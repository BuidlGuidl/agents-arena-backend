import { describe, expect, it } from 'vitest';

import { seedTypedData as backendSeedTypedData } from '../../backend/src/chain/wallet';
import {
  injectedProvider,
  isWaitingRoomState,
  looksLikeSignature,
  requestSeedSignature,
  seedErrorMessage,
  seedTypedData,
  walletErrorMessage,
  type Eip1193Provider,
} from './waiting-room';

const SIGNATURE = `0x${'ab'.repeat(65)}`;
const TEST_CHAIN_ID = 31337;

// Records every RPC the component makes, so the test can assert the order the
// wallet is driven in as well as the result.
function fakeWallet(overrides: Partial<Record<string, unknown>> = {}): {
  provider: Eip1193Provider;
  calls: { method: string; params?: unknown[] }[];
} {
  const calls: { method: string; params?: unknown[] }[] = [];
  const answers: Record<string, unknown> = {
    eth_requestAccounts: ['0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    eth_signTypedData_v4: SIGNATURE,
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

describe('seedTypedData', () => {
  it('matches the backend builder byte for byte as JSON', () => {
    expect(JSON.stringify(seedTypedData('run-1', TEST_CHAIN_ID)))
      .toBe(JSON.stringify(backendSeedTypedData('run-1', 31337)));
  });

  it('varies per run, because every run needs virgin wallets', () => {
    expect(JSON.stringify(seedTypedData('run-1', TEST_CHAIN_ID)))
      .not.toBe(JSON.stringify(seedTypedData('run-2', TEST_CHAIN_ID)));
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
  it('covers body-shape and canonical encoding failures', () => {
    const line = seedErrorMessage(400);
    expect(line).toContain('130 hex chars');
    expect(line).toContain('canonical');
  });

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
  it('sends the account first and exact typed-data JSON second for v4', async () => {
    const { provider, calls } = fakeWallet();
    const typedData = seedTypedData('1', TEST_CHAIN_ID);
    const signature = await requestSeedSignature(provider, typedData);
    expect(signature).toBe(SIGNATURE);
    expect(calls.map((call) => call.method))
      .toEqual(['eth_requestAccounts', 'eth_signTypedData_v4']);
    expect(calls[1]!.params).toEqual([
      '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      JSON.stringify(typedData),
    ]);
  });

  it('keeps the typed-data JSON available when no wallet exists', () => {
    expect(injectedProvider()).toBeUndefined();
    expect(JSON.stringify(seedTypedData('1', TEST_CHAIN_ID))).toBe(
      '{"domain":{"name":"agents-arena","version":"1","chainId":31337},'
      + '"types":{"EIP712Domain":[{"name":"name","type":"string"},'
      + '{"name":"version","type":"string"},{"name":"chainId","type":"uint256"}],'
      + '"Seed":[{"name":"runId","type":"string"}]},'
      + '"primaryType":"Seed","message":{"runId":"1"}}',
    );
  });

  it('throws when the wallet unlocks no account', async () => {
    const { provider } = fakeWallet({ eth_requestAccounts: [] });
    await expect(requestSeedSignature(provider, seedTypedData('1', TEST_CHAIN_ID)))
      .rejects.toThrow('no account');
  });

  it('surfaces the wallet error rather than posting nothing', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const { provider, calls } = fakeWallet({ eth_signTypedData_v4: rejection });
    await expect(requestSeedSignature(provider, seedTypedData('1', TEST_CHAIN_ID)))
      .rejects.toThrow('User rejected');
    expect(calls.map((call) => call.method))
      .toEqual(['eth_requestAccounts', 'eth_signTypedData_v4']);
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
