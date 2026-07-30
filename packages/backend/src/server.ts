import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Hex } from 'viem';
import { z } from 'zod';

import type { ArenaEvent, BroadcastResponse, CreateRunRequest } from './contract.js';
import type { Schedule } from './adapters/fake.js';
import { RegisteredEntrantDriver } from './adapters/registered.js';
import { EntrantUnavailableError, type EntrantDriver } from './adapters/types.js';
import { eventTypes } from './db/schema.js';
import { capEvent, EventJournal } from './journal.js';
import {
  type FundingGate,
  EntrantNotFoundError,
  InvalidTransitionError,
  RunManager,
  type RunManagerOptions,
  RunNotFoundError,
  SeedSignatureError,
  SeedStateConflictError,
  type SolveWatch,
  UnknownPresetError,
} from './run-manager.js';

const createRunSchema = z.object({
  preset: z.string().min(1),
  autoStart: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional(),
}).strict();

// Steer and broadcast carry the same body; only the fan-out differs.
const textSchema = z.object({ text: z.string().min(1) }).strict();
const seedSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
const eventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().optional() });
const decimalIntegerSchema = z.string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const historyQuerySchema = z.object({
  limit: decimalIntegerSchema.pipe(z.number().int().min(1).max(200)).default('50'),
  before: decimalIntegerSchema.pipe(z.number().int().min(1)).optional(),
  types: z.string().optional(),
  source: z.string().optional(),
}).strict();

export interface ServerOptions {
  dbPath?: string;
  schedule?: Schedule;
  driverFactory?: (journal: EventJournal) => EntrantDriver;
  fundingGateFactory?: (journal: EventJournal) => FundingGate;
  solveWatchFactory?: (journal: EventJournal) => SolveWatch;
  logger?: boolean;
}

export interface ArenaServer {
  app: ReturnType<typeof Fastify>;
  journal: EventJournal;
  manager: RunManager;
}

