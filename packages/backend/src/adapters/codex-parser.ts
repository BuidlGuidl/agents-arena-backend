import type { ParsedArenaEvent, ParsedHarnessLine, ParserLogger } from './parser-types.js';

type JsonObject = Record<string, unknown>;

export class CodexEventParser {
  unknownEvents = 0;

  constructor(
    private readonly entrantId: string,
    private readonly logger: ParserLogger = console,
  ) {}

  parse(line: string): ParsedHarnessLine {
    const value = parseObject(line, this.logger, 'codex');
    if (value === undefined) return { events: [] };

    const type = stringValue(value.type);
    if (type === 'thread.started') {
      const sessionId = stringValue(value.thread_id);
      return sessionId === undefined ? { events: [] } : { events: [], sessionId };
    }
    if (type === 'turn.started') return { events: [] };
    if (type === 'turn.completed') {
      const usage = objectValue(value.usage);
      return {
        events: [{
          type: 'usage',
          payload: {
            entrantId: this.entrantId,
            inputTokens: numberValue(usage?.input_tokens),
            outputTokens: numberValue(usage?.output_tokens),
            cachedInputTokens: numberValue(usage?.cached_input_tokens),
            // The codex stream carries no price; the driver derives one from the
            // rate table when the entrant's model is listed there.
            costUsd: null,
          },
        }],
        turnEnded: true,
      };
    }
    if (type === 'error') {
      return {
        events: [this.errorEvent(stringValue(value.message) ?? 'Codex reported an error')],
      };
    }
    if (type !== 'item.started' && type !== 'item.completed') {
      this.recordUnknown(type ?? '<missing>');
      return { events: [] };
    }

    const item = objectValue(value.item);
    const itemType = stringValue(item?.type);
    if (item === undefined || itemType === undefined) {
      this.recordUnknown(`${type}/<missing item>`);
      return { events: [] };
    }

    if (type === 'item.started' && itemType === 'command_execution') {
      return {
        events: [{
          type: 'tool.call',
          payload: {
            entrantId: this.entrantId,
            tool: 'shell',
            detail: stringValue(item.command) ?? '',
          },
        }],
      };
    }
    if (type === 'item.completed' && itemType === 'command_execution') {
      const exitCode = nullableNumberValue(item.exit_code);
      return {
        events: [{
          type: 'tool.result',
          payload: {
            entrantId: this.entrantId,
            tool: 'shell',
            ok: exitCode === 0,
            detail: stringValue(item.aggregated_output) ?? '',
          },
        }],
      };
    }
    if (type === 'item.completed' && itemType === 'agent_message') {
      return {
        events: [{
          type: 'agent.message',
          payload: { entrantId: this.entrantId, text: stringValue(item.text) ?? '' },
        }],
      };
    }
    if (type === 'item.completed' && (itemType === 'reasoning' || itemType === 'reasoning_summary')) {
      return {
        events: [{
          type: 'agent.reasoning',
          payload: { entrantId: this.entrantId, text: reasoningText(item) },
        }],
      };
    }
    if (type === 'item.completed' && itemType === 'error') {
      return {
        events: [this.errorEvent(stringValue(item.message) ?? 'Codex item failed')],
      };
    }

    if (!knownItemType(itemType)) {
      const detail = genericToolDetail(item);
      if (type === 'item.started') {
        return {
          events: [{
            type: 'tool.call',
            payload: { entrantId: this.entrantId, tool: itemType, detail },
          }],
        };
      }
      return {
        events: [{
          type: 'tool.result',
          payload: {
            entrantId: this.entrantId,
            tool: itemType,
            ok: !genericToolFailed(item),
            detail,
          },
        }],
      };
    }

    this.recordUnknown(`${type}/${itemType}`);
    return { events: [] };
  }

  private errorEvent(message: string): ParsedArenaEvent {
    return {
      type: 'entrant.error',
      payload: { entrantId: this.entrantId, message },
    };
  }

  private recordUnknown(type: string): void {
    this.unknownEvents += 1;
    this.logger.info(`[codex parser] ignored unknown event ${type}`);
  }
}

function reasoningText(item: JsonObject): string {
  const direct = stringValue(item.text);
  if (direct !== undefined) return direct;
  const summary = item.summary;
  if (!Array.isArray(summary)) return '';
  return summary.map((part) => {
    if (typeof part === 'string') return part;
    return stringValue(objectValue(part)?.text) ?? '';
  }).filter(Boolean).join('\n');
}

function knownItemType(itemType: string): boolean {
  return itemType === 'command_execution'
    || itemType === 'agent_message'
    || itemType === 'reasoning'
    || itemType === 'reasoning_summary'
    || itemType === 'error';
}

function genericToolDetail(item: JsonObject): string {
  for (const field of ['command', 'path', 'name', 'query', 'title', 'text']) {
    const detail = stringValue(item[field]);
    if (detail !== undefined) return detail.slice(0, 2_000);
  }
  return '';
}

function genericToolFailed(item: JsonObject): boolean {
  const status = stringValue(item.status)?.toLowerCase();
  if (status === 'failed' || status === 'error') return true;
  return failureValue(item.error) || failureValue(item.message);
}

function failureValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseObject(line: string, logger: ParserLogger, harness: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
  } catch {
    // The warning below covers malformed JSON and non-object JSON values.
  }
  logger.warn(`[${harness} parser] skipped malformed line`);
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

function nullableNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
