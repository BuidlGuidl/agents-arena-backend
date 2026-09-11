import { describe, expect, it } from 'vitest';

import type { AgentOption } from '../../../contract/arena-types';
import {
  assignIds,
  buildRoster,
  laneOrder,
  newDraft,
  type DraftEntrant,
} from './roster';

const agents: AgentOption[] = [
  { harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', vendor: 'OpenAI', efforts: ['low', 'high', 'xhigh'] },
  { harness: 'claude', model: 'claude-opus-5', label: 'Opus 5', vendor: 'Anthropic', efforts: ['medium', 'max'] },
  { harness: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', vendor: 'Anthropic', efforts: ['medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/example/model', label: 'Model', vendor: 'Example', efforts: ['high'] },
];

describe('assignIds', () => {
  it('numbers per harness in row order', () => {
    const drafts = [newDraft('codex', agents)!, newDraft('claude', agents)!, newDraft('codex', agents)!];
    expect(assignIds(drafts)).toEqual(['codex-1', 'claude-1', 'codex-2']);
  });
});

describe('laneOrder', () => {
  it('gives each row the board position its id sorts into', () => {
    const { entries } = buildRoster([newDraft('codex', agents)!, newDraft('claude', agents)!, newDraft('codex', agents)!], agents);
    expect(laneOrder(entries)).toEqual([1, 0, 2]);
  });
});

describe('newDraft', () => {
  it('returns null when the harness has no agent', () => {
    expect(newDraft('codex', [])).toBeNull();
  });

  it('starts on the first fetched model for the harness, with its first effort', () => {
    for (const harness of ['codex', 'claude', 'opencode'] as const) {
      const draft = newDraft(harness, agents)!;
      const agent = agents.find((agent) => agent.harness === harness)!;
      expect(draft.model).toBe(agent.model);
      expect(draft.effort).toBe(agent.efforts[0]);
    }
  });
});

describe('buildRoster', () => {
  it('accepts two rows of the same harness on different models', () => {
    const draft = buildRoster([
      newDraft('claude', agents)!,
      { ...newDraft('claude', agents)!, model: 'claude-sonnet-5' },
    ], agents);
    expect(draft.problem).toBeNull();
    expect(draft.entries).toEqual([
      { id: 'claude-1', harness: 'claude', model: 'claude-opus-5', effort: 'medium' },
      { id: 'claude-2', harness: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    ]);
  });

  it('includes picked effort for every harness and keeps the first effort', () => {
    const { entries } = buildRoster([
      { ...newDraft('codex', agents)!, effort: 'xhigh' },
      newDraft('codex', agents)!,
      { ...newDraft('claude', agents)!, effort: 'max' },
      { ...newDraft('opencode', agents)!, effort: 'high' },
    ], agents);
    expect(entries[0]).toEqual({
      id: 'codex-1',
      harness: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(entries[1].effort).toBe('low');
    expect(entries[2]).toEqual({
      id: 'claude-1',
      harness: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
    });
    expect(entries[3]).toEqual({
      id: 'opencode-1',
      harness: 'opencode',
      model: 'openrouter/example/model',
      effort: 'high',
    });
  });

  it('reports the rules the backend enforces', () => {
    const offList: DraftEntrant = { harness: 'codex', model: 'gpt-4o', effort: 'low' };
    expect(buildRoster([], agents).problem).toBe('add at least one entrant.');
    expect(buildRoster([offList], agents).problem).toBe('codex-1: codex does not run gpt-4o.');
    expect(buildRoster(Array.from({ length: 11 }, () => newDraft('codex', agents)!), agents).problem)
      .toBe('10 entrants max.');
  });

  it('rejects an effort outside the agent list', () => {
    expect(buildRoster([{ ...newDraft('codex', agents)!, effort: 'max' }], agents).problem)
      .toBe('codex-1: gpt-5.5 accepts effort low, high, xhigh.');
  });

  it('pins the first effort for OpenCode', () => {
    const { entries, problem } = buildRoster([newDraft('opencode', agents)!], agents);
    expect(problem).toBeNull();
    expect(entries[0].effort).toBe('high');
  });
});
