import { and, eq } from 'drizzle-orm';

import { ExternalAgentTokens } from '../agent-auth.js';
import { entrants } from '../db/schema.js';
import { enqueueMessage } from '../inbox.js';
import type { EventJournal } from '../journal.js';
import {
  EntrantOperationError, EntrantUnavailableError,
  type EntrantDriver, type EntrantRecord, type ExternalEntrantRecord, type RunRecord,
} from './types.js';

function assertExternal(entrant: EntrantRecord): asserts entrant is ExternalEntrantRecord {
  if (entrant.kind !== 'external') throw new Error('Expected an external entrant');
}

export class ExternalDriver implements EntrantDriver {
  constructor(
    private readonly journal: EventJournal,
    private readonly tokens = new ExternalAgentTokens(journal.database),
  ) {}

  async prepare(_run: RunRecord, entrant: EntrantRecord): Promise<void> {
    assertExternal(entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    assertExternal(entrant);
    if (entrant.removedAt !== null) return;
    this.journal.append(run.id, entrant.id, 'entrant.prompt', { entrantId: entrant.id, text: openingPrompt });
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<'queued'> {
    assertExternal(entrant);
    if (entrant.removedAt !== null) throw new EntrantUnavailableError('Entrant was removed');
    enqueueMessage(this.journal.database, run.id, entrant.id, text);
    return 'queued';
  }

  async restart(_run: RunRecord, entrant: EntrantRecord): Promise<void> {
    assertExternal(entrant);
    throw new EntrantOperationError('External entrants cannot be restarted');
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    assertExternal(entrant);
    this.finish(run.id, entrant.id);
  }

  finish(runId: string, entrantId: string): void {
    this.journal.transaction(() => {
      this.tokens.revoke(runId, entrantId);
      const where = and(eq(entrants.runId, runId), eq(entrants.id, entrantId));
      const current = this.journal.database.select({ status: entrants.status }).from(entrants).where(where).get();
      if (current?.status === 'done') return;
      this.journal.database.update(entrants).set({ status: 'done' }).where(where).run();
      this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status: 'done' });
    });
  }
}
