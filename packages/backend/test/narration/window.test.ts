import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntrantDriver, EntrantRecord, RunRecord } from '../../src/adapters/types.js';
import { recordSolve } from '../../src/chain/storage.js';
import { entrants, runs } from '../../src/db/schema.js';
import { EventJournal } from '../../src/journal.js';
import { firstSentences } from '../../src/narration/openrouter.js';
import { buildNarrationWindow } from '../../src/narration/window.js';
import { RunManager } from '../../src/run-manager.js';

const journals: EventJournal[] = [];
const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() { return 'injected'; },
  async restart() {},
  async stop() {},
};

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
});

async function setup(): Promise<{
  journal: EventJournal;
  run: RunRecord;
  entrant: EntrantRecord;
}> {
  const journal = new EventJournal(':memory:');
  journals.push(journal);
  const manager = new RunManager(journal, noopDriver);
  const created = await manager.create({ preset: 'fake-duel' });
  await manager.start(created.run.id);
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  const entrant = journal.database.select().from(entrants).where(and(
    eq(entrants.runId, created.run.id),
    eq(entrants.id, 'codex-1'),
  )).get();
  if (run === undefined || entrant === undefined) throw new Error('Missing narration fixture rows');
  return { journal, run, entrant };
}

describe('buildNarrationWindow', () => {
  it('caps events, trims verbose detail, keeps five prior lines, and derives lane state', async () => {
    const { journal, run, entrant } = await setup();
    journal.database.update(entrants).set({ status: 'working' }).where(and(
      eq(entrants.runId, run.id), eq(entrants.id, entrant.id),
    )).run();
    journal.append(run.id, entrant.id, 'entrant.status', {
      entrantId: entrant.id, status: 'working',
    });
    for (let index = 0; index < 6; index += 1) {
      journal.append(run.id, entrant.id, 'entrant.narration', {
        entrantId: entrant.id, text: `previous-${index}`, basedOnEventId: 0,
      });
    }
    journal.append(run.id, entrant.id, 'entrant.challenge', {
      entrantId: entrant.id, challengeId: 3, via: 'command', evidence: 'Challenge3',
    });
    recordSolve(journal.database, journal, {
      runId: run.id,
      entrantId: entrant.id,
      entrantAddress: '0xA1',
      challengeId: 1,
      tokenId: '1',
      txHash: '0xabc',
      blockNumber: 1,
    });
    for (let index = 0; index < 42; index += 1) {
      journal.append(run.id, entrant.id, 'agent.message', {
        entrantId: entrant.id, text: `message-${index}`,
      });
    }
    journal.append(run.id, entrant.id, 'tool.result', {
      entrantId: entrant.id,
      tool: 'forge',
      toolCallId: 'complete',
      ok: false,
      detail: 'x'.repeat(500),
    });
    const open = journal.append(run.id, entrant.id, 'tool.call', {
      entrantId: entrant.id,
      tool: 'cast',
      toolCallId: 'open',
      detail: 'cast call Challenge3',
    });

    const built = buildNarrationWindow({
      journal,
      run,
      entrant,
      challengeTitles: { 3: 'Fixture Challenge 3' },
      basedOnEventId: 0,
      nowMs: Date.parse(open.ts) + 5_000,
    });

    expect(built.basedOnEventId).toBe(open.id);
    expect(built.eventCount).toBeGreaterThan(40);
    expect(built.status).toBe('working');
    expect(built.input.system).toContain('#3: Fixture Challenge 3');
    expect(built.input.prompt).not.toContain('message-0');
    expect(built.input.prompt).toContain('message-41');
    expect(built.input.prompt).not.toContain('previous-0');
    expect(built.input.prompt).toContain('previous-1');
    expect(built.input.prompt).toContain('previous-5');
    expect(built.input.prompt).toContain('Current challenge: #3 via command');
    expect(built.input.prompt).toContain('Solved flags (1): #1');
    expect(built.input.prompt).toContain('Open tool call: cast (cast call Challenge3), age 5s');
    const resultLine = built.input.prompt.split('\n').find((line) => line.includes('forge → fail'));
    expect(resultLine?.length).toBeLessThan(340);
  });

  it('resumes after a cursor and states when no event changed', async () => {
    const { journal, run, entrant } = await setup();
    const cursor = journal.append(run.id, entrant.id, 'agent.message', {
      entrantId: entrant.id, text: 'already narrated',
    });
    const previous = journal.append(run.id, entrant.id, 'entrant.narration', {
      entrantId: entrant.id, text: 'Previous account.', basedOnEventId: cursor.id,
    });

    const built = buildNarrationWindow({
      journal,
      run,
      entrant,
      challengeTitles: {},
      basedOnEventId: cursor.id,
    });

    expect(built.eventCount).toBe(0);
    // The cursor advances to the head it read, own narration row included, so the
    // next read starts past it instead of re-parsing it.
    expect(built.basedOnEventId).toBe(previous.id);
    expect(built.input.prompt).toContain('no new events since your last line');
    expect(built.input.prompt).not.toContain('already narrated');
  });

  it('advances the cursor to the journal head after reading other lanes', async () => {
    const { journal, run, entrant } = await setup();
    const cursor = journal.append(run.id, entrant.id, 'agent.message', {
      entrantId: entrant.id,
      text: 'already narrated',
    });
    for (let index = 0; index < 2_000; index += 1) {
      journal.append(run.id, 'opencode-1', 'agent.message', {
        entrantId: 'opencode-1',
        text: `other-lane-${index}`,
      });
    }
    journal.append(run.id, entrant.id, 'agent.message', {
      entrantId: entrant.id,
      text: 'fresh work',
    });
    const head = journal.append(run.id, 'opencode-1', 'agent.message', {
      entrantId: 'opencode-1',
      text: 'other-lane-tail',
    });
    const after = vi.spyOn(journal, 'after');

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: cursor.id,
    });

    expect(built.eventCount).toBe(1);
    expect(built.basedOnEventId).toBe(head.id);
    after.mockClear();

    const next = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: built.basedOnEventId,
    });

    expect(after).toHaveBeenCalledWith(run.id, head.id);
    expect(next.eventCount).toBe(0);
  });

  it('clears a dangling tool call when the turn becomes idle', async () => {
    const { journal, run, entrant } = await setup();
    journal.append(run.id, entrant.id, 'tool.call', {
      entrantId: entrant.id,
      tool: 'shell',
      toolCallId: 'dangling',
      detail: 'long command',
    });
    journal.append(run.id, entrant.id, 'entrant.status', {
      entrantId: entrant.id,
      status: 'idle',
    });

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: 0,
    });

    expect(built.openTools).toEqual([]);
    expect(built.input.prompt).toContain('Open tool call: none');
  });

  it('clears a dangling tool call when the entrant restarts', async () => {
    const { journal, run, entrant } = await setup();
    journal.append(run.id, entrant.id, 'tool.call', {
      entrantId: entrant.id,
      tool: 'shell',
      toolCallId: 'dangling',
      detail: 'long command',
    });
    journal.append(run.id, entrant.id, 'entrant.restarted', {
      entrantId: entrant.id,
    });

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: 0,
    });

    expect(built.openTools).toEqual([]);
  });

  it('keeps the 20 most recent open tools with trimmed detail', async () => {
    const { journal, run, entrant } = await setup();
    for (let index = 0; index < 25; index += 1) {
      journal.append(run.id, entrant.id, 'tool.call', {
        entrantId: entrant.id,
        tool: 'shell',
        toolCallId: `call-${index}`,
        detail: `${index}-${'x'.repeat(500)}`,
      });
    }

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: 0,
    });

    expect(built.openTools).toHaveLength(20);
    expect(built.openTools[0]?.toolCallId).toBe('call-5');
    expect(built.openTools.at(-1)?.toolCallId).toBe('call-24');
    expect(built.openTools.every((tool) => tool.detail.length <= 300)).toBe(true);
  });

  it('trims every rendered event text field', async () => {
    const { journal, run, entrant } = await setup();
    const long = 'x'.repeat(500);
    journal.append(run.id, entrant.id, 'agent.message', {
      entrantId: entrant.id, text: long,
    });
    journal.append(run.id, entrant.id, 'agent.reasoning', {
      entrantId: entrant.id, text: long,
    });
    journal.append(run.id, entrant.id, 'tool.call', {
      entrantId: entrant.id, tool: 'shell', toolCallId: 'long-call', detail: long,
    });
    journal.append(run.id, entrant.id, 'tool.result', {
      entrantId: entrant.id, tool: 'shell', toolCallId: 'long-call', ok: true, detail: long,
    });
    journal.append(run.id, entrant.id, 'entrant.steered', {
      entrantId: entrant.id, text: long,
    });
    journal.append(run.id, entrant.id, 'entrant.prompt', {
      entrantId: entrant.id, text: long,
    });
    journal.append(run.id, entrant.id, 'entrant.nudged', {
      entrantId: entrant.id, flags: 0, text: long,
    });
    journal.append(run.id, 'director', 'director.broadcast', {
      targetEntrantIds: [entrant.id], text: long,
    });
    journal.append(run.id, entrant.id, 'entrant.error', {
      entrantId: entrant.id, message: long,
    });

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: 0,
    });

    expect(built.input.prompt).not.toContain('x'.repeat(301));
    expect(built.input.prompt).toContain('says:');
    expect(built.input.prompt).toContain('shell → running:');
    expect(built.input.prompt).toContain('broadcast from the director:');
    expect(built.input.prompt).toContain('error:');
  });

  it('caps the prompt near 12,000 characters by dropping the oldest event lines', async () => {
    const { journal, run, entrant } = await setup();
    for (let index = 0; index < 40; index += 1) {
      journal.append(run.id, entrant.id, 'tool.call', {
        entrantId: entrant.id,
        tool: 'shell',
        toolCallId: `call-${index}`,
        detail: `marker-${index}-${'x'.repeat(500)}`,
      });
    }

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: {}, basedOnEventId: 0,
    });

    expect(built.input.prompt.length).toBeLessThanOrEqual(12_000);
    expect(built.input.prompt).toMatch(/\(\d+ earlier events omitted\)/);
    expect(built.input.prompt).not.toContain('marker-0-');
    expect(built.input.prompt).toContain('marker-39-');
  });

  it('trims each challenge title to 80 characters', async () => {
    const { journal, run, entrant } = await setup();
    const title = `title-${'x'.repeat(100)}`;

    const built = buildNarrationWindow({
      journal, run, entrant, challengeTitles: { 1: title }, basedOnEventId: 0,
    });
    const titleLine = built.input.system.split('\n').find((line) => line.startsWith('#1:'));

    expect(titleLine).toHaveLength(84);
    expect(titleLine).toBe(`#1: ${title.slice(0, 79)}…`);
  });
});

describe('firstSentences', () => {
  it('keeps the first two sentences and drops the rest', () => {
    expect(firstSentences('Holds the #1 flag. Running forge tests. Now idle. More.', 2))
      .toBe('Holds the #1 flag. Running forge tests.');
  });
  it('does not split on a period inside a filename', () => {
    expect(firstSentences('Reading Challenge12.sol to understand the setup. Examining deploy.ts next. Then more.', 2))
      .toBe('Reading Challenge12.sol to understand the setup. Examining deploy.ts next.');
  });
  it('returns a short or unterminated text unchanged', () => {
    expect(firstSentences('Waiting on forge test for 104s', 2)).toBe('Waiting on forge test for 104s');
    expect(firstSentences('Deploying #8.', 2)).toBe('Deploying #8.');
  });
});
