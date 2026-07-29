import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { CodexEventParser } from '../src/adapters/codex-parser.js';
import { OpenCodeEventParser } from '../src/adapters/opencode-parser.js';

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
        payload: { entrantId: 'codex-1', inputTokens: 36126, outputTokens: 126 },
      },
    ]);
    const toolEvents = events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result');
    expect(toolEvents[0]?.payload.toolCallId).toBe(toolEvents[1]?.payload.toolCallId);
    expect(parsed[0]?.sessionId).toBe('019f8878-f894-7dd1-863c-9d91442434b2');
    expect(parsed.at(-1)?.turnEnded).toBe(true);
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
        path: 'packages/backend/src/example.ts',
        status: 'in_progress',
      },
    }));
    const completed = parser.parse(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-file-1',
        type: 'file_change',
        path: 'packages/backend/src/example.ts',
        status: 'completed',
      },
    }));

    expect(started.events).toEqual([{
      type: 'tool.call',
      payload: {
        entrantId: 'codex-1',
        tool: 'file_change',
        toolCallId: 'item-file-1',
        detail: 'packages/backend/src/example.ts',
      },
    }]);
    expect(completed.events).toEqual([{
      type: 'tool.result',
      payload: {
        entrantId: 'codex-1',
        tool: 'file_change',
        toolCallId: 'item-file-1',
        ok: true,
        detail: 'packages/backend/src/example.ts',
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
      {
        type: 'agent.message',
        payload: { entrantId: 'opencode-1', text: 'hello arena' },
      },
      {
        type: 'usage',
        payload: { entrantId: 'opencode-1', inputTokens: 109, outputTokens: 3 },
      },
    ]);
    const toolEvents = events.filter((event) => event.type === 'tool.call' || event.type === 'tool.result');
    expect(toolEvents[0]?.payload.toolCallId).toBe('call_00_7kEdm3hh7CQuyhLOI92R7648');
    expect(toolEvents[0]?.payload.toolCallId).not.toBe('prt_f8878ffad001vvHNmblpjdVwDF');
    expect(parsed.every((result) => result.sessionId === 'ses_077870ef7ffeaZ3Asz0lQdr92M')).toBe(true);
    expect(parsed.at(-1)?.turnEnded).toBe(true);
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

  it('ends a length-limited step and preserves its usage', () => {
    const parser = new OpenCodeEventParser('opencode-1');
    const parsed = parser.parse(JSON.stringify({
      type: 'step_finish',
      sessionID: 'session-length',
      part: { reason: 'length', tokens: { input: 321, output: 45 } },
    }));

    expect(parsed).toEqual({
      events: [{
        type: 'usage',
        payload: { entrantId: 'opencode-1', inputTokens: 321, outputTokens: 45 },
      }],
      sessionId: 'session-length',
      turnEnded: true,
    });
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
      payload: { entrantId: 'opencode-1', inputTokens: 98, outputTokens: 7 },
    }]);
    expect(parsed.turnEnded).toBe(true);
    expect(parser.unknownEvents).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
