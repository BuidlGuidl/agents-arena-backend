import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  challengeAddressIndex,
  currentChallenge,
  dropCurrentChallenge,
  mayMove,
  matchChallenge,
  matchChallengeInProse,
  recordCurrentChallenge,
  markSolved,
  solvedChallenges,
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
    const guess = matchChallenge('cat /challenges/contracts/Challenge5.sol', index);
    expect(guess).toEqual({ challengeId: 5, evidence: 'Challenge5' });
  });

  it('matches spelled-out and lowercase references', () => {
    expect(matchChallenge('grep -n unlock challenge 3 notes', index)?.challengeId).toBe(3);
    expect(matchChallenge('vi solve-challenge7.s.sol', index)?.challengeId).toBe(7);
  });

  it('reads Challenge12 as twelve, not one', () => {
    expect(matchChallenge('cat Challenge12.sol', index)?.challengeId).toBe(12);
  });

  it('matches a known deployed address in any case', () => {
    const guess = matchChallenge(`cast call ${challenge5.toLowerCase()} "locked()"`, index);
    expect(guess?.challengeId).toBe(5);
  });

  it('ignores unknown addresses', () => {
    expect(matchChallenge(`cast send ${nftFlags} "mint()"`, index)).toBeUndefined();
  });

  it('treats a command touching several challenges as ambiguous', () => {
    expect(matchChallenge('diff Challenge4.sol Challenge5.sol', index)).toBeUndefined();
    expect(matchChallenge(`cat Challenge4.sol && cast call ${challenge5} "x()"`, index)).toBeUndefined();
  });

  it('counts a name and its own address as one reference', () => {
    const guess = matchChallenge(`cast call ${challenge5} --abi Challenge5.sol`, index);
    expect(guess?.challengeId).toBe(5);
  });

  it('returns nothing for a command without challenge references', () => {
    expect(matchChallenge('ls /challenges/contracts', index)).toBeUndefined();
    expect(matchChallenge('cat /challenges/BRIEFING.md', index)).toBeUndefined();
  });
});

describe('matchChallengeInProse', () => {
  it('takes the last sentence that names one challenge', () => {
    const text = "Challenge 11 is confirmed. I'm starting Challenge 12.";
    expect(matchChallengeInProse(text, index)?.challengeId).toBe(12);
    expect(matchChallengeInProse(text, index, new Set([11]))?.challengeId).toBe(12);
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
  it('lets a self-report override a guess', () => {
    try {
      recordCurrentChallenge('run-self', 'codex-1', 5, 'command');
      expect(mayMove('run-self', 'codex-1', 6, 'self')).toBe(true);
    } finally {
      dropCurrentChallenge('run-self', 'codex-1');
    }
  });

  it('does not let a guess move a live self-report', () => {
    try {
      recordCurrentChallenge('run-live', 'codex-1', 5, 'self');
      expect(mayMove('run-live', 'codex-1', 6, 'command')).toBe(false);
    } finally {
      dropCurrentChallenge('run-live', 'codex-1');
    }
  });

  it('lets a guess fill an empty target', () => {
    try {
      expect(mayMove('run-empty', 'codex-1', 5, 'message')).toBe(true);
    } finally {
      dropCurrentChallenge('run-empty', 'codex-1');
    }
  });

  it('lets a guess replace a solved target', () => {
    try {
      recordCurrentChallenge('run-solved', 'codex-1', 5, 'self');
      markSolved('run-solved', 'codex-1', 5);
      expect(solvedChallenges('run-solved', 'codex-1')).toEqual(new Set([5]));
      expect(mayMove('run-solved', 'codex-1', 6, 'message')).toBe(true);
    } finally {
      dropCurrentChallenge('run-solved', 'codex-1');
    }
  });

  it('locks a guessed id when the agent reports the same id', () => {
    try {
      recordCurrentChallenge('run-lock', 'codex-1', 5, 'command');
      expect(mayMove('run-lock', 'codex-1', 5, 'self')).toBe(false);
      expect(mayMove('run-lock', 'codex-1', 6, 'command')).toBe(false);
    } finally {
      dropCurrentChallenge('run-lock', 'codex-1');
    }
  });

  it('holds one value per run and entrant, shared by both sources', () => {
    try {
      expect(currentChallenge('run-a', 'codex-1')).toBeUndefined();
      recordCurrentChallenge('run-a', 'codex-1', 5, 'command');
      expect(currentChallenge('run-a', 'codex-1')).toBe(5);
      // Another entrant and another run each track their own value.
      expect(currentChallenge('run-a', 'opencode-1')).toBeUndefined();
      expect(currentChallenge('run-b', 'codex-1')).toBeUndefined();
      // Either source moving the value is what the other dedupes against.
      recordCurrentChallenge('run-a', 'codex-1', 6, 'self');
      expect(currentChallenge('run-a', 'codex-1')).toBe(6);
    } finally {
      dropCurrentChallenge('run-a', 'codex-1');
    }
  });

  it('forgets a dropped entrant', () => {
    recordCurrentChallenge('run-c', 'codex-1', 3, 'self');
    markSolved('run-c', 'codex-1', 3);
    dropCurrentChallenge('run-c', 'codex-1');
    expect(currentChallenge('run-c', 'codex-1')).toBeUndefined();
    expect(solvedChallenges('run-c', 'codex-1')).toEqual(new Set());
  });
});
