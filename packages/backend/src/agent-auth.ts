import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, notInArray } from 'drizzle-orm';

import { TERMINAL_RUN_STATES } from './contract.js';
import type { ArenaDatabase } from './db/index.js';
import { externalEntrants, runs } from './db/schema.js';

export const AGENT_TOKEN_PATTERN = /byoa_[0-9a-f]{48}/;

export function mintRunPass(): string {
  return `byoa_${randomBytes(24).toString('hex')}`;
}

// Hosted credentials live in memory and die with their containers.
// Run passes use the database-backed store below. Both resolve through one function.

export interface AgentTokenRecord {
  runId: string;
  entrantId: string;
  address?: string;
  // Last journalled challenge announcement; request limits use this record.
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

export function resolveAgentToken(token: string, passes?: RunPasses): AgentTokenRecord | undefined {
  return byToken.get(token) ?? passes?.resolve(token);
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

// Each server preserves record identity because request limits key on the record object.
export class RunPasses {
  private readonly states = new Map<string, AgentTokenRecord>();

  constructor(private readonly database: ArenaDatabase) {}

  resolve(pass: string): AgentTokenRecord | undefined {
    if (pass.match(AGENT_TOKEN_PATTERN)?.[0] !== pass) return undefined;
    const hash = passHash(pass);
    const lane = this.database.select({ runId: externalEntrants.runId, entrantId: externalEntrants.id, address: externalEntrants.address })
      .from(externalEntrants).innerJoin(runs, eq(runs.id, externalEntrants.runId))
      .where(and(eq(externalEntrants.passHash, hash), isNull(externalEntrants.removedAt),
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

export function passHash(pass: string): string {
  return createHash('sha256').update(pass).digest('hex');
}
