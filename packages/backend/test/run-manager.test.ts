import { describe, expect, it } from 'vitest';

import type { EntrantDriver } from '../src/adapters/types.js';
import { recordSolve } from '../src/chain/storage.js';
import { EventJournal } from '../src/journal.js';
import {
  InvalidTransitionError,
  LEGAL_TRANSITIONS,
  passThroughWalletGate,
  RunManager,
  type WalletGate,
} from '../src/run-manager.js';
import type { RunState } from '../src/contract.js';

const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() {},
  async stop() {},
};

async function createManager() {
  const journal = new EventJournal(':memory:');
  const manager = new RunManager(journal, noopDriver);
  const { run } = await manager.create({ preset: 'fake-duel' });
  return { journal, manager, runId: run.id };
}

async function advance(manager: RunManager, runId: string, target: RunState): Promise<void> {
  const path: RunState[] = ['created', 'preparing', 'awaiting_funding', 'ready', 'running', 'stopping', 'finished'];
  const targetIndex = path.indexOf(target);
  for (const state of path.slice(1, targetIndex + 1)) {
    manager.transition(runId, state);
  }
}

describe('RunManager state machine', () => {
  const legalEdges = Object.entries(LEGAL_TRANSITIONS).flatMap(([from, destinations]) =>
    destinations.map((to) => [from as RunState, to] as const),
  );

  it.each(legalEdges)('allows %s → %s', async (from, to) => {
    const { journal, manager, runId } = await createManager();
    try {
      await advance(manager, runId, from);
      expect(manager.transition(runId, to).state).toBe(to);
      const stateEvents = journal.after(runId, 0).filter((event) => event.type === 'run.state');
      expect(stateEvents.at(-1)?.payload.state).toBe(to);
    } finally {
      journal.close();
    }
  });

  it('rejects every transition outside the legal table', async () => {
    const states = Object.keys(LEGAL_TRANSITIONS) as RunState[];
    for (const from of states) {
      if (from === 'failed') continue;
      const { journal, manager, runId } = await createManager();
      try {
        await advance(manager, runId, from);
        for (const to of states.filter((candidate) => !LEGAL_TRANSITIONS[from].includes(candidate))) {
          expect(() => manager.transition(runId, to)).toThrow(InvalidTransitionError);
        }
      } finally {
        journal.close();
      }
    }
  });

  it.each(['created', 'preparing', 'awaiting_funding', 'ready', 'running', 'stopping'] as const)(
    'allows failure from %s',
    async (from) => {
      const { journal, manager, runId } = await createManager();
      try {
        await advance(manager, runId, from);
        expect(manager.transition(runId, 'failed', 'test failure').state).toBe('failed');
      } finally {
        journal.close();
      }
    },
  );
});

describe('RunManager snapshot solves', () => {
  it('derives solves and flag counts from scores rows', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      const solves = [
        { entrantId: 'codex-1', entrantAddress: '0xA1', challengeId: 3, txHash: '0xaaa', tokenId: '1' },
        { entrantId: 'codex-1', entrantAddress: '0xA1', challengeId: 7, txHash: '0xbbb', tokenId: '2' },
        { entrantId: 'opencode-1', entrantAddress: '0xB2', challengeId: 3, txHash: '0xccc', tokenId: '3' },
      ];
      for (const solve of solves) {
        expect(recordSolve(journal.database, journal, { runId, blockNumber: 1, ...solve })).toBe(true);
      }

      const flagEvents = journal.after(runId, 0).filter((event) => event.type === 'score.flag');
      expect(flagEvents).toHaveLength(3);

      const { entrants } = manager.snapshot(runId);
      const codex = entrants.find((entrant) => entrant.id === 'codex-1');
      const opencode = entrants.find((entrant) => entrant.id === 'opencode-1');

      expect(codex?.flags).toBe(2);
      expect(codex?.solves.map((solve) => solve.challengeId)).toEqual([3, 7]);
      expect(codex?.solves.map((solve) => solve.txHash)).toEqual(['0xaaa', '0xbbb']);
      expect(codex?.solves.every((solve) => typeof solve.ts === 'string')).toBe(true);
      expect(opencode?.flags).toBe(1);
      expect(opencode?.solves).toMatchObject([{ challengeId: 3, txHash: '0xccc' }]);
    } finally {
      journal.close();
    }
  });

  it('ignores a duplicate capture of the same challenge', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      const solve = {
        runId, entrantId: 'codex-1', entrantAddress: '0xA1', challengeId: 3,
        txHash: '0xaaa', tokenId: '1', blockNumber: 1,
      };
      expect(recordSolve(journal.database, journal, solve)).toBe(true);
      expect(recordSolve(journal.database, journal, { ...solve, tokenId: '2', txHash: '0xbbb' })).toBe(false);

      const codex = manager.snapshot(runId).entrants.find((entrant) => entrant.id === 'codex-1');
      expect(codex?.flags).toBe(1);
      expect(journal.after(runId, 0).filter((event) => event.type === 'score.flag')).toHaveLength(1);
    } finally {
      journal.close();
    }
  });

  it('returns empty solves and zero flags before any capture', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      for (const entrant of manager.snapshot(runId).entrants) {
        expect(entrant.flags).toBe(0);
        expect(entrant.solves).toEqual([]);
      }
    } finally {
      journal.close();
    }
  });
});

