import type { EntrantContainer } from '../runtime/container.js';
import type { RecoveredUsage, UsageTotals } from './parser-types.js';

type JsonObject = Record<string, unknown>;

const SESSION_READ_TIMEOUT_MS = 30_000;
const SESSION_READ_MAX_BYTES = 64 * 1024 * 1024;

interface SessionReadLimits {
  timeoutMs?: number;
  maxBytes?: number;
}

export async function readSessionJsonl(
  container: EntrantContainer,
  root: string,
  limits: SessionReadLimits = {},
): Promise<string[]> {
  const execution = await container.exec([
    'find', root, '-type', 'f', '-name', '*.jsonl', '-exec', 'cat', '{}', '+',
  ]);
  const timeoutMs = limits.timeoutMs ?? SESSION_READ_TIMEOUT_MS;
  const maxBytes = limits.maxBytes ?? SESSION_READ_MAX_BYTES;
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    // Reject independently: a wedged runner may never acknowledge the kill or
    // close the iterator, and usage recovery must not hold stop/teardown open.
    rejectTimeout(new Error('session transcript read timed out'));
    void execution.kill().catch(() => undefined);
  }, timeoutMs);
  timer.unref();

  const consume = async (): Promise<string[]> => {
    const lines: string[] = [];
    let bytes = 0;
    for await (const output of execution) {
      if (output.stream !== 'out') continue;
      bytes += Buffer.byteLength(output.line, 'utf8');
      if (bytes > maxBytes) {
        // Cleanup is best effort and must not delay the limit failure.
        void execution.kill().catch(() => undefined);
        throw new Error('session transcripts exceed the 64 MiB recovery limit');
      }
      lines.push(output.line);
    }
    const code = await execution.exit;
    if (code !== 0) throw new Error(`session transcript read exited with code ${String(code)}`);
    return lines;
  };

  try {
    return await Promise.race([consume(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function codexSessionUsage(
  lines: readonly string[],
  activeSessionId?: string,
): RecoveredUsage | undefined {
  const sessions = new Map<string, UsageTotals>();
  let sessionId = 'unknown';
  for (const line of lines) {
    const value = parseObject(line);
    const payload = objectValue(value?.payload);
    if (stringValue(value?.type) === 'session_meta') {
      sessionId = stringValue(payload?.id) ?? sessionId;
      continue;
    }
    if (stringValue(value?.type) !== 'event_msg' || stringValue(payload?.type) !== 'token_count') continue;
    const usage = objectValue(objectValue(payload?.info)?.total_token_usage);
    if (usage === undefined) continue;
    const totals = {
      inputTokens: numberValue(usage.input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      cachedInputTokens: numberValue(usage.cached_input_tokens),
    };
    const previous = sessions.get(sessionId);
    sessions.set(sessionId, previous === undefined ? totals : maximumUsage(previous, totals));
  }
  if (sessions.size === 0) return undefined;
  const totals = [...sessions.values()].reduce<UsageTotals>(sumUsage, emptyUsage());
  const active = activeSessionId === undefined ? undefined : sessions.get(activeSessionId);
  const single = sessions.size === 1 ? sessions.values().next().value : undefined;
  const parserTotals = active ?? single;
  return { totals, ...(parserTotals === undefined ? {} : { parserTotals }) };
}

export function claudeSessionUsage(lines: readonly string[]): RecoveredUsage | undefined {
  const messages = new Map<string, UsageTotals>();
  let anonymous = 0;
  for (const line of lines) {
    const value = parseObject(line);
    if (stringValue(value?.type) !== 'assistant') continue;
    const message = objectValue(value?.message);
    const usage = objectValue(message?.usage);
    if (usage === undefined) continue;
    const cachedInputTokens = numberValue(usage.cache_read_input_tokens);
    const totals = {
      inputTokens: numberValue(usage.input_tokens)
        + cachedInputTokens
        + numberValue(usage.cache_creation_input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      cachedInputTokens,
    };
    const key = stringValue(message?.id)
      ?? stringValue(value?.request_id)
      ?? stringValue(value?.uuid)
      ?? `anonymous-${++anonymous}`;
    const previous = messages.get(key);
    messages.set(key, previous === undefined ? totals : maximumUsage(previous, totals));
  }
  if (messages.size === 0) return undefined;
  return { totals: [...messages.values()].reduce<UsageTotals>(sumUsage, emptyUsage()) };
}

function sumUsage(sum: UsageTotals, usage: UsageTotals): UsageTotals {
  return {
    inputTokens: sum.inputTokens + usage.inputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens,
    cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
  };
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function maximumUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
  };
}

function parseObject(line: string): JsonObject | undefined {
  try {
    return objectValue(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
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
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
