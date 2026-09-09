import { z } from 'zod';

import { AGENT_BATCH_LIMIT, AGENT_STRING_LIMIT, AgentInputError, AgentBatchTooLargeError, AgentRequestLimit, checkAgentStrings } from './agent-limits.js';

import type { AgentTokenRecord } from './agent-auth.js';
import type { AgentEventInput, AgentEventsResponse, EntrantStatus } from './contract.js';
import type { ExternalStatus } from './adapters/external-status.js';
import { challengeAddressIndex } from './ctf/challenge-tracker.js';
import type { ChallengePackAccess } from './ctf/resolve.js';
import { trackProgress } from './ctf/track-progress.js';
import type { EventJournal } from './journal.js';

const seq = z.number().int();
const text = z.string().max(AGENT_STRING_LIMIT);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ seq, type: z.literal('agent.message'), text }).strict(),
  z.object({ seq, type: z.literal('entrant.status'), status: z.enum(['working', 'idle', 'blocked', 'done']) }).strict(),
]) satisfies z.ZodType<AgentEventInput, z.ZodTypeDef, unknown>;
const requestSchema = z.object({ events: z.array(eventSchema).min(1).max(AGENT_BATCH_LIMIT) }).strict();

export class AgentIngest {
  private readonly requests: AgentRequestLimit;
  // Rejoins preserve record identity and dedupe state; rotation starts a fresh window.
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

  postNote(identity: AgentTokenRecord, text: string, status?: EntrantStatus): AgentEventsResponse {
    const events: AgentEventInput[] = [{ seq: 0, type: 'agent.message', text }];
    if (status !== undefined) events.push({ seq: 1, type: 'entrant.status', status });
    checkAgentStrings(events);
    this.requests.take(identity);
    return this.append(identity, events, false);
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
      let activity = false;
      for (const event of events) {
        if (dedupe && sequences.has(event.seq)) {
          duplicates += 1;
          continue;
        }
        if (event.type === 'entrant.status') {
          pending = event.status;
        } else {
          activity = true;
          this.journal.append(runId, entrantId, event.type, { entrantId, text: event.text });
          trackProgress(this.journal, identity, event.text, 'message', index);
        }
        accepted += 1;
        if (dedupe) {
          sequences.add(event.seq);
          if (sequences.size > 1000) sequences.delete(sequences.values().next().value!);
        }
      }
      if (pending !== undefined) this.status.set(runId, entrantId, pending);
      else if (activity) this.status.touch(runId, entrantId);
      if (dedupe) this.journal.afterCommit(() => this.sequences.set(identity, sequences));
    });
    return { accepted, duplicates };
  }
}
