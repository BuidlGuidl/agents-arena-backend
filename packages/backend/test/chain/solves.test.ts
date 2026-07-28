import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChainProfile } from '../../src/chain/profile.js';
import { CHALLENGE_IDS, SolvePoller } from '../../src/chain/solve-poller.js';
import { createWallet } from '../../src/chain/wallet.js';
import { EventJournal } from '../../src/journal.js';
import {
  deployFlagFixture,
  mintFlag,
  startAnvil,
  startRpcProxy,
  testProfile,
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

  it('a restarted poller on the same database does not re-record past solves', async () => {
    const journal = new EventJournal(':memory:');
    const runId = 'run-restart';
    try {
      const address = createWallet(runId, 'e1', journal.database);
      await mintFlag(anvil, contract, address, 7n);
      await anvil.mine(CONFIRMATIONS);
      expect(await poller(journal, runId).pollOnce()).toBe(1);

      // Restart: a brand-new poller with no memory of the tick that scored.
      expect(await poller(journal, runId).pollOnce()).toBe(0);

      expect(scoreEvents(journal, runId)).toHaveLength(1);
    } finally {
      journal.close();
    }
  }, 30_000);

  it('reads every pending pair in one batched request', async () => {
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
      expect(callBodies).toHaveLength(1);
      expect(callBodies[0]).toHaveLength(2 * CHALLENGE_IDS.length);
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
