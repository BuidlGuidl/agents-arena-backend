import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentMcpOriginGuard } from '../src/agent-mcp.js';
import { AgentTokens } from '../src/agent-auth.js';
import { AGENT_MCP_TOOLS } from '../src/contract.js';
import { dropCurrentChallenge } from '../src/ctf/challenge-tracker.js';
import { agentTokens } from '../src/db/schema.js';
import { createServer, type ArenaServer } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';

const address = '0x1234567890123456789012345678901234567890';
const publicUrl = 'https://arena.test';
const siteUrl = 'https://site.test';
const registerText = `This MCP server has no valid arena token. Ask the person running you to follow ${siteUrl}/arena/join, ` +
  "which explains how to create one, and to add it to this server's Authorization header.";
const expiredText = `This arena token expired on 2000-01-01. Ask the person running you to follow ${siteUrl}/arena/join ` +
  "to create a new one and update this server's Authorization header.";
const serverInstructions = 'These tools are for racing in Agents Arena, a capture-the-flag race between coding agents scored on-chain. ' +
  'Use them only when the person running you asks you to join or race. Do not call them during unrelated work.';
const servers = serverHarness((server) => {
  for (const run of server.manager.list(200)) {
    for (const entrant of server.manager.snapshot(run.id).entrants) dropCurrentChallenge(run.id, entrant.id);
  }
});
afterEach(() => { vi.restoreAllMocks(); });

function setup() {
  const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', publicUrl, siteUrl,
    corsOrigins: [publicUrl], schedule: () => {}, flagsHeld: async () => 4 });
  servers.push(server);
  const { token } = new AgentTokens(server.journal.database).register(address, () => {});
  return { ...server, token };
}

function modern(server: ArenaServer, method: string, params: Record<string, unknown> = {}, token?: string,
  headers: Record<string, string> = {}) {
  return server.app.inject({ method: 'POST', url: '/mcp', headers: {
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
    ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers,
  }, payload: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  } } } });
}

async function call(server: ArenaServer, name: string, args = {}, token?: string) {
  const response = await modern(server, 'tools/call', { name, arguments: args }, token);
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.error).toBeUndefined();
  const result = body.result;
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  return result;
}

async function joined() {
  const f = setup();
  const { run } = await f.manager.create({ preset: 'fake-duel' });
  const joined = await call(f, 'join_run', { name: 'Agent', harness: 'codex', model: 'model' }, f.token);
  expect(joined.structuredContent).toEqual({ entrantId: expect.any(String),
    message: 'You are in. Call get_task for the briefing.', run: { id: run.id, state: 'created' }, inbox: { unread: 0 } });
  return { ...f, runId: run.id, entrantId: joined.structuredContent.entrantId as string };
}

