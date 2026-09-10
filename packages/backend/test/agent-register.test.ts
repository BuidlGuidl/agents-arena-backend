import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { AgentTokens, issueAgentToken, requireLane, resolveAgentToken } from '../src/agent-auth.js';
import { AgentRequestLimit } from '../src/agent-limits.js';
import { registerMessage, REGISTER_MESSAGE_TEMPLATE, type RegisterRequest } from '../src/contract.js';
import { agentTokens, runs } from '../src/db/schema.js';
import { createServer, type ArenaServer } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const servers = serverHarness();
function setup() {
  const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {} });
  servers.push(server);
  return server;
}
async function signed(server: ArenaServer, overrides: Partial<RegisterRequest> = {}): Promise<RegisterRequest> {
  const nonce = (await server.app.inject({ url: '/auth/nonce' })).json().nonce as string;
  const body = { address: account.address, nonce, ...overrides };
  return { ...body, signature: overrides.signature ?? await account.signMessage({ message: registerMessage(body) }) };
}
const register = (server: ArenaServer, payload: object) => server.app.inject({ method: 'POST', url: '/agent/register', payload });
async function credential(server: ArenaServer) {
  const response = await register(server, await signed(server));
  expect(response.statusCode).toBe(201);
  return response.json().token as string;
}
const join = (server: ArenaServer, token: string, payload: object = { name: 'Agent' }) => server.app.inject({
  method: 'POST', url: '/agent/join', headers: { authorization: `Bearer ${token}` }, payload,
});

