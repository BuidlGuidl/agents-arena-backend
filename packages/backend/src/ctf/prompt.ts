import type { EntrantRecord } from "../adapters/types.js";
import type { ChainProfile } from "../chain/profile.js";
import { CHALLENGE_PACK_MOUNT } from "../runtime/container.js";
import { resolveSiteUrl } from "../config.js";
import { CHALLENGE_COUNT } from "./pack.js";

export type OpeningPromptBuilder = (entrant: EntrantRecord) => string;

interface TaskTextOptions {
  publicUrl: string;
  siteUrl?: string;
  packDirFor?: (runId: string) => string;
  warnPackFallback?: () => void;
}

// A public briefing needs no local pack. Hosted entrants use the mounted pack.
function briefingLines(
  profile: ChainProfile,
  entrant: EntrantRecord,
  options: TaskTextOptions,
): readonly string[] {
  if (profile.briefingUrl !== undefined) {
    return [
      `- The challenge briefing is at ${profile.briefingUrl}. It describes all ${CHALLENGE_COUNT} challenges and gives their hints.`,
    ];
  }

  if (entrant.kind === 'external') {
    let packDir: string | undefined;
    try {
      packDir = options.packDirFor?.(entrant.runId);
    } catch {
      // The fallback lets the person running the agent locate the checkout.
    }
    if (packDir !== undefined) {
      return [
        `- This is a local development chain, so you are on the same machine as the arena. The challenge pack is at ${packDir}.`,
        `- Read ${packDir}/BRIEFING.md first: it describes all ${CHALLENGE_COUNT} challenges, gives their hints, and lists the address each one is deployed at. ${packDir}/contracts holds the Solidity source.`,
      ];
    }
    options.warnPackFallback?.();
    return [
      '- This is a local development chain, but the arena could not assemble the challenge pack because AI_CTF_REPO is not set. Ask the person running you where their ai.ctf.buidlguidl.com checkout is, then read packages/hardhat/contracts there and take the addresses for chain 31337 from packages/hardhat/deployments or packages/nextjs/contracts/deployedContracts.ts, checking you have the live set.',
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

// The outside agent is somebody else's, already set up by the person running it, so its
// lines say what only the arena knows (the chain, the address it races as, where the
// challenges are) and leave the how to the agent: no RPC endpoint, no signing recipe, no
// funding procedure. The hosted lines below stay explicit because we built that container.
// Built per entrant at start time so the wallet line carries the real address once
// one is assigned. A vague one-liner left the opencode entrant asking the operator
// what to do instead of working, so this spells out the environment, the puzzles,
// and how scoring works, and tells the agent to act on its own. Open-source models
// also gave up mid-race and idled for operator hints, so the closing bullets command
// persistence outright (ai.ctf#39).
export function buildTaskText(
  entrant: EntrantRecord,
  profile: ChainProfile,
  options: TaskTextOptions,
): string {
  const siteUrl = resolveSiteUrl(options.publicUrl, [], options.siteUrl);
  const apiUrl = entrant.kind === 'hosted' ? '$ARENA_API_URL' : options.publicUrl.replace(/\/$/, '');
  const walletLine = entrant.kind === 'external'
    ? [`- You race as ${entrant.address}. Use the wallet the person running you set up, and pay your own gas.`]
    : entrant.address === null
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
    ...(entrant.kind === 'external' ? [] : ["- An `node:22-bookworm` container with bash, git, and [Foundry](https://www.getfoundry.sh/introduction/agents) (forge, cast, solc via `forge build`, which fetches the compiler version your pragma needs)."]),
    ...(entrant.kind === 'hosted' ? rpcLines(profile) : [
      `- The race is on chain id ${profile.chainId}.`,
    ]),
    ...walletLine,
    ...(entrant.kind === 'external' && profile.chainId === 31337 ? [
      '- If that wallet holds no gas, ask the person running you to fund it.',
    ] : []),
    "",
    "The challenges:",
    ...briefingLines(profile, entrant, options),
    "",
    "How to play:",
    "- Time is critical, a failed transaction teaches you more than more thinking or planning challenges upfront. Send transactions immediately if you feel the approach is right.",
    "- Work alone; no one will answer questions during the race.",
    "- Every challenge is solvable. If an approach fails, try another.",
    // The self-announce channel (#4). $-references keep the token out of this
    // prompt, which is journalled verbatim as entrant.prompt.
    entrant.kind === 'external'
      ? `- Report as you go through the arena tools: call set_current_challenge before you start each challenge, post_note after every attempt and at least every few minutes while you work, and read_inbox between steps. If you do not have the tools, use the agent API at ${apiUrl}, documented at ${siteUrl}/arena/join.`
      : `- Always report the challenge you are working on: when you start one (before you read or write anything for it), and again whenever you switch or move to the next. Report it with: curl -fsS -X POST "${apiUrl}/agent/progress" -H "authorization: Bearer $ARENA_AGENT_TOKEN" -H "content-type: application/json" -d '{"challengeId": N}' with N replaced by the challenge number.`,
    `- Do not stop until your address holds all ${CHALLENGE_COUNT} flags.`,
  ].join("\n");
}
