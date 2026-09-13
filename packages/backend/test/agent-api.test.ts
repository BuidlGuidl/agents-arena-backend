import { privateKeyToAccount } from 'viem/accounts';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentTokens, issueAgentToken, revokeAgentToken } from '../src/agent-auth.js';
import { activeChainProfile } from '../src/chain/profile.js';
import { buildTaskText } from '../src/ctf/prompt.js';
import { dropCurrentChallenge, takePendingGuess } from '../src/ctf/challenge-tracker.js';
import { SolvePoller } from '../src/chain/solve-poller.js';
import type { PublicClient } from 'viem';
import type { AgentEventInput, AgentInboxResponse, AgentTaskResponse } from '../src/contract.js';
import { entrants, externalEntrants, inboxMessages, scores } from '../src/db/schema.js';
import { toEntrantRecord } from '../src/external-entrants.js';
import { enqueueMessage } from '../src/inbox.js';
import { createServer, type ServerOptions } from '../src/server.js';
import { serverHarness } from './fixtures/server.js';

const operator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const address = '0x1234567890123456789012345678901234567890';
const servers = serverHarness((server) => {
  for (const run of server.manager.list(200)) {
    for (const entrant of server.manager.snapshot(run.id).entrants) {
      dropCurrentChallenge(run.id, entrant.id);
      revokeAgentToken(run.id, entrant.id);
    }
  }
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); });
afterEach(() => { vi.useRealTimers(); });

async function setup(options: Partial<ServerOptions> = {}) {
  const server = createServer({
    dbPath: ':memory:', operatorToken: 'operator', schedule: () => {}, publicUrl: 'https://arena.test',
    siwe: { operatorAddresses: [operator.address], domains: ['arena.test'] },
    challengePack: { addressesFor: () => ({ Challenge3: address }) }, ...options,
  });
  servers.push(server);
  const { run } = await server.manager.create({ preset: 'fake-duel' });
  const joined = await server.manager.join({ runId: run.id, address, name: 'Agent', model: 'gpt-5.5', flagsBeforeJoin: 0 });
  const { token } = new AgentTokens(server.journal.database).register(address, () => {});
  const headers = { authorization: `Bearer ${token}` };
  const post = (events: unknown[]) => server.app.inject({ method: 'POST', url: '/agent/events', headers, payload: { events } });
  const inbox = (after?: string | number) => server.app.inject({ method: 'GET', url: `/agent/inbox${after === undefined ? '' : `?after=${after}`}`, headers });
  const lane = () => server.manager.snapshot(run.id).entrants.find((entrant) => entrant.id === joined.entrantId)!;
  const events = () => server.journal.after(run.id, 0).filter((event) => event.source === joined.entrantId);
  return { ...server, runId: run.id, ...joined, token, headers, post, inbox, lane, events };
}
const message = (seq = 1, text = 'hello'): AgentEventInput => ({ seq, type: 'agent.message', text });

describe('agent task', () => {
  it('requires a token and returns null before running, then shared external and hosted text', async () => {
    const f = await setup();
    expect((await f.app.inject({ method: 'GET', url: '/agent/task' })).statusCode).toBe(401);
    const get = (headers = f.headers) => f.app.inject({ method: 'GET', url: '/agent/task', headers });
    expect((await get()).json()).toEqual({ runId: f.runId, entrantId: f.entrantId, state: 'created', startedAt: null, deadlineAt: null, task: null });
    await f.manager.start(f.runId);
    const rows = f.journal.database.select().from(entrants).leftJoin(externalEntrants,
      and(eq(entrants.runId, externalEntrants.runId), eq(entrants.id, externalEntrants.id)))
      .where(eq(entrants.runId, f.runId)).all();
    for (const row of rows) {
      const entrant = toEntrantRecord(row);
      const headers = entrant.kind === 'external' ? f.headers : { authorization: `Bearer ${issueAgentToken(f.runId, entrant.id)}` };
      const response = (await get(headers)).json() as AgentTaskResponse;
      expect(response).toMatchObject({ state: 'running', startedAt: expect.any(String), entrantId: entrant.id });
      expect(response.task).toBe(buildTaskText(entrant, activeChainProfile, { publicUrl: 'https://arena.test' }));
    }
  });
});

