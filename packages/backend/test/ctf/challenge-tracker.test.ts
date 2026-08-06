import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  challengeAddressIndex,
  currentChallenge,
  dropCurrentChallenge,
  matchChallenge,
  recordCurrentChallenge,
} from '../../src/ctf/challenge-tracker.js';

const challenge5 = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const challenge12 = getAddress('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
const nftFlags = getAddress('0x8A791620dd6260079BF849Dc5567aDC3F2FdC318');

const index = challengeAddressIndex({
  Challenge5: challenge5,
  Challenge12: challenge12,
  NFTFlags: nftFlags,
});

describe('challengeAddressIndex', () => {
  it('indexes challenge deployments and skips the rest', () => {
    expect(index.get(challenge5.toLowerCase())).toBe(5);
    expect(index.get(challenge12.toLowerCase())).toBe(12);
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

describe('current challenge store', () => {
  it('holds one value per run and entrant, shared by both sources', () => {
    try {
      expect(currentChallenge('run-a', 'codex-1')).toBeUndefined();
      recordCurrentChallenge('run-a', 'codex-1', 5);
      expect(currentChallenge('run-a', 'codex-1')).toBe(5);
      // Another entrant and another run each track their own value.
      expect(currentChallenge('run-a', 'opencode-1')).toBeUndefined();
      expect(currentChallenge('run-b', 'codex-1')).toBeUndefined();
      // Either source moving the value is what the other dedupes against.
      recordCurrentChallenge('run-a', 'codex-1', 6);
      expect(currentChallenge('run-a', 'codex-1')).toBe(6);
    } finally {
      dropCurrentChallenge('run-a', 'codex-1');
    }
  });

  it('forgets a dropped entrant', () => {
    recordCurrentChallenge('run-c', 'codex-1', 3);
    dropCurrentChallenge('run-c', 'codex-1');
    expect(currentChallenge('run-c', 'codex-1')).toBeUndefined();
  });
});
