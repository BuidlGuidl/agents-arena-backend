import { randomUUID } from 'node:crypto';

import { and, asc, count, desc, eq, inArray, max, ne, notInArray, sql } from 'drizzle-orm';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type {
  CreateRunRequest,
  EntrantSolve,
  EntrantSummary,
  RosterEntry,
  RunListItem,
  RunSnapshot,
  RunState,
  SteerDelivery,
} from './contract.js';
import { entrants, events, runs, scores } from './db/schema.js';
import { ensureChainTables } from './chain/storage.js';
import { activeChainProfile } from './chain/profile.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from './chain/local-dev.js';
import {
  canonicalizeSeedSignature,
  deriveEntrantKeys,
  dropRunKeys,
  seedTypedData,
} from './chain/wallet.js';
import { buildOpeningPrompt, type OpeningPromptBuilder } from './ctf/prompt.js';
import { roundUsd } from './pricing.js';
import type { EventJournal } from './journal.js';
import { dropCredentialSecrets } from './adapters/credential-secrets.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './adapters/types.js';
import { normalizeOperatorAddresses } from './siwe.js';

export const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  created: ['awaiting_signature', 'preparing', 'failed'],
  awaiting_signature: ['preparing', 'stopping', 'failed'],
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
export class SeedStateConflictError extends Error {}
export class SeedEncodingError extends Error {}
export class SeedSignatureError extends Error {}
export class ActiveRunConflictError extends Error {
  constructor(
    message: string,
    readonly activeRunId: string,
    readonly activeRunState: RunState,
  ) {
    super(message);
  }
}

export interface CreateRunResult {
  run: RunSnapshot;
  created: boolean;
}

export interface BroadcastResult {
  delivered: string[];
  queued: string[];
  failed: { entrantId: string; message: string }[];
}

type PresetEntrant = RosterEntry;

export type PresetSubstrate = 'docker' | 'fake';

interface Preset {
  substrate: PresetSubstrate;
  entrants: readonly PresetEntrant[];
}

const PRESETS: Readonly<Record<string, Preset>> = {
  'fake-duel': {
    substrate: 'fake',
    entrants: [
      { id: 'codex-1', harness: 'codex', model: 'gpt-5-codex' },
      { id: 'opencode-1', harness: 'opencode', model: 'opencode-fake-1' },
    ],
  },
  'docker-duel': {
    substrate: 'docker',
    entrants: [
      { id: 'codex-1', harness: 'codex', model: 'gpt-5.5' },
      { id: 'opencode-1', harness: 'opencode', model: 'openrouter/z-ai/glm-5.3' },
    ],
  },
  'docker-arena': {
    substrate: 'docker',
    entrants: [
      { id: 'codex-1', harness: 'codex', model: 'gpt-5.5' },
      { id: 'opencode-1', harness: 'opencode', model: 'openrouter/z-ai/glm-5.3' },
      { id: 'claude-1', harness: 'claude', model: 'claude-opus-5' },
    ],
  },
};

export function presetSubstrate(name: string): PresetSubstrate {
  const preset = PRESETS[name];
  if (preset === undefined) {
    throw new UnknownPresetError(`Unknown preset: ${name}`);
  }
  return preset.substrate;
}

export type FundingGate = (
  run: RunRecord,
  entrants: readonly EntrantRecord[],
  signal?: AbortSignal,
) => Promise<void>;

// Not a gate: a gate is awaited to completion and a poll loop never resolves. The run
// starts this once it is past funding and aborts the signal when it stops.
export type SolveWatch = (
  run: RunRecord,
  entrants: readonly EntrantRecord[],
  signal: AbortSignal,
) => void;

export type NarrationWatch = (
  run: RunRecord,
  entrants: readonly EntrantRecord[],
  signal: AbortSignal,
) => void;

