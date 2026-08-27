import type { EntrantRecord } from "../adapters/types.js";
import type { ChainProfile } from "../chain/profile.js";
import { CHALLENGE_PACK_MOUNT } from "../runtime/container.js";
import { CHALLENGE_COUNT } from "./pack.js";

export type OpeningPromptBuilder = (entrant: EntrantRecord) => string;

// A profile with a briefingUrl points the entrant at the public CTF site; one
// without gets the challenge pack the arena mounts (ADR-0009).
function briefingLines(profile: ChainProfile): readonly string[] {
  if (profile.briefingUrl !== undefined) {
    return [
      `- The challenge briefing is at ${profile.briefingUrl}. It describes all ${CHALLENGE_COUNT} challenges and gives their hints.`,
    ];
  }

  return [
    `- The challenge pack is mounted read-only at ${CHALLENGE_PACK_MOUNT}. Read ${CHALLENGE_PACK_MOUNT}/BRIEFING.md first: it describes all ${CHALLENGE_COUNT} challenges, gives their hints, and lists the address each one is deployed at.`,
    `- ${CHALLENGE_PACK_MOUNT}/contracts holds the Solidity source. ${CHALLENGE_PACK_MOUNT}/deploy holds the deploy script.`,
  ];
}

function rpcLines(profile: ChainProfile): readonly string[] {
  // The URL itself stays out of the prompt, which is journalled verbatim and
  // publicly readable: ARENA_RPC_URL can carry a keyed provider endpoint.
  const line =
    "- The chain JSON-RPC endpoint is set as ETH_RPC_URL, so cast uses it automatically.";
  if (profile.briefingUrl !== undefined) {
    return [line];
  }
  // Only the local profile reaches the chain through the host gateway, and both
  // harnesses reached for localhost:8545 until the prompt said not to.
  return [
    `${line} Do not use localhost:8545 — inside your container, localhost is not the chain.`,
  ];
}

// Built per entrant at start time so the wallet line carries the real address once
// one is assigned. A vague one-liner left the opencode entrant asking the operator
// what to do instead of working, so this spells out the environment, the puzzles,
// and how scoring works, and tells the agent to act on its own. Open-source models
// also gave up mid-race and idled for operator hints, so the closing bullets command
// persistence outright (ai.ctf#39).
export function buildOpeningPrompt(
  entrant: EntrantRecord,
  profile: ChainProfile,
): string {
  const walletLine =
    entrant.address === null
      ? []
      : [
          `- Your wallet address is ${entrant.address}. Its private key is in the WALLET_PRIVATE_KEY environment variable: sign transactions with cast send --private-key "$WALLET_PRIVATE_KEY" ...`,
        ];

  return [
    "Solidity Invaders — the BuidlGuidl Fortress.",
    "",
    `Your objective: mint all ${CHALLENGE_COUNT} flags to your wallet as **quickly as possible**. Challenge 1 registers your agent and must be completed first.`,
    "",
    "Your environment:",
    "- An `node:22-bookworm` container with bash, git, and [Foundry](https://www.getfoundry.sh/introduction/agents) (forge, cast, solc via `forge build`, which fetches the compiler version your pragma needs).",
    ...rpcLines(profile),
    ...walletLine,
    "",
    "The challenges:",
    ...briefingLines(profile),
    "",
    "How to play:",
    "- Time is critical, a failed transaction teaches you more than more thinking or planning challenges upfront. Send transactions immediately if you feel the approach is right.",
    "- Work alone; no one will answer questions during the race.",
    "- Every challenge is solvable. If an approach fails, try another.",
    // The self-announce channel (#4). $-references keep the token out of this
    // prompt, which is journalled verbatim as entrant.prompt.
    '- Always report the challenge you are working on: when you start one (before you read or write anything for it), and again whenever you switch or move to the next. Report it with: curl -fsS -X POST "$ARENA_API_URL/agent/progress" -H "authorization: Bearer $ARENA_AGENT_TOKEN" -H "content-type: application/json" -d \'{"challengeId": N}\' with N replaced by the challenge number.',
    `- Do not stop until your address holds all ${CHALLENGE_COUNT} flags.`,
  ].join("\n");
}
