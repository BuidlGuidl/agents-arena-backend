import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Address } from 'viem';

import type { ChainProfile } from '../chain/profile.js';
import { assembleChallengePack, type ChallengePack } from './pack.js';

export type ChallengePackResolver = (runId: string) => string;

const PACK_ROOT = 'arena-challenge-pack';

// The local addresses in chains.json are derived from the deploy order, so a
// stray transaction before a later deployment shifts them. The pack reads what
// the deploy actually wrote, which turns that drift into a failed prepare
// instead of an entrant calling a contract that isn't there.
export function assertPackMatchesProfile(pack: ChallengePack, profile: ChainProfile): void {
  const expected: ReadonlyArray<readonly [string, Address]> = [
    ['NFTFlags', profile.nftFlags],
    ['Challenge1', profile.challenge1],
  ];

  for (const [name, address] of expected) {
    const actual = pack.addresses[name];
    if (actual === undefined) {
      throw new Error(`Challenge pack has no ${name} deployment; profile ${profile.name} expects ${address}`);
    }
    if (actual !== address) {
      throw new Error(
        `Challenge pack ${name} is ${actual}, but profile ${profile.name} expects ${address}`,
      );
    }
  }
}

// A profile with a briefingUrl sends the entrant to the public site, so it needs
// no pack (ADR-0009).
export function createChallengePackResolver(
  profile: ChainProfile,
): ChallengePackResolver | undefined {
  if (profile.briefingUrl !== undefined) {
    return undefined;
  }

  const built = new Map<string, string>();

  return (runId) => {
    const existing = built.get(runId);
    if (existing !== undefined) {
      return existing;
    }

    const aiCtfRepo = process.env.AI_CTF_REPO;
    if (aiCtfRepo === undefined || aiCtfRepo === '') {
      throw new Error(
        'AI_CTF_REPO must point at a local ai.ctf.buidlguidl.com checkout to assemble the challenge pack',
      );
    }

    const pack = assembleChallengePack({ aiCtfRepo, outDir: join(tmpdir(), PACK_ROOT, runId) });
    assertPackMatchesProfile(pack, profile);
    built.set(runId, pack.dir);
    return pack.dir;
  };
}
