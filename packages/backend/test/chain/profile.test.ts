import { describe, expect, it } from 'vitest';

import { applyRpcOverride, getChainProfile } from '../../src/chain/profile.js';

describe('applyRpcOverride', () => {
  const profile = getChainProfile('local');

  it('returns the profile untouched when the override is unset', () => {
    expect(applyRpcOverride(profile, undefined)).toBe(profile);
  });

  it('ignores an empty override, which an env file sets as an empty string', () => {
    expect(applyRpcOverride(profile, '')).toBe(profile);
    expect(applyRpcOverride(profile, '  ')).toBe(profile);
  });

  it('replaces both RPC endpoints and nothing else', () => {
    const overridden = applyRpcOverride(profile, 'https://rpc.example/key');
    expect(overridden.rpcUrl).toBe('https://rpc.example/key');
    expect(overridden.containerRpcUrl).toBe('https://rpc.example/key');
    expect(overridden).toEqual({
      ...profile,
      rpcUrl: 'https://rpc.example/key',
      containerRpcUrl: 'https://rpc.example/key',
    });
  });
});
