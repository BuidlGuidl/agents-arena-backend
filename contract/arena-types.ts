export type RunState =
  | 'created'
  | 'awaiting_signature'
  | 'preparing'
  | 'awaiting_funding'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'finished'
  | 'failed';

export type EntrantStatus = 'working' | 'idle' | 'blocked' | 'done';

export const HARNESS_IDS = ['codex', 'opencode', 'claude'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const ROSTER_MODELS: Readonly<Record<HarnessId, readonly string[]>> = {
  codex: ['gpt-5.5', 'gpt-5.6-sol'],
  claude: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5'],
  opencode: [
    'openrouter/z-ai/glm-5.2',
    'openrouter/moonshotai/kimi-k3',
    'openrouter/deepseek/deepseek-v4-flash-0731',
  ],
};

export const ROSTER_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type RosterEffort = (typeof ROSTER_EFFORTS)[number];

export interface EntrantSolve {
  challengeId: number;
  ts: string;
  txHash: string;
}

export interface EntrantSummary {
  id: string;
  harness: HarnessId;
  model: string;
  effort?: RosterEffort;
  address: string | null;
  status: EntrantStatus;
  flags: number;
  solves: EntrantSolve[];
  inputTokens: number;
  outputTokens: number;
  // USD across the turns that carried a cost; null when none did. Display only —
  // harnesses on a subscription login report tokens without a price.
  costUsd: number | null;
  // A guess, not a report: the last challenge the entrant's commands touched
  // (see entrant.challenge). Null until a command names one.
  currentChallengeId: number | null;
}

export interface RunSnapshot {
  id: string;
  state: RunState;
  preset: string;
  entrants: EntrantSummary[];
  startedAt: string | null;
  deadlineAt: string | null;
  lastEventId: number;
}

export interface ArenaEventBase {
  id: number;
  runId: string;
  source: string;
  seq: number;
  ts: string;
  truncated?: Record<string, { fullLength: number; lines: number }>;
}

export type ArenaEvent =
  | (ArenaEventBase & { type: 'run.state'; payload: { state: RunState; reason?: string } })
  | (ArenaEventBase & { type: 'entrant.status'; payload: { entrantId: string; status: EntrantStatus } })
  | (ArenaEventBase & { type: 'agent.message'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'agent.reasoning'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'tool.call'; payload: { entrantId: string; tool: string; toolCallId: string; detail: string } })
  | (ArenaEventBase & { type: 'tool.result'; payload: { entrantId: string; tool: string; toolCallId: string; ok: boolean; detail: string } })
  | (ArenaEventBase & { type: 'entrant.steered'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'entrant.prompt'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'entrant.nudged'; payload: { entrantId: string; text: string; flags: number } })
  | (ArenaEventBase & { type: 'director.broadcast'; payload: { text: string; targetEntrantIds: string[] } })
  | (ArenaEventBase & { type: 'wallet.assigned'; payload: { entrantId: string; address: string } })
  | (ArenaEventBase & { type: 'funding.balance'; payload: { entrantId: string; address: string; wei: string; funded: boolean } })
  | (ArenaEventBase & { type: 'score.flag'; payload: { entrantId: string; challengeId: number; txHash: string; tokenId: string } })
  // The agent's own announcement of the challenge it works on, through
  // POST /agent/progress. Fires only when the value changes, and is append-only:
  // the UI takes the latest one per entrant (#4).
  | (ArenaEventBase & { type: 'entrant.challenge'; payload: { entrantId: string; challengeId: number } })
  | (ArenaEventBase & { type: 'entrant.error'; payload: { entrantId: string; message: string } })
  | (ArenaEventBase & { type: 'run.error'; payload: { message: string } })
  // Tokens count only what this event covers — codex emits one per turn, opencode
  // one per step, so events are not turns. inputTokens is the whole prompt, with
  // cachedInputTokens, the part served from cache, counted inside it. Harnesses
  // disagree on both points upstream (codex reports a running session total,
  // opencode reports its input net of cache), so the adapters normalize to this
  // shape. Cached tokens bill cheaper, which is why cost needs them broken out.
  | (ArenaEventBase & {
    type: 'usage';
    payload: {
      entrantId: string;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      costUsd: number | null;
    };
  });

export interface HistoryPage {
  events: ArenaEvent[];
  hasMore: boolean;
  // Absent on immutable pages, whose bodies must never change. Read the SSE
  // resume cursor from a page without `before`.
  lastEventId?: number;
}

export interface RosterEntry {
  id: string;
  harness: HarnessId;
  model: string;
  effort?: RosterEffort;
}

export interface CreateRunRequest {
  preset: string;
  autoStart?: boolean;
  idempotencyKey?: string;
  roster?: RosterEntry[];
}

export interface CreateRunResponse {
  run: RunSnapshot;
}

export interface SteerRequest {
  text: string;
}

export interface BroadcastRequest {
  text: string;
}

// One entrant failing to take the message does not fail the broadcast, so the
// response names both sides: who received the turn and who could not.
export interface BroadcastResponse {
  accepted: boolean;
  delivered: string[];
  failed: { entrantId: string; message: string }[];
}

export interface NonceResponse {
  nonce: string;
}

// The EIP-4361 message the operator's wallet signed, verbatim, plus its signature.
export interface VerifyRequest {
  message: string;
  signature: string;
}

export interface VerifyResponse {
  address: string;
  expiresAt: string;
}

// `configured` is false when the backend has no operator allowlist, so a page can
// hide its sign-in control instead of offering one that can only answer 503.
export type SessionResponse =
  | { authenticated: false; configured: boolean }
  | { authenticated: true; address: string; expiresAt: string };
