import { describe, expect, it } from 'vitest';

import type { ArenaEvent, RunState } from '../../../contract/arena-types';
import { runPhase, styleForEvent } from './event-style';

describe('runPhase', () => {
  it('treats both pre-race waits as preparing', () => {
    expect(runPhase('awaiting_signature')).toBe('preparing');
    expect(runPhase('awaiting_funding')).toBe('preparing');
    expect(runPhase('preparing')).toBe('preparing');
    expect(runPhase('ready')).toBe('preparing');
  });

  it('maps the rest of the lifecycle', () => {
    expect(runPhase(undefined)).toBe('idle');
    expect(runPhase('created')).toBe('idle');
    expect(runPhase('running')).toBe('running');
    expect(runPhase('stopping')).toBe('running');
    expect(runPhase('finished')).toBe('finished');
    expect(runPhase('failed')).toBe('failed');
  });

  it('gives every contract state a phase, so no state renders unstyled', () => {
    const states: RunState[] = [
      'created',
      'awaiting_signature',
      'preparing',
      'awaiting_funding',
      'ready',
      'running',
      'stopping',
      'finished',
      'failed',
    ];
    for (const state of states) {
      expect(runPhase(state)).not.toBe(undefined);
    }
  });
});

describe('styleForEvent', () => {
  const base = { id: 1, runId: 'run-1', source: 'codex-1', seq: 1, ts: 'now' };

  it('tags the chain events the waiting room depends on', () => {
    const assigned: ArenaEvent = {
      ...base,
      type: 'wallet.assigned',
      payload: { entrantId: 'codex-1', address: '0xabc' },
    };
    const balance: ArenaEvent = {
      ...base,
      type: 'funding.balance',
      payload: { entrantId: 'codex-1', address: '0xabc', wei: '1', funded: false },
    };
    expect(styleForEvent(assigned)).toEqual({ tone: 'chain', tag: 'chain' });
    expect(styleForEvent(balance)).toEqual({ tone: 'chain', tag: 'chain' });
  });

  it('falls back to a system tone for a type the UI does not know', () => {
    const unknown = { ...base, type: 'future.type', payload: {} } as unknown as ArenaEvent;
    expect(styleForEvent(unknown)).toEqual({ tone: 'system', tag: 'evt' });
  });
});
