import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntrantDriver, EntrantRecord, RunRecord } from '../../src/adapters/types.js';
import type { EntrantStatus } from '../../src/contract.js';
import { entrants, runs } from '../../src/db/schema.js';
import { EventJournal } from '../../src/journal.js';
import type { Narrate } from '../../src/narration/openrouter.js';
import { NarrationWatcher } from '../../src/narration/watch.js';
import { buildNarrationWindow } from '../../src/narration/window.js';
import { RunManager } from '../../src/run-manager.js';

vi.mock('../../src/narration/window.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/narration/window.js')>();
  return { ...actual, buildNarrationWindow: vi.fn(actual.buildNarrationWindow) };
});

const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() { return 'injected'; },
  async restart() {},
  async stop() {},
};

interface Fixture {
  journal: EventJournal;
  run: RunRecord;
  entrant: EntrantRecord;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(): Promise<Fixture> {
  const journal = new EventJournal(':memory:');
  const manager = new RunManager(journal, noopDriver);
  const created = await manager.create({ preset: 'fake-duel' });
  await manager.start(created.run.id);
  const run = journal.database.select().from(runs).where(eq(runs.id, created.run.id)).get();
  const entrant = journal.database.select().from(entrants).where(and(
    eq(entrants.runId, created.run.id), eq(entrants.id, 'codex-1'),
  )).get();
  if (run === undefined || entrant === undefined) throw new Error('Missing watcher fixture rows');
  return { journal, run, entrant };
}

function setStatus(fixture: Fixture, status: EntrantStatus): void {
  fixture.journal.database.update(entrants).set({ status }).where(and(
    eq(entrants.runId, fixture.run.id), eq(entrants.id, fixture.entrant.id),
  )).run();
  fixture.journal.append(fixture.run.id, fixture.entrant.id, 'entrant.status', {
    entrantId: fixture.entrant.id, status,
  });
}

function start(
  fixture: Fixture,
  narrate: Narrate,
  minMs = 20,
  maxMs = 90,
): { controller: AbortController; task: Promise<void> } {
  const controller = new AbortController();
  const watcher = new NarrationWatcher({
    journal: fixture.journal,
    narrate,
    challengeTitles: {},
    minMs,
    maxMs,
  });
  return {
    controller,
    task: watcher.watch(fixture.run, [fixture.entrant], controller.signal),
  };
}

async function stop(fixture: Fixture, active: ReturnType<typeof start>): Promise<void> {
  active.controller.abort();
  await active.task;
  fixture.journal.close();
}

function narrationEvents(fixture: Fixture) {
  return fixture.journal.after(fixture.run.id, 0)
    .filter((event) => event.type === 'entrant.narration');
}

function seedNarration(fixture: Fixture, text = 'Previous line.'): void {
  const head = fixture.journal.history(fixture.run.id, { limit: 1 }).lastEventId;
  fixture.journal.append(fixture.run.id, fixture.entrant.id, 'entrant.narration', {
    entrantId: fixture.entrant.id,
    text,
    basedOnEventId: head,
  });
}

describe('NarrationWatcher unit behavior in isolation', () => {
  it('waits for the minimum after new activity', async () => {
    const fixture = await setup();
    seedNarration(fixture);
    const narrate = vi.fn<Narrate>(async () => 'Working on it.');
    const active = start(fixture, narrate, 20, 90);
    setStatus(fixture, 'working');

    await vi.advanceTimersByTimeAsync(19);
    expect(narrate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(narrationEvents(fixture)).toHaveLength(2);
    await stop(fixture, active);
  });

  it('calls at the maximum when no event changed', async () => {
    const fixture = await setup();
    const narrate = vi.fn<Narrate>(async () => 'Still waiting.');
    const active = start(fixture, narrate, 10, 30);
    setStatus(fixture, 'working');

    await vi.advanceTimersByTimeAsync(0);
    expect(narrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29);
    expect(narrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(narrate.mock.calls[1]?.[0].prompt).toContain('no new events since your last line');
    await stop(fixture, active);
  });

  it('narrates new idle events without a ceiling and stays alive for the next turn', async () => {
    const fixture = await setup();
    seedNarration(fixture);
    const narrate = vi.fn<Narrate>(async () => 'The entrant changes state.');
    const active = start(fixture, narrate, 10, 30);
    setStatus(fixture, 'idle');

    await vi.advanceTimersByTimeAsync(10);
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(narrate.mock.calls[0]?.[0].prompt).toContain('Status: idle');

    await vi.advanceTimersByTimeAsync(100);
    expect(narrate).toHaveBeenCalledTimes(1);

    setStatus(fixture, 'working');
    await vi.advanceTimersByTimeAsync(0);
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(narrate.mock.calls[1]?.[0].prompt).toContain('Status: working');
    await stop(fixture, active);
  });

  it('in isolation, writes one closing line on done and does not repeat it after restart', async () => {
    const fixture = await setup();
    setStatus(fixture, 'working');
    seedNarration(fixture);
    const narrate = vi.fn<Narrate>(async () => 'The entrant has stopped.');
    const active = start(fixture, narrate, 1_000, 2_000);
    setStatus(fixture, 'done');

    await vi.advanceTimersByTimeAsync(0);
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(narrate.mock.calls[0]?.[0].prompt).toContain('Status: done');
    await active.task;
    expect(narrationEvents(fixture)).toHaveLength(2);

    const restartedNarrate = vi.fn<Narrate>(async () => 'Duplicate.');
    const restarted = start(fixture, restartedNarrate, 10, 30);
    await restarted.task;
    expect(restartedNarrate).not.toHaveBeenCalled();
    active.controller.abort();
    restarted.controller.abort();
    fixture.journal.close();
  });

  it('allows only one model call in flight for an entrant', async () => {
    const fixture = await setup();
    seedNarration(fixture);
    let release!: (value: string) => void;
    const first = new Promise<string>((resolve) => { release = resolve; });
    const narrate = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue('Second line.');
    const active = start(fixture, narrate, 10, 30);
    setStatus(fixture, 'working');
    await vi.advanceTimersByTimeAsync(10);
    expect(narrate).toHaveBeenCalledTimes(1);

    fixture.journal.append(fixture.run.id, fixture.entrant.id, 'agent.message', {
      entrantId: fixture.entrant.id, text: 'more work',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(narrate).toHaveBeenCalledTimes(1);

    release('First line.');
    await vi.advanceTimersByTimeAsync(0);
    expect(narrate).toHaveBeenCalledTimes(2);
    await stop(fixture, active);
  });

  it('in isolation, resumes from the last narration cursor after restart', async () => {
    const fixture = await setup();
    setStatus(fixture, 'working');
    const old = fixture.journal.append(fixture.run.id, fixture.entrant.id, 'agent.message', {
      entrantId: fixture.entrant.id, text: 'old work',
    });
    fixture.journal.append(fixture.run.id, fixture.entrant.id, 'entrant.narration', {
      entrantId: fixture.entrant.id, text: 'Old line.', basedOnEventId: old.id,
    });
    await vi.advanceTimersByTimeAsync(5);
    const fresh = fixture.journal.append(fixture.run.id, fixture.entrant.id, 'tool.call', {
      entrantId: fixture.entrant.id, tool: 'forge', toolCallId: 'fresh', detail: 'forge test',
    });
    const narrate = vi.fn<Narrate>(async () => 'Fresh line.');
    const active = start(fixture, narrate, 10, 90);

    await vi.advanceTimersByTimeAsync(5);
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(narrate.mock.calls[0]?.[0].prompt).not.toContain('old work');
    expect(narrate.mock.calls[0]?.[0].prompt).toContain('forge test');
    expect(narrationEvents(fixture).at(-1)?.payload.basedOnEventId).toBe(fresh.id);
    await stop(fixture, active);
  });

  it('warns and backs off after a model failure', async () => {
    const fixture = await setup();
    seedNarration(fixture);
    const logger = { warn: vi.fn() };
    const narrate = vi.fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue('Recovered.');
    const controller = new AbortController();
    const watcher = new NarrationWatcher({
      journal: fixture.journal,
      narrate,
      challengeTitles: {},
      minMs: 10,
      maxMs: 90,
      logger,
    });
    const task = watcher.watch(fixture.run, [fixture.entrant], controller.signal);
    setStatus(fixture, 'working');

    await vi.advanceTimersByTimeAsync(10);
    expect(narrate).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
    await vi.advanceTimersByTimeAsync(9);
    expect(narrate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(narrate).toHaveBeenCalledTimes(2);
    expect(fixture.journal.after(fixture.run.id, 0).some((event) => event.type === 'run.error'))
      .toBe(false);

    controller.abort();
    await task;
    fixture.journal.close();
  });

  it('aborts an in-flight model call when the run stops', async () => {
    const fixture = await setup();
    let observedSignal: AbortSignal | undefined;
    const narrate = vi.fn<Narrate>(async (_input, signal) => {
      observedSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const active = start(fixture, narrate);
    setStatus(fixture, 'working');
    await vi.advanceTimersByTimeAsync(0);
    expect(narrate).toHaveBeenCalledTimes(1);

    active.controller.abort();
    await active.task;
    expect(observedSignal?.aborted).toBe(true);
    fixture.journal.close();
  });

  it('aborts a model call after 30 seconds', async () => {
    const fixture = await setup();
    const logger = { warn: vi.fn() };
    let observedSignal: AbortSignal | undefined;
    const narrate = vi.fn<Narrate>(async (_input, signal) => {
      observedSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const watcher = new NarrationWatcher({
      journal: fixture.journal,
      narrate,
      challengeTitles: {},
      minMs: 10,
      maxMs: 90,
      logger,
    });
    const task = watcher.watch(fixture.run, [fixture.entrant], controller.signal);
    setStatus(fixture, 'working');
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 30000ms'));

    controller.abort();
    await task;
    fixture.journal.close();
  });

  it('does not build windows for unrelated events before the timing floor', async () => {
    const fixture = await setup();
    setStatus(fixture, 'working');
    seedNarration(fixture);
    const buildSpy = vi.mocked(buildNarrationWindow);
    buildSpy.mockClear();
    const narrate = vi.fn<Narrate>(async () => 'Unexpected.');
    const active = start(fixture, narrate, 1_000_000, 2_000_000);

    for (let index = 0; index < 200; index += 1) {
      fixture.journal.append(fixture.run.id, 'opencode-1', 'agent.message', {
        entrantId: 'opencode-1', text: `unrelated-${index}`,
      });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(narrate).not.toHaveBeenCalled();
    await stop(fixture, active);
  });

  it('advances past irrelevant rows during the initial activity check', async () => {
    const fixture = await setup();
    setStatus(fixture, 'working');
    const previousHead = fixture.journal.history(fixture.run.id, { limit: 1 }).lastEventId;
    const previousNarration = fixture.journal.append(
      fixture.run.id,
      fixture.entrant.id,
      'entrant.narration',
      {
        entrantId: fixture.entrant.id,
        text: 'Previous line.',
        basedOnEventId: previousHead,
      },
    );
    const narrate = vi.fn<Narrate>(async () => 'Fresh line.');
    const active = start(fixture, narrate, 10, 90);

    fixture.journal.append(fixture.run.id, fixture.entrant.id, 'agent.message', {
      entrantId: fixture.entrant.id,
      text: 'fresh work',
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(buildNarrationWindow).toHaveBeenCalledWith(expect.objectContaining({
      basedOnEventId: previousNarration.id,
    }));
    await stop(fixture, active);
  });
});
