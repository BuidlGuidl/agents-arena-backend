import type { RunState } from '../../../contract/arena-types';

// The backend does not expose its active chain yet, so this local mock stays
// pinned to Anvil until RunSnapshot carries the profile chain ID.
export const SEED_CHAIN_ID = 31337;

export function seedTypedData(runId: string, chainId: number) {
  return {
    domain: {
      name: 'agents-arena',
      version: '1',
      chainId,
    },
    types: {
      Seed: [
        { name: 'runId', type: 'string' },
      ],
    },
    primaryType: 'Seed',
    message: { runId },
  } as const;
}

// The two human-gated states the waiting room covers.
export function isWaitingRoomState(state: RunState | undefined): boolean {
  return state === 'awaiting_signature' || state === 'awaiting_funding';
}

// Same shape the backend's zod schema accepts: 0x plus 65 bytes. Checking it
// before posting keeps a typo in the paste box out of the network.
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export function looksLikeSignature(text: string): boolean {
  return SIGNATURE_PATTERN.test(text.trim());
}

// The backend never reveals which wallet it expects, so a rejection cannot name
// one either.
export function seedErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'the backend could not read that signature, or its encoding is not canonical (expects 0x + 130 hex chars, low-s, v 27/28).';
    case 403:
      return 'signature rejected — it did not come from the wallet this profile funds with.';
    case 409:
      return 'this run is no longer waiting for a signature.';
    case 404:
      return 'run not found.';
    default:
      return `seed request failed with status ${status}.`;
  }
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function injectedProvider(): Eip1193Provider | undefined {
  return typeof window === 'undefined' ? undefined : window.ethereum;
}

export async function requestSeedSignature(
  provider: Eip1193Provider,
  typedData: ReturnType<typeof seedTypedData>,
): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== 'string') {
    throw new Error('the wallet returned no account.');
  }
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string') {
    throw new Error('the wallet returned no signature.');
  }
  return signature;
}

// EIP-1193 reports a user-dismissed prompt as code 4001, which is not a failure
// worth showing as one.
export function walletErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 4001) {
    return 'wallet request rejected.';
  }
  return error instanceof Error ? error.message : 'the wallet request failed.';
}
