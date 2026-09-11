import fastifyCors from '@fastify/cors';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { getAddress, isAddressEqual, recoverMessageAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

import { AgentIngest } from './agent-ingest.js';
import { AgentInputError, AgentBatchTooLargeError, AgentRateLimitError, AGENT_BODY_LIMIT } from './agent-limits.js';
import { AgentInbox } from './inbox.js';
import { ExternalStatus } from './adapters/external-status.js';
import { createChallengePackResolver, type ChallengePackAccess } from './ctf/resolve.js';
import { declaredFields } from './external-entrants.js';
import { flagsHeld } from './chain/flags-held.js';
import { activeChainProfile } from './chain/profile.js';
import { buildTaskText } from './ctf/prompt.js';
import {
  joinMessage,
  HARNESS_IDS,
  ROSTER_EFFORTS,
  type ArenaEvent,
  type AgentTaskResponse,
  type BroadcastResponse,
  type CreateRunRequest,
  type RestartResponse,
  type RosterEntry,
  type RunListResponse,
  type SteerResponse,
  type SweepResponse,
} from './contract.js';
import { OpenRouterUnavailableError, createAgentRegistry, rosterIssues, type AgentRegistry } from './agents/registry.js';
import type { Schedule } from './adapters/fake.js';
import { ExternalAgentTokens, resolveAgentToken } from './agent-auth.js';
import { mayMove, recordCurrentChallenge, useSolvedLookup } from './ctf/challenge-tracker.js';
import {
  bearerToken,
  isSecureRequest,
  operatorAuth,
  serializeSessionCookie,
  sessionCookie,
} from './auth.js';
import { SiweLogin, type SiweLoginOptions } from './siwe.js';
import { DEFAULT_PUBLIC_URL } from './config.js';
import { RegisteredEntrantDriver } from './adapters/registered.js';
import { EntrantOperationError, EntrantUnavailableError, type EntrantDriver } from './adapters/types.js';
import { eventTypes, scores } from './db/schema.js';
import { capEvent, EventJournal } from './journal.js';
import {
  DEFAULT_NARRATION_MAX_MS,
  DEFAULT_NARRATION_MIN_MS,
} from './config.js';
import type { Narrate } from './narration/openrouter.js';
import { createNarrationWatch } from './narration/watch.js';
import {
  JoinConflictError,
  RemovedWalletError,
  presetSubstrate,
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
  SweepConflictError,
  SweepSignatureError,
  type SolveWatch,
  UnknownPresetError,
} from './run-manager.js';
import type { NativeSweepChain } from './chain/native-sweep.js';

const rosterEntrySchema = z.object({
  id: z.string()
    .max(20)
    .regex(/^[a-z][a-z0-9-]*$/)
    .refine((id) => !id.startsWith('ext-'), { message: 'entrant id prefix ext- is reserved for external entrants' })
    .refine((id) => id !== 'run', {
      message: 'entrant id "run" is reserved for run-level feed events',
    }),
  harness: z.enum(HARNESS_IDS),
  model: z.string().min(1),
  effort: z.enum(ROSTER_EFFORTS),
}).strict();

class JoinAuthenticationError extends Error {}

const joinSchema = z.object({
  runId: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  nonce: z.string(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  name: z.string().min(1).max(40),
  harness: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  effort: z.string().max(80).optional(),
  url: z.string().max(200).url().refine((value) => /^https?:/i.test(value), {
    message: 'url must use http or https',
  }).optional(),
}).strict();

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
const agentSearchQuerySchema = z.object({
  harness: z.enum(HARNESS_IDS),
  q: z.string().trim().min(2),
}).strict();
const eventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().optional() });
const decimalIntegerSchema = z.string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
const runsQuerySchema = z.object({
  limit: decimalIntegerSchema.pipe(z.number().int().min(1).max(200)).default('50'),
});
const historyQuerySchema = z.object({
  limit: decimalIntegerSchema.pipe(z.number().int().min(1).max(200)).default('50'),
  before: decimalIntegerSchema.pipe(z.number().int().min(1)).optional(),
  types: z.string().optional(),
  source: z.string().optional(),
}).strict();

export interface ServerOptions {
  flagsHeld?: (address: Address) => Promise<number>;
  publicUrl?: string;
  /** Required: every mutating route rejects a request that does not carry it. */
  operatorToken: string;
  /** Operator allowlist for wallet login and seed signing. */
  siwe?: SiweLoginOptions;
  dbPath?: string;
  schedule?: Schedule;
  externalIdleMs?: number;
  challengePack?: ChallengePackAccess;
  driverFactory?: (journal: EventJournal, status: ExternalStatus) => EntrantDriver;
  fundingGateFactory?: (journal: EventJournal) => FundingGate;
  solveWatchFactory?: (journal: EventJournal) => SolveWatch;
  sweepChain?: NativeSweepChain;
  agentRegistry?: AgentRegistry;
  narrate?: Narrate;
  narrationMinMs?: number;
  narrationMaxMs?: number;
  narrationChallengeTitles?: Readonly<Record<number, string>>;
  corsOrigins?: readonly string[];
  logger?: boolean;
}

