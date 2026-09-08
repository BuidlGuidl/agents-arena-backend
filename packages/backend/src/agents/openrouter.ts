import { z } from 'zod';

import type { AgentOption } from '../contract.js';

export interface OpenRouterModelSource {
  list(): Promise<readonly AgentOption[]>;
}

export class OpenRouterUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('OpenRouter model list is unavailable', options);
    this.name = 'OpenRouterUnavailableError';
  }
}

export const OPENROUTER_MODEL_PREFIX = 'openrouter/';

// A 30-second minimum retry delay protects an empty cache and a disabled TTL during outages.
const FAILURE_COOLDOWN_MS = 30_000;

const responseSchema = z.object({ data: z.array(z.unknown()) });
const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  architecture: z.object({ output_modalities: z.array(z.string()) }).optional(),
  supported_parameters: z.array(z.string()).optional(),
});

export function createOpenRouterModelSource(options: {
  fetch?: typeof fetch;
  ttlMs?: number;
  url?: string;
  logger?: { warn(message: string): void };
} = {}): OpenRouterModelSource {
  const fetchModels = options.fetch ?? globalThis.fetch;
  let cached: readonly AgentOption[] | undefined;
  let fetchedAt = 0;
  let failedAt: number | undefined;
  const ttlMs = options.ttlMs ?? 600_000;
  let pending: Promise<readonly AgentOption[]> | undefined;

  async function refresh(): Promise<readonly AgentOption[]> {
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchModels(options.url ?? 'https://openrouter.ai/api/v1/models', {
        signal: timeout,
      });
      if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
      const body = responseSchema.parse(await response.json());
      const agents: AgentOption[] = [];
      for (const row of body.data) {
        const parsed = modelSchema.safeParse(row);
        if (!parsed.success) continue;
        const model = parsed.data;
        // Reasoning supports effort selection; tools let the coding harness act.
        // Text-only output fits the harness; ':' variants are rate-capped or asynchronous.
        // No '~' aliases: a pinned id must never change identity under the arena.
        if (!model.supported_parameters?.includes('reasoning')
          || !model.supported_parameters.includes('tools')
          || model.architecture?.output_modalities.length !== 1
          || model.architecture.output_modalities[0] !== 'text'
          || model.id.startsWith('~') || model.id.includes(':')) continue;
        const name = model.name ?? model.id;
        const separator = name.indexOf(': ');
        agents.push({
          harness: 'opencode',
          model: `${OPENROUTER_MODEL_PREFIX}${model.id}`,
          vendor: separator < 0 ? model.id.split('/')[0]! : name.slice(0, separator),
          label: separator < 0 ? name : name.slice(separator + 2),
          efforts: ['low', 'medium', 'high'],
        });
      }
      failedAt = undefined;
      cached = agents;
      fetchedAt = Date.now();
      return agents;
    } catch (cause) {
      failedAt = Date.now();
      if (cached !== undefined) {
        // A stale list beats a dead picker. Race day uses the offline curated path.
        // An outage must cost one outbound request per TTL, not one per HTTP request.
        fetchedAt = Date.now();
        options.logger?.warn('OpenRouter model list refresh failed; serving the cached list');
        return cached;
      }
      throw new OpenRouterUnavailableError({ cause });
    }
  }

  return {
    async list() {
      // Refresh on demand: no background timer keeps tests and shutdown simple.
      if (cached !== undefined && Date.now() - fetchedAt < ttlMs) return cached;
      if (failedAt !== undefined && Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
        if (cached !== undefined) return cached;
        throw new OpenRouterUnavailableError();
      }
      // Concurrent callers share one fetch so a busy picker cannot multiply requests.
      if (pending === undefined) {
        pending = refresh().finally(() => { pending = undefined; });
      }
      return pending;
    },
  };
}
