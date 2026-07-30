import { readFileSync } from 'node:fs';

import { getAddress, isAddress, type Address } from 'viem';

export interface ChainProfile {
  name: string;
  rpcUrl: string;
  containerRpcUrl: string;
  chainId: number;
  confirmations: number;
  nftFlags: Address;
  challenge1: Address;
  identityRegistry: Address;
  // Set when the chain has a public briefing the entrant can fetch. Absent means
  // the arena mounts a challenge pack instead (ADR-0009).
  briefingUrl?: string;
}

interface RawChainProfile extends Omit<ChainProfile, 'nftFlags' | 'challenge1' | 'identityRegistry'> {
  nftFlags: string;
  challenge1: string;
  identityRegistry: string;
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
  // Presence of briefingUrl selects a prompt variant, so an empty one would send
  // the entrant to fetch nothing rather than fall back to the pack.
  if (value.briefingUrl !== undefined && value.briefingUrl.trim() === '') {
    throw new Error(`Empty briefingUrl for profile ${name}; remove the key to use a challenge pack`);
  }

  return {
    name,
    rpcUrl: value.rpcUrl,
    containerRpcUrl: value.containerRpcUrl,
    chainId: value.chainId,
    confirmations: value.confirmations,
    nftFlags: parseAddress(value.nftFlags, `${name}.nftFlags`),
    challenge1: parseAddress(value.challenge1, `${name}.challenge1`),
    identityRegistry: parseAddress(value.identityRegistry, `${name}.identityRegistry`),
    ...(value.briefingUrl === undefined ? {} : { briefingUrl: value.briefingUrl }),
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

// One process serves one chain, so the environment is read once here rather than
// at each of the prompt builder, funding gate, container driver, and solve poller.
export const activeChainProfile: ChainProfile = getChainProfile(
  process.env.ARENA_CHAIN_PROFILE ?? 'local',
);
