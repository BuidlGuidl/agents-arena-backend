import { describe, expect, it } from 'vitest';

import type { EntrantRecord } from '../../src/adapters/types.js';
import type { ChainProfile } from '../../src/chain/profile.js';
import { buildOpeningPrompt } from '../../src/ctf/prompt.js';

const entrant: EntrantRecord = {
  runId: 'run-1',
  id: 'entrant-1',
  harness: 'codex',
  model: 'gpt-5.5',
  effort: null,
  address: null,
  status: 'idle',
};

describe('buildOpeningPrompt', () => {
  it('describes the mounted challenge pack for a local profile', () => {
    const profile: ChainProfile = {
      name: 'local-test',
      rpcUrl: 'http://127.0.0.1:8545',
      containerRpcUrl: 'http://host.docker.internal:9545',
      chainId: 31337,
      confirmations: 1,
      nftFlags: '0x0000000000000000000000000000000000000001',
      challenge1: '0x0000000000000000000000000000000000000002',
      identityRegistry: '0x0000000000000000000000000000000000000003',
      fundingThresholdWei: 1n,
    };

    const prompt = buildOpeningPrompt(entrant, profile);

    expect(prompt).toContain('/ctf/BRIEFING.md');
    expect(prompt).toContain('/ctf/contracts');
    expect(prompt).toContain('/ctf/deploy');
    expect(prompt).toContain('ETH_RPC_URL');
    expect(prompt).not.toContain(profile.containerRpcUrl);
    expect(prompt).toContain('localhost:8545');
    expect(prompt).not.toContain('Read each challenge contract with cast');
    expect(prompt).not.toContain('Your wallet address is');
  });

  // The instruction references the env vars, so the journalled prompt never
  // carries the live token itself.
  it('tells the agent to announce its challenge through the env-var channel', () => {
    const profile: ChainProfile = {
      name: 'local-test',
      rpcUrl: 'http://127.0.0.1:8545',
      containerRpcUrl: 'http://host.docker.internal:9545',
      chainId: 31337,
      confirmations: 1,
      nftFlags: '0x0000000000000000000000000000000000000001',
      challenge1: '0x0000000000000000000000000000000000000002',
      identityRegistry: '0x0000000000000000000000000000000000000003',
      fundingThresholdWei: 1n,
    };

    const prompt = buildOpeningPrompt(entrant, profile);

    expect(prompt).toContain('$ARENA_API_URL/agent/progress');
    expect(prompt).toContain('Bearer $ARENA_AGENT_TOKEN');
  });

  it('uses the public briefing without local mount instructions', () => {
    const profile: ChainProfile = {
      name: 'public-test',
      rpcUrl: 'https://rpc.example.test',
      containerRpcUrl: 'https://rpc.example.test',
      chainId: 84532,
      confirmations: 2,
      nftFlags: '0x0000000000000000000000000000000000000001',
      challenge1: '0x0000000000000000000000000000000000000002',
      identityRegistry: '0x0000000000000000000000000000000000000003',
      fundingThresholdWei: 1n,
      briefingUrl: 'https://briefing.example.test/challenges',
    };

    const prompt = buildOpeningPrompt(entrant, profile);

    expect(prompt).toContain(profile.briefingUrl);
    expect(prompt).not.toContain(profile.containerRpcUrl);
    expect(prompt).not.toContain('/ctf');
    expect(prompt).not.toContain('localhost:8545');
    expect(prompt).not.toContain('Read each challenge contract with cast');
  });

  it('includes an assigned wallet address', () => {
    const profile: ChainProfile = {
      name: 'wallet-test',
      rpcUrl: 'http://127.0.0.1:8545',
      containerRpcUrl: 'http://host.docker.internal:8545',
      chainId: 31337,
      confirmations: 1,
      nftFlags: '0x0000000000000000000000000000000000000001',
      challenge1: '0x0000000000000000000000000000000000000002',
      identityRegistry: '0x0000000000000000000000000000000000000003',
      fundingThresholdWei: 1n,
    };
    const address = '0x1234567890123456789012345678901234567890';

    const prompt = buildOpeningPrompt({ ...entrant, address }, profile);

    expect(prompt).toContain(address);
  });
});
