import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getAddress, isAddress, isAddressEqual, recoverMessageAddress, type Address } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export const SESSION_COOKIE = 'arena_operator';

const NONCE_TTL_MS = 10 * 60 * 1_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

// A nonce is `<random><expiry><mac>`, all hex so it satisfies EIP-4361's
// alphanumeric rule. Widths are fixed, so the parts split by offset.
const NONCE_RANDOM_CHARS = 16;
const NONCE_EXPIRY_CHARS = 12;
const NONCE_MAC_CHARS = 32;
const NONCE_CHARS = NONCE_RANDOM_CHARS + NONCE_EXPIRY_CHARS + NONCE_MAC_CHARS;

export interface OperatorSession {
  address: Address;
  expiresAt: number;
}

export interface LoginAttempt {
  message: string;
  signature: `0x${string}`;
}

export type LoginResult =
  | { ok: true; sessionId: string; session: OperatorSession }
  | { ok: false; reason: string };

export interface SiweLoginOptions {
  /** Addresses allowed to drive a run. An empty list disables SIWE login. */
  operatorAddresses: readonly string[];
  /** Domains a signed message may claim. Required when SIWE login is enabled. */
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
  readonly #allowlist: string[];
  readonly #domains: string[];
  readonly #sessionTtlMs: number;
  readonly #nonceTtlMs: number;
  readonly #now: () => number;
  // Only spent nonces are stored, and only a completed login spends one, so an
  // anonymous flood of /auth/nonce writes nothing here.
  readonly #spentNonces = new Map<string, number>();
  readonly #nonceKey = randomBytes(32);
  readonly #sessions = new Map<string, OperatorSession>();

  constructor(options: SiweLoginOptions) {
    this.#allowlist = normalizeOperatorAddresses(options.operatorAddresses);
    this.#domains = [...(options.domains ?? [])].map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0);
    if (this.#allowlist.length > 0 && this.#domains.length === 0) {
      throw new MissingSiweDomainError(
        'ARENA_SIWE_DOMAINS is required when wallet login is enabled',
      );
    }
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.#nonceTtlMs = options.nonceTtlMs ?? NONCE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#allowlist.length > 0;
  }

