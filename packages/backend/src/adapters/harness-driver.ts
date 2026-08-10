import { and, eq } from 'drizzle-orm';

import type { EntrantStatus, SteerDelivery } from '../contract.js';
import { entrants } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import { costForTokens } from '../pricing.js';
import type {
  ContainerFactory,
  EntrantContainer,
  RuntimeExecution,
} from '../runtime/container.js';
import { createDockerContainer } from '../runtime/container.js';
import { revokeAgentToken } from '../agent-auth.js';
import {
  challengeAddressIndex,
  currentChallenge,
  dropCurrentChallenge,
  matchChallenge,
  recordCurrentChallenge,
} from '../ctf/challenge-tracker.js';
import type { ChallengePackAccess, ChallengePackResolver } from '../ctf/resolve.js';
import { EntrantUnavailableError, type EntrantDriver, type EntrantRecord, type RunRecord } from './types.js';
import type { HarnessLineParser, ParsedArenaEvent, ParserLogger } from './parser-types.js';

export interface HarnessDriverOptions {
  containerFactory?: ContainerFactory;
  rpcUrl?: string;
  logger?: ParserLogger;
  // Returns the assembled challenge pack directory for a run, mounted read-only
  // into every entrant container. Throwing here fails prepare, which is how a
  // missing ai-ctf checkout surfaces (ADR-0009).
  resolveChallengePack?: ChallengePackResolver;
  // The pack's deployed addresses, for the current-challenge heuristic. Absent
  // on briefing-URL profiles, where only name matching applies.
  challengeAddresses?: ChallengePackAccess['addressesFor'];
  // The backend base URL as seen from inside an entrant container, for the
  // agent-facing routes (POST /agent/progress).
  agentApiUrl?: string;
}

interface EntrantRuntimeState {
  run: RunRecord;
  entrant: EntrantRecord;
  container: EntrantContainer;
  queuedSteers: string[];
  running: boolean;
  stopping: boolean;
  restarting: boolean;
  // Set while something waits for the turn in flight to end. A turn still inside
  // its launch has no execution to kill yet, so runTurn reads this the moment
  // one exists — without it a restart arriving mid-launch skips the kill and
  // then waits out the whole turn, stranding the lane it came to save.
  killRequested: boolean;
  degraded: boolean;
  // Cleared on restart: the session it names is the one being abandoned.
  sessionId: string | undefined;
  active: RuntimeExecution | undefined;
  turnTask: Promise<void> | undefined;
  // Lazy: built on the first tool.call, when the pack addresses already exist.
  addressIndex?: ReadonlyMap<string, number>;
}

export abstract class HarnessEntrantDriver implements EntrantDriver {
  protected readonly containerFactory: ContainerFactory;
  protected readonly rpcUrl: string;
  protected readonly agentApiUrl: string;
  protected readonly logger: ParserLogger;
  private readonly challengeAddresses: ChallengePackAccess['addressesFor'] | undefined;
  private readonly states = new Map<string, EntrantRuntimeState>();
  // Keyed like states — by run and entrant, not by entrant alone. Entrant ids are
  // preset literals, so two runs in flight would otherwise share one parser and
  // interleave their sessions through its state.
  private readonly parsers = new Map<string, HarnessLineParser>();

  protected constructor(
    protected readonly journal: EventJournal,
    options: HarnessDriverOptions = {},
  ) {
    const factory = options.containerFactory ?? createDockerContainer;
    const resolveChallengePack = options.resolveChallengePack;
    // Wrapped once here so every adapter's createContainer picks the mount up
    // without repeating it.
    this.containerFactory = resolveChallengePack === undefined
      ? factory
      : (containerOptions) => factory({
        ...containerOptions,
        challengePackDir: resolveChallengePack(containerOptions.runId),
      });
    this.rpcUrl = options.rpcUrl ?? process.env.ARENA_RPC_URL ?? 'http://host.docker.internal:8545';
    // Containers reach the host the same way they reach the chain RPC.
    this.agentApiUrl = options.agentApiUrl
      ?? process.env.ARENA_AGENT_API_URL
      ?? `http://host.docker.internal:${process.env.PORT ?? 4177}`;
    this.logger = options.logger ?? console;
    this.challengeAddresses = options.challengeAddresses;
  }

