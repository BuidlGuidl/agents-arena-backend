import type { Address } from 'viem';

export interface ChallengeGuess {
  challengeId: number;
  evidence: string;
}

export type ChallengeVia = 'self' | 'command' | 'message';

interface Target {
  challengeId: number;
  via: ChallengeVia;
  pendingGuess?: ChallengeGuess & { via: ChallengeVia };
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
  for (const sentence of text.slice(-2_000).split(/(?<=[.!?])\s+|\n+/)) {
    guess = matchChallenge(sentence, addressIndex, ignore) ?? guess;
  }
  return guess;
}

const targetByEntrant = new Map<string, Target>();
let solvedLookup = (_runId: string, _entrantId: string): ReadonlySet<number> => EMPTY;

function entrantKey(runId: string, entrantId: string): string {
  return `${runId}:${entrantId}`;
}

export function useSolvedLookup(
  lookup: (runId: string, entrantId: string) => ReadonlySet<number>,
): void {
  solvedLookup = lookup;
}

export function solvedChallenges(runId: string, entrantId: string): ReadonlySet<number> {
  return solvedLookup(runId, entrantId);
}

// The agent's report always wins. A guess may replace an empty, solved, or
// guessed target, but never a live self-report. A refused guess is kept pending until
// the self-reported challenge is solved.
export function mayMove(
  runId: string,
  entrantId: string,
  challengeId: number,
  via: ChallengeVia,
): boolean {
  const target = targetByEntrant.get(entrantKey(runId, entrantId));
  if (target?.challengeId === challengeId && (via !== 'self' || target.via === 'self')) return false;
  if (via === 'self') return true;
  return target === undefined
    || solvedChallenges(runId, entrantId).has(target.challengeId)
    || target.via !== 'self';
}

export function savePendingGuess(
  runId: string,
  entrantId: string,
  guess: ChallengeGuess,
  via: ChallengeVia,
): void {
  const target = targetByEntrant.get(entrantKey(runId, entrantId));
  // A guess naming the current target is a no-op, not a refusal: the solve tx
  // for Challenge 11 must not overwrite the pending "starting 12".
  if (target !== undefined && target.challengeId !== guess.challengeId) target.pendingGuess = { ...guess, via };
}

export function takePendingGuess(
  runId: string,
  entrantId: string,
): (ChallengeGuess & { via: ChallengeVia }) | undefined {
  const target = targetByEntrant.get(entrantKey(runId, entrantId));
  if (target?.pendingGuess === undefined) return undefined;
  const solved = solvedChallenges(runId, entrantId);
  if (!solved.has(target.challengeId) || solved.has(target.pendingGuess.challengeId)) return undefined;
  const pending = target.pendingGuess;
  delete target.pendingGuess;
  return pending;
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
  targetByEntrant.delete(entrantKey(runId, entrantId));
}
