/**
 * Throwaway end-to-end drill (not committed).
 *
 * Deploys the real ai-ctf NFTFlags / MockIdentityRegistry / Challenge1 bytecode onto a
 * fresh anvil with 1s blocks, runs the production SolvePoller at confirmations: 5, and
 * drives the real entrant path: registry.registerAgent -> Challenge1.registerAgent -> mint.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ChainProfile } from '../src/chain/profile.js';
import { SolvePoller } from '../src/chain/solve-poller.js';
import { createWallet, getWallet } from '../src/chain/wallet.js';
import { EventJournal } from '../src/journal.js';

const CONFIRMATIONS = 5;
const RPC_URL = 'http://127.0.0.1:8599';
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ARTIFACTS = `${homedir()}/Desktop/github/ai.ctf.buidlguidl.com/packages/hardhat/artifacts/contracts`;

function artifact(name: string): { abi: readonly unknown[]; bytecode: Hex } {
  const raw = JSON.parse(readFileSync(`${ARTIFACTS}/${name}.sol/${name}.json`, 'utf8'));
  return { abi: raw.abi, bytecode: raw.bytecode };
}

const anvil = spawn('anvil', ['--port', '8599', '--block-time', '1', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));

const account = privateKeyToAccount(DEV_KEY);
const chain = {
  id: 31337,
  name: 'e2e',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;
const publicClient = createPublicClient({ transport: http(RPC_URL), cacheTime: 0 });
const deployer = createWalletClient({ account, transport: http(RPC_URL), chain });

async function waitForRpc(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await publicClient.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('anvil never came up');
}

async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`);
  return receipt.contractAddress;
}

async function send(address: Address, name: string, fn: string, args: readonly unknown[], from = account) {
  const hash = await createWalletClient({ account: from, transport: http(RPC_URL), chain }).writeContract({
    address,
    abi: artifact(name).abi,
    functionName: fn,
    args,
    account: from,
    chain,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

await waitForRpc();

const nftFlags = await deploy('NFTFlags', [account.address]);
await send(nftFlags, 'NFTFlags', 'enable', []);
const registry = await deploy('MockIdentityRegistry', []);
const challenge1 = await deploy('Challenge1', [nftFlags, registry]);
await send(nftFlags, 'NFTFlags', 'addAllowedMinterMultiple', [[challenge1]]);
console.log(`deployed NFTFlags=${nftFlags} registry=${registry} challenge1=${challenge1}`);

const journal = new EventJournal(':memory:');
const runId = 'e2e-run';
const burnerAddress = createWallet(runId, 'codex-1', journal.database);
const burnerKey = getWallet(runId, 'codex-1', journal.database)!.privateKey;
const burner = privateKeyToAccount(burnerKey);

const fundHash = await deployer.sendTransaction({ account, chain, to: burnerAddress, value: parseEther('1') });
await publicClient.waitForTransactionReceipt({ hash: fundHash });
console.log(`burner ${burnerAddress} funded`);

const profile: ChainProfile = {
  name: 'e2e',
  rpcUrl: RPC_URL,
  containerRpcUrl: RPC_URL,
  chainId: 31337,
  confirmations: CONFIRMATIONS,
  nftFlags,
  challenge1,
  identityRegistry: registry,
};

const controller = new AbortController();
const poller = new SolvePoller({ profile, runId, journal, pollMs: 3_000 });
const loop = poller.watch(controller.signal);

// Real entrant path: claim an agent id, then register through Challenge1, which mints flag 1.
await send(registry, 'MockIdentityRegistry', 'registerAgent', ['arena-e2e.local'], burner);
const mintReceipt = await send(challenge1, 'Challenge1', 'registerAgent', [1n], burner);
const mintBlock = mintReceipt.blockNumber;
console.log(`flag 1 minted in block ${mintBlock}, tx ${mintReceipt.transactionHash}`);

const scoreEvents = () => journal.after(runId, 0).filter((event) => event.type === 'score.flag');
const seenTooEarly: bigint[] = [];
const deadline = Date.now() + 60_000;
while (scoreEvents().length === 0 && Date.now() < deadline) {
  const head = await publicClient.getBlockNumber();
  if (head < mintBlock + BigInt(CONFIRMATIONS)) seenTooEarly.push(head);
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const observedAt = await publicClient.getBlockNumber();
controller.abort();
await loop;

const events = scoreEvents();
const failures: string[] = [];
if (events.length !== 1) failures.push(`expected 1 score.flag, saw ${events.length}`);
const payload = events[0]?.payload as { entrantId: string; challengeId: number; txHash: string; tokenId: string };
if (payload?.entrantId !== 'codex-1') failures.push(`entrantId was ${payload?.entrantId}`);
if (payload?.challengeId !== 1) failures.push(`challengeId was ${payload?.challengeId}`);
if (payload?.txHash !== mintReceipt.transactionHash) failures.push(`txHash was ${payload?.txHash}`);
if (observedAt < mintBlock + BigInt(CONFIRMATIONS)) {
  failures.push(`scored at block ${observedAt}, before depth ${mintBlock + BigInt(CONFIRMATIONS)}`);
}

console.log(`polled ${seenTooEarly.length} times inside the confirmation window with no score`);
console.log(`scored at block ${observedAt}; mint block ${mintBlock}; depth ${CONFIRMATIONS}`);
console.log(`payload ${JSON.stringify(payload)}`);
journal.close();
anvil.kill('SIGKILL');

if (failures.length > 0) {
  console.error(`FAIL\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('PASS');
