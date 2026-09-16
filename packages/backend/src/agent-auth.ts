import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, isNotNull, notInArray } from 'drizzle-orm';

import { TERMINAL_RUN_STATES } from './contract.js';
import type { ArenaDatabase } from './db/index.js';
import { externalEntrants, runs } from './db/schema.js';

export const AGENT_TOKEN_PATTERN = /byoa_[0-9a-f]{48}/;

export function mintArenaToken(): string {
  return `byoa_${randomBytes(24).toString('hex')}`;
}

// Hosted credentials live in memory and die with their containers.
// Arena tokens use the database-backed store below. Both resolve through one function.

export interface AgentTokenRecord {
  runId: string;
  entrantId: string;
  address?: string;
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

export function resolveAgentToken(token: string, arenaTokens?: ArenaTokens): AgentTokenRecord | undefined {
  return byToken.get(token) ?? arenaTokens?.resolve(token);
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

// Each server caches resolved token records.
export class ArenaTokens {
  private readonly states = new Map<string, AgentTokenRecord>();

  constructor(private readonly database: ArenaDatabase) {}

  removalMessage(token: string): string | undefined {
    const lane = this.database.select().from(externalEntrants)
      .where(and(eq(externalEntrants.arenaTokenHash, arenaTokenHash(token)), isNotNull(externalEntrants.removedAt))).get();
    return lane?.removedReason == null ? undefined : `This lane was removed. ${lane.removedReason}`;
  }

  resolve(token: string): AgentTokenRecord | undefined {
    if (token.match(AGENT_TOKEN_PATTERN)?.[0] !== token) return undefined;
    const hash = arenaTokenHash(token);
    const lane = this.database.select({ runId: externalEntrants.runId, entrantId: externalEntrants.id, address: externalEntrants.address })
      .from(externalEntrants).innerJoin(runs, eq(runs.id, externalEntrants.runId))
      .where(and(eq(externalEntrants.arenaTokenHash, hash), isNull(externalEntrants.removedAt),
        notInArray(runs.state, TERMINAL_RUN_STATES))).get();
    if (lane === undefined) {
      this.states.delete(hash);
      return undefined;
    }
    const record = this.states.get(hash) ?? lane;
    this.states.set(hash, record);
    return record;
  }
}

export function arenaTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
