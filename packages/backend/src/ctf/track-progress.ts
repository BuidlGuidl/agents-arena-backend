import type { EventJournal } from '../journal.js';
import {
  matchChallenge, mayMove, savePendingGuess, recordCurrentChallenge,
  solvedChallenges, restoreChallengeOnRollback,
} from './challenge-tracker.js';

export function trackProgress(
  journal: EventJournal,
  runId: string,
  entrantId: string,
  detail: string,
  via: 'command' | 'message',
  addressIndex: ReadonlyMap<string, number>,
  matcher: typeof matchChallenge,
): void {
  const guess = matcher(detail, addressIndex, solvedChallenges(runId, entrantId));
  if (guess === undefined) return;
  journal.onRollback(restoreChallengeOnRollback(runId, entrantId));
  if (!mayMove(runId, entrantId, guess.challengeId, via)) {
    savePendingGuess(runId, entrantId, guess, via);
    return;
  }
  journal.append(runId, entrantId, 'entrant.challenge', {
    entrantId, challengeId: guess.challengeId, via, evidence: guess.evidence,
  });
  recordCurrentChallenge(runId, entrantId, guess.challengeId, via);
}