export function createServer(options: ServerOptions = {}): ArenaServer {
  const app = Fastify({ logger: options.logger ?? false });
  const journal = new EventJournal(options.dbPath);
  const driver = options.driverFactory?.(journal) ?? new RegisteredEntrantDriver(journal, options.schedule);
  const runManagerOptions: RunManagerOptions = {
    ...(options.solveWatchFactory === undefined
      ? {}
      : { solveWatch: options.solveWatchFactory(journal) }),
  };
  const manager = new RunManager(
    journal,
    driver,
    options.fundingGateFactory?.(journal),
    runManagerOptions,
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunNotFoundError || error instanceof EntrantNotFoundError) {
      void reply.status(404).send({ error: error.message });
      return;
    }
    if (error instanceof InvalidTransitionError || error instanceof UnknownPresetError) {
      void reply.status(400).send({ error: error.message });
      return;
    }
    if (error instanceof SeedStateConflictError) {
      void reply.status(409).send({ error: error.message });
      return;
    }
    if (error instanceof SeedSignatureError) {
      void reply.status(403).send({ error: error.message });
      return;
    }
    // The entrant is real but cannot take a turn right now, so the operator can retry.
    if (error instanceof EntrantUnavailableError) {
      void reply.status(409).send({ error: error.message });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: 'Internal server error' });
  });

  app.post('/runs', async (request, reply) => {
    const body = parseBody(createRunSchema, request.body, reply);
    if (body === undefined) return;
    const input: CreateRunRequest = {
      preset: body.preset,
      ...(body.autoStart === undefined ? {} : { autoStart: body.autoStart }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
    };
    const result = await manager.create(input);
    return reply.status(result.created ? 201 : 200).send({ run: result.run });
  });

  app.get('/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { run: manager.snapshot(id) };
  });

  app.post('/runs/:id/start', async (request) => {
    const { id } = request.params as { id: string };
    return { run: await manager.startForRequest(id) };
  });

  app.post('/runs/:id/seed', async (request, reply) => {
    const body = parseBody(seedSchema, request.body, reply);
    if (body === undefined) return;
    const { id } = request.params as { id: string };
    const run = await manager.submitSeed(id, body.signature as Hex);
    return reply.status(202).send({ run });
  });

  app.post('/runs/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    return { run: await manager.stop(id) };
  });

  app.post('/runs/:id/entrants/:entrantId/steer', async (request, reply) => {
    const body = parseBody(textSchema, request.body, reply);
    if (body === undefined) return;
    const { id, entrantId } = request.params as { id: string; entrantId: string };
    await manager.steer(id, entrantId, body.text);
    return reply.status(202).send({ accepted: true });
  });

  app.post('/runs/:id/broadcast', async (request, reply) => {
    const body = parseBody(textSchema, request.body, reply);
    if (body === undefined) return;
    const { id } = request.params as { id: string };
    const result = await manager.broadcast(id, body.text);
    const response: BroadcastResponse = { accepted: true, ...result };
    return reply.status(202).send(response);
  });

  app.get('/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!manager.hasRun(id)) {
      throw new RunNotFoundError(`Run not found: ${id}`);
    }
    const queryResult = eventsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: 'Invalid after query value' });
    }
    const headerResult = parseLastEventId(request.headers['last-event-id']);
    if (!headerResult.ok) {
      return reply.status(400).send({ error: 'Invalid Last-Event-ID header' });
    }
    const afterId = Math.max(queryResult.data.after ?? 0, headerResult.value);
    openEventStream(request, reply, journal, id, afterId);
  });

  app.get('/runs/:id/events/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!manager.hasRun(id)) {
      throw new RunNotFoundError(`Run not found: ${id}`);
    }
    const queryResult = historyQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      const issue = queryResult.error.issues[0];
      if (issue?.code === 'unrecognized_keys') {
        const label = issue.keys.length === 1 ? 'parameter' : 'parameters';
        return reply.status(400).send({
          error: `Unknown query ${label}: ${issue.keys.join(', ')}`,
        });
      }
      const field = issue?.path[0] ?? 'history';
      const received = (request.query as Record<string, unknown>)[String(field)];
      return reply.status(400).send({
        error: typeof received === 'string'
          ? `Invalid ${String(field)} query value: ${clip(received)}`
          : `Invalid ${String(field)} query value`,
      });
    }
    const typesResult = parseCsv(queryResult.data.types, 'types');
    if (!typesResult.ok) {
      return reply.status(400).send({ error: typesResult.error });
    }
    const sourceResult = parseCsv(queryResult.data.source, 'source');
    if (!sourceResult.ok) {
      return reply.status(400).send({ error: sourceResult.error });
    }
    const invalidType = typesResult.values?.find((type) => !eventTypes.includes(
      type as (typeof eventTypes)[number],
    ));
    if (invalidType !== undefined) {
      return reply.status(400).send({ error: `Unknown event type: ${invalidType}` });
    }
    const page = journal.history(id, {
      limit: queryResult.data.limit,
      ...(queryResult.data.before === undefined ? {} : { before: queryResult.data.before }),
      ...(typesResult.values === undefined
        ? {}
        : { types: typesResult.values as ArenaEvent['type'][] }),
      ...(sourceResult.values === undefined ? {} : { sources: sourceResult.values }),
    });
    // Every id below `before` already exists, so the page can never gain rows.
    // lastEventId is the live run head, so it goes only on pages we let change.
    const frozen = queryResult.data.before !== undefined
      && queryResult.data.before <= page.lastEventId + 1;
    const cappedEvents = page.events.map(capEvent);
    reply.header(
      'Cache-Control',
      frozen ? 'public, max-age=31536000, immutable' : 'public, max-age=1',
    );
    return frozen
      ? { events: cappedEvents, hasMore: page.hasMore }
      : { ...page, events: cappedEvents };
  });

  app.addHook('onClose', async () => {
    journal.close();
  });

  return { app, journal, manager };
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    void reply.status(400).send({ error: 'Invalid request body', issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

function parseLastEventId(value: string | string[] | undefined): { ok: true; value: number } | { ok: false } {
  if (value === undefined) return { ok: true, value: 0 };
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw)) return { ok: false };
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : { ok: false };
}

// Error messages echo what the caller sent, so bound it.
function clip(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
}

function parseCsv(
  value: string | undefined,
  field: 'types' | 'source',
): { ok: true; values?: string[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  const values = value.split(',');
  if (values.some((item) => item.length === 0)) {
    return { ok: false, error: `Invalid ${field} query value: empty CSV item` };
  }
  return { ok: true, values };
}

function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  journal: EventJournal,
  runId: string,
  afterId: number,
): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders();

  let lastSentId = afterId;
  let replaying = true;
  const pending: ArenaEvent[] = [];
  const send = (event: ArenaEvent): void => {
    if (event.id <= lastSentId || reply.raw.destroyed) return;
    reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(capEvent(event))}\n\n`);
    lastSentId = event.id;
  };
  const unsubscribe = journal.subscribe(runId, (event) => {
    if (replaying) {
      pending.push(event);
    } else {
      send(event);
    }
  });

  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  // Registered before replay: a throw mid-replay would otherwise strand the
  // subscriber, which keeps buffering events for a connection nobody reads.
  request.raw.once('close', cleanup);
  reply.raw.once('error', cleanup);

  for (const event of journal.after(runId, afterId)) {
    send(event);
  }
  replaying = false;
  pending.sort((left, right) => left.id - right.id).forEach(send);
}
