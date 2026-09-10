import { readFileSync } from 'node:fs';
import { activeChainProfile } from '../../src/chain/profile.js';
import type { ExternalEntrantRecord } from '../../src/adapters/types.js';
import { describe, expect, it, vi } from 'vitest';

import type { EntrantRecord } from '../../src/adapters/types.js';
import type { ChainProfile } from '../../src/chain/profile.js';
import { buildTaskText } from '../../src/ctf/prompt.js';

const entrant: EntrantRecord = {
  kind: 'hosted',
  runId: 'run-1',
  id: 'entrant-1',
  harness: 'codex',
  model: 'gpt-5.5',
  effort: null,
  address: null,
  status: 'idle',
};

describe('buildTaskText', () => {
  it.each(['local', 'public'] as const)('keeps the %s hosted prompt byte-identical to slice A', (name) => {
    const profile = { ...activeChainProfile,
      ...(name === 'public' ? { briefingUrl: 'https://briefing.example.test/challenges' } : {}),
    };
    const text = buildTaskText({ ...entrant, address: '0x1234567890123456789012345678901234567890' }, profile,
      { publicUrl: 'https://arena.test' });
    expect(text).toBe(readFileSync(new URL(`../fixtures/hosted-prompt-${name}.txt`, import.meta.url), 'utf8'));
  });

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

    const prompt = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });

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

    const prompt = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });

    expect(prompt).toContain('$ARENA_API_URL/agent/progress');
    expect(prompt).toContain('Bearer $ARENA_AGENT_TOKEN');
  });

  // Open-source entrants gave up mid-race and idled for operator hints
  // (ai.ctf#39), so the prompt must keep commanding persistence.
  it('commands the agent to keep going until every flag is held', () => {
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

    const prompt = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });

    expect(prompt).toContain('Do not stop until your address holds all 12 flags.');
    expect(prompt).toContain('Every challenge is solvable.');
    expect(prompt).toContain('Work alone; no one will answer questions during the race.');
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

    const prompt = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });

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

    const prompt = buildTaskText({ ...entrant, address }, profile, { publicUrl: 'https://arena.test' });

    expect(prompt).toContain(address);
  });
});

describe('external task text', () => {
  const external: ExternalEntrantRecord = {
    kind: 'external', runId: 'run-1', id: 'ext-1', name: 'My agent',
    address: '0x1234567890123456789012345678901234567890', status: 'idle',
    joinedAt: '2026-09-08T00:00:00.000Z', removedAt: null, flagsBeforeJoin: 2,
  };

  it('points the outside entrant at the site briefing on every chain', () => {
    const local = buildTaskText(external, activeChainProfile, {
      publicUrl: 'https://arena.test', siteUrl: 'https://site.test',
    });
    const base = buildTaskText(external, {
      ...activeChainProfile, chainId: 8453, briefingUrl: 'https://briefing.test',
    }, { publicUrl: 'https://arena.test', siteUrl: 'https://site.test' });
    const line = '- The challenge briefing is at https://site.test/llms.txt. It describes all 12 challenges, gives their hints, and lists the address each one is deployed at.';
    expect(local).toContain(line);
    expect(base).toContain(line);
    // The profile's own briefingUrl is for the container, which cannot reach a local site.
    expect(base).not.toContain('https://briefing.test');
    expect(local).toContain('- If that wallet holds no gas, ask the person running you to fund it.');
    expect(base).not.toContain('ask the person running you to fund it');
  });

  it('never sends the outside entrant to a path on our machine', () => {
    const text = buildTaskText(external, activeChainProfile, { publicUrl: 'https://arena.test' });
    expect(text).not.toContain('arena-challenge-pack');
    expect(text).not.toContain('AI_CTF_REPO');
    expect(text).not.toContain('packages/hardhat');
    expect(text).not.toContain('/ctf');
  });

  it('defaults the join link to the public URL when siteUrl is omitted', () => {
    const text = buildTaskText(external, activeChainProfile, { publicUrl: 'https://arena.test/' });
    expect(text).toContain('documented at https://arena.test/arena/join.');
  });

  it.each([31337, 8453])('uses the external wallet and public API for chain %s', (chainId) => {
    const profile = { ...activeChainProfile, chainId, ...(chainId === 8453 ? { briefingUrl: 'https://briefing.test' } : {}) };
    const text = buildTaskText(external, profile, { publicUrl: 'https://arena.test/', siteUrl: 'https://site.test/' });
    expect(text).toContain(external.address);
    expect(text).toContain('Use the wallet the person running you set up, and pay your own gas');
    expect(text).toContain(`- The race is on chain id ${chainId}.`);
    expect(text).toContain(
      'Report as you go through the arena tools: call set_current_challenge before you start each challenge, post_note after every attempt and at least every few minutes while you work, and read_inbox between steps. ' +
      'If you do not have the tools, use the agent API at https://arena.test, documented at https://site.test/arena/join.',
    );
    expect(text).not.toContain('WALLET_PRIVATE_KEY');
    expect(text).not.toContain('ETH_RPC_URL');
    expect(text).not.toContain('node:22-bookworm');
    expect(text).not.toContain('not the chain');
    expect(text).not.toContain('http://127.0.0.1:8545');
    expect(text).not.toContain('RPC');
    expect(text.split('https://arena.test')).toHaveLength(2);
    expect(text.split('https://site.test')).toHaveLength(3);
    expect(text).not.toContain('$ARENA_API_URL');
    expect(text).not.toContain('/ctf/BRIEFING.md');
    expect(text).not.toContain('/ctf/contracts');
    expect(text).toContain('- The challenge briefing is at https://site.test/llms.txt.');
    if (profile.briefingUrl) expect(text).not.toContain(profile.briefingUrl);
    const hosted = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });
    expect(text.split('\n').at(-1)).toBe(hosted.split('\n').at(-1));
  });

});
