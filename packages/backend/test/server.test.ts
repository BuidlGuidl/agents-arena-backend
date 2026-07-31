import { afterEach, describe, expect, it } from 'vitest';

import { EntrantUnavailableError } from '../src/adapters/types.js';
import { isSecureRequest, MissingOperatorTokenError } from '../src/auth.js';
import type { ArenaEvent, HistoryPage, RunSnapshot } from '../src/contract.js';
import { capEvent, EVENT_TEXT_LIMIT } from '../src/journal.js';
import { createServer, type ArenaServer } from '../src/server.js';

const servers: ArenaServer[] = [];
const OPERATOR_TOKEN = 'test-operator-token';
const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
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
          'entrant.status', 'agent.message', 'tool.call', 'tool.result',
          'usage', 'entrant.status', 'usage',
        ]);
      const toolEvents = entrantEvents.filter((event) =>
        event.type === 'tool.call' || event.type === 'tool.result',
      );
      expect(toolEvents[0]?.payload.toolCallId).toBe(toolEvents[1]?.payload.toolCallId);
    }

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
      { url: `/runs/${run.id}/stop` },
      { url: `/runs/${run.id}/entrants/codex-1/steer`, payload: { text: 'no token' } },
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
