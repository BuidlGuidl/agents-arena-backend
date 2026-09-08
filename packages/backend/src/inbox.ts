import type { ArenaDatabase } from './db/index.js';
import { inboxMessages } from './db/schema.js';

export function enqueueMessage(database: ArenaDatabase, runId: string, entrantId: string, text: string, kind: 'steer' | 'broadcast'): void {
  database.insert(inboxMessages).values({
    runId, entrantId, text, kind,
    createdAt: new Date().toISOString(),
  }).run();
}
