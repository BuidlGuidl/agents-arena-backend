import { describe, expect, it } from 'vitest';

import {
  injectedProvider,
  isWaitingRoomState,
  looksLikeSignature,
  requestSeedSignature,
  seedErrorMessage,
  seedMessage,
  walletErrorMessage,
  type Eip1193Provider,
} from './waiting-room';

const SIGNATURE = `0x${'ab'.repeat(65)}`;

// Records every RPC the component makes, so the test can assert the order the
// wallet is driven in as well as the result.
function fakeWallet(overrides: Partial<Record<string, unknown>> = {}): {
  provider: Eip1193Provider;
  calls: { method: string; params?: unknown[] }[];
} {
  const calls: { method: string; params?: unknown[] }[] = [];
  const answers: Record<string, unknown> = {
    eth_requestAccounts: ['0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    personal_sign: SIGNATURE,
    ...overrides,
  };
  return {
    calls,
    provider: {
      async request(args) {
        calls.push(args);
        const answer = answers[args.method];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

describe('seedMessage', () => {
  it('matches the backend message byte for byte, one literal newline', () => {
    expect(seedMessage('run-1')).toBe('agents-arena seed v1\nrun: run-1');
    expect(seedMessage('run-1').split('\n')).toHaveLength(2);
  });

  it('varies per run, because every run needs virgin wallets', () => {
    expect(seedMessage('run-1')).not.toBe(seedMessage('run-2'));
  });
});

describe('isWaitingRoomState', () => {
  it('covers both human-gated states', () => {
    expect(isWaitingRoomState('awaiting_signature')).toBe(true);
    expect(isWaitingRoomState('awaiting_funding')).toBe(true);
  });

  it('leaves every other state to the scoreboard', () => {
    for (const state of ['created', 'preparing', 'ready', 'running', 'finished', 'failed'] as const) {
      expect(isWaitingRoomState(state)).toBe(false);
    }
    expect(isWaitingRoomState(undefined)).toBe(false);
  });
});

describe('looksLikeSignature', () => {
  it('accepts a 65-byte hex signature and tolerates surrounding whitespace', () => {
    expect(looksLikeSignature(SIGNATURE)).toBe(true);
    expect(looksLikeSignature(`  ${SIGNATURE}\n`)).toBe(true);
  });

  it('rejects anything the backend schema would reject', () => {
    expect(looksLikeSignature('')).toBe(false);
    expect(looksLikeSignature('0xabc')).toBe(false);
    expect(looksLikeSignature('ab'.repeat(65))).toBe(false); // no 0x
    expect(looksLikeSignature(`${SIGNATURE}ff`)).toBe(false);
  });
});

describe('seedErrorMessage', () => {
  it('explains a rejected signature without naming the expected wallet', () => {
    const line = seedErrorMessage(403);
    expect(line).toContain('rejected');
    expect(line).not.toContain('0x');
  });

  it('explains a wrong-state run', () => {
    expect(seedErrorMessage(409)).toContain('no longer waiting');
  });

  it('names the status for anything unmapped', () => {
    expect(seedErrorMessage(500)).toContain('500');
  });
});

describe('requestSeedSignature', () => {
  it('asks for an account before signing, and signs message-then-signer', async () => {
    const { provider, calls } = fakeWallet();
    const signature = await requestSeedSignature(provider, seedMessage('run-1'));
    expect(signature).toBe(SIGNATURE);
    expect(calls.map((call) => call.method)).toEqual(['eth_requestAccounts', 'personal_sign']);
    expect(calls[1]!.params).toEqual([
      'agents-arena seed v1\nrun: run-1',
      '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    ]);
  });

  it('throws when the wallet unlocks no account', async () => {
    const { provider } = fakeWallet({ eth_requestAccounts: [] });
    await expect(requestSeedSignature(provider, 'msg')).rejects.toThrow('no account');
  });

  it('surfaces the wallet error rather than posting nothing', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const { provider, calls } = fakeWallet({ personal_sign: rejection });
    await expect(requestSeedSignature(provider, 'msg')).rejects.toThrow('User rejected');
    expect(calls.map((call) => call.method)).toEqual(['eth_requestAccounts', 'personal_sign']);
  });
});

describe('walletErrorMessage', () => {
  it('reads a 4001 as a dismissal, not a failure', () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    expect(walletErrorMessage(rejection)).toBe('wallet request rejected.');
  });

  it('passes any other error message through', () => {
    expect(walletErrorMessage(new Error('rpc down'))).toBe('rpc down');
    expect(walletErrorMessage('weird')).toContain('failed');
  });
});

describe('injectedProvider', () => {
  it('returns undefined with no browser window, so the paste path shows', () => {
    expect(injectedProvider()).toBeUndefined();
  });
});
