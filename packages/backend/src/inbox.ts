import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { AgentTokenRecord } from './agent-auth.js';
import type { AgentInboxResponse } from './contract.js';
import { AgentInputError, AgentRequestLimit, checkAgentStrings } from './agent-limits.js';
import type { EventJournal } from './journal.js';
import type { ArenaDatabase } from './db/index.js';
import { inboxMessages } from './db/schema.js';

export const inboxAfterSchema = z.int().nonnegative().default(0);

const inboxQuery = z.strictObject({
  after: z.string().regex(/^\d+$/).transform(Number).optional().pipe(inboxAfterSchema),
});

export function enqueueMessage(database: ArenaDatabase, runId: string, entrantId: string, text: string, kind: 'steer' | 'broadcast'): void {
  database.insert(inboxMessages).values({
    runId, entrantId, text, kind,
    createdAt: new Date().toISOString(),
  }).run();
}

export class AgentInbox {
  private readonly polls: AgentRequestLimit;

  constructor(private readonly journal: EventJournal, now = Date.now) {
    this.polls = new AgentRequestLimit(1, 1000, now);
  }

  unread(identity: AgentTokenRecord): number {
    return this.journal.database.select({ count: count() }).from(inboxMessages)
      .where(and(eq(inboxMessages.runId, identity.runId), eq(inboxMessages.entrantId, identity.entrantId),
        isNull(inboxMessages.deliveredAt))).get()!.count;
  }

  read(identity: AgentTokenRecord, query: unknown): AgentInboxResponse {
    checkAgentStrings(query);
    this.polls.take(identity);
    const parsed = inboxQuery.safeParse(query);
    if (!parsed.success) throw new AgentInputError('Invalid after query value');
    const after = parsed.data.after;
    const { runId, entrantId } = identity;
    return this.journal.transaction(() => {
      const rows = this.journal.database.select().from(inboxMessages)
        .where(and(eq(inboxMessages.runId, runId), eq(inboxMessages.entrantId, entrantId), gt(inboxMessages.id, after)))
        .orderBy(asc(inboxMessages.id)).limit(50).all();
      const now = new Date().toISOString();
      for (const row of rows) {
        if (row.deliveredAt !== null) continue;
        this.journal.database.update(inboxMessages).set({ deliveredAt: now }).where(eq(inboxMessages.id, row.id)).run();
        this.journal.append(runId, entrantId, 'entrant.steered', { entrantId, text: row.text });
      }
      return {
        messages: rows.map((row) => ({ cursor: row.id, kind: row.kind, text: row.text, ts: row.createdAt })),
        cursor: rows.at(-1)?.id ?? after,
      };
    });
  }
}