describe('RunManager idempotency', () => {
  it('returns one run for repeated idempotency keys', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const first = await manager.create({ preset: 'fake-duel', idempotencyKey: 'request-1' });
      const second = await manager.create({ preset: 'fake-duel', idempotencyKey: 'request-1' });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(manager.countRuns()).toBe(1);
      expect(journal.after(first.run.id, 0)).toHaveLength(1);
    } finally {
      journal.close();
    }
  });
});

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

class BarrierDriver implements EntrantDriver {
  readonly prepareControls = new Map<string, Deferred>();
  readonly prepares: string[] = [];
  readonly starts: Array<{ entrantId: string; startedAt: string | null }> = [];
  readonly stops: string[] = [];

  async prepare(_run: Parameters<EntrantDriver['prepare']>[0], entrant: Parameters<EntrantDriver['prepare']>[1]) {
    this.prepares.push(entrant.id);
    await new Promise<void>((resolve, reject) => {
      this.prepareControls.set(entrant.id, { resolve: () => resolve(), reject });
    });
  }

  async start(run: Parameters<EntrantDriver['start']>[0], entrant: Parameters<EntrantDriver['start']>[1]) {
    this.starts.push({ entrantId: entrant.id, startedAt: run.startedAt });
  }

  async steer() {}

  async stop(_run: Parameters<EntrantDriver['stop']>[0], entrant: Parameters<EntrantDriver['stop']>[1]) {
    this.stops.push(entrant.id);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not met');
}

describe('RunManager ready barrier', () => {
  it('runs the wallet gate after preparing state and before driver.prepare', async () => {
    const journal = new EventJournal(':memory:');
    const calls: string[] = [];
    const driver: EntrantDriver = {
      async prepare() {
        calls.push('prepare');
      },
      async start() {},
      async steer() {},
      async stop() {},
    };
    const walletGate: WalletGate = async (run) => {
      calls.push(`wallet:${run.state}`);
      const stateEvents = journal.after(run.id, 0).filter((event) => event.type === 'run.state');
      expect(stateEvents.at(-1)?.payload.state).toBe('preparing');
    };
    const manager = new RunManager(journal, driver, undefined, { walletGate });
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      await manager.start(run.id);

      expect(calls[0]).toBe('wallet:preparing');
      expect(calls.slice(1)).toEqual(['prepare', 'prepare']);
    } finally {
      journal.close();
    }
  });

  it('leaves entrants unchanged with the default wallet gate', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver, undefined, {
      walletGate: passThroughWalletGate,
    });
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      await manager.start(run.id);

      expect(manager.snapshot(run.id).entrants.map((entrant) => entrant.address)).toEqual([null, null]);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned')).toEqual([]);
    } finally {
      journal.close();
    }
  });

  it('shares one in-flight start between concurrent callers', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const first = manager.start(run.id);
      const second = manager.start(run.id);

      expect(second).toBe(first);
      await waitFor(() => driver.prepareControls.size === 2);
      driver.prepareControls.get('codex-1')?.resolve();
      driver.prepareControls.get('opencode-1')?.resolve();

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(secondResult).toEqual(firstResult);
      expect(driver.prepares.sort()).toEqual(['codex-1', 'opencode-1']);
      expect(driver.stops).toEqual([]);
      expect(manager.snapshot(run.id).state).toBe('running');

      await expect(manager.start(run.id)).rejects.toThrow(InvalidTransitionError);
      expect(driver.stops).toEqual([]);
      expect(manager.snapshot(run.id).state).toBe('running');
    } finally {
      journal.close();
    }
  });

  it('waits for both entrants and gives them one recorded start time', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const starting = manager.start(run.id);
      await waitFor(() => driver.prepareControls.size === 2);

      driver.prepareControls.get('codex-1')?.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(driver.starts).toEqual([]);

      driver.prepareControls.get('opencode-1')?.resolve();
      const started = await starting;
      expect(started.state).toBe('running');
      expect(started.startedAt).not.toBeNull();
      expect(driver.starts).toHaveLength(2);
      expect(new Set(driver.starts.map((call) => call.startedAt))).toEqual(new Set([started.startedAt]));
    } finally {
      journal.close();
    }
  });

  it('starts neither entrant and tears down both when one preflight fails', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const outcome = manager.start(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitFor(() => driver.prepareControls.size === 2);

      driver.prepareControls.get('codex-1')?.reject(new Error('codex preflight failed'));
      driver.prepareControls.get('opencode-1')?.resolve();
      const result = await outcome;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual(new Error('codex preflight failed'));
      expect(driver.starts).toEqual([]);
      expect(driver.stops.sort()).toEqual(['codex-1', 'opencode-1']);
      expect(manager.snapshot(run.id).state).toBe('failed');
    } finally {
      journal.close();
    }
  });
});

