import { and, eq } from 'drizzle-orm';

import { recordSolve } from '../chain/storage.js';
import type { EntrantStatus } from '../contract.js';
import { entrants } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import { costForTokens } from '../pricing.js';
import type { EntrantDriver, EntrantRecord, RunRecord } from './types.js';

export type Schedule = (task: () => void, delayMs: number) => unknown;

const defaultSchedule: Schedule = (task, delayMs) => setTimeout(task, delayMs);

export class FakeDriver implements EntrantDriver {
  private readonly activeEntrants = new Set<string>();
  private toolCallCount = 0;

  constructor(
    private readonly journal: EventJournal,
    private readonly schedule: Schedule = defaultSchedule,
  ) {}

  async prepare(_run: RunRecord, _entrant: EntrantRecord): Promise<void> {}

  async start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void> {
    const key = this.key(run.id, entrant.id);
    const toolCallId = `fake-${++this.toolCallCount}`;
    this.activeEntrants.add(key);
    this.setStatus(run.id, entrant.id, 'working');

    const script: Array<readonly [number, () => void]> = [
      [25, () => this.journal.append(run.id, entrant.id, 'agent.message', {
        entrantId: entrant.id,
        text: `Starting from: ${openingPrompt}`,
      })],
      [50, () => this.journal.append(run.id, entrant.id, 'tool.call', {
        entrantId: entrant.id,
        tool: 'shell',
        toolCallId,
        detail: 'inspect challenge files',
      })],
      [75, () => this.journal.append(run.id, entrant.id, 'tool.result', {
        entrantId: entrant.id,
        tool: 'shell',
        toolCallId,
        ok: true,
        detail: 'challenge files inspected',
      })],
      // Two priced turns, so a fake duel shows totals moving and shows the
      // partial-cost case: the codex model is in the rate table, the fake
      // opencode model is not, so one lane has a cost and the other has none.
      [90, () => this.emitUsage(run, entrant, 1_200, 180, 0)],
      [100, () => this.setStatus(run.id, entrant.id, 'idle')],
      // The second turn repeats the first turn's context, so most of it is cached.
      [5_500, () => this.emitUsage(run, entrant, 2_400, 320, 1_800)],
      // Scripted captures through the real dual-write path, so a fake duel
      // exercises the solves UI (event and snapshot alike) without a chain.
      ...(entrant.harness === 'codex' ? [3, 11] : [7, 2]).map((challengeId, index) => [
        3_000 + index * 5_000,
        () => recordSolve(this.journal.database, this.journal, {
          runId: run.id,
          entrantId: entrant.id,
          entrantAddress: entrant.address ?? entrant.id,
          challengeId,
          tokenId: String(challengeId),
          txHash: `0x${challengeId.toString(16).padStart(64, '0')}`,
          blockNumber: 0,
        }),
      ] as const),
    ];

    for (const [delay, emit] of script) {
      this.schedule(() => {
        if (this.activeEntrants.has(key)) {
          emit();
        }
      }, delay);
    }
  }

  async steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<void> {
    this.journal.append(run.id, entrant.id, 'entrant.steered', {
      entrantId: entrant.id,
      text,
    });
  }

  async stop(run: RunRecord, entrant: EntrantRecord): Promise<void> {
    this.activeEntrants.delete(this.key(run.id, entrant.id));
    this.setStatus(run.id, entrant.id, 'done');
  }

  private emitUsage(
    run: RunRecord,
    entrant: EntrantRecord,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): void {
    this.journal.append(run.id, entrant.id, 'usage', {
      entrantId: entrant.id,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd: costForTokens(entrant.model, inputTokens, outputTokens, cachedInputTokens),
    });
  }

  private setStatus(runId: string, entrantId: string, status: EntrantStatus): void {
    this.journal.database
      .update(entrants)
      .set({ status })
      .where(and(eq(entrants.runId, runId), eq(entrants.id, entrantId)))
      .run();
    this.journal.append(runId, entrantId, 'entrant.status', { entrantId, status });
  }

  private key(runId: string, entrantId: string): string {
    return `${runId}:${entrantId}`;
  }
}
