import { and, eq } from 'drizzle-orm';

import { TERMINAL_RUN_STATES, type EntrantStatus } from '../contract.js';
import { entrants, runs } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import type { Schedule } from './fake.js';

export interface ExternalStatusOptions {
  idleMs?: number;
  schedule?: Schedule;
}

export class ExternalStatus {
  private readonly timers = new Map<string, { cancel: () => void }>();
  private readonly schedule: (task: () => void, delay: number) => () => void;
  private readonly idleMs: number;

  constructor(private readonly journal: EventJournal, options: ExternalStatusOptions = {}) {
    this.idleMs = options.idleMs ?? 120_000;
    const schedule = options.schedule;
    this.schedule = schedule === undefined ? (task, delay) => {
      const timer = setTimeout(task, delay);
      timer.unref();
      return () => clearTimeout(timer);
    } : (task, delay) => {
      schedule(task, delay);
      // The identity check invalidates callbacks from injected schedules.
      return () => {};
    };
  }

  touch(runId: string, entrantId: string): void {
    this.set(runId, entrantId, 'working');
  }

  start(runId: string, entrantId: string): void {
    this.journal.afterCommit(() => {
      this.clear(runId, entrantId);
      this.arm(runId, entrantId);
    });
  }

  set(runId: string, entrantId: string, status: EntrantStatus): void {
    this.journal.transaction(() => {
      const where = and(eq(entrants.runId, runId), eq(entrants.id, entrantId));
      const current = this.journal.database.select().from(entrants).where(where).get();
      if (current === undefined || current.kind !== 'external') return;
      this.writeStatus(runId, entrantId, current.status, status);
      this.journal.afterCommit(() => {
        this.clear(runId, entrantId);
        if (status !== 'done') this.arm(runId, entrantId);
      });
    });
  }

  clear(runId: string, entrantId: string): void {
    const key = `${runId}:${entrantId}`;
    const timer = this.timers.get(key);
    this.timers.delete(key);
    timer?.cancel();
  }

  close(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  private writeStatus(runId: string, entrantId: string, current: EntrantStatus, status: EntrantStatus): void {
    if (current === status) return;
    this.journal.database.update(entrants).set({ status })
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId))).run();
    this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status });
  }

  private arm(runId: string, entrantId: string): void {
    const key = `${runId}:${entrantId}`;
    const timer: { cancel: () => void } = { cancel: () => {} };
    this.timers.set(key, timer);
    timer.cancel = this.schedule(() => {
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
