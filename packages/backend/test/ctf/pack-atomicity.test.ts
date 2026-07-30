import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Injected at copyFileSync rather than through file permissions: chmod 000 does
// not stop root, and every filesystem trick (directory, symlink, fifo) is
// skipped by the entry.isFile() filter before the copy is reached.
let failNextCopy = false;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: (source: string, destination: string) => {
      if (failNextCopy && source.endsWith('.sol')) {
        failNextCopy = false;
        throw new Error('EACCES: simulated copy failure');
      }
      return actual.copyFileSync(source, destination);
    },
  };
});

const { assembleChallengePack } = await import('../../src/ctf/pack.js');

const fixtureDir = fileURLToPath(new URL('./fixture', import.meta.url));

describe('assembleChallengePack atomicity', () => {
  let tempDir: string;
  let aiCtfRepo: string;
  let outDir: string;

  beforeEach(() => {
    failNextCopy = false;
    tempDir = mkdtempSync(join(tmpdir(), 'challenge-pack-atomic-'));
    aiCtfRepo = join(tempDir, 'ai-ctf');
    outDir = join(tempDir, 'pack');
    cpSync(fixtureDir, aiCtfRepo, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves a previously built pack intact when a copy fails partway', () => {
    assembleChallengePack({ aiCtfRepo, outDir });
    const before = readdirSync(outDir).sort();
    const briefingBefore = readFileSync(join(outDir, 'BRIEFING.md'), 'utf8');

    failNextCopy = true;
    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow(/simulated copy failure/);

    expect(readdirSync(outDir).sort()).toEqual(before);
    expect(readFileSync(join(outDir, 'BRIEFING.md'), 'utf8')).toBe(briefingBefore);
  });

  it('removes the staging directory when assembly fails', () => {
    failNextCopy = true;
    expect(() => assembleChallengePack({ aiCtfRepo, outDir })).toThrow();

    expect(readdirSync(tempDir).filter((name) => name.includes('.incoming-'))).toEqual([]);
  });
});
