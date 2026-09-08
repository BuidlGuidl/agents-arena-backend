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
  seededBy: string | null;
  idempotencyKey: string | null;
}

interface EntrantBase {
  runId: string;
  id: string;
  address: string | null;
  status: EntrantStatus;
}

export interface HostedEntrantRecord extends EntrantBase {
  kind: 'hosted';
  harness: HarnessId;
  model: string;
  effort: RosterEffort | null;
}

export interface ExternalEntrantRecord extends EntrantBase {
  kind: 'external';
  name: string;
  harness?: string;
  model?: string;
  effort?: string;
  url?: string;
  joinedAt: string;
  removedAt: string | null;
  flagsBeforeJoin: number;
}

export type EntrantRecord = HostedEntrantRecord | ExternalEntrantRecord;

export function assertHosted(entrant: EntrantRecord): asserts entrant is HostedEntrantRecord {
  if (entrant.kind !== 'hosted') throw new Error('Expected a hosted entrant');
}

export function assertExternal(entrant: EntrantRecord): asserts entrant is ExternalEntrantRecord {
  if (entrant.kind !== 'external') throw new Error('Expected an external entrant');
}

// The entrant exists but cannot take a turn right now — stopping, or degraded.
// Thrown rather than swallowed so a steer never reports success it did not have,
// and so a broadcast can name the lane that missed the message.
export class EntrantUnavailableError extends Error {}
export class EntrantOperationError extends Error {}

export interface EntrantDriver {
  prepare(run: RunRecord, entrant: EntrantRecord): Promise<void>;
  start(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void>;
  steer(run: RunRecord, entrant: EntrantRecord, text: string, origin?: 'steer' | 'broadcast'): Promise<SteerDelivery>;
  // Recovery for one lane: abandon whatever session the entrant has and open a
  // fresh one with the opening prompt. Everything the entrant was given to race
  // with — its container, wallet, and credentials — is kept.
  restart(run: RunRecord, entrant: EntrantRecord, openingPrompt: string): Promise<void>;
  stop(run: RunRecord, entrant: EntrantRecord): Promise<void>;
}
