import { describe, expect, it } from 'vitest';

import type { ArenaEvent } from '../src/contract.js';
import { EVENT_TEXT_LIMIT, EventJournal } from '../src/journal.js';

describe('EventJournal', () => {
  it('assigns global IDs and per-source sequences', () => {
    const journal = new EventJournal(':memory:');
    try {
      const first = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'one',
      });
      const second = journal.append('run-1', 'opencode-1', 'agent.message', {
        entrantId: 'opencode-1',
        text: 'two',
      });
      const third = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'three',
      });

      expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
      expect([first.seq, second.seq, third.seq]).toEqual([1, 1, 2]);
    } finally {
      journal.close();
    }
  });

  it('replays the exact events after an ID', () => {
    const journal = new EventJournal(':memory:');
    try {
      journal.append('run-1', 'run', 'run.state', { state: 'created' });
      const second = journal.append('run-1', 'run', 'run.state', { state: 'preparing' });
      const otherRun = journal.append('run-2', 'run', 'run.state', { state: 'created' });
      const fourth = journal.append('run-1', 'run', 'run.state', { state: 'awaiting_funding' });

      expect(journal.after('run-1', 1)).toEqual([second, fourth]);
      expect(journal.after('run-1', otherRun.id)).toEqual([fourth]);
    } finally {
      journal.close();
    }
  });

  it('keeps each source sequence monotonic across concurrent callers', async () => {
    const journal = new EventJournal(':memory:');
    try {
      await Promise.all(Array.from({ length: 40 }, async (_, index) => {
        await Promise.resolve();
        const entrantId = index % 2 === 0 ? 'codex-1' : 'opencode-1';
        journal.append('run-1', entrantId, 'agent.message', {
          entrantId,
          text: String(index),
        });
      }));

      const events = journal.after('run-1', 0);
      expect(events.map((event) => event.id)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      for (const source of ['codex-1', 'opencode-1']) {
        expect(events.filter((event) => event.source === source).map((event) => event.seq))
          .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      }
    } finally {
      journal.close();
    }
  });

  it('returns the newest page in ascending order', () => {
    const journal = new EventJournal(':memory:');
    try {
      const appended = Array.from({ length: 5 }, (_, index) =>
        journal.append('run-1', 'run', 'run.state', {
          state: index % 2 === 0 ? 'created' : 'preparing',
        }));

      expect(journal.history('run-1', { limit: 3 })).toEqual({
        events: appended.slice(2),
        lastEventId: appended[4]?.id,
        hasMore: true,
      });
    } finally {
      journal.close();
    }
  });

  // 1e21 is an integer but not a safe one, and SQLite rejects it as a LIMIT.
  it.each([0, -2, 2.5, 1e21])('rejects a history limit of %i', (limit) => {
    const journal = new EventJournal(':memory:');
    try {
      expect(() => journal.history('run-1', { limit })).toThrow(RangeError);
    } finally {
      journal.close();
    }
  });

  it('walks backward without gaps or duplicate boundary events', () => {
    const journal = new EventJournal(':memory:');
    try {
      const appended = Array.from({ length: 7 }, (_, index) =>
        journal.append('run-1', 'codex-1', 'agent.message', {
          entrantId: 'codex-1',
          text: String(index + 1),
        }));
      const pages: ArenaEvent[][] = [];
      const hasMore: boolean[] = [];
      let before: number | undefined;

      do {
        const page = journal.history('run-1', {
          limit: 3,
          ...(before === undefined ? {} : { before }),
        });
        pages.unshift(page.events);
        hasMore.push(page.hasMore);
        before = page.events[0]?.id;
      } while (hasMore.at(-1));

      expect(pages.flat()).toEqual(appended);
      expect(hasMore).toEqual([true, true, false]);
      expect(new Set(pages.flat().map((event) => event.id)).size).toBe(appended.length);
    } finally {
      journal.close();
    }
  });

  it('reports no older events when the second page is exactly full', () => {
    const journal = new EventJournal(':memory:');
    try {
      const appended = Array.from({ length: 6 }, (_, index) =>
        journal.append('run-1', 'run', 'run.state', {
          state: index % 2 === 0 ? 'created' : 'preparing',
        }));
      const firstPage = journal.history('run-1', { limit: 3 });
      const secondPage = journal.history('run-1', {
        limit: 3,
        before: firstPage.events[0]!.id,
      });

      expect(secondPage.events).toEqual(appended.slice(0, 3));
      expect(secondPage.hasMore).toBe(false);
    } finally {
      journal.close();
    }
  });

  it('filters by type and source without filtering the journal head', () => {
    const journal = new EventJournal(':memory:');
    try {
      const first = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'first',
      });
      const second = journal.append('run-1', 'opencode-1', 'tool.call', {
        entrantId: 'opencode-1',
        tool: 'shell',
        detail: 'second',
      });
      journal.append('run-2', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'other run',
      });
      const third = journal.append('run-1', 'codex-1', 'tool.call', {
        entrantId: 'codex-1',
        tool: 'shell',
        detail: 'third',
      });
      const head = journal.append('run-1', 'opencode-1', 'agent.message', {
        entrantId: 'opencode-1',
        text: 'head',
      });

      expect(journal.history('run-1', { limit: 10, types: ['tool.call'] })).toEqual({
        events: [second, third],
        lastEventId: head.id,
        hasMore: false,
      });
      expect(journal.history('run-1', { limit: 10, sources: ['codex-1'] }).events)
        .toEqual([first, third]);
      expect(journal.history('run-1', {
        limit: 10,
        types: ['tool.call'],
        sources: ['opencode-1'],
      }).events).toEqual([second]);
      expect(journal.history('run-1', {
        limit: 10,
        before: third.id,
        types: ['tool.call'],
      }).events).toEqual([second]);
      expect(journal.history('run-1', { limit: 10 }).events)
        .toEqual([first, second, third, head]);
    } finally {
      journal.close();
    }
  });

  it('returns an empty page for a run with no events', () => {
    const journal = new EventJournal(':memory:');
    try {
      expect(journal.history('empty-run', { limit: 50 })).toEqual({
        events: [],
        lastEventId: 0,
        hasMore: false,
      });
    } finally {
      journal.close();
    }
  });

  it('caps long payload strings and records what was truncated', () => {
    const journal = new EventJournal(':memory:');
    try {
      const longText = `${'a'.repeat(2_000)}\n${'b'.repeat(2_000)}\nend`;
      const input = { entrantId: 'codex-1', text: longText };
      const truncated = journal.append('run-1', 'codex-1', 'agent.message', input);
      const short = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'short',
      });
      const page = journal.history('run-1', { limit: 10 });

      expect(input.text).toBe(longText);
      expect(truncated.payload.text).toBe(longText.slice(0, EVENT_TEXT_LIMIT));
      expect(truncated.truncated).toEqual({
        text: { fullLength: longText.length, lines: 3 },
      });
      expect(page.events[0]).toEqual(truncated);
      expect(journal.after('run-1', 0)[0]).toEqual(truncated);
      expect(short.payload.text).toBe('short');
      expect('truncated' in short).toBe(false);
      expect('truncated' in page.events[1]!).toBe(false);
    } finally {
      journal.close();
    }
  });

  it('leaves 4,000 characters intact and caps 4,001 characters', () => {
    const journal = new EventJournal(':memory:');
    try {
      const exact = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'a'.repeat(4_000),
      });
      const over = journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: 'b'.repeat(4_001),
      });

      expect(exact.payload.text).toHaveLength(4_000);
      expect('truncated' in exact).toBe(false);
      expect(over.payload.text).toHaveLength(4_000);
      expect(over.truncated).toEqual({
        text: { fullLength: 4_001, lines: 1 },
      });
    } finally {
      journal.close();
    }
  });

  it('drops a whole surrogate pair at the truncation boundary', () => {
    const journal = new EventJournal(':memory:');
    try {
      journal.append('run-1', 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: `${'z'.repeat(3_999)}\u{1F600}`,
      });

      const [stored] = journal.after('run-1', 0);
      if (stored?.type !== 'agent.message') throw new Error('Expected an agent message');
      const text = stored.payload.text;
      const lastCodeUnit = text.charCodeAt(text.length - 1);

      expect(text).toHaveLength(3_999);
      expect(lastCodeUnit < 0xD800 || lastCodeUnit > 0xDBFF).toBe(true);
      expect(stored.truncated).toEqual({
        text: { fullLength: 4_001, lines: 1 },
      });
    } finally {
      journal.close();
    }
  });
});
