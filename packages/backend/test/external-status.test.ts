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

it('defaults to 120 seconds and invalidates callbacks through the injected schedule', async () => {
  const f = await setup();
  const tasks: { task: () => void; delay: number }[] = [];
  const status = new ExternalStatus(f.journal, { schedule: (task, delay) => tasks.push({ task, delay }) });
  status.touch(f.runId, f.entrantId);
  status.touch(f.runId, f.entrantId);
  expect(tasks.map((task) => task.delay)).toEqual([120000, 120000]);
  tasks[0]!.task();
  expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status).toBe('working');
  status.clear(f.runId, f.entrantId);
  tasks[1]!.task();
  expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status).toBe('working');
  expect(f.journal.after(f.runId, 0).filter((event) => event.type === 'entrant.status')).toHaveLength(1);
});

it('arms the external driver at start and clears its callback on stop', async () => {
  const f = await setup();
  const tasks: (() => void)[] = [];
  const status = new ExternalStatus(f.journal, { schedule: (task) => tasks.push(task) });
  const set = vi.spyOn(status, 'set');
  const driver = new ExternalDriver(f.journal, status);
  const run = f.manager.assertJoinable(f.runId);
  const entrant = { runId: f.runId, id: f.entrantId, kind: 'external' as const, status: 'idle' as const, address: '0x1234567890123456789012345678901234567890', name: 'Agent', joinedAt: new Date().toISOString(), removedAt: null, flagsBeforeJoin: 0 };
  await driver.start(run, entrant, 'task');
  expect(set).not.toHaveBeenCalled();
  expect(tasks).toHaveLength(1);
  await driver.stop(run, entrant);
  const before = f.journal.after(f.runId, 0);
  tasks[0]!();
  expect(f.journal.after(f.runId, 0)).toEqual(before);
  expect(f.manager.snapshot(f.runId).entrants.find((row) => row.id === f.entrantId)?.status).toBe('done');
});

it('cancels default timers on clear and close', async () => {
  const f = await setup();
  vi.useFakeTimers();
  const status = new ExternalStatus(f.journal);
  try {
    status.start(f.runId, f.entrantId);
    expect(vi.getTimerCount()).toBe(1);
    status.clear(f.runId, f.entrantId);
    expect(vi.getTimerCount()).toBe(0);
    status.start(f.runId, f.entrantId);
    status.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    status.close();
    vi.useRealTimers();
  }
});
