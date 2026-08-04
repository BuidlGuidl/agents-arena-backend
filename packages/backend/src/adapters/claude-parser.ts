import { costForModelUsage, type ModelTokenUsage } from '../pricing.js';
import type { ParsedArenaEvent, ParsedHarnessLine, ParserLogger } from './parser-types.js';

type JsonObject = Record<string, unknown>;

export class ClaudeEventParser {
  unknownEvents = 0;
  private readonly toolNames = new Map<string, string>();

  // The entrant model is the fallback rate for a subagent model the table has no
  // row for, so pricing needs it here rather than only in the driver.
  constructor(
    private readonly entrantId: string,
    private readonly entrantModel: string,
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
    // A line carrying parent_tool_use_id comes from a subagent the entrant
    // delegated to; the id is the outer Task call, and it rides along on the
    // tool events so a lane can nest or badge the nested work (#37).
    const parentToolCallId = stringValue(value.parent_tool_use_id);
    if (type === 'assistant') return { events: this.assistantEvents(value, parentToolCallId) };
    if (type === 'user') return { events: this.userEvents(value, parentToolCallId) };
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

  private assistantEvents(value: JsonObject, parentToolCallId?: string): ParsedArenaEvent[] {
    const content = objectValue(value.message)?.content;
    if (!Array.isArray(content)) return [];

    const events: ParsedArenaEvent[] = [];
    for (const rawBlock of content) {
      const block = objectValue(rawBlock);
      const blockType = stringValue(block?.type);
      if (block === undefined || blockType === undefined) continue;
      // A subagent's prose is its own, not the entrant's, and the contract has
      // nowhere to say so — only its tool work reaches the board. Claude sends
      // it at all only under --forward-subagent-text, which the driver omits.
      if (parentToolCallId !== undefined && blockType !== 'tool_use') continue;
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
            ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
          },
        });
      } else {
        this.recordUnknown(`assistant-block:${blockType}`);
      }
    }
    return events;
  }

  private userEvents(value: JsonObject, parentToolCallId?: string): ParsedArenaEvent[] {
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
          ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
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
        // Priced off modelUsage, not the line's own total_cost_usd: comparable
        // MODEL_RATES costs matter more than exact provider billing, which is
        // also why Anthropic's cache-write premiums stay ignored. Null when the
        // line carries no breakdown (an errored turn does not) leaves the driver
        // to price the aggregate at the entrant model, as before.
        costUsd: costForModelUsage(modelUsageRows(value.modelUsage), this.entrantModel),
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

// The result line's aggregate usage says nothing about which model spent what, so
// a turn that delegates to a subagent would price every token at the entrant's
// model. modelUsage carries one row per model the turn actually used, keyed by
// model id, each counting its fresh, cached, and cache-creation prompt tokens
// separately — the same split the aggregate gets normalized from. The row's
// `canonicalModel` names the model without a release date, which is the form
// MODEL_RATES and the roster key on; the object key is the fallback for a row
// that omits it.
function modelUsageRows(value: unknown): ModelTokenUsage[] {
  const modelUsage = objectValue(value);
  if (modelUsage === undefined) return [];

  const rows: ModelTokenUsage[] = [];
  for (const [key, rawRow] of Object.entries(modelUsage)) {
    const row = objectValue(rawRow);
    if (row === undefined) continue;
    const cachedInputTokens = numberValue(row.cacheReadInputTokens);
    rows.push({
      model: stringValue(row.canonicalModel) ?? key,
      inputTokens: numberValue(row.inputTokens)
        + cachedInputTokens
        + numberValue(row.cacheCreationInputTokens),
      outputTokens: numberValue(row.outputTokens),
      cachedInputTokens,
    });
  }
  return rows;
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
