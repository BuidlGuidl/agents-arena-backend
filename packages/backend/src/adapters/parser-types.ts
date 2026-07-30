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

// One per entrant of a run, kept alive by the driver across the processes that
// harness's turns run in — a parser may carry state that spans them, as codex's
// does for its cumulative token counts.
export interface HarnessLineParser {
  parse(line: string): ParsedHarnessLine;
}
