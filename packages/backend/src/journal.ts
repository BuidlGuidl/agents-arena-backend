import { and, asc, desc, eq, gt, inArray, lt, max } from 'drizzle-orm';

import { credentialSecrets } from './adapters/credential-secrets.js';
import { agentTokenSecrets } from './agent-auth.js';
import { runKeySecrets } from './chain/wallet.js';
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
  private readonly pendingNotifications: ArenaEvent[][] = [];

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
    const serializedPayload = JSON.stringify(payload);
    // Entrant output can echo wallet, harness, and arena credentials, so scrub
    // live values before storage and delivery.
    const payloadJson = redactExactSecrets(serializedPayload, [
      ...runKeySecrets(runId),
      ...credentialSecrets(runId),
      ...agentTokenSecrets(runId),
    ]);
    const journalPayload = payloadJson === serializedPayload
      ? payload
      : JSON.parse(payloadJson) as EventPayload<T>;
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
        .values({ runId, source, seq, ts, type, payloadJson })
        .returning({ id: events.id })
        .get();
      return {
        id: inserted.id,
        runId,
        source,
        seq,
        ts,
        type,
        payload: journalPayload,
      } as EventOfType<T>;
    });

    const pending = this.pendingNotifications.at(-1);
    if (pending === undefined) {
      this.notify(event);
    } else {
      pending.push(event);
    }
    return event;
  }

  transaction<T>(action: () => T): T {
    const notifications: ArenaEvent[] = [];
    this.pendingNotifications.push(notifications);
    let result: T;
    try {
      result = this.database.transaction(action);
    } catch (error) {
      this.pendingNotifications.pop();
      throw error;
    }
    this.pendingNotifications.pop();
    const parent = this.pendingNotifications.at(-1);
    if (parent === undefined) {
      for (const event of notifications) this.notify(event);
    } else {
      parent.push(...notifications);
    }
    return result;
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

  private notify(event: ArenaEvent): void {
    for (const subscriber of this.subscribers.get(event.runId) ?? []) {
      subscriber(event);
    }
  }
}

function redactExactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    const lowerValue = redacted.toLowerCase();
    const lowerSecret = secret.toLowerCase();
    let cursor = 0;
    let match = lowerValue.indexOf(lowerSecret, cursor);
    if (match === -1) continue;

    const parts: string[] = [];
    while (match !== -1) {
      parts.push(redacted.slice(cursor, match), '[redacted-key]');
      cursor = match + secret.length;
      match = lowerValue.indexOf(lowerSecret, cursor);
    }
    parts.push(redacted.slice(cursor));
    redacted = parts.join('');
  }
  return redacted;
}

// The journal retains full payloads, so wire responses cap strings separately.
export function capEvent(event: ArenaEvent): ArenaEvent {
  // Null-prototype so a payload key of `__proto__` records a receipt entry
  // instead of hitting the prototype setter and being cut without one.
  const truncated: TruncationReceipt = Object.create(null) as TruncationReceipt;
  const payload = capValue(event.payload, '', truncated, 0) as ArenaEvent['payload'];
  const capped = { ...event, payload } as ArenaEvent;
  if (Object.keys(truncated).length === 0) {
    delete capped.truncated;
  } else {
    capped.truncated = truncated;
  }
  return capped;
}

// Payloads are flat today. The bound only exists so a future nested shape
// cannot overflow the stack on the SSE path, where a throw kills the stream.
const MAX_CAP_DEPTH = 64;

function capValue(
  value: unknown,
  path: string,
  truncated: TruncationReceipt,
  depth: number,
): unknown {
  if (depth > MAX_CAP_DEPTH) return value;
  if (typeof value === 'string') {
    if (value.length <= EVENT_TEXT_LIMIT) return value;
    const boundaryCodeUnit = value.charCodeAt(EVENT_TEXT_LIMIT - 1);
    const nextCodeUnit = value.charCodeAt(EVENT_TEXT_LIMIT);
    const truncationEnd = boundaryCodeUnit >= 0xD800
      && boundaryCodeUnit <= 0xDBFF
      && nextCodeUnit >= 0xDC00
      && nextCodeUnit <= 0xDFFF
      ? EVENT_TEXT_LIMIT - 1
      : EVENT_TEXT_LIMIT;
    truncated[path] = {
      fullLength: value.length,
      lines: value.split('\n').length,
    };
    return value.slice(0, truncationEnd);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      capValue(item, joinPath(path, String(index)), truncated, depth + 1));
  }
  // Anything not a plain object passes through uncapped, and a key containing a
  // dot collides with a nested path. Both need handling before a payload type
  // gains a class instance, a `toJSON`, or a caller-supplied key.
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    capValue(item, joinPath(path, key), truncated, depth + 1),
  ]));
}

function joinPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  } as ArenaEvent;
}
