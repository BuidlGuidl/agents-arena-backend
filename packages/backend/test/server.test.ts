import { afterEach, describe, expect, it } from 'vitest';

import type { ArenaEvent, RunSnapshot } from '../src/contract.js';
import { createServer, type ArenaServer } from '../src/server.js';

const servers: ArenaServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
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

describe('director broadcast', () => {
  it('injects one message into every live entrant and emits one broadcast event', async () => {
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
    const { run } = createResponse.json() as { run: RunSnapshot };

    const broadcastResponse = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
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
    expect(broadcasts[0]?.payload.entrantIds).toEqual(['codex-1', 'opencode-1']);
    expect(since.filter((event) =>
      event.type === 'entrant.steered' && event.payload.text === 'Five minutes left, ship what you have.',
    ).map((event) => event.source)).toEqual(['codex-1', 'opencode-1']);
  });

  it('rejects an empty body and an unknown run', async () => {
    const server = createServer({ dbPath: ':memory:' });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    const empty = await server.app.inject({
      method: 'POST',
      url: `/runs/${run.id}/broadcast`,
      payload: { text: '' },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await server.app.inject({
      method: 'POST',
      url: '/runs/missing-run/broadcast',
      payload: { text: 'anyone there?' },
    });
    expect(missing.statusCode).toBe(404);
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
