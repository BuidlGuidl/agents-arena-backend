import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { FakeDriver } from '../src/adapters/fake.js';
import { entrants } from '../src/db/schema.js';
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