export interface ArenaServer {
  app: ReturnType<typeof Fastify>;
  journal: EventJournal;
  manager: RunManager;
}

export function createServer(options: ServerOptions): ArenaServer {
  const registry = options.agentRegistry ?? createAgentRegistry();
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
  useSolvedLookup((runId, entrantId) => new Set(journal.database
    .select({ challengeId: scores.challengeId })
    .from(scores)
    .where(and(eq(scores.runId, runId), eq(scores.entrantId, entrantId)))
    .all()
    .map((row) => row.challengeId)));
  const externalTokens = new ExternalAgentTokens(journal.database);
  const externalStatus = new ExternalStatus(journal, {
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.externalIdleMs === undefined ? {} : { idleMs: options.externalIdleMs }),
  });
  const pack = options.challengePack ?? createChallengePackResolver(activeChainProfile);
  const ingest = new AgentIngest(journal, externalStatus, pack.addressesFor);
  const inbox = new AgentInbox(journal);
  const driver = options.driverFactory?.(journal, externalStatus) ?? new RegisteredEntrantDriver(
    journal, { status: externalStatus, schedule: options.schedule, tokens: externalTokens, pack },
  );
  const runManagerOptions: RunManagerOptions = {
    externalTokens,
    promptBuilder: (entrant) => buildTaskText(entrant, activeChainProfile, {
      publicUrl: options.publicUrl ?? DEFAULT_PUBLIC_URL,
    }),
    operatorAddresses: options.siwe?.operatorAddresses ?? [],
    ...(options.solveWatchFactory === undefined
      ? {}
      : { solveWatch: options.solveWatchFactory(journal) }),
    ...(options.narrate === undefined
      ? {}
      : {
        narrationWatch: createNarrationWatch({
          journal,
          narrate: options.narrate,
          minMs: options.narrationMinMs ?? DEFAULT_NARRATION_MIN_MS,
          maxMs: options.narrationMaxMs ?? DEFAULT_NARRATION_MAX_MS,
          challengeTitles: options.narrationChallengeTitles ?? fallbackChallengeTitles(),
          logger: app.log,
        }),
      }),
    ...(options.sweepChain === undefined ? {} : { sweepChain: options.sweepChain }),
  };
  const manager = new RunManager(
    journal,
    driver,
    options.fundingGateFactory?.(journal),
    runManagerOptions,
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentRateLimitError) {
      return reply.status(429).header('Retry-After', error.retryAfter).send({ error: error.message });
    }
    if (error instanceof AgentBatchTooLargeError) {
      return reply.status(413).send({ error: error.message });
    }
    if (error instanceof AgentInputError) {
      return reply.status(400).send({ error: error.message });
    }
    if (error instanceof JoinAuthenticationError) {
      return reply.status(401).send({ error: error.message });
    }
    if (error instanceof JoinConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    if (error instanceof RemovedWalletError) {
      return reply.status(403).send({ error: error.message });
    }
    if (error instanceof EntrantOperationError) {
      return reply.status(400).send({ error: error.message });
    }
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
    if (error instanceof SweepConflictError) {
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
    if (error instanceof SweepSignatureError) {
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
    // A nonce is one-shot and short-lived, so it must never sit in a cache.
    return reply.header('Cache-Control', 'no-store').send({ nonce: login.issueNonce() });
  });

  app.post('/agent/join', async (request, reply) => {
    const body = parseBody(joinSchema, request.body, reply);
    if (body === undefined) return;
    const run = manager.assertJoinable(body.runId);
    if (!login.nonceAvailable(body.nonce)) throw new JoinAuthenticationError('Unknown or already used nonce');
    const message = joinMessage(body);
    const recovered = await recoverMessageAddress({ message, signature: body.signature as Hex }).catch(() => undefined);
    if (recovered === undefined || !isAddressEqual(recovered, body.address as Address)) {
      throw new JoinAuthenticationError('Signature does not match the claimed address');
    }
    let flagsBeforeJoin = 0;
    try {
      flagsBeforeJoin = options.flagsHeld !== undefined
        ? await options.flagsHeld(getAddress(body.address))
        : presetSubstrate(run.preset) === 'fake' ? 0 : await flagsHeld(getAddress(body.address));
    } catch {
      app.log.warn('Could not read flags held at join; recording zero');
    }
    const result = await manager.join({
      runId: body.runId, address: body.address, name: body.name, ...declaredFields(body), flagsBeforeJoin,
    }, () => {
      if (!login.consumeNonce(body.nonce)) throw new JoinAuthenticationError('Unknown or already used nonce');
    });
    return reply.status(result.created ? 201 : 200).send({ entrantId: result.entrantId, token: result.token, run: result.run });
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

  // Open read: the operator gate is method-based (ADR-0012).
  app.get('/agents', async (_request, reply) => {
    return reply.header('Cache-Control', 'public, max-age=60').send(registry.list());
  });

  app.get('/agents/search', async (request, reply) => {
    const query = agentSearchQuerySchema.safeParse(request.query);
    if (!query.success) {
      const issue = query.error.issues[0];
      if (issue?.code === 'unrecognized_keys') {
        const label = issue.keys.length === 1 ? 'parameter' : 'parameters';
        return reply.status(400).send({ error: `Unknown query ${label}: ${issue.keys.join(', ')}` });
      }
      const field = issue?.path[0] ?? 'harness';
      return reply.status(400).send({ error: `Invalid ${String(field)} query value` });
    }
    try {
      const agents = await registry.search(query.data.harness, query.data.q);
      return reply.header('Cache-Control', 'public, max-age=60').send({ agents });
    } catch (error) {
      if (!(error instanceof OpenRouterUnavailableError)) throw error;
      return reply.status(503).send({ error: error.message });
    }
  });

  app.post('/runs', async (request, reply) => {
    const body = parseBody(createRunSchema, request.body, reply);
    if (body === undefined) return;
    if (body.idempotencyKey !== undefined) {
      const run = manager.findByIdempotencyKey(body.idempotencyKey);
      if (run !== undefined) return reply.status(200).send({ run });
    }
    if (body.roster !== undefined) {
      const issues = await rosterIssues(registry, body.roster);
      if (issues.length > 0) return reply.status(400).send({ error: 'Invalid request body', issues });
    }
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
          effort: entry.effort,
        })),
      }),
    };
    const result = await manager.create(input);
    return reply.status(result.created ? 201 : 200).send({ run: result.run });
  });

  app.get('/runs', async (request, reply) => {
    const queryResult = runsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: 'Invalid limit query value' });
    }
    const response: RunListResponse = { runs: manager.list(queryResult.data.limit) };
    return response;
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

  app.post('/runs/:id/sweep', async (request, reply) => {
    const body = parseBody(seedSchema, request.body, reply);
    if (body === undefined) return;
    const { id } = request.params as { id: string };
    const response: SweepResponse = await manager.sweep(id, body.signature as Hex);
    return response;
  });

  app.post('/runs/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    return { run: await manager.stop(id) };
  });

  app.post('/runs/:id/entrants/:entrantId/remove', async (request, reply) => {
    const { id, entrantId } = request.params as { id: string; entrantId: string };
    await manager.remove(id, entrantId);
    return reply.status(202).send({ accepted: true });
  });

  app.post('/runs/:id/entrants/:entrantId/steer', async (request, reply) => {
    const body = parseBody(textSchema, request.body, reply);
    if (body === undefined) return;
    const { id, entrantId } = request.params as { id: string; entrantId: string };
    const status = await manager.steer(id, entrantId, body.text);
    const response: SteerResponse = { accepted: true, status };
    return reply.status(202).send(response);
  });

  // No body: the opening prompt is rebuilt from the run, so an operator cannot
  // quietly swap in a different one through the recovery path.
  app.post('/runs/:id/entrants/:entrantId/restart', async (request, reply) => {
    const { id, entrantId } = request.params as { id: string; entrantId: string };
    await manager.restart(id, entrantId);
    const response: RestartResponse = { accepted: true };
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

  function agentIdentity(request: FastifyRequest) {
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : resolveAgentToken(token, externalTokens);
    if (identity === undefined) throw new JoinAuthenticationError('Agent token required');
    return identity;
  }

  app.get('/agent/task', async (request): Promise<AgentTaskResponse> => {
    const identity = agentIdentity(request);
    return manager.agentTask(identity.runId, identity.entrantId);
  });

  app.post('/agent/events', { bodyLimit: AGENT_BODY_LIMIT }, async (request) =>
    ingest.events(agentIdentity(request), request.body));

  app.post('/agent/hooks/claude-code', { bodyLimit: AGENT_BODY_LIMIT }, async (request) => {
    ingest.hook(agentIdentity(request), request.body);
    return {};
  });

  app.get('/agent/inbox', async (request) => inbox.read(agentIdentity(request), request.query));

  // The agent-facing channel: authenticated by the per-entrant token the driver
  // injects as ARENA_AGENT_TOKEN, never by the operator credential. The agent's
  // announcement of the challenge it works on journals as entrant.challenge.
  app.post('/agent/progress', async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : resolveAgentToken(token, externalTokens);
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
    if (!mayMove(identity.runId, identity.entrantId, challengeId, 'self')) {
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
    journal.transaction(() => {
      journal.append(identity.runId, identity.entrantId, 'entrant.challenge', {
        entrantId: identity.entrantId, challengeId, via: 'self', evidence: 'announced',
      });
      externalStatus.touch(identity.runId, identity.entrantId);
      journal.afterCommit(() => recordCurrentChallenge(identity.runId, identity.entrantId, challengeId, 'self'));
    });
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
    externalStatus.close();
    journal.close();
  });

  return { app, journal, manager };
}

function fallbackChallengeTitles(): Readonly<Record<number, string>> {
  return Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [index + 1, `Challenge ${index + 1}`]),
  );
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
