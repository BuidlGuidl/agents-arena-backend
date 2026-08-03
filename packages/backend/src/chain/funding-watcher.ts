import { createPublicClient, http, type Address } from 'viem';

import type { EventJournal } from '../journal.js';
import type { ChainProfile } from './profile.js';

export interface FundingEntry {
  entrantId: string;
  address: Address;
}

export interface AwaitFundingOptions {
  profile: ChainProfile;
  entries: readonly FundingEntry[];
  thresholdWei: bigint;
  journal: EventJournal;
  runId: string;
  pollMs?: number;
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('Funding watch aborted', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function balancesAtConfirmedBlock(
  profile: ChainProfile,
  entries: readonly FundingEntry[],
): Promise<readonly bigint[] | null> {
  const client = createPublicClient({
    transport: http(profile.rpcUrl, { batch: { batchSize: 10 } }),
  });
  const head = await client.getBlockNumber();
  const depth = BigInt(profile.confirmations);
  if (head < depth) {
    return null;
  }
  const blockNumber = head - depth;
  return Promise.all(entries.map(({ address }) => client.getBalance({ address, blockNumber })));
}

export async function checkFunded(
  profile: ChainProfile,
  entries: readonly FundingEntry[],
  thresholdWei: bigint,
): Promise<boolean> {
  if (entries.length === 0) {
    return true;
  }
  const balances = await balancesAtConfirmedBlock(profile, entries);
  return balances !== null && balances.every((balance) => balance >= thresholdWei);
}

export async function awaitFunding({
  profile,
  entries,
  thresholdWei,
  journal,
  runId,
  pollMs = 500,
  signal,
}: AwaitFundingOptions): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const client = createPublicClient({
    transport: http(profile.rpcUrl, { batch: { batchSize: 10 } }),
  });
  const observed = new Map<string, bigint>();

  while (true) {
    if (signal?.aborted) {
      throw abortError();
    }

    const head = await client.getBlockNumber();
    const depth = BigInt(profile.confirmations);
    if (head >= depth) {
      const blockNumber = head - depth;
      const balances = await Promise.all(
        entries.map(({ address }) => client.getBalance({ address, blockNumber })),
      );

      entries.forEach((entry, index) => {
        const balance = balances[index];
        if (balance === undefined) {
          return;
        }
        const key = `${entry.entrantId}:${entry.address.toLowerCase()}`;
        if (observed.get(key) !== balance) {
          observed.set(key, balance);
          journal.append(runId, entry.entrantId, 'funding.balance', {
            entrantId: entry.entrantId,
            address: entry.address,
            wei: balance.toString(),
            funded: balance >= thresholdWei,
          });
        }
      });

      if (balances.every((balance) => balance >= thresholdWei)) {
        return;
      }
    }

    await delay(Math.max(0, pollMs), signal);
  }
}
