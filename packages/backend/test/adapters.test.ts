import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexDriver } from '../src/adapters/codex.js';
import { OpenCodeDriver, scrubOpenCodeEnvironment } from '../src/adapters/opencode.js';
import {
  EntrantUnavailableError,
  type EntrantDriver,
  type EntrantRecord,
  type RunRecord,
} from '../src/adapters/types.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import { deriveEntrantKeys, getWallet, seedTypedData } from '../src/chain/wallet.js';
import { entrants, runs } from '../src/db/schema.js';
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

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class ControlledExecution implements RuntimeExecution {
  readonly exit: Promise<number | null>;
  readonly killCalls: string[] = [];
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
  tornDown = false;
  private active: ControlledExecution | undefined;

  async exec(argv: string[], env?: Record<string, string>): Promise<RuntimeExecution> {
    if (this.active !== undefined) throw new Error('single-writer violation');
    this.calls.push(env === undefined ? { argv } : { argv, env });
    const execution = new ControlledExecution(`exec-${this.calls.length}`, () => {
      if (this.active === execution) this.active = undefined;
    });
    this.active = execution;

    const isTurn = argv[0] === 'codex' && argv[1] === 'exec' || argv[0] === 'opencode' && argv[1] === 'run';
    if (isTurn) {
      this.turns.push(execution);
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

async function setup(
  harness: 'codex' | 'opencode',
  watchdogMs = 10 * 60 * 1_000,
  withWallet = false,
  model?: string,
): Promise<{
  journal: EventJournal;
  driver: EntrantDriver;
  run: RunRecord;
  entrant: EntrantRecord;
  container: ControlledContainer;
  containerOptions: ContainerOptions;
}> {
  const journal = new EventJournal(':memory:');
  const seedDriver: EntrantDriver = {
    async prepare() {}, async start() {}, async steer() {}, async stop() {},
  };
  const manager = new RunManager(journal, seedDriver);
  const created = await manager.create({ preset: 'docker-duel' });
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  let entrant = journal.database.select().from(entrants).where(and(
    eq(entrants.runId, created.run.id),
    eq(entrants.harness, harness),
  )).get();
  if (run === undefined || entrant === undefined) throw new Error('Test run was not seeded');
  // Cost pricing keys off the entrant's model, so a test can swap in a model the
  // rate table lists (or one it does not).
  if (model !== undefined) entrant = { ...entrant, model };
  if (withWallet) {
    const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
    const signature = await account.signTypedData(seedTypedData(run.id, 31337));
    deriveEntrantKeys(run.id, signature, [entrant.id]);
  }

  const container = new ControlledContainer();
  let containerOptions: ContainerOptions | undefined;
  const containerFactory: ContainerFactory = async (options: ContainerOptions) => {
    containerOptions = options;
    if (options.credentialDir !== undefined) temporaryPaths.push(options.credentialDir);
    return container;
  };
  let driver: EntrantDriver;
  if (harness === 'codex') {
    const authDirectory = await mkdtemp(join(tmpdir(), 'arena-test-auth-'));
    temporaryPaths.push(authDirectory);
    const authPath = join(authDirectory, 'auth.json');
    await writeFile(authPath, '{}');
    driver = new CodexDriver(journal, { authPath, containerFactory });
  } else {
    driver = new OpenCodeDriver(journal, {
      apiKey: 'test-key',
      containerFactory,
      turnWatchdogMs: watchdogMs,
    });
  }
  await driver.prepare(run, entrant);
  if (containerOptions === undefined) {
    throw new Error('Container factory was not called');
  }
  return { journal, driver, run, entrant, container, containerOptions };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not met');
}

function completeTurn(harness: 'codex' | 'opencode', execution: ControlledExecution, sessionId: string): void {
  if (harness === 'codex') {
    execution.push(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));
    execution.push(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
  } else {
    execution.push(JSON.stringify({ type: 'step_start', sessionID: sessionId, part: {} }));
    execution.push(JSON.stringify({
      type: 'step_finish',
      sessionID: sessionId,
      part: { reason: 'stop', tokens: { input: 10, output: 2 } },
    }));
  }
  execution.finish(0);
}

describe.each(['codex', 'opencode'] as const)('%s steer rejection', (harness) => {
  it('rejects a steer sent before the opening turn without degrading the entrant', async () => {
    const context = await setup(harness);
    const sessionId = harness === 'codex' ? 'thread-1' : 'session-1';
    try {
      await expect(context.driver.steer(context.run, context.entrant, 'too early'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);
      expect(context.container.turns).toHaveLength(0);
      // The caller records the miss on the lane; the driver stays silent.
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.error')).toHaveLength(0);

      // The early miss must not poison the entrant: once the opening turn
      // reports a session, a steer goes through.
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

describe.each(['codex', 'opencode'] as const)('%s steer queue', (harness) => {
  it('queues during a turn and injects at once while idle', async () => {
    const context = await setup(harness);
    const sessionId = harness === 'codex' ? 'thread-1' : 'session-1';
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      expect(context.container.turns).toHaveLength(1);

      await context.driver.steer(context.run, context.entrant, 'queued steer');
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

      await context.driver.steer(context.run, context.entrant, 'idle steer');
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

describe('parser isolation', () => {
  // One CodexDriver serves every run in the process and entrant ids are preset
  // literals, so a parser cache keyed by entrant alone would let two runs in
  // flight interleave their sessions and reset each other's token baseline.
  it('gives each run its own parser so a second run cannot reset the baseline', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, {
      async prepare() {}, async start() {}, async steer() {}, async stop() {},
    });
    const authDirectory = await mkdtemp(join(tmpdir(), 'arena-test-auth-'));
    temporaryPaths.push(authDirectory);
    const authPath = join(authDirectory, 'auth.json');
    await writeFile(authPath, '{}');

    const containers: ControlledContainer[] = [];
    const containerFactory: ContainerFactory = async (options) => {
      if (options.credentialDir !== undefined) temporaryPaths.push(options.credentialDir);
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

describe('adapter guardrails', () => {
  it.each(['codex', 'opencode'] as const)('%s always injects ETH_RPC_URL into the container', async (harness) => {
    const context = await setup(harness);
    try {
      expect(context.containerOptions.env).toEqual(expect.objectContaining({
        ETH_RPC_URL: 'http://host.docker.internal:8545',
      }));
      expect(context.containerOptions.env).not.toHaveProperty('WALLET_ADDRESS');
      expect(context.containerOptions.env).not.toHaveProperty('WALLET_PRIVATE_KEY');
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it.each(['codex', 'opencode'] as const)('%s injects wallet credentials when a wallet row exists', async (harness) => {
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

  it('blocks Codex when resume returns a different thread ID', async () => {
    const context = await setup('codex');
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      completeTurn('codex', context.container.turns[0] as ControlledExecution, 'thread-1');
      await waitFor(() => {
        const statuses = context.journal.after(context.run.id, 0).filter((event) =>
          event.type === 'entrant.status');
        return statuses.at(-1)?.payload.status === 'idle';
      });

      await context.driver.steer(context.run, context.entrant, 'resume');
      const resume = context.container.turns[1] as ControlledExecution;
      resume.push(JSON.stringify({ type: 'thread.started', thread_id: 'ghost-thread' }));
      await waitFor(() => resume.killCalls.length === 1);
      await waitFor(() => context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.status' && event.payload.status === 'blocked'));

      const events = context.journal.after(context.run.id, 0);
      expect(events.some((event) => event.type === 'entrant.error' &&
        event.payload.message.includes('expected thread-1'))).toBe(true);
      expect(events.some((event) => event.type === 'entrant.status' &&
        event.payload.status === 'blocked')).toBe(true);
    } finally {
      await context.driver.stop(context.run, context.entrant);
      context.journal.close();
    }
  });

  it('kills a stuck OpenCode turn and releases its queued steer', async () => {
    const context = await setup('opencode', 20);
    try {
      await context.driver.start(context.run, context.entrant, 'opening');
      const first = context.container.turns[0] as ControlledExecution;
      first.push(JSON.stringify({ type: 'step_start', sessionID: 'session-1', part: {} }));
      await context.driver.steer(context.run, context.entrant, 'queued after timeout');

      await waitFor(() => first.killCalls.length === 1);
      await waitFor(() => context.container.turns.length === 2);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.error' && event.payload.message.includes('watchdog'))).toBe(true);
      expect(context.journal.after(context.run.id, 0).some((event) =>
        event.type === 'entrant.steered' && event.payload.text === 'queued after timeout')).toBe(true);

      completeTurn('opencode', context.container.turns[1] as ControlledExecution, 'session-1');
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
});
