// Funding-gate drill against the local ai-ctf chain (ADR-0007 substrate).
//
// Creates two burner wallets, then runs the real funding watcher against the
// running `yarn chain` node. It holds until both wallets cross the threshold
// at head - confirmations, printing every balance change as a funding.balance
// event — exactly what slice 5 does inside a real run.
//
//   Terminal A:  tsx scripts/demo-funding.ts [thresholdEth=0.05]
//   Terminal B:  scripts/fund-drill.sh          (funds the addresses it printed)
//
// The watcher and the funder talk only through the chain — the funder never
// touches this process's in-memory DB, just the addresses written to
// scripts/.funding-request.json.

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ArenaEvent } from '../src/contract.js';
import { awaitFunding, type FundingEntry } from '../src/chain/funding-watcher.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import { getChainProfile } from '../src/chain/profile.js';
import { deriveEntrantKeys, seedTypedData } from '../src/chain/wallet.js';
import { EventJournal } from '../src/journal.js';

const thresholdEth = process.argv[2] ?? '0.05';
const profile = getChainProfile('local');
const runId = `drill-${randomUUID().slice(0, 8)}`;

const journal = new EventJournal(':memory:');
const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
const signature = await account.signTypedData(seedTypedData(runId, profile.chainId));
const addresses = deriveEntrantKeys(runId, signature, ['codex-1', 'opencode-1']);

const entries: FundingEntry[] = [
  { entrantId: 'codex-1', address: addresses.get('codex-1')! },
  { entrantId: 'opencode-1', address: addresses.get('opencode-1')! },
];
const thresholdWei = parseEther(thresholdEth);

// Hand the addresses to the funder script.
const requestPath = new URL('./.funding-request.json', import.meta.url);
writeFileSync(
  requestPath,
  `${JSON.stringify(
    {
      runId,
      rpcUrl: profile.rpcUrl,
      thresholdEth,
      entries: entries.map((e) => ({ entrantId: e.entrantId, address: e.address })),
    },
    null,
    2,
  )}\n`,
);

const rule = '─'.repeat(64);
console.log(`\n${rule}`);
console.log(`  FUNDING DRILL · profile=${profile.name} · chainId=${profile.chainId}`);
console.log(`  rpc=${profile.rpcUrl} · confirmations=${profile.confirmations}`);
console.log(`  run=${runId} · threshold=${thresholdEth} ETH each`);
console.log(rule);
for (const e of entries) console.log(`  ${e.entrantId.padEnd(11)} ${e.address}`);
console.log(rule);
console.log('  In another terminal, fund them:');
console.log('      scripts/fund-drill.sh');
console.log('  or by hand with unlocked local account 0:');
for (const e of entries) {
  console.log(
    `      cast send ${e.address} --value ${thresholdEth}ether \\\n` +
      `        --unlocked --from ${profile.funderAddress} \\\n` +
      `        --rpc-url ${profile.rpcUrl}`,
  );
}
console.log(`      cast rpc evm_mine --rpc-url ${profile.rpcUrl}   # advance one confirmation`);
console.log(`${rule}\n  watching for balances (Ctrl-C to stop)…\n`);

journal.subscribe(runId, (event: ArenaEvent) => {
  if (event.type !== 'funding.balance') return;
  const p = event.payload;
  const mark = p.funded ? '✓ funded ' : '… waiting';
  const eth = formatEther(BigInt(p.wei)).padStart(10);
  console.log(`  [${event.ts.slice(11, 19)}] ${p.entrantId.padEnd(11)} ${eth} ETH  ${mark}`);
});

const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
  journal.close();
  console.log('\n  aborted.');
  process.exit(130);
});

await awaitFunding({ profile, entries, thresholdWei, journal, runId, pollMs: 800, signal: controller.signal });

console.log(`\n${rule}`);
console.log('  ✓ FUNDING GATE PASSED — both entrants crossed the threshold.');
console.log('    In a real run the state machine now advances awaiting_funding → ready.');
console.log(rule);
journal.close();
process.exit(0);