  /**
   * The nonce carries its own expiry under a MAC, so issuing one stores nothing.
   * `/auth/nonce` is open to anyone, and a map written by every anonymous caller
   * is a memory drip with no safe eviction policy — dropping the oldest entry
   * under a flood would delete the one sitting in the operator's wallet prompt.
   */
  issueNonce(): string {
    const random = randomBytes(NONCE_RANDOM_CHARS / 2).toString('hex');
    const expiry = (this.#now() + this.#nonceTtlMs).toString(16).padStart(NONCE_EXPIRY_CHARS, '0');
    if (expiry.length !== NONCE_EXPIRY_CHARS) {
      throw new Error('Nonce expiry does not fit its field');
    }
    return `${random}${expiry}${this.#nonceMac(random + expiry)}`;
  }

  async login(attempt: LoginAttempt): Promise<LoginResult> {
    this.#sweep();
    const parsed = parseSiweMessage(attempt.message);
    const nonce = parsed.nonce;
    if (nonce === undefined || !this.#nonceValid(nonce) || this.#spentNonces.has(nonce)) {
      return { ok: false, reason: 'Unknown or already used nonce' };
    }
    const domain = parsed.domain;
    if (domain === undefined || !this.#domainAllowed(domain)) {
      return { ok: false, reason: 'Message domain does not match this server' };
    }
    if (parsed.version !== '1') {
      return { ok: false, reason: 'Unsupported SIWE version' };
    }
    let uri: URL;
    try {
      uri = new URL(parsed.uri ?? '');
    } catch {
      return { ok: false, reason: 'Message URI is invalid' };
    }
    if (uri.host.toLowerCase() !== domain.toLowerCase()) {
      return { ok: false, reason: 'Message URI host does not match its domain' };
    }
    // A loopback host is the local demo, which is served over plain http. Anything
    // else the operator reaches over the network must have shown him an https URI.
    if (uri.protocol !== 'https:' && !isLoopbackDomain(domain)) {
      return { ok: false, reason: 'Message URI must be https' };
    }
    // Only `time` is worth passing: viem compares its other arguments against the
    // same parsed message, so handing it our own domain and nonce back would
    // compare each value to itself. Both are checked above against the allowlist
    // and the issued-nonce map, which is where the real answer lives.
    if (!validateSiweMessage({ message: parsed, time: new Date(this.#now()) })) {
      return { ok: false, reason: 'Message is expired or not yet valid' };
    }
    const claimed = parsed.address;
    if (claimed === undefined || !this.#allowlist.includes(claimed.toLowerCase())) {
      return { ok: false, reason: 'Address is not an arena operator' };
    }
    // EOA only: the signature is recovered here, so login needs no RPC. A
    // smart-contract wallet (ERC-1271/6492) would need a client on its own chain.
    const recovered = await recoverMessageAddress({ message: attempt.message, signature: attempt.signature })
      .catch(() => undefined);
    if (recovered === undefined || !isAddressEqual(recovered, claimed)) {
      return { ok: false, reason: 'Signature does not match the claimed address' };
    }

    // Spent only now, on a login that carried a real operator signature, so the
    // map cannot be grown by anyone who is not already allowed to drive the run.
    this.#spentNonces.set(nonce, this.#nonceExpiry(nonce));
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
  // is the anti-phishing check.
  #domainAllowed(messageDomain: string | undefined): boolean {
    const claimed = messageDomain?.toLowerCase();
    if (claimed === undefined) return false;
    return this.#domains.includes(claimed);
  }

  #nonceMac(payload: string): string {
    return createHmac('sha256', this.#nonceKey).update(payload).digest('hex').slice(0, NONCE_MAC_CHARS);
  }

  #nonceExpiry(nonce: string): number {
    return Number.parseInt(nonce.slice(NONCE_RANDOM_CHARS, NONCE_RANDOM_CHARS + NONCE_EXPIRY_CHARS), 16);
  }

  // A nonce this process did not mint cannot carry the right MAC, and one it
  // minted names its own deadline, so neither needs a record of the issue.
  #nonceValid(nonce: string): boolean {
    if (nonce.length !== NONCE_CHARS || !/^[0-9a-f]+$/.test(nonce)) return false;
    const payload = nonce.slice(0, NONCE_RANDOM_CHARS + NONCE_EXPIRY_CHARS);
    const mac = Buffer.from(nonce.slice(NONCE_RANDOM_CHARS + NONCE_EXPIRY_CHARS), 'hex');
    const expected = Buffer.from(this.#nonceMac(payload), 'hex');
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
    const expiry = this.#nonceExpiry(nonce);
    return Number.isSafeInteger(expiry) && expiry > this.#now();
  }

  #sweep(): void {
    const now = this.#now();
    for (const [nonce, expiresAt] of this.#spentNonces) {
      if (expiresAt <= now) this.#spentNonces.delete(nonce);
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

export function normalizeOperatorAddresses(values: readonly string[]): string[] {
  return values.map((value) => normalizeAddress(value).toLowerCase());
}

// Mirrors the loopback rule the session cookie uses for `Secure`, so the local
// demo and the deployed arena agree on which one they are.
function isLoopbackDomain(domain: string): boolean {
  const host = domain.toLowerCase();
  const closing = host.indexOf(']');
  const name = host.startsWith('[') && closing > 0 ? host.slice(1, closing) : (host.split(':')[0] ?? '');
  if (name === 'localhost' || name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function normalizeAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new InvalidOperatorAddressError(`Not an Ethereum address: ${value}`);
  }
  return getAddress(value);
}

export class InvalidOperatorAddressError extends Error {}

export class MissingSiweDomainError extends Error {}
