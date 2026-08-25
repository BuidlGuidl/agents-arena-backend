import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { ClaudeEventParser } from '../src/adapters/claude-parser.js';
import { CodexEventParser } from '../src/adapters/codex-parser.js';
import { OpenCodeEventParser } from '../src/adapters/opencode-parser.js';
import { costForTokens } from '../src/pricing.js';

async function fixture(name: string): Promise<string[]> {
  const contents = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return contents.trim().split('\n');
}

describe('CodexEventParser', () => {
  it('maps the fixture to arena events', async () => {
    const parser = new CodexEventParser('codex-1');
    const parsed = (await fixture('codex-events.jsonl')).map((line) => parser.parse(line));

    const events = parsed.flatMap((result) => result.events);
    expect(events).toEqual([
      {
        type: 'entrant.error',
        payload: {
          entrantId: 'codex-1',
          message: 'Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
        },
      },
      {
        type: 'agent.message',
        payload: { entrantId: 'codex-1', text: 'I’ll run the command and return its exact output.' },
      },
      {
        type: 'tool.call',
        payload: {
          entrantId: 'codex-1',
          tool: 'shell',
          toolCallId: 'item_2',
          detail: "/bin/zsh -lc 'echo hello arena'",
        },
      },
      {
        type: 'tool.result',
        payload: {
          entrantId: 'codex-1',
          tool: 'shell',
          toolCallId: 'item_2',
          ok: true,
          detail: 'hello arena\n',
        },
      },
      {
        type: 'agent.message',
        payload: { entrantId: 'codex-1', text: '`hello arena`' },
      },
      {
        type: 'usage',
        payload: { entrantId: 'codex-1', inputTokens: 36126, outputTokens: 126, cachedInputTokens: 27136, costUsd: null },
      },
    ]);
    const toolEvents = events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result');
    expect(toolEvents[0]?.payload.toolCallId).toBe(toolEvents[1]?.payload.toolCallId);
    expect(parsed[0]?.sessionId).toBe('019f8878-f894-7dd1-863c-9d91442434b2');
    expect(parsed.at(-1)?.turnEnded).toBe(true);
  });

  // turn.completed carries the session running total, not the turn
  // (openai/codex#17539), and `exec resume` keeps counting in the same session.
  // codex-resume-turns.jsonl is a captured two-turn session — `codex exec` then
  // `codex exec resume` on the same thread, the shape a steer produces. Turn 2
  // reports output 10 for the two turns that emitted 5 each.
  it('reports each turn as its own spend across a resumed session', async () => {
    const parser = new CodexEventParser('codex-1');
    const usage = (await fixture('codex-resume-turns.jsonl'))
      .flatMap((line) => parser.parse(line).events)
      .filter((event) => event.type === 'usage')
      .map((event) => event.payload);

    expect(usage).toMatchObject([
      { inputTokens: 12_937, cachedInputTokens: 10_496, outputTokens: 5 },
      { inputTokens: 12_955, cachedInputTokens: 12_544, outputTokens: 5 },
    ]);
    // What the snapshot would total has to land on the session total codex last
    // reported — 25,892 in / 23,040 cached / 10 out — not the sum of both reports.
    expect(usage.reduce((total, turn) => total + turn.inputTokens, 0)).toBe(25_892);
    expect(usage.reduce((total, turn) => total + turn.cachedInputTokens, 0)).toBe(23_040);
    expect(usage.reduce((total, turn) => total + turn.outputTokens, 0)).toBe(10);
  });

  it('counts from zero again when a new thread starts', () => {
    const parser = new CodexEventParser('codex-1');
    parser.parse(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
    parser.parse(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 9_000, output_tokens: 40 },
    }));
    parser.parse(JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }));
    const fresh = parser.parse(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1_500, output_tokens: 7 },
    }));

    expect(fresh.events[0]?.payload).toMatchObject({ inputTokens: 1_500, outputTokens: 7 });
  });

  it('takes a shrinking total at face value instead of reporting a negative turn', () => {
    const parser = new CodexEventParser('codex-1');
    parser.parse(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
    parser.parse(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 9_000, output_tokens: 40 },
    }));
    const shrunk = parser.parse(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1_200, output_tokens: 6 },
    }));

    expect(shrunk.events[0]?.payload).toMatchObject({ inputTokens: 1_200, outputTokens: 6 });
  });

  it('warns on malformed lines and counts unknown events', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new CodexEventParser('codex-1', logger);

    expect(parser.parse('{oops')).toEqual({ events: [] });
    expect(parser.parse('{"type":"future.event"}')).toEqual({ events: [] });
    expect(parser.unknownEvents).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('maps generic file-change items without counting them as unknown', () => {
    const parser = new CodexEventParser('codex-1');
    const started = parser.parse(JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item-file-1',
        type: 'file_change',
        changes: [{ path: 'src/Challenge12Solver.sol', kind: 'add' }, { path: 'foundry.toml', kind: 'update' }],
        status: 'in_progress',
      },
    }));
    const completed = parser.parse(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-file-1',
        type: 'file_change',
        changes: [{ path: 'src/Challenge12Solver.sol', kind: 'add' }, { path: 'foundry.toml', kind: 'update' }],
        status: 'completed',
      },
    }));

    expect(started.events).toEqual([{
      type: 'tool.call',
      payload: {
        entrantId: 'codex-1',
        tool: 'file_change',
        toolCallId: 'item-file-1',
        detail: 'src/Challenge12Solver.sol foundry.toml',
      },
    }]);
    expect(completed.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'codex-1',
        tool: 'file_change',
        toolCallId: 'item-file-1',
        ok: true,
        detail: 'src/Challenge12Solver.sol foundry.toml',
      },
    }]);
    const startedEvent = started.events[0];
    const completedEvent = completed.events[0];
    if (startedEvent?.type !== 'tool.call' || completedEvent?.type !== 'tool.result') {
      throw new Error('generic tool pair missing');
    }
    expect(startedEvent.payload.toolCallId).toBe(completedEvent.payload.toolCallId);
    expect(parser.unknownEvents).toBe(0);
  });

  it('marks a generic failed item result as failed', () => {
    const parser = new CodexEventParser('codex-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-file-2',
        type: 'file_change',
        path: 'packages/backend/src/example.ts',
        status: 'failed',
        message: 'patch did not apply',
      },
    }));

    expect(parsed.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'codex-1',
        tool: 'file_change',
        toolCallId: 'item-file-2',
        ok: false,
        detail: 'packages/backend/src/example.ts',
      },
    }]);
  });

  it('uses per-parser synthetic ids when Codex omits item ids', () => {
    const parser = new CodexEventParser('codex-1');
    const started = parser.parse(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'pwd' },
    }));
    const completed = parser.parse(JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', exit_code: 0 },
    }));

    expect(started.events[0]?.payload).toMatchObject({ toolCallId: 'synthetic-1' });
    expect(completed.events[0]?.payload).toMatchObject({ toolCallId: 'synthetic-2' });
  });
});

