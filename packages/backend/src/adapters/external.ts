import { ExternalAgentTokens } from '../agent-auth.js';
import { externalStatusFor, type ExternalStatus, type ExternalStatusOptions } from './external-status.js';
import { enqueueMessage } from '../inbox.js';
import type { EventJournal } from '../journal.js';
import {
  assertExternal, EntrantOperationError, EntrantUnavailableError,
  type EntrantDriver, type EntrantRecord, type RunRecord,
} from './types.js';

export class ExternalDriver implements EntrantDriver {
  private readonly status: ExternalStatus;

  constructor(
    private readonly journal: EventJournal,
    private readonly tokens = new ExternalAgentTokens(journal.database),
    statusOptions: ExternalStatusOptions = {},
  ) {
    this.status = externalStatusFor(journal, statusOptions);
  }

  async prepare(_run: RunRecord, entrant: EntrantRecord): Promise<void> {
    assertExternal(entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    assertExternal(entrant);
    if (entrant.removedAt !== null) return;
    this.journal.append(run.id, entrant.id, 'entrant.prompt', { entrantId: entrant.id, text: openingPrompt });
    this.status.set(run.id, entrant.id, entrant.status);
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string, origin: 'steer' | 'broadcast' = 'steer'): Promise<'queued'> {
    assertExternal(entrant);
    if (entrant.removedAt !== null) throw new EntrantUnavailableError('Entrant was removed');
    enqueueMessage(this.journal.database, run.id, entrant.id, text, origin);
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

  private finish(runId: string, entrantId: string): void {
    this.journal.transaction(() => {
      this.tokens.revoke(runId, entrantId);
      this.status.set(runId, entrantId, 'done');
    });
  }
}
