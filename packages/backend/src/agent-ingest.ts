import { z } from 'zod';

import type { AgentTokenRecord } from './agent-auth.js';
import type { AgentEventInput, AgentEventsResponse } from './contract.js';
import type { ExternalStatus } from './adapters/external-status.js';
import { challengeAddressIndex, matchChallenge, matchChallengeInProse } from './ctf/challenge-tracker.js';
import type { ChallengePackAccess } from './ctf/resolve.js';
import { trackProgress } from './ctf/track-progress.js';
import type { EventJournal } from './journal.js';
import { claudeHookToAgentEvents, claudeHookSchema } from './claude-hooks.js';

export const AGENT_BODY_LIMIT = 256 * 1024;
export class AgentInputError extends Error {}
export class AgentBatchTooLargeError extends Error {}
export class AgentRateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super('Request limit reached');
  }
}

const seq = z.number().int();
const text = z.string().max(16_000);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ seq, type: z.literal('agent.message'), text }).strict(),
  z.object({ seq, type: z.literal('agent.reasoning'), text }).strict(),
  z.object({ seq, type: z.literal('tool.call'), tool: text, toolCallId: text, detail: text }).strict(),
  z.object({ seq, type: z.literal('tool.result'), tool: text, toolCallId: text, ok: z.boolean(), detail: text }).strict(),
  z.object({
    seq, type: z.literal('usage'), inputTokens: z.number().finite(), outputTokens: z.number().finite(),
    cachedInputTokens: z.number().finite().optional(), costUsd: z.number().finite().nullable().optional(),
  }).strict(),
  z.object({ seq, type: z.literal('entrant.status'), status: z.enum(['working', 'idle', 'blocked', 'done']) }).strict(),
]);
const requestSchema = z.object({ events: z.array(eventSchema).min(1).max(100) }).strict();

// Walk iteratively because hook extensions can contain deeply nested JSON.
export function checkAgentStrings(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === 'string' && item.length > 16_000) {
      throw new AgentInputError('String fields must contain at most 16000 characters');
    }
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push(child);
    }
  }
}

export class AgentRequestLimit {
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

export class AgentIngest {
  private readonly requests: AgentRequestLimit;
  private readonly sequences = new WeakMap<AgentTokenRecord, Set<number>>();
  private hookSeq = 0;

  constructor(
    private readonly journal: EventJournal,
    private readonly status: ExternalStatus,
    private readonly addressesFor: ChallengePackAccess['addressesFor'],
    now = Date.now,
  ) {
    this.requests = new AgentRequestLimit(30, 10_000, now);
  }

  events(identity: AgentTokenRecord, body: unknown): AgentEventsResponse {
    if (body !== null && typeof body === 'object' && 'events' in body
      && Array.isArray(body.events) && body.events.length > 100) {
      throw new AgentBatchTooLargeError('A batch must contain at most 100 events');
    }
    checkAgentStrings(body);
    this.requests.take(identity);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new AgentInputError('Invalid event batch');
    return this.append(identity, parsed.data.events as AgentEventInput[], true);
  }

  hook(identity: AgentTokenRecord, body: unknown): void {
    checkAgentStrings(body);
    const parsed = claudeHookSchema.safeParse(body);
    const mapped = parsed.success ? claudeHookToAgentEvents(parsed.data) : [];
    checkAgentStrings(mapped);
    this.requests.take(identity);
    if (!parsed.success) throw new AgentInputError('Invalid Claude Code hook');
    const events = mapped.map((event) => ({ ...event, seq: ++this.hookSeq }));
    this.append(identity, events, false);
  }

  private append(identity: AgentTokenRecord, events: AgentEventInput[], dedupe: boolean): AgentEventsResponse {
    const { runId, entrantId } = identity;
    // Set insertion order is the accepted sequence order, including out-of-order client numbers.
    const sequences = new Set(this.sequences.get(identity));
    let accepted = 0;
    let duplicates = 0;
    const index = challengeAddressIndex(this.addressesFor(runId) ?? {});
    this.journal.transaction(() => {
      for (const event of events) {
        if (dedupe && sequences.has(event.seq)) {
          duplicates += 1;
          continue;
        }
        if (event.type === 'entrant.status') {
          this.status.set(runId, entrantId, event.status);
        } else {
          this.status.touch(runId, entrantId);
          switch (event.type) {
            case 'usage':
              this.journal.append(runId, entrantId, event.type, {
                entrantId, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
                cachedInputTokens: event.cachedInputTokens ?? 0, costUsd: event.costUsd ?? null,
              });
              break;
            case 'agent.message':
            case 'agent.reasoning':
              this.journal.append(runId, entrantId, event.type, { entrantId, text: event.text });
              if (event.type === 'agent.message') {
                trackProgress(this.journal, runId, entrantId, event.text, 'message', index, matchChallengeInProse);
              }
              break;
            case 'tool.call':
              this.journal.append(runId, entrantId, event.type, {
                entrantId, tool: event.tool, toolCallId: event.toolCallId, detail: event.detail,
              });
              trackProgress(this.journal, runId, entrantId, event.detail, 'command', index, matchChallenge);
              break;
            case 'tool.result':
              this.journal.append(runId, entrantId, event.type, {
                entrantId, tool: event.tool, toolCallId: event.toolCallId, detail: event.detail, ok: event.ok,
              });
          }
        }
        accepted += 1;
        if (dedupe) {
          sequences.add(event.seq);
          if (sequences.size > 1000) sequences.delete(sequences.values().next().value!);
        }
      }
      if (dedupe) this.journal.afterCommit(() => this.sequences.set(identity, sequences));
    });
    return { accepted, duplicates };
  }
}