  async prepare(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    this.assertHarness(entrant);
    const key = this.key(run.id, entrant.id);
    if (this.states.has(key)) throw new Error(`Entrant ${entrant.id} is already prepared`);

    let container: EntrantContainer;
    try {
      container = await this.createContainer(run, entrant);
    } catch (error) {
      // createContainer issues the agent token before the factory can fail.
      revokeAgentToken(run.id, entrant.id);
      dropCurrentChallenge(run.id, entrant.id);
      throw error;
    }
    const state: EntrantRuntimeState = {
      run,
      entrant,
      container,
      queuedSteers: [],
      running: false,
      stopping: false,
      restarting: false,
      killRequested: false,
      degraded: false,
      sessionId: undefined,
      active: undefined,
      turnTask: undefined,
    };
    this.states.set(key, state);

    try {
      await this.preflight(container, ['forge', '--version'], 'forge');
      await this.preflight(container, ['cast', 'chain-id', '--rpc-url', this.rpcUrl], 'cast chain-id');
      await this.preflight(container, this.versionArgv(), this.harnessName());
      this.setStatus(run.id, entrant.id, 'idle');
    } catch (error) {
      this.states.delete(key);
      revokeAgentToken(run.id, entrant.id);
      dropCurrentChallenge(run.id, entrant.id);
      await container.teardown();
      throw error;
    }
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    this.assertHarness(entrant);
    const state = this.requireState(run.id, entrant.id);
    if (state.running) throw new Error(`Entrant ${entrant.id} already has a turn in flight`);
    await this.beginTurn(state, openingPrompt, false);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<SteerDelivery> {
    this.assertHarness(entrant);
    const state = this.requireState(run.id, entrant.id);
    if (state.stopping) throw new EntrantUnavailableError(`Entrant ${entrant.id} is stopping`);
    if (state.restarting) throw new EntrantUnavailableError(`Entrant ${entrant.id} is restarting`);
    // The caller records the miss on the lane, so this only reports it.
    if (state.degraded) {
      throw new EntrantUnavailableError(`Entrant ${entrant.id} is degraded`);
    }

    if (state.running) {
      state.queuedSteers.push(text);
      return 'queued';
    }
    await this.beginTurn(state, text, true);
    return 'injected';
  }

  // Recovery for one wedged lane. The harness session is thrown away — a
  // resume can only make a blocked or stale thread worse — and the opening
  // prompt starts a new one in the container the entrant already has, so its
  // wallet, credentials, and challenge pack survive the restart.
  //
  // When it fails it fails after the kill, so the old session is gone either
  // way and the lane lands on `blocked`: `entrant.restarted` is already on the
  // feed, no prompt follows it, and with no sessionId a steer cannot revive the
  // lane — only another restart can. `restarting` also clears before the
  // replacement turn is injected (holding it through the launch would deadlock
  // against finishTurn), so a steer racing that launch is answered `queued` and
  // then dropped if the launch never lands.
  async restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    this.assertHarness(entrant);
    const state = this.requireState(run.id, entrant.id);
    if (state.stopping) throw new EntrantUnavailableError(`Entrant ${entrant.id} is stopping`);
    if (state.restarting) throw new EntrantUnavailableError(`Entrant ${entrant.id} is already restarting`);

    // Claimed before the first await: finishTurn must not drain a queued steer
    // into the container while the restart is taking over its single writer.
    state.restarting = true;
    let killed = false;
    try {
      await this.settleTurn(state);
      // A stop that landed while the wedged turn unwound owns the container now.
      if (state.stopping) throw new EntrantUnavailableError(`Entrant ${entrant.id} is stopping`);
      killed = true;
      this.discardQueuedSteers(state, 'entrant restarted');
      // Both belong to the session being abandoned: the id a resume would
      // target, and the parser's half-read view of its stream.
      state.sessionId = undefined;
      this.parsers.delete(this.key(run.id, entrant.id));
      state.degraded = false;
      this.journal.append(run.id, entrant.id, 'entrant.restarted', { entrantId: entrant.id });
      // Released before the launch. Holding it through beginTurn would let a
      // turn that ends inside the launch reach finishTurn while the flag is
      // still up, and that turn's status and queue drain would go missing.
      state.restarting = false;
      await this.beginTurn(state, openingPrompt, false);
    } catch (error) {
      state.restarting = false;
      // The kill already happened, so there is no session to fall back on and
      // finishTurn cannot report it — a launch that never started never reaches
      // it. Without this the lane sits on the board as `working`, or as `idle`
      // after a launch failure, with nothing running behind either.
      if (killed && !state.stopping && !state.running) {
        state.degraded = true;
        this.setStatus(run.id, entrant.id, 'blocked');
      }
      throw error;
    }
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    this.assertHarness(entrant);
    const key = this.key(run.id, entrant.id);
    const state = this.states.get(key);
    if (state === undefined) return;

    state.stopping = true;
    this.discardQueuedSteers(state, 'entrant stopped');
    await this.settleTurn(state);
    try {
      await state.container.teardown();
    } finally {
      // A throwing teardown must not leave the token resolving for a dead
      // entrant that could still journal announcements into a finished run.
      revokeAgentToken(run.id, entrant.id);
      dropCurrentChallenge(run.id, entrant.id);
    }
    this.states.delete(key);
    this.parsers.delete(key);
    this.setStatus(run.id, entrant.id, 'done');
  }

