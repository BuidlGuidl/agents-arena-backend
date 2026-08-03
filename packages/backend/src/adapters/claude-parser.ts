import type { ParsedArenaEvent, ParsedHarnessLine, ParserLogger } from './parser-types.js';

type JsonObject = Record<string, unknown>;

export class ClaudeEventParser {
  unknownEvents = 0;
  private readonly toolNames = new Map<string, string>();

  constructor(
    private readonly entrantId: string,
    private readonly logger: ParserLogger = console,
  ) {}

  parse(line: string): ParsedHarnessLine {
    const value = parseObject(line, this.logger);
    if (value === undefined) return { events: [] };

    const type = stringValue(value.type);
    if (type === 'system') {
      if (stringValue(value.subtype) !== 'init') return { events: [] };
      const sessionId = stringValue(value.session_id);
      return sessionId === undefined ? { events: [] } : { events: [], sessionId };
    }
    if ((type === 'assistant' || type === 'user')
        && value.parent_tool_use_id !== undefined
        && value.parent_tool_use_id !== null) {
      return { events: [] };
    }
    if (type === 'assistant') return { events: this.assistantEvents(value) };
    if (type === 'user') return { events: this.userEvents(value) };
    if (type === 'result') return this.result(value);
    if (type === 'rate_limit_event') {
      const info = objectValue(value.rate_limit_info);
      const status = stringValue(info?.status) ?? '<missing>';
      this.logger.info(
        `[claude parser] rate limit status=${status}`
        + ` overageStatus=${stringValue(info?.overageStatus) ?? '<missing>'}`,
      );
      return status === 'allowed'
        ? { events: [] }
        : {
          events: [{
            type: 'entrant.error',
            payload: {
              entrantId: this.entrantId,
              message: `Claude rate limit status=${status}: ${detailValue(info)}`,
            },
          }],
        };
    }
    this.recordUnknown(type ?? '<missing>');
    return { events: [] };
  }

  private assistantEvents(value: JsonObject): ParsedArenaEvent[] {
    const content = objectValue(value.message)?.content;
    if (!Array.isArray(content)) return [];

    const events: ParsedArenaEvent[] = [];
    for (const rawBlock of content) {
      const block = objectValue(rawBlock);
      const blockType = stringValue(block?.type);
      if (block === undefined || blockType === undefined) continue;
      if (blockType === 'text') {
        const text = stringValue(block.text) ?? '';
        if (text.length > 0) {
          events.push({
            type: 'agent.message',
            payload: { entrantId: this.entrantId, text },
          });
        }
      } else if (blockType === 'thinking') {
        const text = stringValue(block.thinking) ?? stringValue(block.text) ?? '';
        if (text.length > 0) {
          events.push({
            type: 'agent.reasoning',
            payload: { entrantId: this.entrantId, text },
          });
        }
      } else if (blockType === 'tool_use') {
        const toolCallId = stringValue(block.id);
        if (toolCallId === undefined) continue;
        const tool = stringValue(block.name) ?? 'tool';
        this.toolNames.set(toolCallId, tool);
        events.push({
          type: 'tool.call',
          payload: {
            entrantId: this.entrantId,
            tool,
            toolCallId,
            detail: detailValue(block.input),
          },
        });
      } else {
        this.recordUnknown(`assistant-block:${blockType}`);
      }
    }
    return events;
  }

  private userEvents(value: JsonObject): ParsedArenaEvent[] {
    const content = objectValue(value.message)?.content;
    if (!Array.isArray(content)) return [];

    const events: ParsedArenaEvent[] = [];
    for (const rawBlock of content) {
      const block = objectValue(rawBlock);
      if (block === undefined || stringValue(block.type) !== 'tool_result') continue;
      const toolCallId = stringValue(block.tool_use_id);
      if (toolCallId === undefined) continue;
      const tool = this.toolNames.get(toolCallId) ?? 'tool';
      this.toolNames.delete(toolCallId);
      events.push({
        type: 'tool.result',
        payload: {
          entrantId: this.entrantId,
          tool,
          toolCallId,
          ok: block.is_error !== true,
          detail: detailValue(block.content),
        },
      });
    }
    return events;
  }

  private result(value: JsonObject): ParsedHarnessLine {
    // Claude reports usage only on the result line, so a watchdog-killed turn has no usage event.
    this.toolNames.clear();
    const usage = objectValue(value.usage);
    const cachedInputTokens = numberValue(usage?.cache_read_input_tokens);
    const events: ParsedArenaEvent[] = [];
    if (value.is_error === true) {
      events.push({
        type: 'entrant.error',
        payload: {
          entrantId: this.entrantId,
          message: resultErrorMessage(value),
        },
      });
    }
    events.push({
      type: 'usage',
      payload: {
        entrantId: this.entrantId,
        inputTokens: numberValue(usage?.input_tokens)
          + cachedInputTokens
          + numberValue(usage?.cache_creation_input_tokens),
        outputTokens: numberValue(usage?.output_tokens),
        cachedInputTokens,
        // Ignore Anthropic's cache-write premiums because comparable MODEL_RATES costs matter more than exact provider billing.
        costUsd: null,
      },
    });
    return { events, turnEnded: true };
  }

  private recordUnknown(type: string): void {
    this.unknownEvents += 1;
    this.logger.info(`[claude parser] ignored unknown event ${type}`);
  }
}

function parseObject(line: string, logger: ParserLogger): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
  } catch {
    logger.warn('[claude parser] skipped malformed line');
    return undefined;
  }
  logger.warn('[claude parser] skipped malformed line');
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

function resultErrorMessage(value: JsonObject): string {
  const result = stringValue(value.result);
  if (result !== undefined) return result;
  if (Array.isArray(value.errors)) {
    const errors = value.errors.filter((error): error is string => typeof error === 'string');
    if (errors.length > 0) return errors.join('; ');
  }
  return 'Claude reported an error';
}

function detailValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((rawBlock) => {
      const block = objectValue(rawBlock);
      if (stringValue(block?.type) === 'text') return stringValue(block?.text) ?? '';
      return JSON.stringify(rawBlock) ?? '';
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(value) ?? '';
}
