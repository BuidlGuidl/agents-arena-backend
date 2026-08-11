import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Hex } from 'viem';
import { z } from 'zod';

import {
  HARNESS_IDS,
  OPENCODE_EFFORTS,
  ROSTER_EFFORTS,
  ROSTER_MODELS,
  type ArenaEvent,
  type BroadcastResponse,
  type CreateRunRequest,
  type RosterEntry,
  type SteerResponse,
} from './contract.js';
import type { Schedule } from './adapters/fake.js';
import { resolveAgentToken } from './agent-auth.js';
import { currentChallenge, recordCurrentChallenge } from './ctf/challenge-tracker.js';
import {
  bearerToken,
  isSecureRequest,
  operatorAuth,
  serializeSessionCookie,
  sessionCookie,
} from './auth.js';
import { SiweLogin, type SiweLoginOptions } from './siwe.js';
import { RegisteredEntrantDriver } from './adapters/registered.js';
import { EntrantUnavailableError, type EntrantDriver } from './adapters/types.js';
import { eventTypes } from './db/schema.js';
import { capEvent, EventJournal } from './journal.js';
import {
  ActiveRunConflictError,
  type FundingGate,
  EntrantNotFoundError,
  InvalidTransitionError,
  RunManager,
  type RunManagerOptions,
  RunNotFoundError,
  SeedEncodingError,
  SeedSignatureError,
  SeedStateConflictError,
  type SolveWatch,
  UnknownPresetError,
} from './run-manager.js';

const rosterEntrySchema = z.object({
  id: z.string()
    .max(20)
    .regex(/^[a-z][a-z0-9-]*$/)
    .refine((id) => id !== 'run', {
      message: 'entrant id "run" is reserved for run-level feed events',
    }),
  harness: z.enum(HARNESS_IDS),
  model: z.string(),
  effort: z.enum(ROSTER_EFFORTS).optional(),
}).strict().superRefine((entry, context) => {
  const allowedModels = ROSTER_MODELS[entry.harness];
  if (!allowedModels.includes(entry.model)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: `${entry.harness} models must be one of: ${allowedModels.join(', ')}`,
    });
  }
  if (
    entry.harness === 'opencode'
    && entry.effort
    && !OPENCODE_EFFORTS.some((effort) => effort === entry.effort)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['effort'],
      message: `opencode effort through openrouter must be one of: ${OPENCODE_EFFORTS.join(', ')}`,
    });
  }
});

const createRunSchema = z.object({
  preset: z.string().min(1),
  autoStart: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional(),
  durationMs: z.number().int().min(60_000).max(86_400_000).optional(),
  roster: z.array(rosterEntrySchema)
    .min(1)
    .max(10)
    .refine((roster) => new Set(roster.map((entrant) => entrant.id)).size === roster.length, {
      message: 'entrant ids must be unique within the roster',
    })
    .optional(),
}).strict();

// Steer and broadcast carry the same body; only the fan-out differs.
const textSchema = z.object({ text: z.string().min(1) }).strict();
const agentProgressSchema = z.object({
  challengeId: z.number().int().min(1).max(12),
}).strict();
// Journalled announcements are rate limited; repeats of the same value are
// deduped before the limit so they stay cheap instead of burning the budget.
const AGENT_ANNOUNCE_INTERVAL_MS = 1_000;
const seedSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
const verifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
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
  /** Required: every mutating route rejects a request that does not carry it. */
  operatorToken: string;
  /** Wallet login for the operator. Omit, or pass no addresses, to serve token-only. */
  siwe?: SiweLoginOptions;
  dbPath?: string;
  schedule?: Schedule;
  driverFactory?: (journal: EventJournal) => EntrantDriver;
  fundingGateFactory?: (journal: EventJournal) => FundingGate;
  solveWatchFactory?: (journal: EventJournal) => SolveWatch;
  corsOrigins?: readonly string[];
  logger?: boolean;
}

export interface ArenaServer {
  app: ReturnType<typeof Fastify>;
  journal: EventJournal;
  manager: RunManager;
}

