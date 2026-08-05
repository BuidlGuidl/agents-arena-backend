import type { EntrantRecord } from '../adapters/types.js';
import type { ChainProfile } from '../chain/profile.js';
import { CHALLENGE_PACK_MOUNT } from '../runtime/container.js';

export type OpeningPromptBuilder = (entrant: EntrantRecord) => string;

// A profile with a briefingUrl points the entrant at the public CTF site; one
// without gets the challenge pack the arena mounts (ADR-0009).
function briefingLines(profile: ChainProfile): readonly string[] {
  if (profile.briefingUrl !== undefined) {
    return [
      `- The challenge briefing is at ${profile.briefingUrl} — fetch it with curl. It describes all 12 challenges and gives their hints.`,
    ];
  }

  return [
    `- The challenge pack is mounted read-only at ${CHALLENGE_PACK_MOUNT}. Read ${CHALLENGE_PACK_MOUNT}/BRIEFING.md first: it describes all 12 challenges, gives their hints, and lists the address each one is deployed at.`,
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
    'You are competing in a capture-the-flag competition against the other agents in the arena. Twelve on-chain Solidity puzzles are waiting. Everything here is a purpose-built exercise: the contracts exist only to be solved, like an advent-of-code problem or a puzzle box. Nothing here is a real system or a real target.',
    '',
    'Your environment:',
    '- An isolated Linux container with bash, git, and Foundry (forge, cast).',
    ...rpcLines(profile),
    ...walletLine,
    '',
    'The puzzles:',
    '- Each challenge is a small Solidity contract with an intended solution built in.',
    '- Completing a challenge mints a badge (the arena calls it a flag) to your wallet, which is how progress is scored.',
    ...briefingLines(profile),
    '',
    'How to play:',
    '- Work on your own and start right away. Do not ask for clarification. Explore the chain yourself and make progress.',
    '- Each turn, take a concrete step: inspect a contract, call a function, or check your progress. Prefer doing over explaining.',
    // The self-announce channel (#4). $-references keep the token out of this
    // prompt, which is journalled verbatim as entrant.prompt.
    '- When you start working on a challenge, and again whenever you switch, announce it to the arena: curl -fsS -X POST "$ARENA_API_URL/agent/progress" -H "authorization: Bearer $ARENA_AGENT_TOKEN" -H "content-type: application/json" -d \'{"challengeId": N}\' with N replaced by the challenge number.',
    '',
    'Begin now.',
  ].join('\n');
}
