import type { ArenaEvent, RunSnapshot } from '../../../contract/arena-types';

export function projectSnapshot(current: RunSnapshot | undefined, event: ArenaEvent): RunSnapshot | undefined {
  if (current === undefined) return current;
  // The snapshot already reflects everything up to lastEventId; replayed events
  // must not re-apply (score.flag appends, so it is not idempotent).
  if (event.id <= current.lastEventId) return current;
  if (event.type === 'run.state') {
    return { ...current, state: event.payload.state, lastEventId: event.id };
  }
  if (event.type === 'entrant.status') {
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === event.payload.entrantId
        ? { ...entrant, status: event.payload.status }
        : entrant),
    };
  }
  if (event.type === 'score.flag') {
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === event.payload.entrantId
        ? {
          ...entrant,
          flags: entrant.flags + 1,
          solves: [
            ...entrant.solves,
            { challengeId: event.payload.challengeId, ts: event.ts, txHash: event.payload.txHash },
          ],
        }
        : entrant),
    };
  }
  if (event.type === 'entrant.challenge') {
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === event.payload.entrantId
        ? { ...entrant, currentChallengeId: event.payload.challengeId }
        : entrant),
    };
  }
  if (event.type === 'usage') {
    const { entrantId, inputTokens, outputTokens, costUsd } = event.payload;
    return {
      ...current,
      lastEventId: event.id,
      entrants: current.entrants.map((entrant) => entrant.id === entrantId
        ? {
          ...entrant,
          inputTokens: entrant.inputTokens + inputTokens,
          outputTokens: entrant.outputTokens + outputTokens,
          // A priced turn starts the total; unpriced turns leave it alone, so a
          // lane that never reports cost stays blank instead of showing $0.
          costUsd: costUsd === null ? entrant.costUsd : (entrant.costUsd ?? 0) + costUsd,
        }
        : entrant),
    };
  }
  return { ...current, lastEventId: event.id };
}
