import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, notInArray } from 'drizzle-orm';

import { TERMINAL_RUN_STATES } from './contract.js';
import type { ArenaDatabase } from './db/index.js';
import { externalEntrants, runs } from './db/schema.js';

export const EXTERNAL_TOKEN_PATTERN = /byoa_[0-9a-f]{48}/;

export function mintExternalToken(): string {
  return `byoa_${randomBytes(24).toString('hex')}`;
}

// Hosted credentials live in memory and die with their containers. External
// credentials use the database-backed store below. Both resolve through one function.

export interface AgentTokenRecord {
  runId: string;
  entrantId: string;
  // Route-level state: when the last journalled announcement landed (rate
  // limit). Dedupe lives in the shared current-challenge store, which the
  // command heuristic reads and moves too.
  lastAnnouncedAtMs?: number;
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

export function resolveAgentToken(token: string, external?: ExternalAgentTokens): AgentTokenRecord | undefined {
  return byToken.get(token) ?? external?.resolve(token);
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

// Each server owns its lookup and rate state; SQLite remains the token authority.
export class ExternalAgentTokens {
  private readonly states = new Map<string, AgentTokenRecord>();

  constructor(private readonly database: ArenaDatabase) {}

  issue(runId: string, entrantId: string): string {
    this.revoke(runId, entrantId);
    const token = mintExternalToken();
    this.database.update(externalEntrants).set({ tokenHash: tokenHash(token) })
      .where(and(eq(externalEntrants.runId, runId), eq(externalEntrants.id, entrantId))).run();
    return token;
  }

  resolve(token: string): AgentTokenRecord | undefined {
    if (token.match(EXTERNAL_TOKEN_PATTERN)?.[0] !== token) return undefined;
    const hash = tokenHash(token);
    const row = this.database.select({ runId: externalEntrants.runId, entrantId: externalEntrants.id })
      .from(externalEntrants).innerJoin(runs, eq(runs.id, externalEntrants.runId))
      .where(and(eq(externalEntrants.tokenHash, hash), isNull(externalEntrants.removedAt),
        notInArray(runs.state, TERMINAL_RUN_STATES))).get();
    if (row === undefined) {
      this.states.delete(hash);
      return undefined;
    }
    const state = this.states.get(hash) ?? row;
    this.states.set(hash, state);
    return state;
  }

  revoke(runId: string, entrantId: string): void {
    const where = and(eq(externalEntrants.runId, runId), eq(externalEntrants.id, entrantId));
    const previous = this.database.select({ hash: externalEntrants.tokenHash })
      .from(externalEntrants).where(where).get();
    if (previous?.hash != null) this.states.delete(previous.hash);
    this.database.update(externalEntrants).set({ tokenHash: null }).where(where).run();
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
