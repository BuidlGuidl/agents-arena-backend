import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, max, sql } from 'drizzle-orm';

import type {
  CreateRunRequest,
  EntrantSolve,
  EntrantSummary,
  HarnessId,
  RunSnapshot,
  RunState,
} from './contract.js';
import { entrants, events, runs, scores } from './db/schema.js';
import { ensureChainTables } from './chain/storage.js';
import { getChainProfile } from './chain/profile.js';
import { buildOpeningPrompt, type OpeningPromptBuilder } from './ctf/prompt.js';
import { roundUsd } from './pricing.js';
import type { EventJournal } from './journal.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './adapters/types.js';

export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['preparing', 'failed'],
  preparing: ['awaiting_funding', 'failed'],
  awaiting_funding: ['ready', 'failed'],
  ready: ['running', 'failed'],
  running: ['stopping', 'failed'],
  stopping: ['finished', 'failed'],
  finished: [],
  failed: [],
};

export class RunNotFoundError extends Error {}
export class EntrantNotFoundError extends Error {}
export class InvalidTransitionError extends Error {}
export class UnknownPresetError extends Error {}

export interface CreateRunResult {
  run: RunSnapshot;
  created: boolean;
}

interface PresetEntrant {
  id: string;
  harness: HarnessId;
  model: string;
}

const PRESETS: Readonly<Record<string, readonly PresetEntrant[]>> = {
  'fake-duel': [
    { id: 'codex-1', harness: 'codex', model: 'gpt-5-codex' },
    { id: 'opencode-1', harness: 'opencode', model: 'opencode-fake-1' },
  ],
  'docker-duel': [
    { id: 'codex-1', harness: 'codex', model: 'gpt-5.5' },
    { id: 'opencode-1', harness: 'opencode', model: 'openrouter/z-ai/glm-5.2' },
  ],
};

export type FundingGate = (
  run: RunRecord,
  entrants: readonly EntrantRecord[],
  signal?: AbortSignal,
) => Promise<void>;

export type WalletGate = (
  run: RunRecord,
  entrants: readonly EntrantRecord[],
) => Promise<void>;

export interface RunManagerOptions {
  prepareTimeoutMs?: number;
  fundingTimeoutMs?: number;
  walletGate?: WalletGate;
  promptBuilder?: OpeningPromptBuilder;
}

interface EntrantUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const EMPTY_USAGE: EntrantUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };

const DEFAULT_PREPARE_TIMEOUT_MS = 300_000;
const DEFAULT_FUNDING_TIMEOUT_MS = 900_000;
const OPERATOR_STOP_REASON = 'stopped by operator before running';

// The chain funding slice replaces this pass-through hook with the real gate.
export const passThroughFundingGate: FundingGate = async () => {};
export const passThroughWalletGate: WalletGate = async () => {};

// The prompt names the chain's RPC and says where the challenge briefing lives,
// so it follows the same profile the funding gate resolves (ADR-0009).
export const profilePromptBuilder: OpeningPromptBuilder = (entrant) =>
  buildOpeningPrompt(entrant, getChainProfile(process.env.ARENA_CHAIN_PROFILE ?? 'local'));

export class RunManager {
  private readonly inFlightStarts = new Map<string, Promise<RunSnapshot>>();
  private readonly startControllers = new Map<string, AbortController>();
  private readonly operatorStops = new Set<string>();
  private readonly teardownPromises = new Map<string, Promise<PromiseSettledResult<void>[]>>();
  private readonly prepareTimeoutMs: number;
  private readonly fundingTimeoutMs: number;
  private readonly walletGate: WalletGate;
  private readonly promptBuilder: OpeningPromptBuilder;

  constructor(
    private readonly journal: EventJournal,
    private readonly driver: EntrantDriver,
    private readonly fundingGate: FundingGate = passThroughFundingGate,
    options: RunManagerOptions = {},
  ) {
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    this.fundingTimeoutMs = options.fundingTimeoutMs ?? DEFAULT_FUNDING_TIMEOUT_MS;
    this.walletGate = options.walletGate ?? passThroughWalletGate;
    this.promptBuilder = options.promptBuilder ?? profilePromptBuilder;
    // snapshot() reads scores, which chainless presets never create otherwise.
    ensureChainTables(journal.database);
  }

