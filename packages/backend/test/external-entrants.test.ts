import { ExternalStatus } from '../src/adapters/external-status.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import type { PublicClient } from 'viem';
import { and, eq, isNotNull } from 'drizzle-orm';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentTokens, resolveAgentToken } from '../src/agent-auth.js';
import { RegisteredEntrantDriver } from '../src/adapters/registered.js';
import { ExternalDriver } from '../src/adapters/external.js';
import { noopDriver, serverHarness } from './fixtures/server.js';
import { activeChainProfile } from '../src/chain/profile.js';
import { recordSolve } from '../src/chain/storage.js';
import { SolvePoller } from '../src/chain/solve-poller.js';
import { dropRunKeys, getWallet } from '../src/chain/wallet.js';
import { dropCurrentChallenge } from '../src/ctf/challenge-tracker.js';
import { type JoinRunRequest, type JoinRunResponse } from '../src/contract.js';
import { agentTokens, entrants, externalEntrants, inboxMessages } from '../src/db/schema.js';
import { createServer, type ArenaServer, type ServerOptions } from '../src/server.js';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const headers = { authorization: 'Bearer operator' };
const servers = serverHarness((target) => {
  for (const run of target.manager.list(200)) {
    for (const entrant of target.manager.snapshot(run.id).entrants) dropCurrentChallenge(run.id, entrant.id);
    dropRunKeys(run.id);
  }
});
const directories: string[] = [];
function server(options: Partial<ServerOptions> = {}): ArenaServer {
  const result = createServer({ dbPath: ':memory:', operatorToken: 'operator', schedule: () => {}, ...options });
  servers.push(result);
  return result;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const tokens = new WeakMap<ArenaServer, string>();
async function signed(target: ArenaServer, runId: string, overrides: Partial<JoinRunRequest> = {}): Promise<JoinRunRequest> {
  if (!tokens.has(target)) {
    const nonce = (await target.app.inject({ url: '/auth/nonce' })).json().nonce as string;
    const signature = await account.signMessage({ message: `Register ${account.address} as an Agents Arena agent with nonce ${nonce}` });
    const response = await target.app.inject({ method: 'POST', url: '/agent/register', payload: { address: account.address, nonce, signature } });
    expect(response.statusCode).toBe(201);
    tokens.set(target, response.json().token as string);
  }
  return { runId, name: 'My agent', ...overrides };
}

async function join(target: ArenaServer, payload: object): Promise<LightMyRequestResponse> {
  return target.app.inject({ method: 'POST', url: '/agent/join', headers: { authorization: `Bearer ${tokens.get(target)}` }, payload });
}
function progress(target: ArenaServer, token: string, challengeId = 1) {
  return target.app.inject({ method: 'POST', url: '/agent/progress', headers: { authorization: `Bearer ${token}` }, payload: { challengeId } });
}
function remove(target: ArenaServer, runId: string, entrantId: string) {
  return target.app.inject({ method: 'POST', url: `/runs/${runId}/entrants/${entrantId}/remove`, headers });
}

async function setup(options: Partial<ServerOptions> = {}) {
  const target = server(options);
  const { run } = await target.manager.create({ preset: 'fake-duel' });
  return { target, runId: run.id };
}

describe('external entrant join', () => {
  it('resolves a persisted token in a new server', async () => {
    const directory = await mkdtemp(joinPath(tmpdir(), 'arena-external-'));
    directories.push(directory);
    const dbPath = joinPath(directory, 'arena.db');
    const first = server({ dbPath });
    const { run } = await first.manager.create({ preset: 'fake-duel' });
    const response = await join(first, await signed(first, run.id));
    const body = response.json<JoinRunResponse>();
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);
    const second = server({ dbPath });
    expect((await progress(second, tokens.get(first)!, 1)).statusCode).toBe(200);

  });

  it('keeps per-token progress rate state', async () => {
    const { target, runId } = await setup();
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    expect((await progress(target, tokens.get(target)!, 1)).statusCode).toBe(200);
    expect((await progress(target, tokens.get(target)!, 2)).statusCode).toBe(429);
  });

  it('keeps the wallet registered after removal', async () => {
    const { target, runId } = await setup();
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    await remove(target, runId, body.entrantId);
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(409);
  });

  it('removes through the injected driver stop seam', async () => {
    const stop = vi.fn<ExternalDriver['stop']>();
    const { target, runId } = await setup({ driverFactory: (journal) => {
      const driver = new ExternalDriver(journal, new ExternalStatus(journal));
      stop.mockImplementation((run, entrant) => driver.stop(run, entrant));
      return { ...noopDriver, stop };
    } });
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    expect((await remove(target, runId, body.entrantId)).statusCode).toBe(202);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ id: runId }), expect.objectContaining({ id: body.entrantId }));
    expect(target.manager.snapshot(runId).entrants.find((entrant) => entrant.id === body.entrantId))
      .toMatchObject({ status: 'done', removedAt: expect.any(String) });
  });

  it('registers a lane, journals its declared fields, and stores only a token hash', async () => {
    const flagsHeld = vi.fn(async () => 4);
    const { target, runId } = await setup({ flagsHeld });
    const payload = await signed(target, runId, { harness: 'my-cli', model: 'my-model', effort: 'whatever', url: 'https://agent.test' });
    const response = await join(target, payload);
    expect(response.statusCode).toBe(201);
    const body = response.json<JoinRunResponse>();
    expect(body.entrantId).toBe(`ext-${account.address.slice(2, 14).toLowerCase()}`);
    expect(tokens.get(target)!).toMatch(/^byoa_[0-9a-f]{48}$/);
    const lane = body.run.entrants.find((entrant) => entrant.id === body.entrantId);
    expect(lane).toMatchObject({ kind: 'external', name: payload.name, address: account.address, status: 'idle',
      harness: payload.harness, model: payload.model, effort: payload.effort, url: payload.url,
      joinedAt: expect.any(String), task: { ctfFlagsBeforeJoin: 4 } });
    expect(lane).not.toHaveProperty('removedAt');
    expect(body.run.entrants.filter((entrant) => entrant.kind === 'hosted')).toHaveLength(2);
    expect(flagsHeld).toHaveBeenCalledWith(account.address);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'entrant.joined').map((event) => event.payload)).toEqual([{
      entrantId: body.entrantId, kind: 'external', name: payload.name, address: account.address,
      harness: payload.harness, model: payload.model, effort: payload.effort, url: payload.url,
    }]);
    const rows = target.journal.database.select().from(agentTokens).all();
    expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(tokens.get(target)!).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(tokens.get(target)!);
    expect(resolveAgentToken(tokens.get(target)!, new AgentTokens(target.journal.database)))
      .toMatchObject({ address: account.address, runId, entrantId: body.entrantId });
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(200);
    expect(target.manager.list(10)[0]?.agentCount).toBe(3);
    const history = await target.app.inject({ url: `/runs/${runId}/events/history?types=entrant.joined,entrant.removed` });
    expect(history.statusCode).toBe(200);
    expect(history.json().events).toHaveLength(1);
  });

  it('replaces declared fields while retaining the first join time and flag baseline', async () => {
    const flagsHeld = vi.fn(async () => 2);
    const { target, runId } = await setup({ flagsHeld });
    const first = (await join(target, await signed(target, runId, { harness: 'first' }))).json<JoinRunResponse>();
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(200);
    recordSolve(target.journal.database, target.journal, {
      runId, entrantId: first.entrantId, entrantAddress: account.address, challengeId: 3,
      tokenId: '3', txHash: `0x${'ab'.repeat(32)}`, blockNumber: 1,
    });
    flagsHeld.mockResolvedValue(3);
    const response = await join(target, await signed(target, runId, { name: 'Renamed', model: 'new' }));
    expect(response.statusCode).toBe(200);
    const second = response.json<JoinRunResponse>();
    expect(second.entrantId).toBe(first.entrantId);
    const lane = second.run.entrants.find((entrant) => entrant.id === second.entrantId);
    expect(lane).toMatchObject({ name: 'Renamed', model: 'new', flags: 1, task: { ctfFlagsBeforeJoin: 2 } });
    expect(lane).not.toHaveProperty('harness');
    const original = first.run.entrants.find((entrant) => entrant.id === first.entrantId);
    if (original?.kind !== 'external' || lane?.kind !== 'external') throw new Error('Missing external lane');
    expect(lane.joinedAt).toBe(original.joinedAt);
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(200);
    expect((await progress(target, tokens.get(target)!, 2)).statusCode).toBe(429);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'entrant.joined')).toHaveLength(2);
  });

  it.each([
    { name: '' }, { name: undefined }, { name: 'a'.repeat(41) },
    { harness: 'a'.repeat(81) }, { model: 'a'.repeat(81) }, { effort: 'a'.repeat(81) },
    { url: `https://a.test/${'a'.repeat(200)}` }, { url: 'ftp://a.test' }, { url: 'bad' },
    { signature: '0x1234' }, { signature: `0x${'gg'.repeat(65)}` },
    { address: '0x1234' }, { runId: '' }, { nonce: 12 }, { extra: true },
  ])('rejects malformed join fields: %j', async (invalid) => {
    const { target, runId } = await setup();
    const body = await signed(target, runId);
    expect((await join(target, { ...body, ...invalid })).statusCode).toBe(400);
    expect(target.manager.snapshot(runId).entrants).toHaveLength(2);
  });

  it('returns 404 for an unknown run and 409 for every stopped state', async () => {
    const { target, runId } = await setup();
    expect((await join(target, await signed(target, 'missing'))).statusCode).toBe(404);
    await target.manager.start(runId);
    target.manager.transition(runId, 'stopping');
    expect((await join(target, await signed(target, runId))).statusCode).toBe(409);
    target.manager.transition(runId, 'finished');
    expect((await join(target, await signed(target, runId))).statusCode).toBe(409);
    const next = await target.manager.create({ preset: 'fake-duel' });
    target.manager.transition(next.run.id, 'failed');
    expect((await join(target, await signed(target, next.run.id))).statusCode).toBe(409);
  });

  it('records zero if the chain read fails', async () => {
    const { target, runId } = await setup({ flagsHeld: async () => { throw new Error('unavailable'); } });
    const warning = vi.spyOn(target.app.log, 'warn');
    const response = await join(target, await signed(target, runId));
    expect(response.statusCode).toBe(201);
    expect(response.json<JoinRunResponse>().run.entrants.find((entrant) => entrant.kind === 'external'))
      .toMatchObject({ task: { ctfFlagsBeforeJoin: 0 } });
    expect(warning).toHaveBeenCalledOnce();
  });

  it('refuses a join if the run stops during its chain read', async () => {
    let resolve!: (count: number) => void;
    const read = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const { target, runId } = await setup({ flagsHeld: read });
    await target.manager.start(runId);
    const pending = join(target, await signed(target, runId));
    const response = pending.then((value) => value);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await target.manager.stop(runId);
    resolve(0);
    expect((await response).statusCode).toBe(409);
    expect(target.manager.snapshot(runId).entrants).toHaveLength(2);
  });

  it('does not replace a hosted id or an external address with the same prefix', async () => {
    const { target, runId } = await setup();
    const entrantId = `ext-${account.address.slice(2, 14).toLowerCase()}`;
    target.journal.database.update(entrants).set({ id: entrantId }).where(and(eq(entrants.runId, runId), eq(entrants.id, 'codex-1'))).run();
    expect((await join(target, await signed(target, runId))).statusCode).toBe(409);
    target.journal.database.update(entrants).set({ id: 'codex-1' }).where(eq(entrants.id, entrantId)).run();
    await join(target, await signed(target, runId));
    await expect(target.manager.join({ runId, address: `${account.address.slice(0, 14)}${'0'.repeat(28)}`, name: 'collision', flagsBeforeJoin: 0 }))
      .rejects.toThrow('Entrant id is already in use');
  });
});

