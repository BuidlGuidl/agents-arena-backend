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

  it('resolves the local pack for the outside entrant', () => {
    const packDir = '/tmp/arena-challenge-pack/run-1';
    const packDirFor = vi.fn(() => packDir);
    const text = buildTaskText(external, activeChainProfile, { publicUrl: 'https://arena.test', packDirFor });
    expect(packDirFor).toHaveBeenCalledWith(external.runId);
    expect(text).toContain(`- This is a local development chain, so you are on the same machine as the arena. The challenge pack is at ${packDir}.`);
    expect(text).toContain(`- Read ${packDir}/BRIEFING.md first: it describes all 12 challenges, gives their hints, and lists the address each one is deployed at. ${packDir}/contracts holds the Solidity source.`);
    expect(text).toContain('- If that wallet holds no gas, ask the person running you to fund it.');
  });

  it('uses the fallback when the pack resolver throws', () => {
    const warnPackFallback = vi.fn();
    const text = buildTaskText(external, activeChainProfile, {
      publicUrl: 'https://arena.test', warnPackFallback,
      packDirFor: () => { throw new Error('AI_CTF_REPO is not set'); },
    });
    expect(warnPackFallback).toHaveBeenCalledOnce();
    expect(text).toContain('AI_CTF_REPO is not set');
    expect(text).toContain('packages/hardhat/contracts');
    expect(text).toContain('checking you have the live set.');
  });

  it('does not resolve a pack for hosted entrants or public briefings', () => {
    const packDirFor = vi.fn(() => '/tmp/private-pack');
    const options = { publicUrl: 'https://arena.test', packDirFor };
    buildTaskText(entrant, activeChainProfile, options);
    const text = buildTaskText(external, {
      ...activeChainProfile, chainId: 8453, briefingUrl: 'https://briefing.test',
    }, options);
    expect(packDirFor).not.toHaveBeenCalled();
    expect(text).not.toContain('/tmp/private-pack');
    expect(text).not.toContain('ask the person running you to fund it');
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
    expect(text.split('https://site.test')).toHaveLength(2);
    expect(text).not.toContain('$ARENA_API_URL');
    expect(text).not.toContain('/ctf/BRIEFING.md');
    expect(text).not.toContain('/ctf/contracts');
    if (profile.briefingUrl) expect(text).toContain(profile.briefingUrl);
    else {
      expect(text).toContain('local development chain');
      expect(text).toContain('AI_CTF_REPO is not set');
      expect(text).toContain('checking you have the live set');
    }
    const hosted = buildTaskText(entrant, profile, { publicUrl: 'https://arena.test' });
    expect(text.split('\n').at(-1)).toBe(hosted.split('\n').at(-1));
  });

});
