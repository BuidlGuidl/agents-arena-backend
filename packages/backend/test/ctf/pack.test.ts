import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleChallengePack } from '../../src/ctf/pack.js';

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describe('assembleChallengePack', () => {
  let tempDir: string;
  let aiCtfRepo: string;
  let outDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'challenge-pack-'));
    aiCtfRepo = join(tempDir, 'ai-ctf');
    outDir = join(tempDir, 'pack');
    cpSync(fixtureDir, aiCtfRepo, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds a pack with checksummed addresses and numeric challenge order', () => {
    const pack = assembleChallengePack({ aiCtfRepo, outDir });

    expect(pack.dir).toBe(outDir);
    expect(pack.addresses).toEqual({
      Challenge1: getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3'),
      Challenge2: getAddress('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'),
      Challenge3: getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906'),
      Challenge4: getAddress('0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'),
      Challenge5: getAddress('0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'),
      Challenge6: getAddress('0x976EA74026E726554dB657fA54763abd0C3a0aa9'),
      Challenge7: getAddress('0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'),
      Challenge8: getAddress('0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f'),
      Challenge9: getAddress('0xa0Ee7A142d267C1f36714E4a8F75612F20a79720'),
      Challenge10: getAddress('0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0'),
      Challenge11: getAddress('0x71bE63f3384f5fb98995898A86B02Fb2426c5788'),
      Challenge12: getAddress('0xFABB0ac9d68B0B445fB7357272Ff202C5651694a'),
      Challenge12Dungeon: getAddress('0x0165878A594ca255338adfa4d48449f69242Eb8F'),
      MockIdentityRegistry: getAddress('0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6'),
      NFTFlags: getAddress('0x8A791620dd6260079BF849Dc5567aDC3F2FdC318'),
    });

    const briefing = readFileSync(join(outDir, 'BRIEFING.md'), 'utf8');
    const rows = briefing
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.includes('Contract') && !line.includes('---'));
    expect(rows.map((row) => row.split(' | ')[0]?.slice(2))).toEqual([
      'Challenge1',
      'Challenge2',
      'Challenge3',
      'Challenge4',
      'Challenge5',
      'Challenge6',
      'Challenge7',
      'Challenge8',
      'Challenge9',
      'Challenge10',
      'Challenge11',
      'Challenge12',
      'Challenge12Dungeon',
      'MockIdentityRegistry',
      'NFTFlags',
    ]);
  });

  // Asserted against a literal, not against the expression the implementation
  // uses — otherwise the test passes whatever that expression does.
  it('separates challenge markdown with a thematic break on its own line', () => {
    const challengeDir = join(aiCtfRepo, 'packages', 'nextjs', 'data', 'challenges');
    writeFileSync(join(challengeDir, '1.md'), '# #1: First\n\nBody one.\n');
    writeFileSync(join(challengeDir, '2.md'), '# #2: Second\n\nBody two.\n');

    assembleChallengePack({ aiCtfRepo, outDir });

    const briefing = readFileSync(join(outDir, 'BRIEFING.md'), 'utf8');
    expect(briefing).toContain(
      '## Challenges\n\n---\n\n# #1: First\n\nBody one.\n\n---\n\n# #2: Second\n\nBody two.\n',
    );
  });

  it('keeps the separator off the last line when a challenge file has no trailing newline', () => {
    const challengeDir = join(aiCtfRepo, 'packages', 'nextjs', 'data', 'challenges');
    writeFileSync(join(challengeDir, '1.md'), '# #1: First\n\nNo trailing newline.');
    writeFileSync(join(challengeDir, '2.md'), '# #2: Second\n\nBody two.\n');

    assembleChallengePack({ aiCtfRepo, outDir });

    const briefing = readFileSync(join(outDir, 'BRIEFING.md'), 'utf8');
    expect(briefing).toContain('No trailing newline.\n\n---\n\n# #2: Second');
    expect(briefing).not.toContain('No trailing newline.\n---');
  });

  it('skips the solcInputs directory when reading deployments', () => {
    const pack = assembleChallengePack({ aiCtfRepo, outDir });

    expect(Object.keys(pack.addresses)).not.toContain('solcInputs');
    expect(Object.keys(pack.addresses)).not.toContain('fixture-input');
  });

  it('returns an absolute directory for a relative outDir', () => {
    const pack = assembleChallengePack({ aiCtfRepo, outDir: join(tempDir, '.', 'relative-pack') });

    expect(isAbsolute(pack.dir)).toBe(true);
  });

  it('copies Solidity contracts and the deploy script verbatim', () => {
    assembleChallengePack({ aiCtfRepo, outDir });

    const sourceContracts = join(aiCtfRepo, 'packages', 'hardhat', 'contracts');
    const outputContracts = join(outDir, 'contracts');
    expect(readdirSync(outputContracts).sort()).toEqual(readdirSync(sourceContracts).sort());
    for (const file of readdirSync(sourceContracts)) {
      expect(readFileSync(join(outputContracts, file), 'utf8'))
        .toBe(readFileSync(join(sourceContracts, file), 'utf8'));
    }

    const deployFile = join('deploy', '00_deploy_ctf_contracts.ts');
    expect(readFileSync(join(outDir, deployFile), 'utf8'))
      .toBe(readFileSync(join(aiCtfRepo, 'packages', 'hardhat', deployFile), 'utf8'));
  });

  it('names a missing challenge markdown path', () => {
    const challengePath = join(aiCtfRepo, 'packages', 'nextjs', 'data', 'challenges', '7.md');
    rmSync(challengePath);

    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow(challengePath);
  });

  it('names the deployment path for an invalid address', () => {
    const deploymentPath = join(
      aiCtfRepo,
      'packages',
      'hardhat',
      'deployments',
      'localhost',
      'Challenge2.json',
    );
    writeFileSync(deploymentPath, JSON.stringify({ address: 'invalid' }));

    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow(deploymentPath);
  });

  it('replaces an existing output directory without stale files', () => {
    assembleChallengePack({ aiCtfRepo, outDir });
    const stalePath = join(outDir, 'stale.txt');
    writeFileSync(stalePath, 'stale');

    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).not.toThrow();
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(outDir, 'BRIEFING.md'))).toBe(true);
  });

  it('refuses an outDir that would delete the ai-ctf checkout', () => {
    const contractsDir = join(aiCtfRepo, 'packages', 'hardhat', 'contracts');

    expect(() => assembleChallengePack({ aiCtfRepo, outDir: aiCtfRepo })).toThrow(/overlaps/);
    expect(() => assembleChallengePack({ aiCtfRepo, outDir: join(aiCtfRepo, 'pack') }))
      .toThrow(/overlaps/);
    expect(() => assembleChallengePack({ aiCtfRepo, outDir: tempDir })).toThrow(/overlaps/);
    expect(existsSync(contractsDir)).toBe(true);
  });

  it('accepts a sibling directory whose path merely starts with the repo path', () => {
    expect(() => assembleChallengePack({ aiCtfRepo, outDir: `${aiCtfRepo}-backup` }))
      .not.toThrow();
  });

  it('refuses an empty outDir', () => {
    expect(() => assembleChallengePack({ aiCtfRepo, outDir: '' })).toThrow(/must not be empty/);
  });

  it('refuses a deployments network that escapes the repo', () => {
    for (const deploymentsNetwork of ['../../../etc', 'local/host', '', '..']) {
      expect(() => assembleChallengePack({ aiCtfRepo, outDir, deploymentsNetwork }))
        .toThrow(/Invalid deployments network/);
    }
  });

  it('names every missing challenge deployment', () => {
    rmSync(join(aiCtfRepo, 'packages', 'hardhat', 'deployments', 'localhost', 'Challenge7.json'));

    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow(/Challenge7/);
  });

  it('leaves a previously built pack intact when assembly fails partway', () => {
    assembleChallengePack({ aiCtfRepo, outDir });
    const before = readdirSync(outDir).sort();
    const briefingBefore = readFileSync(join(outDir, 'BRIEFING.md'), 'utf8');

    // Unreadable source: the copy loop throws after staging has started.
    const contractPath = join(aiCtfRepo, 'packages', 'hardhat', 'contracts', 'NFTFlags.sol');
    chmodSync(contractPath, 0o000);
    try {
      expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow();
    } finally {
      chmodSync(contractPath, 0o644);
    }

    expect(readdirSync(outDir).sort()).toEqual(before);
    expect(readFileSync(join(outDir, 'BRIEFING.md'), 'utf8')).toBe(briefingBefore);
    expect(readdirSync(tempDir).filter((name) => name.includes('.incoming-'))).toEqual([]);
  });
});
