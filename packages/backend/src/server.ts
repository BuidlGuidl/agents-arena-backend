import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ArenaEvent, BroadcastResponse, CreateRunRequest } from './contract.js';
import type { Schedule } from './adapters/fake.js';
import { RegisteredEntrantDriver } from './adapters/registered.js';
import { EntrantUnavailableError, type EntrantDriver } from './adapters/types.js';
import { EventJournal } from './journal.js';
import {
  type FundingGate,
  EntrantNotFoundError,
  InvalidTransitionError,
  RunManager,
  RunNotFoundError,
  UnknownPresetError,
  type WalletGate,
} from './run-manager.js';

const createRunSchema = z.object({
  preset: z.string().min(1),
  autoStart: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional(),
}).strict();

// Steer and broadcast carry the same body; only the fan-out differs.
const textSchema = z.object({ text: z.string().min(1) }).strict();
const eventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().optional() });

export interface ServerOptions {
  dbPath?: string;
  schedule?: Schedule;
  driverFactory?: (journal: EventJournal) => EntrantDriver;
  walletGateFactory?: (journal: EventJournal) => WalletGate;
  fundingGateFactory?: (journal: EventJournal) => FundingGate;
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
  const runManagerOptions = options.walletGateFactory === undefined
    ? {}
    : { walletGate: options.walletGateFactory(journal) };
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
    return { run: await manager.start(id) };
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
    reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    lastSentId = event.id;
  };
  const unsubscribe = journal.subscribe(runId, (event) => {
    if (replaying) {
      pending.push(event);
    } else {
      send(event);
    }
  });

  for (const event of journal.after(runId, afterId)) {
    send(event);
  }
  replaying = false;
  pending.sort((left, right) => left.id - right.id).forEach(send);

  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.once('close', cleanup);
  reply.raw.once('error', cleanup);
}
