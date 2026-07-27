import { afterEach, describe, expect, it } from 'vitest';

import type { ArenaEvent, HistoryPage, RunSnapshot } from '../src/contract.js';
import { createServer, type ArenaServer } from '../src/server.js';

const servers: ArenaServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
});

describe('event history', () => {
  it('returns the newest events in ascending order', async () => {
    const server = createServer({ dbPath: ':memory:' });
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

  it('accepts a limit of 200, rejects larger limits, and defaults to 50', async () => {
    const server = createServer({ dbPath: ':memory:' });
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
    expect(invalid.json()).toEqual({ error: 'Invalid limit query value' });
    expect(maximum.statusCode).toBe(200);
    expect((maximum.json() as HistoryPage).events).toHaveLength(56);
    expect((defaulted.json() as HistoryPage).events).toHaveLength(50);
  });

  it('rejects unknown event types and empty CSV items', async () => {
    const server = createServer({ dbPath: ':memory:' });
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
    const server = createServer({ dbPath: ':memory:' });
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
    const server = createServer({ dbPath: ':memory:' });
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

    expect(hexadecimal.statusCode).toBe(400);
    expect(unsafe.statusCode).toBe(400);
  });

  it('returns 404 for an unknown run', async () => {
    const server = createServer({ dbPath: ':memory:' });
    servers.push(server);

    const response = await server.app.inject({
      method: 'GET',
      url: '/runs/missing/events/history',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Run not found: missing' });
  });

  it('only marks history immutable when its exclusive cursor cannot gain events', async () => {
    const server = createServer({ dbPath: ':memory:' });
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
    const server = createServer({ dbPath: ':memory:' });
    servers.push(server);
    const created = await server.manager.create({ preset: 'fake-duel' });
    server.journal.append(created.run.id, 'codex-1', 'agent.message', {
      entrantId: 'codex-1',
      text: 'tail one',
    });
    server.journal.append(created.run.id, 'opencode-1', 'tool.call', {
      entrantId: 'opencode-1',
      tool: 'shell',
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
    const server = createServer({ dbPath: ':memory:' });
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
      schedule: (task) => {
        task();
        return undefined;
      },
    });
    servers.push(server);

    const createResponse = await server.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { preset: 'fake-duel', autoStart: true },
    });
    expect(createResponse.statusCode).toBe(201);
    const { run } = createResponse.json() as { run: RunSnapshot };
    expect(run.state).toBe('running');
    expect(run.entrants.map((entrant) => entrant.id)).toEqual(['codex-1', 'opencode-1']);

    const beforeSteer = server.journal.after(run.id, 0);
    for (const entrantId of ['codex-1', 'opencode-1']) {
      expect(beforeSteer.filter((event) => event.source === entrantId).map((event) => event.type))
        .toEqual(['entrant.status', 'agent.message', 'tool.call', 'tool.result', 'entrant.status']);
    }

    const steerResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/entrants/codex-1/steer`,
      payload: { text: 'Check storage slot zero.' },
    });
    expect(steerResponse.statusCode).toBe(202);
    expect(server.journal.after(run.id, run.lastEventId).some((event) =>
      event.type === 'entrant.steered' && event.payload.text === 'Check storage slot zero.',
    )).toBe(true);

    const stopResponse = await server.app.inject({ method: 'POST', url: `/runs/${run.id}/stop` });
    expect(stopResponse.statusCode).toBe(200);
    expect((stopResponse.json() as { run: RunSnapshot }).run.state).toBe('finished');
    expect(server.manager.snapshot(run.id).entrants.every((entrant) => entrant.status === 'done')).toBe(true);
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