describe('external lane lifecycle', () => {
  it('drops an in-flight solve after removal and makes no further chain calls for that wallet', async () => {
    const { target, runId } = await setup();
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const getLogs = vi.fn(async () => {
      await barrier;
      return [{ args: { tokenId: 1n }, blockNumber: 1n, transactionHash: `0x${'ab'.repeat(32)}`, logIndex: 0 }];
    });
    const readContract = vi.fn(async ({ args }: { args: [string, bigint] }) => args[1] === 1n);
    const client = {
      getBlockNumber: async () => 10n, getCode: async () => undefined, readContract, getLogs,
    } as unknown as PublicClient;
    const poller = new SolvePoller({ profile: activeChainProfile, runId, journal: target.journal, client });
    const polling = poller.pollOnce();
    await vi.waitFor(() => expect(getLogs).toHaveBeenCalledOnce());
    expect((await remove(target, runId, body.entrantId)).statusCode).toBe(202);
    finish();
    expect(await polling).toBe(0);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'score.flag')).toEqual([]);
    readContract.mockClear();
    expect(await poller.pollOnce()).toBe(0);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([false, true])('journals the external task before or after start (late=%s)', async (late) => {
    const resolve = vi.fn((id: string) => `/tmp/arena-challenge-pack/${id}`);
    const { target, runId } = await setup({
      publicUrl: 'https://arena.test', siteUrl: 'https://site.test',
      challengePack: { resolve, addressesFor: () => undefined },
    });
    if (late) await target.manager.start(runId);
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    if (!late) await target.manager.start(runId);
    const prompts = target.journal.after(runId, 0).filter((event) => event.type === 'entrant.prompt' && event.source === body.entrantId);
    expect(prompts).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(prompts[0]?.payload).toMatchObject({ text: expect.stringContaining('The challenge briefing is at https://site.test/llms.txt.') });
    expect(prompts[0]?.payload).toMatchObject({ text: expect.stringContaining(
      'Report as you go through the arena tools: call set_current_challenge before you start each challenge, post_note after every attempt and at least every few minutes while you work, and read_inbox between steps. ' +
      'If you do not have the tools, use the agent API at https://arena.test, documented at https://site.test/arena/join.',
    ) });
    expect(JSON.stringify(prompts)).not.toContain('WALLET_PRIVATE_KEY');
    expect(JSON.stringify(prompts)).toContain(account.address);
    expect(target.manager.snapshot(runId).entrants.find((entrant) => entrant.id === body.entrantId)?.status).toBe('idle');
    await target.manager.stop(runId);
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(409);
    expect(target.manager.snapshot(runId).entrants.find((entrant) => entrant.id === body.entrantId)?.status).toBe('done');
    expect(target.journal.database.select().from(agentTokens).all()).toHaveLength(1);
  });

  it('queues steer and broadcast with their kinds and refuses restart', async () => {
    const { target, runId } = await setup();
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    await target.manager.start(runId);
    const steer = await target.app.inject({ method: 'POST', url: `/runs/${runId}/entrants/${body.entrantId}/steer`, headers, payload: { text: 'Try 2' } });
    expect(steer.statusCode).toBe(202);
    expect(steer.json()).toEqual({ accepted: true, status: 'queued' });
    const broadcast = await target.app.inject({ method: 'POST', url: `/runs/${runId}/broadcast`, headers, payload: { text: 'Hurry' } });
    expect(broadcast.statusCode).toBe(202);
    expect(broadcast.json().queued).toContain(body.entrantId);
    const rows = target.journal.database.select().from(inboxMessages).all();
    expect(rows.map(({ kind, text, deliveredAt }) => ({ kind, text, deliveredAt }))).toEqual([
      { kind: 'steer', text: 'Try 2', deliveredAt: null }, { kind: 'broadcast', text: 'Hurry', deliveredAt: null },
    ]);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'entrant.steered' && event.source === body.entrantId)).toEqual([]);
    expect(target.journal.after(runId, 0).find((event) => event.type === 'director.broadcast')?.payload)
      .toMatchObject({ targetEntrantIds: expect.arrayContaining([body.entrantId]) });
    expect((await target.app.inject({ method: 'POST', url: `/runs/${runId}/entrants/${body.entrantId}/restart`, headers })).statusCode).toBe(400);
    await target.manager.stop(runId);
  });

  it('removes a lane, preserves display and its wallet token, and bars rejoin', async () => {
    const { target, runId } = await setup();
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    expect((await remove(target, runId, body.entrantId)).statusCode).toBe(202);
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(409);
    expect(target.manager.snapshot(runId).entrants.find((entrant) => entrant.id === body.entrantId))
      .toMatchObject({ address: account.address, status: 'done', removedAt: expect.any(String) });
    expect(target.journal.database.select().from(entrants).where(and(eq(entrants.runId, runId), isNotNull(entrants.address))).all()).toEqual([]);
    const events = target.journal.after(runId, 0).filter((event) => event.source === body.entrantId);
    expect(events.map((event) => event.type)).toEqual(['entrant.joined', 'entrant.status', 'entrant.removed']);
    expect(events[1]?.payload).toEqual({ entrantId: body.entrantId, status: 'done' });
    expect(events[2]?.payload).toEqual({ entrantId: body.entrantId });
    expect((await remove(target, runId, body.entrantId)).statusCode).toBe(409);
    expect((await remove(target, runId, 'codex-1')).statusCode).toBe(400);
    expect((await remove(target, runId, 'unknown')).statusCode).toBe(404);
    expect((await remove(target, 'unknown', body.entrantId)).statusCode).toBe(404);
    expect((await target.app.inject({ method: 'POST', url: `/runs/${runId}/entrants/${body.entrantId}/remove` })).statusCode).toBe(401);
    expect((await join(target, await signed(target, runId))).statusCode).toBe(403);
    expect((await target.app.inject({ method: 'POST', url: `/runs/${runId}/entrants/${body.entrantId}/steer`, headers, payload: { text: 'hello' } })).statusCode).toBe(409);
    await target.manager.start(runId);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'entrant.prompt' && event.source === body.entrantId)).toEqual([]);
    await target.manager.stop(runId);
    expect(target.journal.after(runId, 0).filter((event) => event.type === 'entrant.status' && event.source === body.entrantId)).toHaveLength(1);
  });

  it('includes a join during preparation at the running transition without preparing or funding its wallet', async () => {
    let ready!: () => void;
    const barrier = new Promise<void>((resolve) => { ready = resolve; });
    const prepare = vi.fn(async () => barrier);
    const start = vi.fn(async () => {});
    const funding = vi.fn(async () => {});
    const watch = vi.fn(() => {});
    const target = server({ driverFactory: (journal, status) => new RegisteredEntrantDriver(journal, { status, schedule: () => {}, hosted: { ...noopDriver, prepare, start } }), fundingGateFactory: () => funding, solveWatchFactory: () => watch, flagsHeld: async () => 0 });
    const { run } = await target.manager.create({ preset: 'docker-duel', roster: [{ id: 'host', harness: 'codex', model: 'gpt-5.5', effort: 'high' }] });
    const starting = target.manager.start(run.id);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const body = (await join(target, await signed(target, run.id))).json<JoinRunResponse>();
    expect(getWallet(run.id, body.entrantId)).toBeNull();
    ready();
    expect((await starting).state).toBe('ready');
    await target.manager.start(run.id);
    expect(prepare).toHaveBeenCalledOnce();
    expect(funding).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ id: 'host', kind: 'hosted' })], expect.anything());
    expect(start).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([expect.objectContaining({ id: body.entrantId })]), expect.anything());
    expect(target.journal.after(run.id, 0).filter((event) => event.type === 'entrant.prompt' && event.source === body.entrantId)).toHaveLength(1);
    expect(target.journal.after(run.id, 0).filter((event) => event.type === 'wallet.assigned').map((event) => event.source)).toEqual(['host']);
    await target.manager.stop(run.id);
  });

  it('clears the live lane if preparation fails', async () => {
    let fail!: (error: Error) => void;
    const prepare = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const { target, runId } = await setup({ driverFactory: (journal, status) => new RegisteredEntrantDriver(journal, { status, schedule: () => {}, hosted: { ...noopDriver, prepare } }) });
    // One hosted lane makes the preparation failure deterministic.
    target.journal.database.delete(entrants).where(eq(entrants.id, 'opencode-1')).run();
    const starting = target.manager.start(runId).catch(() => undefined);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const body = (await join(target, await signed(target, runId))).json<JoinRunResponse>();
    fail(new Error('prepare failed'));
    await starting;
    expect((await progress(target, tokens.get(target)!)).statusCode).toBe(409);
    expect(target.journal.database.select().from(agentTokens).all()).toHaveLength(1);
  });

  it('reserves ext- roster ids', async () => {
    const target = server();
    const response = await target.app.inject({ method: 'POST', url: '/runs', headers, payload: { preset: 'fake-duel', roster: [{ id: 'ext-taken', harness: 'codex', model: 'gpt-5.5', effort: 'high' }] } });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('ext-');
  });
});
