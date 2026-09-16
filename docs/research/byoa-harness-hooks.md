# BYOA: can each harness self-report via config-only hooks?

Question: an outsider gets a bearer token and our HTTPS endpoint. Can they paste a config file
into their repo and have their harness POST our six event types (message, reasoning, tool call,
tool result, usage, status) with no custom process and no script beyond a shell one-liner?
Checked 2026-09-08 against official docs and shipped source; every claim cited.

## 1. Claude Code

Sources: [hooks reference](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide).

**Events.** Far more than the classic nine. The lifecycle table lists `Setup`, `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`,
`PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`,
`StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`,
`TeammateIdle`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`,
`ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`,
`WorktreeRemove`, `InstructionsLoaded`, `Notification`, `MessageDisplay`, `Elicitation`,
`ElicitationResult`.

**Payloads.** Every event gets `session_id`, `prompt_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, `effort.level`, plus `agent_id`/`agent_type` inside
subagents. `PreToolUse` adds `tool_name`, `tool_input`, `tool_use_id`; `PostToolUse` adds
`tool_response` (tool-dependent shape, e.g. `{"filePath":...,"success":true}` for `Write`) and
optional `duration_ms`. `Stop` gets `last_assistant_message` and `stop_reason`; `SubagentStop`
the same plus `agent_id`/`agent_type`.

**Assistant text — yes, there is a hook.** `MessageDisplay` fires "while assistant message
text is displayed" with `turn_id`, `message_id`, `index`, `final`, `delta`. It "fires for
every assistant message that streams text; messages with no text, such as tool-call-only
responses, don't trigger it." In `claude -p` and Agent SDK runs it fires once per message
with the whole text in `delta`. Timeout is lowered to **10s** on this event. **Reasoning is
absent:** a grep of the full reference for "thinking"/"reasoning" returns nothing, and
`MessageDisplay` "receives assistant message text only."

**Usage — effectively no.** No hook payload carries tokens or cost. Sole exception: a foreground
`Agent` call's `PostToolUse` `tool_response` includes `usage` with `input_tokens`,
`output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` for the final request
only. The docs point at OpenTelemetry counters for real usage.

**No shell needed at all.** Handler `type` may be `"http"`, POSTing the payload with bearer
auth (other types: `command`, `mcp_tool`, `prompt`, `agent`; `command` also takes `"async": true`):

```json
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"http",
  "url":"http://localhost:8080/hooks/pre-tool-use","timeout":30,
  "headers":{"Authorization":"Bearer $MY_TOKEN"},"allowedEnvVars":["MY_TOKEN"]}]}]}}
```

