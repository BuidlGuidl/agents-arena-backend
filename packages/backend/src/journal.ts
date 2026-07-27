import { and, asc, desc, eq, gt, inArray, lt, max } from 'drizzle-orm';

import type { ArenaEvent, HistoryPage } from './contract.js';
import { openArenaDatabase, type ArenaDatabase } from './db/index.js';
import { events } from './db/schema.js';

export const EVENT_TEXT_LIMIT = 4_000;
export type { HistoryPage } from './contract.js';

type EventType = ArenaEvent['type'];
type EventOfType<T extends EventType> = Extract<ArenaEvent, { type: T }>;
type EventPayload<T extends EventType> = EventOfType<T>['payload'];
type Subscriber = (event: ArenaEvent) => void;
type TruncationReceipt = NonNullable<ArenaEvent['truncated']>;

// The journal always knows the run head; only the wire shape drops it.
export type JournalPage = HistoryPage & { lastEventId: number };

export interface HistoryQuery {
  limit: number;
  before?: number;
  types?: ArenaEvent['type'][];
  sources?: string[];
}

export class EventJournal {
  readonly database: ArenaDatabase;

  private readonly sqlite: ReturnType<typeof openArenaDatabase>['sqlite'];
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(path = process.env.ARENA_DB ?? './arena.db') {
    const opened = openArenaDatabase(path);
    this.database = opened.database;
    this.sqlite = opened.sqlite;
  }

  append<T extends EventType>(
    runId: string,
    source: string,
    type: T,
    payload: EventPayload<T>,
  ): EventOfType<T> {
    const capped = capPayload(payload);
    const event = this.database.transaction((transaction) => {
      const sequence = transaction
        .select({ current: max(events.seq) })
        .from(events)
        .where(and(eq(events.runId, runId), eq(events.source, source)))
        .get();
      const seq = (sequence?.current ?? 0) + 1;
      const ts = new Date().toISOString();
      const inserted = transaction
        .insert(events)
        .values({
          runId,
          source,
          seq,
          ts,
          type,
          payloadJson: JSON.stringify(capped.payload),
          truncatedJson: capped.truncated === undefined ? null : JSON.stringify(capped.truncated),
        })
        .returning({ id: events.id })
        .get();
      return {
        id: inserted.id,
        runId,
        source,
        seq,
        ts,
        type,
        payload: capped.payload,
        ...(capped.truncated === undefined ? {} : { truncated: capped.truncated }),
      } as EventOfType<T>;
    });

    for (const subscriber of this.subscribers.get(runId) ?? []) {
      subscriber(event);
    }
    return event;
  }

  after(runId: string, afterId: number): ArenaEvent[] {
    return this.database
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.id, afterId)))
      .orderBy(asc(events.id))
      .all()
      .map(toArenaEvent);
  }

  // One transaction keeps the page and lastEventId at the same journal head.
  // SSE resumes above lastEventId, so separate reads could lose an event.
  history(runId: string, query: HistoryQuery): JournalPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new RangeError('History limit must be an integer of at least 1');
    }
    return this.database.transaction((transaction) => {
      const lastEvent = transaction
        .select({ id: max(events.id) })
        .from(events)
        .where(eq(events.runId, runId))
        .get();
      const filters = [eq(events.runId, runId)];
      if (query.before !== undefined) filters.push(lt(events.id, query.before));
      if (query.types !== undefined) filters.push(inArray(events.type, query.types));
      if (query.sources !== undefined) filters.push(inArray(events.source, query.sources));
      const rows = transaction
        .select()
        .from(events)
        .where(and(...filters))
        .orderBy(desc(events.id))
        .limit(query.limit + 1)
        .all();
      const hasMore = rows.length > query.limit;

      return {
        events: rows.slice(0, query.limit).reverse().map(toArenaEvent),
        lastEventId: lastEvent?.id ?? 0,
        hasMore,
      };
    });
  }

  subscribe(runId: string, subscriber: Subscriber): () => void {
    const runSubscribers = this.subscribers.get(runId) ?? new Set<Subscriber>();
    runSubscribers.add(subscriber);
    this.subscribers.set(runId, runSubscribers);

    return () => {
      runSubscribers.delete(subscriber);
      if (runSubscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  close(): void {
    this.subscribers.clear();
    this.sqlite.close();
  }
}

function capPayload<T extends EventType>(
  payload: EventPayload<T>,
): { payload: EventPayload<T>; truncated?: TruncationReceipt } {
  const cappedPayload: Record<string, unknown> = { ...payload };
  const truncated: TruncationReceipt = {};
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value !== 'string' || value.length <= EVENT_TEXT_LIMIT) continue;
    const boundaryCodeUnit = value.charCodeAt(EVENT_TEXT_LIMIT - 1);
    const nextCodeUnit = value.charCodeAt(EVENT_TEXT_LIMIT);
    const truncationEnd = boundaryCodeUnit >= 0xD800
      && boundaryCodeUnit <= 0xDBFF
      && nextCodeUnit >= 0xDC00
      && nextCodeUnit <= 0xDFFF
      ? EVENT_TEXT_LIMIT - 1
      : EVENT_TEXT_LIMIT;
    cappedPayload[field] = value.slice(0, truncationEnd);
    truncated[field] = {
      fullLength: value.length,
      lines: value.split('\n').length,
    };
  }
  return {
    payload: cappedPayload as EventPayload<T>,
    ...(Object.keys(truncated).length === 0 ? {} : { truncated }),
  };
}

function toArenaEvent(row: typeof events.$inferSelect): ArenaEvent {
  return {
    id: row.id,
    runId: row.runId,
    source: row.source,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as ArenaEvent['payload'],
    ...(row.truncatedJson === null
      ? {}
      : { truncated: JSON.parse(row.truncatedJson) as TruncationReceipt }),
  } as ArenaEvent;
}
