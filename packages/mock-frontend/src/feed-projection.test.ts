import { describe, expect, it } from 'vitest';

import type { ArenaEvent, EntrantSummary } from '../../../contract/arena-types';
import {
  deriveLaneWallet,
  deriveWaitingRoom,
  describeEntry,
  describeEvent,
  entriesForSource,
  formatWei,
  gapsForSource,
  ingestEvent,
  initialFeedState,
  isRunLevel,
  RUN_SOURCE,
  truncateAddress,
  type FeedState,
} from './feed-projection';
import { styleForEntry } from './event-style';

// Minimal event builder. Global id and per-source seq are set explicitly so
// tests exercise the exact skip patterns the backend can produce.
function evt(partial: Partial<ArenaEvent> & Pick<ArenaEvent, 'id' | 'source' | 'seq'>): ArenaEvent {
  return {
    runId: 'run-1',
    ts: '2026-07-22T00:00:00.000Z',
    type: 'agent.message',
    payload: { entrantId: partial.source, text: 'hi' },
    ...partial,
  } as ArenaEvent;
}

function feedFrom(events: ArenaEvent[]): FeedState {
  return events.reduce(ingestEvent, initialFeedState());
}

describe('ingestEvent — seq gap detection', () => {
  it('does not flag a global id skip when per-source seq stays contiguous', () => {
    // ids jump 10 → 40 (another run wrote in between) but codex-1 seq is 1,2,3.
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 25, source: 'codex-1', seq: 2 }),
      evt({ id: 40, source: 'codex-1', seq: 3 }),
    ]);
    expect(feed.gaps).toHaveLength(0);
    expect(feed.entries).toHaveLength(3);
  });

  it('flags a real gap when a source seq skips forward', () => {
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 4 }), // seq 2,3 missing
    ]);
    expect(feed.gaps).toEqual([{ source: 'codex-1', from: 1, to: 4 }]);
  });

  it('tracks seq per source independently', () => {
    const feed = feedFrom([
      evt({ id: 1, source: 'codex-1', seq: 1 }),
      evt({ id: 2, source: 'opencode-1', seq: 1 }),
      evt({ id: 3, source: 'codex-1', seq: 2 }),
      evt({ id: 4, source: 'opencode-1', seq: 5 }), // opencode gap
    ]);
    expect(gapsForSource(feed.gaps, 'codex-1')).toHaveLength(0);
    expect(gapsForSource(feed.gaps, 'opencode-1')).toEqual([{ source: 'opencode-1', from: 1, to: 5 }]);
  });
});

describe('ingestEvent — id dedup on replay overlap', () => {
  it('drops a repeated id after reconnect and does not re-count it', () => {
    const first = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }),
    ]);
    // Reconnect replays id 11 (overlap), then continues with 12.
    const after = [
      evt({ id: 11, source: 'codex-1', seq: 2 }),
      evt({ id: 12, source: 'codex-1', seq: 3 }),
    ].reduce(ingestEvent, first);
    expect(after.entries.map((entry) => entry.event.id)).toEqual([10, 11, 12]);
    expect(after.gaps).toHaveLength(0);
  });

  it('returns the same state object for a duplicate so React skips a render', () => {
    const feed = feedFrom([evt({ id: 10, source: 'codex-1', seq: 1 })]);
    const again = ingestEvent(feed, evt({ id: 10, source: 'codex-1', seq: 1 }));
    expect(again).toBe(feed);
  });

  it('a replayed duplicate does not produce a false gap', () => {
    // Contiguous seq, but id 11 replayed out of order after 12 arrived.
    const feed = feedFrom([
      evt({ id: 10, source: 'codex-1', seq: 1 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }),
      evt({ id: 12, source: 'codex-1', seq: 3 }),
      evt({ id: 11, source: 'codex-1', seq: 2 }), // replay overlap
    ]);
    expect(feed.gaps).toHaveLength(0);
    expect(feed.entries).toHaveLength(3);
  });
});

