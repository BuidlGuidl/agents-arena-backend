import { and, eq } from 'drizzle-orm';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { entrants } from '../db/schema.js';
import type { EventJournal } from '../journal.js';
import type { FundingGate, WalletGate } from '../run-manager.js';
import { awaitFunding, type FundingEntry } from './funding-watcher.js';
import { activeChainProfile, getChainProfile } from './profile.js';
import { createWallet, getWallet } from './wallet.js';

const FUNDING_THRESHOLD_WEI = parseEther('0.05');
const FUNDING_AMOUNT_WEI = parseEther('0.1');
const DEFAULT_LOCAL_FUNDER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export function createWalletGate(journal: EventJournal): WalletGate {
  return async (run, runEntrants) => {
    if (run.preset !== 'docker-duel') {
      return;
    }

    for (const entrant of runEntrants) {
      const existing = getWallet(run.id, entrant.id, journal.database);
      const address = existing?.address ?? createWallet(run.id, entrant.id, journal.database);
      journal.database
        .update(entrants)
        .set({ address })
        .where(and(eq(entrants.runId, run.id), eq(entrants.id, entrant.id)))
        .run();
      entrant.address = address;
      journal.append(run.id, entrant.id, 'wallet.assigned', {
        entrantId: entrant.id,
        address,
      });
    }
  };
}

export function createLocalFundingGate(
  journal: EventJournal,
  profileName?: string,
): FundingGate {
  return async (run, runEntrants, signal) => {
    if (run.preset !== 'docker-duel') {
      return;
    }

    const profile = profileName === undefined ? activeChainProfile : getChainProfile(profileName);
    const entries = runEntrants.map<FundingEntry>((entrant) => {
      if (entrant.address === null) {
        throw new Error(`Entrant ${entrant.id} has no wallet address`);
      }
      return { entrantId: entrant.id, address: getAddress(entrant.address) };
    });

    const watchOptions = {
      profile,
      entries,
      thresholdWei: FUNDING_THRESHOLD_WEI,
      journal,
      runId: run.id,
      pollMs: 500,
      ...(signal === undefined ? {} : { signal }),
    };
    const watch = awaitFunding(watchOptions);

    await Promise.all([
      watch,
      fundLocalEntrants(profile, entries, signal),
    ]);
  };
}

async function fundLocalEntrants(
  profile: ReturnType<typeof getChainProfile>,
  entries: readonly FundingEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (profile.name !== 'local' || profile.chainId !== 31337) {
    return;
  }
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const account = privateKeyToAccount(
    (process.env.ARENA_FUNDER_KEY ?? DEFAULT_LOCAL_FUNDER_KEY) as Hex,
  );
  const publicClient = createPublicClient({ transport: http(profile.rpcUrl) });
  const chain = {
    id: profile.chainId,
    name: profile.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [profile.rpcUrl] } },
  } as const;
  const walletClient = createWalletClient({
    account,
    transport: http(profile.rpcUrl),
    chain,
  });

  for (const entry of entries) {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const balance = await publicClient.getBalance({ address: entry.address });
    if (balance >= FUNDING_THRESHOLD_WEI) {
      continue;
    }
    const hash = await walletClient.sendTransaction({
      account,
      chain,
      to: entry.address as Address,
      value: FUNDING_AMOUNT_WEI,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // The local chain only mines when something transacts, and awaitFunding reads the
  // balance at head - confirmations. One block past the last transfer is enough for a
  // depth of 1 and nothing else, so a deeper local profile has to be mined up to.
  const mining = walletClient as unknown as LocalMiningClient;
  for (let block = 0; block < Math.max(1, profile.confirmations); block += 1) {
    await mining.request({ method: 'evm_mine', params: [] });
  }
}

interface LocalMiningClient {
  request(args: { method: 'evm_mine'; params: [] }): Promise<unknown>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Funding aborted');
}
