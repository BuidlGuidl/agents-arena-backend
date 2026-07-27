import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChainProfile } from '../../src/chain/profile.js';
import type { ChallengePack } from '../../src/ctf/pack.js';
import {
  assertPackMatchesProfile,
  createChallengePackResolver,
} from '../../src/ctf/resolve.js';

const nftFlags = getAddress('0x8A791620dd6260079BF849Dc5567aDC3F2FdC318');
const challenge1 = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const identityRegistry = getAddress('0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6');
const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

const localProfile: ChainProfile = {
  name: 'fixture-local',
  rpcUrl: 'http://127.0.0.1:8545',
  containerRpcUrl: 'http://host.docker.internal:8545',
  chainId: 31337,
  confirmations: 1,
  nftFlags,
  challenge1,
  identityRegistry,
};

const fixturePack: ChallengePack = {
  dir: '/tmp/challenge-pack',
  addresses: {
    NFTFlags: nftFlags,
    Challenge1: challenge1,
  },
};

describe('createChallengePackResolver', () => {
  let previousAiCtfRepo: string | undefined;
  const generatedPaths: string[] = [];

  beforeEach(() => {
    previousAiCtfRepo = process.env.AI_CTF_REPO;
  });

  afterEach(() => {
    if (previousAiCtfRepo === undefined) {
      delete process.env.AI_CTF_REPO;
    } else {
      process.env.AI_CTF_REPO = previousAiCtfRepo;
    }
    for (const path of generatedPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('returns undefined for a profile with a briefing URL', () => {
    expect(createChallengePackResolver({
      ...localProfile,
      briefingUrl: 'https://ctf.example.test/briefing',
    })).toBeUndefined();
  });

  it('returns a resolver for a profile without a briefing URL', () => {
    expect(createChallengePackResolver(localProfile)).toBeTypeOf('function');
  });

  it.each(['unset', 'empty'] as const)(
    'names AI_CTF_REPO when the environment variable is %s',
    (state) => {
      if (state === 'unset') {
        delete process.env.AI_CTF_REPO;
      } else {
        process.env.AI_CTF_REPO = '';
      }
      const resolver = createChallengePackResolver(localProfile);
      if (resolver === undefined) throw new Error('Expected a local challenge pack resolver');

      expect(() => resolver('run-without-repo')).toThrow('AI_CTF_REPO');
    },
  );

  it('assembles and caches a pack from the existing fixture tree', () => {
    process.env.AI_CTF_REPO = fixtureDir;
    const resolver = createChallengePackResolver(localProfile);
    if (resolver === undefined) throw new Error('Expected a local challenge pack resolver');
    const runId = `resolver-${randomUUID()}`;

    const firstPath = resolver(runId);
    generatedPaths.push(firstPath);
    const secondPath = resolver(runId);

    expect(existsSync(join(firstPath, 'BRIEFING.md'))).toBe(true);
    expect(secondPath).toBe(firstPath);
  });
});

describe('assertPackMatchesProfile', () => {
  it('accepts matching NFTFlags and Challenge1 deployments', () => {
    expect(() => assertPackMatchesProfile(fixturePack, localProfile)).not.toThrow();
  });

  it('names both Challenge1 addresses when they differ', () => {
    const actual = getAddress('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
    const pack: ChallengePack = {
      ...fixturePack,
      addresses: {
        ...fixturePack.addresses,
        Challenge1: actual,
      },
    };

    expect(() => assertPackMatchesProfile(pack, localProfile)).toThrow(actual);
    expect(() => assertPackMatchesProfile(pack, localProfile)).toThrow(challenge1);
  });

  it('rejects a pack without an NFTFlags deployment', () => {
    const pack: ChallengePack = {
      ...fixturePack,
      addresses: {
        Challenge1: challenge1,
      },
    };

    expect(() => assertPackMatchesProfile(pack, localProfile)).toThrow('NFTFlags');
  });
});