  protected abstract harnessName(): string;
  protected abstract assertHarness(entrant: EntrantRecord): void;
  protected abstract createContainer(run: RunRecord, entrant: EntrantRecord): Promise<EntrantContainer>;
  protected abstract versionArgv(): string[];
  protected abstract startArgv(entrant: EntrantRecord, prompt: string): string[];
  protected abstract resumeArgv(entrant: EntrantRecord, sessionId: string, text: string): string[];
  protected abstract createParser(entrant: EntrantRecord): HarnessLineParser;

  protected watchdogMs(): number | undefined {
    return undefined;
  }

  protected validateResumeSession(): boolean {
    return false;
  }

  private async beginTurn(state: EntrantRuntimeState, text: string, resume: boolean): Promise<void> {
    if (state.running) throw new Error(`Entrant ${state.entrant.id} already has a turn in flight`);
    // Too early is not broken: the caller gets the rejection, and the entrant
    // steers normally once the opening turn reports a session.
    if (resume && state.sessionId === undefined) {
      throw new EntrantUnavailableError(
        `Entrant ${state.entrant.id} cannot take a turn before the harness reports a session ID`,
      );
    }

    state.running = true;
    this.setStatus(state.run.id, state.entrant.id, 'working');

    let resolveInjected!: () => void;
    let rejectInjected!: (error: Error) => void;
    const injected = new Promise<void>((resolve, reject) => {
      resolveInjected = resolve;
      rejectInjected = reject;
    });
    state.turnTask = this.runTurn(state, text, resume, resolveInjected, rejectInjected);
    await injected;
  }

