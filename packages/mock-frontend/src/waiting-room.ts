import type { RunState } from '../../../contract/arena-types';

// The seed flow, minus the rendering. The arena stores no private keys: the
// funder signs one message per run and the backend derives every burner wallet
// from that signature, so this module is the client half of ADR-0011/0012.

// Byte-for-byte the string `seedMessage` builds in
// packages/backend/src/chain/wallet.ts, one literal newline included. A message
// that differs anywhere recovers a different address and the seed is rejected.
export function seedMessage(runId: string): string {
  return `agents-arena seed v1\nrun: ${runId}`;
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
      return 'that is not a signature the backend can read (expects 0x + 130 hex chars).';
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

// Ask the injected wallet for an account, then for an EIP-191 signature over the
// seed message. `personal_sign` takes the message first and the signer second.
export async function requestSeedSignature(
  provider: Eip1193Provider,
  message: string,
): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== 'string') {
    throw new Error('the wallet returned no account.');
  }
  const signature = await provider.request({ method: 'personal_sign', params: [message, account] });
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
