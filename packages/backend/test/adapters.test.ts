import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeDriver } from '../src/adapters/claude.js';
import { CodexDriver } from '../src/adapters/codex.js';
import {
  credentialSecrets,
  dropCredentialSecrets,
} from '../src/adapters/credential-secrets.js';
import { DockerEntrantDriver } from '../src/adapters/docker.js';
import { recordCurrentChallenge } from '../src/ctf/challenge-tracker.js';
import {
  formatWatchdogDuration,
  type HarnessDriverOptions,
} from '../src/adapters/harness-driver.js';
import { FakeDriver } from '../src/adapters/fake.js';
import { OpenCodeDriver, scrubOpenCodeEnvironment } from '../src/adapters/opencode.js';
import { RegisteredEntrantDriver } from '../src/adapters/registered.js';
import {
  EntrantUnavailableError,
  type EntrantDriver,
  type EntrantRecord,
  type RunRecord,
} from '../src/adapters/types.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import { deriveEntrantKeys, getWallet, seedTypedData } from '../src/chain/wallet.js';
import { entrants, events as eventRows, runs } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';
import { RunManager } from '../src/run-manager.js';
import type {
  ContainerFactory,
  ContainerOptions,
  EntrantContainer,
  RuntimeExecution,
  RuntimeLine,
} from '../src/runtime/container.js';

