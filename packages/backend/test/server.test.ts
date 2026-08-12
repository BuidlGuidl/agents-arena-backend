import { eq } from 'drizzle-orm';
import {
  parseSignature,
  serializeSignature,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { issueAgentToken, revokeAgentToken } from '../src/agent-auth.js';
import { dropCurrentChallenge, recordCurrentChallenge } from '../src/ctf/challenge-tracker.js';
import { EntrantUnavailableError, type EntrantDriver } from '../src/adapters/types.js';
import { isSecureRequest, MissingOperatorTokenError } from '../src/auth.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../src/chain/local-dev.js';
import {
  deriveEntrantKeys,
  seedTypedData,
} from '../src/chain/wallet.js';
import type { ArenaEvent, HistoryPage, RunSnapshot } from '../src/contract.js';
import { entrants, runs } from '../src/db/schema.js';
import { capEvent, EVENT_TEXT_LIMIT } from '../src/journal.js';
import { createServer, type ArenaServer } from '../src/server.js';

const servers: ArenaServer[] = [];
const OPERATOR_TOKEN = 'test-operator-token';
const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };
const LOCAL_DEV_OPERATOR = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() { return 'injected'; },
  async restart() {},
  async stop() {},
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
});

describe('agent self-announce', () => {
  async function announceSetup() {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });
    const token = issueAgentToken(run.id, 'codex-1');
    return { server, runId: run.id, token };
  }

  function progressEvents(server: ArenaServer, runId: string) {
    return server.journal.after(runId, 0).filter((event) => event.type === 'entrant.challenge');
  }

  it('journals an announcement and rejects everything unauthorized', async () => {
    const { server, runId, token } = await announceSetup();
    try {
      const accepted = await server.app.inject({
        method: 'POST',
        url: '/agent/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: { challengeId: 5 },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ ok: true, changed: true });
      expect(progressEvents(server, runId).map((event) => event.payload)).toEqual([
        { entrantId: 'codex-1', challengeId: 5, via: 'self', evidence: 'announced' },
      ]);
      expect(server.manager.snapshot(runId).entrants.find((entrant) => entrant.id === 'codex-1')
        ?.currentChallengeId).toBe(5);

      // No token, a wrong token, and the operator token all bounce: the route
      // only trusts the per-entrant credential.
      for (const headers of [
        {},
        { authorization: 'Bearer not-a-real-token' },
        { authorization: `Bearer ${OPERATOR_TOKEN}` },
      ]) {
        const rejected = await server.app.inject({
          method: 'POST', url: '/agent/progress', headers, payload: { challengeId: 5 },
        });
        expect(rejected.statusCode).toBe(401);
      }
    } finally {
      revokeAgentToken(runId, 'codex-1');
    }
  });

  it('validates the challenge id', async () => {
    const { server, runId, token } = await announceSetup();
    try {
      for (const challengeId of [0, 13, 1.5, '5', undefined]) {
        const response = await server.app.inject({
          method: 'POST',
          url: '/agent/progress',
          headers: { authorization: `Bearer ${token}` },
          payload: { challengeId },
        });
        expect(response.statusCode).toBe(400);
      }
      expect(progressEvents(server, runId)).toEqual([]);
    } finally {
      revokeAgentToken(runId, 'codex-1');
    }
  });

  it('dedupes repeats and rate limits switches', async () => {
    const { server, runId, token } = await announceSetup();
    try {
      const headers = { authorization: `Bearer ${token}` };
      const first = await server.app.inject({
        method: 'POST', url: '/agent/progress', headers, payload: { challengeId: 5 },
      });
      expect(first.json()).toEqual({ ok: true, changed: true });

      // The same value repeats cheaply without a journal row or a 429.
      const repeat = await server.app.inject({
        method: 'POST', url: '/agent/progress', headers, payload: { challengeId: 5 },
      });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual({ ok: true, changed: false });

      // An immediate switch hits the announce interval instead of the journal.
      const tooFast = await server.app.inject({
        method: 'POST', url: '/agent/progress', headers, payload: { challengeId: 6 },
      });
      expect(tooFast.statusCode).toBe(429);
      expect(progressEvents(server, runId)).toHaveLength(1);
    } finally {
      revokeAgentToken(runId, 'codex-1');
    }
  });

  it('dedupes against the command heuristic, not its own last value', async () => {
    const { server, runId, token } = await announceSetup();
    try {
      // The heuristic already moved the shared current to 5; the agent
      // announcing 5 now adds nothing.
      recordCurrentChallenge(runId, 'codex-1', 5);
      const repeat = await server.app.inject({
        method: 'POST',
        url: '/agent/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: { challengeId: 5 },
      });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual({ ok: true, changed: false });
      expect(progressEvents(server, runId)).toEqual([]);
    } finally {
      dropCurrentChallenge(runId, 'codex-1');
      revokeAgentToken(runId, 'codex-1');
    }
  });

  it('stops resolving a revoked token', async () => {
    const { server, runId, token } = await announceSetup();
    revokeAgentToken(runId, 'codex-1');
    const response = await server.app.inject({
      method: 'POST',
      url: '/agent/progress',
      headers: { authorization: `Bearer ${token}` },
      payload: { challengeId: 5 },
    });
    expect(response.statusCode).toBe(401);
    expect(progressEvents(server, runId)).toEqual([]);
  });
});