describe('OpenCodeEventParser', () => {
  it('maps the fixture to arena events', async () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = (await fixture('opencode-events.jsonl')).map((line) => parser.parse(line));

    const events = parsed.flatMap((result) => result.events);
    expect(events).toEqual([
      {
        type: 'tool.call',
        payload: {
          entrantId: 'opencode-1',
          tool: 'bash',
          toolCallId: 'call_00_7kEdm3hh7CQuyhLOI92R7648',
          detail: 'echo hello arena',
        },
      },
      {
        type: 'tool.result',
        payload: {
          entrantId: 'opencode-1',
          tool: 'bash',
          toolCallId: 'call_00_7kEdm3hh7CQuyhLOI92R7648',
          ok: true,
          detail: 'hello arena\n',
        },
      },
      // The tool-calls step is mid-turn, but its tokens are real spend.
      {
        type: 'usage',
        payload: { entrantId: 'opencode-1', inputTokens: 15138, outputTokens: 60, cachedInputTokens: 0, costUsd: null },
      },
      {
        type: 'agent.message',
        payload: { entrantId: 'opencode-1', text: 'hello arena' },
      },
      {
        type: 'agent.reasoning',
        payload: { entrantId: 'opencode-1', text: 'The command succeeded, so I can answer with its output.' },
      },
      {
        type: 'usage',
        payload: { entrantId: 'opencode-1', inputTokens: 15213, outputTokens: 13, cachedInputTokens: 15104, costUsd: null },
      },
    ]);
    const toolEvents = events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result');
    expect(toolEvents[0]?.payload.toolCallId).toBe('call_00_7kEdm3hh7CQuyhLOI92R7648');
    expect(toolEvents[0]?.payload.toolCallId).not.toBe('prt_f8878ffad001vvHNmblpjdVwDF');
    expect(parsed.every((result) => result.sessionId === 'ses_077870ef7ffeaZ3Asz0lQdr92M')).toBe(true);
    expect(parsed.at(-1)?.turnEnded).toBe(true);
  });

  it('maps a reasoning part to agent reasoning', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'reasoning',
      sessionID: 'session-reasoning',
      part: { id: 'part-reasoning', text: 'I need to inspect the result.' },
    }));

    expect(parsed).toEqual({
      events: [{
        type: 'agent.reasoning',
        payload: { entrantId: 'opencode-1', text: 'I need to inspect the result.' },
      }],
      sessionId: 'session-reasoning',
    });
  });

  it('emits a reasoning part id once', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const line = JSON.stringify({
      type: 'reasoning',
      sessionID: 'session-reasoning',
      part: { id: 'part-reasoning', text: 'I need to inspect the result.' },
    });

    expect(parser.parse(line).events).toHaveLength(1);
    expect(parser.parse(line)).toEqual({ events: [], sessionId: 'session-reasoning' });
  });

  it('warns on malformed lines and counts unknown events', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new OpenCodeEventParser('opencode-1', logger);

    expect(parser.parse('[]')).toEqual({ events: [] });
    expect(parser.parse('{"type":"future_event"}')).toEqual({ events: [] });
    expect(parser.unknownEvents).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('shares one synthetic id across an OpenCode tool pair without callID', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'pwd' }, metadata: { exit: 0 } },
      },
    }));

    expect(parsed.events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ toolCallId: 'synthetic-1' }),
      expect.objectContaining({ toolCallId: 'synthetic-1' }),
    ]);
  });

  it('does not let a whitespace-only reasoning part consume its id', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const first = parser.parse(JSON.stringify({
      type: 'reasoning', sessionID: 'session-1', part: { id: 'prt_ws', text: '\n\n' },
    }));
    const second = parser.parse(JSON.stringify({
      type: 'reasoning', sessionID: 'session-1', part: { id: 'prt_ws', text: '\nThe whole thought.\n' },
    }));
    expect(first.events).toEqual([]);
    expect(second.events).toEqual([{
      type: 'agent.reasoning',
      payload: { entrantId: 'opencode-1', text: '\nThe whole thought.\n' },
    }]);
  });

  it('ends a length-limited step and preserves its usage', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-length',
      part: { reason: 'length', tokens: { input: 321, output: 45, reasoning: 30 } },
    }));

    expect(parsed).toEqual({
      events: [{
        type: 'usage',
        payload: { entrantId: 'opencode-1', inputTokens: 321, outputTokens: 75, cachedInputTokens: 0, costUsd: null },
      }],
      sessionId: 'session-length',
      turnEnded: true,
    });
  });

  it('counts a mid-turn tool-calls step without ending the turn', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-tools',
      part: { reason: 'tool-calls', tokens: { input: 15138, output: 45 }, cost: 0.0042 },
    }));

    expect(parsed.events).toEqual([{
      type: 'usage',
      payload: { entrantId: 'opencode-1', inputTokens: 15138, outputTokens: 45, cachedInputTokens: 0, costUsd: 0.0042 },
    }]);
    expect(parsed.turnEnded).toBeUndefined();
  });

  // opencode reports input net of cache; codex counts cache inside input.
  // The board compares the two lanes, so this adapter normalizes to codex's shape.
  it('folds cache reads into the prompt total', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-cache',
      part: {
        reason: 'stop',
        tokens: { total: 15226, input: 109, output: 3, reasoning: 10, cache: { write: 0, read: 15104 } },
        cost: 0.0042,
      },
    }));

    expect(parsed.events[0]?.payload).toMatchObject({
      inputTokens: 15213,
      cachedInputTokens: 15104,
      outputTokens: 13,
    });
  });

  it('folds cache reads and writes into the prompt total', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-cache-write',
      part: {
        reason: 'stop',
        tokens: { input: 40, output: 3, cache: { read: 100, write: 250 } },
      },
    }));

    expect(parsed.events[0]?.payload).toMatchObject({
      inputTokens: 390,
      cachedInputTokens: 100,
    });
  });

  it('treats a reported cost of zero as no price', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    // Subscription and local-model logins report 0 for every step.
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-free',
      part: { reason: 'stop', tokens: { input: 400, output: 20 }, cost: 0 },
    }));

    expect(parsed.events[0]?.payload).toMatchObject({ costUsd: null });
  });

  it('ends an unrecognized step-finish reason without counting it as unknown', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new OpenCodeEventParser('opencode-1', logger);
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-future',
      part: { reason: 'future-reason', tokens: { input: 98, output: 7 } },
    }));

    expect(parsed.events).toEqual([{
      type: 'usage',
      payload: { entrantId: 'opencode-1', inputTokens: 98, outputTokens: 7, cachedInputTokens: 0, costUsd: null },
    }]);
    expect(parsed.turnEnded).toBe(true);
    expect(parser.unknownEvents).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('ClaudeEventParser', () => {
  it('maps the captured start fixture to paired events and per-invocation usage', async () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = (await fixture('claude-events.jsonl')).map((line) => parser.parse(line));
    const events = parsed.flatMap((result) => result.events);

    expect(events).toEqual([
      {
        type: 'tool.call',
        payload: {
          entrantId: 'claude-1',
          tool: 'Bash',
          toolCallId: 'toolu_014hxUxk5yfTxYBZ5yBXzk2R',
          detail: '{"command":"echo arena-fixture-test","description":"Echo test string"}',
        },
      },
      {
        type: 'tool.result',
        payload: {
          entrantId: 'claude-1',
          tool: 'Bash',
          toolCallId: 'toolu_014hxUxk5yfTxYBZ5yBXzk2R',
          ok: true,
          detail: 'arena-fixture-test',
        },
      },
      {
        type: 'agent.message',
        payload: { entrantId: 'claude-1', text: 'fixture start done' },
      },
      {
        type: 'usage',
        payload: {
          entrantId: 'claude-1',
          inputTokens: 63_196,
          outputTokens: 88,
          cachedInputTokens: 46_817,
          // Single-model turn: the modelUsage row prices exactly like the aggregate.
          costUsd: 0.107504,
        },
      },
    ]);
    const toolEvents = events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result');
    expect(toolEvents[0]?.payload.toolCallId).toBe(toolEvents[1]?.payload.toolCallId);
    expect(parsed[0]?.sessionId).toBe('7a89c9bf-ce69-4b8e-bde5-28c99b318d58');
    expect(parsed[2]).toEqual({ events: [] });
    expect(parsed.at(-1)?.turnEnded).toBe(true);
  });

  it('extracts the same session and reports resumed usage without a cumulative delta', async () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = (await fixture('claude-resume-turns.jsonl')).map((line) => parser.parse(line));
    const usage = parsed.flatMap((result) => result.events).find((event) => event.type === 'usage');

    expect(parsed[0]?.sessionId).toBe('7a89c9bf-ce69-4b8e-bde5-28c99b318d58');
    expect(usage?.payload).toEqual({
      entrantId: 'claude-1',
      inputTokens: 31_924,
      outputTokens: 8,
      cachedInputTokens: 15_268,
      costUsd: 0.091114,
    });
    expect(parsed.at(-1)?.turnEnded).toBe(true);
  });

  it('prices a delegating turn per model instead of at the entrant rate', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = parser.parse(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 9_000,
        output_tokens: 3_000,
      },
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 1_000,
          cacheReadInputTokens: 4_000,
          cacheCreationInputTokens: 1_000,
        },
        'claude-sonnet-5': {
          inputTokens: 0,
          outputTokens: 2_000,
          cacheReadInputTokens: 5_000,
          cacheCreationInputTokens: 0,
        },
      },
    }));
    const usage = parsed.events.find((event) => event.type === 'usage');

    // opus: 1,010 fresh + 4,000 cached + 1,000 out. sonnet: 5,000 cached + 2,000 out.
    expect(usage?.payload.costUsd).toBe(0.06355);
    // Aggregate tokens still come from `usage`, which counts the whole turn.
    expect(usage?.payload).toMatchObject({ inputTokens: 10_010, outputTokens: 3_000, cachedInputTokens: 9_000 });
    // The old aggregate-only pricing charged every sonnet token at the opus rate.
    expect(costForTokens('claude-opus-5', 10_010, 3_000, 9_000)).toBe(0.08455);
  });

  it('prices a subagent model the rate table does not list at the entrant rate', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = parser.parse(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 2_000, output_tokens: 200 },
      modelUsage: {
        'claude-opus-5': { inputTokens: 1_000, outputTokens: 100 },
        'claude-haiku-9-9': { inputTokens: 1_000, outputTokens: 100 },
      },
    }));
    const usage = parsed.events.find((event) => event.type === 'usage');

    expect(usage?.payload.costUsd).toBe(costForTokens('claude-opus-5', 2_000, 200));
  });

  // Captured shape: a Task subagent's row is keyed by dated id, and only its
  // `canonicalModel` matches the rate table.
  it('prices a dated modelUsage key off its canonical model', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = parser.parse(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 1_000, output_tokens: 100 },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 1_000,
          outputTokens: 100,
          canonicalModel: 'claude-haiku-4-5',
        },
      },
    }));
    const usage = parsed.events.find((event) => event.type === 'usage');

    // Keyed on the dated id alone, the row would miss the table and fall back to opus.
    expect(usage?.payload.costUsd).toBe(costForTokens('claude-haiku-4-5', 1_000, 100));
    expect(usage?.payload.costUsd).not.toBe(costForTokens('claude-opus-5', 1_000, 100));
  });

  it('leaves cost null when an unlisted entrant model prices nothing', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-mystery-9');
    const parsed = parser.parse(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 1_000, output_tokens: 100 },
      modelUsage: { 'claude-mystery-9': { inputTokens: 1_000, outputTokens: 100 } },
    }));
    const usage = parsed.events.find((event) => event.type === 'usage');

    expect(usage?.payload.costUsd).toBeNull();
  });

  it('logs rate limits and unknown event shapes while ignoring empty text blocks', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5', logger);

    expect(parser.parse(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
    }))).toEqual({ events: [] });
    expect(parser.parse(JSON.stringify({ type: 'system', subtype: 'future' }))).toEqual({ events: [] });
    expect(parser.parse(JSON.stringify({ type: 'future_event' }))).toEqual({ events: [] });
    expect(parser.parse(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }, { type: 'thinking', thinking: '' }] },
    }))).toEqual({ events: [] });
    expect(parser.unknownEvents).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[claude parser] rate limit status=allowed overageStatus=rejected',
    );
    expect(logger.info).toHaveBeenCalledWith('[claude parser] ignored unknown event future_event');
  });

  it('emits an entrant error when a rate limit is not allowed', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5', logger);
    const parsed = parser.parse(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        overageStatus: 'not_available',
        resetsAt: 1_786_000_000,
      },
    }));

    expect(parsed.events).toEqual([{
      type: 'entrant.error',
      payload: {
        entrantId: 'claude-1',
        message: 'Claude rate limit status=rejected: '
          + '{"status":"rejected","overageStatus":"not_available","resetsAt":1786000000}',
      },
    }]);
    expect(logger.info).toHaveBeenCalledWith(
      '[claude parser] rate limit status=rejected overageStatus=not_available',
    );
  });

  it('tags Task subagent tool work with the call that spawned it', async () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const assistant = JSON.parse((await fixture('claude-events.jsonl'))[1] as string) as Record<string, unknown>;
    assistant.parent_tool_use_id = 'toolu_task';
    const call = parser.parse(JSON.stringify(assistant));
    const result = parser.parse(JSON.stringify({
      type: 'user',
      parent_tool_use_id: 'toolu_task',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_014hxUxk5yfTxYBZ5yBXzk2R',
          content: 'arena-fixture-test',
        }],
      },
    }));

    expect(call.events).toEqual([{
      type: 'tool.call',
      payload: {
        entrantId: 'claude-1',
        tool: 'Bash',
        toolCallId: 'toolu_014hxUxk5yfTxYBZ5yBXzk2R',
        detail: '{"command":"echo arena-fixture-test","description":"Echo test string"}',
        parentToolCallId: 'toolu_task',
      },
    }]);
    expect(result.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'claude-1',
        tool: 'Bash',
        toolCallId: 'toolu_014hxUxk5yfTxYBZ5yBXzk2R',
        ok: true,
        detail: 'arena-fixture-test',
        parentToolCallId: 'toolu_task',
      },
    }]);
  });

  it('drops subagent prose so the lane keeps only the entrant own voice', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5', logger);

    expect(parser.parse(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_task',
      message: {
        content: [
          { type: 'text', text: 'subagent chatter' },
          { type: 'thinking', thinking: 'subagent thoughts' },
        ],
      },
    }))).toEqual({ events: [] });
    expect(parser.unknownEvents).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs unhandled assistant block types without emitting events', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5', logger);

    expect(parser.parse(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'server_tool_use', id: 'server-tool-1' }] },
    }))).toEqual({ events: [] });
    expect(parser.unknownEvents).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[claude parser] ignored unknown event assistant-block:server_tool_use',
    );
  });

  it('extracts text blocks from array-shaped tool results', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    parser.parse(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'toolu_array', name: 'Read' }] },
    }));
    const parsed = parser.parse(JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_array',
          content: [
            { type: 'text', text: 'first line' },
            { type: 'text', text: 'second line' },
            { type: 'image', source: 'preview' },
          ],
        }],
      },
    }));

    expect(parsed.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'claude-1',
        tool: 'Read',
        toolCallId: 'toolu_array',
        ok: true,
        detail: 'first line\nsecond line\n{"type":"image","source":"preview"}',
      },
    }]);
  });

  it('emits reasoning and reports result errors while keeping usage', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const reasoning = parser.parse(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'Check the balance.' }] },
    }));
    const failed = parser.parse(JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Credit balance is too low',
      total_cost_usd: 0,
      usage: { input_tokens: 3, output_tokens: 1 },
    }));

    expect(reasoning.events).toEqual([{
      type: 'agent.reasoning',
      payload: { entrantId: 'claude-1', text: 'Check the balance.' },
    }]);
    expect(failed).toEqual({
      events: [
        {
          type: 'entrant.error',
          payload: { entrantId: 'claude-1', message: 'Credit balance is too low' },
        },
        {
          type: 'usage',
          payload: {
            entrantId: 'claude-1',
            inputTokens: 3,
            outputTokens: 1,
            cachedInputTokens: 0,
            costUsd: null,
          },
        },
      ],
      turnEnded: true,
    });
  });

  it('uses the errors array when an error result has no result string', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    const parsed = parser.parse(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Credit balance is too low'],
      usage: { input_tokens: 3, output_tokens: 1 },
    }));

    expect(parsed.events).toContainEqual({
      type: 'entrant.error',
      payload: {
        entrantId: 'claude-1',
        message: 'Credit balance is too low',
      },
    });
  });

  it('forgets unmatched tool names when a result ends the turn', () => {
    const parser = new ClaudeEventParser('claude-1', 'claude-opus-5');
    parser.parse(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_stale', name: 'Bash' }] },
    }));
    parser.parse(JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const lateResult = parser.parse(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_stale',
          content: 'late',
        }],
      },
    }));

    expect(lateResult.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'claude-1',
        tool: 'tool',
        toolCallId: 'toolu_stale',
        ok: true,
        detail: 'late',
      },
    }]);
  });
});
