export type RunState =
  | 'created'
  | 'preparing'
  | 'awaiting_funding'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'finished'
  | 'failed';

export type EntrantStatus = 'working' | 'idle' | 'blocked' | 'done';

export type HarnessId = 'codex' | 'opencode' | 'claude';

export interface EntrantSolve {
  challengeId: number;
  ts: string;
  txHash: string;
}

export interface EntrantSummary {
  id: string;
  harness: HarnessId;
  model: string;
  address: string | null;
  status: EntrantStatus;
  flags: number;
  solves: EntrantSolve[];
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
}

export type ArenaEvent =
  | (ArenaEventBase & { type: 'run.state'; payload: { state: RunState; reason?: string } })
  | (ArenaEventBase & { type: 'entrant.status'; payload: { entrantId: string; status: EntrantStatus } })
  | (ArenaEventBase & { type: 'agent.message'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'agent.reasoning'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'tool.call'; payload: { entrantId: string; tool: string; detail: string } })
  | (ArenaEventBase & { type: 'tool.result'; payload: { entrantId: string; tool: string; ok: boolean; detail: string } })
  | (ArenaEventBase & { type: 'entrant.steered'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'entrant.prompt'; payload: { entrantId: string; text: string } })
  | (ArenaEventBase & { type: 'entrant.nudged'; payload: { entrantId: string; text: string; flags: number } })
  | (ArenaEventBase & { type: 'wallet.assigned'; payload: { entrantId: string; address: string } })
  | (ArenaEventBase & { type: 'funding.balance'; payload: { entrantId: string; address: string; wei: string; funded: boolean } })
  | (ArenaEventBase & { type: 'score.flag'; payload: { entrantId: string; challengeId: number; txHash: string; tokenId: string } })
  | (ArenaEventBase & { type: 'entrant.error'; payload: { entrantId: string; message: string } })
  | (ArenaEventBase & { type: 'run.error'; payload: { message: string } })
  | (ArenaEventBase & { type: 'usage'; payload: { entrantId: string; inputTokens: number; outputTokens: number } });

export interface CreateRunRequest {
  preset: string;
  autoStart?: boolean;
  idempotencyKey?: string;
}

export interface CreateRunResponse {
  run: RunSnapshot;
}

export interface SteerRequest {
  text: string;
}