describe('browser CORS', () => {
  it('serves credentialed preflight headers for a configured exact origin', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      corsOrigins: ['http://localhost:3000'],
    });
    servers.push(server);

    const response = await server.app.inject({
      method: 'OPTIONS',
      url: '/runs',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, HEAD, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(response.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('carries CORS headers on the hijacked SSE stream response', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      corsOrigins: ['http://localhost:3000'],
    });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });

    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const response = await fetch(`${address}/runs/${created.run.id}/events`, {
      headers: { origin: 'http://localhost:3000' },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    abort.abort();
  });

  it('adds no CORS headers when no origins are configured', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { origin: 'http://localhost:3000' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('event history', () => {
  it('returns the newest events in ascending order', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const appended = Array.from({ length: 4 }, (_, index) =>
      server.journal.append(created.run.id, 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: String(index + 1),
      }));

    const response = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?limit=3`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: appended.slice(1),
      lastEventId: appended[3]?.id,
      hasMore: true,
    });
  });

  it('caps history and SSE copies while the journal retains the full payload', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const longText = `${'a'.repeat(2_000)}\n${'b'.repeat(2_000)}\nend`;
    const appended = server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: longText,
    });

    const historyResponse = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history`,
    });
    const history = historyResponse.json() as HistoryPage;
    const servedHistory = history.events.find((event) => event.id === appended.id);
    const storedHistory = server.journal.history(created.run.id, { limit: 10 })
      .events.find((event) => event.id === appended.id);
    if (servedHistory?.type !== 'agent.message' || storedHistory?.type !== 'agent.message') {
      throw new Error('Expected the journaled agent message');
    }

    expect(historyResponse.statusCode).toBe(200);
    expect(servedHistory.payload.text).toBe(longText.slice(0, EVENT_TEXT_LIMIT));
    expect(servedHistory.truncated).toEqual({
      text: { fullLength: longText.length, lines: 3 },
    });
    expect(appended.payload.text).toBe(longText);
    expect(storedHistory.payload.text).toBe(longText);
    expect('truncated' in appended).toBe(false);
    expect('truncated' in storedHistory).toBe(false);

    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const sseResponse = await fetch(`${address}/runs/${created.run.id}/events`, {
      headers: { 'Last-Event-ID': String(created.run.lastEventId) },
      signal: abort.signal,
    });
    const [servedSse] = await readSseEvents(sseResponse, 1);
    abort.abort();

    expect(servedSse).toEqual(servedHistory);
  });

  it('caps nested payload strings with dotted paths without mutating the event', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const nestedText = 'n'.repeat(EVENT_TEXT_LIMIT + 1);
    const itemText = 'i'.repeat(EVENT_TEXT_LIMIT + 1);
    const payload = {
      entrantId: 'codex-1',
      tool: 'shell',
      ok: true,
      detail: 'summary',
      output: { stdout: nestedText },
      items: [{ text: itemText }],
    } as Extract<ArenaEvent, { type: 'tool.result' }>['payload'] & {
      output: { stdout: string };
      items: { text: string }[];
    };
    const appended = server.journal.append(
      created.run.id,
      'codex-1',
      'tool.result',
      payload,
    );
    const capped = capEvent(appended) as ArenaEvent & {
      payload: {
        output: { stdout: string };
        items: { text: string }[];
      };
    };

    expect(capped).not.toBe(appended);
    expect(capped.payload).not.toBe(appended.payload);
    expect(capped.payload.output).not.toBe(payload.output);
    expect(capped.payload.items).not.toBe(payload.items);
    expect(capped.payload.items[0]).not.toBe(payload.items[0]);
    expect(capped.payload.output.stdout).toBe(nestedText.slice(0, EVENT_TEXT_LIMIT));
    expect(capped.payload.items[0]?.text).toBe(itemText.slice(0, EVENT_TEXT_LIMIT));
    expect(capped.truncated).toEqual({
      'output.stdout': { fullLength: nestedText.length, lines: 1 },
      'items.0.text': { fullLength: itemText.length, lines: 1 },
    });
    expect(payload.output.stdout).toBe(nestedText);
    expect(payload.items[0]?.text).toBe(itemText);
    expect('truncated' in appended).toBe(false);

    const response = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history`,
    });
    const served = (response.json() as HistoryPage).events.find(
      (event) => event.id === appended.id,
    );
    const stored = server.journal.history(created.run.id, { limit: 10 })
      .events.find((event) => event.id === appended.id);

    expect(served?.payload).toMatchObject({
      output: { stdout: nestedText.slice(0, EVENT_TEXT_LIMIT) },
      items: [{ text: itemText.slice(0, EVENT_TEXT_LIMIT) }],
    });
    expect(served?.truncated).toEqual({
      'output.stdout': { fullLength: nestedText.length, lines: 1 },
      'items.0.text': { fullLength: itemText.length, lines: 1 },
    });
    expect(stored?.payload).toMatchObject({
      output: { stdout: nestedText },
      items: [{ text: itemText }],
    });
    expect('truncated' in stored!).toBe(false);
  });

  it('leaves 4,000 characters intact and caps 4,001 characters', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const exact = server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'a'.repeat(EVENT_TEXT_LIMIT),
    });
    const over = server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'b'.repeat(EVENT_TEXT_LIMIT + 1),
    });
    const exactCapped = capEvent(exact);
    const overCapped = capEvent(over);
    if (exactCapped.type !== 'agent.message' || overCapped.type !== 'agent.message') {
      throw new Error('Expected capped agent messages');
    }

    expect(exactCapped.payload.text).toHaveLength(EVENT_TEXT_LIMIT);
    expect('truncated' in exactCapped).toBe(false);
    expect(overCapped.payload.text).toHaveLength(EVENT_TEXT_LIMIT);
    expect(overCapped.truncated).toEqual({
      text: { fullLength: EVENT_TEXT_LIMIT + 1, lines: 1 },
    });
  });

  // A plain-object receipt would route this key to the prototype setter, cutting
  // the string with nothing recording that it was cut.
  it('records a receipt for a payload key named __proto__', () => {
    const payload = JSON.parse(`{"__proto__":"${'c'.repeat(EVENT_TEXT_LIMIT + 1)}"}`) as unknown;
    const capped = capEvent({
      id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now', type: 'agent.message', payload,
    } as unknown as ArenaEvent);

    // Compared as entries: an object literal keyed `__proto__` sets the
    // prototype rather than the key, which is the bug this guards against.
    expect(Object.entries(capped.truncated ?? {})).toEqual([
      ['__proto__', { fullLength: EVENT_TEXT_LIMIT + 1, lines: 1 }],
    ]);
  });

  // Unreachable with today's flat payloads. The bound matters because a throw
  // here happens mid-SSE-replay, where it would take the connection with it.
  it('returns a deeply nested payload instead of overflowing the stack', () => {
    let payload: unknown = { text: 'd'.repeat(EVENT_TEXT_LIMIT + 1) };
    for (let level = 0; level < 3_000; level += 1) payload = { nested: payload };

    expect(() => capEvent({
      id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now', type: 'agent.message', payload,
    } as unknown as ArenaEvent)).not.toThrow();
  });

  it('drops an emoji whole when its surrogate pair straddles the boundary', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const appended = server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: `${'z'.repeat(EVENT_TEXT_LIMIT - 1)}\u{1F600}`,
    });
    const capped = capEvent(appended);
    if (capped.type !== 'agent.message') throw new Error('Expected a capped agent message');
    const lastCodeUnit = capped.payload.text.charCodeAt(capped.payload.text.length - 1);

    expect(capped.payload.text).toHaveLength(EVENT_TEXT_LIMIT - 1);
    expect(lastCodeUnit < 0xD800 || lastCodeUnit > 0xDBFF).toBe(true);
    expect(capped.truncated).toEqual({
      text: { fullLength: EVENT_TEXT_LIMIT + 1, lines: 1 },
    });
    expect(appended.payload.text).toHaveLength(EVENT_TEXT_LIMIT + 1);
  });

  it('accepts a limit of 200, rejects larger limits, and defaults to 50', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    Array.from({ length: 55 }, (_, index) =>
      server.journal.append(created.run.id, 'codex-1', 'agent.message', {
        entrantId: 'codex-1',
        text: String(index + 1),
      }));

    const invalid = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?limit=201`,
    });
    const maximum = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?limit=200`,
    });
    const defaulted = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history`,
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Invalid limit query value: 201' });
    expect(maximum.statusCode).toBe(200);
    expect((maximum.json() as HistoryPage).events).toHaveLength(56);
    expect((defaulted.json() as HistoryPage).events).toHaveLength(50);
  });

  it('rejects unknown event types and empty CSV items', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });

    const unknown = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?types=agent.message,unknown.event`,
    });
    const empty = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?types=,,`,
    });

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: 'Unknown event type: unknown.event' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'Invalid types query value: empty CSV item' });
  });

  it('names unknown history query parameters', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });

    const response = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?after=1`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Unknown query parameter: after' });
  });

  it('rejects non-decimal and unsafe history integers', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });

    const hexadecimal = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?limit=0x10`,
    });
    const unsafe = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?before=1e20`,
    });

    const long = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?limit=${'9'.repeat(80)}`,
    });

    expect(hexadecimal.statusCode).toBe(400);
    expect(hexadecimal.json()).toEqual({ error: 'Invalid limit query value: 0x10' });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json()).toEqual({ error: 'Invalid before query value: 1e20' });
    expect(long.statusCode).toBe(400);
    expect((long.json() as { error: string }).error).toBe(`Invalid limit query value: ${'9'.repeat(40)}…`);
  });

  it('returns 404 for an unknown run', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'GET',
      url: '/runs/missing/events/history',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found: missing' });
  });

  it('only marks history immutable when its exclusive cursor cannot gain events', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const head = server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'before the cursor',
    });
    const frozenUrl = `/runs/${created.run.id}/events/history?before=${head.id + 1}`;
    const aboveHeadUrl = `/runs/${created.run.id}/events/history?before=1000000`;

    const tail = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history`,
    });
    const frozenBefore = await server.app.inject({ method: 'GET', url: frozenUrl });
    const aboveHeadBefore = await server.app.inject({ method: 'GET', url: aboveHeadUrl });
    server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'after the cursor',
    });
    const frozenAfter = await server.app.inject({ method: 'GET', url: frozenUrl });
    const aboveHeadAfter = await server.app.inject({ method: 'GET', url: aboveHeadUrl });

    expect(tail.headers['cache-control']).toBe('public, max-age=1');
    expect((tail.json() as HistoryPage).lastEventId).toBe(head.id);

    // An immutable body must be byte-identical after the run moves on, which is
    // why lastEventId cannot ride along on it.
    expect(frozenBefore.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(frozenAfter.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((frozenBefore.json() as HistoryPage).events).not.toEqual([]);
    expect(frozenBefore.json()).toEqual(frozenAfter.json());
    expect('lastEventId' in (frozenBefore.json() as HistoryPage)).toBe(false);

    expect(aboveHeadBefore.headers['cache-control']).toBe('public, max-age=1');
    expect(aboveHeadAfter.headers['cache-control']).toBe('public, max-age=1');
    expect((aboveHeadBefore.json() as HistoryPage).events)
      .not.toEqual((aboveHeadAfter.json() as HistoryPage).events);
  });

  it('hands the unfiltered history cursor to SSE without gaps or duplicates', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'tail one',
    });
    server.journal.append(created.run.id, 'opencode-1', 'tool.call', {
      entrantId: 'opencode-1',
      tool: 'shell',
      toolCallId: 'call-tail-two',
      detail: 'tail two',
    });
    const historyResponse = await server.app.inject({
      method: 'GET',
      url: `/runs/${created.run.id}/events/history?types=agent.message`,
    });
    const history = historyResponse.json() as HistoryPage;
    const live = server.journal.append(created.run.id, 'codex-1', 'tool.result', {
      entrantId: 'codex-1',
      tool: 'shell',
      toolCallId: 'call-live',
      ok: true,
      detail: 'live',
    });

    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const response = await fetch(`${address}/runs/${created.run.id}/events`, {
      headers: { 'Last-Event-ID': String(history.lastEventId) },
      signal: abort.signal,
    });
    const events = await readSseEvents(response, 1);
    abort.abort();

    expect(history.events.every((event) => event.type === 'agent.message')).toBe(true);
    expect(events).toEqual([live]);
  });
});

describe('SSE event delivery', () => {
  it('replays missed events and then sends live events without duplicates or gaps', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    const runId = created.run.id;
    const resumeAfter = created.run.lastEventId;
    const missedOne = server.journal.append(runId, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'missed one',
    });
    const missedTwo = server.journal.append(runId, 'codex-1', 'tool.call', {
      entrantId: 'codex-1',
      tool: 'shell',
      toolCallId: 'server-tool-1',
      detail: 'missed two',
    });

    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const response = await fetch(`${address}/runs/${runId}/events`, {
      headers: { 'Last-Event-ID': String(resumeAfter) },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const eventsPromise = readSseEvents(response, 3);
    const live = server.journal.append(runId, 'codex-1', 'tool.result', {
      entrantId: 'codex-1',
      tool: 'shell',
      toolCallId: 'server-tool-1',
      ok: true,
      detail: 'live',
    });
    const events = await eventsPromise;
    abort.abort();

    expect(events.map((event) => event.id)).toEqual([missedOne.id, missedTwo.id, live.id]);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
    expect(events.map((event) => event.type)).toEqual(['agent.message', 'tool.call', 'tool.result']);
  });
});

describe('single active run guard', () => {
  it('rejects create with the active run identity', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run: active } = await server.manager.create({ preset: 'fake-duel' });
    server.manager.transition(active.id, 'preparing');

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: `Run ${active.id} is active in state preparing`,
      activeRunId: active.id,
      activeRunState: 'preparing',
    });
  });

  it('rejects start with the other active run identity', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run: active } = await server.manager.create({ preset: 'fake-duel' });
    const { run: drafted } = await server.manager.create({ preset: 'fake-duel' });
    server.manager.transition(active.id, 'preparing');

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${drafted.id}/start`,
      headers: operatorHeaders,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: `Run ${active.id} is active in state preparing`,
      activeRunId: active.id,
      activeRunState: 'preparing',
    });
  });

  it('allows create and start while another run remains created', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      schedule: (task) => {
        task();
        return undefined;
      },
    });
    servers.push(server);
    await server.manager.create({ preset: 'fake-duel' });

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel' },
    });

    expect(response.statusCode).toBe(201);
    expect(server.manager.countRuns()).toBe(2);
    const { run } = response.json() as { run: RunSnapshot };
    const startResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/start`,
      headers: operatorHeaders,
    });
    expect(startResponse.statusCode).toBe(200);
  });

  it('replays an idempotent create while that run is active', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({
      preset: 'fake-duel',
      idempotencyKey: 'active-request',
    });
    server.manager.transition(run.id, 'preparing');

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', idempotencyKey: 'active-request' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { run: RunSnapshot }).run.id).toBe(run.id);
    expect(server.manager.countRuns()).toBe(1);
  });
});

describe('seed endpoint', () => {
  it('auto-signs with an empty operator allowlist and records the dev signer', async () => {
    await withAutoSignEnabled(async () => {
      const server = createSeedTestServer([]);

      const response = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel', autoStart: true },
      });

      expect(response.statusCode).toBe(201);
      const { run } = response.json() as { run: RunSnapshot };
      expect(run.state).toBe('running');
      expect(run.seededBy).toBe(LOCAL_DEV_OPERATOR.address);
      const stored = server.journal.database
        .select({ seededBy: runs.seededBy })
        .from(runs)
        .where(eq(runs.id, run.id))
        .get();
      expect(stored?.seededBy).toBe(LOCAL_DEV_OPERATOR.address);

      await server.manager.stop(run.id);
    });
  });

  it('returns from start while a human-gated run awaits its seed signature', async () => {
    await withAutoSignDisabled(async () => {
      const server = createSeedTestServer();
      const created = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel' },
      });
      const { run } = created.json() as { run: RunSnapshot };
      const responsePromise = server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/start`,
        headers: operatorHeaders,
      });

      const outcome = await Promise.race([
        responsePromise.then((response: { statusCode: number; json(): unknown }) => ({
          kind: 'response' as const,
          response,
        })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 25);
        }),
      ]);

      try {
        expect(outcome.kind).toBe('response');
        if (outcome.kind === 'response') {
          expect(outcome.response.statusCode).toBe(200);
          expect((outcome.response.json() as { run: RunSnapshot }).run.state)
            .toBe('awaiting_signature');
        }
      } finally {
        await server.manager.stop(run.id);
        await responsePromise;
      }
    });
  });

  it('rejects a seed when the run is not awaiting a signature', async () => {
    await withAutoSignDisabled(async () => {
      const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
      servers.push(server);
      const { run } = await server.manager.create({ preset: 'docker-duel' });
      const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
      const signature = await account.signTypedData(seedTypedData(run.id, 31337));

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Run is not awaiting a seed signature' });
    });
  });

  it('explains that an awaiting-signature run cannot resume after a restart', async () => {
    await withAutoSignDisabled(async () => {
      const server = createSeedTestServer();
      const { run } = await server.manager.create({ preset: 'docker-duel' });
      server.manager.transition(run.id, 'awaiting_signature');
      const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
      const signature = await account.signTypedData(seedTypedData(run.id, 31337));

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: 'Backend restarted while this run awaited its signature; stop the run and create a new one.',
      });
      await server.manager.stop(run.id);
    });
  });

  it('rejects a signature from a non-operator without exposing signer data', async () => {
    await withAutoSignDisabled(async () => {
      const server = createSeedTestServer();
      const created = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel', autoStart: true },
      });
      const { run } = created.json() as { run: RunSnapshot };
      const wrongAccount = privateKeyToAccount(generatePrivateKey());
      const signature = await wrongAccount.signTypedData(seedTypedData(run.id, 31337));

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Seed signature is not authorized' });
      expect(response.body).not.toContain(signature);
      expect(response.body).not.toContain(wrongAccount.address);
      await server.manager.stop(run.id);
    });
  });

  it('rejects a high-s variant of an operator signature', async () => {
    await withAutoSignDisabled(async () => {
      const server = createSeedTestServer();
      const created = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel', autoStart: true },
      });
      const { run } = created.json() as { run: RunSnapshot };
      const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
      const signature = await account.signTypedData(seedTypedData(run.id, 31337));

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature: highSSignature(signature) },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Signature encoding is not canonical (expects low-s, v 27/28).',
      });
      expect(response.body).not.toContain(signature);
      expect(server.manager.snapshot(run.id).state).toBe('awaiting_signature');
      await server.manager.stop(run.id);
    });
  });

  it('derives the canonical addresses from a v-as-0-or-1 signature', async () => {
    await withAutoSignDisabled(async () => {
      const server = createSeedTestServer();
      const created = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel', autoStart: true },
      });
      const { run } = created.json() as { run: RunSnapshot };
      const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
      const canonicalSignature = await account.signTypedData(seedTypedData(run.id, 31337));
      const entrantIds = run.entrants.map((entrant) => entrant.id);
      const expected = deriveEntrantKeys(run.id, canonicalSignature, entrantIds);

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature: paritySignature(canonicalSignature) },
      });

      expect(response.statusCode).toBe(202);
      const seeded = (response.json() as { run: RunSnapshot }).run;
      expect(seeded.entrants.map((entrant) => entrant.address)).toEqual(
        entrantIds.map((entrantId) => expected.get(entrantId)),
      );
      await waitForState(server, run.id, 'running');
      await server.manager.stop(run.id);
    });
  });

  it('accepts an allowlisted operator signature and records its provenance', async () => {
    await withAutoSignDisabled(async () => {
      const operator = privateKeyToAccount(generatePrivateKey());
      const server = createSeedTestServer([operator.address]);
      const created = await server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: operatorHeaders,
        payload: { preset: 'docker-duel', autoStart: true },
      });
      const { run } = created.json() as { run: RunSnapshot };
      expect(run.state).toBe('awaiting_signature');
      expect(run).not.toHaveProperty('seededBy');
      const signature = await operator.signTypedData(seedTypedData(run.id, 31337));

      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/seed`,
        headers: operatorHeaders,
        payload: { signature },
      });
      await waitForState(server, run.id, 'running');

      expect(response.statusCode).toBe(202);
      const seeded = (response.json() as { run: RunSnapshot }).run;
      expect(seeded.seededBy).toBe(operator.address);
      expect(server.manager.snapshot(run.id).seededBy).toBe(operator.address);
      const storedRun = server.journal.database
        .select({ seededBy: runs.seededBy })
        .from(runs)
        .where(eq(runs.id, run.id))
        .get();
      expect(storedRun?.seededBy).toBe(operator.address);
      const rows = server.journal.database
        .select({ address: entrants.address })
        .from(entrants)
        .where(eq(entrants.runId, run.id))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.address !== null)).toBe(true);
      const assigned = server.journal.after(run.id, 0)
        .filter((event) => event.type === 'wallet.assigned');
      expect(assigned).toHaveLength(2);
      const observable = JSON.stringify({
        response: response.json(),
        events: server.journal.after(run.id, 0),
      });
      expect(observable).not.toContain(signature);

      await server.manager.stop(run.id);
    });
  });
});

describe('run rosters', () => {
  it.each([59_999, 86_400_001])('rejects durationMs %i', async (durationMs) => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', durationMs },
    });

    expect(response.statusCode).toBe(400);
  });

  it('creates a run with the roster entrants instead of the preset entrants', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [
          { id: 'claude-opus', harness: 'claude', model: 'claude-opus-5' },
          { id: 'codex-main', harness: 'codex', model: 'gpt-5.5' },
          { id: 'opencode-main', harness: 'opencode', model: 'openrouter/z-ai/glm-5.2' },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { run } = response.json() as { run: RunSnapshot };
    expect(run.entrants.map((entrant) => entrant.id)).toEqual([
      'claude-opus',
      'codex-main',
      'opencode-main',
    ]);
  });

  it('rejects a model outside the harness allowlist', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{ id: 'codex-main', harness: 'codex', model: 'gpt-4' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { issues: Array<{ message: string }> }).issues[0]?.message)
      .toBe('codex models must be one of: gpt-5.5');
  });

  it('rejects a model allowed only for another harness', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{ id: 'codex-main', harness: 'codex', model: 'claude-opus-5' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { issues: Array<{ message: string }> }).issues[0]?.message)
      .toBe('codex models must be one of: gpt-5.5');
  });

  it('accepts effort for a Codex roster entrant and exposes it in the snapshot', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{ id: 'codex-main', harness: 'codex', model: 'gpt-5.5', effort: 'xhigh' }],
      },
    });

    expect(response.statusCode).toBe(201);
    const { run } = response.json() as { run: RunSnapshot };
    expect(run.entrants).toEqual([
      expect.objectContaining({
        id: 'codex-main',
        harness: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
      }),
    ]);
  });

  it('accepts effort for a Claude roster entrant and exposes it in the snapshot', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{ id: 'claude-main', harness: 'claude', model: 'claude-opus-5', effort: 'high' }],
      },
    });

    expect(response.statusCode).toBe(201);
    const { run } = response.json() as { run: RunSnapshot };
    expect(run.entrants).toEqual([
      expect.objectContaining({
        id: 'claude-main',
        harness: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
      }),
    ]);
  });

  it('accepts high effort for an OpenCode roster entrant', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{
          id: 'opencode-main',
          harness: 'opencode',
          model: 'openrouter/z-ai/glm-5.2',
          effort: 'high',
        }],
      },
    });

    expect(response.statusCode).toBe(201);
    const { run } = response.json() as { run: RunSnapshot };
    expect(run.entrants).toEqual([
      expect.objectContaining({
        id: 'opencode-main',
        harness: 'opencode',
        model: 'openrouter/z-ai/glm-5.2',
        effort: 'high',
      }),
    ]);
  });

  it('rejects xhigh effort for an OpenCode roster entrant', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{
          id: 'opencode-main',
          harness: 'opencode',
          model: 'openrouter/z-ai/glm-5.2',
          effort: 'xhigh',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { issues: Array<{ message: string }> }).issues[0]?.message)
      .toBe('opencode effort through openrouter must be one of: low, medium, high');
  });

  it('rejects an invalid roster effort', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        roster: [{ id: 'codex-main', harness: 'codex', model: 'gpt-5.5', effort: 'extreme' }],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    {
      caseName: 'more than ten entrants',
      roster: Array.from({ length: 11 }, (_, index) => ({
        id: `entrant-${index}`,
        harness: 'codex',
        model: 'gpt-5.5',
      })),
    },
    {
      caseName: 'duplicate entrant ids',
      roster: [
        { id: 'same-id', harness: 'codex', model: 'gpt-5.5' },
        { id: 'same-id', harness: 'claude', model: 'claude-opus-5' },
      ],
      expectedMessage: 'entrant ids must be unique within the roster',
    },
    {
      caseName: 'invalid entrant id characters',
      roster: [{ id: 'Bad_id', harness: 'codex', model: 'gpt-5.5' }],
    },
    {
      caseName: 'an entrant id longer than 20 characters',
      roster: [{ id: 'abcdefghijklmnopqrstu', harness: 'codex', model: 'gpt-5.5' }],
    },
    {
      caseName: 'the reserved run entrant id',
      roster: [{ id: 'run', harness: 'codex', model: 'gpt-5.5' }],
      expectedMessage: 'entrant id "run" is reserved for run-level feed events',
    },
    {
      caseName: 'the default model because it is outside the allowlist',
      roster: [{ id: 'codex-main', harness: 'codex', model: 'default' }],
    },
    {
      caseName: 'a whitespace-padded model because it is outside the allowlist',
      roster: [{ id: 'codex-main', harness: 'codex', model: ' gpt-5.5' }],
    },
    {
      caseName: 'an empty roster',
      roster: [],
    },
  ])('rejects $caseName', async ({ roster, expectedMessage }) => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', roster },
    });

    expect(response.statusCode).toBe(400);
    if (expectedMessage !== undefined) {
      expect((response.json() as { issues: Array<{ message: string }> }).issues[0]?.message)
        .toBe(expectedMessage);
    }
  });

  it('streams and prices same-harness entrants by entrant id and model', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      schedule: (task) => {
        task();
        return undefined;
      },
    });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: {
        preset: 'fake-duel',
        autoStart: true,
        roster: [
          { id: 'claude-a', harness: 'claude', model: 'claude-opus-5' },
          { id: 'claude-b', harness: 'claude', model: 'claude-sonnet-5' },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const { run } = response.json() as { run: RunSnapshot };
    const entrantEvents = server.journal.after(run.id, 0)
      .filter((event) => event.source === 'claude-a' || event.source === 'claude-b');
    for (const entrantId of ['claude-a', 'claude-b']) {
      const events = entrantEvents.filter((event) => event.source === entrantId);
      expect(events.some((event) => event.type === 'agent.message')).toBe(true);
      expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
      expect(events.every((event) =>
        !('entrantId' in event.payload) || event.payload.entrantId === entrantId,
      )).toBe(true);
    }
    const toolCallIds = entrantEvents
      .filter((event) => event.type === 'tool.call')
      .map((event) => event.payload.toolCallId);
    expect(new Set(toolCallIds).size).toBe(2);

    const snapshot = server.manager.snapshot(run.id);
    expect(snapshot.entrants).toMatchObject([
      { id: 'claude-a', harness: 'claude', model: 'claude-opus-5', costUsd: 0.0224 },
      { id: 'claude-b', harness: 'claude', model: 'claude-sonnet-5', costUsd: 0.01344 },
    ]);
  });
});

describe('fake run vertical slice', () => {
  it('creates, streams scripted events, steers, and finishes a run', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      schedule: (task) => {
        task();
        return undefined;
      },
    });
    servers.push(server);

    const createResponse = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', autoStart: true },
    });
    expect(createResponse.statusCode).toBe(201);
    const { run } = createResponse.json() as { run: RunSnapshot };
    expect(run.state).toBe('running');
    expect(run.entrants.map((entrant) => entrant.id)).toEqual(['codex-1', 'opencode-1']);

    const beforeSteer = server.journal.after(run.id, 0);
    for (const entrantId of ['codex-1', 'opencode-1']) {
      const entrantEvents = beforeSteer.filter((event) => event.source === entrantId);
      expect(entrantEvents.map((event) => event.type))
        .toEqual([
          'entrant.prompt', 'entrant.status', 'agent.message', 'tool.call', 'tool.result',
          'usage', 'entrant.status', 'usage', 'entrant.challenge', 'entrant.challenge',
        ]);
      const toolEvents = entrantEvents.filter((event) =>
        event.type === 'tool.call' || event.type === 'tool.result',
      );
      expect(toolEvents[0]?.payload.toolCallId).toBe(toolEvents[1]?.payload.toolCallId);
    }
    expect(run.entrants.every((entrant) => entrant.address === null)).toBe(true);

    // Same totals the live usage events carry, so a reload repaints them. The
    // fake codex model is in the rate table; the fake opencode model is not.
    const scripted = server.manager.snapshot(run.id).entrants;
    expect(scripted.find((entrant) => entrant.id === 'codex-1'))
      .toMatchObject({ inputTokens: 3_600, outputTokens: 500, costUsd: 0.007475 });
    expect(scripted.find((entrant) => entrant.id === 'opencode-1'))
      .toMatchObject({ inputTokens: 3_600, outputTokens: 500, costUsd: null });

    const steerResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/steer`,
      headers: operatorHeaders,
      payload: { text: 'Check storage slot zero.' },
    });
    expect(steerResponse.statusCode).toBe(202);
    expect(steerResponse.json()).toEqual({ accepted: true, status: 'injected' });
    expect(server.journal.after(run.id, run.lastEventId).some((event) =>
      event.type === 'entrant.steered' && event.payload.text === 'Check storage slot zero.',
    )).toBe(true);

    const stopResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/stop`,
      headers: operatorHeaders,
    });
    expect(stopResponse.statusCode).toBe(200);
    expect((stopResponse.json() as { run: RunSnapshot }).run.state).toBe('finished');
    expect(server.manager.snapshot(run.id).entrants.every((entrant) => entrant.status === 'done')).toBe(true);
  });
});

async function withAutoSignDisabled<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.ARENA_AUTO_SIGN;
  process.env.ARENA_AUTO_SIGN = 'false';
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.ARENA_AUTO_SIGN;
    } else {
      process.env.ARENA_AUTO_SIGN = previous;
    }
  }
}

async function withAutoSignEnabled<T>(action: () => Promise<T>): Promise<T> {
  const previous = process.env.ARENA_AUTO_SIGN;
  process.env.ARENA_AUTO_SIGN = 'true';
  try {
    return await action();
  } finally {
    if (previous === undefined) {
      delete process.env.ARENA_AUTO_SIGN;
    } else {
      process.env.ARENA_AUTO_SIGN = previous;
    }
  }
}

function createSeedTestServer(
  operatorAddresses: readonly string[] = [LOCAL_DEV_OPERATOR.address],
): ArenaServer {
  const server = createServer({
    dbPath: ':memory:',
    operatorToken: OPERATOR_TOKEN,
    siwe: { operatorAddresses, domains: ['localhost'] },
    driverFactory: () => noopDriver,
    fundingGateFactory: () => async () => {},
  });
  servers.push(server);
  return server;
}

function highSSignature(signature: Hex): Hex {
  const parsed = parseSignature(signature);
  return serializeSignature({
    r: parsed.r,
    s: toHex(SECP256K1_N - BigInt(parsed.s), { size: 32 }),
    yParity: parsed.yParity === 0 ? 1 : 0,
  });
}

function paritySignature(signature: Hex): Hex {
  const { yParity } = parseSignature(signature);
  return `${signature.slice(0, -2)}0${yParity}` as Hex;
}

async function waitForState(
  server: ArenaServer,
  runId: string,
  state: RunSnapshot['state'],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.manager.snapshot(runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Run ${runId} did not reach ${state}`);
}