  private async runTurn(
    state: EntrantRuntimeState,
    text: string,
    resume: boolean,
    resolveInjected: () => void,
    rejectInjected: (error: Error) => void,
  ): Promise<void> {
    const expectedSessionId = resume ? state.sessionId : undefined;
    const argv = resume
      ? this.resumeArgv(state.entrant, expectedSessionId as string, text)
      : this.startArgv(state.entrant, text);
    let sawTurnEnd = false;
    let sawSession = false;
    let watchdogFired = false;
    let launchFailed = false;
    let timer: NodeJS.Timeout | undefined;
    const stderrTail: string[] = [];

    try {
      const execution = await state.container.exec(argv, this.execEnvironment());
      state.active = execution;
      if (resume) {
        this.journal.append(state.run.id, state.entrant.id, 'entrant.steered', {
          entrantId: state.entrant.id,
          text,
        });
      } else {
        this.journal.append(state.run.id, state.entrant.id, 'entrant.prompt', {
          entrantId: state.entrant.id,
          text,
        });
      }
      resolveInjected();
      // A stop or restart that arrived while this turn was launching had nothing
      // to kill; it does now, and it is still waiting on this task.
      if (state.killRequested) {
        void execution.kill().catch((error: unknown) => {
          this.logger.warn(`[${this.harnessName()}] launch-race kill failed: ${errorMessage(error)}`);
        });
      }

      const timeoutMs = this.watchdogMs();
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          watchdogFired = true;
          this.appendError(state, `Turn exceeded the ${timeoutMs}ms watchdog; killed its process group`);
          void execution.kill().catch((error: unknown) => {
            this.logger.warn(`[${this.harnessName()}] watchdog kill failed: ${errorMessage(error)}`);
          });
        }, timeoutMs);
        timer.unref();
      }

      for await (const output of execution) {
        if (output.stream === 'err') {
          stderrTail.push(output.line);
          if (stderrTail.length > 8) stderrTail.shift();
          continue;
        }

        const parsed = this.parserFor(state).parse(output.line);
        for (const event of parsed.events) this.appendParsed(state, event);
        if (parsed.turnEnded === true) {
          sawTurnEnd = true;
          // Disarm the watchdog once the turn actually ends. A slow process close
          // after a real turn-end must not trip a false "exceeded watchdog" kill.
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        }
        if (parsed.sessionId !== undefined) {
          sawSession = true;
          if (expectedSessionId !== undefined && this.validateResumeSession() &&
              parsed.sessionId !== expectedSessionId) {
            this.markDegraded(
              state,
              `Resume returned thread ${parsed.sessionId}; expected ${expectedSessionId}`,
            );
            await execution.kill();
          } else if (state.sessionId === undefined) {
            state.sessionId = parsed.sessionId;
          }
        }
      }

      const code = await execution.exit;
      if (resume && this.validateResumeSession() && !sawSession && !state.degraded) {
        this.markDegraded(state, `Resume for thread ${expectedSessionId as string} returned no thread ID`);
      }
      if (!sawTurnEnd && !watchdogFired) {
        this.appendError(state, 'Harness exited before a turn-end event; synthesized turn end');
      }
      if (code !== 0 && !watchdogFired && !state.degraded) {
        const detail = stderrTail.length === 0 ? '' : `: ${stderrTail.join('\n')}`;
        this.appendError(state, `Harness exited with code ${String(code)}${detail}`);
      }
      // Container execs are single-writer, so housekeeping that needs the
      // container must run here — the turn still owns it, the next queued
      // steer has not started.
      await this.afterTurn(state.run, state.entrant, state.container);
    } catch (error) {
      launchFailed = state.active === undefined;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.appendError(state, `Harness turn failed: ${normalized.message}`);
      if (launchFailed) rejectInjected(normalized);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.active = undefined;
      if (!launchFailed) resolveInjected();
      this.finishTurn(state);
    }
  }

  // Turn-boundary hook: the harness may inspect its container between turns.
  // Must not throw — a housekeeping failure is not a turn failure.
  protected async afterTurn(
    _run: RunRecord,
    _entrant: EntrantRecord,
    _container: EntrantContainer,
  ): Promise<void> {}

  // The container takes one exec at a time, so anything that wants the next turn
  // first kills what is in flight and waits for it to unwind.
  private async settleTurn(state: EntrantRuntimeState): Promise<void> {
    // Claimed before the kill so a turn whose exec has not landed yet still gets
    // killed the moment it does. A container wedged inside exec() itself is
    // beyond this — that lane needs a new container, not a new session.
    state.killRequested = true;
    try {
      if (state.active !== undefined) {
        try {
          await state.active.kill();
        } catch {
          // The turn task settles either way; the caller decides what follows.
        }
      }
      await state.turnTask;
    } finally {
      state.killRequested = false;
    }
  }

  private finishTurn(state: EntrantRuntimeState): void {
    state.running = false;
    // A restart is already holding the lane and starts its own turn next.
    if (state.stopping || state.restarting) return;
    this.setStatus(state.run.id, state.entrant.id, state.degraded ? 'blocked' : 'idle');
    if (state.degraded) {
      this.dropQueuedSteers(state, 'entrant degraded');
      return;
    }

    const next = state.queuedSteers.shift();
    if (next !== undefined) {
      void this.beginTurn(state, next, true).catch((error: unknown) => {
        const message = errorMessage(error);
        this.logger.warn(`[${this.harnessName()}] queued steer failed: ${message}`);
        this.appendError(state, `Queued steer dropped (${message}): ${next}`);
        if (!state.running && !state.stopping) this.dropQueuedSteers(state, message);
      });
    }
  }

  // Teardown and restart both drop what is queued as housekeeping, so a journal
  // failure here must not abort the work that follows.
  private discardQueuedSteers(state: EntrantRuntimeState, reason: string): void {
    try {
      this.dropQueuedSteers(state, reason);
    } catch (error) {
      this.logger.warn(`[${this.harnessName()}] failed to journal dropped steers: ${errorMessage(error)}`);
    }
  }

  private dropQueuedSteers(state: EntrantRuntimeState, reason: string): void {
    // Drain before journaling: a mid-loop append failure must not leave
    // already-journaled texts queued for a second drop.
    for (const dropped of state.queuedSteers.splice(0)) {
      this.appendError(state, `Queued steer dropped (${reason}): ${dropped}`);
    }
  }

  private async preflight(container: EntrantContainer, argv: string[], name: string): Promise<void> {
    const execution = await container.exec(argv);
    const output: string[] = [];
    for await (const line of execution) output.push(line.line);
    const code = await execution.exit;
    if (code !== 0) {
      throw new Error(`${name} preflight failed with code ${String(code)}: ${output.join('\n')}`);
    }
  }

  private appendParsed(state: EntrantRuntimeState, event: ParsedArenaEvent): void {
    const runId = state.run.id;
    const entrantId = state.entrant.id;
    switch (event.type) {
      case 'agent.message': this.journal.append(runId, entrantId, event.type, event.payload); break;
      case 'agent.reasoning': this.journal.append(runId, entrantId, event.type, event.payload); break;
      case 'tool.call':
        this.journal.append(runId, entrantId, event.type, event.payload);
        this.trackProgress(state, event.payload.detail);
        break;
      case 'tool.result': this.journal.append(runId, entrantId, event.type, event.payload); break;
      case 'entrant.error': this.journal.append(runId, entrantId, event.type, event.payload); break;
      // A harness that prices its own turns wins; otherwise the rate table fills in.
      case 'usage': this.journal.append(runId, entrantId, event.type, {
        ...event.payload,
        costUsd: event.payload.costUsd ?? costForTokens(
          state.entrant.model,
          event.payload.inputTokens,
          event.payload.outputTokens,
          event.payload.cachedInputTokens,
        ),
      }); break;
      default: this.logger.warn(`[${this.harnessName()}] parser returned unsupported event ${event.type}`);
    }
  }

  // The heuristic behind entrant.challenge: a command that references exactly one
  // challenge moves the entrant's current-challenge guess (see contract notes).
  private trackProgress(state: EntrantRuntimeState, detail: string): void {
    state.addressIndex ??= challengeAddressIndex(this.challengeAddresses?.(state.run.id) ?? {});
    const guess = matchChallenge(detail, state.addressIndex);
    if (guess === undefined) return;
    const runId = state.run.id;
    const entrantId = state.entrant.id;
    // Deduped against the shared current, not a tracker-private last, so an
    // announcement moving the value lets the next command move it back.
    if (currentChallenge(runId, entrantId) === guess.challengeId) return;
    this.journal.append(runId, entrantId, 'entrant.challenge', {
      entrantId,
      challengeId: guess.challengeId,
      via: 'command',
      evidence: guess.evidence,
    });
    recordCurrentChallenge(runId, entrantId, guess.challengeId);
  }

  private appendError(state: EntrantRuntimeState, message: string): void {
    this.journal.append(state.run.id, state.entrant.id, 'entrant.error', {
      entrantId: state.entrant.id,
      message,
    });
  }

  private markDegraded(state: EntrantRuntimeState, message: string): void {
    if (state.degraded) return;
    state.degraded = true;
    this.appendError(state, message);
  }

  private setStatus(runId: string, entrantId: string, status: EntrantStatus): void {
    this.journal.database
      .update(entrants)
      .set({ status })
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
      .run();
    this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status });
  }

  private parserFor(state: EntrantRuntimeState): HarnessLineParser {
    const key = this.key(state.run.id, state.entrant.id);
    let parser = this.parsers.get(key);
    if (parser === undefined) {
      parser = this.createParser(state.entrant);
      this.parsers.set(key, parser);
    }
    return parser;
  }

  private requireState(runId: string, entrantId: string): EntrantRuntimeState {
    const state = this.states.get(this.key(runId, entrantId));
    if (state === undefined) throw new Error(`Entrant ${entrantId} is not prepared`);
    return state;
  }

  private key(runId: string, entrantId: string): string {
    return `${runId}:${entrantId}`;
  }

  private execEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    delete environment.OPENCODE_SERVER_PASSWORD;
    delete environment.OPENCODE_PORT;
    return environment;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