describe('wallet registration', () => {
  it('creates and rotates one hashed credential per wallet, without a run', async () => {
    const server = setup();
    expect(REGISTER_MESSAGE_TEMPLATE).toBe('Register {address} as an Agents Arena agent with nonce {nonce}');
    const before = Date.now();
    const first = await register(server, await signed(server));
    expect(first.statusCode).toBe(201);
    const body = first.json();
    expect(body.token).toMatch(/^byoa_[0-9a-f]{48}$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(before + 90 * 86400000);
    const store = new AgentTokens(server.journal.database);
    const original = resolveAgentToken(body.token, store);
    expect(original).toEqual({ address: account.address });
    const second = await register(server, await signed(server, { address: account.address.toLowerCase() }));
    expect(second.statusCode).toBe(200);
    expect(resolveAgentToken(body.token, store)).toBeUndefined();
    expect(resolveAgentToken(second.json().token, store)).not.toBe(original);
    const rows = server.journal.database.select().from(agentTokens).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(second.json().token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(second.json().token);
  });

  it.each([{ address: 'bad' }, { nonce: 12 }, { signature: '0x1234' }, { extra: true }])('rejects malformed registration: %j', async (invalid) => {
    const server = setup();
    expect((await register(server, { ...await signed(server), ...invalid })).statusCode).toBe(400);
  });

  it('rejects unknown, expired, spent nonces and a different signer', async () => {
    const server = setup();
    expect((await register(server, await signed(server, { nonce: 'invented' }))).statusCode).toBe(401);
    expect((await register(server, await signed(server, { address: '0x1234567890123456789012345678901234567890' }))).statusCode).toBe(401);
    const body = await signed(server);
    expect((await register(server, body)).statusCode).toBe(201);
    expect((await register(server, body)).statusCode).toBe(401);
    let now = Date.now();
    const expiring = createServer({ dbPath: ':memory:', operatorToken: 'operator', siwe: { operatorAddresses: [], now: () => now } });
    servers.push(expiring);
    const expired = await signed(expiring);
    now += 600001;
    expect((await register(expiring, expired)).statusCode).toBe(401);
  });

  it('consumes the nonce after successful writes and rejects concurrent replay', async () => {
    const server = setup();
    const body = await signed(server);
    server.journal.database.run(sql`CREATE TRIGGER fail_register BEFORE INSERT ON agent_tokens BEGIN SELECT RAISE(FAIL, 'register failed'); END`);
    expect((await register(server, body)).statusCode).toBe(500);
    expect(server.journal.database.select().from(agentTokens).all()).toHaveLength(0);
    server.journal.database.run(sql`DROP TRIGGER fail_register`);
    const responses = await Promise.all([register(server, body), register(server, body)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 401]);
    expect(server.journal.database.select().from(agentTokens).all()).toHaveLength(1);
  });

  it('resolves at 89 days and expires after 90 days', () => {
    const server = setup();
    vi.useFakeTimers();
    try {
      const store = new AgentTokens(server.journal.database);
      const { token } = store.register(account.address.toLowerCase(), () => {});
      const record = store.resolve(token);
      expect(record).toEqual({ address: account.address });
      vi.advanceTimersByTime(89 * 86400000);
      expect(store.resolve(token)).toBe(record);
      vi.advanceTimersByTime(86400000 + 1);
      expect(store.resolve(token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an expired token even after it has resolved', async () => {
    const server = setup();
    const token = await credential(server);
    const store = new AgentTokens(server.journal.database);
    expect(resolveAgentToken(token, store)).toBeDefined();
    server.journal.database.update(agentTokens).set({ expiresAt: new Date(Date.now() - 1).toISOString() }).run();
    expect(resolveAgentToken(token, store)).toBeUndefined();
    expect((await join(server, token)).statusCode).toBe(401);
  });
});

describe('joining with a wallet token', () => {
  it('requires a wallet bearer and rejects old signed-join fields', async () => {
    const server = setup();
    const token = await credential(server);
    expect((await join(server, 'unknown')).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'POST', url: '/agent/join', payload: { name: 'Agent' } })).statusCode).toBe(401);
    expect((await join(server, issueAgentToken('hosted-run', 'hosted'))).statusCode).toBe(401);
    for (const field of ['address', 'nonce', 'signature']) {
      expect((await join(server, token, { name: 'Agent', [field]: 'old' })).statusCode).toBe(400);
    }
  });

  it('returns 409 on each lane route before joining', async () => {
    const server = setup();
    const token = await credential(server);
    for (const [method, url, payload] of [
      ['GET', '/agent/task', undefined], ['GET', '/agent/inbox', undefined],
      ['POST', '/agent/events', { events: [] }], ['POST', '/agent/progress', { challengeId: 1 }],
    ] as const) {
      const response = await server.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Not in a run. Join first.' });
    }
  });

  it('selects the only open run, or names missing and ambiguous runs', async () => {
    const server = setup();
    const token = await credential(server);
    expect((await join(server, token)).json()).toEqual({ error: 'No open run' });
    expect((await join(server, token)).statusCode).toBe(404);
    const first = (await server.manager.create({ preset: 'fake-duel' })).run;
    const response = await join(server, token);
    expect(response.statusCode).toBe(201);
    expect(response.json().run.id).toBe(first.id);
    expect(response.json()).not.toHaveProperty('token');
    // Multiple created runs can exist in persisted data even though create guards the active run.
    server.journal.database.insert(runs).values({ id: 'other', state: 'created', preset: 'fake-duel', createdAt: new Date().toISOString() }).run();
    const rejoined = await join(server, token);
    expect(rejoined.statusCode).toBe(200);
    expect(rejoined.json().run.id).toBe(first.id);
    const otherAccount = privateKeyToAccount('0x' + '02'.repeat(32) as `0x${string}`);
    const { token: otherToken } = new AgentTokens(server.journal.database)
      .register(otherAccount.address, () => {});
    const ambiguous = await join(server, otherToken);
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error).toContain(first.id);
    expect(ambiguous.json().error).toContain('other');
    const conflict = await join(server, token, { runId: 'other', name: 'Agent' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: `Already racing in run ${first.id}` });
    expect((await join(server, token, { runId: 'missing', name: 'Agent' })).statusCode).toBe(404);
  });

  it('keeps record identity, rate state and history across rejoin and a later run', async () => {
    const server = setup();
    const token = await credential(server);
    const store = new AgentTokens(server.journal.database);
    const record = resolveAgentToken(token, store)!;
    const first = (await server.manager.create({ preset: 'fake-duel' })).run;
    await server.manager.start(first.id);
    const joined = await join(server, token, { runId: first.id, name: 'Agent' });
    expect(joined.statusCode).toBe(201);
    const lane = requireLane(resolveAgentToken(token, store)!);
    expect(lane).toBe(record);
    const limit = new AgentRequestLimit(1, 10000);
    limit.take(lane);
    const rejoined = await join(server, token, { runId: first.id, name: 'Renamed' });
    expect(rejoined.statusCode).toBe(200);
    expect(rejoined.json().entrantId).toBe(joined.json().entrantId);
    expect(() => limit.take(requireLane(resolveAgentToken(token, store)!))).toThrow('Request limit reached');
    expect(server.journal.after(first.id, 0).filter((event) => event.source === lane.entrantId && event.type === 'entrant.prompt')).toHaveLength(1);
    await server.manager.stop(first.id);
    expect(resolveAgentToken(token, store)).toBe(record);
    expect(record.runId).toBeUndefined();
    const next = (await server.manager.create({ preset: 'fake-duel' })).run;
    expect((await join(server, token)).statusCode).toBe(201);
    expect(resolveAgentToken(token, store)).toBe(record);
    expect(record.runId).toBe(next.id);
    expect(() => limit.take(requireLane(record))).toThrow('Request limit reached');
    server.journal.database.update(agentTokens).set({ expiresAt: new Date(0).toISOString() }).where(eq(agentTokens.address, account.address)).run();
    expect(resolveAgentToken(token, store)).toBeUndefined();
  });
});