describe('director broadcast', () => {
  it('injects one message into every live entrant and emits one broadcast event', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      schedule: (task) => {
        task();
        return undefined;
      },
    });
    servers.push(server);

    const createResponse = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', autoStart: true },
    });
    const { run } = createResponse.json() as { run: RunSnapshot };

    const broadcastResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
      headers: operatorHeaders,
      payload: { text: 'Five minutes left, ship what you have.' },
    });
    expect(broadcastResponse.statusCode).toBe(202);
    expect(broadcastResponse.json()).toEqual({
      accepted: true,
      delivered: ['codex-1', 'opencode-1'],
      queued: [],
      failed: [],
    });

    const since = server.journal.after(run.id, run.lastEventId);
    const broadcasts = since.filter((event) => event.type === 'director.broadcast');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.source).toBe('run');
    expect(broadcasts[0]?.payload.targetEntrantIds).toEqual(['codex-1', 'opencode-1']);
    expect(since.filter((event) =>
      event.type === 'entrant.steered' && event.payload.text === 'Five minutes left, ship what you have.',
    ).map((event) => event.source)).toEqual(['codex-1', 'opencode-1']);
  });

  it('reports the queued subset when one entrant is mid-turn and another is idle', async () => {
    const inFlight = new Set(['codex-1']);
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      driverFactory: () => ({
        ...noopDriver,
        async steer(_run, entrant) {
          return inFlight.has(entrant.id) ? 'queued' : 'injected';
        },
      }),
    });
    servers.push(server);

    const createResponse = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel', autoStart: true },
    });
    const { run } = createResponse.json() as { run: RunSnapshot };

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
      headers: operatorHeaders,
      payload: { text: 'Ship what you have.' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      accepted: true,
      delivered: ['codex-1', 'opencode-1'],
      queued: ['codex-1'],
      failed: [],
    });
  });

  it('rejects an empty body, an unknown run, and a run that is not running', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    const empty = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
      headers: operatorHeaders,
      payload: { text: '' },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await server.app.inject({
      method: 'POST',
      url: '/runs/missing-run/broadcast',
      headers: operatorHeaders,
      payload: { text: 'anyone there?' },
    });
    expect(missing.statusCode).toBe(404);

    // The run exists but has not started, so no steer may reach the driver.
    const notRunning = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
      headers: operatorHeaders,
      payload: { text: 'anyone there?' },
    });
    expect(notRunning.statusCode).toBe(400);
    expect(server.journal.after(run.id, 0).filter((event) => event.type === 'director.broadcast')).toEqual([]);
  });

  it('answers 409 when an entrant cannot take the turn', async () => {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      driverFactory: () => ({
        async prepare() {},
        async start() {},
        async steer(_run, entrant) {
          throw new EntrantUnavailableError(`Entrant ${entrant.id} is degraded`);
        },
        async restart() {},
        async stop() {},
      }),
    });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    const steer = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/steer`,
      headers: operatorHeaders,
      payload: { text: 'are you there?' },
    });
    expect(steer.statusCode).toBe(409);
    expect(steer.json()).toEqual({ error: 'Entrant codex-1 is degraded' });
  });
});

describe('entrant restart', () => {
  function advanceToRunning(server: ArenaServer, runId: string): void {
    for (const state of ['awaiting_signature', 'preparing', 'awaiting_funding', 'ready', 'running'] as const) {
      server.manager.transition(runId, state);
    }
  }

  async function runningServer(driver?: Partial<EntrantDriver>) {
    const server = createServer({
      dbPath: ':memory:',
      operatorToken: OPERATOR_TOKEN,
      ...(driver === undefined ? {} : { driverFactory: () => ({ ...noopDriver, ...driver }) }),
    });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });
    return { server, run };
  }

  it('restarts one lane and reports it accepted', async () => {
    const restarts: Array<{ entrantId: string; prompt: string }> = [];
    const { server, run } = await runningServer({
      async restart(_run, entrant, openingPrompt) {
        restarts.push({ entrantId: entrant.id, prompt: openingPrompt });
      },
    });
    advanceToRunning(server, run.id);

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/restart`,
      headers: operatorHeaders,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    // Only the named lane, and on the prompt the backend rebuilt for it.
    expect(restarts.map((restart) => restart.entrantId)).toEqual(['codex-1']);
    expect(restarts[0]?.prompt).toContain('Solidity Invaders');
    expect(server.manager.snapshot(run.id).state).toBe('running');
  });

  it('rejects an unknown run, an unknown entrant, and a run that is not running', async () => {
    const { server, run } = await runningServer();

    const missingRun = await server.app.inject({
      method: 'POST',
      url: '/runs/missing-run/entrants/codex-1/restart',
      headers: operatorHeaders,
    });
    expect(missingRun.statusCode).toBe(404);

    // The run exists but has not started, so there is no session to replace.
    const notRunning = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/restart`,
      headers: operatorHeaders,
    });
    expect(notRunning.statusCode).toBe(400);

    // Both wrong at once: a name that was never on the roster is a 404 whatever
    // the run is doing, the same answer steer gives.
    const ghostBeforeStart = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/ghost-1/restart`,
      headers: operatorHeaders,
    });
    expect(ghostBeforeStart.statusCode).toBe(404);

    advanceToRunning(server, run.id);
    const missingEntrant = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/ghost-1/restart`,
      headers: operatorHeaders,
    });
    expect(missingEntrant.statusCode).toBe(404);
  });

  it('answers 409 when the lane cannot be restarted right now', async () => {
    const { server, run } = await runningServer({
      async restart(_run, entrant) {
        throw new EntrantUnavailableError(`Entrant ${entrant.id} is stopping`);
      },
    });
    advanceToRunning(server, run.id);

    const response = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/restart`,
      headers: operatorHeaders,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Entrant codex-1 is stopping' });
  });
});

