import { randomUUID } from 'node:crypto';

import type { ArenaEvent } from '../src/contract.js';
import { ClaudeDriver } from '../src/adapters/claude.js';
import { CodexDriver } from '../src/adapters/codex.js';
import { OpenCodeDriver } from '../src/adapters/opencode.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from '../src/adapters/types.js';
import { entrants, runs } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';

const harness = process.argv[2];
if (harness !== 'codex' && harness !== 'opencode' && harness !== 'claude') {
  console.error('Usage: tsx scripts/demo-entrant.ts <codex|opencode|claude>');
  process.exit(2);
}

const journal = new EventJournal(':memory:');
const runId = randomUUID();
const entrantId = `${harness}-demo`;
const now = new Date().toISOString();
const model = harness === 'codex'
  ? 'default' // ChatGPT-account login: use the account default, don't pin an API-only model
  : harness === 'opencode'
    ? 'openrouter/z-ai/glm-5.2'
    : 'claude-opus-5';
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
  harness,
  model,
  effort: null,
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
  : harness === 'opencode'
    ? new OpenCodeDriver(journal)
    : new ClaudeDriver(journal);
let prepared = false;
// A turn can reach idle after erroring every step of the way (a codex account
// past its usage limit still "completes" its turn), so PASS requires a clean
// journal, not just a turn end.
let sawEntrantError = false;
const unsubscribe = journal.subscribe(runId, (event) => {
  console.log(JSON.stringify(event));
  if (event.type === 'entrant.error') sawEntrantError = true;
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

if (sawEntrantError) {
  console.error(`The ${harness} turn journaled entrant.error events; the harness cannot play.`);
  process.exit(1);
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
