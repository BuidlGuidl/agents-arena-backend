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
  seedTypedData,
} from '../../src/chain/wallet.js';
import { openArenaDatabase } from '../../src/db/index.js';

const account = privateKeyToAccount(LOCAL_DEV_FUNDER_PRIVATE_KEY);
const runIds = ['1', 'run-1', 'run-2'];
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KNOWN_SIGNATURE =
  '0x9e1dce6fe4da1ae1bbaa92eb2a158f2d71a183351c5ff203a2e4fc6a127f2e272ce63b02c9a17c02f2d8ee57a46d21492abbc35cfd9fbf2540bf298c83be644d1b';

afterEach(() => {
  for (const runId of runIds) dropRunKeys(runId);
});

describe('derived entrant wallets', () => {
  it('builds the pinned seed typed data', () => {
    expect(JSON.stringify(seedTypedData('run-1', 31337))).toBe(
      '{"domain":{"name":"agents-arena","version":"1","chainId":31337},'
      + '"types":{"Seed":[{"name":"runId","type":"string"}]},'
      + '"primaryType":"Seed","message":{"runId":"run-1"}}',
    );
  });

  it('matches the independently verified run 1 signature and burner vectors', async () => {
    const signature = await account.signTypedData(seedTypedData('1', 31337));
    expect(signature).toBe(KNOWN_SIGNATURE);

    const addresses = deriveEntrantKeys('1', KNOWN_SIGNATURE, ['codex-1', 'opencode-1']);
    expect(getWallet('1', 'codex-1')).toEqual({
      runId: '1',
      entrantId: 'codex-1',
      privateKey: '0x4d44297d498894431b90b3be967a19b0233bab737ddf056b643262519fa527ff',
      address: '0x4ee3BE13180D87C59dC5ae8EE7E631923ffFE254',
    });
    expect(getWallet('1', 'opencode-1')).toEqual({
      runId: '1',
      entrantId: 'opencode-1',
      privateKey: '0x919f4b9a269a75b2add473c35c2b2024daa189a41632282ac682ec2a3e88ecba',
      address: '0xd790a2797650D602F49f56C438ac89dDCF0F109F',
    });
    expect([...addresses.values()]).toEqual([
      '0x4ee3BE13180D87C59dC5ae8EE7E631923ffFE254',
      '0xd790a2797650D602F49f56C438ac89dDCF0F109F',
    ]);
  });

  it('derives the same wallet again from the same signature and entrant id', async () => {
    const signature = await account.signTypedData(seedTypedData('run-1', 31337));
    deriveEntrantKeys('run-1', signature, ['e1']);
    const first = getWallet('run-1', 'e1');

    dropRunKeys('run-1');
    deriveEntrantKeys('run-1', signature, ['e1']);

    expect(getWallet('run-1', 'e1')).toEqual(first);
  });

  it('canonicalizes parity-encoded signatures before deriving keys', async () => {
    const canonical = await account.signTypedData(seedTypedData('run-1', 31337));
    const parityEncoded = `${canonical.slice(0, -2)}0${parseSignature(canonical).yParity}` as Hex;

    const expected = deriveEntrantKeys('run-1', canonical, ['e1']);
    dropRunKeys('run-1');

    expect(deriveEntrantKeys('run-1', parityEncoded, ['e1'])).toEqual(expected);
  });

  it('rejects high-s signatures before deriving keys', async () => {
    const signature = await account.signTypedData(seedTypedData('run-1', 31337));

    expect(() => deriveEntrantKeys('run-1', highSSignature(signature), ['e1']))
      .toThrow('Seed signature has a high s value');
    expect(getWallet('run-1', 'e1')).toBeNull();
  });

  it('derives distinct wallets for entrant ids and run messages', async () => {
    const firstSignature = await account.signTypedData(seedTypedData('run-1', 31337));
    const secondSignature = await account.signTypedData(seedTypedData('run-2', 31337));
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
    const signature = await account.signTypedData(seedTypedData('run-1', 31337));
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
