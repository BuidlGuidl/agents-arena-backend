import type { EventJournal } from '../journal.js';
import {
  matchChallenge, matchChallengeInProse, mayMoveTarget, savePendingGuessTarget,
  solvedChallenges, type Target,
} from './challenge-tracker.js';

const matchers = { command: matchChallenge, message: matchChallengeInProse };

export function trackProgress(
  journal: EventJournal,
  { runId, entrantId }: { runId: string; entrantId: string },
  detail: string,
  via: 'command' | 'message',
  addressIndex: ReadonlyMap<string, number>,
  target: Target | undefined,
): Target | undefined {
  const guess = matchers[via](detail, addressIndex, solvedChallenges(runId, entrantId));
  if (guess === undefined) return target;
  if (!mayMoveTarget(target, guess.challengeId, via, solvedChallenges(runId, entrantId))) {
    return savePendingGuessTarget(target, guess, via);
  }
  journal.append(runId, entrantId, 'entrant.challenge', {
    entrantId, challengeId: guess.challengeId, via, evidence: guess.evidence,
  });
  return { challengeId: guess.challengeId, via };
}
