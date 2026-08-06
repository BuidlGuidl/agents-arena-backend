import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import { EntrantUnavailableError, type EntrantDriver } from '../src/adapters/types.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import { activeChainProfile } from '../src/chain/profile.js';
import { recordSolve } from '../src/chain/storage.js';
import { getWallet, seedTypedData } from '../src/chain/wallet.js';
import { entrants } from '../src/db/schema.js';
import { EventJournal } from '../src/journal.js';
import {
  InvalidTransitionError,
  LEGAL_TRANSITIONS,
  presetSubstrate,
  RunManager,
  RunNotFoundError,
  UnknownPresetError,
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

async function withAutoSignDisabled<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.ARENA_AUTO_SIGN;
  process.env.ARENA_AUTO_SIGN = 'false';
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.ARENA_AUTO_SIGN;
    } else {
      process.env.ARENA_AUTO_SIGN = previous;
    }
  }
}

async function advance(manager: RunManager, runId: string, target: RunState): Promise<void> {
  const path: RunState[] = [
    'created',
    'awaiting_signature',
    'preparing',
    'awaiting_funding',
    'ready',
    'running',
    'stopping',
    'finished',
  ];
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

  it.each([
    'created',
    'awaiting_signature',
    'preparing',
    'awaiting_funding',
    'ready',
    'running',
    'stopping',
  ] as const)(
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

describe('run presets', () => {
  it('looks up each preset substrate', () => {
    expect(presetSubstrate('fake-duel')).toBe('fake');
    expect(presetSubstrate('docker-duel')).toBe('docker');
    expect(presetSubstrate('docker-arena')).toBe('docker');
    expect(() => presetSubstrate('missing')).toThrow(UnknownPresetError);
  });

  it('creates the three-entrant docker arena lineup', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const { run } = await manager.create({ preset: 'docker-arena' });
      const lineup = run.entrants
        .map(({ id, harness, model }) => ({ id, harness, model }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(lineup).toEqual([
        { id: 'claude-1', harness: 'claude', model: 'claude-opus-5' },
        { id: 'codex-1', harness: 'codex', model: 'gpt-5.5' },
        { id: 'opencode-1', harness: 'opencode', model: 'openrouter/z-ai/glm-5.2' },
      ]);
    } finally {
      journal.close();
    }
  });
});

describe('RunManager snapshot timing', () => {
  it('exposes the active chain and sets the deadline only when the run starts', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel', durationMs: 60_000 });

      expect(run.chainId).toBe(activeChainProfile.chainId);
      expect(run.startedAt).toBeNull();
      expect(run.deadlineAt).toBeNull();

      const started = await manager.start(run.id);
      expect(started.state).toBe('running');
      expect(started.startedAt).not.toBeNull();
      expect(started.deadlineAt).not.toBeNull();
      expect(Date.parse(started.deadlineAt!) - Date.parse(started.startedAt!)).toBe(60_000);

      const finished = await manager.stop(run.id);
      expect(finished.deadlineAt).toBe(started.deadlineAt);
    } finally {
      journal.close();
    }
  });
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

describe('RunManager snapshot usage', () => {
  it('totals tokens and cost per entrant from usage events', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      journal.append(runId, 'codex-1', 'usage', {
        entrantId: 'codex-1', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.0125,
      });
      journal.append(runId, 'codex-1', 'usage', {
        entrantId: 'codex-1', inputTokens: 250, outputTokens: 40, cachedInputTokens: 0, costUsd: 0.0075,
      });
      journal.append(runId, 'opencode-1', 'usage', {
        entrantId: 'opencode-1', inputTokens: 900, outputTokens: 12, cachedInputTokens: 0, costUsd: null,
      });

      const { entrants } = manager.snapshot(runId);
      const codex = entrants.find((entrant) => entrant.id === 'codex-1');
      const opencode = entrants.find((entrant) => entrant.id === 'opencode-1');

      expect(codex).toMatchObject({ inputTokens: 350, outputTokens: 50, costUsd: 0.02 });
      // Every turn was unpriced, so cost stays unknown instead of reading $0.
      expect(opencode).toMatchObject({ inputTokens: 900, outputTokens: 12, costUsd: null });
    } finally {
      journal.close();
    }
  });

  it('keeps totals across a reload and counts only priced turns in cost', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      journal.append(runId, 'codex-1', 'usage', {
        entrantId: 'codex-1', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: null,
      });
      journal.append(runId, 'codex-1', 'usage', {
        entrantId: 'codex-1', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.001,
      });

      const first = manager.snapshot(runId).entrants.find((entrant) => entrant.id === 'codex-1');
      // A second read is what a browser refresh does: same journal, same totals.
      const second = manager.snapshot(runId).entrants.find((entrant) => entrant.id === 'codex-1');

      expect(first).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.001 });
      expect(second).toEqual(first);
    } finally {
      journal.close();
    }
  });

  it('reports zero tokens and no cost before any usage event', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      for (const entrant of manager.snapshot(runId).entrants) {
        expect(entrant).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null });
      }
    } finally {
      journal.close();
    }
  });
});

