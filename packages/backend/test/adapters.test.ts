import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexDriver } from '../src/adapters/codex.js';
import { OpenCodeDriver, scrubOpenCodeEnvironment } from '../src/adapters/opencode.js';
import {
  EntrantUnavailableError,
  type EntrantDriver,
  type EntrantRecord,
  type RunRecord,
} from '../src/adapters/types.js';
import { createWallet, getWallet } from '../src/chain/wallet.js';
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
  const entrant = journal.database.select().from(entrants).where(and(
    eq(entrants.runId, created.run.id),
    eq(entrants.harness, harness),
  )).get();
  if (run === undefined || entrant === undefined) throw new Error('Test run was not seeded');
  if (withWallet) {
    createWallet(run.id, entrant.id, journal.database);
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
  it('rejects a steer sent before the opening turn and keeps rejecting once degraded', async () => {
    const context = await setup(harness);
    try {
      await expect(context.driver.steer(context.run, context.entrant, 'too early'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);
      expect(context.container.turns).toHaveLength(0);
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.error')
        .map((event) => event.payload.message))
        .toEqual(['Cannot steer before the harness reports a session ID']);

      // Degraded is sticky, and the second rejection must not double-log the cause.
      await expect(context.driver.steer(context.run, context.entrant, 'again'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);
      expect(context.journal.after(context.run.id, 0)
        .filter((event) => event.type === 'entrant.error')).toHaveLength(1);
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
      const wallet = getWallet(context.run.id, context.entrant.id, context.journal.database);
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