export interface RunManagerOptions {
  prepareTimeoutMs?: number;
  fundingTimeoutMs?: number;
  operatorAddresses?: readonly string[];
  solveWatch?: SolveWatch;
  narrationWatch?: NarrationWatch;
  promptBuilder?: OpeningPromptBuilder;
}

interface EntrantUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

interface SeedWaiter {
  promise: Promise<void>;
  resolve(): void;
  submitting: boolean;
}

const EMPTY_USAGE: EntrantUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };

const DEFAULT_PREPARE_TIMEOUT_MS = 300_000;
const NARRATION_STOP_GRACE_MS = 45_000;
const OPERATOR_STOP_REASON = 'stopped by operator before running';
const ACTIVE_RUN_STATES: RunState[] = [
  'awaiting_signature',
  'preparing',
  'awaiting_funding',
  'ready',
  'running',
  'stopping',
];

// The chain funding slice replaces this pass-through hook with the real gate.
export const passThroughFundingGate: FundingGate = async () => {};
export const passThroughSolveWatch: SolveWatch = () => {};
export const passThroughNarrationWatch: NarrationWatch = () => {};

// The prompt names the chain's RPC and says where the challenge briefing lives,
// so it follows the same profile the funding gate resolves (ADR-0009).
export const profilePromptBuilder: OpeningPromptBuilder = (entrant) =>
  buildOpeningPrompt(entrant, activeChainProfile);

export class RunManager {
  private readonly inFlightStarts = new Map<string, Promise<RunSnapshot>>();
  private readonly startControllers = new Map<string, AbortController>();
  private readonly seedWaiters = new Map<string, SeedWaiter>();
  private readonly operatorStops = new Set<string>();
  private readonly teardownPromises = new Map<string, Promise<PromiseSettledResult<void>[]>>();
  private readonly solveWatchControllers = new Map<string, AbortController>();
  private readonly narrationWatchControllers = new Map<string, AbortController>();
  private readonly narrationStopTimers = new Map<string, NodeJS.Timeout>();
  private readonly prepareTimeoutMs: number;
  private readonly fundingTimeoutMs: number | undefined;
  private readonly operatorAddresses: ReadonlySet<string>;
  private readonly solveWatch: SolveWatch;
  private readonly narrationWatch: NarrationWatch;
  private readonly promptBuilder: OpeningPromptBuilder;