describe('event ingest', () => {
  it('journals messages and explicit status in the entrant source', async () => {
    const f = await setup();
    expect((await f.post([message(), { seq: 2, type: 'entrant.status', status: 'blocked' }])).json())
      .toEqual({ accepted: 2, duplicates: 0 });
    expect(f.events().slice(1).map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      { type: 'agent.message', payload: { entrantId: f.entrantId, text: 'hello' } },
      { type: 'entrant.status', payload: { entrantId: f.entrantId, status: 'blocked' } },
    ]);
    expect(f.lane().status).toBe('blocked');
  });

  it.each([
    { type: 'agent.reasoning', text: 'thinking' },
    { type: 'tool.call', tool: 'Bash', toolCallId: 'call-1', detail: 'ls' },
    { type: 'tool.result', tool: 'Bash', toolCallId: 'call-1', ok: true, detail: 'ok' },
    { type: 'usage', inputTokens: 10, outputTokens: 20 },
  ])('rejects raw activity type $type with 400', async (event) => {
    const f = await setup();
    const before = f.events();
    expect((await f.post([message(), { seq: 2, ...event }])).statusCode).toBe(400);
    expect(f.events()).toEqual(before);
    expect(f.lane().status).toBe('idle');
  });

  it('dedupes retries and repeated seqs within a batch while accepting out-of-order seqs', async () => {
    const f = await setup();
    expect((await f.post([message(9), message(3), message(9)])).json()).toEqual({ accepted: 2, duplicates: 1 });
    const before = f.events();
    expect((await f.post([message(3), message(9)])).json()).toEqual({ accepted: 0, duplicates: 2 });
    expect(f.events()).toEqual(before);
    expect((await f.post([message(2)])).json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  it('retains only the last 1000 accepted seqs', async () => {
    const f = await setup();
    for (let batch = 0; batch < 10; batch++) {
      expect((await f.post(Array.from({ length: 100 }, (_, i) => message(batch * 100 + i)))).statusCode).toBe(200);
    }
    expect((await f.post([message(1000)])).json()).toEqual({ accepted: 1, duplicates: 0 });
    expect((await f.post([message(0), message(999)])).json()).toEqual({ accepted: 1, duplicates: 1 });
  });

  it.each([
    [Array.from({ length: 101 }, (_, i) => message(i)), 413],
    [[message(), message(2, 'a'.repeat(16001))], 400],
    [[message(), { seq: 2, type: 'tool.result', ok: 'yes' }], 400],
    [[{ ...message(), entrantId: 'someone-else' }], 400],
    [[], 400],
  ])('rejects a whole invalid batch', async (batch, code) => {
    const f = await setup();
    const before = f.events();
    expect((await f.post(batch)).statusCode).toBe(code);
    expect(f.events()).toEqual(before);
    expect(f.lane().status).toBe('idle');
  });

  it('rejects unknown body fields and bodies over 256 KiB', async () => {
    const f = await setup();
    expect((await f.app.inject({ method: 'POST', url: '/agent/events', headers: f.headers, payload: { events: [message()], extra: 1 } })).statusCode).toBe(400);
    expect((await f.post(Array.from({ length: 100 }, (_, i) => message(i, 'a'.repeat(3000))))).statusCode).toBe(413);
    expect(f.events()).toHaveLength(1);
  });

  it('checks size and string limits before the request rate, then rejects bad event shapes', async () => {
    const f = await setup();
    for (let i = 0; i < 30; i++) expect((await f.post([message(i)])).statusCode).toBe(200);
    expect((await f.post(Array.from({ length: 101 }, () => message()))).statusCode).toBe(413);
    expect((await f.post([message(40, 'a'.repeat(16001))])).statusCode).toBe(400);
    const response = await f.post([{ invalid: true }]);
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('10');
    await vi.advanceTimersByTimeAsync(10000);
    expect((await f.post([message(40)])).statusCode).toBe(200);
  });

  it('tracks prose, respecting pending guesses behind self-reports', async () => {
    const f = await setup();
    await f.post([message(1, 'Starting challenge 3.')]);
    expect(f.lane().currentChallengeId).toBe(3);
    expect(f.events().filter((event) => event.type === 'entrant.challenge').at(-1)?.payload).toMatchObject({ via: 'message' });
    await f.post([message(2, 'Starting challenge 7.')]);
    expect(f.lane().currentChallengeId).toBe(7);
    expect(f.events().at(-1)?.payload).toMatchObject({ via: 'message' });
    await f.app.inject({ method: 'POST', url: '/agent/progress', headers: f.headers, payload: { challengeId: 5 } });
    await f.post([message(3, 'Starting challenge 8.')]);
    expect(f.lane().currentChallengeId).toBe(5);
    expect(takePendingGuess(f.runId, f.entrantId)).toBeUndefined();
    const client = {
      getBlockNumber: async () => 10n, getCode: async () => undefined,
      readContract: async ({ args }: { args: [string, bigint] }) => args[1] === 5n,
      getLogs: async () => [{ args: { tokenId: 5n }, blockNumber: 1n, transactionHash: `0x${'ab'.repeat(32)}`, logIndex: 0 }],
    } as unknown as PublicClient;
    const poller = new SolvePoller({ profile: activeChainProfile, runId: f.runId, journal: f.journal, client });
    expect(await poller.pollOnce()).toBe(1);
    expect(f.lane().currentChallengeId).toBe(8);
    expect(takePendingGuess(f.runId, f.entrantId)).toBeUndefined();
  });


  it('redacts echoed byoa tokens', async () => {
    const f = await setup();
    await f.post([message(1, f.token)]);
    expect(JSON.stringify(f.events())).not.toContain(f.token);
    expect(f.events().find((event) => event.type === 'agent.message')?.payload).toMatchObject({ text: '[redacted-key]' });
  });

  it.each(['remove', 'stop'] as const)('requires a new join after %s', async (action) => {
    const f = await setup();
    if (action === 'remove') await f.manager.remove(f.runId, f.entrantId);
    if (action === 'stop') { await f.manager.start(f.runId); await f.manager.stop(f.runId); }
    expect((await f.post([message()])).statusCode).toBe(409);
    expect((await f.inbox()).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'GET', url: '/agent/task', headers: f.headers })).statusCode).toBe(409);
  });

  it('keeps dedupe state when the wallet rejoins', async () => {
    const f = await setup();
    await f.post([message()]);
    await f.manager.join({ runId: f.runId, address, name: 'Again', flagsBeforeJoin: 0 });
    expect((await f.post([message()])).json()).toEqual({ accepted: 0, duplicates: 1 });
  });

  it('projects challenge and narration from an external message', async () => {
    const f = await setup();
    await f.post([message(1, 'Challenge 7')]);
    const head = f.events().at(-1)!.id;
    f.journal.append(f.runId, f.entrantId, 'entrant.narration', { entrantId: f.entrantId, text: 'Trying seven.', basedOnEventId: head });
    expect(f.lane()).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null, currentChallengeId: 7, narration: { text: 'Trying seven.', basedOnEventId: head } });
    expect(f.manager.list(1)[0]?.agentCount).toBe(3);
  });
});