describe('operator auth', () => {
  it('rejects every mutating route with a missing or wrong token and leaves reads open', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    // Every mutating route, once with no credential and once with a wrong one.
    // Broadcast is here to prove the method-based gate covers a route added later.
    const routes = [
      { url: '/runs', payload: { preset: 'fake-duel' } },
      { url: `/runs/${run.id}/start` },
      { url: `/runs/${run.id}/seed` },
      { url: `/runs/${run.id}/stop` },
      { url: `/runs/${run.id}/entrants/codex-1/steer`, payload: { text: 'no token' } },
      { url: `/runs/${run.id}/entrants/codex-1/restart` },
      { url: `/runs/${run.id}/broadcast`, payload: { text: 'no token' } },
    ];
    const credentials = [undefined, { authorization: 'Bearer wrong-token' }, { authorization: OPERATOR_TOKEN }];
    const unauthorized = await Promise.all(routes.flatMap((route) =>
      credentials.map(async (headers) => server.app.inject({
        method: 'POST',
        url: route.url,
        ...(headers === undefined ? {} : { headers }),
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      })),
    ));
    for (const response of unauthorized) {
      expect(response.statusCode).toBe(401);
      expect(response.json() as { error: string }).toEqual({ error: 'Operator token required' });
      expect(response.headers['www-authenticate']).toContain('Bearer');
    }
    // A rejected request must not have touched the run.
    expect(server.manager.snapshot(run.id).state).toBe('created');

    const snapshotResponse = await server.app.inject({ method: 'GET', url: `/runs/${run.id}` });
    expect(snapshotResponse.statusCode).toBe(200);
    const headResponse = await server.app.inject({ method: 'HEAD', url: `/runs/${run.id}` });
    expect(headResponse.statusCode).toBe(200);
    // No OPTIONS route exists; the gate must let it reach the router rather than answer 401.
    const optionsResponse = await server.app.inject({ method: 'OPTIONS', url: `/runs/${run.id}` });
    expect(optionsResponse.statusCode).toBe(404);

    const address = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    const stream = await fetch(`${address}/runs/${run.id}/events`, { signal: abort.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    abort.abort();

    const authorized = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: operatorHeaders,
      payload: { preset: 'fake-duel' },
    });
    expect(authorized.statusCode).toBe(201);
  });

  it('refuses to build a server on a token that is empty or only whitespace', () => {
    for (const operatorToken of ['', '   ', '\t\n']) {
      expect(() => createServer({ dbPath: ':memory:', operatorToken })).toThrow(MissingOperatorTokenError);
    }
  });

  it('treats a malformed session cookie as missing', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { cookie: 'arena_operator=%' },
      payload: { preset: 'fake-duel' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Operator token required' });
  });

  it('treats bracketed IPv6 loopback with a port as insecure', () => {
    const request = { headers: { host: '[::1]:4177' } } as Parameters<typeof isSecureRequest>[0];
    expect(isSecureRequest(request)).toBe(false);
  });

  it('answers a Fastify client error with its own status and hides everything else', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    // The Docker daemon reports a name collision as a 409 carrying the host path,
    // so a status code alone must not be enough to reach the client.
    server.app.get('/test-docker-error', async () => {
      throw Object.assign(new Error('(HTTP code 409) Conflict. The container name "/arena-1" is in use'), {
        statusCode: 409,
      });
    });
    server.app.get('/test-fastify-error', async () => {
      throw Object.assign(new Error('Unsupported Media Type: text/csv'), {
        statusCode: 415,
        code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      });
    });

    const hidden = await server.app.inject({ method: 'GET', url: '/test-docker-error' });
    expect(hidden.statusCode).toBe(500);
    expect(hidden.json()).toEqual({ error: 'Internal server error' });

    const passed = await server.app.inject({ method: 'GET', url: '/test-fastify-error' });
    expect(passed.statusCode).toBe(415);
  });

  it('rejects every content type a plain HTML form can post before the handler runs', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    // Body parsing is one of the three layers holding CSRF off the control routes.
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/stop`,
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'content-type': contentType },
        payload: '',
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(server.manager.snapshot(run.id).state).toBe('created');
  });

  it('ignores surrounding whitespace on both sides of the comparison', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: `  ${OPERATOR_TOKEN}  ` });
    servers.push(server);

    const response = await server.app.inject({
      method: 'POST',
      url: '/runs',
      headers: { authorization: `Bearer   ${OPERATOR_TOKEN} ` },
      payload: { preset: 'fake-duel' },
    });
    expect(response.statusCode).toBe(201);
  });
});

async function readSseEvents(response: Response, count: number): Promise<ArenaEvent[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE response has no body');
  const decoder = new TextDecoder();
  const events: ArenaEvent[] = [];
  let buffer = '';

  while (events.length < count) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE stream ended after ${events.length} events`);
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) events.push(JSON.parse(data.slice(6)) as ArenaEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
}
