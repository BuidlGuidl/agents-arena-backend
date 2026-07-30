import { concat, hexToBytes, keccak256, stringToBytes } from 'viem';
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
const runIds = ['run-1', 'run-2'];

afterEach(() => {
  for (const runId of runIds) dropRunKeys(runId);
});

describe('derived entrant wallets', () => {
  it('builds the pinned seed message with a literal newline', () => {
    expect(seedMessage('run-1')).toBe('agents-arena seed v1\nrun: run-1');
  });

  it('uses the pinned signature and entrant derivation', async () => {
    const signature = await account.signMessage({ message: seedMessage('run-1') });
    const addresses = deriveEntrantKeys('run-1', signature, ['e1']);
    const wallet = getWallet('run-1', 'e1');
    const expectedKey = keccak256(concat([
      hexToBytes(signature),
      stringToBytes('e1'),
    ]));

    expect(wallet?.privateKey).toBe(expectedKey);
    expect(wallet?.address).toBe(privateKeyToAccount(expectedKey).address);
    expect(addresses.get('e1')).toBe(wallet?.address);
  });

  it('derives the same wallet again from the same signature and entrant id', async () => {
    const signature = await account.signMessage({ message: seedMessage('run-1') });
    deriveEntrantKeys('run-1', signature, ['e1']);
    const first = getWallet('run-1', 'e1');

    dropRunKeys('run-1');
    deriveEntrantKeys('run-1', signature, ['e1']);

    expect(getWallet('run-1', 'e1')).toEqual(first);
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
  it('drops a wallets table that contains plaintext keys', () => {
    const opened = openArenaDatabase(':memory:');
    try {
      opened.sqlite.exec(`
        CREATE TABLE wallets (
          run_id TEXT NOT NULL,
          entrant_id TEXT NOT NULL,
          address TEXT NOT NULL,
          private_key TEXT NOT NULL
        );
        INSERT INTO wallets VALUES ('run-1', 'e1', '0x1', 'fake-key');
      `);

      ensureChainTables(opened.database);

      const table = opened.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallets'")
        .get();
      expect(table).toBeUndefined();
    } finally {
      opened.sqlite.close();
    }
  });
});
