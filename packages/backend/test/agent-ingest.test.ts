import { afterEach, describe, expect, it } from 'vitest';

import { AgentIngest, AgentInputError, AgentRateLimitError, AgentRequestLimit } from '../src/agent-ingest.js';
import { ExternalStatus } from '../src/adapters/external-status.js';
import { EventJournal } from '../src/journal.js';
import { RunManager } from '../src/run-manager.js';
import { noopDriver } from './fixtures/server.js';

const journals: EventJournal[] = [];
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });

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
    const journal = new EventJournal(':memory:');
    journals.push(journal);
    const manager = new RunManager(journal, noopDriver);
    const { run } = await manager.create({ preset: 'fake-duel' });
    const joined = await manager.join({ runId: run.id, address: '0x1234567890123456789012345678901234567890', name: 'Agent', flagsBeforeJoin: 0 });
    const status = new ExternalStatus(journal, { schedule: () => {} });
    return { journal, manager, identity: { runId: run.id, entrantId: joined.entrantId }, ingest: new AgentIngest(journal, status, () => undefined) };
  }

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

  it('keeps hook sequences out of the client window and applies all mapped limits before rate', async () => {
    const { ingest, identity } = await setup();
    for (let i = 0; i < 31; i++) {
      expect(() => ingest.hook(identity, {
        hook_event_name: 'PostToolUse', tool_response: { stdout: 'a'.repeat(9000), stderr: 'b'.repeat(9000) },
      })).toThrow(AgentInputError);
    }
    ingest.hook(identity, { hook_event_name: 'Stop', last_assistant_message: 'hello' });
    expect(ingest.events(identity, { events: [{ seq: 1, type: 'agent.message', text: 'hello' }] })).toEqual({ accepted: 1, duplicates: 0 });
  });
});