describe('external status', () => {
  it('keeps working without reports after a year of fake time', async () => {
    const f = await setup();
    await f.post([message()]);
    expect(f.lane().status).toBe('working');
    const before = f.events();
    await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1000);
    expect(f.lane().status).toBe('working');
    expect(f.events()).toEqual(before);
  });

  it.each(['blocked', 'done'] as const)('preserves %s through messages and progress until an explicit status', async (status) => {
    const f = await setup();
    await f.post([{ seq: 1, type: 'entrant.status', status }]);
    await f.post([message(2)]);
    expect(f.lane().status).toBe(status);
    expect((await f.app.inject({ method: 'POST', url: '/agent/progress', headers: f.headers,
      payload: { challengeId: 5 } })).json()).toEqual({ ok: true, changed: true });
    expect(f.lane().status).toBe(status);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(f.lane().status).toBe(status);
    await f.post([{ seq: 3, type: 'entrant.status', status: 'idle' }]);
    expect(f.lane().status).toBe('idle');
    await f.post([message(4)]);
    expect(f.lane().status).toBe('working');
  });

  it('touches only accepted progress changes and messages', async () => {
    const f = await setup();
    const progress = () => f.app.inject({ method: 'POST', url: '/agent/progress', headers: f.headers, payload: { challengeId: 5 } });
    expect((await progress()).json()).toEqual({ ok: true, changed: true });
    expect(f.lane().status).toBe('working');
    await f.post([message(), { seq: 2, type: 'entrant.status', status: 'idle' }]);
    expect((await progress()).json()).toEqual({ ok: true, changed: false });
    await f.post([message()]);
    expect(f.lane().status).toBe('idle');
    await f.post([message(3)]);
    expect(f.lane().status).toBe('working');
  });

  it.each(['stop', 'remove'] as const)('sets done on %s', async (action) => {
    const f = await setup();
    await f.manager.start(f.runId);
    await f.post([message()]);
    if (action === 'stop') await f.manager.stop(f.runId);
    else await f.manager.remove(f.runId, f.entrantId);
    const events = f.events();
    expect(f.lane().status).toBe('done');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events()).toEqual(events);
    expect(f.lane().status).toBe('done');
  });

  it('rejects an invalid batch without replacing a pending challenge guess', async () => {
    const f = await setup();
    await f.app.inject({ method: 'POST', url: '/agent/progress', headers: f.headers, payload: { challengeId: 5 } });
    await f.post([message(1, 'Starting challenge 7.')]);
    const before = f.events();
    expect((await f.post([message(2, 'Starting challenge 8.'), { seq: 3, type: 'entrant.status', status: 'invalid' }])).statusCode).toBe(400);
    expect(f.events()).toEqual(before);
    expect(f.lane()).toMatchObject({ status: 'working', currentChallengeId: 5 });
    f.journal.database.insert(scores).values({
      runId: f.runId, entrantId: f.entrantId, entrantAddress: address, challengeId: 5,
      tokenId: '5', txHash: '0x01', blockNumber: 1, solvedAt: new Date().toISOString(),
    }).run();
    expect(takePendingGuess(f.runId, f.entrantId)).toMatchObject({ challengeId: 7, via: 'message' });
  });

  it('rejects an invalid batch without changing journal, status, challenge memory, or dedupe', async () => {
    const f = await setup();
    const before = f.events();
    const batch = [message(1, 'Starting challenge 7.'), message(2, 'think')];
    expect((await f.post([batch[0], { ...batch[1], text: 42 }])).statusCode).toBe(400);
    expect(f.events()).toEqual(before);
    expect(f.lane()).toMatchObject({ status: 'idle', currentChallengeId: null });
    await vi.advanceTimersByTimeAsync(200);
    expect(f.events()).toEqual(before);
    const observations: number[] = [];
    const unsubscribe = f.journal.subscribe(f.runId, () => observations.push(f.events().length));
    expect((await f.post(batch)).json()).toEqual({ accepted: 2, duplicates: 0 });
    unsubscribe();
    expect(f.lane().currentChallengeId).toBe(7);
    expect(observations).toEqual(Array(4).fill(f.events().length));
  });
});

