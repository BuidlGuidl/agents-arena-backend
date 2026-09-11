import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';

import { getAddress } from 'viem';

import { TERMINAL_RUN_STATES } from './contract.js';
import type { ArenaDatabase } from './db/index.js';
import { agentTokens, externalEntrants, runs } from './db/schema.js';

const AGENT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export const AGENT_TOKEN_PATTERN = /byoa_[0-9a-f]{48}/;

export function mintAgentToken(): string {
  return `byoa_${randomBytes(24).toString('hex')}`;
}

// Hosted credentials live in memory and die with their containers.
// Agent tokens use the database-backed store below. Both resolve through one function.

interface AgentRecordBase {
  address?: string;
  runId?: string;
  entrantId?: string;
  // Route-level state: when the last journalled announcement landed (rate
  // limit). Dedupe lives in the shared current-challenge store, which the
  // command heuristic reads and moves too.
  lastAnnouncedAtMs?: number;
}

export class NotInRunError extends Error {
  constructor() { super('Not in a run. Join first.'); }
}

export function requireLane(record: AgentIdentityRecord): AgentTokenRecord {
  if (record.runId === undefined || record.entrantId === undefined) throw new NotInRunError();
  return record as AgentTokenRecord;
}

export type AgentIdentityRecord = (AgentRecordBase & { address: string }) | AgentTokenRecord;

export interface AgentTokenRecord extends AgentRecordBase {
  runId: string;
  entrantId: string;
}

const byToken = new Map<string, AgentTokenRecord>();
const byEntrant = new Map<string, string>();

function entrantKey(runId: string, entrantId: string): string {
  return `${runId}:${entrantId}`;
}

// Re-preparing an entrant reissues; the old token stops resolving immediately.
export function issueAgentToken(runId: string, entrantId: string): string {
  const key = entrantKey(runId, entrantId);
  const previous = byEntrant.get(key);
  if (previous !== undefined) byToken.delete(previous);

  const token = randomBytes(24).toString('hex');
  byToken.set(token, { runId, entrantId });
  byEntrant.set(key, token);
  return token;
}

export function resolveAgentToken(token: string, agentTokens?: AgentTokens): AgentIdentityRecord | undefined {
  return byToken.get(token) ?? agentTokens?.resolve(token);
}

export function revokeAgentToken(runId: string, entrantId: string): void {
  const key = entrantKey(runId, entrantId);
  const token = byEntrant.get(key);
  if (token !== undefined) byToken.delete(token);
  byEntrant.delete(key);
}

// Agent tool output can echo $ARENA_AGENT_TOKEN just like the wallet key, so the
// journal scrubs live tokens on the same path (see journal.append).
export function agentTokenSecrets(runId: string): readonly string[] {
  const secrets: string[] = [];
  for (const [token, record] of byToken) {
    if (record.runId === runId) secrets.push(token);
  }
  return secrets;
}

export type AgentTokenInspection =
  | { state: 'unknown' }
  | { state: 'expired'; expiresAt: string }
  | { state: 'live'; record: AgentIdentityRecord };

// Each server owns its lookup and rate state; SQLite remains the token authority.
export class AgentTokens {
  private readonly states = new Map<string, AgentIdentityRecord>();

  constructor(private readonly database: ArenaDatabase) {}

  register(address: string, consumeNonce: () => void): { address: string; token: string; expiresAt: string; created: boolean } {
    address = getAddress(address);
    return this.database.transaction(() => {
      const previous = this.database.select().from(agentTokens).where(eq(agentTokens.address, address)).get();
      const token = mintAgentToken();
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + AGENT_TOKEN_LIFETIME_MS).toISOString();
      const row = { address, tokenHash: tokenHash(token), createdAt, expiresAt };
      this.database.insert(agentTokens).values(row).onConflictDoUpdate({ target: agentTokens.address, set: row }).run();
      consumeNonce();
      if (previous !== undefined) this.states.delete(previous.tokenHash);
      return { address, token, expiresAt, created: previous === undefined };
    });
  }

  liveLane(address: string): { runId: string; entrantId: string } | undefined {
    return this.database.select({ runId: externalEntrants.runId, entrantId: externalEntrants.id })
      .from(externalEntrants).innerJoin(runs, eq(runs.id, externalEntrants.runId))
      .where(and(eq(externalEntrants.address, address), isNull(externalEntrants.removedAt),
        notInArray(runs.state, TERMINAL_RUN_STATES)))
      .orderBy(desc(externalEntrants.joinedAt)).get();
  }

  resolve(token: string): AgentIdentityRecord | undefined {
    const inspected = this.inspect(token);
    return inspected.state === 'live' ? inspected.record : undefined;
  }

  inspect(token: string): AgentTokenInspection {
    if (token.match(AGENT_TOKEN_PATTERN)?.[0] !== token) return { state: 'unknown' };
    const hash = tokenHash(token);
    const wallet = this.database.select().from(agentTokens).where(eq(agentTokens.tokenHash, hash)).get();
    if (wallet === undefined || Date.parse(wallet.expiresAt) <= Date.now()) {
      this.states.delete(hash);
      return wallet === undefined ? { state: 'unknown' } : { state: 'expired', expiresAt: wallet.expiresAt };
    }
    const state = this.states.get(hash) ?? { address: wallet.address };
    const lane = this.liveLane(wallet.address);
    // Avoid rewriting unchanged lane fields so a handler mid-flight keeps the lane it validated.
    if (state.runId !== lane?.runId || state.entrantId !== lane?.entrantId) {
      if (lane === undefined) {
        delete state.runId;
        delete state.entrantId;
      } else {
        Object.assign(state, lane);
      }
    }
    this.states.set(hash, state);
    return { state: 'live', record: state };
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
