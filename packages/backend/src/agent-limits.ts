import type { AgentTokenRecord } from './agent-auth.js';
import type { EventJournal } from './journal.js';

const laneStates = new WeakMap<EventJournal, Set<Map<string, unknown>>>();

export function agentLaneState<T>(journal: EventJournal): Map<string, T> {
  const state = new Map<string, T>();
  const states = laneStates.get(journal) ?? new Set<Map<string, unknown>>();
  states.add(state);
  laneStates.set(journal, states);
  return state;
}

export function clearAgentLaneState(journal: EventJournal, runId: string, entrantId?: string): void {
  for (const state of laneStates.get(journal) ?? []) {
    if (entrantId !== undefined) state.delete(`${runId}:${entrantId}`);
    else for (const key of state.keys()) if (key.startsWith(`${runId}:`)) state.delete(key);
  }
}

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
  private readonly windows: Map<string, { start: number; count: number }>;

  constructor(private readonly limit: number, private readonly intervalMs: number, private readonly now = Date.now, journal?: EventJournal) {
    this.windows = journal === undefined ? new Map() : agentLaneState(journal);
  }

  take(identity: AgentTokenRecord): void {
    const now = this.now();
    const key = `${identity.runId}:${identity.entrantId}`;
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.intervalMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      throw new AgentRateLimitError(Math.max(1, Math.ceil((window.start + this.intervalMs - now) / 1000)));
    }
    window.count += 1;
  }
}
