import type { ArenaEvent } from '../contract.js';

export type ParsedArenaEvent = ArenaEvent extends infer Event
  ? Event extends ArenaEvent
    ? Pick<Event, 'type' | 'payload'>
    : never
  : never;

export interface ParsedHarnessLine {
  events: ParsedArenaEvent[];
  sessionId?: string;
  turnEnded?: boolean;
}

export interface ParserLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface RecoveredUsage {
  // Cumulative across every session retained in this entrant's container.
  totals: UsageTotals;
  // Codex's stream is cumulative only within the active session, so its parser
  // baseline advances to this narrower value after recovery.
  parserTotals?: UsageTotals;
}

// One per entrant of a run, kept alive by the driver across the processes that
// harness's turns run in — a parser may carry state that spans them, as codex's
// does for its cumulative token counts.
export interface HarnessLineParser {
  parse(line: string): ParsedHarnessLine;
  // A killed Codex process never emits turn.completed. Session-file recovery
  // advances its cumulative baseline so the next natural completion does not
  // report the recovered tokens a second time.
  reconcileUsage?(totals: UsageTotals): void;
}
