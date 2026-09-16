import { describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';
import { signedEntry } from './enter-helper.js';

const servers = serverHarness();

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

  it('reports entry issue paths', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator' });
    servers.push(server);
    const response = await server.app.inject({ method: 'POST', url: '/agent/enter',
      payload: { ...await signedEntry(server), name: '', url: 'https://' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Invalid request body');
    expect(response.json().issues.map((issue: { path: (string | number)[] }) => issue.path))
      .toEqual([['name'], ['url']]);
  });

  it('rejects empty HTTP metadata and an empty HTTP runId, and trims what it keeps', async () => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', flagsHeld: async () => 0 });
    servers.push(server);
    const { run } = await server.manager.create({ preset: 'fake-duel' });
    const payload = { ...await signedEntry(server), name: 'Agent', harness: '', model: '', effort: '', url: 'HTTP:example.com' };
    const empty = await server.app.inject({ method: 'POST', url: '/agent/enter', payload });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('Invalid request body');
    expect(empty.json().issues.map((issue: { path: (string | number)[] }) => issue.path)).toEqual([['harness'], ['model'], ['effort']]);
    const invalid = await server.app.inject({ method: 'POST', url: '/agent/enter', payload: { ...payload, harness: 'codex', model: 'gpt', effort: 'high', runId: '' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues.map((issue: { path: (string | number)[] }) => issue.path)).toEqual([['runId']]);
    const trimmed = await server.app.inject({ method: 'POST', url: '/agent/enter', payload: { ...payload, harness: '  codex  ', model: ' gpt ', effort: ' high ' } });
    expect(trimmed.statusCode).toBe(201);
    const entrant = server.manager.snapshot(run.id).entrants.find((candidate) => candidate.id === trimmed.json().entrantId);
    expect(entrant?.kind === 'external' ? [entrant.harness, entrant.model, entrant.effort] : null).toEqual(['codex', 'gpt', 'high']);
  });
});