**Config and limits.** Per-project `.claude/settings.json`, committed (also
`~/.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin
`hooks/hooks.json`, skill/subagent frontmatter). Default timeout 600s for
`command`/`http`/`mcp_tool`, 30s `prompt`, 60s `agent`; lowered to 30s on
`UserPromptSubmit`/`PreModelSwitch`/`PostModelSwitch`, 10s on `MessageDisplay`; `SessionEnd`
hooks share a 1.5s budget. Matching hooks run in parallel; identical handlers across settings
files are deduplicated. **Workspace trust:** hooks from every settings file are held back until
the user accepts the trust dialog for the folder.

## 2. Codex CLI

Sources: [docs/config.md](https://github.com/openai/codex/blob/main/docs/config.md),
[hooks docs](https://learn.chatgpt.com/docs/hooks),
[config reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[codex-rs/hooks/src/legacy_notify.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/legacy_notify.rs).

**Codex now has hooks.** The repo's `config.md` is a stub redirecting to hosted docs but
keeps a "Lifecycle hooks" section (admins can set `allow_managed_hooks_only = true` in
`requirements.toml`). Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`,
`UserPromptSubmit`, `Stop`, `Interrupt`. Config is discovered at `~/.codex/hooks.json` or
`~/.codex/config.toml`, `<repo>/.codex/hooks.json` or `<repo>/.codex/config.toml`, and
plugin-bundled `hooks/hooks.json` — so repo-local paste-one-file works.

**Payload.** "Every command hook receives one JSON object on `stdin`." Common: `session_id`,
`transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped hooks
add `turn_id`. `PreToolUse`: `tool_name`, `tool_use_id`, `tool_input`. `PostToolUse`: same
plus `tool_response`. `Stop`: `stop_hook_active`, `last_assistant_message`.
`UserPromptSubmit`: `prompt`. Command and MCP-tool handlers work; prompt and agent handlers "are
parsed but skipped." **No HTTP handler type** — a `curl` one-liner is required. `async` is
supported per handler (`SessionEnd` always sync).

**Legacy `notify`.** Still present, now a shim over the hooks system, and argv-based rather
than stdin: the JSON is appended as the final argv argument. One event type only,
`agent-turn-complete`, fired from the internal `AfterAgent` event. Per `legacy_notify.rs` the
payload is kebab-case: `{"type":"agent-turn-complete","thread-id":...,"turn-id":...,"cwd":...,
"client":"codex-tui","input-messages":[...],"last-assistant-message":"..."}`. stdout/stderr
are `Stdio::null()` — fire and forget. One event per turn with the final message; hooks are
strictly better. **Missing:** no streaming assistant-text event (no `MessageDisplay`
equivalent), no reasoning, no token usage anywhere in hook payloads. The docs also warn "the
transcript format isn't a stable interface," so `transcript_path` is not a supported fallback.

## 3. OpenCode

Sources: [plugins docs](https://opencode.ai/docs/plugins/), [server docs](https://opencode.ai/docs/server/),
`@opencode-ai/plugin@1.18.29` `dist/index.d.ts`, `@opencode-ai/sdk` `dist/gen/types.gen.d.ts`.

**Plugin format.** A JS or TS file in `.opencode/plugins/` (project) or
`~/.config/opencode/plugins/` (global), loaded automatically at startup; npm plugins install
via Bun. A plugin is `(input: PluginInput, options?) => Promise<Hooks>`, where `PluginInput`
is `{ client, project, directory, worktree, experimental_workspace, serverUrl, $ }` — `client`
is the opencode SDK client, `$` the Bun shell. Ordinary JS in the Bun runtime, so `fetch()` to
an external URL works; the docs impose no network restriction.

**Hooks** (verbatim from the `Hooks` interface): `event`, `config`, `tool`, `auth`,
`provider`, `chat.message`, `chat.params`, `chat.headers`, `permission.ask`,
`command.execute.before`, `tool.execute.before`, `tool.execute.after`, `shell.env`,
`tool.definition`, plus `experimental.*`. Tool hooks are
`(input: {tool, sessionID, callID}, output: {args})` before and
`(input: {tool, sessionID, callID, args}, output: {title, output, metadata})` after.
`chat.message` fires on the **user** message (`output.message: UserMessage`), not the assistant's.

**The `event` hook is the whole feed:** `event?: (input: { event: Event }) => Promise<void>`.
The `Event` union includes `message.updated`, `message.part.updated`, `message.part.removed`,
`session.status`, `session.idle`, `session.error`, `session.compacted`, `permission.updated`,
`file.edited`, `command.executed`, `server.connected`. `EventMessagePartUpdated` carries
`{ part: Part, delta?: string }`, and `Part` is `TextPart | ReasoningPart | FilePart |
ToolPart | StepStartPart | StepFinishPart | ...`. `ReasoningPart` is
`{id, sessionID, messageID, type:"reasoning", text, time}` — **real reasoning text**.
`StepFinishPart` and `AssistantMessage` both carry `cost: number` and
`tokens: {input, output, reasoning, cache:{read, write}}` — **real usage**.
`session.status`/`session.idle` give status.

**HTTP server.** `opencode serve [--port <n>] [--hostname <h>] [--cors <origin>]`, default
`127.0.0.1:4096`, with a `/event` SSE stream ("First event is `server.connected`, then bus
events") and `/global/event`; auth via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`.
Same bus as the `event` hook, but consuming it needs a process — breaks config-only. Caveat: a
plugin is a JS file, not a config file — still zero-install (one file, no daemon), but it is
code the entrant runs, not a settings blob.

## 4. Gemini CLI

Sources: [docs/hooks/index.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md),
[docs/hooks/reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md).

**Events.** `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`,
`AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`,
`Notification`. (Named `BeforeTool`/`AfterTool`, not `PreToolUse`/`PostToolUse`.)

**Mechanics.** stdin JSON in, stdout JSON out, stderr for logs. Exit 0 success, 2 block, anything
else warning. "Silence is Mandatory": any non-JSON on stdout breaks parsing, so a `curl`
one-liner must be silenced (`curl -s -o /dev/null`). Only `type: "command"` is supported — **no
HTTP handler**. Default timeout 60000 ms; `sequential: true` opts out of parallel execution.

**Payloads.** All hooks get `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
`timestamp` (ISO 8601). `BeforeTool`: `tool_name`, `tool_input`, `mcp_context`,
`original_request_name`. `AfterTool`: adds `tool_response` (`{llmContent, returnDisplay,
error?}`). `BeforeAgent`: `prompt`. `AfterAgent`: `prompt`, `prompt_response` (final
generated text), `stop_hook_active`. `SessionStart`: `source`. `SessionEnd`: `reason`.
`Notification`: `notification_type` (`"ToolPermission"`), `message`, `details`.

**`AfterModel` is the interesting one.** It "fires immediately after an LLM response chunk
is received," receives `llm_request` and `llm_response`, and is "fired for **every chunk**
generated by the model." The documented stable shape:

```ts
{ candidates: [{ content: {role:"model", parts: string[]}, finishReason: string }],
  usageMetadata: { totalTokenCount: number } }
```

So `AfterModel` gives **both streaming assistant text and token usage** — the only harness
here that hands usage to a hook. Caveats: `parts` is `string[]` and "Non-text parts are
filtered out for hooks," so reasoning is not separately typed; and per-chunk firing means
one subprocess spawn per chunk.

**Config.** A `hooks` object in `settings.json`, project-scoped at `.gemini/settings.json` (highest
precedence, above `~/.gemini/settings.json` and `/etc/gemini-cli/settings.json`), with
`$GEMINI_PROJECT_DIR` available in commands. Paste-one-file works.

## 5. Pi

Sources: [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [docs/json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), [docs/security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md),
[docs/quickstart.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md), [packages/ai/src/types.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts).

**Name check first.** `badlogic/pi-mono` redirects to **`earendil-works/pi`** (the GitHub API returns
`"full_name": "earendil-works/pi"` for both). The npm package is **`@earendil-works/pi-coding-agent`**
(0.85.1, bin `pi`), not `@mariozechner/*`; install with `npm install -g --ignore-scripts
@earendil-works/pi-coding-agent`. Docs live in the repo under `packages/coding-agent/docs/`.

**Mechanism: extensions, not hooks.** `docs/hooks.md` is gone — hooks and custom tools were folded
into one extension system. An extension is a **TypeScript module** exporting
`default function (pi: ExtensionAPI)` that calls `pi.on(event, handler)`. Auto-discovered from
`~/.pi/agent/extensions/*.ts` (global) and `.pi/extensions/*.ts` (project-local), plus their
`*/index.ts` subdirectory forms; also `pi -e ./file.ts`, or `extensions`/`packages` arrays in
`settings.json`. **There is no config-only hook format — it is always a code file.**

**Events** (from the doc's lifecycle diagram): `project_trust`, `resources_discover`,
`session_start`, `session_shutdown`, `session_before_switch`/`fork`/`compact`/`tree`, `input`,
`before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`,
`message_start`, `message_update`, `message_end`, `context`, `before_provider_headers`,
`before_provider_request`, `after_provider_response`, `tool_execution_start`/`update`/`end`,
`tool_call` (can block), `tool_result` (can modify), `user_bash`, `model_select`,
`thinking_level_select`, `ui_prompt_start`/`end`.

**Reasoning — yes.** `message_update` carries `event.assistantMessageEvent`, the token-level
`AssistantMessageEvent` union, whose variants include `thinking_start`/`thinking_delta`/`thinking_end`
beside `text_*` and `toolcall_*` — real streaming thinking text.

**Usage — yes.** `message_end` exposes `event.message.usage`; `Usage` in `packages/ai/src/types.ts`
is `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{input,
output, cacheRead, cacheWrite, total}}`. `ctx.getContextUsage()` exists too.

**Outbound HTTP — yes.** The docs' own `tool_result` example calls
`await fetch("https://example.com/summarize", { method:"POST", body:…, signal: ctx.signal })`.
Node built-ins are available (`node:fs`, `node:path`, …), so `process.env.MY_TOKEN` supplies the
bearer header. security.md is explicit — "Extensions are TypeScript modules that run with the same
permissions", "Pi does not include a built-in sandbox" — so no network restriction.

**Non-interactive.** Both `pi -p` (print) and `pi --mode json` exist. JSON mode writes one JSON
object per line: a `session` header, then `agent_start`, `turn_start`, `message_start`,
`message_update` (delta-only, with a top-level cumulative `usage`), `message_end`, `turn_end`,
`agent_end`, `tool_execution_*`. Extensions run in both, `ctx.hasUI` false, UI calls no-ops.

**Trust — the sharp edge.** `.pi/extensions` loads only after the project is trusted (saved in
`~/.pi/agent/trust.json`). But "non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do
not show a trust prompt", and under the default `defaultProjectTrust: "ask"` they **silently
ignore** project resources. An entrant must pass `--approve`/`-a`, set
`defaultProjectTrust: "always"` globally, or run `/trust` once interactively.

## Comparison — config-only, hooks alone, no companion process

| Event | Claude Code | Codex CLI | OpenCode | Gemini CLI | Pi |
|---|---|---|---|---|---|
| message | Yes — `MessageDisplay` streaming `delta`; `Stop.last_assistant_message` fallback | Turn-final only — `Stop.last_assistant_message` | Yes — `message.part.updated` `TextPart` + `delta` | Yes — `AfterModel` `candidates[].content.parts` per chunk; `AfterAgent.prompt_response` turn-final | Yes — `message_update` `text_delta`; `message_end` final message |
| reasoning | **No** | **No** | Yes — `ReasoningPart.text` | No (non-text parts filtered) | Yes — `thinking_delta` in `message_update.assistantMessageEvent` |
| tool call | Yes — `PreToolUse` | Yes — `PreToolUse` | Yes — `tool.execute.before` / `ToolPart` | Yes — `BeforeTool` | Yes — `tool_call` (blocking) / `tool_execution_start` |
| tool result | Yes — `PostToolUse` (`tool_response`, `duration_ms`) | Yes — `PostToolUse` (`tool_response`) | Yes — `tool.execute.after` | Yes — `AfterTool` (`tool_response`) | Yes — `tool_result` (mutable) / `tool_execution_end` |
| usage | **No** (subagent `Agent` `tool_response.usage` only) | **No** | Yes — `tokens{input,output,reasoning,cache}` + `cost` | Partial — `usageMetadata.totalTokenCount` | Yes — `message_end` `message.usage` incl. `cost.total`, `reasoning` |
| status | Yes — `SessionStart`/`SessionEnd`/`Stop`/`Notification` | Yes — `SessionStart`/`SessionEnd`/`Stop`/`Interrupt` | Yes — `session.status`/`idle`/`error` | Yes — `SessionStart`/`SessionEnd`/`Notification` | Yes — `session_start`/`session_shutdown`/`agent_start`/`agent_settled` |
| transport | **`type:"http"` + bearer header, zero shell** | `curl` one-liner | `fetch()` in the plugin | `curl -s` one-liner | `fetch()` in the extension |
| paste-one-file | `.claude/settings.json` | `.codex/hooks.json` | `.opencode/plugins/arena.js` (code, not config) | `.gemini/settings.json` | `.pi/extensions/arena.ts` (code, not config; needs project trust) |

**Trust surface.** Four of five require the entrant to paste a config that runs a shell command
we authored on their machine, with their environment inherited (Codex and Gemini need `curl`,
OpenCode a JS file, Pi a TS file). Claude Code's `http` handler is the only one that runs none of our code.
Each is a supply-chain item from the entrant's side: keep the snippet readable in full, have it
read nothing beyond the hook payload, and source the token from their own env var rather than
baking it in (Claude Code's `allowedEnvVars` is the right shape). Note too that Claude Code
holds settings-file hooks back until the workspace trust dialog is accepted.

## Assessment

Paste-this-config is viable for all four, but the ceiling differs. Claude Code is the best
case: `type:"http"` with a bearer header runs no shell at all, and `MessageDisplay` plus
`PreToolUse`/`PostToolUse`/`Stop` covers five of six types — only usage is missing.
Gemini CLI is second: one settings file, and `AfterModel` uniquely delivers text and
`totalTokenCount` together, at the cost of a subprocess per chunk. OpenCode gets all six
including real reasoning and full token/cost, but costs the entrant a JS file rather than
config. Codex is weakest: tools and status are covered, assistant text arrives only once per
turn, and there is no reasoning and no usage at all. Plan for usage to be absent on Claude
Code and Codex, and treat reasoning as an OpenCode-or-Pi bonus, not a required field.

Pi is the other end of the OpenCode trade: an extension is a TypeScript file, never a config blob,
but it produces all six types from the extension alone — streaming `text_delta` and `thinking_delta`
off `message_update`, blocking `tool_call` and mutable `tool_result`, and per-message `usage` with a
real `cost.total`, the fullest usage of the five. `fetch()` with `process.env` is used in Pi's own
docs, so the bearer-token POST is native. The catch is enablement, not capability: `.pi/extensions`
needs project trust, and `-p`/`--mode json` never prompt for it — under the default
`defaultProjectTrust: "ask"` our extension is skipped in silence unless the entrant passes
`--approve`, sets `"always"`, or runs `/trust` once.
