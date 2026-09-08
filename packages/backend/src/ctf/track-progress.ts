import type { EventJournal } from '../journal.js';
import {
  matchChallenge, matchChallengeInProse, mayMove, savePendingGuess, recordCurrentChallenge,
  solvedChallenges,
} from './challenge-tracker.js';

const matchers = { command: matchChallenge, message: matchChallengeInProse };

export function trackProgress(
  journal: EventJournal,
  { runId, entrantId }: { runId: string; entrantId: string },
  detail: string,
  via: 'command' | 'message',
  addressIndex: ReadonlyMap<string, number>,
): void {
  const guess = matchers[via](detail, addressIndex, solvedChallenges(runId, entrantId));
  if (guess === undefined) return;
  if (!mayMove(runId, entrantId, guess.challengeId, via)) {
    savePendingGuess(runId, entrantId, guess, via);
    return;
  }
  journal.append(runId, entrantId, 'entrant.challenge', {
    entrantId, challengeId: guess.challengeId, via, evidence: guess.evidence,
  });
  recordCurrentChallenge(runId, entrantId, guess.challengeId, via);
}
