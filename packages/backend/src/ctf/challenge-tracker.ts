import type { Address } from 'viem';

export interface ChallengeGuess {
  challengeId: number;
  evidence: string;
}

export type ChallengeVia = 'self' | 'command' | 'message';

interface ChallengeTarget {
  challengeId: number;
  via: ChallengeVia;
}

// "Challenge5", "Challenge12.sol", "challenge 3" — the forms commands take when
// they read a contract source or run a forge script named after one.
const NAME_PATTERN = /challenge\s*#?\s*(1[0-2]|[1-9])(?![0-9])/gi;
const ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const EMPTY: ReadonlySet<number> = new Set();

// Challenge1..12 and their helpers (Challenge12HeroNFT → 12) feed the index;
// NFTFlags and the registry are deliberately absent — minting a flag says
// nothing about which puzzle is next.
export function challengeAddressIndex(
  addresses: Readonly<Record<string, Address>>,
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (const [name, address] of Object.entries(addresses)) {
    const match = /^Challenge(1[0-2]|[1-9])(?![0-9])/.exec(name);
    if (match !== null) index.set(address.toLowerCase(), Number(match[1]));
  }
  return index;
}

// Guesses the challenge a command is about. A command that references several
// challenges (a grep across all sources, reading the briefing) says nothing
// about which one is current, so only an unambiguous reference counts.
export function matchChallenge(
  detail: string,
  addressIndex: ReadonlyMap<string, number>,
  ignore: ReadonlySet<number> = EMPTY,
): ChallengeGuess | undefined {
  const guesses = new Map<number, string>();
  for (const match of detail.matchAll(NAME_PATTERN)) {
    const challengeId = Number(match[1]);
    if (!ignore.has(challengeId) && !guesses.has(challengeId)) {
      guesses.set(challengeId, match[0]);
    }
  }
  for (const match of detail.matchAll(ADDRESS_PATTERN)) {
    const challengeId = addressIndex.get(match[0].toLowerCase());
    if (challengeId !== undefined && !ignore.has(challengeId) && !guesses.has(challengeId)) {
      guesses.set(challengeId, match[0]);
    }
  }

  if (guesses.size !== 1) return undefined;
  const [challengeId, evidence] = guesses.entries().next().value as [number, string];
  return { challengeId, evidence };
}

// Agents narrate the switch ("Challenge 11 is confirmed. I'm starting Challenge
// 12.") before any command names it. Sentences are matched one by one and the
// last one wins: the flag may not be confirmed on-chain yet, and what the agent
// does next comes last.
export function matchChallengeInProse(
  text: string,
  addressIndex: ReadonlyMap<string, number>,
  ignore: ReadonlySet<number> = EMPTY,
): ChallengeGuess | undefined {
  let guess: ChallengeGuess | undefined;
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    guess = matchChallenge(sentence, addressIndex, ignore) ?? guess;
  }
  return guess;
}

const targetByEntrant = new Map<string, ChallengeTarget>();
const solvedByEntrant = new Map<string, Set<number>>();

function entrantKey(runId: string, entrantId: string): string {
  return `${runId}:${entrantId}`;
}

export function currentChallenge(runId: string, entrantId: string): number | undefined {
  return targetByEntrant.get(entrantKey(runId, entrantId))?.challengeId;
}

// The agent's own report always wins. A guess may only fill a target that is
// empty or already solved, so guesses stop flickering the value under a live
// report. A self-report that names the current guess claims it without a new
// journal row.
export function mayMove(
  runId: string,
  entrantId: string,
  challengeId: number,
  via: ChallengeVia,
): boolean {
  const key = entrantKey(runId, entrantId);
  const target = targetByEntrant.get(key);
  if (target?.challengeId === challengeId) {
    if (via === 'self' && target.via !== 'self') {
      targetByEntrant.set(key, { challengeId, via });
    }
    return false;
  }
  if (via === 'self') return true;
  return target === undefined || solvedByEntrant.get(key)?.has(target.challengeId) === true;
}

export function solvedChallenges(runId: string, entrantId: string): ReadonlySet<number> {
  return solvedByEntrant.get(entrantKey(runId, entrantId)) ?? EMPTY;
}

// A solved challenge is ignored by the matchers, and a target left on it
// counts as empty, so the next guess may fill it.
export function markSolved(runId: string, entrantId: string, challengeId: number): void {
  const key = entrantKey(runId, entrantId);
  const solved = solvedByEntrant.get(key) ?? new Set<number>();
  solved.add(challengeId);
  solvedByEntrant.set(key, solved);
}

// Callers journal first and record after, so an append that throws leaves the
// retry journalling instead of deduping into silence.
export function recordCurrentChallenge(
  runId: string,
  entrantId: string,
  challengeId: number,
  via: ChallengeVia,
): void {
  targetByEntrant.set(entrantKey(runId, entrantId), { challengeId, via });
}

export function dropCurrentChallenge(runId: string, entrantId: string): void {
  const key = entrantKey(runId, entrantId);
  targetByEntrant.delete(key);
  solvedByEntrant.delete(key);
}
