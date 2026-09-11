import type { AgentOption, AgentsResponse, HarnessId, RosterEntry, ValidationErrorResponse } from '../contract.js';
import { CURATED_AGENTS, HARNESSES } from './curated.js';
import { OPENROUTER_MODEL_PREFIX, OpenRouterUnavailableError, type OpenRouterModelSource } from './openrouter.js';

export { OpenRouterUnavailableError } from './openrouter.js';

export interface AgentRegistry {
  list(): AgentsResponse;
  search(harness: HarnessId, query: string): Promise<readonly AgentOption[]>;
  // Curated hits work offline. Only a lookup that needs OpenRouter can throw
  // OpenRouterUnavailableError.
  resolve(harness: HarnessId, model: string): Promise<AgentOption | null>;
}

export function createAgentRegistry(options: { openRouter?: OpenRouterModelSource } = {}): AgentRegistry {
  // The source behind custom models for a harness, or undefined when the harness
  // takes none or no source is configured. Returning the source keeps the null check
  // visible to the compiler at each call site.
  const customModelSource = (harness: HarnessId): OpenRouterModelSource | undefined =>
    HARNESSES.some((entry) => entry.id === harness && entry.customModels) ? options.openRouter : undefined;
  return {
    list() {
      return {
        harnesses: HARNESSES.map((harness) => ({
          ...harness,
          customModels: customModelSource(harness.id) !== undefined,
        })),
        agents: [...CURATED_AGENTS],
      };
    },
    // Propagate failures so the operator sees degraded search; a typed model must not look absent.
    async search(harness, query) {
      const needle = query.trim().toLowerCase();
      const matches = (agent: AgentOption) => agent.harness === harness
        && [agent.model, agent.label, agent.vendor].some((value) => value.toLowerCase().includes(needle));
      const curated = CURATED_AGENTS.filter(matches);
      const source = customModelSource(harness);
      if (source === undefined || curated.length >= 20) return curated.slice(0, 20);
      const ids = new Set(CURATED_AGENTS.filter((agent) => agent.harness === harness).map((agent) => agent.model));
      const custom = (await source.list())
        .filter((agent) => matches(agent) && !ids.has(agent.model))
        // The order must not depend on the runtime locale.
        .sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
      return [...curated, ...custom].slice(0, 20);
    },
    async resolve(harness, model) {
      const curated = CURATED_AGENTS.find((agent) => agent.harness === harness && agent.model === model);
      if (curated) return curated;
      const source = customModelSource(harness);
      if (source === undefined || !model.startsWith(OPENROUTER_MODEL_PREFIX)) return null;
      return (await source.list()).find((agent) => agent.model === model) ?? null;
    },
  };
}

export async function rosterIssues(
  registry: AgentRegistry,
  roster: readonly RosterEntry[],
): Promise<ValidationErrorResponse['issues']> {
  const issues = await Promise.all(roster.map(async (entry, index) => {
    const path = ['roster', index, 'model'];
    let agent: AgentOption | null;
    try {
      agent = await registry.resolve(entry.harness, entry.model);
    } catch (error) {
      if (!(error instanceof OpenRouterUnavailableError)) throw error;
      return [{ path, message: `could not verify ${entry.model} against OpenRouter; retry or pick a listed model` }];
    }
    if (agent === null) {
      const suffix = entry.harness === 'opencode'
        ? '; pick a listed model or an OpenRouter model that supports reasoning' : '';
      return [{ path, message: `${entry.harness} does not run ${entry.model}${suffix}` }];
    }
    if (!agent.efforts.includes(entry.effort)) {
      return [{ path: ['roster', index, 'effort'], message: `${entry.model} accepts effort ${agent.efforts.join(', ')}` }];
    }
    return [];
  }));
  return issues.flat();
}
