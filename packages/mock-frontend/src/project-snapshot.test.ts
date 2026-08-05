import { describe, expect, it } from 'vitest';

import type { ArenaEvent, RunSnapshot } from '../../../contract/arena-types';
import { projectSnapshot } from './project-snapshot';

const snapshot: RunSnapshot = {
  id: 'run-1',
  state: 'created',
  preset: 'fake-duel',
  chainId: 31337,
  entrants: [
    {
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5-codex',
      address: null,
      status: 'idle',
      flags: 0,
      solves: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      currentChallengeId: null,
    },
  ],
  startedAt: null,
  deadlineAt: null,
  lastEventId: 1,
};

describe('projectSnapshot', () => {
  it('projects run state events', () => {
    const event: ArenaEvent = {
      id: 2,
      runId: 'run-1',
      source: 'run',
      seq: 2,
      ts: '2026-07-22T00:00:00.000Z',
      type: 'run.state',
      payload: { state: 'preparing' },
    };

    expect(projectSnapshot(snapshot, event)).toMatchObject({ state: 'preparing', lastEventId: 2 });
  });

  it('projects entrant status events', () => {
    const event: ArenaEvent = {
      id: 3,
      runId: 'run-1',
      source: 'codex-1',
      seq: 1,
      ts: '2026-07-22T00:00:01.000Z',
      type: 'entrant.status',
      payload: { entrantId: 'codex-1', status: 'working' },
    };

    expect(projectSnapshot(snapshot, event)?.entrants[0]?.status).toBe('working');
  });

  it('ignores replayed events already covered by the snapshot', () => {
    const replayed: ArenaEvent = {
      id: 1,
      runId: 'run-1',
      source: 'chain:flags',
      seq: 1,
      ts: '2026-07-22T00:00:00.000Z',
      type: 'score.flag',
      payload: { entrantId: 'codex-1', challengeId: 3, txHash: '0xabc', tokenId: '1' },
    };

    expect(projectSnapshot(snapshot, replayed)).toBe(snapshot);
  });

  it('adds usage events to the entrant totals', () => {
    const priced: ArenaEvent = {
      id: 5,
      runId: 'run-1',
      source: 'codex-1',
      seq: 2,
      ts: '2026-07-22T00:00:03.000Z',
      type: 'usage',
      payload: { entrantId: 'codex-1', inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, costUsd: 0.002 },
    };
    const unpriced: ArenaEvent = { ...priced, id: 6, seq: 3, payload: { ...priced.payload, costUsd: null } };

    const once = projectSnapshot(snapshot, priced);
    const twice = projectSnapshot(once, unpriced);

    expect(once?.entrants[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.002 });
    // The unpriced turn still adds tokens; cost holds at what the priced turn cost.
    expect(twice?.entrants[0]).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 0.002 });
  });

  it('leaves cost null while every usage event is unpriced', () => {
    const event: ArenaEvent = {
      id: 5,
      runId: 'run-1',
      source: 'codex-1',
      seq: 2,
      ts: '2026-07-22T00:00:03.000Z',
      type: 'usage',
      payload: { entrantId: 'codex-1', inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, costUsd: null },
    };

    expect(projectSnapshot(snapshot, event)?.entrants[0]).toMatchObject({ inputTokens: 100, costUsd: null });
  });

  it('moves the current challenge with entrant.challenge events', () => {
    const event: ArenaEvent = {
      id: 5,
      runId: 'run-1',
      source: 'codex-1',
      seq: 2,
      ts: '2026-07-22T00:00:03.000Z',
      type: 'entrant.challenge',
      payload: { entrantId: 'codex-1', challengeId: 3, via: 'command', evidence: 'Challenge3' },
    };
    const next: ArenaEvent = {
      ...event,
      id: 6,
      seq: 3,
      payload: { entrantId: 'codex-1', challengeId: 11, via: 'self', evidence: 'announced' },
    };

    const once = projectSnapshot(snapshot, event);
    expect(once?.entrants[0]?.currentChallengeId).toBe(3);
    // Latest guess wins: the value overwrites, it never accumulates.
    expect(projectSnapshot(once, next)?.entrants[0]?.currentChallengeId).toBe(11);
  });

  it('projects score.flag events into flags and solves', () => {
    const event: ArenaEvent = {
      id: 4,
      runId: 'run-1',
      source: 'chain:flags',
      seq: 1,
      ts: '2026-07-22T00:00:02.000Z',
      type: 'score.flag',
      payload: { entrantId: 'codex-1', challengeId: 3, txHash: '0xabc', tokenId: '1' },
    };

    const projected = projectSnapshot(snapshot, event)?.entrants[0];
    expect(projected?.flags).toBe(1);
    expect(projected?.solves).toEqual([
      { challengeId: 3, ts: '2026-07-22T00:00:02.000Z', txHash: '0xabc' },
    ]);
  });
});