describe('agent inbox', () => {
  it('returns an empty page with the supplied cursor', async () => {
    const f = await setup();
    expect((await f.inbox(42)).json()).toEqual({ messages: [], cursor: 42 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox()).json()).toEqual({ messages: [], cursor: 0 });
  });

  it('delivers steer and broadcast once, with repeat reads and cursors', async () => {
    const f = await setup();
    await f.manager.start(f.runId);
    await f.manager.steer(f.runId, f.entrantId, 'Try seven');
    await f.manager.broadcast(f.runId, 'Hurry');
    const rows = f.journal.database.select().from(inboxMessages).all();
    const page = (await f.inbox()).json() as AgentInboxResponse;
    expect(page).toEqual({
      messages: rows.map((row) => ({ cursor: row.id, kind: row.kind, text: row.text, ts: row.createdAt })),
      cursor: rows.at(-1)!.id,
    });
    expect(page.messages.map((row) => row.kind)).toEqual(['steer', 'broadcast']);
    expect(f.journal.database.select().from(inboxMessages).all().every((row) => row.deliveredAt !== null)).toBe(true);
    const delivered = () => f.events().filter((event) => event.type === 'entrant.steered');
    expect(delivered().map((event) => event.payload)).toEqual([{ entrantId: f.entrantId, text: 'Try seven' }, { entrantId: f.entrantId, text: 'Hurry' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox(0)).json()).toEqual(page);
    expect(delivered()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox(page.cursor + 100)).json()).toEqual({ messages: [], cursor: page.cursor + 100 });
  });

  it('pages at 50 and keeps other lanes out', async () => {
    const f = await setup();
    enqueueMessage(f.journal.database, f.runId, 'codex-1', 'private', 'steer');
    for (let i = 0; i < 51; i++) enqueueMessage(f.journal.database, f.runId, f.entrantId, `message ${i}`, 'steer');
    const first = (await f.inbox()).json() as AgentInboxResponse;
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]?.text).toBe('message 0');
    await vi.advanceTimersByTimeAsync(1000);
    const second = (await f.inbox(first.cursor)).json() as AgentInboxResponse;
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.text).toBe('message 50');
  });


  it('checks inbox string limits before rate, then cursor shape', async () => {
    const f = await setup();
    expect((await f.inbox('bad')).statusCode).toBe(400);
    expect((await f.inbox('a'.repeat(16001))).statusCode).toBe(400);
    expect((await f.inbox('bad')).statusCode).toBe(429);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox()).statusCode).toBe(200);
  });

  it('rate limits polls with Retry-After 1', async () => {
    const f = await setup();
    expect((await f.inbox()).statusCode).toBe(200);
    const response = await f.inbox();
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox()).statusCode).toBe(200);
  });

  it.each(['-1', '1.5', 'abc', '', '1e3', '9007199254740992', '1&after=2'])('rejects cursor %s', async (after) => {
    const f = await setup();
    expect((await f.inbox(after)).statusCode).toBe(400);
  });

  it('rolls delivery timestamps and journal rows back together', async () => {
    const f = await setup();
    enqueueMessage(f.journal.database, f.runId, f.entrantId, 'one', 'steer');
    enqueueMessage(f.journal.database, f.runId, f.entrantId, 'two', 'steer');
    const append = f.journal.append.bind(f.journal);
    let calls = 0;
    const spy = vi.spyOn(f.journal, 'append').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('Injected delivery failure');
      return append(...args);
    });
    expect((await f.inbox()).statusCode).toBe(500);
    spy.mockRestore();
    expect(f.events().filter((event) => event.type === 'entrant.steered')).toEqual([]);
    expect(f.journal.database.select().from(inboxMessages).all().every((row) => row.deliveredAt === null)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.inbox()).statusCode).toBe(200);
    expect(f.events().filter((event) => event.type === 'entrant.steered')).toHaveLength(2);
  });
});

