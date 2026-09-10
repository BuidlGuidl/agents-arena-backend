import { describe, expect, it } from 'vitest';

import { AgentTokens } from '../src/agent-auth.js';
import { createServer } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';

const servers = serverHarness();
const address = '0x1234567890123456789012345678901234567890';

describe('HTTP request validation', () => {
  it.each([
    [{}, [['preset']]],
    [{ preset: '' }, [['preset']]],
    [{ preset: [] }, [['preset'], ['preset']]],
    [{ preset: 'fake-duel', extra: true }, [[]]],
    [{ preset: 'fake-duel', durationMs: 1.5 }, [['durationMs']]],
    [{ preset: 'fake-duel', durationMs: 1e20 }, [['durationMs'], ['durationMs']]],
    [{ preset: 'fake-duel', roster: 'too long for an array' }, [['roster'], ['roster']]],
    [{ preset: 'fake-duel', roster: [{ id: 'agent', harness: 'codex', model: 'gpt-4', effort: 'high' }] }, [
      ['roster', 0, 'model'],
    ]],
  ])('reports run issue paths for %j', async (payload, paths) => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator' });
    servers.push(server);
    const response = await server.app.inject({ method: 'POST', url: '/runs',
      headers: { authorization: 'Bearer operator' }, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid request body');
    expect(response.json().issues.map((issue: { path: (string | number)[] }) => issue.path)).toEqual(paths);
  });

  it('reports join issue paths', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator' });
    servers.push(server);
    const { token } = new AgentTokens(server.journal.database).register(address, () => {});
    const response = await server.app.inject({ method: 'POST', url: '/agent/join',
      headers: { authorization: `Bearer ${token}` }, payload: { name: '', url: 'https://' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid request body');
    expect(response.json().issues.map((issue: { path: (string | number)[] }) => issue.path))
      .toEqual([['name'], ['url']]);
  });

  it('keeps empty HTTP metadata and rejects an empty HTTP runId', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', flagsHeld: async () => 0 });
    servers.push(server);
    await server.manager.create({ preset: 'fake-duel' });
    const { token } = new AgentTokens(server.journal.database).register(address, () => {});
    const headers = { authorization: `Bearer ${token}` };
    const payload = { name: 'Agent', harness: '', model: '', effort: '', url: 'HTTP:example.com' };
    expect((await server.app.inject({ method: 'POST', url: '/agent/join', headers, payload })).statusCode).toBe(201);
    const invalid = await server.app.inject({ method: 'POST', url: '/agent/join', headers, payload: { ...payload, runId: '' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('Invalid request body');
    expect(invalid.json().issues.map((issue: { path: (string | number)[] }) => issue.path)).toEqual([['runId']]);
  });
});