describe('RunManager snapshot current challenge', () => {
  it('carries the latest progress guess per entrant, surviving a reload', async () => {
    const { journal, manager, runId } = await createManager();
    try {
      journal.append(runId, 'codex-1', 'entrant.challenge', {
        entrantId: 'codex-1', challengeId: 3,
      });
      journal.append(runId, 'codex-1', 'entrant.challenge', {
        entrantId: 'codex-1', challengeId: 11,
      });

      const { entrants } = manager.snapshot(runId);
      const codex = entrants.find((entrant) => entrant.id === 'codex-1');
      const opencode = entrants.find((entrant) => entrant.id === 'opencode-1');

      expect(codex?.currentChallengeId).toBe(11);
      // No guess yet: null, so a lane shows nothing rather than a challenge #0.
      expect(opencode?.currentChallengeId).toBeNull();
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

describe('RunManager solve watch', () => {
  function watchedManager() {
    const journal = new EventJournal(':memory:');
    const order: string[] = [];
    const signals: AbortSignal[] = [];
    const driver: EntrantDriver = {
      ...noopDriver,
      async start() {
        order.push('entrant-start');
      },
    };
    const manager = new RunManager(
      journal,
      driver,
      async () => {
        order.push('funding');
      },
      {
        solveWatch: (_run, _entrants, signal) => {
          order.push('solve-watch');
          signals.push(signal);
        },
      },
    );
    return { journal, manager, order, signals };
  }

  it('starts one watch after funding and before the entrants start', async () => {
    const { journal, manager, order, signals } = watchedManager();
    try {
      await manager.create({ preset: 'docker-arena', autoStart: true });

      expect(order).toEqual([
        'funding',
        'solve-watch',
        'entrant-start',
        'entrant-start',
        'entrant-start',
      ]);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
    } finally {
      journal.close();
    }
  });

  it('aborts the watch when the run stops', async () => {
    const { journal, manager, signals } = watchedManager();
    try {
      const { run } = await manager.create({ preset: 'docker-duel', autoStart: true });
      expect(signals[0]?.aborted).toBe(false);

      await manager.stop(run.id);

      expect(signals[0]?.aborted).toBe(true);
    } finally {
      journal.close();
    }
  });

  it('aborts the watch when the run fails to start', async () => {
    const journal = new EventJournal(':memory:');
    const signals: AbortSignal[] = [];
    const failing: EntrantDriver = {
      ...noopDriver,
      async start() {
        throw new Error('entrant refused to start');
      },
    };
    const manager = new RunManager(journal, failing, undefined, {
      solveWatch: (_run, _entrants, signal) => signals.push(signal),
    });
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      await expect(manager.start(run.id)).rejects.toThrow('entrant refused to start');

      expect(signals[0]?.aborted).toBe(true);
    } finally {
      journal.close();
    }
  });

  it('leaves the watch out when no factory is wired', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel', autoStart: true });
      expect(manager.snapshot(run.id).state).toBe('running');
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
  it('waits for a chainless start and surfaces its error when auto-signing is disabled', async () => {
    await withAutoSignDisabled(async () => {
      const journal = new EventJournal(':memory:');
      const driver: EntrantDriver = {
        ...noopDriver,
        async prepare() {
          throw new Error('fake prepare failed');
        },
      };
      const manager = new RunManager(journal, driver);
      try {
        const { run } = await manager.create({ preset: 'fake-duel' });

        await expect(manager.startForRequest(run.id)).rejects.toThrow('fake prepare failed');
        expect(manager.snapshot(run.id).state).toBe('failed');
      } finally {
        journal.close();
      }
    });
  });

  it('starts a chainless run without assigning entrant wallets', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });

      const started = await manager.start(run.id);

      expect(started.state).toBe('running');
      expect(started.entrants.every((entrant) => entrant.address === null)).toBe(true);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned'))
        .toEqual([]);
    } finally {
      journal.close();
    }
  });

  it('assigns derived wallets before driver.prepare', async () => {
    const journal = new EventJournal(':memory:');
    const preparedAddresses: Array<string | null> = [];
    const driver: EntrantDriver = {
      async prepare(run, entrant) {
        expect(run.state).toBe('preparing');
        preparedAddresses.push(entrant.address);
        expect(getWallet(run.id, entrant.id)).not.toBeNull();
      },
      async start() {},
      async steer() {},
      async stop() {},
    };
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      await manager.start(run.id);

      expect(preparedAddresses).toHaveLength(2);
      expect(preparedAddresses.every((address) => address !== null)).toBe(true);
      expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned'))
        .toHaveLength(2);
    } finally {
      journal.close();
    }
  });

  it('rolls back every address and wallet event when one append fails', async () => {
    await withAutoSignDisabled(async () => {
      const journal = new EventJournal(':memory:');
      const manager = new RunManager(journal, noopDriver);
      const published: string[] = [];
      let starting: Promise<unknown> | undefined;
      try {
        const { run } = await manager.create({ preset: 'docker-duel' });
        starting = manager.start(run.id);
        expect(manager.snapshot(run.id).state).toBe('awaiting_signature');
        const signature = await privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY)
          .signTypedData(seedTypedData(run.id, 31337));
        const unsubscribe = journal.subscribe(run.id, (event) => {
          if (event.type === 'wallet.assigned') published.push(event.source);
        });
        journal.database.run(sql`
          CREATE TRIGGER fail_second_wallet_append
          BEFORE INSERT ON events
          WHEN NEW.type = 'wallet.assigned' AND NEW.source = 'opencode-1'
          BEGIN
            SELECT RAISE(FAIL, 'wallet append failed');
          END
        `);

        await expect(manager.submitSeed(run.id, signature)).rejects.toThrow('wallet append failed');

        expect(manager.snapshot(run.id).entrants.every((entrant) => entrant.address === null))
          .toBe(true);
        expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned'))
          .toEqual([]);
        expect(published).toEqual([]);

        journal.database.run(sql`DROP TRIGGER fail_second_wallet_append`);
        await manager.submitSeed(run.id, signature);
        await starting;

        expect(journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned'))
          .toHaveLength(2);
        expect(published.sort()).toEqual(['codex-1', 'opencode-1']);
        unsubscribe();
        await manager.stop(run.id);
      } finally {
        if (starting !== undefined) await starting.catch(() => {});
        journal.close();
      }
    });
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
  it('drops derived keys when a running run stops', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel', autoStart: true });
      expect(getWallet(run.id, 'codex-1')).not.toBeNull();

      await manager.stop(run.id);

      expect(getWallet(run.id, 'codex-1')).toBeNull();
      expect(getWallet(run.id, 'opencode-1')).toBeNull();
    } finally {
      journal.close();
    }
  });

  it('finishes a run stopped while it waits for a seed signature', async () => {
    const previous = process.env.ARENA_AUTO_SIGN;
    process.env.ARENA_AUTO_SIGN = 'false';
    const journal = new EventJournal(':memory:');
    const driver = new BarrierDriver();
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'docker-duel' });
      const startOutcome = manager.start(run.id).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(manager.snapshot(run.id).state).toBe('awaiting_signature');

      const stopped = await manager.stop(run.id);
      const startResult = await startOutcome;

      expect(stopped.state).toBe('finished');
      expect(startResult.ok).toBe(false);
      expect(driver.prepares).toEqual([]);
      expect(getWallet(run.id, 'codex-1')).toBeNull();
      expect(journal.after(run.id, 0).filter((event) => event.type === 'run.state')
        .map((event) => event.payload.state)).toEqual([
        'created',
        'awaiting_signature',
        'stopping',
        'finished',
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.ARENA_AUTO_SIGN;
      } else {
        process.env.ARENA_AUTO_SIGN = previous;
      }
      journal.close();
    }
  });

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

