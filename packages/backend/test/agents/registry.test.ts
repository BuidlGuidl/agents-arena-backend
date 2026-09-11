import { describe, expect, it, vi } from 'vitest';

import { CURATED_AGENTS } from '../../src/agents/curated.js';
import { OpenRouterUnavailableError } from '../../src/agents/openrouter.js';
import { createAgentRegistry, rosterIssues } from '../../src/agents/registry.js';
import type { AgentOption } from '../../src/contract.js';

const custom: AgentOption = {
  harness: 'opencode', model: 'openrouter/google/gemini-3.1-pro-preview',
  label: 'Gemini 3.1 Pro Preview', vendor: 'Google', efforts: ['low', 'medium', 'high'],
};

describe('agent registry', () => {
  it('reports effective custom model support', () => {
    expect(createAgentRegistry().list().harnesses.every((harness) => !harness.customModels)).toBe(true);
    expect(createAgentRegistry({ openRouter: { list: async () => [] } }).list().harnesses)
      .toContainEqual({ id: 'opencode', label: 'OpenCode', customModels: true });
    expect(createAgentRegistry().list().harnesses.map((harness) => harness.id)).toEqual(['codex', 'claude', 'opencode']);
  });

  it('ranks curated matches first, sorts custom ids, removes curated duplicates, and caps at 20', async () => {
    const curated = CURATED_AGENTS.filter((agent) => agent.harness === 'opencode');
    const extra = Array.from({ length: 30 }, (_, index) => ({ ...custom, model: `openrouter/google/${String(index).padStart(2, '0')}` }));
    const registry = createAgentRegistry({ openRouter: { list: async () => [...extra].reverse().concat(curated) } });
    const results = await registry.search('opencode', ' OPENROUTER/ ');
    expect(results).toHaveLength(20);
    expect(results).toEqual([...curated, ...extra].slice(0, 20));
    expect(await registry.search('opencode', ' gOoGlE ')).toEqual(extra.slice(0, 20));
    expect(await registry.search('opencode', 'Gemini')).toEqual(extra.slice(0, 20));
  });

  it('keeps codex and claude searches offline', async () => {
    const list = vi.fn().mockRejectedValue(new OpenRouterUnavailableError());
    const registry = createAgentRegistry({ openRouter: { list } });
    expect(await registry.search('codex', 'OpenAI')).toHaveLength(4);
    expect(await registry.search('claude', 'Opus')).toHaveLength(4);
    expect(list).not.toHaveBeenCalled();
    await expect(registry.search('opencode', 'glm')).rejects.toBeInstanceOf(OpenRouterUnavailableError);
  });

  it('resolves curated hits offline, custom OpenCode models through the source, and unknowns to null', async () => {
    const list = vi.fn().mockResolvedValue([custom]);
    const registry = createAgentRegistry({ openRouter: { list } });
    expect(await registry.resolve('codex', 'gpt-5.5')).toEqual(CURATED_AGENTS[0]);
    expect(await registry.resolve('opencode', 'openrouter/z-ai/glm-5.3')).not.toBeNull();
    expect(await registry.resolve('codex', custom.model)).toBeNull();
    expect(await registry.resolve('opencode', 'google/gemini')).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(await registry.resolve('opencode', custom.model)).toEqual(custom);
    expect(await registry.resolve('opencode', 'openrouter/unknown/model')).toBeNull();
    expect(await createAgentRegistry().resolve('opencode', custom.model)).toBeNull();
    expect(await createAgentRegistry().search('opencode', 'Google')).toEqual([]);
  });

  it('collects all model and effort issues in entry order', async () => {
    const registry = createAgentRegistry({ openRouter: { list: async () => { throw new OpenRouterUnavailableError(); } } });
    expect(await rosterIssues(registry, [
      { id: 'a', harness: 'codex', model: 'gpt-5.5', effort: 'max' },
      { id: 'b', harness: 'claude', model: 'unknown', effort: 'high' },
      { id: 'c', harness: 'opencode', model: custom.model, effort: 'high' },
    ])).toEqual([
      { path: ['roster', 0, 'effort'], message: 'gpt-5.5 accepts effort low, medium, high, xhigh' },
      { path: ['roster', 1, 'model'], message: 'claude does not run unknown' },
      { path: ['roster', 2, 'model'], message: `could not verify ${custom.model} against OpenRouter; retry or pick a listed model` },
    ]);
  });
});
