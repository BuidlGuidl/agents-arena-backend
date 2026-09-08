import { z } from 'zod';

import type { AgentEventInput } from './contract.js';

export const claudeHookSchema = z.object({
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.object({ command: z.string().optional() }).passthrough().optional(),
  tool_response: z.union([
    z.object({ stdout: z.string().optional(), stderr: z.string().optional() }).passthrough(),
    z.string(), z.array(z.unknown()), z.number(), z.boolean(), z.null(),
  ]).optional(),
  error: z.string().optional(),
  last_assistant_message: z.string().optional(),
}).passthrough();

export type ClaudeHookPayload = z.infer<typeof claudeHookSchema>;

// seq is a placeholder; ingest assigns hook sequences independently of client dedupe.
export function claudeHookToAgentEvents(payload: ClaudeHookPayload): AgentEventInput[] {
  const tool = { seq: 0, tool: payload.tool_name ?? '', toolCallId: payload.tool_use_id ?? '' };
  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return [{ ...tool, type: 'tool.call', detail: payload.tool_input?.command ?? compact(payload.tool_input) }];
    case 'PostToolUse': {
      const response = payload.tool_response;
      const detail = response !== null && typeof response === 'object' && !Array.isArray(response)
        && (response.stdout !== undefined || response.stderr !== undefined)
        ? [response.stdout, response.stderr].filter((part) => part !== undefined && part !== '').join('\n')
        : compact(response);
      return [{ ...tool, type: 'tool.result', ok: true, detail }];
    }
    case 'PostToolUseFailure':
      return [{ ...tool, type: 'tool.result', ok: false, detail: payload.error ?? compact(payload.tool_response) }];
    case 'Stop':
      return payload.last_assistant_message
        ? [{ seq: 0, type: 'agent.message', text: payload.last_assistant_message }] : [];
    case 'SessionStart': return [{ seq: 0, type: 'entrant.status', status: 'working' }];
    case 'SessionEnd': return [{ seq: 0, type: 'entrant.status', status: 'idle' }];
    default: return [];
  }
}

function compact(value: unknown): string {
  return JSON.stringify(value ?? {});
}
