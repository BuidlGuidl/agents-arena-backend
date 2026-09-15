import { describe, expect, it, vi } from 'vitest';

import { AgentIngest } from '../src/agent-ingest.js';
import { AgentInputError, AgentRateLimitError, AgentRequestLimit } from '../src/agent-limits.js';
import { ExternalStatus } from '../src/adapters/external-status.js';
import { journalHarness } from './fixtures/journal.js';
import { RunManager } from '../src/run-manager.js';
import { noopDriver } from './fixtures/server.js';
import { mayMove, dropCurrentChallenge } from '../src/ctf/challenge-tracker.js';
import { agentLaneState, clearAgentLaneState } from '../src/agent-limits.js';
import { AgentInbox } from '../src/inbox.js';
import { AgentProgress } from '../src/agent-progress.js';

const createJournal = journalHarness();

describe('AgentRequestLimit', () => {
  it('uses lane identity, a fixed window, and whole seconds rounded up', () => {
    let now = 0;
    const limit = new AgentRequestLimit(2, 10000, () => now);
    const identity = { runId: 'run', entrantId: 'entrant' };
    limit.take(identity);
    limit.take(identity);
    now = 1001;
    try {
      limit.take(identity);
      throw new Error('Expected request rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRateLimitError);
      expect((error as AgentRateLimitError).retryAfter).toBe(9);
    }
    expect(() => limit.take({ ...identity })).toThrow(AgentRateLimitError);
    now = 10000;
    expect(() => limit.take(identity)).not.toThrow();
  });
});

describe('AgentIngest module', () => {
  async function setup() {
    const journal = createJournal();
    const manager = new RunManager(journal, noopDriver);
    const { run } = await manager.create({ preset: 'fake-duel' });
    const joined = await manager.join({ runId: run.id, address: '0x1234567890123456789012345678901234567890', name: 'Agent', arenaTokenHash: 'test-arena-token-hash', claim: () => {} });
    const status = new ExternalStatus(journal);
    return { journal, manager, status, identity: { runId: run.id, entrantId: joined.entrantId }, ingest: new AgentIngest(journal, status, () => undefined) };
  }

  it('uses the last explicit status regardless of message order', async () => {
    const { ingest, identity, status, manager } = await setup();
    const set = vi.spyOn(status, 'set');
    const message = { seq: 1, type: 'agent.message', text: 'hello' };
    const done = { seq: 2, type: 'entrant.status', status: 'blocked' };
    const lane = () => manager.snapshot(identity.runId).entrants.find((entrant) => entrant.id === identity.entrantId)!;
    ingest.events(identity, { events: [message, done] });
    expect(set).toHaveBeenCalledTimes(1);
    expect(lane().status).toBe('blocked');
    ingest.events(identity, { events: [{ ...done, seq: 3, status: 'idle' }, { ...message, seq: 4 }] });
    expect(set).toHaveBeenCalledTimes(2);
    expect(lane().status).toBe('idle');
    ingest.events(identity, { events: [
      { ...done, seq: 5, status: 'blocked' }, { ...message, seq: 6 }, { ...done, seq: 7, status: 'working' },
    ] });
    expect(set).toHaveBeenCalledTimes(3);
    expect(lane().status).toBe('working');
  });

  it('does not spend a request for long strings and rejects every event shape strictly', async () => {
    const { ingest, identity, journal } = await setup();
    for (let i = 0; i < 31; i++) {
      expect(() => ingest.events(identity, { events: [{ seq: i, type: 'agent.message', text: 'a'.repeat(16001) }] })).toThrow(AgentInputError);
    }
    for (const event of [
      { type: 'agent.message', text: 'hello' },
      { type: 'entrant.status', status: 'idle' },
    ]) {
      expect(() => ingest.events(identity, { events: [{ seq: 1, ...event, extra: true }] })).toThrow(AgentInputError);
    }
    expect(() => ingest.events(identity, { events: [{ seq: 1, type: 'tool.call', tool: 'Bash', toolCallId: '1', detail: 'ls', extra: true }] })).toThrow(AgentInputError);
    expect(journal.after(identity.runId, 0)).toHaveLength(2);
    expect(ingest.events(identity, { events: [{ seq: 1, type: 'agent.message', text: 'accepted' }] })).toEqual({ accepted: 1, duplicates: 0 });
  });

  it('keeps note sequences out of the client dedupe window and shares the request limit', async () => {
    const { ingest, identity } = await setup();
    ingest.postNote(identity, 'hello', 'idle');
    expect(ingest.events(identity, { events: [{ seq: 1, type: 'agent.message', text: 'hello' }] }))
      .toEqual({ accepted: 1, duplicates: 0 });
    for (let i = 0; i < 28; i++) ingest.postNote(identity, 'another note');
    expect(() => ingest.events(identity, { events: [{ seq: 2, type: 'agent.message', text: 'too fast' }] }))
      .toThrow(AgentRateLimitError);
  });

  it('keeps dedupe, inbox, and challenge limits across new token records and clears lane state', async () => {
    const { ingest, identity, journal, status } = await setup();
    const inbox = new AgentInbox(journal, () => 0);
    const progress = new AgentProgress(journal, status);
    const batch = { events: [{ seq: 42, type: 'agent.message', text: 'hello' }] };
    ingest.events(identity, batch);
    expect(ingest.events({ ...identity }, batch)).toEqual({ accepted: 0, duplicates: 1 });
    inbox.read(identity, {});
    expect(() => inbox.read({ ...identity }, {})).toThrow(AgentRateLimitError);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      progress.announce(identity, { challengeId: 1 });
      expect(() => progress.announce({ ...identity }, { challengeId: 2 })).toThrow(AgentRateLimitError);
      clearAgentLaneState(journal, identity.runId, identity.entrantId);
      expect(ingest.events(identity, batch)).toEqual({ accepted: 1, duplicates: 0 });
      expect(() => inbox.read(identity, {})).not.toThrow();
      expect(progress.announce(identity, { challengeId: 2 }).changed).toBe(true);
    } finally {
      vi.restoreAllMocks();
      dropCurrentChallenge(identity.runId, identity.entrantId);
    }
  });

  it('keeps the tracker and sequence available when a later batch write fails', async () => {
    const { ingest, identity, journal, status } = await setup();
    const batch = { events: [
      { seq: 1, type: 'agent.message', text: 'Starting Challenge 2.' },
      { seq: 2, type: 'entrant.status', status: 'working' },
    ] };
    const set = vi.spyOn(status, 'set').mockImplementationOnce(() => { throw new Error('later write failed'); });
    try {
      expect(() => ingest.events(identity, batch)).toThrow('later write failed');
      expect(mayMove(identity.runId, identity.entrantId, 2, 'message')).toBe(true);
      expect(journal.after(identity.runId, 0).filter((event) => event.type === 'entrant.challenge')).toEqual([]);
      set.mockRestore();
      expect(ingest.events(identity, batch)).toEqual({ accepted: 2, duplicates: 0 });
      expect(mayMove(identity.runId, identity.entrantId, 2, 'message')).toBe(false);
      expect(journal.after(identity.runId, 0).filter((event) => event.type === 'entrant.challenge'))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ challengeId: 2 }) })]);
    } finally {
      set.mockRestore();
      dropCurrentChallenge(identity.runId, identity.entrantId);
    }
  });

  it('prunes only committed lane and run state within its journal', async () => {
    const { manager, journal, identity } = await setup();
    const state = agentLaneState(journal);
    const otherServerState = agentLaneState(createJournal());
    const key = `${identity.runId}:${identity.entrantId}`;
    const otherLane = `${identity.runId}:other`;
    state.set(key, 1);
    state.set(otherLane, 2);
    state.set('other-run:lane', 3);
    otherServerState.set(key, 4);
    await manager.remove(identity.runId, identity.entrantId);
    expect(state.has(key)).toBe(false);
    expect(state.has(otherLane)).toBe(true);
    expect(otherServerState.get(key)).toBe(4);
    expect(() => journal.transaction(() => {
      manager.transition(identity.runId, 'failed');
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(state.has(otherLane)).toBe(true);
    manager.transition(identity.runId, 'failed');
    expect([...state]).toEqual([['other-run:lane', 3]]);
    expect(otherServerState.get(key)).toBe(4);
  });
});
