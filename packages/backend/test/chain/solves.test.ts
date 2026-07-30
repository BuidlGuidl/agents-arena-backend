import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChainProfile } from '../../src/chain/profile.js';
import { CHALLENGE_IDS, SolvePoller } from '../../src/chain/solve-poller.js';
import { createWallet } from '../../src/chain/wallet.js';
import { EventJournal } from '../../src/journal.js';
import {
  deployFlagFixture,
  mintFlag,
  MULTICALL3_ADDRESS,
  startAnvil,
  startRpcProxy,
  testProfile,
  withMulticall3,
  type AnvilHandle,
} from './support.js';

const CONFIRMATIONS = 2;

interface ScoreEvent {
  entrantId: string;
  challengeId: number;
  txHash: string;
  tokenId: string;
}

describe('solve poller', () => {
  let anvil: AnvilHandle;
  let contract: Address;
  let profile: ChainProfile;
  // cacheTime 0 so each poll reads a fresh head after anvil_mine (no 4s viem cache).
  let client: PublicClient;

  beforeAll(async () => {
    anvil = await startAnvil();
    contract = await deployFlagFixture(anvil);
    profile = testProfile(anvil.rpcUrl, CONFIRMATIONS, contract);
    client = createPublicClient({ transport: http(anvil.rpcUrl), cacheTime: 0 });
  }, 60_000);

  afterAll(async () => {
    await anvil.stop();
  });

  function poller(journal: EventJournal, runId: string, pollMs?: number): SolvePoller {
    return new SolvePoller({
      profile,
      runId,
      journal,
      database: journal.database,
      client,
      ...(pollMs === undefined ? {} : { pollMs }),
    });
  }

  function scoreEvents(journal: EventJournal, runId: string): ScoreEvent[] {
    return journal
      .after(runId, 0)
      .filter((event) => event.type === 'score.flag')
      .map((event) => event.payload as unknown as ScoreEvent);
  }

  function runErrors(journal: EventJournal, runId: string): { message: string }[] {
    return journal
      .after(runId, 0)
      .filter((event) => event.type === 'run.error')
      .map((event) => event.payload as unknown as { message: string });
  }

  function multicallCalls(proxy: { bodies: unknown[] }): { method: string }[] {
    return proxy.bodies
      .flatMap((body) => (Array.isArray(body) ? body : [body]) as { method: string; params?: unknown[] }[])
      .filter((entry) => {
        if (entry.method !== 'eth_call') return false;
        const [call] = (entry.params ?? []) as [{ to?: string }];
        return call?.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase();
      });
  }

  it('records nothing until the pair is confirmation-deep, then exactly one solve', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-confirm';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const poll = poller(journal, runId);

      await mintFlag(anvil, contract, address, 3n);
      expect(await poll.pollOnce()).toBe(0);
      expect(scoreEvents(journal, runId)).toHaveLength(0);

      await anvil.mine(CONFIRMATIONS);
      expect(await poll.pollOnce()).toBe(1);

      const events = scoreEvents(journal, runId);
      expect(events).toHaveLength(1);
      expect(events[0]?.entrantId).toBe('e1');
      expect(events[0]?.challengeId).toBe(3);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('does not record the same pair on a later poll', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-repeat';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const poll = poller(journal, runId);

      await mintFlag(anvil, contract, address, 3n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poll.pollOnce()).toBe(1);

      // A distinct on-chain log (new tokenId) against a pair that already scored.
      await mintFlag(anvil, contract, address, 3n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poll.pollOnce()).toBe(0);
      expect(await poll.pollOnce()).toBe(0);

      expect(scoreEvents(journal, runId)).toHaveLength(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('ignores a mint by an address that is not an entrant wallet', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-stranger';
    try {
      createWallet(runId, 'e1', journal.database);
      const poll = poller(journal, runId);
      const stranger = '0x00000000000000000000000000000000deadbeef' as Address;

      await mintFlag(anvil, contract, stranger, 4n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poll.pollOnce()).toBe(0);

      expect(scoreEvents(journal, runId)).toHaveLength(0);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('reads a block from before NFTFlags was deployed as no solves', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-predeploy';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 6n);

      // A chain started minutes ago puts head - confirmations before the deploy, where
      // the call returns no data. A depth of the whole chain forces that block.
      const head = await client.getBlockNumber();
      const deep = new SolvePoller({
        profile: testProfile(anvil.rpcUrl, Number(head), contract),
        runId,
        journal,
        database: journal.database,
        client,
      });

      expect(await deep.pollOnce()).toBe(0);
      expect(scoreEvents(journal, runId)).toHaveLength(0);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('recovers the txHash and tokenId of the mint that set the flag', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-recover';
    try {
      const address = createWallet(runId, 'e1', journal.database);

      // Three logs for one minter. The earliest belongs to another challenge, so a
      // recovery that filtered on minter alone would report it. Of the two that do
      // belong to challenge 5, hasMinted turned true on the first.
      const otherChallenge = await mintFlag(anvil, contract, address, 8n);
      const first = await mintFlag(anvil, contract, address, 5n);
      const second = await mintFlag(anvil, contract, address, 5n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poller(journal, runId).pollOnce()).toBe(2);

      const five = scoreEvents(journal, runId).find((event) => event.challengeId === 5);
      expect(five?.txHash).toBe(first.txHash);
      expect(five?.tokenId).toBe(first.tokenId.toString());
      expect(five?.txHash).not.toBe(second.txHash);
      expect(five?.txHash).not.toBe(otherChallenge.txHash);

      const eight = scoreEvents(journal, runId).find((event) => event.challengeId === 8);
      expect(eight?.txHash).toBe(otherChallenge.txHash);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('journals two solves found in one poll in chain order, not poll order', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-order';
    try {
      const address = createWallet(runId, 'e1', journal.database);

      // The poll walks challenge ids ascending, so it meets 2 before 9. The chain
      // saw 9 first, and that is the order the journal must carry.
      await mintFlag(anvil, contract, address, 9n);
      await mintFlag(anvil, contract, address, 2n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poller(journal, runId).pollOnce()).toBe(2);

      expect(scoreEvents(journal, runId).map((event) => event.challengeId)).toEqual([9, 2]);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('a restarted poller recovers a solve it never saw and skips the ones already scored', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-restart';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 7n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poller(journal, runId).pollOnce()).toBe(1);

      // The mint that lands while nothing is polling is the case a cursor used to
      // cover. A replacement poller has to find it by reading state, and has to leave
      // the already-scored pair alone.
      const missed = await mintFlag(anvil, contract, address, 4n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poller(journal, runId).pollOnce()).toBe(1);

      const events = scoreEvents(journal, runId);
      expect(events.map((event) => event.challengeId)).toEqual([7, 4]);
      expect(events[1]?.txHash).toBe(missed.txHash);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('batches the tick reads without exceeding what Base accepts in one request', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-batch';
    const proxy = await startRpcProxy(anvil.rpcUrl);
    try {
      createWallet(runId, 'e1', journal.database);
      createWallet(runId, 'e2', journal.database);
      const batching = new SolvePoller({
        profile: testProfile(proxy.url, CONFIRMATIONS, contract),
        runId,
        journal,
        database: journal.database,
      });

      await anvil.mine(CONFIRMATIONS);
      expect(await batching.pollOnce()).toBe(0);

      const callBodies = proxy.bodies.filter(
        (body): body is { method: string }[] =>
          Array.isArray(body) && body.every((entry) => (entry as { method: string }).method === 'eth_call'),
      );
      const reads = 2 * CHALLENGE_IDS.length;
      // mainnet.base.org answers -32014 above ten calls per batch, so the tick's reads
      // are grouped rather than sent as one request or as one request each.
      expect(callBodies.every((body) => body.length <= 10)).toBe(true);
      expect(callBodies.reduce((total, body) => total + body.length, 0)).toBe(reads);
      expect(callBodies).toHaveLength(Math.ceil(reads / 10));
    } finally {
      await proxy.stop();
      journal.close();
    }
  }, 30_000);

  it('does not journal a solve found by a tick that was already aborted', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-late-tick';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 10n);
      await anvil.mine(CONFIRMATIONS);

      // The run stopped while this tick was mid-flight. A score.flag written now would
      // land after the run's own finished event.
      const controller = new AbortController();
      controller.abort();
      expect(await poller(journal, runId).pollOnce(controller.signal)).toBe(0);
      expect(scoreEvents(journal, runId)).toHaveLength(0);

      // Nothing was consumed: a later poller still finds and records it.
      expect(await poller(journal, runId).pollOnce()).toBe(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('aggregates the tick into one call where the chain has Multicall3', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-multicall';
    const proxy = await startRpcProxy(anvil.rpcUrl);
    try {
      const address = createWallet(runId, 'e1', journal.database);
      createWallet(runId, 'e2', journal.database);
      await mintFlag(anvil, contract, address, 6n);

      await withMulticall3(anvil, async () => {
        // The reads execute at head - confirmations, so the injected code has to be that
        // deep as well. On base Multicall3 predates every run, so this only sets up here.
        await anvil.mine(CONFIRMATIONS + 1);
        const aggregating = new SolvePoller({
          profile: testProfile(proxy.url, CONFIRMATIONS, contract),
          runId,
          journal,
          database: journal.database,
        });
        expect(await aggregating.pollOnce()).toBe(1);
      });

      const calls = proxy.bodies
        .flatMap((body) => (Array.isArray(body) ? body : [body]) as { method: string; params?: unknown[] }[])
        .filter((entry) => entry.method === 'eth_call');
      const toMulticall = multicallCalls(proxy);

      // Two entrants across twelve challenges is 24 reads, which the fallback path sends
      // as three batched requests. Aggregated it is one call whatever the entrant count.
      expect(toMulticall).toHaveLength(1);
      expect(calls).toHaveLength(toMulticall.length);

      const [event] = scoreEvents(journal, runId);
      expect(event?.entrantId).toBe('e1');
      expect(event?.challengeId).toBe(6);
    } finally {
      await proxy.stop();
      journal.close();
    }
  }, 30_000);

  it('falls back to per-pair reads once Multicall3 is gone again', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-no-multicall';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 12n);
      await anvil.mine(CONFIRMATIONS);

      // withMulticall3 clears the code again, so the probe has to see a bare chain here.
      // This is the path local dev runs on, since neither anvil nor hardhat deploys it.
      expect(await poller(journal, runId).pollOnce()).toBe(1);
      expect(scoreEvents(journal, runId).map((event) => event.challengeId)).toEqual([12]);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('journals one run.error once polling keeps failing, and stops after recovery', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-dead-rpc';
    try {
      createWallet(runId, 'e1', journal.database);
      const dead = new SolvePoller({
        // Nothing listens here, so every tick throws the way a wrong address on base would.
        profile: testProfile('http://127.0.0.1:1', CONFIRMATIONS, contract),
        runId,
        journal,
        database: journal.database,
        pollMs: 10,
      });

      const controller = new AbortController();
      const loop = dead.watch(controller.signal);
      await waitFor(() => runErrors(journal, runId).length === 1, 10_000);
      // Well past the three-tick threshold: a repeating failure must not repeat the event.
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();
      await loop;

      expect(runErrors(journal, runId)).toHaveLength(1);
      expect(runErrors(journal, runId)[0]?.message).toContain('solve poll failed');
      expect(scoreEvents(journal, runId)).toHaveLength(0);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('journals run.error when hasMinted is true but the mint log is out of range', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-stuck-pair';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const mint = await mintFlag(anvil, contract, address, 8n);
      await anvil.mine(CONFIRMATIONS + 2);

      // Starting the search past the mint is what a >10,000 block gap looks like from
      // inside recoverCapture: the pair reads true and no log explains it.
      const stuck = new SolvePoller({
        profile,
        runId,
        journal,
        database: journal.database,
        client,
        fromBlock: mint.blockNumber + 1n,
      });

      expect(await stuck.pollOnce()).toBe(0);
      expect(await stuck.pollOnce()).toBe(0);

      const errors = runErrors(journal, runId);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('challenge 8');
      expect(scoreEvents(journal, runId)).toHaveLength(0);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('retries the Multicall3 probe after a failed one instead of caching the slow path', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-probe-retry';
    const proxy = await startRpcProxy(anvil.rpcUrl);
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 9n);

      await withMulticall3(anvil, async () => {
        await anvil.mine(CONFIRMATIONS + 1);
        let blips = 1;
        const flaky = new Proxy(
          createPublicClient({ transport: http(proxy.url), cacheTime: 0 }),
          {
            get(target, property, receiver) {
              if (property !== 'getCode') {
                return Reflect.get(target, property, receiver) as unknown;
              }
              return async (args: { address: Address; blockNumber?: bigint }) => {
                if (blips > 0) {
                  blips -= 1;
                  throw new Error('rpc blip');
                }
                return target.getCode(args);
              };
            },
          },
        ) as PublicClient;

        const retrying = new SolvePoller({
          profile: testProfile(proxy.url, CONFIRMATIONS, contract),
          runId,
          journal,
          database: journal.database,
          client: flaky,
        });

        // First tick's probe throws, so it reads pair by pair and still scores.
        expect(await retrying.pollOnce()).toBe(1);
        expect(multicallCalls(proxy)).toHaveLength(0);

        // Second tick probes again rather than trusting the blip for the whole run.
        await mintFlag(anvil, contract, address, 10n);
        await anvil.mine(CONFIRMATIONS + 1);
        expect(await retrying.pollOnce()).toBe(1);
        expect(multicallCalls(proxy)).toHaveLength(1);
      });
    } finally {
      await proxy.stop();
      journal.close();
    }
  }, 30_000);

  it('watch() records while it runs and resolves once the run signal aborts', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-watch';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      const controller = new AbortController();
      const loop = poller(journal, runId, 20).watch(controller.signal);

      await mintFlag(anvil, contract, address, 11n);
      await anvil.mine(CONFIRMATIONS);
      await waitFor(() => scoreEvents(journal, runId).length === 1, 5_000);

      controller.abort();
      await loop;

      const before = scoreEvents(journal, runId).length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(scoreEvents(journal, runId)).toHaveLength(before);
      expect(before).toBe(1);
    } finally {
      journal.close();
    }
  }, 30_000);
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition did not hold in time');
}
