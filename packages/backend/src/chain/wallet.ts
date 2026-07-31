import {
  concat,
  hexToBytes,
  keccak256,
  parseSignature,
  serializeSignature,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface WalletRecord {
  runId: string;
  entrantId: string;
  address: Address;
  privateKey: Hex;
}

const runKeys = new Map<string, Map<string, WalletRecord>>();
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function seedMessage(runId: string): string {
  return `agents-arena seed v1\nrun: ${runId}`;
}

export function canonicalizeSeedSignature(signature: Hex): Hex {
  const parsed = parseSignature(signature);
  if (BigInt(parsed.s) > SECP256K1_N / 2n) {
    throw new Error('Seed signature has a high s value');
  }
  return serializeSignature({
    r: parsed.r,
    s: parsed.s,
    v: BigInt(27 + parsed.yParity),
  });
}

export function deriveEntrantKeys(
  runId: string,
  signature: Hex,
  entrantIds: readonly string[],
): ReadonlyMap<string, Address> {
  const canonicalSignature = canonicalizeSeedSignature(signature);
  const entrantKeys = new Map<string, WalletRecord>();

  for (const entrantId of entrantIds) {
    // Offline recovery hashes the canonical low-s, v 27/28 signature bytes
    // with the UTF-8 entrant ID.
    const privateKey = keccak256(concat([
      hexToBytes(canonicalSignature),
      stringToBytes(entrantId),
    ]));
    // Noble includes an out-of-range key's decimal value in its error, so callers must never log it.
    const address = privateKeyToAccount(privateKey).address;
    entrantKeys.set(entrantId, { runId, entrantId, address, privateKey });
  }

  runKeys.set(runId, entrantKeys);
  return new Map([...entrantKeys].map(([entrantId, wallet]) => [entrantId, wallet.address]));
}

export function getWallet(runId: string, entrantId: string): WalletRecord | null {
  return runKeys.get(runId)?.get(entrantId) ?? null;
}

export function runKeySecrets(runId: string): readonly string[] {
  const keys = runKeys.get(runId);
  if (keys === undefined) return [];
  return [...keys.values()].map((wallet) => wallet.privateKey);
}

export function dropRunKeys(runId: string): void {
  runKeys.delete(runId);
}
