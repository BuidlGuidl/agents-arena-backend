import { describe, expect, it } from 'vitest';

import { ROSTER_MODELS } from '../../../contract/arena-types';
import {
  assignIds,
  buildRoster,
  DEFAULT_EFFORT,
  draftEffort,
  laneOrder,
  newDraft,
  type DraftEntrant,
} from './roster';

describe('assignIds', () => {
  it('numbers per harness in row order', () => {
    const drafts = [newDraft('codex'), newDraft('claude'), newDraft('codex')];
    expect(assignIds(drafts)).toEqual(['codex-1', 'claude-1', 'codex-2']);
  });
});

describe('laneOrder', () => {
  it('gives each row the board position its id sorts into', () => {
    const { entries } = buildRoster([newDraft('codex'), newDraft('claude'), newDraft('codex')]);
    expect(laneOrder(entries)).toEqual([1, 0, 2]);
  });
});

describe('newDraft', () => {
  it('starts on the first allowlisted model for the harness, with no effort', () => {
    for (const harness of ['codex', 'claude', 'opencode'] as const) {
      const draft = newDraft(harness);
      expect(draft.model).toBe(ROSTER_MODELS[harness][0]);
      expect(draft.effort).toBe(DEFAULT_EFFORT);
    }
  });
});

describe('draftEffort', () => {
  it('sends a picked level for every harness and drops the default sentinel', () => {
    expect(draftEffort({ ...newDraft('codex'), effort: 'xhigh' })).toBe('xhigh');
    expect(draftEffort({ ...newDraft('claude'), effort: 'max' })).toBe('max');
    expect(draftEffort({ ...newDraft('opencode'), effort: 'high' })).toBe('high');
    expect(draftEffort(newDraft('claude'))).toBeUndefined();
    expect(draftEffort(newDraft('opencode'))).toBeUndefined();
  });
});

describe('buildRoster', () => {
  it('accepts two rows of the same harness on different models', () => {
    const draft = buildRoster([
      newDraft('claude'),
      { ...newDraft('claude'), model: 'claude-sonnet-5' },
    ]);
    expect(draft.problem).toBeNull();
    expect(draft.entries).toEqual([
      { id: 'claude-1', harness: 'claude', model: 'claude-opus-5' },
      { id: 'claude-2', harness: 'claude', model: 'claude-sonnet-5' },
    ]);
  });

  it('includes picked effort for every harness but omits defaults', () => {
    const { entries } = buildRoster([
      { ...newDraft('codex'), effort: 'xhigh' },
      newDraft('codex'),
      { ...newDraft('claude'), effort: 'max' },
      { ...newDraft('opencode'), effort: 'high' },
    ]);
    expect(entries[0]).toEqual({
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(entries[1]).not.toHaveProperty('effort');
    expect(entries[2]).toEqual({
      id: 'claude-1',
      harness: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
    });
    expect(entries[3]).toEqual({
      id: 'opencode-1',
      harness: 'opencode',
      model: 'openrouter/z-ai/glm-5.3',
      effort: 'high',
    });
  });

  it('reports the rules the backend enforces', () => {
    const offList: DraftEntrant = { harness: 'codex', model: 'gpt-4o', effort: DEFAULT_EFFORT };
    expect(buildRoster([]).problem).toBe('add at least one entrant.');
    expect(buildRoster([offList]).problem).toBe('codex-1: codex does not run gpt-4o.');
    expect(buildRoster(Array.from({ length: 11 }, () => newDraft('codex'))).problem)
      .toBe('10 entrants max.');
  });

  it('drops the default effort sentinel for OpenCode', () => {
    const { entries, problem } = buildRoster([newDraft('opencode')]);
    expect(problem).toBeNull();
    expect(entries[0]).not.toHaveProperty('effort');
  });
});
