import { randomBytes } from 'node:crypto';

import { getAddress, isAddress, isAddressEqual, recoverMessageAddress, type Address } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export const SESSION_COOKIE = 'arena_operator';

const NONCE_TTL_MS = 10 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

export interface OperatorSession {
  address: Address;
  expiresAt: number;
}

export interface LoginAttempt {
  message: string;
  signature: `0x${string}`;
  /** Host header of the request, used when no domain allowlist is configured. */
  requestHost: string | undefined;
}

export type LoginResult =
  | { ok: true; sessionId: string; session: OperatorSession }
  | { ok: false; reason: string };

export interface SiweLoginOptions {
  /** Addresses allowed to drive a run. An empty list disables SIWE login. */
  operatorAddresses: readonly string[];
  /** Domains a signed message may claim. Empty means "must equal the request host". */
  domains?: readonly string[];
  sessionTtlMs?: number;
  nonceTtlMs?: number;
  now?: () => number;
}

/**
 * Wallet login for the operator: a nonce, one EIP-4361 signature, and a session
 * the auth hook accepts alongside the shared token. Nonces and sessions live in
 * this process — a restart logs the operator out, which matches a restart already
 * dropping the run it was driving.
 */
export class SiweLogin {
  readonly #allowlist: Address[];
  readonly #domains: string[];
  readonly #sessionTtlMs: number;
  readonly #nonceTtlMs: number;
  readonly #now: () => number;
  readonly #nonces = new Map<string, number>();
  readonly #sessions = new Map<string, OperatorSession>();

  constructor(options: SiweLoginOptions) {
    this.#allowlist = options.operatorAddresses.map(normalizeAddress);
    this.#domains = [...(options.domains ?? [])].map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.#nonceTtlMs = options.nonceTtlMs ?? NONCE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#allowlist.length > 0;
  }

  issueNonce(): string {
    this.#sweep();
    const nonce = generateSiweNonce();
    this.#nonces.set(nonce, this.#now() + this.#nonceTtlMs);
    return nonce;
  }

  async login(attempt: LoginAttempt): Promise<LoginResult> {
    this.#sweep();
    const parsed = parseSiweMessage(attempt.message);
    const nonce = parsed.nonce;
    if (nonce === undefined || !this.#nonces.delete(nonce)) {
      // Deleted on first use, so a captured message cannot be replayed.
      return { ok: false, reason: 'Unknown or already used nonce' };
    }
    if (!this.#domainAllowed(parsed.domain, attempt.requestHost)) {
      return { ok: false, reason: 'Message domain does not match this server' };
    }
    if (!validateSiweMessage({ message: parsed, time: new Date(this.#now()) })) {
      return { ok: false, reason: 'Message is expired or not yet valid' };
    }
    const claimed = parsed.address;
    if (claimed === undefined || !this.#allowlist.some((allowed) => isAddressEqual(allowed, claimed))) {
      return { ok: false, reason: 'Address is not an arena operator' };
    }
    // EOA only: the signature is recovered here, so login needs no RPC. A
    // smart-contract wallet (ERC-1271/6492) would need a client on its own chain.
    const recovered = await recoverMessageAddress({ message: attempt.message, signature: attempt.signature })
      .catch(() => undefined);
    if (recovered === undefined || !isAddressEqual(recovered, claimed)) {
      return { ok: false, reason: 'Signature does not match the claimed address' };
    }

    const sessionId = randomBytes(32).toString('hex');
    const session: OperatorSession = {
      address: getAddress(claimed),
      expiresAt: this.#now() + this.#sessionTtlMs,
    };
    this.#sessions.set(sessionId, session);
    return { ok: true, sessionId, session };
  }

  session(sessionId: string | undefined): OperatorSession | undefined {
    if (sessionId === undefined) return undefined;
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.#sessions.delete(sessionId);
  }

  // The domain is what the operator's wallet showed him before he signed, so it
  // is the anti-phishing check. Configure the list when a frontend proxies the
  // arena under its own hostname; otherwise the request's own host is the answer.
  #domainAllowed(messageDomain: string | undefined, requestHost: string | undefined): boolean {
    const claimed = messageDomain?.toLowerCase();
    if (claimed === undefined) return false;
    if (this.#domains.length > 0) return this.#domains.includes(claimed);
    return requestHost !== undefined && claimed === requestHost.toLowerCase();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [nonce, expiresAt] of this.#nonces) {
      if (expiresAt <= now) this.#nonces.delete(nonce);
    }
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}

export function parseCsvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new InvalidOperatorAddressError(`Not an Ethereum address: ${value}`);
  }
  return getAddress(value);
}

export class InvalidOperatorAddressError extends Error {}
