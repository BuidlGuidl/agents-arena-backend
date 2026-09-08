import { createPublicClient, http, type Address } from 'viem';

import { nftFlagsAbi } from './abi.js';
import { activeChainProfile } from './profile.js';
import { CHALLENGE_IDS } from './solve-poller.js';

export async function flagsHeld(address: Address): Promise<number> {
  const client = createPublicClient({ transport: http(activeChainProfile.rpcUrl, { batch: { batchSize: 10 } }) });
  const flags = await Promise.all(CHALLENGE_IDS.map((id) => client.readContract({
    address: activeChainProfile.nftFlags, abi: nftFlagsAbi,
    functionName: 'hasMinted', args: [address, BigInt(id)],
  })));
  return flags.filter(Boolean).length;
}
