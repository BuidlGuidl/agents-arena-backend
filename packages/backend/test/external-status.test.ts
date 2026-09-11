import { expect, it, vi } from 'vitest';

import { ExternalDriver } from '../src/adapters/external.js';
import { ExternalStatus } from '../src/adapters/external-status.js';
import { journalHarness } from './fixtures/journal.js';
import { RunManager } from '../src/run-manager.js';
import { noopDriver } from './fixtures/server.js';

const createJournal = journalHarness();

async function setup() {
  const journal = createJournal();
  const manager = new RunManager(journal, noopDriver);
  const { run } = await manager.create({ preset: 'fake-duel' });
  const joined = await manager.join({ runId: run.id, address: '0x1234567890123456789012345678901234567890', name: 'Agent', flagsBeforeJoin: 0 });
  return { journal, manager, runId: run.id, entrantId: joined.entrantId };
}

it.each(['idle', 'working', 'blocked', 'done'] as const)('touch moves only idle to working from %s', async (initial) => {
  const f = await setup();
  const status = new ExternalStatus(f.journal);
  status.set(f.runId, f.entrantId, initial);
  status.touch(f.runId, f.entrantId);
  expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status)
    .toBe(initial === 'idle' ? 'working' : initial);
});

it('starts without a timer and sets done on stop', async () => {
  const f = await setup();
  vi.useFakeTimers();
  try {
    const status = new ExternalStatus(f.journal);
    const driver = new ExternalDriver(f.journal, status);
    const run = f.manager.assertJoinable(f.runId);
    const entrant = { runId: f.runId, id: f.entrantId, kind: 'external' as const, status: 'idle' as const,
      address: '0x1234567890123456789012345678901234567890', name: 'Agent',
      joinedAt: new Date().toISOString(), removedAt: null, flagsBeforeJoin: 0 };
    await driver.start(run, entrant, 'task');
    expect(vi.getTimerCount()).toBe(0);
    status.touch(f.runId, f.entrantId);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1000);
    expect(f.manager.snapshot(f.runId).entrants.find((row) => row.id === f.entrantId)?.status).toBe('working');
    await driver.stop(run, entrant);
    expect(f.manager.snapshot(f.runId).entrants.find((row) => row.id === f.entrantId)?.status).toBe('done');
  } finally {
    vi.useRealTimers();
  }
});
