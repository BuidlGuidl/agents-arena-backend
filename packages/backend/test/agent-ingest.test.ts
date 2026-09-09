import { describe, expect, it, vi } from 'vitest';

import { AgentIngest } from '../src/agent-ingest.js';
import { AgentInputError, AgentRateLimitError, AgentRequestLimit } from '../src/agent-limits.js';
import { ExternalStatus } from '../src/adapters/external-status.js';
import { journalHarness } from './fixtures/journal.js';
import { RunManager } from '../src/run-manager.js';
import { noopDriver } from './fixtures/server.js';

const createJournal = journalHarness();

describe('AgentRequestLimit', () => {
  it('uses token identity, a fixed window, and whole seconds rounded up', () => {
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
    expect(() => limit.take({ ...identity })).not.toThrow();
    now = 10000;
    expect(() => limit.take(identity)).not.toThrow();
  });
});

describe('AgentIngest module', () => {
  async function setup() {
    const journal = createJournal();
    const manager = new RunManager(journal, noopDriver);
    const { run } = await manager.create({ preset: 'fake-duel' });
    const joined = await manager.join({ runId: run.id, address: '0x1234567890123456789012345678901234567890', name: 'Agent', flagsBeforeJoin: 0 });
    const status = new ExternalStatus(journal);
    return { journal, manager, status, identity: { runId: run.id, entrantId: joined.entrantId }, ingest: new AgentIngest(journal, status, () => undefined) };
  }

  it('uses the last explicit status regardless of message order', async () => {
    const { ingest, identity, status, manager } = await setup();
    const set = vi.spyOn(status, 'set');
    const message = { seq: 1, type: 'agent.message', text: 'hello' };
    const done = { seq: 2, type: 'entrant.status', status: 'done' };
    const lane = () => manager.snapshot(identity.runId).entrants.find((entrant) => entrant.id === identity.entrantId)!;
    ingest.events(identity, { events: [message, done] });
    expect(set).toHaveBeenCalledTimes(1);
    expect(lane().status).toBe('done');
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
      { type: 'agent.message', text: 'hello' }, { type: 'agent.reasoning', text: 'think' },
      { type: 'tool.call', tool: 'Bash', toolCallId: '1', detail: 'ls' },
      { type: 'tool.result', tool: 'Bash', toolCallId: '1', detail: '', ok: true },
      { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'entrant.status', status: 'idle' },
    ]) {
      expect(() => ingest.events(identity, { events: [{ seq: 1, ...event, extra: true }] })).toThrow(AgentInputError);
    }
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
});
