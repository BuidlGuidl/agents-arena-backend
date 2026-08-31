import {
  createPublicClient,
  createWalletClient,
  defineChain,
  extractChain,
  http,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as allChains from 'viem/chains';
import { publicActionsL2 } from 'viem/op-stack';

import type { ChainProfile } from './profile.js';

export interface NativeSweepChain {
  getBalance(address: Address): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  estimateGas(from: Address, to: Address): Promise<bigint>;
  estimateL1Fee(from: Address, to: Address): Promise<bigint>;
  sendTransaction(input: {
    privateKey: Hex;
    to: Address;
    value: bigint;
    gas: bigint;
    gasPrice: bigint;
  }): Promise<Hex>;
}

export function createNativeSweepChain(profile: ChainProfile): NativeSweepChain {
  let registryChain: Chain | undefined;
  try {
    registryChain = extractChain({
      chains: Object.values(allChains) as Chain[],
      id: profile.chainId,
    });
  } catch {
    registryChain = undefined;
  }
  // A chain missing from viem's registry deliberately has no L1 data fee.
  const chain = registryChain ?? defineChain({
    id: profile.chainId,
    name: profile.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [profile.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(profile.rpcUrl) })
    .extend(publicActionsL2());

  return {
    getBalance: (address) => publicClient.getBalance({ address }),
    getGasPrice: () => publicClient.getGasPrice(),
    estimateGas: (from, to) => publicClient.estimateGas({ account: from, to, value: 0n }),
    estimateL1Fee: registryChain?.contracts?.gasPriceOracle !== undefined
      ? (from, to) => publicClient.estimateL1Fee({
        account: from,
        to,
        value: 0n,
      })
      : async () => 0n,
    async sendTransaction(input) {
      const account = privateKeyToAccount(input.privateKey);
      const walletClient = createWalletClient({ account, chain, transport: http(profile.rpcUrl) });
      return walletClient.sendTransaction({
        account,
        chain,
        to: input.to,
        value: input.value,
        gas: input.gas,
        gasPrice: input.gasPrice,
      });
    },
  };
}
