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

import type { EntrantRecord, RunRecord } from '../adapters/types.js';
import type { EventJournal } from '../journal.js';
import type { FundingGate } from '../run-manager.js';
import { awaitFunding, type FundingEntry } from './funding-watcher.js';
import { LOCAL_DEV_FUNDER_PRIVATE_KEY } from './local-dev.js';
import { activeChainProfile, getChainProfile, type ChainProfile } from './profile.js';

const FUNDING_AMOUNT_WEI = parseEther('0.1');

export function createFundingGate(
  journal: EventJournal,
  profileName?: string,
): FundingGate {
  return async (run, runEntrants, signal) => {
    if (run.preset !== 'docker-duel') {
      return;
    }

    const profile = profileName === undefined ? activeChainProfile : getChainProfile(profileName);
    await awaitFunding({
      profile,
      entries: fundingEntries(runEntrants),
      thresholdWei: profile.fundingThresholdWei,
      journal,
      runId: run.id,
      pollMs: 500,
      ...(signal === undefined ? {} : { signal }),
    });
  };
}

export async function runLocalDevFaucet(
  run: RunRecord,
  runEntrants: readonly EntrantRecord[],
  signal?: AbortSignal,
  profile: ChainProfile = activeChainProfile,
): Promise<void> {
  if (run.preset !== 'docker-duel') {
    return;
  }
  if (profile.name !== 'local' || profile.chainId !== 31337) {
    return;
  }
  await fundLocalEntrants(profile, fundingEntries(runEntrants), signal);
}

function fundingEntries(runEntrants: readonly EntrantRecord[]): FundingEntry[] {
  return runEntrants.map<FundingEntry>((entrant) => {
    if (entrant.address === null) {
      throw new Error(`Entrant ${entrant.id} has no wallet address`);
    }
    return { entrantId: entrant.id, address: getAddress(entrant.address) };
  });
}

async function fundLocalEntrants(
  profile: ChainProfile,
  entries: readonly FundingEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (profile.name !== 'local' || profile.chainId !== 31337) {
    return;
  }
  if (signal?.aborted) {
    throw abortError(signal);
  }

  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(
      (process.env.ARENA_FUNDER_KEY ?? LOCAL_DEV_FUNDER_PRIVATE_KEY) as Hex,
    );
  } catch {
    throw new Error('ARENA_FUNDER_KEY is invalid');
  }
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
    if (balance >= profile.fundingThresholdWei) {
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
  // balance at head - confirmations. Mine enough blocks for that read to see the funds.
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