const temporaryPaths: string[] = [];
type TestHarness = 'claude' | 'codex' | 'opencode';
const testCredentials = {
  claude: 'test-oauth-token-claude-12345',
  codex: 'test-codex-access-token-12345',
  codexRefresh: 'test-codex-refresh-token-67890',
  opencode: 'test-openrouter-key-12345',
} as const;
const testCodexAuth = JSON.stringify({
  auth: {
    access: testCredentials.codex,
    account: 'codex-user@example-account.com',
    issuer: 'https://auth.openai.example/realms/codex',
    nested: { refresh: testCredentials.codexRefresh },
  },
  short: 'ignored',
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ControlledExecution implements RuntimeExecution {
  readonly exit: Promise<number | null>;
  readonly killCalls: string[] = [];
  killFailure: Error | undefined;
  private readonly values: RuntimeLine[] = [];
  private readonly waiters: Array<(result: IteratorResult<RuntimeLine>) => void> = [];
  private resolveExit!: (code: number | null) => void;
  private done = false;

  constructor(
    readonly id: string,
    private readonly onFinish: () => void,
  ) {
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  push(line: string, stream: 'out' | 'err' = 'out'): void {
    const value = { line, stream };
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  finish(code: number | null): void {
    if (this.done) return;
    this.done = true;
    this.resolveExit(code);
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
    this.onFinish();
  }

  async kill(): Promise<void> {
    this.killCalls.push('kill');
    if (this.killFailure !== undefined) throw this.killFailure;
    this.finish(null);
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeLine> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.done) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class ControlledContainer implements EntrantContainer {
  readonly calls: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  readonly turns: ControlledExecution[] = [];
  readonly authReads: ControlledExecution[] = [];
  authFileContent: string | undefined;
  tornDown = false;
  failNextLaunch = false;
  hangAuthRead = false;
  private active: ControlledExecution | undefined;
  private launchGate: Promise<void> | undefined;

  // Freezes the next exec inside its launch, where the driver has a turn in
  // flight but no execution to kill yet. Returns the release.
  holdNextLaunch(): () => void {
    let release!: () => void;
    this.launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution> {
    if (this.active !== undefined) throw new Error('single-writer violation');
    const gate = this.launchGate;
    if (gate !== undefined) {
      this.launchGate = undefined;
      await gate;
    }
    if (this.failNextLaunch) {
      this.failNextLaunch = false;
      throw new Error('container is gone');
    }
    this.calls.push(env === undefined ? { argv } : { argv, env });
    const execution = new ControlledExecution(`exec-${this.calls.length}`, () => {
      if (this.active === execution) this.active = undefined;
    });
    this.active = execution;

    const isTurn = argv[0] === 'codex' && argv[1] === 'exec'
      || argv[0] === 'opencode' && argv[1] === 'run'
      || argv[0] === 'claude' && argv[1] === '-p';
    if (isTurn) {
      this.turns.push(execution);
    } else if (argv[0] === 'cat' && argv[1] === '/creds/codex/auth.json') {
      // The auth sync-back reads the container's file this way on teardown.
      this.authReads.push(execution);
      if (this.hangAuthRead) {
        // Leave the execution open until the test releases or tears it down.
      } else if (this.authFileContent === undefined) {
        execution.finish(1);
      } else {
        for (const line of this.authFileContent.split('\n')) execution.push(line);
        execution.finish(0);
      }
    } else {
      execution.push(`${argv[0] ?? 'command'} ok`);
      execution.finish(0);
    }
    return execution;
  }

  async teardown(): Promise<void> {
    this.tornDown = true;
    await this.active?.kill();
  }
}

class TimerProbeDriver extends OpenCodeDriver {
  timerValues(run: RunRecord): { watchdogMs: number | undefined; turnCapMs: number | undefined } {
    return {
      watchdogMs: this.watchdogMs(),
      turnCapMs: this.turnCapMs(run),
    };
  }
}

async function setup(
  harness: TestHarness,
  watchdogMs = 10 * 60 * 1_000,
  withWallet = false,
  model?: string,
  effort?: EntrantRecord['effort'],
  challengeAddresses?: HarnessDriverOptions['challengeAddresses'],
  timerOptions: Pick<HarnessDriverOptions, 'turnMaxMs' | 'logger'> = {},
): Promise<{
  journal: EventJournal;
  driver: EntrantDriver;
  run: RunRecord;
  entrant: EntrantRecord;
  container: ControlledContainer;
  containerOptions: ContainerOptions;
  authPath?: string;
}> {
  const journal = new EventJournal(':memory:');
  const seedDriver: EntrantDriver = {
    async prepare() {}, async start() {}, async steer() { return 'injected'; },
    async restart() {}, async stop() {},
  };
  const manager = new RunManager(journal, seedDriver);
  const created = await manager.create({ preset: harness === 'claude' ? 'docker-arena' : 'docker-duel' });
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  let entrant = journal.database.select().from(entrants).where(and(
    eq(entrants.runId, created.run.id),
    eq(entrants.harness, harness),
  )).get();
  if (run === undefined || entrant === undefined) throw new Error('Test run was not seeded');
  // Cost pricing keys off the entrant's model, so a test can swap in a model the
  // rate table lists (or one it does not).
  if (model !== undefined) entrant = { ...entrant, model };
  if (effort !== undefined) entrant = { ...entrant, effort };
  if (withWallet) {
    const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
    const signature = await account.signTypedData(seedTypedData(run.id, 31337));
    deriveEntrantKeys(run.id, signature, [entrant.id]);
  }

  const container = new ControlledContainer();
  let containerOptions: ContainerOptions | undefined;
  const containerFactory: ContainerFactory = async (options: ContainerOptions) => {
    containerOptions = options;
    return container;
  };
  let driver: EntrantDriver;
  const addressOptions = challengeAddresses === undefined ? {} : { challengeAddresses };
  let authPath: string | undefined;
  if (harness === 'codex') {
    const authDirectory = await mkdtemp(join(tmpdir(), 'arena-test-auth-'));
    temporaryPaths.push(authDirectory);
    authPath = join(authDirectory, 'auth.json');
    await writeFile(authPath, testCodexAuth);
    driver = new CodexDriver(journal, {
      authPath,
      containerFactory,
      turnWatchdogMs: watchdogMs,
      ...addressOptions,
      ...timerOptions,
    });
  } else if (harness === 'opencode') {
    driver = new OpenCodeDriver(journal, {
      apiKey: testCredentials.opencode,
      containerFactory,
      turnWatchdogMs: watchdogMs,
      ...addressOptions,
      ...timerOptions,
    });
  } else {
    driver = new ClaudeDriver(journal, {
      oauthToken: testCredentials.claude,
      containerFactory,
      turnWatchdogMs: watchdogMs,
      ...addressOptions,
      ...timerOptions,
    });
  }
  await driver.prepare(run, entrant);
  if (containerOptions === undefined) {
    throw new Error('Container factory was not called');
  }
  return {
    journal, driver, run, entrant, container, containerOptions,
    ...(authPath === undefined ? {} : { authPath }),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not met');
}

// Opens a session and says something on it, so a test can wait for the message
// and know the session line ahead of it has already been parsed.
function openSession(harness: TestHarness, execution: ControlledExecution, sessionId: string): void {
  if (harness === 'codex') {
    execution.push(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
    execution.push(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'working' },
    }));
  } else if (harness === 'opencode') {
    execution.push(JSON.stringify({ type: 'step_start', sessionID: sessionId, part: {} }));
    execution.push(JSON.stringify({
      type: 'text',
      sessionID: sessionId,
      part: { text: 'working' },
    }));
  } else {
    execution.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
    execution.push(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working' }] },
    }));
  }
}

function completeTurn(harness: TestHarness, execution: ControlledExecution, sessionId: string): void {
  if (harness === 'codex') {
    execution.push(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
    execution.push(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
  } else if (harness === 'opencode') {
    execution.push(JSON.stringify({ type: 'step_start', sessionID: sessionId, part: {} }));
    execution.push(JSON.stringify({
      type: 'step_finish',
      sessionID: sessionId,
      part: { reason: 'stop', tokens: { input: 10, output: 2 } },
    }));
  } else {
    execution.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
    execution.push(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
  }
  execution.finish(0);
}

describe.each(['codex', 'opencode', 'claude'] as const)('%s steer rejection', (harness) => {
  it('rejects a steer sent before the opening turn without degrading the entrant', async () => {
    const context = await setup(harness);
    const sessionId = harness === 'codex' ? 'thread-1' : `${harness}-session-1`;
    try {
      const rejection = context.driver.steer(context.run, context.entrant, 'too early');
      await expect(rejection)
        .rejects.toThrow(
          `Entrant ${context.entrant.id} cannot take a turn before the harness reports a session ID; ` +
          'restart the lane to resend the opening prompt',
        );
      await expect(rejection)
        .rejects.toBeInstanceOf(EntrantUnavailableError);
      expect(context.container.turns).toHaveLength(0);
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.error')).toHaveLength(0);
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status').at(-1)?.payload.status).toBe('idle');

      // The rejection must not claim the lane or degrade it.
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn(harness, context.container.turns[0] as ControlledExecution, sessionId);
      await context.driver.steer(context.run, context.entrant, 'after start');
      await waitFor(() => context.container.turns.length === 2);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe.each(['codex', 'opencode', 'claude'] as const)('%s steer queue', (harness) => {
  it('queues during a turn and injects at once while idle', async () => {
    const context = await setup(harness);
    const sessionId = harness === 'codex' ? 'thread-1' : `${harness}-session-1`;
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      expect(context.container.turns).toHaveLength(1);

      await expect(context.driver.steer(context.run, context.entrant, 'queued steer'))
        .resolves.toBe('queued');
      expect(context.container.turns).toHaveLength(1);

      completeTurn(harness, context.container.turns[0] as ControlledExecution, sessionId);
      await waitFor(() => context.container.turns.length === 2);
      expect(context.journal.after(context.run.id, 0).filter((event) =>
        event.type === 'entrant.steered')).toHaveLength(1);

      completeTurn(harness, context.container.turns[1] as ControlledExecution, sessionId);
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      await expect(context.driver.steer(context.run, context.entrant, 'idle steer'))
        .resolves.toBe('injected');
      expect(context.container.turns).toHaveLength(3);
      const steers = context.journal.after(context.run.id, 0).filter((event) =>
        event.type === 'entrant.steered');
      expect(steers.map((event) => event.payload.text)).toEqual(['queued steer', 'idle steer']);
      completeTurn(harness, context.container.turns[2] as ControlledExecution, sessionId);
      await waitFor(() => context.container.calls.length >= 6);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

// The route answered 'queued' for these steers, so a silent drop would leave a
// consumer reconciling against entrant.steered waiting forever.
describe('queued steer drain', () => {
  it('drops a queued steer when the opening turn ends without a session ID', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      await expect(context.driver.steer(context.run, context.entrant, 'ghost steer'))
        .resolves.toBe('queued');

      // The opening turn ends without ever reporting a thread, so the drained
      // steer has no session to resume into.
      const opening = context.container.turns[0] as ControlledExecution;
      opening.push(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
      opening.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' && event.payload.message.includes('Queued steer dropped')));
      expect(context.container.turns).toHaveLength(1);
      expect(context.journal.after(context.run.id, 0).filter((event) =>
        event.type === 'entrant.steered')).toHaveLength(0);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message.includes('restart the lane to resend the opening prompt') &&
        event.payload.message.includes('ghost steer'))).toBe(true);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('journals queued steers spliced away when the entrant degrades', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      await expect(context.driver.steer(context.run, context.entrant, 'first steer'))
        .resolves.toBe('injected');
      await expect(context.driver.steer(context.run, context.entrant, 'second steer'))
        .resolves.toBe('queued');

      // The first steer's resume comes back on the wrong thread, degrading the
      // entrant; the still-queued second steer gets dropped at turn end.
      completeTurn('codex', context.container.turns[1] as ControlledExecution, 'thread-999');

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error'
          && event.payload.message.includes('degraded')
          && event.payload.message.includes('second steer')));
      const steers = context.journal.after(context.run.id, 0).filter((event) =>
        event.type === 'entrant.steered');
      expect(steers.map((event) => event.payload.text)).toEqual(['first steer']);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('journals queued steers discarded when the entrant stops', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      await expect(context.driver.steer(context.run, context.entrant, 'first stopped steer'))
        .resolves.toBe('queued');
      await expect(context.driver.steer(context.run, context.entrant, 'second stopped steer'))
        .resolves.toBe('queued');

      await context.driver.stop(context.run, context.entrant);

      const errors = context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.error')
        .filter((event) => event.payload.message.includes('Queued steer dropped'));
      expect(errors.map((event) => event.payload.message)).toEqual([
        'Queued steer dropped (entrant stopped): first stopped steer',
        'Queued steer dropped (entrant stopped): second stopped steer',
      ]);
      expect(context.journal.after(context.run.id, 0).filter((event) =>
        event.type === 'entrant.steered')).toHaveLength(0);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

// The lane recovery path (#49): the operator's last resort when a session goes
// stale mid-race, and the rest of the field must not notice.
describe.each(['codex', 'opencode', 'claude'] as const)('%s restart', (harness) => {
  it('kills the wedged turn and opens a fresh session on the opening prompt', async () => {
    const context = await setup(harness);
    const sessionId = harness === 'codex' ? 'thread-1' : `${harness}-session-1`;
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const wedged = context.container.turns[0] as ControlledExecution;
      // A session exists but the turn never ends — the stale lane the operator sees.
      openSession(harness, wedged, sessionId);
      await waitFor(() => context.journal.after(context.run.id, 0)
        .some((event) => event.type === 'agent.message'));
      await expect(context.driver.steer(context.run, context.entrant, 'never delivered'))
        .resolves.toBe('queued');

      await context.driver.restart(context.run, context.entrant, 'opening again');

      expect(wedged.killCalls).toEqual(['kill']);
      expect(context.container.turns).toHaveLength(2);
      // A fresh session, not a resume: the restart argv carries no session id.
      const restarted = context.container.calls.at(-1)?.argv ?? [];
      expect(restarted).toContain('opening again');
      expect(restarted).not.toContain(sessionId);

      const events = context.journal.after(context.run.id, 0);
      expect(events.some((event) => event.type === 'entrant.restarted'
        && event.payload.entrantId === context.entrant.id)).toBe(true);
      // The queued steer was answered 'queued', so its drop is on the record.
      expect(events.some((event) => event.type === 'entrant.error'
        && event.payload.message === 'Queued steer dropped (entrant restarted): never delivered')).toBe(true);
      expect(events.filter((event) => event.type === 'entrant.prompt')
        .map((event) => event.payload.text)).toEqual(['opening', 'opening again']);
      expect(events.filter((event) => event.type === 'entrant.status')
        .at(-1)?.payload.status).toBe('working');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe('codex restart', () => {
  it('un-blocks a degraded entrant and steers into the new session', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      // A resume that comes back on the wrong thread degrades the lane; from
      // here every steer is refused, which is the state #49 was raised for.
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });
      await expect(context.driver.steer(context.run, context.entrant, 'first steer'))
        .resolves.toBe('injected');
      completeTurn('codex', context.container.turns[1] as ControlledExecution, 'thread-999');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'blocked';
      });
      await expect(context.driver.steer(context.run, context.entrant, 'refused'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);

      await context.driver.restart(context.run, context.entrant, 'opening again');
      completeTurn('codex', context.container.turns[2] as ControlledExecution, 'thread-2');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      // The lane takes turns again, and the resume targets the new thread.
      await expect(context.driver.steer(context.run, context.entrant, 'after restart'))
        .resolves.toBe('injected');
      expect(context.container.calls.at(-1)?.argv).toContain('thread-2');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  // The window the kill used to miss: state.active is only set once exec()
  // resolves, so a restart landing mid-launch had nothing to kill and then sat
  // on turnTask waiting out the very turn it came to end.
  it('kills a turn that was still launching when the restart landed', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      const release = context.container.holdNextLaunch();
      // Never resolves on its own: its turn is frozen inside the launch.
      const steering = context.driver.steer(context.run, context.entrant, 'lands mid-launch');
      void steering.catch(() => {});
      const restarting = context.driver.restart(context.run, context.entrant, 'opening again');
      release();

      await restarting;
      await steering;
      // The frozen turn was killed the moment it had an execution, and the
      // restart went on to open its own.
      expect((context.container.turns[1] as ControlledExecution).killCalls).toEqual(['kill']);
      expect(context.container.turns).toHaveLength(3);
      expect(context.container.calls.at(-1)?.argv).toContain('opening again');
      expect(context.container.calls.at(-1)?.argv).not.toContain('thread-1');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  // The kill already happened, so there is no session to fall back on: the lane
  // must not be left claiming it is working.
  it('marks the lane blocked when the replacement turn cannot launch', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      context.container.failNextLaunch = true;
      await expect(context.driver.restart(context.run, context.entrant, 'opening again'))
        .rejects.toThrow('container is gone');

      const events = context.journal.after(context.run.id, 0);
      expect(events.filter((event) => event.type === 'entrant.status')
        .map((event) => event.payload.status).at(-1)).toBe('blocked');
      // The restart is on the record with no prompt behind it, and the lane
      // only comes back through another restart.
      expect(events.filter((event) => event.type === 'entrant.restarted')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'entrant.prompt')
        .map((event) => event.payload.text)).toEqual(['opening']);
      await expect(context.driver.steer(context.run, context.entrant, 'cannot revive'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('refuses a restart while the entrant is stopping', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const stopping = context.driver.stop(context.run, context.entrant);
      await expect(context.driver.restart(context.run, context.entrant, 'too late'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);
      await stopping;
      expect(context.container.turns).toHaveLength(1);
    } finally {
      context.journal.close();
    }
  });
});

describe('parser isolation', () => {
  // One CodexDriver serves every run in the process and entrant ids are preset
  // literals, so a parser cache keyed by entrant alone would let two runs in
  // flight interleave their sessions and reset each other's token baseline.
  it('gives each run its own parser so a second run cannot reset the baseline', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, {
      async prepare() {}, async start() {}, async steer() { return 'injected'; },
      async restart() {}, async stop() {},
    });
    const authDirectory = await mkdtemp(join(tmpdir(), 'arena-test-auth-'));
    temporaryPaths.push(authDirectory);
    const authPath = join(authDirectory, 'auth.json');
    await writeFile(authPath, testCodexAuth);

    const containers: ControlledContainer[] = [];
    const containerFactory: ContainerFactory = async () => {
      const container = new ControlledContainer();
      containers.push(container);
      return container;
    };
    const driver = new CodexDriver(journal, { authPath, containerFactory });

    const seed = async () => {
      const created = await manager.create({ preset: 'docker-duel' });
      const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
      const entrant = journal.database.select().from(entrants).where(and(
        eq(entrants.runId, created.run.id),
        eq(entrants.harness, 'codex'),
      )).get();
      if (run === undefined || entrant === undefined) throw new Error('Test run was not seeded');
      return { run, entrant };
    };
    const first = await seed();
    const second = await seed();
    expect(first.entrant.id).toBe(second.entrant.id);

    const usageOf = (runId: string) => journal.after(runId, 0)
      .filter((event) => event.type === 'usage')
      .map((event) => event.payload);
    const completeCumulative = (
      container: ControlledContainer,
      index: number,
      threadId: string,
      totals: { input: number; output: number },
    ) => {
      const execution = container.turns[index] as ControlledExecution;
      execution.push(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
      execution.push(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: totals.input, output_tokens: totals.output },
      }));
      execution.finish(0);
    };

    try {
      await driver.prepare(first.run, first.entrant);
      await driver.prepare(second.run, second.entrant);
      await driver.start(first.run, first.entrant, 'opening');
      await driver.start(second.run, second.entrant, 'opening');

      const [firstContainer, secondContainer] = containers as [ControlledContainer, ControlledContainer];
      completeCumulative(firstContainer, 0, 'thread-a', { input: 10_000, output: 40 });
      await waitFor(() => usageOf(first.run.id).length === 1);
      // The other run reports a different session between the two turns below.
      completeCumulative(secondContainer, 0, 'thread-b', { input: 5_000, output: 20 });
      await waitFor(() => usageOf(second.run.id).length === 1);

      await waitFor(() => journal.after(first.run.id, 0).some((event) =>
        event.type === 'entrant.status' && event.payload.status === 'idle'));
      await driver.steer(first.run, first.entrant, 'again');
      completeCumulative(firstContainer, 1, 'thread-a', { input: 18_000, output: 70 });
      await waitFor(() => usageOf(first.run.id).length === 2);

      // 18,000 - 10,000, not the whole 18,000 a baseline reset would report.
      expect(usageOf(first.run.id)).toMatchObject([
        { inputTokens: 10_000, outputTokens: 40 },
        { inputTokens: 8_000, outputTokens: 30 },
      ]);
      expect(usageOf(second.run.id)).toMatchObject([{ inputTokens: 5_000, outputTokens: 20 }]);
    } finally {
      await driver.stop(first.run, first.entrant);
      await driver.stop(second.run, second.entrant);
      journal.close();
    }
  });
});

describe('usage cost', () => {
  it('prices a codex turn from the rate table, cached prompt tokens included', async () => {
    const context = await setup('codex', undefined, false, 'gpt-5-codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      turn.push(JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 10_000 },
      }));
      turn.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) => event.type === 'usage'));
      const usage = context.journal.after(context.run.id, 0).find((event) => event.type === 'usage');
      // 20k fresh at $1.25/M + 80k cached at $0.125/M + 10k out at $10/M. Pricing
      // all 100k input as fresh would read $0.225, nearly double.
      expect(usage?.payload).toEqual({
        entrantId: context.entrant.id,
        inputTokens: 100_000,
        outputTokens: 10_000,
        cachedInputTokens: 80_000,
        costUsd: 0.135,
      });
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('leaves cost unknown for a codex model the rate table does not list', async () => {
    const context = await setup('codex', undefined, false, 'gpt-6-codex-preview');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) => event.type === 'usage'));
      const usage = context.journal.after(context.run.id, 0).find((event) => event.type === 'usage');
      expect(usage?.payload).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: null });
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('keeps the cost opencode reports for its own step', async () => {
    const context = await setup('opencode');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'step_start', sessionID: 'session-1', part: {} }));
      turn.push(JSON.stringify({
        type: 'step_finish',
        sessionID: 'session-1',
        part: { reason: 'stop', tokens: { input: 109, output: 3 }, cost: 0.0042 },
      }));
      turn.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) => event.type === 'usage'));
      const usage = context.journal.after(context.run.id, 0).find((event) => event.type === 'usage');
      expect(usage?.payload).toMatchObject({ inputTokens: 109, outputTokens: 3, costUsd: 0.0042 });
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe('current challenge heuristic', () => {
  const challenge5 = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  function commandLine(id: string, command: string): string {
    return JSON.stringify({
      type: 'item.started',
      item: { id, type: 'command_execution', command },
    });
  }

  it('journals a progress guess per challenge the commands touch', async () => {
    const context = await setup('codex', undefined, false, undefined, undefined, () => ({
      Challenge5: challenge5,
    }));
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      turn.push(commandLine('item_1', 'cat /challenges/BRIEFING.md'));
      turn.push(commandLine('item_2', 'cat /challenges/contracts/Challenge3.sol'));
      // The same challenge again: the guess holds, no new event.
      turn.push(commandLine('item_3', 'cat /challenges/contracts/Challenge3.sol'));
      turn.push(commandLine('item_4', `cast call ${challenge5} "locked()"`));
      turn.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.challenge').length === 2);
      const guesses = context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.challenge')
        .map((event) => event.payload);
      expect(guesses).toEqual([
        { entrantId: context.entrant.id, challengeId: 3, via: 'command', evidence: 'Challenge3' },
        { entrantId: context.entrant.id, challengeId: 5, via: 'command', evidence: challenge5 },
      ]);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('lets a command move the value back after an announcement moved it away', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      turn.push(commandLine('item_1', 'cat /challenges/contracts/Challenge3.sol'));
      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.challenge').length === 1);

      // The agent announces 6 through the route; the shared current moves along.
      recordCurrentChallenge(context.run.id, context.entrant.id, 6);

      // The same challenge as before — a tracker-private last would still be 3
      // and stay silent, leaving the snapshot stuck on the announcement.
      turn.push(commandLine('item_2', 'cat /challenges/contracts/Challenge3.sol'));
      turn.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.challenge').length === 2);
      const latest = context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.challenge')
        .at(-1);
      expect(latest?.payload).toMatchObject({ challengeId: 3, via: 'command' });
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('guesses by name alone when the profile has no pack addresses', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
      turn.push(commandLine('item_1', 'forge script solve-challenge7.s.sol'));
      turn.finish(0);

      await waitFor(() => context.journal.after(context.run.id, 0)
        .some((event) => event.type === 'entrant.challenge'));
      const guess = context.journal.after(context.run.id, 0)
        .find((event) => event.type === 'entrant.challenge');
      expect(guess?.payload).toMatchObject({ challengeId: 7 });
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe('codex auth rotation', () => {
  // Codex rotates its refresh token inside the container; losing the rotated
  // auth.json with the container leaves the host copy consumed and the next
  // run dies with refresh_token_reused.
  it('syncs a rotated auth.json back to the host on stop', async () => {
    const context = await setup('codex');
    // A real rotation rewrites tokens in place; the file keeps its other keys.
    const rotated = JSON.stringify({ auth: { access: 'rotated-access-token-98765' }, short: 'ignored' });
    try {
      context.container.authFileContent = rotated;
      await context.driver.stop(context.run, context.entrant);
      await expect(readFile(context.authPath as string, 'utf8')).resolves.toBe(rotated);
    } finally {
      context.journal.close();
    }
  });

  it('keeps the host auth.json when the operator re-logged-in mid-run', async () => {
    const context = await setup('codex');
    const relogged = JSON.stringify({ auth: { access: 'relogged-access-token-13579' } });
    try {
      context.container.authFileContent = JSON.stringify({ auth: { access: 'rotated-access-token-98765' } });
      await writeFile(context.authPath as string, relogged);
      await context.driver.stop(context.run, context.entrant);
      await expect(readFile(context.authPath as string, 'utf8')).resolves.toBe(relogged);
    } finally {
      context.journal.close();
    }
  });

  it('does not touch the host when the container never rotated', async () => {
    const context = await setup('codex');
    try {
      context.container.authFileContent = testCodexAuth;
      await context.driver.stop(context.run, context.entrant);
      await expect(readFile(context.authPath as string, 'utf8')).resolves.toBe(testCodexAuth);
    } finally {
      context.journal.close();
    }
  });

  it('scrubs the rotated token, not just the seeded one', async () => {
    const context = await setup('codex');
    const rotatedAccess = 'rotated-codex-access-token-abcdef';
    const rotatedRefresh = 'rotated-codex-refresh-token-abcdef';
    try {
      // Seeded credentials are scrubbed at prepare; the rotated ones only once
      // the teardown read pulls them out of the container.
      expect(credentialSecrets(context.run.id)).not.toContain(rotatedRefresh);
      context.container.authFileContent = JSON.stringify({
        auth: { access: rotatedAccess, nested: { refresh: rotatedRefresh } },
      });
      await context.driver.stop(context.run, context.entrant);
      expect(credentialSecrets(context.run.id)).toEqual(
        expect.arrayContaining([rotatedAccess, rotatedRefresh]),
      );
    } finally {
      dropCredentialSecrets(context.run.id);
      context.journal.close();
    }
  });

  // The container copy is agent-writable; a rotation keeps the seeded shape,
  // junk does not, and junk must never replace the operator's login.
  it('refuses to overwrite the host login with agent-written junk', async () => {
    const context = await setup('codex');
    try {
      context.container.authFileContent = '{}';
      await context.driver.stop(context.run, context.entrant);
      await expect(readFile(context.authPath as string, 'utf8')).resolves.toBe(testCodexAuth);
    } finally {
      context.journal.close();
    }
  });

  it('learns rotated secrets at the turn boundary and scrubs rows already stored', async () => {
    const context = await setup('codex');
    const rotatedAccess = 'turn-rotated-access-token-abcdef';
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      // The agent echoes the rotated token mid-turn, before anything registered it.
      context.journal.append(context.run.id, context.entrant.id, 'entrant.error', {
        entrantId: context.entrant.id,
        message: `saw ${rotatedAccess} in auth.json`,
      });
      context.container.authFileContent = JSON.stringify({ auth: { access: rotatedAccess } });
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => credentialSecrets(context.run.id).includes(rotatedAccess));

      const stored = context.journal.after(context.run.id, 0)
        .find((event) => event.type === 'entrant.error');
      expect(JSON.stringify(stored?.payload)).not.toContain(rotatedAccess);
      expect(JSON.stringify(stored?.payload)).toContain('[redacted-key]');
    } finally {
      dropCredentialSecrets(context.run.id);
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('times out a wedged turn-boundary auth read without failing the turn', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const context = await setup(
      'codex',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      { logger: { info() {}, warn: (message) => warnings.push(message) } },
    );
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      context.container.hangAuthRead = true;
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      expect(context.container.calls.some((call) => call.argv[0] === 'cat')).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(context.container.authReads[0]?.killCalls).toEqual(['kill']);
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status').at(-1)?.payload.status).toBe('idle');
      expect(warnings).toContain(
        '[codex] rotated-auth read timed out after 30s; killed it and skipped rotation for this turn',
      );

      context.container.hangAuthRead = false;
      await expect(context.driver.steer(context.run, context.entrant, 'after auth timeout'))
        .resolves.toBe('injected');
      expect(context.container.turns).toHaveLength(2);
      completeTurn('codex', context.container.turns[1] as ControlledExecution, 'thread-1');
    } finally {
      context.container.hangAuthRead = false;
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe('adapter guardrails', () => {
  it('writes Codex model reasoning effort to config.toml when set', async () => {
    const context = await setup('codex', undefined, false, undefined, 'high');
    try {
      expect(context.containerOptions.credentialFiles).toEqual([
        {
          path: '/creds/codex/auth.json',
          content: testCodexAuth,
          mode: 0o600,
        },
        {
          path: '/creds/codex/config.toml',
          content: 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n',
          mode: 0o644,
        },
      ]);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('omits Codex model reasoning effort from config.toml when unset', async () => {
    const context = await setup('codex');
    try {
      const config = context.containerOptions.credentialFiles?.find(
        (file) => file.path === '/creds/codex/config.toml',
      )?.content;
      expect(config).toContain('model = "gpt-5.5"\n');
      expect(config).not.toContain('model_reasoning_effort');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('writes OpenCode reasoning effort to the project config when set', async () => {
    const context = await setup(
      'opencode',
      undefined,
      false,
      'openrouter/z-ai/glm-5.2',
      'high',
    );
    try {
      expect(context.containerOptions.credentialFiles).toEqual([
        {
          path: '/work/opencode.json',
          content: `${JSON.stringify({
            provider: {
              openrouter: {
                models: {
                  'z-ai/glm-5.2': {
                    options: { reasoningEffort: 'high' },
                  },
                },
              },
            },
          }, null, 2)}\n`,
          mode: 0o644,
        },
      ]);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('writes no OpenCode config when reasoning effort is unset', async () => {
    const context = await setup('opencode');
    try {
      expect(context.containerOptions.credentialFiles).toBeUndefined();
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it.each(['codex', 'opencode', 'claude'] as const)(
    '%s credentials are scrubbed after prepare and exposed after teardown cleanup',
    async (harness) => {
      const context = await setup(harness);
      const credential = testCredentials[harness];
      const streamed: unknown[] = [];
      context.journal.subscribe(context.run.id, (event) => streamed.push(event));
      try {
        const redacted = context.journal.append(context.run.id, context.entrant.id, 'tool.result', {
          entrantId: context.entrant.id,
          tool: 'shell',
          toolCallId: 'credential-echo',
          ok: true,
          detail: `env credential=${credential}`,
        });
        const stored = context.journal.database
          .select({ payloadJson: eventRows.payloadJson })
          .from(eventRows)
          .where(eq(eventRows.id, redacted.id))
          .get();

        expect(redacted.payload.detail).toBe('env credential=[redacted-key]');
        expect(stored?.payloadJson).toBe(JSON.stringify(redacted.payload));
        expect(streamed).toEqual([redacted]);

        await context.driver.stop(context.run, context.entrant);
        dropCredentialSecrets(context.run.id);
        const exposed = context.journal.append(context.run.id, context.entrant.id, 'tool.result', {
          entrantId: context.entrant.id,
          tool: 'shell',
          toolCallId: 'credential-after-drop',
          ok: true,
          detail: credential,
        });
        expect(exposed.payload.detail).toBe(credential);
      } finally {
        await context.driver.stop(context.run, context.entrant);
        dropCredentialSecrets(context.run.id);
        context.journal.close();
      }
    },
  );

  it('registers only long secret-shaped leaves from Codex auth JSON', async () => {
    const context = await setup('codex');
    try {
      expect(credentialSecrets(context.run.id)).toEqual([
        testCredentials.codex,
        testCredentials.codexRefresh,
      ]);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      dropCredentialSecrets(context.run.id);
      context.journal.close();
    }
  });

  it.each(['codex', 'opencode', 'claude'] as const)('%s always injects ETH_RPC_URL into the container', async (harness) => {
    const context = await setup(harness);
    try {
      expect(context.containerOptions.env).toEqual(expect.objectContaining({
        ETH_RPC_URL: 'http://host.docker.internal:8545',
        ARENA_API_URL: expect.stringContaining('http://host.docker.internal:') as string,
        ARENA_AGENT_TOKEN: expect.stringMatching(/^[0-9a-f]{48}$/) as string,
      }));
      expect(context.containerOptions.env).not.toHaveProperty('WALLET_ADDRESS');
      expect(context.containerOptions.env).not.toHaveProperty('WALLET_PRIVATE_KEY');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it.each(['codex', 'opencode', 'claude'] as const)('%s injects wallet credentials when a wallet row exists', async (harness) => {
    const context = await setup(harness, 10 * 60 * 1_000, true);
    try {
      const wallet = getWallet(context.run.id, context.entrant.id);
      expect(wallet).not.toBeNull();
      expect(context.containerOptions.env).toEqual(expect.objectContaining({
        ETH_RPC_URL: 'http://host.docker.internal:8545',
        WALLET_ADDRESS: wallet?.address,
        WALLET_PRIVATE_KEY: wallet?.privateKey,
      }));
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it.each(['codex', 'claude'] as const)('blocks %s when resume returns a different session ID', async (harness) => {
    const context = await setup(harness);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn(harness, context.container.turns[0] as ControlledExecution, 'session-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      await context.driver.steer(context.run, context.entrant, 'resume');
      const resume = context.container.turns[1] as ControlledExecution;
      resume.push(JSON.stringify(harness === 'codex'
        ? { type: 'thread.started', thread_id: 'ghost-thread' }
        : { type: 'system', subtype: 'init', session_id: 'ghost-session' }));
      await waitFor(() => resume.killCalls.length === 1);
      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.status' && event.payload.status === 'blocked'));

      const events = context.journal.after(context.run.id, 0);
      expect(events.some((event) => event.type === 'entrant.error' &&
        event.payload.message.includes('expected session-1'))).toBe(true);
      expect(events.some((event) => event.type === 'entrant.status' &&
        event.payload.status === 'blocked')).toBe(true);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('kills a stuck OpenCode turn and releases its queued steer', async () => {
    const context = await setup('opencode', 200);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const first = context.container.turns[0] as ControlledExecution;
      first.push(JSON.stringify({ type: 'step_start', sessionID: 'session-1', part: {} }));
      await context.driver.steer(context.run, context.entrant, 'queued after timeout');

      await waitFor(() => first.killCalls.length === 1);
      await waitFor(() => context.container.turns.length === 2);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' && event.payload.message.includes('Watchdog'))).toBe(true);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.steered' && event.payload.text === 'queued after timeout')).toBe(true);

      completeTurn('opencode', context.container.turns[1] as ControlledExecution, 'session-1');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('resets the turn watchdog when the harness emits parsed progress', async () => {
    const context = await setup('opencode', 500);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;

      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        turn.push(JSON.stringify({
          type: 'text',
          sessionID: 'session-1',
          part: { text: `progress ${index}` },
        }));
      }

      expect(turn.killCalls).toHaveLength(0);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error')).toBe(false);

      await waitFor(() => turn.killCalls.length === 1);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === "Watchdog: no output for 500ms; killed the turn's process group"
      )).toBe(true);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('does not refresh the turn watchdog for repeated known-session heartbeat noise', async () => {
    const context = await setup('opencode', 200);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({ type: 'step_start', sessionID: 'session-1', part: {} }));
      heartbeat = setInterval(() => turn.push(JSON.stringify({
        type: 'server.heartbeat',
        sessionID: 'session-1',
        part: {},
      })), 40);

      await waitFor(() => turn.killCalls.length === 1);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === "Watchdog: no output for 200ms; killed the turn's process group"
      )).toBe(true);
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('kills a turn despite steady stderr chatter', async () => {
    const context = await setup('opencode', 200);
    let chatter: NodeJS.Timeout | undefined;
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      chatter = setInterval(() => turn.push('still noisy', 'err'), 20);

      await waitFor(() => turn.killCalls.length === 1);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === "Watchdog: no output for 200ms; killed the turn's process group"
      )).toBe(true);
    } finally {
      if (chatter !== undefined) clearInterval(chatter);
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('kills a turn at its absolute cap despite steady parsed progress', async () => {
    const context = await setup(
      'opencode',
      500,
      false,
      undefined,
      undefined,
      undefined,
      { turnMaxMs: 200 },
    );
    let progress: NodeJS.Timeout | undefined;
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      progress = setInterval(() => turn.push(JSON.stringify({
        type: 'text',
        sessionID: 'session-1',
        part: { text: 'still working' },
      })), 20);

      await waitFor(() => turn.killCalls.length === 1);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message ===
          "Watchdog: turn ran past the 200ms cap; killed the turn's process group"
      )).toBe(true);
    } finally {
      if (progress !== undefined) clearInterval(progress);
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('keeps the inactivity watchdog armed while a completed turn drains', async () => {
    const warnings: string[] = [];
    const context = await setup(
      'opencode',
      200,
      false,
      undefined,
      undefined,
      undefined,
      { logger: { info() {}, warn: (message) => warnings.push(message) } },
    );
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({
        type: 'step_finish',
        sessionID: 'session-1',
        part: { reason: 'stop', tokens: { input: 10, output: 2 } },
      }));

      await waitFor(() => turn.killCalls.length === 1);
      expect(warnings.some((message) => message.includes(
        "Watchdog: no output for 200ms; killed the turn's process group",
      ))).toBe(true);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' && event.payload.message.includes('Watchdog'))).toBe(false);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('keeps the absolute cap armed while a completed turn drains', async () => {
    const warnings: string[] = [];
    const context = await setup(
      'opencode',
      500,
      false,
      undefined,
      undefined,
      undefined,
      {
        turnMaxMs: 200,
        logger: { info() {}, warn: (message) => warnings.push(message) },
      },
    );
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.push(JSON.stringify({
        type: 'step_finish',
        sessionID: 'session-1',
        part: { reason: 'stop', tokens: { input: 10, output: 2 } },
      }));

      await waitFor(() => turn.killCalls.length === 1);
      expect(warnings.some((message) => message.includes(
        "Watchdog: turn ran past the 200ms cap; killed the turn's process group",
      ))).toBe(true);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' && event.payload.message.includes('Watchdog'))).toBe(false);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('leaves a watchdog-killed resume turn idle when it reports no session ID', async () => {
    const context = await setup('codex', 200);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status').at(-1)?.payload.status === 'idle');

      await context.driver.steer(context.run, context.entrant, 'resume');
      const resume = context.container.turns[1] as ControlledExecution;
      await waitFor(() => resume.killCalls.length === 1);
      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status').at(-1)?.payload.status === 'idle');

      const events = context.journal.after(context.run.id, 0);
      expect(events.some((event) => event.type === 'entrant.status' &&
        event.payload.status === 'blocked')).toBe(false);
      expect(events.some((event) => event.type === 'entrant.error' &&
        event.payload.message.includes('returned no thread ID'))).toBe(false);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('kills a stuck Codex turn with its watchdog', async () => {
    const context = await setup('codex', 200);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;

      await waitFor(() => turn.killCalls.length === 1);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === "Watchdog: no output for 200ms; killed the turn's process group"
      )).toBe(true);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('journals a rejected inactivity-watchdog kill', async () => {
    const context = await setup('opencode', 200);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.killFailure = new Error('process group is gone');

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === 'Watchdog kill failed: process group is gone'));
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message.includes('no output for 200ms'))).toBe(true);
      turn.finish(null);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('journals a rejected absolute-cap kill', async () => {
    const context = await setup(
      'opencode',
      500,
      false,
      undefined,
      undefined,
      undefined,
      { turnMaxMs: 200 },
    );
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;
      turn.killFailure = new Error('process group is gone');
      turn.push(JSON.stringify({
        type: 'text',
        sessionID: 'session-1',
        part: { text: 'progress' },
      }));

      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message === 'Watchdog kill failed: process group is gone'));
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' &&
        event.payload.message.includes('ran past the 200ms cap'))).toBe(true);
      turn.finish(null);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('formats production watchdog durations', () => {
    expect(formatWatchdogDuration(20 * 60 * 1_000)).toBe('20m');
    expect(formatWatchdogDuration(2 * 60 * 60 * 1_000)).toBe('2h');
  });

  it('derives timer durations from options and the run', async () => {
    const context = await setup('opencode');
    try {
      const shortRun = { ...context.run, durationMs: 1_234 };
      const noDurationRun = { ...context.run, durationMs: null };

      expect(new TimerProbeDriver(context.journal, { turnMaxMs: 321 })
        .timerValues(shortRun).turnCapMs).toBe(321);
      expect(new TimerProbeDriver(context.journal)
        .timerValues(shortRun).turnCapMs).toBe(1_234 + 10 * 60 * 1_000);
      expect(new TimerProbeDriver(context.journal)
        .timerValues(noDurationRun).turnCapMs).toBe(2 * 60 * 60 * 1_000);

      for (const durationMs of [0, -1]) {
        expect(new TimerProbeDriver(context.journal, {
          turnWatchdogMs: durationMs,
          turnMaxMs: durationMs,
        }).timerValues(shortRun)).toEqual({ watchdogMs: undefined, turnCapMs: undefined });
      }
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('disables both turn timers when their configured durations are zero', async () => {
    vi.useFakeTimers();
    const context = await setup(
      'opencode',
      0,
      false,
      undefined,
      undefined,
      undefined,
      { turnMaxMs: 0 },
    );
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const turn = context.container.turns[0] as ControlledExecution;

      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1_000);

      expect(turn.killCalls).toHaveLength(0);
      completeTurn('opencode', turn, 'session-1');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('removes OpenCode server variables from the launch environment', () => {
    expect(scrubOpenCodeEnvironment({
      OPENROUTER_API_KEY: 'key',
      OPENCODE_SERVER_PASSWORD: 'bad',
      OPENCODE_PORT: '4096',
    })).toEqual({ OPENROUTER_API_KEY: 'key' });
  });

  it('passes an OAuth token into an otherwise empty Claude credential home', async () => {
    const context = await setup('claude');
    try {
      expect(context.containerOptions.credentialFiles).toEqual([{ path: '/creds/claude' }]);
      expect(context.containerOptions.env).toEqual({
        CLAUDE_CONFIG_DIR: '/creds/claude',
        CLAUDE_CODE_OAUTH_TOKEN: testCredentials.claude,
        ETH_RPC_URL: 'http://host.docker.internal:8545',
        ARENA_API_URL: expect.stringContaining('http://host.docker.internal:') as string,
        ARENA_AGENT_TOKEN: expect.stringMatching(/^[0-9a-f]{48}$/) as string,
      });
      expect(context.containerOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(context.containerOptions.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(context.containerOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('omits Claude effort from start and resume arguments when unset', async () => {
    const context = await setup('claude');
    try {
      expect(context.container.calls[2]?.argv).toEqual(['claude', '--version']);
      await context.driver.start(context.run, context.entrant, 'opening prompt');
      expect(context.container.calls[3]?.argv).toEqual([
        'claude',
        '-p',
        'opening prompt',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-5',
      ]);
      completeTurn('claude', context.container.turns[0] as ControlledExecution, 'session-1');
      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status')
        .at(-1)?.payload.status === 'idle');

      await context.driver.steer(context.run, context.entrant, 'steer text');
      expect(context.container.calls[4]?.argv).toEqual([
        'claude',
        '-p',
        '--resume',
        'session-1',
        'steer text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-5',
      ]);
      completeTurn('claude', context.container.turns[1] as ControlledExecution, 'session-1');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('passes Claude effort in start and resume arguments when set', async () => {
    const context = await setup('claude', undefined, false, undefined, 'high');
    try {
      await context.driver.start(context.run, context.entrant, 'opening prompt');
      expect(context.container.calls[3]?.argv).toEqual([
        'claude',
        '-p',
        'opening prompt',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-5',
        '--effort',
        'high',
      ]);
      completeTurn('claude', context.container.turns[0] as ControlledExecution, 'session-1');
      await waitFor(() => context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.status')
        .at(-1)?.payload.status === 'idle');

      await context.driver.steer(context.run, context.entrant, 'steer text');
      expect(context.container.calls[4]?.argv).toEqual([
        'claude',
        '-p',
        '--resume',
        'session-1',
        'steer text',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-5',
        '--effort',
        'high',
      ]);
      completeTurn('claude', context.container.turns[1] as ControlledExecution, 'session-1');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });
});

describe('adapter construction errors', () => {
  it('does not create a Codex container when auth.json is missing', async () => {
    const journal = new EventJournal(':memory:');
    const containerFactory: ContainerFactory = vi.fn(async () => new ControlledContainer());
    const run: RunRecord = {
      id: 'missing-codex-auth-run',
      state: 'created',
      preset: 'docker-duel',
      startedAt: null,
      deadlineAt: null,
      durationMs: null,
      idempotencyKey: null,
    };
    const entrant: EntrantRecord = {
      runId: run.id,
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5.5',
      effort: null,
      address: null,
      status: 'idle',
    };
    const driver = new CodexDriver(journal, {
      authPath: '/missing/codex-auth.json',
      containerFactory,
    });

    try {
      await expect(driver.prepare(run, entrant)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(containerFactory).not.toHaveBeenCalled();
    } finally {
      journal.close();
    }
  });

  it('routes an unknown legacy preset to Docker during teardown', async () => {
    const journal = new EventJournal(':memory:');
    const dockerStop = vi.spyOn(DockerEntrantDriver.prototype, 'stop').mockResolvedValue();
    const fakeStop = vi.spyOn(FakeDriver.prototype, 'stop').mockResolvedValue();
    const driver = new RegisteredEntrantDriver(journal);
    const run: RunRecord = {
      id: 'legacy-run',
      state: 'stopping',
      preset: 'legacy-gone',
      startedAt: null,
      deadlineAt: null,
      durationMs: null,
      idempotencyKey: null,
    };
    const entrant: EntrantRecord = {
      runId: run.id,
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5.5',
      effort: null,
      address: null,
      status: 'working',
    };

    try {
      await expect(driver.stop(run, entrant)).resolves.toBeUndefined();
      expect(dockerStop).toHaveBeenCalledWith(run, entrant);
      expect(fakeStop).not.toHaveBeenCalled();
    } finally {
      dockerStop.mockRestore();
      fakeStop.mockRestore();
      journal.close();
    }
  });

  it.each(['opencode', 'claude'] as const)('%s rejects a missing environment credential', async (harness) => {
    const journal = new EventJournal(':memory:');
    const run: RunRecord = {
      id: 'missing-credential-run',
      state: 'created',
      preset: 'docker-arena',
      startedAt: null,
      deadlineAt: null,
      durationMs: null,
      idempotencyKey: null,
    };
    const entrant: EntrantRecord = {
      runId: run.id,
      id: `${harness}-1`,
      harness,
      model: harness === 'claude' ? 'claude-opus-5' : 'openrouter/z-ai/glm-5.2',
      effort: null,
      address: null,
      status: 'idle',
    };
    const driver: EntrantDriver = harness === 'claude'
      ? new ClaudeDriver(journal, { oauthToken: '' })
      : new OpenCodeDriver(journal, { apiKey: '', authPath: '/missing/opencode-auth.json' });

    try {
      await expect(driver.prepare(run, entrant)).rejects.toThrow(
        harness === 'claude'
          ? 'Claude OAuth token not found in CLAUDE_CODE_OAUTH_TOKEN'
          : 'OpenRouter API key not found',
      );
    } finally {
      journal.close();
    }
  });

  it.each(['codex', 'opencode', 'claude'] as const)('%s rejects an entrant for another harness', async (harness) => {
    const journal = new EventJournal(':memory:');
    const run: RunRecord = {
      id: 'wrong-harness-run',
      state: 'created',
      preset: 'docker-arena',
      startedAt: null,
      deadlineAt: null,
      durationMs: null,
      idempotencyKey: null,
    };
    const entrant: EntrantRecord = {
      runId: run.id,
      id: 'wrong-1',
      harness: harness === 'codex' ? 'opencode' : 'codex',
      model: 'test-model',
      effort: null,
      address: null,
      status: 'idle',
    };
    const driver: EntrantDriver = harness === 'codex'
      ? new CodexDriver(journal)
      : harness === 'opencode'
        ? new OpenCodeDriver(journal)
        : new ClaudeDriver(journal);

    try {
      await expect(driver.prepare(run, entrant)).rejects.toThrow('cannot run harness');
    } finally {
      journal.close();
    }
  });
});
