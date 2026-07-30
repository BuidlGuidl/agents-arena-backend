import { randomUUID } from 'node:crypto';

import type { ArenaEvent, HarnessId } from '../src/contract.js';
import { CodexDriver } from '../src/adapters/codex.js';
import { OpenCodeDriver } from '../src/adapters/opencode.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from '../src/adapters/types.js';
import { entrants, runs } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';

const harness = process.argv[2];
if (harness !== 'codex' && harness !== 'opencode') {
  console.error('Usage: tsx scripts/demo-entrant.ts <codex|opencode>');
  process.exit(2);
}

const journal = new EventJournal(':memory:');
const runId = randomUUID();
const entrantId = `${harness}-demo`;
const now = new Date().toISOString();
const model = harness === 'codex'
  ? 'default' // ChatGPT-account login: use the account default, don't pin an API-only model
  : 'openrouter/z-ai/glm-5.2';
const run: RunRecord = {
  id: runId,
  state: 'running',
  preset: `demo-${harness}`,
  startedAt: now,
  deadlineAt: null,
  idempotencyKey: null,
};
const entrant: EntrantRecord = {
  runId,
  id: entrantId,
  harness: harness as HarnessId,
  model,
  address: null,
  status: 'idle',
};

journal.database.insert(runs).values({
  ...run,
  createdAt: now,
}).run();
journal.database.insert(entrants).values(entrant).run();
journal.append(runId, 'run', 'run.state', { state: 'running' });

const driver: EntrantDriver = harness === 'codex'
  ? new CodexDriver(journal)
  : new OpenCodeDriver(journal);
let prepared = false;
const unsubscribe = journal.subscribe(runId, (event) => {
  console.log(JSON.stringify(event));
});

try {
  await driver.prepare(run, entrant);
  prepared = true;
  const turnFinished = waitForTurn(journal, runId, entrantId);
  const prompt = [
    'Run `forge --version` and',
    '`cast chain-id --rpc-url http://host.docker.internal:8545`,',
    'then summarize what you see.',
  ].join(' ');
  await driver.start(run, entrant, prompt);
  await turnFinished;
} finally {
  if (prepared) await driver.stop(run, entrant);
  unsubscribe();
  journal.close();
}

function waitForTurn(
  eventJournal: EventJournal,
  id: string,
  source: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let working = false;
    const timeout = setTimeout(() => {
      stopListening();
      reject(new Error('Demo turn timed out after 15 minutes'));
    }, 15 * 60 * 1_000);
    const stopListening = eventJournal.subscribe(id, (event: ArenaEvent) => {
      if (event.source !== source || event.type !== 'entrant.status') return;
      if (event.payload.status === 'working') working = true;
      if (working && (event.payload.status === 'idle' || event.payload.status === 'blocked')) {
        clearTimeout(timeout);
        stopListening();
        resolve();
      }
    });
  });
}
