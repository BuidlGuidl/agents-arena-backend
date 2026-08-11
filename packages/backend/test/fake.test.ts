import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { FakeDriver } from '../src/adapters/fake.js';
import { entrants, runs } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';
import { RunManager } from '../src/run-manager.js';

describe('FakeDriver scripted solves', () => {
  it('assigns distinct flags by entrant identity when harnesses match', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new FakeDriver(journal, (task) => task());
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      journal.database
        .update(entrants)
        .set({ harness: 'codex' })
        .where(and(eq(entrants.runId, run.id), eq(entrants.id, 'opencode-1')))
        .run();

      await manager.start(run.id);

      const snapshot = manager.snapshot(run.id);
      expect(snapshot.entrants.find((entrant) => entrant.id === 'codex-1')?.solves
        .map((solve) => solve.challengeId)).toEqual([3, 11]);
      expect(snapshot.entrants.find((entrant) => entrant.id === 'opencode-1')?.solves
        .map((solve) => solve.challengeId)).toEqual([7, 2]);
    } finally {
      journal.close();
    }
  });
});

// The generation counter is the whole reason a restart is not two scripts
// running at once: the lane is re-added under the same key in the same tick,
// so a membership flag would let every pending timer through.
describe('FakeDriver restart', () => {
  it('silences the script in flight instead of interleaving with it', async () => {
    const journal = new EventJournal(':memory:');
    const pending: Array<() => void> = [];
    const driver = new FakeDriver(journal, (task) => pending.push(task));
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      await manager.start(run.id);
      // Nothing from the opening script has fired yet; every timer is still held.
      await driver.restart(
        runRecord(journal, run.id),
        entrantRecord(journal, run.id, 'codex-1'),
        'second prompt',
      );
      for (const task of pending.splice(0)) task();

      const events = journal.after(run.id, 0).filter((event) => event.source === 'codex-1');
      // One script's worth of usage, not two: the abandoned timers found a
      // generation that had moved on and stayed quiet.
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
      expect(manager.snapshot(run.id).entrants.find((entrant) => entrant.id === 'codex-1'))
        .toMatchObject({ inputTokens: 3_600, outputTokens: 500 });
      // The restart row, and the task row the contract promises after it.
      expect(events.filter((event) =>
        event.type === 'entrant.restarted' || event.type === 'entrant.prompt',
      ).map((event) => event.type)).toEqual(['entrant.prompt', 'entrant.restarted', 'entrant.prompt']);
      expect(events.filter((event) => event.type === 'entrant.prompt')
        .map((event) => event.payload.text).at(-1)).toBe('second prompt');
    } finally {
      journal.close();
    }
  });

  it('leaves a stopped lane quiet when its timers finally fire', async () => {
    const journal = new EventJournal(':memory:');
    const pending: Array<() => void> = [];
    const driver = new FakeDriver(journal, (task) => pending.push(task));
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      await manager.start(run.id);
      await driver.stop(runRecord(journal, run.id), entrantRecord(journal, run.id, 'codex-1'));
      for (const task of pending.splice(0)) task();

      const events = journal.after(run.id, 0).filter((event) => event.source === 'codex-1');
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'entrant.status')
        .map((event) => event.payload.status).at(-1)).toBe('done');
    } finally {
      journal.close();
    }
  });
});

function runRecord(journal: EventJournal, runId: string) {
  const run = journal.database.select().from(runs).where(eq(runs.id, runId)).get();
  if (run === undefined) throw new Error(`Test run ${runId} was not seeded`);
  return run;
}

function entrantRecord(journal: EventJournal, runId: string, entrantId: string) {
  const entrant = journal.database
    .select()
    .from(entrants)
    .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
    .get();
  if (entrant === undefined) throw new Error(`Test entrant ${entrantId} was not seeded`);
  return entrant;
}
