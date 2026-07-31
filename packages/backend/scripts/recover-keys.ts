import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  canonicalizeSeedSignature,
  deriveEntrantKeys,
  getWallet,
} from '../src/chain/wallet.js';

const args = process.argv.slice(2);
const rpcUrl = takeOption(args, '--rpc-url') ?? process.env.RPC_URL;
const sweepText = takeOption(args, '--sweep') ?? process.env.SWEEP_TO;
const [argumentSignature, argumentRunId, argumentEntrants, ...extra] = args;
if (extra.length > 0 || argumentSignature?.startsWith('--')) {
  throw new Error(`Unknown arguments: ${args.join(' ')}`);
}
const signature = argumentSignature ?? process.env.SEED_SIGNATURE;
const runId = argumentRunId ?? process.env.RUN_ID;
const entrantsText = argumentEntrants ?? process.env.ENTRANT_IDS ?? 'codex-1,opencode-1';

if (signature === undefined || runId === undefined) {
  throw new Error(
    'Usage: tsx scripts/recover-keys.ts <signature> <runId> [entrant-ids] '
    + '[--rpc-url <url>] [--sweep <to-address>]',
  );
}
if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
  throw new Error('The seed signature must contain 65 hex bytes with a 0x prefix.');
}

const entrantIds = entrantsText.split(',').map((value) => value.trim()).filter(Boolean);
if (entrantIds.length === 0) throw new Error('Provide at least one entrant ID.');
if (sweepText !== undefined && rpcUrl === undefined) {
  throw new Error('--sweep requires --rpc-url or RPC_URL.');
}

let canonicalSignature: Hex;
try {
  canonicalSignature = canonicalizeSeedSignature(signature as Hex);
} catch {
  throw new Error('The seed signature is not canonical.');
}

try {
  deriveEntrantKeys(runId, canonicalSignature, entrantIds);
} catch {
  throw new Error('Key derivation failed without exposing the rejected key.');
}

const recovered = entrantIds.map((entrantId) => {
  const wallet = getWallet(runId, entrantId);
  if (wallet === null) throw new Error(`No recovered wallet for ${entrantId}.`);
  return wallet;
});

const publicClient = rpcUrl === undefined
  ? undefined
  : createPublicClient({ transport: http(rpcUrl) });
const sweepTo: Address | undefined = sweepText === undefined
  ? undefined
  : getAddress(sweepText);
const chain = publicClient === undefined || rpcUrl === undefined
  ? undefined
  : defineChain({
      id: await publicClient.getChainId(),
      name: 'recovery-rpc',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });

console.log('WARNING: this output contains private keys. Store it securely.');
for (const wallet of recovered) {
  console.log(`\n${wallet.entrantId}`);
  console.log(`address:     ${wallet.address}`);
  console.log(`private key: ${wallet.privateKey}`);

  if (publicClient === undefined) continue;
  const balance = await publicClient.getBalance({ address: wallet.address });
  console.log(`balance:     ${balance} wei (${formatEther(balance)} ETH)`);

  if (sweepTo === undefined || chain === undefined || rpcUrl === undefined) continue;
  const gasPrice = await publicClient.getGasPrice();
  const gas = await publicClient.estimateGas({
    account: wallet.address,
    to: sweepTo,
    value: 0n,
  });
  const gasCost = gas * gasPrice;
  if (balance <= gasCost) {
    console.log('sweep:       skipped because the balance does not cover gas');
    continue;
  }

  const account = privateKeyToAccount(wallet.privateKey);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: sweepTo,
    value: balance - gasCost,
    gas,
    gasPrice,
  });
  console.log(`sweep:       ${hash}`);
}

function takeOption(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  values.splice(index, 2);
  return value;
}
