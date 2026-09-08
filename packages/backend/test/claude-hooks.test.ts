import { describe, expect, it } from 'vitest';

import { claudeHookToAgentEvents } from '../src/claude-hooks.js';

const base = { session_id: 'session-1', cwd: '/work/ctf', permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'toolu_01' };
const tool = { seq: 0, tool: 'Bash', toolCallId: 'toolu_01' };

describe('Claude Code hook mapping', () => {
  it('maps PreToolUse Bash commands', () => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'PreToolUse', tool_input: { command: 'forge test', description: 'Run tests' } }))
      .toEqual([{ ...tool, type: 'tool.call', detail: 'forge test' }]);
  });

  it('maps PostToolUse stdout and stderr', () => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: 'passed', stderr: 'warning', interrupted: false } }))
      .toEqual([{ ...tool, type: 'tool.result', ok: true, detail: 'passed\nwarning' }]);
  });

  it('maps PostToolUseFailure errors', () => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'PostToolUseFailure', error: 'Command exited with code 1', is_interrupt: false }))
      .toEqual([{ ...tool, type: 'tool.result', ok: false, detail: 'Command exited with code 1' }]);
  });

  it('maps Stop assistant text', () => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Starting challenge 7.', stop_hook_active: false }))
      .toEqual([{ seq: 0, type: 'agent.message', text: 'Starting challenge 7.' }]);
  });

  it.each([['SessionStart', 'working'], ['SessionEnd', 'idle']] as const)('maps %s status', (hook_event_name, status) => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name, source: 'startup', reason: 'prompt_input_exit' }))
      .toEqual([{ seq: 0, type: 'entrant.status', status }]);
  });

  it('uses compact JSON for other tools', () => {
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'PreToolUse', tool_input: { file_path: '/work/a.ts' } })[0])
      .toMatchObject({ detail: '{"file_path":"/work/a.ts"}' });
    expect(claudeHookToAgentEvents({ ...base, hook_event_name: 'PostToolUse', tool_response: { content: 'file' } })[0])
      .toMatchObject({ detail: '{"content":"file"}' });
  });

  it.each([{ hook_event_name: 'Stop' }, { hook_event_name: 'Stop', last_assistant_message: '' }, { hook_event_name: 'Notification' }])('ignores empty and unknown hooks', (payload) => {
    expect(claudeHookToAgentEvents(payload)).toEqual([]);
  });
});
