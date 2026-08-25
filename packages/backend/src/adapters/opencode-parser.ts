import type { ParsedArenaEvent, ParsedHarnessLine, ParserLogger } from './parser-types.js';

type JsonObject = Record<string, unknown>;

export class OpenCodeEventParser {
  unknownEvents = 0;
  private syntheticToolCallCount = 0;
  private readonly seenReasoningPartIds = new Set<string>();

  constructor(
    private readonly entrantId: string,
    private readonly logger: ParserLogger = console,
  ) {}

  parse(line: string): ParsedHarnessLine {
    const value = parseObject(line, this.logger);
    if (value === undefined) return { events: [] };

    const sessionId = stringValue(value.sessionID);
    const type = stringValue(value.type);
    const part = objectValue(value.part);
    if (type === 'step_start') return withSession([], sessionId);
    if (type === 'text') {
      return withSession([{
        type: 'agent.message',
        payload: { entrantId: this.entrantId, text: stringValue(part?.text) ?? '' },
      }], sessionId);
    }
    if (type === 'reasoning') {
      const partId = stringValue(part?.id);
      if (partId !== undefined && this.seenReasoningPartIds.has(partId)) {
        return withSession([], sessionId);
      }
      const text = stringValue(part?.text) ?? '';
      if (text.trim().length === 0) return withSession([], sessionId);
      if (partId !== undefined) this.seenReasoningPartIds.add(partId);
      return withSession([{
        type: 'agent.reasoning',
        payload: { entrantId: this.entrantId, text },
      }], sessionId);
    }
    if (type === 'tool_use') {
      const state = objectValue(part?.state);
      if (stringValue(state?.status) !== 'completed') return withSession([], sessionId);
      const input = objectValue(state?.input);
      const metadata = objectValue(state?.metadata);
      const tool = stringValue(part?.tool) ?? 'tool';
      const toolCallId = stringValue(part?.callID) ?? `synthetic-${++this.syntheticToolCallCount}`;
      const detail = stringValue(input?.command) ?? JSON.stringify(input ?? {});
      const output = stringValue(state?.output) ?? stringValue(metadata?.output) ?? '';
      const exit = numberValue(metadata?.exit);
      return withSession([
        {
          type: 'tool.call',
          payload: { entrantId: this.entrantId, tool, toolCallId, detail },
        },
        {
          type: 'tool.result',
          payload: { entrantId: this.entrantId, tool, toolCallId, ok: exit === 0, detail: output },
        },
      ], sessionId);
    }
    if (type === 'step_finish') {
      const tokens = objectValue(part?.tokens);
      // Tokens and cost are per step. OpenCode's input excludes cache reads and
      // writes, so add both back: claude adds cache creation the same way, and
      // codex's input already includes cache. Reasoning goes into output because
      // OpenRouter bills it inside max_tokens and the other lanes count thinking
      // as output too, so the board means the same thing across lanes.
      const cache = objectValue(tokens?.cache);
      const cachedInputTokens = numberValue(cache?.read);
      const cacheWriteTokens = numberValue(cache?.write);
      const usage: ParsedArenaEvent = {
        type: 'usage',
        payload: {
          entrantId: this.entrantId,
          inputTokens: numberValue(tokens?.input) + cachedInputTokens + cacheWriteTokens,
          outputTokens: numberValue(tokens?.output) + numberValue(tokens?.reasoning),
          cachedInputTokens,
          costUsd: reportedCost(part?.cost),
        },
      };
      // A tool-calls step is mid-turn: its spend counts, but the turn is not over.
      if (stringValue(part?.reason) === 'tool-calls') return withSession([usage], sessionId);
      return { ...withSession([usage], sessionId), turnEnded: true };
    }
    if (type === 'error') {
      return withSession([{
        type: 'entrant.error',
        payload: {
          entrantId: this.entrantId,
          message: stringValue(value.message) ?? 'OpenCode reported an error',
        },
      }], sessionId);
    }

    this.unknownEvents += 1;
    this.logger.info(`[opencode parser] ignored unknown event ${type ?? '<missing>'}`);
    return withSession([], sessionId);
  }
}

function withSession(events: ParsedArenaEvent[], sessionId: string | undefined): ParsedHarnessLine {
  return sessionId === undefined ? { events } : { events, sessionId };
}

function parseObject(line: string, logger: ParserLogger): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
  } catch {
    // The warning below covers malformed JSON and non-object JSON values.
  }
  logger.warn('[opencode parser] skipped malformed line');
  return undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// A subscription or local-model login reports cost 0 for every step, which is
// "no price", not "this turn was free". Passing the 0 through would print
// $0.0000 on the board; unknown prints a dash. A genuinely free OpenRouter model
// gets the dash too — the cheaper mistake of the two.
function reportedCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
