import type { AgentOption, HarnessInfo } from '../contract.js';

export const HARNESSES: readonly HarnessInfo[] = [
  { id: 'codex', label: 'Codex CLI', customModels: false },
  { id: 'claude', label: 'Claude Code', customModels: false },
  { id: 'opencode', label: 'OpenCode', customModels: true },
];

// Efforts verified 2026-09-08 against the Codex model cache and Claude Code docs:
// https://code.claude.com/docs/en/model-config.md
// Sonnet 4.5 and Haiku 4.5 are absent: Claude Code has no effort setting for them.
export const CURATED_AGENTS: readonly AgentOption[] = [
  // gpt-5.5 has no max effort.
  { harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', vendor: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh'] },
  // Dropped in #48 after refusing the briefing on its first turn.
  // Re-listed unrehearsed after the briefing changed (#76).
  { harness: 'codex', model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', vendor: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { harness: 'codex', model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', vendor: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { harness: 'codex', model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', vendor: 'OpenAI', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-opus-5', label: 'Opus 5', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-opus-4-8', label: 'Opus 4.8', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-opus-4-7', label: 'Opus 4.7', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-opus-4-6', label: 'Opus 4.6', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'max'] },
  { harness: 'claude', model: 'claude-sonnet-5', label: 'Sonnet 5', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-sonnet-4-6', label: 'Sonnet 4.6', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'max'] },
  // claude-fable-5-1 is the API id; not yet rehearsed in a container.
  { harness: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'claude', model: 'claude-fable-5', label: 'Fable 5', vendor: 'Anthropic', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { harness: 'opencode', model: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', vendor: 'xAI', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/z-ai/glm-5.3', label: 'GLM-5.3', vendor: 'Z.ai', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/z-ai/glm-5.3-flash', label: 'GLM-5.3 Flash', vendor: 'Z.ai', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3', vendor: 'Moonshot', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', vendor: 'Moonshot', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/minimax/minimax-m3', label: 'MiniMax M3', vendor: 'MiniMax', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/minimax/minimax-m2.7', label: 'MiniMax M2.7', vendor: 'MiniMax', efforts: ['low', 'medium', 'high'] },
  // OpenRouter renamed this id; the bare id is a stale OpenCode cache entry.
  { harness: 'opencode', model: 'openrouter/qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max', vendor: 'Alibaba', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/qwen/qwen3.8-flash', label: 'Qwen3.8 Flash', vendor: 'Alibaba', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/qwen/qwen3.7-max', label: 'Qwen3.7 Max', vendor: 'Alibaba', efforts: ['low', 'medium', 'high'] },
  // On today's list and raced last week (#73); keeps the frontend default race working.
  { harness: 'opencode', model: 'openrouter/qwen/qwen3.8-2.4t-a95b', label: 'Qwen3.8 2.4T', vendor: 'Alibaba', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek', efforts: ['low', 'medium', 'high'] },
  // On today's list and raced last week (#73); keeps the frontend default race working.
  { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro (0813)', vendor: 'DeepSeek', efforts: ['low', 'medium', 'high'] },
  { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', efforts: ['low', 'medium', 'high'] },
];