  async create(input: CreateRunRequest): Promise<CreateRunResult> {
    if (input.idempotencyKey !== undefined) {
      const existing = this.journal.database
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing !== undefined) {
        return { run: this.snapshot(existing.id), created: false };
      }
    }

    const preset = PRESETS[input.preset];
    if (preset === undefined) {
      throw new UnknownPresetError(`Unknown preset: ${input.preset}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.journal.database.transaction((transaction) => {
      transaction.insert(runs).values({
        id,
        state: 'created',
        preset: input.preset,
        startedAt: null,
        deadlineAt: null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
      }).run();
      transaction.insert(entrants).values(preset.map((entrant) => ({
          runId: id,
          id: entrant.id,
          harness: entrant.harness,
          model: entrant.model,
          address: null,
          status: 'idle' as const,
          flags: 0,
      }))).run();
    });
    this.journal.append(id, 'run', 'run.state', { state: 'created' });

    if (input.autoStart === true) {
      await this.start(id);
    }
    return { run: this.snapshot(id), created: true };
  }

  // One transaction so solves, usage totals, and lastEventId describe the same
  // moment. Clients skip events at or below lastEventId, so a client that also
  // folds live usage into its copy must not double-count what the snapshot holds.
  snapshot(runId: string): RunSnapshot {
    return this.journal.database.transaction(() => {
      const run = this.requireRun(runId);
      const solvesByEntrant = this.solvesByEntrant(runId);
      const usageByEntrant = this.usageByEntrant(runId);
      const entrantSummaries = this.entrants(runId).map<EntrantSummary>((entrant) => {
        const solves = solvesByEntrant.get(entrant.id) ?? [];
        const usage = usageByEntrant.get(entrant.id) ?? EMPTY_USAGE;
        return {
          id: entrant.id,
          harness: entrant.harness,
          model: entrant.model,
          address: entrant.address,
          status: entrant.status,
          flags: solves.length,
          solves,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
        };
      });
      const lastEvent = this.journal.database
        .select({ id: max(events.id) })
        .from(events)
        .where(eq(events.runId, runId))
        .get();

      return {
        id: run.id,
        state: run.state,
        preset: run.preset,
        entrants: entrantSummaries,
        startedAt: run.startedAt,
        deadlineAt: run.deadlineAt,
        lastEventId: lastEvent?.id ?? 0,
      };
    });
  }

  transition(runId: string, nextState: RunState, reason?: string): RunRecord {
    const run = this.requireRun(runId);
    if (!LEGAL_TRANSITIONS[run.state].includes(nextState)) {
      throw new InvalidTransitionError(`Cannot move run ${runId} from ${run.state} to ${nextState}`);
    }

    const startedAt = nextState === 'running' ? new Date().toISOString() : run.startedAt;
    this.journal.database
      .update(runs)
      .set({ state: nextState, startedAt })
      .where(eq(runs.id, runId))
      .run();
    const payload = reason === undefined ? { state: nextState } : { state: nextState, reason };
    this.journal.append(runId, 'run', 'run.state', payload);
    return this.requireRun(runId);
  }

  start(runId: string): Promise<RunSnapshot> {
    const existing = this.inFlightStarts.get(runId);
    if (existing !== undefined) return existing;

    const run = this.requireRun(runId);
    if (run.state !== 'created' && run.state !== 'ready') {
      return Promise.reject(new InvalidTransitionError(`Cannot start run ${runId} from ${run.state}`));
    }

    const controller = new AbortController();
    const starting = this.startOwned(runId, controller).finally(() => {
      if (this.inFlightStarts.get(runId) === starting) this.inFlightStarts.delete(runId);
      if (this.startControllers.get(runId) === controller) this.startControllers.delete(runId);
      this.clearTeardownWhenSafe(runId);
    });
    this.inFlightStarts.set(runId, starting);
    this.startControllers.set(runId, controller);
    return starting;
  }

  private async startOwned(runId: string, controller: AbortController): Promise<RunSnapshot> {
    let run = this.requireRun(runId);
    const runEntrants = this.entrants(runId);
    try {
      if (run.state === 'created') {
        run = this.transition(runId, 'preparing');
        await this.walletGate(run, runEntrants);
        const prepareResults = await withPhaseTimeout(
          Promise.allSettled(runEntrants.map((entrant) => this.driver.prepare(run, entrant))),
          this.prepareTimeoutMs,
          'prepare',
          controller,
        );
        const prepareFailure = prepareResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (prepareFailure !== undefined) {
          throw prepareFailure.reason;
        }
        run = this.transition(runId, 'awaiting_funding');
        await withPhaseTimeout(
          this.fundingGate(run, runEntrants, controller.signal),
          this.fundingTimeoutMs,
          'funding',
          controller,
        );
        run = this.transition(runId, 'ready');
      }
      if (run.state !== 'ready') {
        throw new InvalidTransitionError(`Cannot start run ${runId} from ${run.state}`);
      }

      run = this.transition(runId, 'running');
      const preset = PRESETS[run.preset];
      if (preset === undefined) throw new UnknownPresetError(`Unknown preset: ${run.preset}`);
      await Promise.all(runEntrants.map(async (entrant) => {
        const entrantPreset = preset.find((candidate) => candidate.id === entrant.id);
        if (entrantPreset === undefined) throw new Error(`Preset has no entrant ${entrant.id}`);
        await this.driver.start(run, entrant, this.promptBuilder(entrant));
      }));
      return this.snapshot(runId);
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(asError(error));
      let current = this.requireRun(runId);
      if (!this.operatorStops.has(runId) && current.state !== 'failed' && current.state !== 'finished') {
        current = this.transition(runId, 'failed', errorMessage(error));
      }
      await this.teardownEntrants(runId, current, runEntrants);
      throw error;
    }
  }

  async stop(runId: string): Promise<RunSnapshot> {
    let run = this.requireRun(runId);
    if (!(['preparing', 'awaiting_funding', 'ready', 'running'] as RunState[]).includes(run.state)) {
      throw new InvalidTransitionError(`Cannot stop run ${runId} from ${run.state}`);
    }

    const runEntrants = this.entrants(runId);
    this.operatorStops.add(runId);
    try {
      if (run.state !== 'running') {
        this.startControllers.get(runId)?.abort(new Error(OPERATOR_STOP_REASON));
        run = this.transition(runId, 'failed', OPERATOR_STOP_REASON);
        const stopResults = await this.teardownEntrants(runId, run, runEntrants);
        const stopError = aggregateStopErrors(stopResults);
        if (stopError !== undefined) throw stopError;
        return this.snapshot(runId);
      }

      run = this.transition(runId, 'stopping');
      const stopResults = await this.teardownEntrants(runId, run, runEntrants);
      const stopError = aggregateStopErrors(stopResults);
      if (stopError !== undefined) throw stopError;
      this.transition(runId, 'finished');
      return this.snapshot(runId);
    } catch (error) {
      const current = this.requireRun(runId);
      if (current.state !== 'failed' && current.state !== 'finished') {
        this.transition(runId, 'failed', errorMessage(error));
      }
      throw error;
    } finally {
      this.operatorStops.delete(runId);
      this.clearTeardownWhenSafe(runId);
    }
  }

  async steer(runId: string, entrantId: string, text: string): Promise<void> {
    const run = this.requireRun(runId);
    const entrant = this.journal.database
      .select()
      .from(entrants)
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
      .get();
    if (entrant === undefined) {
      throw new EntrantNotFoundError(`Entrant ${entrantId} does not exist in run ${runId}`);
    }
    await this.driver.steer(run, entrant, text);
  }

  hasRun(runId: string): boolean {
    return this.journal.database
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .get() !== undefined;
  }

  countRuns(): number {
    return this.journal.database.select({ value: count() }).from(runs).get()?.value ?? 0;
  }

  private teardownEntrants(
    runId: string,
    run: RunRecord,
    runEntrants: readonly EntrantRecord[],
  ): Promise<PromiseSettledResult<void>[]> {
    const existing = this.teardownPromises.get(runId);
    if (existing !== undefined) return existing;

    const teardown = Promise.allSettled(
      runEntrants.map((entrant) => this.driver.stop(run, entrant)),
    );
    this.teardownPromises.set(runId, teardown);
    return teardown;
  }

  private clearTeardownWhenSafe(runId: string): void {
    if (this.inFlightStarts.has(runId) || this.operatorStops.has(runId)) return;
    this.teardownPromises.delete(runId);
  }

  private requireRun(runId: string): RunRecord {
    const run = this.journal.database.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) {
      throw new RunNotFoundError(`Run not found: ${runId}`);
    }
    return run;
  }

  // The entrants.flags column is never written after creation, so both the solved
  // list and the count come from scores rows — recordSolve keeps those 1:1 with
  // score.flag events, one per confirmed, deduped capture.
  private solvesByEntrant(runId: string): Map<string, EntrantSolve[]> {
    const rows = this.journal.database
      .select({
        entrantId: scores.entrantId,
        challengeId: scores.challengeId,
        txHash: scores.txHash,
        solvedAt: scores.solvedAt,
      })
      .from(scores)
      .where(eq(scores.runId, runId))
      .orderBy(asc(scores.id))
      .all();

    const byEntrant = new Map<string, EntrantSolve[]>();
    for (const row of rows) {
      const solves = byEntrant.get(row.entrantId) ?? [];
      solves.push({ challengeId: row.challengeId, ts: row.solvedAt, txHash: row.txHash });
      byEntrant.set(row.entrantId, solves);
    }
    return byEntrant;
  }

  // Totals come from the journal's usage events, the same rows the live feed
  // ships, so a reload lands on exactly what the client had already summed.
  // SUM ignores nulls and returns null when every row is null, which is the
  // "no entrant turn carried a price" case.
  private usageByEntrant(runId: string): Map<string, EntrantUsage> {
    const entrantId = sql<string>`json_extract(${events.payloadJson}, '$.entrantId')`;
    const rows = this.journal.database
      .select({
        entrantId,
        inputTokens: sql<number>`coalesce(sum(json_extract(${events.payloadJson}, '$.inputTokens')), 0)`,
        outputTokens: sql<number>`coalesce(sum(json_extract(${events.payloadJson}, '$.outputTokens')), 0)`,
        costUsd: sql<number | null>`sum(json_extract(${events.payloadJson}, '$.costUsd'))`,
      })
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, 'usage')))
      .groupBy(entrantId)
      .all();

    return new Map(rows.map((row) => [row.entrantId, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd === null ? null : roundUsd(row.costUsd),
    }]));
  }

  private entrants(runId: string): EntrantRecord[] {
    return this.journal.database
      .select()
      .from(entrants)
      .where(eq(entrants.runId, runId))
      .orderBy(asc(entrants.id))
      .all();
  }
}

function withPhaseTimeout<T>(
  action: Promise<T>,
  timeoutMs: number,
  phase: 'prepare' | 'funding',
  controller: AbortController,
): Promise<T> {
  const { signal } = controller;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => rejectOnce(abortReason(signal));
    const timer = setTimeout(() => {
      controller.abort(new Error(`${phase} phase timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
    action.then(resolveOnce, rejectOnce);
  });
}

function abortReason(signal: AbortSignal): Error {
  return asError(signal.reason ?? 'Start aborted');
}

function aggregateStopErrors(results: readonly PromiseSettledResult<void>[]): AggregateError | undefined {
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length === 0) return undefined;
  const suffix = errors.length === 1 ? '' : 's';
  return new AggregateError(errors, `Failed to stop ${errors.length} entrant${suffix}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
