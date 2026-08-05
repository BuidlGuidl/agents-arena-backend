import type { Address } from 'viem';

export interface ChallengeGuess {
  challengeId: number;
  evidence: string;
}

// "Challenge5", "Challenge12.sol", "challenge 3" — the forms commands take when
// they read a contract source or run a forge script named after one.
const NAME_PATTERN = /challenge\s*#?\s*(1[0-2]|[1-9])(?![0-9])/gi;
const ADDRESS_PATTERN = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

// Only Challenge1..12 deployments feed the index; NFTFlags and the registry are
// deliberately absent — minting a flag says nothing about which puzzle is next.
export function challengeAddressIndex(
  addresses: Readonly<Record<string, Address>>,
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (const [name, address] of Object.entries(addresses)) {
    const match = /^Challenge(1[0-2]|[1-9])$/.exec(name);
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
): ChallengeGuess | undefined {
  const guesses = new Map<number, string>();
  for (const match of detail.matchAll(NAME_PATTERN)) {
    const challengeId = Number(match[1]);
    if (!guesses.has(challengeId)) guesses.set(challengeId, match[0]);
  }
  for (const match of detail.matchAll(ADDRESS_PATTERN)) {
    const challengeId = addressIndex.get(match[0].toLowerCase());
    if (challengeId !== undefined && !guesses.has(challengeId)) {
      guesses.set(challengeId, match[0]);
    }
  }

  if (guesses.size !== 1) return undefined;
  const [challengeId, evidence] = guesses.entries().next().value as [number, string];
  return { challengeId, evidence };
}

// One per run and entrant. Folds command-level guesses into a current challenge
// and reports only the changes, so the journal stays quiet while an entrant
// keeps working on the same puzzle.
export class ChallengeTracker {
  private current: number | undefined;

  constructor(private readonly addressIndex: ReadonlyMap<string, number>) {}

  observe(detail: string): ChallengeGuess | undefined {
    const guess = matchChallenge(detail, this.addressIndex);
    if (guess === undefined || guess.challengeId === this.current) return undefined;
    this.current = guess.challengeId;
    return guess;
  }
}
