import { z } from 'zod';

import { AGENT_BATCH_LIMIT, AGENT_STRING_LIMIT, AgentInputError, AgentBatchTooLargeError, AgentRequestLimit, checkAgentStrings } from './agent-limits.js';

import type { AgentTokenRecord } from './agent-auth.js';
import type { AgentEventInput, AgentEventsResponse, EntrantStatus } from './contract.js';
import type { ExternalStatus } from './adapters/external-status.js';
import { challengeAddressIndex } from './ctf/challenge-tracker.js';
import type { ChallengePackAccess } from './ctf/resolve.js';
import { trackProgress } from './ctf/track-progress.js';
import type { EventJournal } from './journal.js';
import { claudeHookToAgentEvents, claudeHookSchema } from './claude-hooks.js';

const seq = z.number().int();
const text = z.string().max(AGENT_STRING_LIMIT);
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
]).transform((event): AgentEventInput => {
  if (event.type !== 'usage') return event;
  const { cachedInputTokens, costUsd, ...required } = event;
  return {
    ...required,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}) satisfies z.ZodType<AgentEventInput, z.ZodTypeDef, unknown>;
const requestSchema = z.object({ events: z.array(eventSchema).min(1).max(AGENT_BATCH_LIMIT) }).strict();

export class AgentIngest {
  private readonly requests: AgentRequestLimit;
  // ExternalAgentTokens.states preserves record identity; a rejoined token gets fresh dedupe state.
  private readonly sequences = new WeakMap<AgentTokenRecord, Set<number>>();

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
      && Array.isArray(body.events) && body.events.length > AGENT_BATCH_LIMIT) {
      throw new AgentBatchTooLargeError(`A batch must contain at most ${AGENT_BATCH_LIMIT} events`);
    }
    checkAgentStrings(body);
    this.requests.take(identity);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new AgentInputError('Invalid event batch');
    return this.append(identity, parsed.data.events, true);
  }

  hook(identity: AgentTokenRecord, body: unknown): void {
    const parsed = claudeHookSchema.safeParse(body);
    const mapped = parsed.success ? claudeHookToAgentEvents(parsed.data) : [];
    checkAgentStrings(mapped);
    this.requests.take(identity);
    if (!parsed.success) throw new AgentInputError('Invalid Claude Code hook');
    this.append(identity, mapped, false);
  }

  private append(identity: AgentTokenRecord, events: AgentEventInput[], dedupe: boolean): AgentEventsResponse {
    const { runId, entrantId } = identity;
    // Set insertion order is the accepted sequence order, including out-of-order client numbers.
    const sequences = new Set(this.sequences.get(identity));
    let accepted = 0;
    let duplicates = 0;
    const index = challengeAddressIndex(this.addressesFor(runId) ?? {});
    this.journal.transaction(() => {
      let pending: EntrantStatus | undefined;
      for (const event of events) {
        if (dedupe && sequences.has(event.seq)) {
          duplicates += 1;
          continue;
        }
        if (event.type === 'entrant.status') {
          pending = event.status;
        } else {
          pending = 'working';
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
                trackProgress(this.journal, identity, event.text, 'message', index);
              }
              break;
            case 'tool.call':
              this.journal.append(runId, entrantId, event.type, {
                entrantId, tool: event.tool, toolCallId: event.toolCallId, detail: event.detail,
              });
              trackProgress(this.journal, identity, event.detail, 'command', index);
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
      if (pending !== undefined) this.status.set(runId, entrantId, pending);
      if (dedupe) this.journal.afterCommit(() => this.sequences.set(identity, sequences));
    });
    return { accepted, duplicates };
  }
}
