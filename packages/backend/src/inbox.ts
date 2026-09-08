import { AsyncLocalStorage } from 'node:async_hooks';

import type { ArenaDatabase } from './db/index.js';
import { inboxMessages } from './db/schema.js';

type InboxKind = 'steer' | 'broadcast';
// Carry the operator's intent through the existing steer seam, including async fan-out.
const messageKind = new AsyncLocalStorage<InboxKind>();

export function withInboxKind<T>(kind: InboxKind, action: () => T): T {
  return messageKind.run(kind, action);
}

export function enqueueMessage(database: ArenaDatabase, runId: string, entrantId: string, text: string): void {
  database.insert(inboxMessages).values({
    runId, entrantId, text, kind: messageKind.getStore() ?? 'steer',
    createdAt: new Date().toISOString(),
  }).run();
}
