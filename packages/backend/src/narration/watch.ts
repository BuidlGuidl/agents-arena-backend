import { and, eq } from 'drizzle-orm';

import type { EntrantRecord, RunRecord } from '../adapters/types.js';
import type { ArenaEvent, EntrantStatus } from '../contract.js';
import { entrants } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import type { NarrationWatch } from '../run-manager.js';
import type { Narrate } from './openrouter.js';
import {
  buildNarrationWindow,
  isNarrationEventRelevant,
  seedOpenTools,
  type NarrationWindow,
  type OpenTool,
} from './window.js';

const MAX_BACKOFF_MS = 60_000;
const NARRATION_TIMEOUT_MS = 30_000;

export interface NarrationLogger {
  warn(message: string): void;
}

export interface NarrationWatcherOptions {
  journal: EventJournal;
  narrate: Narrate;
  challengeTitles: Readonly<Record<number, string>>;
  minMs: number;
  maxMs: number;
  logger?: NarrationLogger;
  now?: () => number;
}

interface ResumeState {
  basedOnEventId: number;
  lastCallAtMs: number;
  closingWritten: boolean;
  openTools: readonly OpenTool[];
}

export class NarrationWatcher {
  private readonly logger: NarrationLogger;
  private readonly now: () => number;

  constructor(private readonly options: NarrationWatcherOptions) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  /** Run each entrant on its own clock. One failed or slow lane never stalls another. */
  async watch(
    run: RunRecord,
    runEntrants: readonly EntrantRecord[],
    signal: AbortSignal,
  ): Promise<void> {
    await Promise.all(runEntrants.map((entrant) => this.watchEntrant(run, entrant, signal)));
  }