describe('ingestEvent — tool call pairing', () => {
  it('keeps codex command and output details in one paired entry', () => {
    const events = [
      evt({
        id: 10,
        source: 'codex-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'call-1',
          detail: 'echo command-token',
        },
      }),
      evt({
        id: 11,
        source: 'codex-1',
        seq: 2,
        type: 'tool.result',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'call-1',
          ok: true,
          detail: 'output-token',
        },
      }),
    ];
    const feed = feedFrom(events);

    expect(feed.events).toEqual(events);
    expect(feed.entries).toHaveLength(1);
    expect(describeEntry(feed.entries[0]!)).toContain('echo command-token');
    expect(describeEntry(feed.entries[0]!)).toContain('output-token');
  });

  it('pairs back-to-back opencode events and preserves the command', () => {
    const feed = feedFrom([
      evt({
        id: 20,
        source: 'opencode-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'opencode-1',
          tool: 'bash',
          toolCallId: 'tool-1',
          detail: 'forge test',
        },
      }),
      evt({
        id: 21,
        source: 'opencode-1',
        seq: 2,
        type: 'tool.result',
        payload: {
          entrantId: 'opencode-1',
          tool: 'bash',
          toolCallId: 'tool-1',
          ok: true,
          detail: 'tests passed',
        },
      }),
    ]);

    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.event.payload).toMatchObject({ detail: 'forge test' });
    expect(styleForEntry(feed.entries[0]!)).toEqual({ tone: 'tool', tag: 'ok' });
  });

  it('marks a subagent call and pairs it with its own result', () => {
    const feed = feedFrom([
      evt({
        id: 25,
        source: 'claude-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'claude-1',
          tool: 'Task',
          toolCallId: 'task-1',
          detail: 'audit the challenge',
        },
      }),
      evt({
        id: 26,
        source: 'claude-1',
        seq: 2,
        type: 'tool.call',
        payload: {
          entrantId: 'claude-1',
          tool: 'Bash',
          toolCallId: 'nested-1',
          detail: 'cast call',
          parentToolCallId: 'task-1',
        },
      }),
      evt({
        id: 27,
        source: 'claude-1',
        seq: 3,
        type: 'tool.result',
        payload: {
          entrantId: 'claude-1',
          tool: 'Bash',
          toolCallId: 'nested-1',
          ok: true,
          detail: '0x01',
          parentToolCallId: 'task-1',
        },
      }),
    ]);

    expect(feed.entries).toHaveLength(2);
    expect(describeEntry(feed.entries[0]!)).toBe('Task → running: audit the challenge');
    expect(describeEntry(feed.entries[1]!)).toBe('↳ subagent Bash → ok: cast call ⇒ 0x01');
  });

  it('pairs a reused id with the latest unresolved call', () => {
    const feed = feedFrom([
      evt({
        id: 30,
        source: 'codex-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'item_2',
          detail: 'old command',
        },
      }),
      evt({
        id: 31,
        source: 'codex-1',
        seq: 2,
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'item_2',
          detail: 'new command',
        },
      }),
      evt({
        id: 32,
        source: 'codex-1',
        seq: 3,
        type: 'tool.result',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'item_2',
          ok: true,
          detail: 'new output',
        },
      }),
    ]);

    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]!.result).toBeUndefined();
    expect(styleForEntry(feed.entries[0]!)).toEqual({ tone: 'tool', tag: 'running' });
    expect(feed.entries[1]!.result).toMatchObject({
      type: 'tool.result',
      payload: { detail: 'new output' },
    });
    expect(describeEntry(feed.entries[1]!)).toContain('new command');
  });

  it('keeps a duplicate result for a resolved id as a standalone entry', () => {
    const feed = feedFrom([
      evt({
        id: 40,
        source: 'codex-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'call-1',
          detail: 'pwd',
        },
      }),
      evt({
        id: 41,
        source: 'codex-1',
        seq: 2,
        type: 'tool.result',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'call-1',
          ok: true,
          detail: '/repo',
        },
      }),
      evt({
        id: 42,
        source: 'codex-1',
        seq: 3,
        type: 'tool.result',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'call-1',
          ok: true,
          detail: '/repo again',
        },
      }),
    ]);

    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]!.result?.id).toBe(41);
    expect(feed.entries[1]).toEqual({ event: expect.objectContaining({ id: 42, type: 'tool.result' }) });
  });

  it('keeps an unmatched replay result as a standalone entry', () => {
    const result = evt({
      id: 20,
      source: 'codex-1',
      seq: 1,
      type: 'tool.result',
      payload: {
        entrantId: 'codex-1',
        tool: 'bash',
        toolCallId: 'missing-call',
        ok: false,
        detail: 'failed',
      },
    });

    expect(feedFrom([result]).entries).toEqual([{ event: result }]);
  });

  it('does not pair equal synthetic ids from different sources', () => {
    const feed = feedFrom([
      evt({
        id: 30,
        source: 'codex-1',
        seq: 1,
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'bash',
          toolCallId: 'synthetic-1',
          detail: 'pwd',
        },
      }),
      evt({
        id: 31,
        source: 'opencode-1',
        seq: 1,
        type: 'tool.result',
        payload: {
          entrantId: 'opencode-1',
          tool: 'bash',
          toolCallId: 'synthetic-1',
          ok: true,
          detail: '/repo',
        },
      }),
    ]);

    expect(feed.entries).toHaveLength(2);
  });
});

