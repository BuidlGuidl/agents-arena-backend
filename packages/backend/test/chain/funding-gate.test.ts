import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { EntrantDriver } from '../../src/adapters/types.js';
import { createFundingGate } from '../../src/chain/funding-gate.js';
import { entrants, runs } from '../../src/db/schema.js';
import { EventJournal } from '../../src/journal.js';
import { RunManager } from '../../src/run-manager.js';

const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() { return 'injected'; },
  async restart() {},
  async stop() {},
};

async function seedRun(preset: 'docker-arena' | 'fake-duel') {
  const journal = new EventJournal(':memory:');
  const manager = new RunManager(journal, noopDriver);
  const created = await manager.create({ preset });
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  const runEntrants = journal.database
    .select()
    .from(entrants)
    .where(eq(entrants.runId, created.run.id))
    .all();
  if (run === undefined) {
    throw new Error('Test run was not seeded');
  }
  return { journal, run, runEntrants };
}

describe('funding gate', () => {
  it('does nothing for a fake substrate', async () => {
    const { journal, run, runEntrants } = await seedRun('fake-duel');
    try {
      await createFundingGate(journal)(run, runEntrants);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'funding.balance')).toEqual([]);
    } finally {
      journal.close();
    }
  });

  it('throws when a docker-substrate entrant has no address', async () => {
    const { journal, run, runEntrants } = await seedRun('docker-arena');
    try {
      await expect(createFundingGate(journal)(run, runEntrants)).rejects.toThrow(
        /Entrant .+ has no wallet address/,
      );
    } finally {
      journal.close();
    }
  });
});
