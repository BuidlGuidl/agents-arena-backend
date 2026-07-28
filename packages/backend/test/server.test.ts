import { afterEach, describe, expect, it } from 'vitest';

import type { ArenaEvent, RunSnapshot } from '../src/contract.js';
import { createServer, type ArenaServer } from '../src/server.js';

const servers: ArenaServer[] = [];
const OPERATOR_TOKEN = 'test-operator-token';
const operatorHeaders = { authorization: `Bearer ${OPERATOR_TOKEN}` };

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ app }) => app.close()));
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
      expect(beforeSteer.filter((event) => event.source === entrantId).map((event) => event.type))
        .toEqual(['entrant.status', 'agent.message', 'tool.call', 'tool.result', 'entrant.status']);
    }

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

describe('operator auth', () => {
  it('rejects mutating requests without a valid token and leaves reads open', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: OPERATOR_TOKEN });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });

    const unauthorized = await Promise.all([
      server.app.inject({ method: 'POST', url: '/runs', payload: { preset: 'fake-duel' } }),
      server.app.inject({
        method: 'POST',
        url: '/runs',
        headers: { authorization: 'Bearer wrong-token' },
        payload: { preset: 'fake-duel' },
      }),
      server.app.inject({ method: 'POST', url: `/runs/${run.id}/start` }),
      server.app.inject({ method: 'POST', url: `/runs/${run.id}/stop` }),
      server.app.inject({
        method: 'POST',
        url: `/runs/${run.id}/entrants/codex-1/steer`,
        payload: { text: 'no token' },
      }),
    ]);
    for (const response of unauthorized) {
      expect(response.statusCode).toBe(401);
      expect(response.json() as { error: string }).toEqual({ error: 'Operator token required' });
      expect(response.headers['www-authenticate']).toContain('Bearer');
    }
    // A rejected request must not have touched the run.
    expect(server.manager.snapshot(run.id).state).toBe('created');

    const snapshotResponse = await server.app.inject({ method: 'GET', url: `/runs/${run.id}` });
    expect(snapshotResponse.statusCode).toBe(200);

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
