import { readFileSync } from 'node:fs';

import { getAddress, isAddress, parseEther, type Address } from 'viem';

export interface ChainProfile {
  name: string;
  rpcUrl: string;
  containerRpcUrl: string;
  chainId: number;
  confirmations: number;
  nftFlags: Address;
  challenge1: Address;
  identityRegistry: Address;
  fundingThresholdWei: bigint;
  fundingTimeoutMs?: number;
  challengeAddresses?: Readonly<Record<string, Address>>;
  // Set when the chain has a public briefing the entrant can fetch. Absent means
  // the arena mounts a challenge pack instead (ADR-0009).
  briefingUrl?: string;
}

interface RawChainProfile extends Omit<
  ChainProfile,
  'nftFlags' | 'challenge1' | 'identityRegistry' | 'fundingThresholdWei' | 'challengeAddresses'
> {
  nftFlags: string;
  challenge1: string;
  identityRegistry: string;
  fundingThresholdEth: string;
  challengeAddresses?: Readonly<Record<string, string>>;
}

const configUrl = new URL('../../config/chains.json', import.meta.url);

function parseAddress(value: string, field: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${field} address: ${value}`);
  }
  return getAddress(value);
}

function parseProfile(name: string, value: RawChainProfile): ChainProfile {
  if (value.name !== name) {
    throw new Error(`Chain profile key ${name} does not match its name ${value.name}`);
  }
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0) {
    throw new Error(`Invalid chain ID for profile ${name}`);
  }
  if (!Number.isSafeInteger(value.confirmations) || value.confirmations < 0) {
    throw new Error(`Invalid confirmation count for profile ${name}`);
  }
  if (
    value.fundingTimeoutMs !== undefined
    && (!Number.isSafeInteger(value.fundingTimeoutMs) || value.fundingTimeoutMs <= 0)
  ) {
    throw new Error(`Invalid funding timeout for profile ${name}`);
  }
  if (typeof value.fundingThresholdEth !== 'string' || value.fundingThresholdEth.trim() === '') {
    throw new Error(`Invalid funding threshold for profile ${name}`);
  }
  let fundingThresholdWei: bigint;
  try {
    fundingThresholdWei = parseEther(value.fundingThresholdEth);
  } catch {
    throw new Error(`Invalid funding threshold for profile ${name}`);
  }
  if (fundingThresholdWei <= 0n) {
    throw new Error(`Invalid funding threshold for profile ${name}`);
  }
  // Presence of briefingUrl selects a prompt variant, so an empty one would send
  // the entrant to fetch nothing rather than fall back to the pack.
  if (value.briefingUrl !== undefined && value.briefingUrl.trim() === '') {
    throw new Error(`Empty briefingUrl for profile ${name}; remove the key to use a challenge pack`);
  }

  const nftFlags = parseAddress(value.nftFlags, `${name}.nftFlags`);
  const challenge1 = parseAddress(value.challenge1, `${name}.challenge1`);
  const challengeAddresses = value.challengeAddresses === undefined
    ? undefined
    : Object.fromEntries(Object.entries(value.challengeAddresses).map(([contractName, address]) => [
      contractName,
      parseAddress(address, `${name}.challengeAddresses.${contractName}`),
    ]));
  if (challengeAddresses !== undefined) {
    const expected: ReadonlyArray<readonly [string, Address]> = [
      ['Challenge1', challenge1],
      ['NFTFlags', nftFlags],
    ];
    for (const [contractName, address] of expected) {
      const actual = challengeAddresses[contractName];
      if (actual !== address) {
        throw new Error(
          `Profile ${name} challengeAddresses.${contractName} is ${String(actual)}, but the profile expects ${address}`,
        );
      }
    }
  }

  return {
    name,
    rpcUrl: value.rpcUrl,
    containerRpcUrl: value.containerRpcUrl,
    chainId: value.chainId,
    confirmations: value.confirmations,
    nftFlags,
    challenge1,
    identityRegistry: parseAddress(value.identityRegistry, `${name}.identityRegistry`),
    fundingThresholdWei,
    ...(value.fundingTimeoutMs === undefined
      ? {}
      : { fundingTimeoutMs: value.fundingTimeoutMs }),
    ...(value.briefingUrl === undefined ? {} : { briefingUrl: value.briefingUrl }),
    ...(challengeAddresses === undefined ? {} : { challengeAddresses }),
  };
}

export function loadChainProfiles(): Readonly<Record<string, ChainProfile>> {
  const raw = JSON.parse(readFileSync(configUrl, 'utf8')) as Record<string, RawChainProfile>;
  return Object.fromEntries(
    Object.entries(raw).map(([name, profile]) => [name, parseProfile(name, profile)]),
  );
}

export const chainProfiles = loadChainProfiles();

export function getChainProfile(name: string): ChainProfile {
  const profile = chainProfiles[name];
  if (!profile) {
    throw new Error(`Unknown chain profile: ${name}`);
  }
  return profile;
}

// ARENA_RPC_URL replaces both endpoints so one variable keeps the backend
// clients, the entrant containers, and the prompt on the same URL. chains.json
// is committed, so a keyed provider URL can only live in the environment.
export function applyRpcOverride(profile: ChainProfile, override: string | undefined): ChainProfile {
  if (override === undefined || override.trim() === '') {
    return profile;
  }
  return { ...profile, rpcUrl: override, containerRpcUrl: override };
}

// One process serves one chain, so the environment is read once here rather than
// at each of the prompt builder, funding gate, container driver, and solve poller.
export const activeChainProfile: ChainProfile = applyRpcOverride(
  getChainProfile(process.env.ARENA_CHAIN_PROFILE ?? 'local'),
  process.env.ARENA_RPC_URL,
);