function legacyBody(body: string) {
  return JSON.parse(body.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
}

describe('arena MCP', () => {
  it('lists the same five tools publicly with absent, dead, expired, and valid tokens', async () => {
    const f = setup();
    const first = await modern(f, 'tools/list');
    expect(first.statusCode).toBe(200);
    const expected = first.json();
    expect(expected.result.cacheScope).toBe('public');
    expect(expected.result.tools.map((tool: { name: string }) => tool.name)).toEqual(AGENT_MCP_TOOLS);
    for (const token of ['dead', f.token]) expect((await modern(f, 'tools/list', {}, token)).json()).toEqual(expected);
    f.journal.database.update(agentTokens).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).run();
    expect((await modern(f, 'tools/list', {}, f.token)).json()).toEqual(expected);
    for (const tool of expected.result.tools) {
      expect(tool.description).toContain('Agents Arena');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties.token).toBeUndefined();
    }
    expect(expected.result.tools[1].annotations.readOnlyHint).toBe(true);
    const [join, , challenge, note, inbox] = expected.result.tools;
    expect(join.inputSchema.required).toEqual(['name']);
    expect(join.inputSchema.properties.name).toEqual({ type: 'string', minLength: 1, maxLength: 40 });
    for (const key of ['harness', 'model', 'effort']) {
      expect(join.inputSchema.properties[key]).toEqual({ type: 'string', minLength: 1, maxLength: 80 });
    }
    expect(join.inputSchema.properties.url).toMatchObject({ type: 'string', format: 'uri', maxLength: 200 });
    const urlPattern = new RegExp(join.inputSchema.properties.url.pattern);
    expect(urlPattern.test('HTTPS://arena.test')).toBe(true);
    expect(urlPattern.test('file:///tmp/x')).toBe(false);
    expect(challenge.inputSchema.properties.challengeId).toEqual({ type: 'integer', minimum: 1, maximum: 12 });
    expect(note.inputSchema.properties.text).toEqual({ type: 'string', minLength: 1, maxLength: 4000 });
    expect(inbox.inputSchema.properties.after).toEqual({
      type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0,
    });
    expect(inbox.inputSchema.required).toBeUndefined();
  });

  it.each([
    { corsOrigins: ['https://browser.test', 'https://other.test'], expected: 'https://browser.test' },
    { corsOrigins: [], expected: publicUrl },
  ])('defaults the join link to $expected when siteUrl is omitted', async ({ corsOrigins, expected }) => {
    const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', publicUrl, corsOrigins });
    servers.push(server);
    const result = await call(server, 'get_task');
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe(registerText.replace(siteUrl, expected));
  });

  it.each(['missing', 'unknown', 'expired', 'rotated'])('returns the registration text for a %s token', async (kind) => {
    const f = setup();
    if (kind === 'expired') f.journal.database.update(agentTokens).set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(agentTokens.address, address)).run();
    if (kind === 'rotated') new AgentTokens(f.journal.database).register(address, () => {});
    const token = kind === 'missing' ? undefined : kind === 'unknown' ? 'dead' : f.token;
    for (const name of AGENT_MCP_TOOLS) {
      const result = await call(f, name, {}, token);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: kind === 'expired' ? expiredText : registerText });
    }
  });

  it.each([{ name: 'Agent' }, { name: 'Agent', harness: 'codex' }])('joins with optional display fields omitted: %j', async (args) => {
    const f = setup();
    const { run } = await f.manager.create({ preset: 'fake-duel' });
    const result = await call(f, 'join_run', args, f.token);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.run.id).toBe(run.id);
    expect(f.manager.snapshot(run.id).entrants.find((entrant) => entrant.id === result.structuredContent.entrantId))
      .toMatchObject({ name: 'Agent' });
  });

  it('serves server instructions through modern discovery', async () => {
    const response = await modern(setup(), 'server/discover');
    expect(response.statusCode).toBe(200);
    expect(response.json().result.instructions).toBe(serverInstructions);
    expect(response.json().result.supportedVersions).toContain('2026-07-28');
  });

  it('tells a registered wallet to join first', async () => {
    const f = setup();
    const result = await call(f, 'get_task', {}, f.token);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe('Not in a run. Call join_run first.');
  });

  it('joins without a run id and serves all tools with run state and unread counts', async () => {
    const f = await joined();
    const task = await call(f, 'get_task', {}, f.token);
    expect(task.structuredContent).toMatchObject({ task: null, run: { id: f.runId, state: 'created' }, inbox: { unread: 0 } });
    expect(task.structuredContent.instructions).toBe('The race has not started. Ask the person running you to say "go" when it starts, ' +
      'or call get_task again in about thirty seconds. Do not start work until task is set.');
    await f.manager.start(f.runId);
    const briefing = await call(f, 'get_task', {}, f.token);
    expect(briefing.structuredContent.run.state).toBe('running');
    expect(briefing.structuredContent.task).toContain(
      '- Report as you go through the arena tools: call set_current_challenge before you start each challenge, ' +
      'post_note after every attempt and at least every few minutes while you work, and read_inbox between steps. ' +
      `If you do not have the tools, use the agent API at ${publicUrl}, documented at ${siteUrl}/arena/join.`,
    );
    expect(briefing.structuredContent.instructions).toBe('Call post_note between steps to say what you are doing and how you are approaching the challenge, ' +
      'and after each attempt, success or failure. Call set_current_challenge when you start a challenge. ' +
      'Call read_inbox between steps; inbox.unread tells you when there is something.');
    const steer = await f.app.inject({ method: 'POST', url: `/runs/${f.runId}/entrants/${f.entrantId}/steer`,
      headers: { authorization: 'Bearer operator' }, payload: { text: 'Try another approach' } });
    expect(steer.statusCode).toBe(202);
    expect((await call(f, 'get_task', {}, f.token)).structuredContent.inbox.unread).toBe(1);
    const progress = await call(f, 'set_current_challenge', { challengeId: 3 }, f.token);
    expect(progress.structuredContent).toEqual({ ok: true, changed: true, run: { id: f.runId, state: 'running' }, inbox: { unread: 1 } });
    const note = await call(f, 'post_note', { text: 'The attempt failed', status: 'blocked' }, f.token);
    expect(note.structuredContent).toEqual({ accepted: 2, run: { id: f.runId, state: 'running' }, inbox: { unread: 1 } });
    expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status).toBe('blocked');
    expect((await call(f, 'post_note', { text: 'Another attempt' }, f.token)).structuredContent.accepted).toBe(1);
    expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status).toBe('blocked');
    for (const status of ['idle', 'done', 'working', 'blocked']) {
      expect((await call(f, 'post_note', { text: 'Status update', status }, f.token)).structuredContent.accepted).toBe(2);
      expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)?.status).toBe(status);
    }

    const inbox = await call(f, 'read_inbox', {}, f.token);
    expect(inbox.structuredContent).toMatchObject({ messages: [{ text: 'Try another approach', kind: 'steer' }],
      cursor: expect.any(Number), run: { id: f.runId, state: 'running' }, inbox: { unread: 0 } });
    expect((await call(f, 'get_task', {}, f.token)).structuredContent.inbox.unread).toBe(0);
  });

  it('rejoins an explicit run through the shared join rules', async () => {
    const f = await joined();
    await f.manager.start(f.runId);
    const prompts = () => f.journal.after(f.runId, 0).filter((event) => event.source === f.entrantId && event.type === 'entrant.prompt');
    const before = prompts().length;
    const rejoin = await call(f, 'join_run', { runId: f.runId, name: 'Updated', harness: 'codex', model: 'new-model' }, f.token);
    expect(rejoin.structuredContent.entrantId).toBe(f.entrantId);
    expect(rejoin.structuredContent.run.state).toBe('running');
    expect(prompts()).toHaveLength(before);
    expect(f.manager.snapshot(f.runId).entrants.find((entrant) => entrant.id === f.entrantId)).toMatchObject({
      name: 'Updated', model: 'new-model', task: { ctfFlagsBeforeJoin: 4 },
    });
  });

  it('shares event, progress, and inbox limits across HTTP and MCP', async () => {
    const f = await joined();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const headers = { authorization: `Bearer ${f.token}` };
    for (let seq = 0; seq < 29; seq++) {
      expect((await f.app.inject({ method: 'POST', url: '/agent/events', headers,
        payload: { events: [{ seq, type: 'agent.message', text: 'attempt' }] } })).statusCode).toBe(200);
    }
    expect((await call(f, 'post_note', { text: 'last allowed' }, f.token)).isError).toBeUndefined();
    expect((await call(f, 'post_note', { text: 'too fast' }, f.token)).structuredContent.error).toBe('Too fast. Try again in 10 seconds.');
    expect((await f.app.inject({ method: 'GET', url: '/agent/inbox', headers })).statusCode).toBe(200);
    const poll = await call(f, 'read_inbox', {}, f.token);
    expect(poll.isError).toBe(true);
    expect(poll.structuredContent.error).toBe('Too fast. Try again in 1 seconds.');
    await call(f, 'set_current_challenge', { challengeId: 3 }, f.token);
    expect((await f.app.inject({ method: 'POST', url: '/agent/progress', headers, payload: { challengeId: 4 } })).statusCode).toBe(429);
    const progress = await call(f, 'set_current_challenge', { challengeId: 4 }, f.token);
    expect(progress.isError).toBe(true);
    expect(progress.structuredContent.error).toBe('Too fast. Try again in 1 seconds.');
  });

  it('keeps MCP notes out of HTTP sequence dedupe', async () => {
    const f = await joined();
    for (let i = 0; i < 2; i++) {
      expect((await call(f, 'post_note', { text: 'MCP note', status: 'idle' }, f.token)).structuredContent.accepted).toBe(2);
    }
    const batch = () => f.app.inject({ method: 'POST', url: '/agent/events',
      headers: { authorization: `Bearer ${f.token}` },
      payload: { events: [-1, -2, 0, 1].map((seq) => ({ seq, type: 'agent.message', text: 'HTTP note' })) } });
    expect((await batch()).json()).toEqual({ accepted: 4, duplicates: 0 });
    expect((await batch()).json()).toEqual({ accepted: 0, duplicates: 4 });
    expect(f.journal.after(f.runId, 0).filter((event) => event.type === 'agent.message')).toHaveLength(6);
  });

  it('tells a wallet in another live run to finish or leave that race', async () => {
    const f = await joined();
    const { run } = await f.manager.create({ preset: 'fake-duel' });
    const response = await call(f, 'join_run', {
      runId: run.id, name: 'Agent', harness: 'codex', model: 'model',
    }, f.token);
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toBe(`Already racing in run ${f.runId}. Finish or leave that race first.`);
  });

  it.each([0, 13, Number.MAX_SAFE_INTEGER + 1])('checks lane membership before challenge bounds for %s', async (challengeId) => {
    const f = setup();
    const response = await call(f, 'set_current_challenge', { challengeId }, f.token);
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toBe('Not in a run. Call join_run first.');
  });

  it('includes the validation issue in post_note errors', async () => {
    const f = await joined();
    const response = await modern(f, 'tools/call', { name: 'post_note', arguments: { text: '' } }, f.token);
    expect(response.json().error).toMatchObject({
      code: -32602, message: expect.stringMatching(/^Invalid arguments for post_note: .+/),
    });
  });

  it('names an invalid configured origin in the startup error', () => {
    expect(() => agentMcpOriginGuard([publicUrl, 'bad origin']))
      .toThrow('Invalid MCP CORS origin: "bad origin". Configure a valid URL.');
  });

  it.each([
    ['join_run', { name: 'Agent', harness: '', model: 'model' }],
    ['join_run', { harness: 'codex' }],
    ['join_run', { name: 'Agent', harness: 'codex', model: 'model', url: 'file:///tmp/x' }],
    ['join_run', { name: 'Agent', harness: 'codex', model: 'model', url: 'https://' }],
    ['get_task', { token: 'secret' }],
    ['set_current_challenge', { challengeId: '3' }],
    ['set_current_challenge', { challengeId: 1.5 }],
    ['set_current_challenge', { challengeId: 13, extra: true }],
    ['post_note', { text: '' }],
    ['post_note', { text: 'a'.repeat(4001) }],
    ['post_note', { text: 'note', status: 'unknown' }],
    ['read_inbox', { after: -1 }],
    ['read_inbox', { after: 1.5 }],
    ['read_inbox', { after: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects invalid %s arguments at runtime', async (name, args) => {
    const f = await joined();
    const before = f.journal.after(f.runId, 0);
    const response = await modern(f, 'tools/call', { name, arguments: args }, f.token);
    expect(response.json().error.code).toBe(-32602);
    expect(f.journal.after(f.runId, 0)).toEqual(before);
  });

  it.each([0, 13, Number.MAX_SAFE_INTEGER + 1])('returns the fixed unknown-challenge text for %s', async (challengeId) => {
    const f = await joined();
    const response = await call(f, 'set_current_challenge', { challengeId }, f.token);
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toBe(`Challenge ${challengeId} is not in this race. Call get_task for the valid ids.`);
  });

  it('keeps unexpected failures as server errors without leaking details', async () => {
    const f = await joined();
    vi.spyOn(f.manager, 'agentTask').mockImplementation(() => { throw new Error('private backend detail'); });
    const response = await modern(f, 'tools/call', { name: 'get_task' }, f.token);
    expect(response.json().error).toMatchObject({ code: -32603, message: 'Internal server error' });
    expect(response.body).not.toContain('private backend detail');
  });

  it('allows no Origin and exact configured Origins, rejects others, and preserves CORS headers', async () => {
    const f = setup();
    expect((await modern(f, 'tools/list')).statusCode).toBe(200);
    const allowed = await modern(f, 'tools/list', {}, undefined, { origin: publicUrl });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(publicUrl);
    for (const origin of ['https://evil.test', 'http://arena.test', 'https://arena.test:8443', 'null', 'bad origin']) {
      expect((await modern(f, 'tools/list', {}, undefined, { origin })).statusCode).toBe(403);
    }
    const preflight = await f.app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: publicUrl,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'MCP-Protocol-Version,Mcp-Method,Mcp-Name' } });
    const deniedPreflight = await f.app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: 'https://evil.test',
      'access-control-request-method': 'POST' } });
    expect(deniedPreflight.statusCode).toBe(403);
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Mcp-Name');
  });

  it('rejects a mismatched modern method header with 400', async () => {
    const response = await modern(setup(), 'tools/list', {}, undefined, { 'mcp-method': 'tools/call' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(-32020);
  });

  it('keeps concurrent callers in their own lanes', async () => {
    const f = await joined();
    const otherAddress = '0x2234567890123456789012345678901234567890';
    const { token } = new AgentTokens(f.journal.database).register(otherAddress, () => {});
    const other = await call(f, 'join_run', { name: 'Other', harness: 'codex', model: 'model' }, token);
    await Promise.all([
      call(f, 'post_note', { text: 'first wallet' }, f.token),
      call(f, 'post_note', { text: 'second wallet' }, token),
    ]);
    const messages = f.journal.after(f.runId, 0).filter((event) => event.type === 'agent.message');
    expect(messages.find((event) => event.payload.text === 'first wallet')?.source).toBe(f.entrantId);
    expect(messages.find((event) => event.payload.text === 'second wallet')?.source).toBe(other.structuredContent.entrantId);
  });

  it('uses the request bearer and shared inbox limit on the legacy path', async () => {
    const f = await joined();
    const response = await f.app.inject({ method: 'POST', url: '/mcp', headers: {
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${f.token}`,
    }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_inbox', arguments: {} } } });
    expect(response.statusCode).toBe(200);
    const result = legacyBody(response.body).result;
    expect(result.structuredContent).toEqual({ messages: [], cursor: 0,
      run: { id: f.runId, state: 'created' }, inbox: { unread: 0 } });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect((await call(f, 'read_inbox', {}, f.token)).structuredContent.error).toBe('Too fast. Try again in 1 seconds.');
  });

  it('serves a raw 2025-06-18 initialize and tool list without a method header or session', async () => {
    const f = setup();
    const headers = { accept: 'application/json, text/event-stream' };
    const initialized = await f.app.inject({ method: 'POST', url: '/mcp', headers, payload: {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
        capabilities: {}, clientInfo: { name: 'raw-test', version: '1.0.0' } },
    } });
    expect(initialized.statusCode).toBe(200);
    expect(initialized.headers['mcp-session-id']).toBeUndefined();
    expect(legacyBody(initialized.body).result.instructions).toBe(serverInstructions);
    expect(legacyBody(initialized.body).result.protocolVersion).toBe('2025-06-18');
    const listed = await f.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    expect(listed.statusCode).toBe(200);
    expect(legacyBody(listed.body).result.tools).toEqual((await modern(f, 'tools/list')).json().result.tools);
    const noToken = await f.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, 'mcp-protocol-version': '2025-06-18' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_task', arguments: {} } } });
    expect(legacyBody(noToken.body).result).toMatchObject({ isError: true, structuredContent: { error: registerText } });
    for (const method of ['GET', 'DELETE'] as const) expect((await f.app.inject({ method, url: '/mcp' })).statusCode).toBe(405);
  });
});
