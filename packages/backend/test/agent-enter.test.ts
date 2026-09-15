import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ArenaTokens, arenaTokenHash, resolveAgentToken } from '../src/agent-auth.js';
import { ENTER_MESSAGE_TEMPLATE, TERMINAL_RUN_STATES } from '../src/contract.js';
import { externalEntrants, runs } from '../src/db/schema.js';
import { createServer } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';
import { enter, racer, signedEntry } from './enter-helper.js';

const servers = serverHarness();
async function setup() {
  const server = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {} });
  servers.push(server);
  const { run } = await server.manager.create({ preset: 'fake-duel' });
  return { ...server, runId: run.id };
}

describe('signed entry', () => {
  it('creates a lane and rotates its hashed arena token with a fresh signature', async () => {
    const f = await setup();
    expect(ENTER_MESSAGE_TEMPLATE).toBe('Enter Agents Arena as {address} with nonce {nonce}');
    const first = await enter(f);
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json();
    expect(Object.keys(body).sort()).toEqual(['entrantId', 'run', 'token']);
    expect(body.token).toMatch(/^byoa_[0-9a-f]{48}$/);
    const store = new ArenaTokens(f.journal.database);
    const record = resolveAgentToken(body.token, store);
    expect(record).toEqual({ runId: f.runId, entrantId: body.entrantId, address: racer.address });
    expect(resolveAgentToken(body.token, store)).toBe(record);
    const second = await enter(f, { address: racer.address.toLowerCase() });
    expect(second.statusCode).toBe(200);
    expect(second.headers['cache-control']).toBe('no-store');
    expect(second.json().entrantId).toBe(body.entrantId);
    expect(second.json().token).not.toBe(body.token);
    expect(store.resolve(body.token)).toBeUndefined();
    expect(store.resolve(second.json().token)).toEqual(record);
    expect(store.resolve(second.json().token)).not.toBe(record);
    const rows = f.journal.database.select().from(externalEntrants).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arenaTokenHash).toBe(arenaTokenHash(second.json().token));
    expect(JSON.stringify(rows)).not.toContain(second.json().token);
    expect((await f.app.inject({ url: '/agent/task', headers: { authorization: `Bearer ${body.token}` } })).statusCode).toBe(401);
  });

  it.each([{ address: 'bad' }, { nonce: 12 }, { signature: '0x1234' }, { extra: true }])('rejects malformed entry: %j', async (invalid) => {
    const f = await setup();
    const response = await f.app.inject({ method: 'POST', url: '/agent/enter', payload: { ...await signedEntry(f), ...invalid } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty('error');
  });

  it('rejects unknown and used nonces and the wrong signer', async () => {
    const f = await setup();
    for (const fields of [{ nonce: 'unknown' }, { address: '0x1234567890123456789012345678901234567890' }]) {
      const response = await enter(f, fields);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toHaveProperty('error');
    }
    const payload = await signedEntry(f);
    const send = () => f.app.inject({ method: 'POST', url: '/agent/enter', payload });
    expect((await send()).statusCode).toBe(201);
    const replay = await send();
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: 'Unknown or already used nonce' });
  });

  it('rejects expired nonces', async () => {
    let now = Date.now();
    const f = createServer({ dbPath: ':memory:', operatorToken: 'operator', siwe: { operatorAddresses: [], now: () => now } });
    servers.push(f);
    const payload = await signedEntry(f);
    now += 600001;
    const response = await f.app.inject({ method: 'POST', url: '/agent/enter', payload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unknown or already used nonce' });
  });

  it('preserves the nonce after a failed write', async () => {
    const f = await setup();
    const payload = await signedEntry(f);
    const send = () => f.app.inject({ method: 'POST', url: '/agent/enter', payload });
    f.journal.database.run(sql`CREATE TRIGGER fail_entry BEFORE INSERT ON external_entrants BEGIN SELECT RAISE(FAIL, 'entry failed'); END`);
    expect((await send()).statusCode).toBe(500);
    expect(f.journal.database.select().from(externalEntrants).all()).toEqual([]);
    f.journal.database.run(sql`DROP TRIGGER fail_entry`);
    expect((await send()).statusCode).toBe(201);
  });

  it('allows exactly one of two identical concurrent entry requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let both!: () => void;
    const waiting = new Promise<void>((resolve) => { both = resolve; });
    const f = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {},
      flagsHeld: async () => { if (++reads === 2) both(); await gate; return 0; } });
    servers.push(f);
    await f.manager.create({ preset: 'fake-duel' });
    const payload = await signedEntry(f);
    const send = () => f.app.inject({ method: 'POST', url: '/agent/enter', payload });
    const pending = Promise.all([send(), send()]);
    await waiting;
    release();
    const responses = await pending;
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 401]);
    const winner = responses.find((response) => response.statusCode === 201)!;
    const loser = responses.find((response) => response.statusCode === 401)!;
    expect(loser.json()).toEqual({ error: 'Unknown or already used nonce' });
    const store = new ArenaTokens(f.journal.database);
    expect(store.resolve(winner.json().token)).toEqual({ runId: winner.json().run.id, entrantId: winner.json().entrantId, address: racer.address });
    expect(f.journal.database.select().from(externalEntrants).all()).toHaveLength(1);
  });

  it.each([
    { flagsHeld: async () => 2, message: 'This wallet already holds flags from before this run. Enter with a wallet that holds none.' },
    { flagsHeld: async (): Promise<number> => { throw new Error('unavailable'); }, message: "Could not read this wallet's flags. Try again in a moment." },
  ])('rejects first entry without a lane: $message', async ({ flagsHeld, message }) => {
    const f = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {}, flagsHeld });
    servers.push(f);
    const { run } = await f.manager.create({ preset: 'fake-duel' });
    const response = await enter(f);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: message });
    expect(f.manager.hasLane(run.id, racer.address)).toBe(false);
    expect(f.journal.database.select().from(externalEntrants).all()).toEqual([]);
  });

  it('reenters without reading flags even when the wallet now holds flags', async () => {
    let reads = 0;
    const f = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {},
      flagsHeld: async () => { reads++; return reads === 1 ? 0 : 4; } });
    servers.push(f);
    await f.manager.create({ preset: 'fake-duel' });
    const first = await enter(f);
    expect(first.statusCode).toBe(201);
    expect(reads).toBe(1);
    const second = await enter(f);
    expect(second.statusCode).toBe(200);
    expect(reads).toBe(1);
    expect(second.json().entrantId).toBe(first.json().entrantId);
  });

  it('kills the arena token on removal and bars another entry', async () => {
    const f = await setup();
    const body = (await enter(f)).json();
    await f.manager.remove(f.runId, body.entrantId);
    expect(new ArenaTokens(f.journal.database).resolve(body.token)).toBeUndefined();
    const response = await enter(f);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'This wallet was removed from the run' });
  });

  it.each(TERMINAL_RUN_STATES)('kills the arena token when the run is %s', async (state) => {
    const f = await setup();
    const body = (await enter(f)).json();
    const store = new ArenaTokens(f.journal.database);
    expect(store.resolve(body.token)).toBeDefined();
    f.journal.database.update(runs).set({ state }).where(eq(runs.id, f.runId)).run();
    expect(store.resolve(body.token)).toBeUndefined();
    const response = await f.app.inject({ url: '/agent/task', headers: { authorization: `Bearer ${body.token}` } });
    expect(response.statusCode).toBe(401);
  });
});