  constructor(
    private readonly journal: EventJournal,
    private readonly driver: EntrantDriver,
    private readonly fundingGate: FundingGate = passThroughFundingGate,
    options: RunManagerOptions = {},
  ) {
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    this.fundingTimeoutMs = options.fundingTimeoutMs ?? activeChainProfile.fundingTimeoutMs;
    this.operatorAddresses = new Set(normalizeOperatorAddresses(options.operatorAddresses ?? []));
    this.solveWatch = options.solveWatch ?? passThroughSolveWatch;
    this.narrationWatch = options.narrationWatch ?? passThroughNarrationWatch;
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
    this.assertNoActiveRun();

    const id = randomUUID();
    const now = new Date().toISOString();
    this.journal.database.transaction((transaction) => {
      transaction.insert(runs).values({
        id,
        state: 'created',
        preset: input.preset,
        startedAt: null,
        deadlineAt: null,
        durationMs: input.durationMs ?? null,
        seededBy: null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
      }).run();
      transaction.insert(entrants).values((input.roster ?? preset.entrants).map((entrant) => ({
          runId: id,
          id: entrant.id,
          harness: entrant.harness,
          model: entrant.model,
          effort: entrant.effort ?? null,
          address: null,
          status: 'idle' as const,
      }))).run();
    });
    this.journal.append(id, 'run', 'run.state', { state: 'created' });

    if (input.autoStart === true) {
      await this.startForRequest(id);
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
      const challengeByEntrant = this.challengeByEntrant(runId);
      const narrationByEntrant = this.narrationByEntrant(runId);
      const entrantSummaries = this.entrants(runId).map<EntrantSummary>((entrant) => {
        const solves = solvesByEntrant.get(entrant.id) ?? [];
        const usage = usageByEntrant.get(entrant.id) ?? EMPTY_USAGE;
        const narration = narrationByEntrant.get(entrant.id);
        return {
          id: entrant.id,
          harness: entrant.harness,
          model: entrant.model,
          ...(entrant.effort === null ? {} : { effort: entrant.effort }),
          address: entrant.address,
          status: entrant.status,
          flags: solves.length,
          solves,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
          currentChallengeId: challengeByEntrant.get(entrant.id) ?? null,
          ...(narration === undefined ? {} : { narration }),
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
        chainId: activeChainProfile.chainId,
        ...(run.seededBy === null ? {} : { seededBy: run.seededBy }),
        entrants: entrantSummaries,
        startedAt: run.startedAt,
        deadlineAt: run.deadlineAt,
        lastEventId: lastEvent?.id ?? 0,
      };
    });
  }

  // One query with an entrant count join. The expensive parts — solves, usage,
  // scores — stay on snapshot(), so the list is cheap at any run count.
  list(limit: number): RunListItem[] {
    return this.journal.database
      .select({
        id: runs.id,
        state: runs.state,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        agentCount: count(entrants.runId),
      })
      .from(runs)
      .leftJoin(entrants, eq(entrants.runId, runs.id))
      .groupBy(runs.id)
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .all();
  }

  transition(runId: string, nextState: RunState, reason?: string): RunRecord {
    const run = this.requireRun(runId);
    if (!LEGAL_TRANSITIONS[run.state].includes(nextState)) {
      throw new InvalidTransitionError(`Cannot move run ${runId} from ${run.state} to ${nextState}`);
    }

    const startTime = nextState === 'running' ? new Date() : undefined;
    const startedAt = startTime?.toISOString() ?? run.startedAt;
    const deadlineAt = startTime !== undefined && run.durationMs !== null
      ? new Date(startTime.getTime() + run.durationMs).toISOString()
      : run.deadlineAt;
    this.journal.database
      .update(runs)
      .set({ state: nextState, startedAt, deadlineAt })
      .where(eq(runs.id, runId))
      .run();
    const payload = reason === undefined ? { state: nextState } : { state: nextState, reason };
    this.journal.append(runId, 'run', 'run.state', payload);
    return this.requireRun(runId);
  }

  async submitSeed(runId: string, signature: Hex): Promise<RunSnapshot> {
    return this.submitSeedInternal(runId, signature, false);
  }

  private async submitSeedInternal(
    runId: string,
    signature: Hex,
    bypassOperatorAllowlist: boolean,
  ): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    const waiter = this.seedWaiters.get(runId);
    if (run.state === 'awaiting_signature' && waiter === undefined) {
      throw new SeedStateConflictError(
        'Backend restarted while this run awaited its signature; stop the run and create a new one.',
      );
    }
    if (run.state !== 'awaiting_signature' || waiter === undefined || waiter.submitting) {
      throw new SeedStateConflictError('Run is not awaiting a seed signature');
    }
    waiter.submitting = true;

    let canonicalSignature: Hex;
    try {
      canonicalSignature = canonicalizeSeedSignature(signature);
    } catch {
      waiter.submitting = false;
      throw new SeedEncodingError(
        'Signature encoding is not canonical (expects low-s, v 27/28).',
      );
    }

    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        ...seedTypedData(runId, activeChainProfile.chainId),
        signature: canonicalSignature,
      });
    } catch {
      waiter.submitting = false;
      throw new SeedSignatureError('Seed signature is not authorized');
    }
    if (!bypassOperatorAllowlist && !this.operatorAddresses.has(recovered.toLowerCase())) {
      waiter.submitting = false;
      throw new SeedSignatureError('Seed signature is not authorized');
    }

    const current = this.requireRun(runId);
    if (current.state !== 'awaiting_signature' || this.seedWaiters.get(runId) !== waiter) {
      throw new SeedStateConflictError('Run is not awaiting a seed signature');
    }

    const runEntrants = this.entrants(runId);
    let addresses: ReadonlyMap<string, string>;
    try {
      addresses = deriveEntrantKeys(
        runId,
        canonicalSignature,
        runEntrants.map((entrant) => entrant.id),
      );
    } catch {
      waiter.submitting = false;
      throw new SeedSignatureError('Seed signature is not authorized');
    }

    try {
      this.journal.transaction(() => {
        this.journal.database
          .update(runs)
          .set({ seededBy: recovered })
          .where(eq(runs.id, runId))
          .run();
        for (const entrant of runEntrants) {
          const address = addresses.get(entrant.id);
          if (address === undefined) {
            throw new Error(`No derived address for entrant ${entrant.id}`);
          }
          this.journal.database
            .update(entrants)
            .set({ address })
            .where(and(eq(entrants.runId, runId), eq(entrants.id, entrant.id)))
            .run();
          this.journal.append(runId, entrant.id, 'wallet.assigned', {
            entrantId: entrant.id,
            address,
          });
        }
      });
    } catch (error) {
      dropRunKeys(runId);
      dropCredentialSecrets(runId);
      waiter.submitting = false;
      throw error;
    }

    waiter.resolve();
    return this.snapshot(runId);
  }

  start(runId: string): Promise<RunSnapshot> {
    // TODO: a go sent while the first phase is still preparing joins it here and
    // is lost — the caller gets a 200 and the run parks at `ready` with nobody
    // left to advance it. Give the go its own route (or 409 while a start is in
    // flight) so timing cannot change what this call means.
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

  async startForRequest(runId: string): Promise<RunSnapshot> {
    const run = this.requireRun(runId);
    this.assertNoActiveRun(runId);
    const starting = this.start(runId);
    if (presetSubstrate(run.preset) !== 'docker' || localAutoSignEnabled()) {
      return starting;
    }
    void starting.catch(() => {});
    return this.snapshot(runId);
  }

  private async startOwned(runId: string, controller: AbortController): Promise<RunSnapshot> {
    let run = this.requireRun(runId);
    let runEntrants = this.entrants(runId);
    try {
      if (run.state === 'created') {
        if (presetSubstrate(run.preset) === 'docker') {
          const seedWaiter = createSeedWaiter();
          this.seedWaiters.set(runId, seedWaiter);
          run = this.transition(runId, 'awaiting_signature');
          try {
            if (localAutoSignEnabled()) {
              const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
              const signature = await account.signTypedData(
                seedTypedData(runId, activeChainProfile.chainId),
              );
              await this.submitSeedInternal(runId, signature, true);
            }
            await withAbort(seedWaiter.promise, controller);
          } finally {
            if (this.seedWaiters.get(runId) === seedWaiter) {
              this.seedWaiters.delete(runId);
            }
          }
        }

        runEntrants = this.entrants(runId);
        run = this.transition(runId, 'preparing');
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
        // The director starts the race, not the last wallet to be topped up.
        // Funding is theirs to drive by hand, so the run parks here and a second
        // POST /runs/:id/start takes it to `running` — the deadline, the opening
        // prompts and the countdown all hang off that moment. Chainless presets
        // have nothing to fund and nobody watching, so they run straight through.
        if (presetSubstrate(run.preset) === 'docker') return this.snapshot(runId);
      }
      if (run.state !== 'ready') {
        throw new InvalidTransitionError(`Cannot start run ${runId} from ${run.state}`);
      }

      run = this.transition(runId, 'running');
      // Before the entrants start, so the first mint of the race is already covered.
      this.startSolveWatch(run, runEntrants);
      this.startNarrationWatch(run, runEntrants);
      if (PRESETS[run.preset] === undefined) {
        throw new UnknownPresetError(`Unknown preset: ${run.preset}`);
      }
      await Promise.all(runEntrants.map(async (entrant) => {
        await this.driver.start(run, entrant, this.promptBuilder(entrant));
      }));
      return this.snapshot(runId);
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(asError(error));
      this.stopSolveWatch(runId);
      this.stopNarrationWatch(runId);
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
    if (!(
      ['awaiting_signature', 'preparing', 'awaiting_funding', 'ready', 'running'] as RunState[]
    ).includes(run.state)) {
      this.stopNarrationWatch(runId);
      throw new InvalidTransitionError(`Cannot stop run ${runId} from ${run.state}`);
    }

    const runEntrants = this.entrants(runId);
    let teardownResolved = false;
    this.operatorStops.add(runId);
    this.stopSolveWatch(runId);
    dropRunKeys(runId);
    dropCredentialSecrets(runId);
    try {
      if (run.state === 'awaiting_signature') {
        this.startControllers.get(runId)?.abort(new Error(OPERATOR_STOP_REASON));
        run = this.transition(runId, 'stopping');
        const stopResults = await this.teardownEntrants(runId, run, runEntrants);
        teardownResolved = true;
        const stopError = aggregateStopErrors(stopResults);
        if (stopError !== undefined) throw stopError;
        this.transition(runId, 'finished');
        return this.snapshot(runId);
      }

      if (run.state !== 'running') {
        this.startControllers.get(runId)?.abort(new Error(OPERATOR_STOP_REASON));
        run = this.transition(runId, 'failed', OPERATOR_STOP_REASON);
        const stopResults = await this.teardownEntrants(runId, run, runEntrants);
        teardownResolved = true;
        const stopError = aggregateStopErrors(stopResults);
        if (stopError !== undefined) throw stopError;
        return this.snapshot(runId);
      }

      run = this.transition(runId, 'stopping');
      const stopResults = await this.teardownEntrants(runId, run, runEntrants);
      teardownResolved = true;
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
      if (teardownResolved) this.scheduleNarrationWatchStop(runId);
      this.operatorStops.delete(runId);
      this.clearTeardownWhenSafe(runId);
    }
  }

  async steer(runId: string, entrantId: string, text: string): Promise<SteerDelivery> {
    const run = this.requireRun(runId);
    const entrant = this.requireEntrant(runId, entrantId);
    return this.deliver(run, entrant, text, 'Steer');
  }

  // One lane, alone: a blocked or stale entrant gets a fresh session fed the
  // same opening prompt, and the rest of the field keeps racing untouched.
  //
  // Only a running run may be restarted, for the reason a broadcast may not
  // reach a run that has not started: before the opening turn there is no
  // session to replace, and after the race the lane is torn down.
  async restart(runId: string, entrantId: string): Promise<void> {
    const run = this.requireRun(runId);
    // Existence before state, as steer does: a name that was never on the roster
    // is a 404 whatever the run is doing, and the docs promise that.
    const entrant = this.requireEntrant(runId, entrantId);
    if (run.state !== 'running') {
      throw new InvalidTransitionError(
        `Cannot restart entrant ${entrantId} in run ${runId} in state ${run.state}`,
      );
    }
    // The prompt is rebuilt, not replayed: it is a pure function of the entrant,
    // whose wallet address the seed already fixed, so it comes out identical.
    try {
      await this.driver.restart(run, entrant, this.promptBuilder(entrant));
    } catch (error) {
      this.journal.append(runId, entrant.id, 'entrant.error', {
        entrantId: entrant.id,
        message: `Restart failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  }

  // The director speaks once and every entrant still in the fight hears it. The
  // broadcast event lands before the fan-out so the feed reads message-then-turns,
  // and a steer that throws is reported back instead of thrown: one wedged entrant
  // must not swallow the message for the rest.
  //
  // Only a running run may be addressed. Before the opening turn the harness has no
  // session to resume, and a steer there degrades the entrant for the rest of the
  // run — one early broadcast would take out the whole field.
  async broadcast(runId: string, text: string): Promise<BroadcastResult> {
    const run = this.requireRun(runId);
    if (run.state !== 'running') {
      throw new InvalidTransitionError(`Cannot broadcast to run ${runId} in state ${run.state}`);
    }
    const live = this.entrants(runId).filter((entrant) => entrant.status !== 'done');
    // Who the director addressed. Delivery truth is the response, not this list:
    // a busy entrant queues the turn, and a wedged one lands in `failed`.
    this.journal.append(runId, 'run', 'director.broadcast', {
      text,
      targetEntrantIds: live.map((entrant) => entrant.id),
    });

    const outcomes = await Promise.all(live.map(async (entrant) => {
      try {
        const status = await this.deliver(run, entrant, text, 'Broadcast');
        return { entrantId: entrant.id, status, message: undefined };
      } catch (error) {
        return { entrantId: entrant.id, status: undefined, message: errorMessage(error) };
      }
    }));

    const delivered: string[] = [];
    const queued: string[] = [];
    const failed: BroadcastResult['failed'] = [];
    for (const outcome of outcomes) {
      if (outcome.message === undefined) {
        delivered.push(outcome.entrantId);
        if (outcome.status === 'queued') queued.push(outcome.entrantId);
        continue;
      }
      failed.push({ entrantId: outcome.entrantId, message: outcome.message });
    }
    return { delivered, queued, failed };
  }

  // Every operator message travels this path so a miss is recorded on the lane it
  // missed, whoever asked for it. The error keeps its type for the caller to map.
  private async deliver(
    run: RunRecord,
    entrant: EntrantRecord,
    text: string,
    label: 'Steer' | 'Broadcast',
  ): Promise<SteerDelivery> {
    try {
      return await this.driver.steer(run, entrant, text);
    } catch (error) {
      this.journal.append(run.id, entrant.id, 'entrant.error', {
        entrantId: entrant.id,
        message: `${label} not delivered: ${errorMessage(error)}`,
      });
      throw error;
    }
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

  failNonTerminalRuns(reason: string): number {
    this.stopAllNarrationWatches();
    return this.journal.transaction(() => {
      const interrupted = this.journal.database
        .select({ id: runs.id })
        .from(runs)
        .where(notInArray(runs.state, ['finished', 'failed']))
        .all();
      for (const run of interrupted) this.transition(run.id, 'failed', reason);
      return interrupted.length;
    });
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
    ).finally(() => {
      dropRunKeys(runId);
      dropCredentialSecrets(runId);
    });
    this.teardownPromises.set(runId, teardown);
    return teardown;
  }

  private startSolveWatch(run: RunRecord, runEntrants: readonly EntrantRecord[]): void {
    this.stopSolveWatch(run.id);
    const controller = new AbortController();
    this.solveWatchControllers.set(run.id, controller);
    this.solveWatch(run, runEntrants, controller.signal);
  }

  private stopSolveWatch(runId: string): void {
    this.solveWatchControllers.get(runId)?.abort();
    this.solveWatchControllers.delete(runId);
  }

  private startNarrationWatch(run: RunRecord, runEntrants: readonly EntrantRecord[]): void {
    this.stopNarrationWatch(run.id);
    const controller = new AbortController();
    this.narrationWatchControllers.set(run.id, controller);
    this.narrationWatch(run, runEntrants, controller.signal);
  }

  private stopNarrationWatch(runId: string): void {
    const timer = this.narrationStopTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    this.narrationStopTimers.delete(runId);
    this.narrationWatchControllers.get(runId)?.abort();
    this.narrationWatchControllers.delete(runId);
  }

  private scheduleNarrationWatchStop(runId: string): void {
    const controller = this.narrationWatchControllers.get(runId);
    if (controller === undefined || controller.signal.aborted) return;
    const existing = this.narrationStopTimers.get(runId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => this.stopNarrationWatch(runId), NARRATION_STOP_GRACE_MS);
    timer.unref();
    this.narrationStopTimers.set(runId, timer);
  }

  private stopAllNarrationWatches(): void {
    const runIds = new Set([
      ...this.narrationWatchControllers.keys(),
      ...this.narrationStopTimers.keys(),
    ]);
    for (const runId of runIds) this.stopNarrationWatch(runId);
  }

  private clearTeardownWhenSafe(runId: string): void {
    if (this.inFlightStarts.has(runId) || this.operatorStops.has(runId)) return;
    this.teardownPromises.delete(runId);
  }

  private assertNoActiveRun(excludedRunId?: string): void {
    const active = this.journal.database
      .select({ id: runs.id, state: runs.state })
      .from(runs)
      .where(and(
        inArray(runs.state, ACTIVE_RUN_STATES),
        ...(excludedRunId === undefined ? [] : [ne(runs.id, excludedRunId)]),
      ))
      .orderBy(asc(runs.createdAt))
      .get();
    if (active !== undefined) {
      throw new ActiveRunConflictError(
        `Run ${active.id} is active in state ${active.state}`,
        active.id,
        active.state,
      );
    }
  }

  private requireEntrant(runId: string, entrantId: string): EntrantRecord {
    const entrant = this.journal.database
      .select()
      .from(entrants)
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
      .get();
    if (entrant === undefined) {
      throw new EntrantNotFoundError(`Entrant ${entrantId} does not exist in run ${runId}`);
    }
    return entrant;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.journal.database.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) {
      throw new RunNotFoundError(`Run not found: ${runId}`);
    }
    return run;
  }

  // Both the solved list and count come from scores rows because recordSolve keeps
  // them 1:1 with score.flag events, one per confirmed, deduped capture.
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

  // The latest entrant.challenge guess per entrant — the same rows the live feed
  // ships, so a reload lands where the client already was.
  private challengeByEntrant(runId: string): Map<string, number> {
    const entrantId = sql<string>`json_extract(${events.payloadJson}, '$.entrantId')`;
    const rows = this.journal.database
      .select({
        entrantId,
        challengeId: sql<number>`json_extract(${events.payloadJson}, '$.challengeId')`,
      })
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, 'entrant.challenge')))
      .orderBy(asc(events.id))
      .all();

    return new Map(rows.map((row) => [row.entrantId, row.challengeId]));
  }

  private narrationByEntrant(
    runId: string,
  ): Map<string, { text: string; ts: string; basedOnEventId: number }> {
    const entrantId = sql<string>`json_extract(${events.payloadJson}, '$.entrantId')`;
    const rows = this.journal.database
      .select({
        entrantId,
        text: sql<string>`json_extract(${events.payloadJson}, '$.text')`,
        ts: events.ts,
        basedOnEventId: sql<number>`json_extract(${events.payloadJson}, '$.basedOnEventId')`,
      })
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.type, 'entrant.narration')))
      .orderBy(asc(events.id))
      .all();

    return new Map(rows.map((row) => [row.entrantId, {
      text: row.text,
      ts: row.ts,
      basedOnEventId: row.basedOnEventId,
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
  timeoutMs: number | undefined,
  phase: 'prepare' | 'funding',
  controller: AbortController,
): Promise<T> {
  const { signal } = controller;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        controller.abort(new Error(`${phase} phase timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    timer?.unref();
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
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
    signal.addEventListener('abort', onAbort, { once: true });
    action.then(resolveOnce, rejectOnce);
  });
}

function withAbort<T>(action: Promise<T>, controller: AbortController): Promise<T> {
  const { signal } = controller;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    action.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function createSeedWaiter(): SeedWaiter {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve, submitting: false };
}

export function localAutoSignEnabled(): boolean {
  return activeChainProfile.name === 'local' && process.env.ARENA_AUTO_SIGN !== 'false';
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
