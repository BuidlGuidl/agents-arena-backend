import type { ExternalStatus } from './external-status.js';
import { enqueueMessage } from '../inbox.js';
import type { EventJournal } from '../journal.js';
import {
  assertExternal, EntrantOperationError, EntrantUnavailableError,
  type EntrantDriver, type EntrantRecord, type RunRecord,
} from './types.js';

export class ExternalDriver implements EntrantDriver {
  constructor(
    private readonly journal: EventJournal,
    private readonly status: ExternalStatus,
  ) {}

  async prepare(_run: RunRecord, entrant: EntrantRecord): Promise<void> {
    assertExternal(entrant);
  }

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    assertExternal(entrant);
    if (entrant.removedAt !== null) return;
    this.journal.append(run.id, entrant.id, 'entrant.prompt', { entrantId: entrant.id, text: openingPrompt });
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
      this.status.set(runId, entrantId, 'done');
    });
  }
}
