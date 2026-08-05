import type { EntrantRecord } from '../adapters/types.js';
import type { ChainProfile } from '../chain/profile.js';
import { CHALLENGE_PACK_MOUNT } from '../runtime/container.js';
import { CHALLENGE_COUNT } from './pack.js';

export type OpeningPromptBuilder = (entrant: EntrantRecord) => string;

// A profile with a briefingUrl points the entrant at the public CTF site; one
// without gets the challenge pack the arena mounts (ADR-0009).
function briefingLines(profile: ChainProfile): readonly string[] {
  if (profile.briefingUrl !== undefined) {
    return [
      `- The challenge briefing is at ${profile.briefingUrl} — fetch it with curl. It describes all ${CHALLENGE_COUNT} challenges and gives their hints.`,
    ];
  }

  return [
    `- The challenge pack is mounted read-only at ${CHALLENGE_PACK_MOUNT}. Read ${CHALLENGE_PACK_MOUNT}/BRIEFING.md first: it describes all ${CHALLENGE_COUNT} challenges, gives their hints, and lists the address each one is deployed at.`,
    `- ${CHALLENGE_PACK_MOUNT}/contracts holds the Solidity source. ${CHALLENGE_PACK_MOUNT}/deploy holds the deploy script.`,
  ];
}

function rpcLines(profile: ChainProfile): readonly string[] {
  const line = `- The chain JSON-RPC is at ${profile.containerRpcUrl}. It is also set as ETH_RPC_URL, so cast uses it automatically.`;
  if (profile.briefingUrl !== undefined) {
    return [line];
  }
  // Only the local profile reaches the chain through the host gateway, and both
  // harnesses reached for localhost:8545 until the prompt said not to.
  return [`${line} Do not use localhost:8545 — inside your container, localhost is not the chain.`];
}

// Built per entrant at start time so the wallet line carries the real address once
// one is assigned. A vague one-liner left the opencode entrant asking the operator
// what to do instead of working, so this spells out the environment, the puzzles,
// and how scoring works, and tells the agent to act on its own.
export function buildOpeningPrompt(entrant: EntrantRecord, profile: ChainProfile): string {
  const walletLine = entrant.address === null
    ? []
    : [
      `- Your wallet address is ${entrant.address}. Its private key is in the WALLET_PRIVATE_KEY environment variable: sign transactions with cast send --private-key "$WALLET_PRIVATE_KEY" ...`,
    ];

  return [
    'Solidity Invaders — the BuidlGuidl Fortress.',
    '',
    `ALERT! Invaders have taken ${CHALLENGE_COUNT} flags from the BuidlGuidl Fortress. Your mission is to complete ${CHALLENGE_COUNT} Ethereum coding challenges and reclaim them. The other agents in the arena are racing you for the same flags, so reclaim as many as you can.`,
    '',
    'Your environment:',
    '- An isolated Linux container with bash, git, and Foundry (forge, cast).',
    ...rpcLines(profile),
    ...walletLine,
    '',
    'The challenges:',
    '- Each flag sits inside a small Solidity contract, and every contract has a solution designed into it.',
    '- Reclaim a flag by working out that solution and running it. The contract mints the flag to your wallet, and the arena scores you on the flags you hold.',
    ...briefingLines(profile),
    '',
    'How to play:',
    '- Work on your own and start right away. Do not ask for clarification. Explore the chain yourself and make progress.',
    '- Each turn, take a concrete step: inspect a contract, call a function, or check your progress. Prefer doing over explaining.',
    '',
    'Begin now.',
  ].join('\n');
}
