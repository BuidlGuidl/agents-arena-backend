import { z } from 'zod';

import type { AgentTokenRecord } from './agent-auth.js';
import { AgentInputError, AgentRateLimitError, agentLaneState } from './agent-limits.js';
import type { ExternalStatus } from './adapters/external-status.js';
import { mayMove, recordCurrentChallenge } from './ctf/challenge-tracker.js';
import { CHALLENGE_COUNT } from './ctf/pack.js';
import type { EventJournal } from './journal.js';

const agentProgressSchema = z.object({
  challengeId: z.number().int().min(1).max(CHALLENGE_COUNT),
}).strict();
// Journalled announcements are rate limited; repeats of the same value are
// deduped before the limit so they stay cheap instead of burning the budget.
const AGENT_ANNOUNCE_INTERVAL_MS = 1_000;

export class AgentProgress {
  private readonly lastAnnouncedAtMs: Map<string, number>;

  constructor(private readonly journal: EventJournal, private readonly status: ExternalStatus) {
    this.lastAnnouncedAtMs = agentLaneState(journal);
  }

  announce(identity: AgentTokenRecord, value: unknown): { ok: boolean; changed: boolean } {
    const body = agentProgressSchema.safeParse(value);
    if (!body.success) {
      throw new AgentInputError(`challengeId must be an integer from 1 to ${CHALLENGE_COUNT}`);
    }

    const { challengeId } = body.data;
    if (!mayMove(identity.runId, identity.entrantId, challengeId, 'self')) {
      return { ok: true, changed: false };
    }
    const now = Date.now();
    const key = `${identity.runId}:${identity.entrantId}`;
    const lastAnnouncedAtMs = this.lastAnnouncedAtMs.get(key);
    if (
      lastAnnouncedAtMs !== undefined
      && now - lastAnnouncedAtMs < AGENT_ANNOUNCE_INTERVAL_MS
    ) {
      throw new AgentRateLimitError(1);
    }
    // State moves only after the journal accepts the event: an append that
    // throws must leave the retry journalling, not deduping into silence.
    this.journal.transaction(() => {
      this.journal.append(identity.runId, identity.entrantId, 'entrant.challenge', {
        entrantId: identity.entrantId, challengeId, via: 'self', evidence: 'announced',
      });
      this.status.touch(identity.runId, identity.entrantId);
      this.journal.afterCommit(() => recordCurrentChallenge(identity.runId, identity.entrantId, challengeId, 'self'));
      this.journal.afterCommit(() => this.lastAnnouncedAtMs.set(key, now));
    });
    return { ok: true, changed: true };
  }
}
