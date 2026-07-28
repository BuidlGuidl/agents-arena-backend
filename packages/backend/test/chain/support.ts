import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { flagMintedEvent } from '../../src/chain/abi.js';
import type { ChainProfile } from '../../src/chain/profile.js';

// anvil's first pre-funded dev account — deterministic across every run.
const devPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export interface AnvilHandle {
  rpcUrl: string;
  port: number;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: ReturnType<typeof privateKeyToAccount>;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  mine: (blocks: number) => Promise<void>;
  setBalance: (address: Address, wei: bigint) => Promise<void>;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // anvil is not listening yet — retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('anvil did not become ready in time');
}

/** Spawn an isolated anvil node on an ephemeral port. Caller must stop() it. */
export async function startAnvil(): Promise<AnvilHandle> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  // --order fifo keeps tx ordering deterministic; default auto-mine gives one block per tx.
  const child: ChildProcess = spawn(
    'anvil',
    ['--port', String(port), '--silent'],
    { stdio: 'ignore' },
  );
  child.unref();

  await waitForRpc(rpcUrl, 15_000);

  const account = privateKeyToAccount(devPrivateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  let nextId = 1;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) {
      throw new Error(`${method} failed: ${body.error.message}`);
    }
    return body.result;
  };

  const mine = async (blocks: number): Promise<void> => {
    await rpc('anvil_mine', [`0x${blocks.toString(16)}`]);
  };
  const setBalance = async (address: Address, wei: bigint): Promise<void> => {
    await rpc('anvil_setBalance', [address, `0x${wei.toString(16)}`]);
  };

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });

  return { rpcUrl, port, publicClient, walletClient, account, rpc, mine, setBalance, stop };
}

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));
const artifactPath = `${fixtureDir}/out/FlagMintedFixture.sol/FlagMintedFixture.json`;

interface FixtureArtifact {
  abi: readonly unknown[];
  bytecode: { object: `0x${string}` };
}

/** Compile the fixture with forge when its artifact is missing. Idempotent. */
export function buildFixture(): void {
  if (existsSync(artifactPath)) {
    return;
  }
  execFileSync('forge', ['build'], { cwd: fixtureDir, stdio: 'ignore' });
}

/** Deploy the FlagMinted fixture and return its address. Builds first if needed. */
export async function deployFlagFixture(handle: AnvilHandle): Promise<Address> {
  buildFixture();
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as FixtureArtifact;
  const hash = await handle.walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    account: handle.account,
    chain: null,
  });
  const receipt = await handle.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
    throw new Error('fixture deployment produced no contract address');
  }
  return receipt.contractAddress;
}

export interface MintResult {
  txHash: Hash;
  tokenId: bigint;
  blockNumber: bigint;
}

/** Call mint(recipient, challengeId) on the fixture and wait for the receipt. */
export async function mintFlag(
  handle: AnvilHandle,
  contract: Address,
  recipient: Address,
  challengeId: bigint,
): Promise<MintResult> {
  const hash = await handle.walletClient.writeContract({
    address: contract,
    abi: [
      {
        type: 'function',
        name: 'mint',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'recipient', type: 'address' },
          { name: 'challengeId', type: 'uint256' },
        ],
        outputs: [],
      },
    ],
    functionName: 'mint',
    args: [recipient, challengeId],
    account: handle.account,
    chain: null,
  });
  const receipt = await handle.publicClient.waitForTransactionReceipt({ hash });
  const [minted] = parseEventLogs({ abi: [flagMintedEvent], logs: receipt.logs });
  if (minted === undefined) {
    throw new Error('mint produced no FlagMinted log');
  }
  return { txHash: hash, tokenId: minted.args.tokenId, blockNumber: receipt.blockNumber };
}

export interface RpcProxy {
  url: string;
  /** One entry per HTTP request: the parsed body, an array when the client batched. */
  bodies: unknown[];
  stop: () => Promise<void>;
}

/** A recording JSON-RPC pass-through, so a test can count HTTP requests the client made. */
export async function startRpcProxy(targetUrl: string): Promise<RpcProxy> {
  const bodies: unknown[] = [];
  const server: Server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      bodies.push(JSON.parse(body));
      void fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
        .then(async (upstream) => {
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(await upstream.text());
        })
        .catch(() => {
          response.writeHead(502).end();
        });
    });
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A ChainProfile pointed at the test node, with the confirmation depth the test needs. */
export function testProfile(rpcUrl: string, confirmations: number, nftFlags: Address): ChainProfile {
  const zero = '0x0000000000000000000000000000000000000000' as Address;
  return {
    name: 'test',
    rpcUrl,
    containerRpcUrl: rpcUrl,
    chainId: 31337,
    confirmations,
    nftFlags,
    challenge1: zero,
    identityRegistry: zero,
  };
}
