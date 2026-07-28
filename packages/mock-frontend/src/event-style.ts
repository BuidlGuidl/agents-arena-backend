import type { ArenaEvent } from '../../../contract/arena-types';

// Presentation-only classifier. Maps each ArenaEvent to a visual tone and a
// short tag shown on the feed row. No projection logic lives here — this only
// decides how an already-projected event looks.

export type EventTone =
  | 'system'
  | 'message'
  | 'reasoning'
  | 'tool'
  | 'tool-fail'
  | 'steer'
  | 'chain'
  | 'score'
  | 'usage'
  | 'error';

export interface EventStyle {
  tone: EventTone;
  tag: string; // three-to-five letter row label, lowercase
}

export function styleForEvent(event: ArenaEvent): EventStyle {
  switch (event.type) {
    case 'run.state':
    case 'entrant.status':
      return { tone: 'system', tag: 'sys' };
    case 'agent.message':
      return { tone: 'message', tag: 'msg' };
    case 'agent.reasoning':
      return { tone: 'reasoning', tag: 'think' };
    case 'tool.call':
      return { tone: 'tool', tag: 'call' };
    case 'tool.result':
      return { tone: event.payload.ok ? 'tool' : 'tool-fail', tag: 'result' };
    case 'entrant.steered':
      return { tone: 'steer', tag: 'steer' };
    case 'entrant.prompt':
      return { tone: 'steer', tag: 'task' };
    case 'entrant.nudged':
      return { tone: 'steer', tag: 'nudge' };
    case 'wallet.assigned':
    case 'funding.balance':
      return { tone: 'chain', tag: 'chain' };
    case 'score.flag':
      return { tone: 'score', tag: 'flag' };
    case 'usage':
      return { tone: 'usage', tag: 'tok' };
    case 'entrant.error':
    case 'run.error':
      return { tone: 'error', tag: 'err' };
    default:
      return { tone: 'system', tag: 'evt' };
  }
}

// Coarse phase for a run state, for the scoreboard status pill.
export function runPhase(state: string | undefined): 'idle' | 'preparing' | 'running' | 'finished' | 'failed' {
  switch (state) {
    case undefined:
    case 'created':
      return 'idle';
    case 'preparing':
    case 'awaiting_funding':
    case 'ready':
      return 'preparing';
    case 'running':
    case 'stopping':
      return 'running';
    case 'finished':
      return 'finished';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}
