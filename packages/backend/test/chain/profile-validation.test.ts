import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ text: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => {
      if (path instanceof URL && path.pathname.endsWith('/config/chains.json')) {
        return config.text;
      }
      return actual.readFileSync(path, options);
    },
  };
});

const nftFlags = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
const challenge1 = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const rawProfile = {
  name: 'local',
  rpcUrl: 'http://127.0.0.1:8545',
  containerRpcUrl: 'http://host.docker.internal:8545',
  chainId: 31337,
  confirmations: 1,
  nftFlags,
  challenge1,
  identityRegistry: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
  fundingThresholdEth: '0.05',
};

async function importProfileWith(challengeAddresses: Record<string, string>): Promise<unknown> {
  config.text = JSON.stringify({
    local: { ...rawProfile, challengeAddresses },
  });
  vi.resetModules();
  return import('../../src/chain/profile.js');
}

describe('chain profile challenge address validation', () => {
  it('rejects an invalid challenge address', async () => {
    await expect(importProfileWith({
      Challenge1: challenge1,
      Challenge2: 'not-an-address',
      NFTFlags: nftFlags,
    })).rejects.toThrow(
      'Invalid local.challengeAddresses.Challenge2 address: not-an-address',
    );
  });

  it('rejects a Challenge1 address that differs from the profile field', async () => {
    await expect(importProfileWith({
      Challenge1: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      NFTFlags: nftFlags,
    })).rejects.toThrow('Profile local challengeAddresses.Challenge1');
  });
});