describe('RunManager lifecycle cancellation', () => {
  it('stops a run while preparation is stuck', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const startOutcome = manager.start(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitFor(() => driver.prepareControls.size === 2);

      const stopped = await manager.stop(run.id);
      const startResult = await startOutcome;

      expect(stopped.state).toBe('failed');
      expect(startResult.ok).toBe(false);
      if (!startResult.ok) {
        expect(startResult.error).toEqual(new Error('stopped by operator before running'));
      }
      expect(driver.stops.sort()).toEqual(['codex-1', 'opencode-1']);
      const stateEvents = journal.after(run.id, 0).filter((event) => event.type === 'run.state');
      expect(stateEvents.at(-1)?.payload).toEqual({
        state: 'failed',
        reason: 'stopped by operator before running',
      });
    } finally {
      journal.close();
    }
  });

  it('fails and tears down a run when preparation times out', async () => {
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver, undefined, { prepareTimeoutMs: 10 });
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const outcome = await manager.start(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toEqual(new Error('prepare phase timed out after 10ms'));
      expect(manager.snapshot(run.id).state).toBe('failed');
      expect(driver.stops.sort()).toEqual(['codex-1', 'opencode-1']);
      const stateEvents = journal.after(run.id, 0).filter((event) => event.type === 'run.state');
      expect(stateEvents.at(-1)?.payload).toEqual({
        state: 'failed',
        reason: 'prepare phase timed out after 10ms',
      });
    } finally {
      journal.close();
    }
  });

  it('attempts every running entrant stop before reporting failures', async () => {
    const journal = new EventJournal(':memory:');
    const stopError = new Error('codex teardown failed');
    const stops: string[] = [];
    const driver: EntrantDriver = {
      async prepare() {},
      async start() {},
      async steer() {},
      async stop(_run, entrant) {
        stops.push(entrant.id);
        if (entrant.id === 'codex-1') throw stopError;
      },
    };
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      await manager.start(run.id);

      const outcome = await manager.stop(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect((outcome.error as AggregateError).errors).toEqual([stopError]);
      }
      expect(stops).toEqual(['codex-1', 'opencode-1']);
      expect(manager.snapshot(run.id).state).toBe('failed');
    } finally {
      journal.close();
    }
  });
});