describe('event → lane routing', () => {
  const events: ArenaEvent[] = [
    { id: 1, runId: 'run-1', source: RUN_SOURCE, seq: 1, ts: 'now', type: 'run.state', payload: { state: 'running' } },
    evt({ id: 2, source: 'codex-1', seq: 1 }),
    evt({ id: 3, source: 'opencode-1', seq: 1 }),
    evt({ id: 4, source: 'codex-1', seq: 2 }),
  ];
  const entries = events.map((event) => ({ event }));

  it('routes each entrant source to its own lane', () => {
    expect(entriesForSource(entries, 'codex-1').map((entry) => entry.event.id)).toEqual([2, 4]);
    expect(entriesForSource(entries, 'opencode-1').map((entry) => entry.event.id)).toEqual([3]);
  });

  it('routes run-source events to the run lane only', () => {
    expect(entriesForSource(entries, RUN_SOURCE).map((entry) => entry.event.id)).toEqual([1]);
    expect(isRunLevel(events[0]!)).toBe(true);
    expect(isRunLevel(events[1]!)).toBe(false);
  });
});

describe('describeEvent — all 16 contract types render', () => {
  const base = { id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now' };
  const samples: ArenaEvent[] = [
    { ...base, source: RUN_SOURCE, type: 'run.state', payload: { state: 'running' } },
    { ...base, type: 'entrant.status', payload: { entrantId: 'codex-1', status: 'working' } },
    { ...base, type: 'agent.message', payload: { entrantId: 'codex-1', text: 'hi' } },
    { ...base, type: 'agent.reasoning', payload: { entrantId: 'codex-1', text: 'thinking' } },
    { ...base, type: 'tool.call', payload: { entrantId: 'codex-1', tool: 'bash', toolCallId: 'call-1', detail: 'ls' } },
    { ...base, type: 'tool.result', payload: { entrantId: 'codex-1', tool: 'bash', toolCallId: 'call-1', ok: true, detail: 'ok' } },
    { ...base, type: 'entrant.steered', payload: { entrantId: 'codex-1', text: 'go' } },
    { ...base, type: 'entrant.prompt', payload: { entrantId: 'codex-1', text: 'begin' } },
    { ...base, type: 'entrant.nudged', payload: { entrantId: 'codex-1', text: 'nudge', flags: 1 } },
    { ...base, source: RUN_SOURCE, type: 'director.broadcast', payload: { text: 'wrap up', targetEntrantIds: ['codex-1', 'opencode-1'] } },
    { ...base, type: 'wallet.assigned', payload: { entrantId: 'codex-1', address: '0xabc' } },
    { ...base, type: 'funding.balance', payload: { entrantId: 'codex-1', address: '0xabc', wei: '100', funded: true } },
    { ...base, type: 'score.flag', payload: { entrantId: 'codex-1', challengeId: 1, txHash: '0xtx', tokenId: '7' } },
    { ...base, type: 'entrant.error', payload: { entrantId: 'codex-1', message: 'boom' } },
    { ...base, source: RUN_SOURCE, type: 'run.error', payload: { message: 'fatal' } },
    { ...base, type: 'usage', payload: { entrantId: 'codex-1', inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, costUsd: 0.001 } },
  ];

  it('covers every contract event type', () => {
    expect(samples).toHaveLength(16);
  });

  it('renders a non-empty summary for each without throwing', () => {
    for (const event of samples) {
      const line = describeEvent(event);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('renders tool states as running, ok, and fail', () => {
    const call = samples.find((event) => event.type === 'tool.call');
    const result = samples.find((event) => event.type === 'tool.result');
    if (call === undefined || result === undefined || result.type !== 'tool.result') {
      throw new Error('tool samples missing');
    }
    const failed = { ...result, payload: { ...result.payload, ok: false } };

    expect(describeEvent(call)).toContain('running');
    expect(describeEvent(result)).toContain('ok');
    expect(describeEvent(failed)).toContain('fail');
  });

  // A missing case still renders through rawFallback, so assert the shaped line.
  it('names the entrant count and the text on a director broadcast', () => {
    const broadcast = samples.find((event) => event.type === 'director.broadcast');
    expect(broadcast && describeEvent(broadcast)).toBe('broadcast (2 entrants): wrap up');
  });

  it('falls back to a raw payload dump for an unknown-to-the-UI type', () => {
    const unknown = { ...base, type: 'future.type', payload: { foo: 'bar' } } as unknown as ArenaEvent;
    const line = describeEvent(unknown);
    expect(line).toContain('future.type');
    expect(line).toContain('foo');
  });
});

describe('truncateAddress', () => {
  it('middle-truncates a full hex address', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });

  it('leaves a string too short to truncate unchanged', () => {
    expect(truncateAddress('0x1234abcd')).toBe('0x1234abcd');
  });
});

describe('formatWei', () => {
  it('formats one ether as a whole number', () => {
    expect(formatWei('1000000000000000000')).toBe('1');
  });

  it('formats a fractional balance and trims trailing zeros', () => {
    expect(formatWei('500000000000000000')).toBe('0.5');
  });

  it('caps at four decimal places (truncates, does not round)', () => {
    expect(formatWei('123450000000000000')).toBe('0.1234');
  });

  it('formats zero and sub-0.0001 dust as 0', () => {
    expect(formatWei('0')).toBe('0');
    expect(formatWei('100')).toBe('0');
  });

  it('handles balances above one ether', () => {
    expect(formatWei('12500000000000000000')).toBe('12.5');
  });
});

describe('deriveLaneWallet', () => {
  const base = { id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now' };

  it('falls back to the snapshot address when no wallet events arrived', () => {
    expect(deriveLaneWallet([], '0xsnapshot', 'preparing')).toEqual({
      address: '0xsnapshot',
      wei: null,
      funded: false,
      awaitingFunds: false,
    });
  });

  it('marks awaiting funds while the run awaits funding and the lane is unfunded', () => {
    const wallet = deriveLaneWallet([], '0xsnapshot', 'awaiting_funding');
    expect(wallet.awaitingFunds).toBe(true);
  });

  it('takes the address from a wallet.assigned event over the snapshot', () => {
    const events: ArenaEvent[] = [
      { ...base, type: 'wallet.assigned', payload: { entrantId: 'codex-1', address: '0xassigned' } },
    ];
    expect(deriveLaneWallet(events, null, 'preparing').address).toBe('0xassigned');
  });

  it('uses the latest funding.balance for wei and funded, and stops awaiting once funded', () => {
    const events: ArenaEvent[] = [
      { ...base, id: 1, seq: 1, type: 'funding.balance', payload: { entrantId: 'codex-1', address: '0xw', wei: '10', funded: false } },
      { ...base, id: 2, seq: 2, type: 'funding.balance', payload: { entrantId: 'codex-1', address: '0xw', wei: '1000000000000000000', funded: true } },
    ];
    const wallet = deriveLaneWallet(events, null, 'awaiting_funding');
    expect(wallet).toEqual({ address: '0xw', wei: '1000000000000000000', funded: true, awaitingFunds: false });
  });
});

describe('deriveWaitingRoom', () => {
  const base = { id: 1, runId: 'run-1', seq: 1, ts: 'now' };

  function entrant(id: string, address: string | null): EntrantSummary {
    return {
      id,
      harness: 'codex',
      model: 'gpt-5',
      address,
      status: 'idle',
      flags: 0,
      solves: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    };
  }

  it('marks every entrant pending before the seed signature derives an address', () => {
    const roster = deriveWaitingRoom(
      [entrant('codex-1', null), entrant('opencode-1', null)],
      [],
      'awaiting_signature',
    );
    expect(roster.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(roster.map((row) => row.address)).toEqual([null, null]);
  });

  it('picks up the address from wallet.assigned and reports the lane as waiting', () => {
    const events: ArenaEvent[] = [
      { ...base, source: 'codex-1', type: 'wallet.assigned', payload: { entrantId: 'codex-1', address: '0xcodex' } },
    ];
    const roster = deriveWaitingRoom(
      [entrant('codex-1', null)],
      events.map((event) => ({ event })),
      'awaiting_funding',
    );
    expect(roster[0]).toEqual({
      entrantId: 'codex-1',
      harness: 'codex',
      address: '0xcodex',
      wei: null,
      funded: false,
      status: 'waiting',
    });
  });

  it('tracks each entrant separately, so one funded lane does not cover the other', () => {
    const events: ArenaEvent[] = [
      { ...base, id: 1, source: 'codex-1', type: 'funding.balance', payload: { entrantId: 'codex-1', address: '0xcodex', wei: '50000000000000000', funded: true } },
      { ...base, id: 2, source: 'opencode-1', type: 'funding.balance', payload: { entrantId: 'opencode-1', address: '0xopen', wei: '1000', funded: false } },
    ];
    const roster = deriveWaitingRoom(
      [entrant('codex-1', '0xcodex'), entrant('opencode-1', '0xopen')],
      events.map((event) => ({ event })),
      'awaiting_funding',
    );
    expect(roster.map((row) => row.status)).toEqual(['funded', 'waiting']);
    expect(roster[0]!.wei).toBe('50000000000000000');
    expect(roster[1]!.wei).toBe('1000');
  });

  it('keeps the entrant order the snapshot gave it', () => {
    const roster = deriveWaitingRoom(
      [entrant('opencode-1', '0xopen'), entrant('codex-1', '0xcodex')],
      [],
      'awaiting_funding',
    );
    expect(roster.map((row) => row.entrantId)).toEqual(['opencode-1', 'codex-1']);
  });
});
