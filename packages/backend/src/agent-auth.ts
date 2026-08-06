import { randomBytes } from 'node:crypto';

// Per-container bearer credentials for the agent-facing routes. Kept in process
// memory like the run wallet keys: one backend process serves one arena, and a
// token must die with its container, not survive a restart.

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

export function resolveAgentToken(token: string): AgentTokenRecord | undefined {
  return byToken.get(token);
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