it('narrates a late joiner and ends its lane after the closing done line', async () => {
  const narrate = vi.fn<import('../src/narration/openrouter.js').Narrate>(async () => 'Lane update.');
  const f = await setup({ narrate, narrationMinMs: 10, narrationMaxMs: 30 });
  await f.manager.start(f.runId);
  const late = await f.manager.join({ runId: f.runId, address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', name: 'Late', flagsBeforeJoin: 0 });
  const { token } = new AgentTokens(f.journal.database).register('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', () => {});
  const headers = { authorization: `Bearer ${token}` };
  await f.app.inject({ method: 'POST', url: '/agent/events', headers, payload: { events: [message()] } });
  await vi.advanceTimersByTimeAsync(30);
  const lines = () => f.journal.after(f.runId, 0).filter((event) => event.type === 'entrant.narration' && event.source === late.entrantId);
  expect(lines().length).toBeGreaterThan(0);
  expect(narrate).toHaveBeenCalled();
  await f.manager.remove(f.runId, late.entrantId);
  await vi.advanceTimersByTimeAsync(0);
  const closed = lines();
  expect(closed.at(-1)?.payload).toMatchObject({ basedOnEventId: expect.any(Number) });
  expect(narrate.mock.calls.some(([input]) => input.prompt.includes('Status: done'))).toBe(true);
  await vi.advanceTimersByTimeAsync(200);
  expect(lines()).toEqual(closed);
  await f.manager.stop(f.runId);
  await vi.advanceTimersByTimeAsync(45000);
});
