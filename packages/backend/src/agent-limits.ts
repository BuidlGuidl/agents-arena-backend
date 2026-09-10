import type { AgentTokenRecord } from './agent-auth.js';

export const AGENT_BODY_LIMIT = 256 * 1024;
export const AGENT_BATCH_LIMIT = 100;
export const AGENT_STRING_LIMIT = 16_000;

export class AgentInputError extends Error {}
export class AgentBatchTooLargeError extends Error {}
export class AgentRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super('Request limit reached');
  }
}

// Walk iteratively because request bodies can contain deeply nested JSON.
export function checkAgentStrings(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string' && item.length > AGENT_STRING_LIMIT) {
      throw new AgentInputError(`String fields must contain at most ${AGENT_STRING_LIMIT} characters`);
    }
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
    }
  }
}

export class AgentRequestLimit {
  // AgentTokens.states preserves record identity; a rotated token gets fresh rate state.
  private readonly windows = new WeakMap<AgentTokenRecord, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly intervalMs: number, private readonly now = Date.now) {}

  take(identity: AgentTokenRecord): void {
    const now = this.now();
    let window = this.windows.get(identity);
    if (window === undefined || now - window.start >= this.intervalMs) {
      window = { start: now, count: 0 };
      this.windows.set(identity, window);
    }
    if (window.count >= this.limit) {
      throw new AgentRateLimitError(Math.max(1, Math.ceil((window.start + this.intervalMs - now) / 1000)));
    }
    window.count += 1;
  }
}
