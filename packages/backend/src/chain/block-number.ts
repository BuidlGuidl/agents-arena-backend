import { createPublicClient, http } from 'viem';

import { activeChainProfile } from './profile.js';

export async function currentBlockNumber(): Promise<bigint> {
  const client = createPublicClient({ transport: http(activeChainProfile.rpcUrl) });
  return client.getBlockNumber();
}
