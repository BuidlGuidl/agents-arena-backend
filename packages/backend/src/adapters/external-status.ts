import { and, eq } from 'drizzle-orm';

import type { EntrantStatus } from '../contract.js';
import { entrants } from '../db/schema.js';
import type { EventJournal } from '../journal.js';

export class ExternalStatus {
  constructor(private readonly journal: EventJournal) {}

  touch(runId: string, entrantId: string): void {
    this.journal.transaction(() => {
      const current = this.current(runId, entrantId);
      if (current?.kind !== 'external' || current.status !== 'idle') return;
      this.writeStatus(runId, entrantId, current.status, 'working');
    });
  }

  set(runId: string, entrantId: string, status: EntrantStatus): void {
    this.journal.transaction(() => {
      const current = this.current(runId, entrantId);
      if (current === undefined || current.kind !== 'external') return;
      this.writeStatus(runId, entrantId, current.status, status);
    });
  }

  private current(runId: string, entrantId: string) {
    return this.journal.database.select().from(entrants)
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId))).get();
  }

  private writeStatus(runId: string, entrantId: string, current: EntrantStatus, status: EntrantStatus): void {
    if (current === status) return;
    this.journal.database.update(entrants).set({ status })
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId))).run();
    this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status });
  }
}
