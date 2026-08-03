import type { EntrantStatus, HarnessId, RosterEffort, RunState } from '../contract.js';

export interface RunRecord {
  id: string;
  state: RunState;
  preset: string;
  startedAt: string | null;
  deadlineAt: string | null;
  idempotencyKey: string | null;
}

export interface EntrantRecord {
  runId: string;
  id: string;
  harness: HarnessId;
  model: string;
  effort: RosterEffort | null;
  address: string | null;
  status: EntrantStatus;
}

// The entrant exists but cannot take a turn right now — stopping, or degraded.
// Thrown rather than swallowed so a steer never reports success it did not have,
// and so a broadcast can name the lane that missed the message.
export class EntrantUnavailableError extends Error {}

export interface EntrantDriver {
  prepare(run: RunRecord, entrant: EntrantRecord): Promise<void>;
  start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void>;
  steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<void>;
  stop(run: RunRecord, entrant: EntrantRecord): Promise<void>;
}