export function createServer(options: ServerOptions): ArenaServer {
  const app = Fastify({ logger: options.logger ?? false });
  if (options.corsOrigins !== undefined && options.corsOrigins.length > 0) {
    void app.register(fastifyCors, {
      origin: [...options.corsOrigins],
      credentials: true,
      methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  }
  const login = new SiweLogin(options.siwe ?? { operatorAddresses: [] });
  app.addHook('onRequest', operatorAuth({ token: options.operatorToken, login }));
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
    if (
      error instanceof InvalidTransitionError
      || error instanceof UnknownPresetError
      || error instanceof SeedEncodingError
    ) {
      void reply.status(400).send({ error: error.message });
      return;
    }
    if (error instanceof SeedStateConflictError) {
      void reply.status(409).send({ error: error.message });
      return;
    }
    if (error instanceof ActiveRunConflictError) {
      void reply.status(409).send({
        error: error.message,
        activeRunId: error.activeRunId,
        activeRunState: error.activeRunState,
      });
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
    const clientError = fastifyClientError(error);
    if (clientError !== undefined) {
      void reply.status(clientError.status).send({ error: clientError.message });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/auth/nonce', async (_request, reply) => {
    if (!login.enabled) return siweDisabled(reply);
    // A nonce is one-shot and short-lived, so it must never sit in a cache.
    return reply.header('Cache-Control', 'no-store').send({ nonce: login.issueNonce() });
  });

  app.post('/auth/verify', async (request, reply) => {
    if (!login.enabled) return siweDisabled(reply);
    const body = parseBody(verifySchema, request.body, reply);
    if (body === undefined) return;
    const result = await login.login({
      message: body.message,
      // The schema already pinned the 0x-hex shape zod cannot express as a type.
      signature: body.signature as `0x${string}`,
    });
    if (!result.ok) {
      return reply.status(401).send({ error: result.reason });
    }
    const maxAgeSeconds = Math.max(1, Math.round((result.session.expiresAt - Date.now()) / 1_000));
    return reply
      .header('Set-Cookie', serializeSessionCookie(result.sessionId, {
        maxAgeSeconds,
        secure: isSecureRequest(request),
      }))
      .send({ address: result.session.address, expiresAt: new Date(result.session.expiresAt).toISOString() });
  });

  app.get('/auth/session', async (request, reply) => {
    const session = login.session(sessionCookie(request.headers.cookie));
    if (session === undefined) {
      // `configured` lets a page hide its sign-in control rather than offer one
      // that can only answer 503.
      return reply.header('Cache-Control', 'no-store').send({
        authenticated: false,
        configured: login.enabled,
      });
    }
    return reply.header('Cache-Control', 'no-store').send({
      authenticated: true,
      address: session.address,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    login.logout(sessionCookie(request.headers.cookie));
    return reply
      .header('Set-Cookie', serializeSessionCookie('', { maxAgeSeconds: 0, secure: isSecureRequest(request) }))
      .send({ authenticated: false, configured: login.enabled });
  });

  app.post('/runs', async (request, reply) => {
    const body = parseBody(createRunSchema, request.body, reply);
    if (body === undefined) return;
    const input: CreateRunRequest = {
      preset: body.preset,
      ...(body.autoStart === undefined ? {} : { autoStart: body.autoStart }),
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
      ...(body.durationMs === undefined ? {} : { durationMs: body.durationMs }),
      ...(body.roster === undefined ? {} : {
        roster: body.roster.map((entry): RosterEntry => ({
          id: entry.id,
          harness: entry.harness,
          model: entry.model,
          ...(entry.effort === undefined ? {} : { effort: entry.effort }),
        })),
      }),
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
    const status = await manager.steer(id, entrantId, body.text);
    const response: SteerResponse = { accepted: true, status };
    return reply.status(202).send(response);
  });

  app.post('/runs/:id/broadcast', async (request, reply) => {
    const body = parseBody(textSchema, request.body, reply);
    if (body === undefined) return;
    const { id } = request.params as { id: string };
    const result = await manager.broadcast(id, body.text);
    const response: BroadcastResponse = { accepted: true, ...result };
    return reply.status(202).send(response);
  });

  // The agent-facing channel: authenticated by the per-entrant token the driver
  // injects as ARENA_AGENT_TOKEN, never by the operator credential. The agent's
  // announcement of the challenge it works on journals as entrant.challenge with
  // via 'self'; the command heuristic keeps feeding via 'command', latest wins.
  app.post('/agent/progress', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : resolveAgentToken(token);
    if (identity === undefined) {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="agents-arena-agent"')
        .send({ error: 'Agent token required' });
    }
    const body = agentProgressSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'challengeId must be an integer from 1 to 12' });
    }

    const { challengeId } = body.data;
    // Deduped against the same current the command heuristic reads and moves,
    // so the two sources cannot disagree about what is already announced.
    if (currentChallenge(identity.runId, identity.entrantId) === challengeId) {
      return { ok: true, changed: false };
    }
    const now = Date.now();
    if (
      identity.lastAnnouncedAtMs !== undefined
      && now - identity.lastAnnouncedAtMs < AGENT_ANNOUNCE_INTERVAL_MS
    ) {
      return reply.status(429).send({ error: 'Announcing too fast; try again in a second' });
    }
    // State moves only after the journal accepts the event: an append that
    // throws must leave the retry journalling, not deduping into silence.
    journal.append(identity.runId, identity.entrantId, 'entrant.challenge', {
      entrantId: identity.entrantId,
      challengeId,
      via: 'self',
      evidence: 'announced',
    });
    recordCurrentChallenge(identity.runId, identity.entrantId, challengeId);
    identity.lastAnnouncedAtMs = now;
    return { ok: true, changed: true };
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

/**
 * Fastify tags its own client errors — an unparseable body, an unsupported media
 * type — with an `FST_ERR_` code and the status to answer with, and their messages
 * are safe to repeat. Anything else that happens to carry a `statusCode` is ours:
 * the Docker daemon reports a name collision as 409 with the host path in the text,
 * and that must be logged and hidden behind a 500, not echoed to a spectator.
 */
function fastifyClientError(error: unknown): { status: number; message: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  if (typeof code !== 'string' || !code.startsWith('FST_ERR_')) return undefined;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode > 499) return undefined;
  return { status: statusCode, message: error.message };
}

// No allowlist means no wallet can be the operator, so the route says so rather
// than 404 — the frontend needs to tell "not configured" from "wrong URL".
function siweDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ error: 'Wallet login is not configured' });
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
  // hijack() bypasses Fastify's send pipeline, so headers staged by hooks —
  // the CORS headers in particular — must be copied onto the raw response.
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
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
