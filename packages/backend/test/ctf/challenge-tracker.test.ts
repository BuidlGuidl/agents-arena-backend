import { getAddress } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  challengeAddressIndex,
  dropCurrentChallenge,
  savePendingGuess,
  mayMove,
  matchChallenge,
  matchChallengeInProse,
  recordCurrentChallenge,
  takePendingGuess,
  solvedChallenges,
  useSolvedLookup,
} from '../../src/ctf/challenge-tracker.js';

const challenge5 = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const challenge12 = getAddress('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
const nftFlags = getAddress('0x8A791620dd6260079BF849Dc5567aDC3F2FdC318');
const challenge12HeroNft = getAddress('0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0');

const index = challengeAddressIndex({
  Challenge5: challenge5,
  Challenge12: challenge12,
  Challenge12HeroNFT: challenge12HeroNft,
  NFTFlags: nftFlags,
});
const solvedByEntrant = new Map<string, Set<number>>();

function key(runId: string, entrantId: string): string {
  return `${runId}:${entrantId}`;
}

function solve(runId: string, entrantId: string, ...challengeIds: number[]): void {
  solvedByEntrant.set(key(runId, entrantId), new Set(challengeIds));
}

beforeEach(() => {
  solvedByEntrant.clear();
  useSolvedLookup((runId, entrantId) => solvedByEntrant.get(key(runId, entrantId)) ?? new Set());
});

describe('challengeAddressIndex', () => {
  it('indexes challenge deployments and skips the rest', () => {
    expect(index.get(challenge5.toLowerCase())).toBe(5);
    expect(index.get(challenge12.toLowerCase())).toBe(12);
    expect(index.get(challenge12HeroNft.toLowerCase())).toBe(12);
    expect(index.has(nftFlags.toLowerCase())).toBe(false);
  });
});

describe('matchChallenge', () => {
  it('matches a contract source read by name', () => {
    expect(matchChallenge('cat /challenges/contracts/Challenge5.sol', index))
      .toEqual({ challengeId: 5, evidence: 'Challenge5' });
  });

  it('matches spelled-out and lowercase references', () => {
    expect(matchChallenge('grep -n unlock challenge 3 notes', index)?.challengeId).toBe(3);
    expect(matchChallenge('vi solve-challenge7.s.sol', index)?.challengeId).toBe(7);
  });

  it('reads Challenge12 as twelve, not one', () => {
    expect(matchChallenge('cat Challenge12.sol', index)?.challengeId).toBe(12);
  });

  it('matches a known deployed address in any case', () => {
    expect(matchChallenge(`cast call ${challenge5.toLowerCase()} "locked()"`, index)?.challengeId).toBe(5);
  });

  it('ignores unknown addresses', () => {
    expect(matchChallenge(`cast send ${nftFlags} "mint()"`, index)).toBeUndefined();
  });

  it('treats a command touching several challenges as ambiguous', () => {
    expect(matchChallenge('diff Challenge4.sol Challenge5.sol', index)).toBeUndefined();
    expect(matchChallenge(`cat Challenge4.sol && cast call ${challenge5} "x()"`, index)).toBeUndefined();
  });

  it('counts a name and its own address as one reference', () => {
    expect(matchChallenge(`cast call ${challenge5} --abi Challenge5.sol`, index)?.challengeId).toBe(5);
  });

  it('returns nothing for a command without challenge references', () => {
    expect(matchChallenge('ls /challenges/contracts', index)).toBeUndefined();
    expect(matchChallenge('cat /challenges/BRIEFING.md', index)).toBeUndefined();
  });
});

describe('matchChallengeInProse', () => {
  it('takes the last sentence with or without the earlier challenge ignored', () => {
    const text = "Challenge 11 is confirmed. I'm starting Challenge 12.";
    expect(matchChallengeInProse(text, index)?.challengeId).toBe(12);
    expect(matchChallengeInProse(text, index, new Set([11]))?.challengeId).toBe(12);
  });

  it('takes the last newline-separated item', () => {
    expect(matchChallengeInProse('- Solved Challenge 11\n- Starting Challenge 12', index)?.challengeId)
      .toBe(12);
  });

  it('only matches within the last 2000 characters', () => {
    expect(matchChallengeInProse(`Challenge 12 ${'x'.repeat(2_000)}`, index)).toBeUndefined();
    expect(matchChallengeInProse(`Challenge 5 ${'x'.repeat(2_000)} Challenge 12`, index)?.challengeId)
      .toBe(12);
  });

  it('ignores solved challenges inside a sentence', () => {
    const text = 'For challenge 12, claim the gold with the challenge 1 flag.';
    expect(matchChallengeInProse(text, index)).toBeUndefined();
    expect(matchChallengeInProse(text, index, new Set([1]))?.challengeId).toBe(12);
  });

  it('matches a challenge before a colon', () => {
    expect(matchChallengeInProse('Now Challenge 2:', index)?.challengeId).toBe(2);
  });

  it('rejects a sentence that names two unsolved challenges', () => {
    expect(matchChallengeInProse('Compare Challenge 2 and Challenge 3.', index)).toBeUndefined();
  });
});

describe('current challenge store', () => {
  it('lets a self-report replace a guess', () => {
    recordCurrentChallenge('run-self-guess', 'codex-1', 5, 'command');
    expect(mayMove('run-self-guess', 'codex-1', 6, 'self')).toBe(true);
  });

  it('lets a self-report replace a self-report', () => {
    recordCurrentChallenge('run-self-self', 'codex-1', 5, 'self');
    expect(mayMove('run-self-self', 'codex-1', 6, 'self')).toBe(true);
  });

  it('lets a guess replace a guess', () => {
    recordCurrentChallenge('run-guess-guess', 'codex-1', 5, 'message');
    expect(mayMove('run-guess-guess', 'codex-1', 6, 'command')).toBe(true);
  });

  it('does not let a guess replace a live self-report', () => {
    recordCurrentChallenge('run-live', 'codex-1', 5, 'self');
    expect(mayMove('run-live', 'codex-1', 6, 'command')).toBe(false);
  });

  it('lets a guess replace a solved self-report', () => {
    recordCurrentChallenge('run-solved', 'codex-1', 5, 'self');
    solve('run-solved', 'codex-1', 5);
    expect(solvedChallenges('run-solved', 'codex-1')).toEqual(new Set([5]));
    expect(mayMove('run-solved', 'codex-1', 6, 'message')).toBe(true);
  });

  it('treats a same-id self-report over a guess as a change', () => {
    recordCurrentChallenge('run-claim', 'codex-1', 5, 'command');
    expect(mayMove('run-claim', 'codex-1', 5, 'self')).toBe(true);
  });

  it('dedupes a same-id self-report over a self-report', () => {
    recordCurrentChallenge('run-self-repeat', 'codex-1', 5, 'self');
    expect(mayMove('run-self-repeat', 'codex-1', 5, 'self')).toBe(false);
  });

  it('dedupes a same-id guess', () => {
    recordCurrentChallenge('run-guess-repeat', 'codex-1', 5, 'command');
    expect(mayMove('run-guess-repeat', 'codex-1', 5, 'message')).toBe(false);
  });

  it('releases the latest pending guess once after the target is solved', () => {
    const runId = 'run-pending';
    recordCurrentChallenge(runId, 'codex-1', 5, 'self');
    savePendingGuess(runId, 'codex-1', { challengeId: 6, evidence: 'Challenge6' }, 'command');
    savePendingGuess(runId, 'codex-1', { challengeId: 7, evidence: 'Challenge7' }, 'message');
    expect(takePendingGuess(runId, 'codex-1')).toBeUndefined();
    solve(runId, 'codex-1', 5);
    expect(takePendingGuess(runId, 'codex-1')).toEqual({
      challengeId: 7,
      evidence: 'Challenge7',
      via: 'message',
    });
    expect(takePendingGuess(runId, 'codex-1')).toBeUndefined();
  });

  it('does not let a guess naming the current target overwrite the pending guess', () => {
    const runId = 'run-pending-same';
    recordCurrentChallenge(runId, 'codex-1', 11, 'self');
    savePendingGuess(runId, 'codex-1', { challengeId: 12, evidence: 'Challenge12' }, 'message');
    savePendingGuess(runId, 'codex-1', { challengeId: 11, evidence: 'Challenge11' }, 'command');
    solve(runId, 'codex-1', 11);
    expect(takePendingGuess(runId, 'codex-1')?.challengeId).toBe(12);
  });

  it('does not release a pending guess that is solved', () => {
    const runId = 'run-pending-solved';
    recordCurrentChallenge(runId, 'codex-1', 5, 'self');
    savePendingGuess(runId, 'codex-1', { challengeId: 6, evidence: 'Challenge6' }, 'command');
    solve(runId, 'codex-1', 5, 6);
    expect(takePendingGuess(runId, 'codex-1')).toBeUndefined();
  });

  it('drops a pending guess when the target is replaced', () => {
    const runId = 'run-pending-dropped';
    recordCurrentChallenge(runId, 'codex-1', 5, 'self');
    savePendingGuess(runId, 'codex-1', { challengeId: 6, evidence: 'Challenge6' }, 'command');
    recordCurrentChallenge(runId, 'codex-1', 7, 'self');
    solve(runId, 'codex-1', 7);
    expect(takePendingGuess(runId, 'codex-1')).toBeUndefined();
  });

  it('does not hold a guess without a target', () => {
    savePendingGuess('run-empty', 'codex-1', { challengeId: 6, evidence: 'Challenge6' }, 'command');
    solve('run-empty', 'codex-1', 5);
    expect(takePendingGuess('run-empty', 'codex-1')).toBeUndefined();
  });

  it('forgets a dropped target and pending guess', () => {
    const runId = 'run-drop';
    recordCurrentChallenge(runId, 'codex-1', 5, 'self');
    savePendingGuess(runId, 'codex-1', { challengeId: 6, evidence: 'Challenge6' }, 'command');
    dropCurrentChallenge(runId, 'codex-1');
    solve(runId, 'codex-1', 5);
    expect(mayMove(runId, 'codex-1', 7, 'message')).toBe(true);
    expect(takePendingGuess(runId, 'codex-1')).toBeUndefined();
  });
});
