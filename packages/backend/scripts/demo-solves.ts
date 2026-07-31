// Solve-poller drill against the real CTF contracts (ADR-0010).
//
// Deploys the ai-ctf NFTFlags / MockIdentityRegistry / Challenge1 bytecode onto a
// throwaway anvil with 1s blocks, then runs the real SolvePoller against it while
// driving the entrant path an agent takes: registry.registerAgent, then
// Challenge1.registerAgent, which mints flag 1.
//
// The confirmation depth defaults to 5, base's, because the local chain profile
// ships at 1 and the head - confirmations path otherwise never runs. The drill
// fails if a solve is journaled before that depth has passed.
//
//   AI_CTF_REPO=~/src/ai.ctf.buidlguidl.com tsx scripts/demo-solves.ts [confirmations=5]
//
// Needs anvil on PATH and a built ai-ctf checkout (`yarn compile` there once).
// It starts and stops its own chain, so it does not touch a running demo.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import { deriveEntrantKeys, getWallet, seedTypedData } from '../src/chain/wallet.js';
import { entrants, runs } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';

const CONFIRMATIONS = Number(process.argv[2] ?? 5);
const RPC_URL = 'http://127.0.0.1:8599';

const chainRepo = process.env.AI_CTF_REPO;
if (chainRepo === undefined || chainRepo.trim() === '') {
  console.error('Set AI_CTF_REPO to your local ai-ctf checkout (see DEMO.md).');
  process.exit(2);
}
const ARTIFACTS = `${chainRepo.replace(/^~/, homedir())}/packages/hardhat/artifacts/contracts`;

function artifact(name: string): { abi: readonly unknown[]; bytecode: Hex } {
  const path = `${ARTIFACTS}/${name}.sol/${name}.json`;
  if (!existsSync(path)) {
    console.error(`No artifact at ${path}. Run \`yarn compile\` in ${chainRepo} first.`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return { abi: raw.abi, bytecode: raw.bytecode };
}

const anvil = spawn('anvil', ['--port', '8599', '--block-time', '1', '--silent'], { stdio: 'ignore' });
process.on('exit', () => anvil.kill('SIGKILL'));

const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
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
const signature = await account.signTypedData(seedTypedData(runId, chain.id));
const burnerAddress = deriveEntrantKeys(runId, signature, ['codex-1']).get('codex-1')!;
const burnerKey = getWallet(runId, 'codex-1')!.privateKey;
const burner = privateKeyToAccount(burnerKey);
const createdAt = new Date().toISOString();
journal.database.insert(runs).values({
  id: runId,
  state: 'created',
  preset: 'docker-duel',
  startedAt: null,
  deadlineAt: null,
  idempotencyKey: null,
  createdAt,
}).run();
journal.database.insert(entrants).values({
  runId,
  id: 'codex-1',
  harness: 'codex',
  model: 'demo',
  address: burnerAddress,
  status: 'idle',
}).run();

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
  funderAddress: account.address,
  fundingThresholdWei: parseEther('0.05'),
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