  private async watchEntrant(
    run: RunRecord,
    entrant: EntrantRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const resume = this.resumeState(run, entrant);
    let basedOnEventId = resume.basedOnEventId;
    let lastCallAtMs = resume.lastCallAtMs;
    let closingWritten = resume.closingWritten;
    let openTools = resume.openTools;
    let failures = 0;
    let retryAtMs = 0;
    let hasNewActivity = false;
    let wake: Wake | undefined;

    try {
      wake = createWake(this.options.journal, run.id, signal, (event) => {
        if (!isNarrationEventRelevant(event, entrant.id)) return false;
        hasNewActivity = true;
        return true;
      });
      const initialEvents = this.options.journal.after(run.id, basedOnEventId);
      const initialActivity = initialEvents.some((event) =>
        isNarrationEventRelevant(event, entrant.id));
      hasNewActivity = hasNewActivity || initialActivity;
      if (!initialActivity) {
        basedOnEventId = initialEvents.at(-1)?.id ?? basedOnEventId;
      }
      while (!signal.aborted) {
        let window: NarrationWindow | undefined;
        let timed: ReturnType<typeof timedSignal> | undefined;
        try {
          const nowMs = this.now();
          const status = currentStatus(this.options.journal, run, entrant);
          if (status === 'done' && closingWritten) return;

          const dueAt = callDueAt(status, hasNewActivity, lastCallAtMs, this.options.minMs, this.options.maxMs);
          const callAt = Math.max(dueAt, retryAtMs);
          if (nowMs < callAt) {
            await wake.wait(Number.isFinite(callAt) ? callAt - nowMs : undefined);
            continue;
          }

          hasNewActivity = false;
          window = buildNarrationWindow({
            journal: this.options.journal,
            run,
            entrant,
            challengeTitles: this.options.challengeTitles,
            basedOnEventId,
            openTools,
            nowMs,
          });
          if (status === 'done' && !window.everActive) return;

          // A failed attempt still counts as a call for the timing floor. The
          // retry deadline can extend it with exponential backoff.
          lastCallAtMs = nowMs;
          timed = timedSignal(signal, NARRATION_TIMEOUT_MS);
          const text = await this.options.narrate(window.input, timed.signal);
          if (signal.aborted) return;
          this.options.journal.append(run.id, entrant.id, 'entrant.narration', {
            entrantId: entrant.id,
            text,
            basedOnEventId: window.basedOnEventId,
          });
          basedOnEventId = window.basedOnEventId;
          openTools = window.openTools;
          failures = 0;
          retryAtMs = 0;
          if (status === 'done') {
            closingWritten = true;
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          hasNewActivity = hasNewActivity || (window?.eventCount ?? 0) > 0;
          failures += 1;
          const backoffMs = Math.min(
            MAX_BACKOFF_MS,
            Math.max(10, this.options.minMs) * 2 ** Math.min(failures - 1, 10),
          );
          retryAtMs = this.now() + backoffMs;
          this.logger.warn(
            `[narration] ${entrant.id} failed: ${describe(error)}; retrying in ${backoffMs}ms`,
          );
        } finally {
          timed?.close();
        }
      }
    } finally {
      wake?.close();
    }
  }

  private resumeState(run: RunRecord, entrant: EntrantRecord): ResumeState {
    const lastNarration = this.options.journal.history(run.id, {
      types: ['entrant.narration'],
      sources: [entrant.id],
      limit: 1,
    }).events.at(-1);
    const statusEvents = this.options.journal.history(run.id, {
      types: ['entrant.status'],
      sources: [entrant.id],
      limit: 200,
    }).events;
    const lastStatus = statusEvents.at(-1);
    const basedOnEventId = lastNarration?.type === 'entrant.narration'
      ? lastNarration.payload.basedOnEventId
      : 0;
    const parsedLastCall = lastNarration === undefined ? NaN : Date.parse(lastNarration.ts);
    return {
      basedOnEventId,
      lastCallAtMs: Number.isFinite(parsedLastCall)
        ? parsedLastCall
        : Number.NEGATIVE_INFINITY,
      closingWritten: lastStatus?.type === 'entrant.status'
        && lastStatus.payload.status === 'done'
        && basedOnEventId >= lastStatus.id,
      openTools: seedOpenTools(this.options.journal, run.id, entrant.id, basedOnEventId),
    };
  }
}

export function createNarrationWatch(options: NarrationWatcherOptions): NarrationWatch {
  const watcher = new NarrationWatcher(options);
  return (run, entrants, signal) => {
    void watcher.watch(run, entrants, signal).catch((error: unknown) => {
      options.logger?.warn(`[narration] watch failed for run ${run.id}: ${describe(error)}`);
    });
  };
}

function callDueAt(
  status: EntrantStatus,
  hasNewActivity: boolean,
  lastCallAtMs: number,
  minMs: number,
  maxMs: number,
): number {
  if (status === 'done') return Number.NEGATIVE_INFINITY;
  const eventDueAt = hasNewActivity ? lastCallAtMs + minMs : Number.POSITIVE_INFINITY;
  if (status === 'idle') return eventDueAt;
  return Math.min(eventDueAt, lastCallAtMs + maxMs);
}

function currentStatus(
  journal: EventJournal,
  run: RunRecord,
  entrant: EntrantRecord,
): EntrantStatus {
  return journal.database
    .select({ status: entrants.status })
    .from(entrants)
    .where(and(eq(entrants.runId, run.id), eq(entrants.id, entrant.id)))
    .get()?.status ?? entrant.status;
}

interface Wake {
  wait(delayMs?: number): Promise<void>;
  close(): void;
}

function createWake(
  journal: EventJournal,
  runId: string,
  signal: AbortSignal,
  wakeForEvent: (event: ArenaEvent) => boolean,
): Wake {
  let pending = false;
  let resolveWait: (() => void) | undefined;
  const unsubscribe = journal.subscribe(runId, (event) => {
    if (!wakeForEvent(event)) return;
    if (resolveWait === undefined) {
      pending = true;
    } else {
      resolveWait();
    }
  });

  return {
    wait(delayMs) {
      if (pending || signal.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolveWait = undefined;
          resolve();
        };
        if (delayMs !== undefined) {
          timer = setTimeout(finish, Math.max(0, delayMs));
          timer.unref();
        }
        resolveWait = finish;
        signal.addEventListener('abort', finish, { once: true });
      });
    },
    close() {
      unsubscribe();
      resolveWait?.();
    },
  };
}

function timedSignal(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; close(): void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new Error(`Narration request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([signal, timeout.signal]),
    close: () => clearTimeout(timer),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