describe('RunManager broadcast', () => {
  it('fans one message into every live entrant and records a single broadcast event', async () => {
    const journal = new EventJournal(':memory:');
    const steers: string[] = [];
    const driver: EntrantDriver = {
      ...noopDriver,
      async steer(_run, entrant, text) {
        if (entrant.id === 'opencode-1') throw new Error('container is gone');
        steers.push(`${entrant.id}:${text}`);
      },
    };
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      await advance(manager, run.id, 'running');
      const result = await manager.broadcast(run.id, 'Ten minutes left.');

      expect(steers).toEqual(['codex-1:Ten minutes left.']);
      expect(result.delivered).toEqual(['codex-1']);
      expect(result.failed).toEqual([{ entrantId: 'opencode-1', message: 'container is gone' }]);

      const events = journal.after(run.id, 0);
      const broadcasts = events.filter((event) => event.type === 'director.broadcast');
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]?.source).toBe('run');
      expect(broadcasts[0]?.payload).toEqual({
        text: 'Ten minutes left.',
        targetEntrantIds: ['codex-1', 'opencode-1'],
      });
      const errors = events.filter((event) => event.type === 'entrant.error');
      expect(errors.map((event) => event.source)).toEqual(['opencode-1']);
      expect(errors[0]?.payload.message).toBe('Broadcast not delivered: container is gone');
    } finally {
      journal.close();
    }
  });

  it('leaves finished entrants out of the fan-out', async () => {
    const journal = new EventJournal(':memory:');
    const steers: string[] = [];
    const driver: EntrantDriver = {
      ...noopDriver,
      async steer(_run, entrant) {
        steers.push(entrant.id);
      },
    };
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      await advance(manager, run.id, 'running');
      journal.database
        .update(entrants)
        .set({ status: 'done' })
        .where(and(eq(entrants.runId, run.id), eq(entrants.id, 'codex-1')))
        .run();

      const result = await manager.broadcast(run.id, 'Wrap up.');

      expect(steers).toEqual(['opencode-1']);
      expect(result.delivered).toEqual(['opencode-1']);
      const broadcast = journal.after(run.id, 0).find((event) => event.type === 'director.broadcast');
      expect(broadcast?.payload.targetEntrantIds).toEqual(['opencode-1']);
    } finally {
      journal.close();
    }
  });

  it('rejects a broadcast to a run that does not exist', async () => {
    const journal = new EventJournal(':memory:');
    const manager = new RunManager(journal, noopDriver);
    try {
      await expect(manager.broadcast('missing-run', 'hello')).rejects.toBeInstanceOf(RunNotFoundError);
    } finally {
      journal.close();
    }
  });

  // Before the opening turn the harness has no session to resume, and the docker
  // driver answers a steer there by degrading the entrant for good. So the gate is
  // load-bearing: nothing may reach the driver until the run is running.
  it.each(['created', 'preparing', 'awaiting_funding', 'ready', 'stopping', 'finished'] as const)(
    'refuses to broadcast to a run in %s and never touches the driver',
    async (state) => {
      const journal = new EventJournal(':memory:');
      const steers: string[] = [];
      const driver: EntrantDriver = {
        ...noopDriver,
        async steer(_run, entrant) {
          steers.push(entrant.id);
        },
      };
      const manager = new RunManager(journal, driver);
      try {
        const { run } = await manager.create({ preset: 'fake-duel' });
        await advance(manager, run.id, state);

        await expect(manager.broadcast(run.id, 'too early')).rejects.toBeInstanceOf(InvalidTransitionError);
        expect(steers).toEqual([]);
        expect(journal.after(run.id, 0).filter((event) => event.type === 'director.broadcast')).toEqual([]);
      } finally {
        journal.close();
      }
    },
  );

  it('records a failed single steer on the lane and keeps the error type', async () => {
    const journal = new EventJournal(':memory:');
    const driver: EntrantDriver = {
      ...noopDriver,
      async steer(_run, entrant) {
        throw new EntrantUnavailableError(`Entrant ${entrant.id} is degraded`);
      },
    };
    const manager = new RunManager(journal, driver);
    try {
      const { run } = await manager.create({ preset: 'fake-duel' });
      await expect(manager.steer(run.id, 'codex-1', 'are you there?'))
        .rejects.toBeInstanceOf(EntrantUnavailableError);

      const errors = journal.after(run.id, 0).filter((event) => event.type === 'entrant.error');
      expect(errors.map((event) => event.payload.message))
        .toEqual(['Steer not delivered: Entrant codex-1 is degraded']);
    } finally {
      journal.close();
    }
  });
});
