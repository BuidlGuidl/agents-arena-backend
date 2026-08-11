import type {
  EntrantStatus,
  HarnessId,
  RosterEffort,
  RunState,
  SteerDelivery,
} from '../contract.js';

export interface RunRecord {
  id: string;
  state: RunState;
  preset: string;
  startedAt: string | null;
  deadlineAt: string | null;
  durationMs: number | null;
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
  steer(run: RunRecord, entrant: EntrantRecord, text: string): Promise<SteerDelivery>;
  // Recovery for one lane: abandon whatever session the entrant has and open a
  // fresh one with the opening prompt. Everything the entrant was given to race
  // with — its container, wallet, and credentials — is kept.
  restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void>;
  stop(run: RunRecord, entrant: EntrantRecord): Promise<void>;
}
