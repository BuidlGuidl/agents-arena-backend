import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSignature, serializeSignature, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureChainTables } from '../../src/chain/storage.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from '../../src/chain/local-dev.js';
import {
  deriveEntrantKeys,
  dropRunKeys,
  getWallet,
  seedMessage,
} from '../../src/chain/wallet.js';
import { openArenaDatabase } from '../../src/db/index.js';

const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
const runIds = ['1', 'run-1', 'run-2'];
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KNOWN_SIGNATURE =
  '0xa5a56be28f9d244409d14a074112c46591dca81bdb85140892f6ae83cb1f99e67c8842e3f4be2e4a31f416521e7b418a95d2c06f4cfd33d4e3d94f9d39949c221b';

afterEach(() => {
  for (const runId of runIds) dropRunKeys(runId);
});

describe('derived entrant wallets', () => {
  it('builds the pinned seed message with a literal newline', () => {
    expect(seedMessage('run-1')).toBe('agents-arena seed v1\nrun: run-1');
  });

  it('matches the independently verified run 1 signature and burner vectors', async () => {
    const message = seedMessage('1');
    const signature = await account.signMessage({ message });

    expect(message).toBe('agents-arena seed v1\nrun: 1');
    expect(signature).toBe(KNOWN_SIGNATURE);

    const addresses = deriveEntrantKeys('1', signature, ['codex-1', 'opencode-1']);
    expect(getWallet('1', 'codex-1')).toEqual({
      runId: '1',
      entrantId: 'codex-1',
      privateKey: '0x9e30862148d3d08073d0f4fcb2879ae6b77a44775914d26c55736097dd355a49',
      address: '0x3189838a5dD1dAE2dbAE85cd945e558c98F6Ef3F',
    });
    expect(getWallet('1', 'opencode-1')).toEqual({
      runId: '1',
      entrantId: 'opencode-1',
      privateKey: '0xf081f77901235ae551738e804e72b43e6e97a07a155b85563eece8a26f108b01',
      address: '0x62F16E026500757A6F4dDF42acdD94AbDfF1ad0C',
    });
    expect([...addresses.values()]).toEqual([
      '0x3189838a5dD1dAE2dbAE85cd945e558c98F6Ef3F',
      '0x62F16E026500757A6F4dDF42acdD94AbDfF1ad0C',
    ]);
  });

  it('derives the same wallet again from the same signature and entrant id', async () => {
    const signature = await account.signMessage({ message: seedMessage('run-1') });
    deriveEntrantKeys('run-1', signature, ['e1']);
    const first = getWallet('run-1', 'e1');

    dropRunKeys('run-1');
    deriveEntrantKeys('run-1', signature, ['e1']);

    expect(getWallet('run-1', 'e1')).toEqual(first);
  });

  it('canonicalizes parity-encoded signatures before deriving keys', async () => {
    const canonical = await account.signMessage({ message: seedMessage('run-1') });
    const parityEncoded = `${canonical.slice(0, -2)}0${parseSignature(canonical).yParity}` as Hex;

    const expected = deriveEntrantKeys('run-1', canonical, ['e1']);
    dropRunKeys('run-1');

    expect(deriveEntrantKeys('run-1', parityEncoded, ['e1'])).toEqual(expected);
  });

  it('rejects high-s signatures before deriving keys', async () => {
    const signature = await account.signMessage({ message: seedMessage('run-1') });

    expect(() => deriveEntrantKeys('run-1', highSSignature(signature), ['e1']))
      .toThrow('Seed signature has a high s value');
    expect(getWallet('run-1', 'e1')).toBeNull();
  });

  it('derives distinct wallets for entrant ids and run messages', async () => {
    const firstSignature = await account.signMessage({ message: seedMessage('run-1') });
    const secondSignature = await account.signMessage({ message: seedMessage('run-2') });
    deriveEntrantKeys('run-1', firstSignature, ['e1', 'e2']);
    deriveEntrantKeys('run-2', secondSignature, ['e1']);

    const wallets = [
      getWallet('run-1', 'e1'),
      getWallet('run-1', 'e2'),
      getWallet('run-2', 'e1'),
    ];
    expect(new Set(wallets.map((wallet) => wallet?.address)).size).toBe(3);
    expect(new Set(wallets.map((wallet) => wallet?.privateKey)).size).toBe(3);
  });

  it('drops every key for one run', async () => {
    const signature = await account.signMessage({ message: seedMessage('run-1') });
    deriveEntrantKeys('run-1', signature, ['e1', 'e2']);

    dropRunKeys('run-1');

    expect(getWallet('run-1', 'e1')).toBeNull();
    expect(getWallet('run-1', 'e2')).toBeNull();
  });
});

describe('legacy wallet migration', () => {
  it('removes legacy plaintext key bytes from the database file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-wallet-migration-'));
    const databasePath = join(directory, 'arena.db');
    const fakeKeyHex = '0123456789abcdef'.repeat(8);
    const opened = openArenaDatabase(databasePath);
    try {
      opened.sqlite.pragma('secure_delete = OFF');
      opened.sqlite.exec(`
        CREATE TABLE wallets (
          run_id TEXT NOT NULL,
          entrant_id TEXT NOT NULL,
          address TEXT NOT NULL,
          private_key TEXT NOT NULL
        );
      `);
      opened.sqlite.prepare('INSERT INTO wallets VALUES (?, ?, ?, ?)')
        .run('run-1', 'e1', '0x1', fakeKeyHex);
      opened.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      expect(readFileSync(databasePath).includes(Buffer.from(fakeKeyHex))).toBe(true);

      ensureChainTables(opened.database);

      const table = opened.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallets'")
        .get();
      expect(table).toBeUndefined();
      expect(readFileSync(databasePath).includes(Buffer.from(fakeKeyHex))).toBe(false);
      expect(opened.sqlite.pragma('secure_delete', { simple: true })).toBe(0);
    } finally {
      opened.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function highSSignature(signature: Hex): Hex {
  const parsed = parseSignature(signature);
  return serializeSignature({
    r: parsed.r,
    s: toHex(SECP256K1_N - BigInt(parsed.s), { size: 32 }),
    yParity: parsed.yParity === 0 ? 1 : 0,
  });
}
