import { and, eq } from 'drizzle-orm';

import { TERMINAL_RUN_STATES, type EntrantStatus } from '../contract.js';
import { entrants, runs } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import type { Schedule } from './fake.js';

export interface ExternalStatusOptions {
  idleMs?: number;
  schedule?: Schedule;
}

const owners = new WeakMap<EventJournal, ExternalStatus>();

// Driver factories and routes share one owner for this journal, including test drivers.
export function externalStatusFor(journal: EventJournal, options: ExternalStatusOptions = {}): ExternalStatus {
  let status = owners.get(journal);
  if (status === undefined) {
    status = new ExternalStatus(journal, options);
    owners.set(journal, status);
  }
  return status;
}

export class ExternalStatus {
  private readonly timers = new Map<string, { handle?: unknown }>();
  private readonly schedule: Schedule;
  private readonly idleMs: number;

  constructor(private readonly journal: EventJournal, options: ExternalStatusOptions = {}) {
    this.idleMs = options.idleMs ?? 120_000;
    this.schedule = options.schedule ?? ((task, delay) => {
      const timer = setTimeout(task, delay);
      timer.unref();
      return timer;
    });
  }

  touch(runId: string, entrantId: string): void {
    const entrant = this.journal.database.select({ kind: entrants.kind }).from(entrants)
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId))).get();
    if (entrant?.kind === 'external') this.set(runId, entrantId, 'working');
  }

  set(runId: string, entrantId: string, status: EntrantStatus): void {
    this.journal.transaction(() => {
      const where = and(eq(entrants.runId, runId), eq(entrants.id, entrantId));
      const current = this.journal.database.select().from(entrants).where(where).get();
      if (current === undefined) return;
      this.writeStatus(runId, entrantId, current.status, status);
      this.journal.afterCommit(() => {
        this.clear(runId, entrantId);
        if (current.kind === 'external' && status !== 'done') this.arm(runId, entrantId);
      });
    });
  }

  clear(runId: string, entrantId: string): void {
    const key = `${runId}:${entrantId}`;
    const timer = this.timers.get(key);
    this.timers.delete(key);
    // Injected schedules need no cancellation API: the identity check also invalidates old callbacks.
    if (typeof timer?.handle === 'object' && timer.handle !== null && 'unref' in timer.handle) {
      clearTimeout(timer.handle as NodeJS.Timeout);
    }
  }

  close(): void {
    for (const key of this.timers.keys()) {
      const separator = key.lastIndexOf(':');
      this.clear(key.slice(0, separator), key.slice(separator + 1));
    }
  }

  private writeStatus(runId: string, entrantId: string, current: EntrantStatus, status: EntrantStatus): void {
    if (current === status) return;
    this.journal.database.update(entrants).set({ status })
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId))).run();
    this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status });
  }

  private arm(runId: string, entrantId: string): void {
    const key = `${runId}:${entrantId}`;
    const timer: { handle?: unknown } = {};
    this.timers.set(key, timer);
    timer.handle = this.schedule(() => {
      if (this.timers.get(key) !== timer) return;
      this.timers.delete(key);
      const run = this.journal.database.select().from(runs).where(eq(runs.id, runId)).get();
      if (run === undefined || TERMINAL_RUN_STATES.includes(run.state)) return;
      this.journal.transaction(() => {
        const where = and(eq(entrants.runId, runId), eq(entrants.id, entrantId));
        const current = this.journal.database.select().from(entrants).where(where).get();
        if (current === undefined || current.status === 'idle' || current.status === 'done') return;
        this.writeStatus(runId, entrantId, current.status, 'idle');
      });
    }, this.idleMs);
  }
}
