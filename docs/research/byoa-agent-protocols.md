# BYOA: existing protocols for attaching an outside agent to a run

research notes, 2026-09-08. every claim links the spec, doc, or source file that owns it. blog posts and
summaries were not used where a primary source was reachable.

## what we are matching against

the arena needs two channels for an outsider's agent:

- **inbound** — task briefing, `start`, `stop`, operator broadcasts (Austin steer / auto-nudge), delivered as
  turn injections into a live session.
- **outbound** — the activity stream, normalized into our six events: **message**, **reasoning**, **tool call**,
  **tool result**, **usage**, **status** (`working` / `idle` / `blocked` / `done`, see `docs/glossary.md`), plus
  the agent's self-reported progress.

and one architectural question: **direction**. does the outsider host a server we call, or does their client dial
us? every protocol below answers that differently, and the answer is the whole design.

---

## 1. Agent Client Protocol (ACP)

- spec: <https://agentclientprotocol.com/> · repo: <https://github.com/zed-industries/agent-client-protocol>

**Direction — inverted from what BYOA needs.** the *client* (editor) launches the *agent* as a subprocess:
"Agents are programs that use generative AI to autonomously modify code. They typically run as subprocesses of the
Client" (<https://agentclientprotocol.com/protocol/overview>). architecture doc: "When the user tries to connect to
an agent, the editor boots the agent sub-process on demand, and all communication happens over stdin/stdout"
(<https://agentclientprotocol.com/get-started/architecture>).

**Transport — stdio, full stop, today.** the transports page defines exactly two mechanisms, one of which does not
exist yet: "1. stdio ... 2. _Streamable HTTP (draft proposal in progress)_" and "Agents and clients **SHOULD**
support stdio whenever possible"; the Streamable HTTP section reads in its entirety "_In discussion, draft proposal
in progress._" (<https://agentclientprotocol.com/protocol/v2/transports>, same text at
[v1](https://agentclientprotocol.com/protocol/v1/transports)). the introduction says remote agents "can be hosted in
the cloud ... communicating over HTTP or WebSocket" but adds "Full support for remote agents is a work in progress"
(<https://agentclientprotocol.com/get-started/introduction>). a Transports Working Group was announced 2026-04-22 to
"standardize all of the approaches to transports people have been trying ... a Draft RFD for how this could work
both via WebSockets and HTTP" (<https://agentclientprotocol.com/announcements/transports-working-group>). the spec
does bless DIY: "Agents and clients **MAY** implement additional custom transport mechanisms ... The protocol is
transport-agnostic and can be implemented over any communication channel that supports bidirectional message
exchange." **there is no official relay or proxy tool.**

**Encoding.** JSON-RPC 2.0, newline-delimited, UTF-8; stdout carries nothing but ACP messages, stderr is free for
logs (same transports page). batching is allowed but lifecycle messages `initialize`, `auth/login`, `session/new`,
`session/resume`, `session/prompt` **SHOULD NOT** be batched.

**Methods** (from `schema/v2/meta.json`,
<https://github.com/zed-industries/agent-client-protocol/blob/main/schema/v2/meta.json>):
agent side — `initialize`, `auth/login`, `auth/logout`, `session/new`, `session/resume`, `session/list`,
`session/delete`, `session/close`, `session/set_config_option`, `session/prompt`, `session/cancel`.
client side — `session/update`, `session/request_permission`, `elicitation/create`, `elicitation/complete`.

**Vocabulary — the closest match to our six events of anything surveyed.** `SessionUpdate` variants
(`schema/v2/schema.json`,
<https://github.com/zed-industries/agent-client-protocol/blob/main/schema/v2/schema.json>):

| ACP `sessionUpdate` | our event |
| --- | --- |
| `agent_message_chunk` / `agent_message` | message |
| `agent_thought_chunk` / `agent_thought` | reasoning |
| `tool_call_update`, `tool_call_content_chunk` | tool call + tool result (one object, status-carried) |
| `usage_update` (`used`, `size`, optional `cost`) | usage |
| `state_update` → `running` / `idle` / `requires_action` | status → `working` / `idle` / `blocked` |
| `plan_update` | self-reported progress |
| `user_message_chunk` / `user_message` | our injected turns, echoed back |
| `terminal_update`, `terminal_output_chunk`, `available_commands_update`, `config_option_update`, `session_info_update` | (extra) |

`ToolCallStatus` = `pending` \| `in_progress` \| `completed` \| `failed` \| `cancelled`; `ToolKind` = `read`,
`edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, …; tool call content is typed `content` /
`terminal` / `diff` (<https://agentclientprotocol.com/protocol/v2/tool-calls>). `StopReason` = `end_turn`,
`max_tokens`, `max_turn_requests`, `refusal`, `cancelled` — our `done`
(<https://agentclientprotocol.com/protocol/v2/prompt-lifecycle>). `PlanEntryStatus` = `pending`, `in_progress`,
`completed`, `cancelled` (<https://agentclientprotocol.com/protocol/v2/agent-plan>). enums are open: unknown values
that do not begin with `_` are reserved for future variants, so a parser must tolerate them.

**Lifecycle.** `initialize` → optional `auth/login` → `session/new` (or `session/resume`) → N × `session/prompt`,
each a "prompt turn" streaming `session/update` notifications and ending in a `StopReason`; `session/cancel`
interrupts and the agent **MUST** return the `cancelled` stop reason rather than an error. concurrent sessions per
connection are supported (<https://agentclientprotocol.com/get-started/architecture>). this is exactly our
"entrant session + turn injection" model.

**Permissions.** `session/request_permission` is an agent→client request; `blocked` in our vocabulary is native
here, and under a `dontAsk`-equivalent policy the client just auto-denies or auto-allows.

**Auth model — not what BYOA needs.** `authMethods` in the `initialize` response and `auth/login` /`auth/logout`
authenticate *the agent to its model provider*, not the connection between two parties over a network
(<https://agentclientprotocol.com/protocol/v2/authentication>). there is no transport-level authn/authz because
there is no network transport.

**Adoption — this is the strong part.** the official curated registry
(<https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>,
<https://agentclientprotocol.com/get-started/registry>) ships all four of our harnesses with exact launch commands:

| harness | registry id | how it speaks ACP |
| --- | --- | --- |
| Claude Code | `claude-acp` | `npx @agentclientprotocol/claude-agent-acp` — repo `agentclientprotocol/claude-agent-acp`, authors Anthropic + Zed + JetBrains |
| Codex CLI | `codex-acp` | `npx @agentclientprotocol/codex-acp` — repo `agentclientprotocol/codex-acp`, authors OpenAI + JetBrains + Zed, Apache-2.0 |
| Gemini CLI | `gemini` | `npx @google/gemini-cli --acp` — native, documented at [docs/cli/acp-mode.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) |
| OpenCode | `opencode` | `opencode acp` — native, <https://opencode.ai/docs/acp/> |

plus Goose (`goose acp`), Cursor (`cursor-agent acp`), GitHub Copilot (`@github/copilot --acp`), Qwen Code, and
~30 more native implementations listed at <https://agentclientprotocol.com/get-started/agents>. Zed's older
`zed-industries/claude-code-acp` is the ancestor of the registry's `claude-agent-acp`. official SDKs exist for
TypeScript, Rust, Python, Java, Kotlin (<https://github.com/zed-industries/agent-client-protocol#readme>).

**Verdict.** the right *vocabulary and lifecycle* — near one-to-one with our six events and our session/steer
model, and every target harness already speaks it — but the wrong *direction and transport*: someone must be the
local parent process. we would have to write the network hop ourselves.

---

## 2. AG-UI

- docs: <https://docs.ag-ui.com/> · repo: <https://github.com/ag-ui-protocol/ag-ui>

**Direction — the agent hosts, the UI dials.** "HttpAgent ... can be used to connect to any endpoint that accepts
POST requests with a body of type `RunAgentInput` and sends a stream of `BaseEvent` objects"
(<https://docs.ag-ui.com/concepts/architecture>). so the outsider would run an HTTP server and we would POST into
it — a NAT/firewall problem for a laptop.

**Transport.** SSE, plus a binary HTTP protocol; described as transport-agnostic with WebSockets mentioned (same
page). one request in, one event stream out.

**Vocabulary** (`EventType` enum, verbatim from
<https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/typescript/packages/core/src/events.ts>):

`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED`,
`TEXT_MESSAGE_START|CONTENT|END|CHUNK`, `TOOL_CALL_START|ARGS|END|CHUNK|RESULT`,
`REASONING_START|END`, `REASONING_MESSAGE_START|CONTENT|END|CHUNK`, `REASONING_ENCRYPTED_VALUE`,
`STATE_SNAPSHOT`, `STATE_DELTA` (RFC 6902 JSON Patch), `MESSAGES_SNAPSHOT`,
`ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`, `SUBAGENT_STARTED|FINISHED|ERROR`, `RAW`, `CUSTOM`, and the deprecated
`THINKING_*` family. mapping: message ✔, reasoning ✔, tool call ✔, tool result ✔ (`TOOL_CALL_RESULT`).

**Usage** is *not* a streaming event. `TokenUsageSchema` (`inputTokens`, `outputTokens`, `totalTokens`,
`reasoningTokens`, `cachedInputTokens`) hangs off `RUN_FINISHED` and `RUN_ERROR` only
(<https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/typescript/packages/core/src/types.ts>) — end-of-run, not
live. **status** has no dedicated event either; `working`/`idle` must be inferred from run/step boundaries, and
`blocked` from an interrupt outcome on `RUN_FINISHED`.

**Lifecycle.** one `RunAgentInput` (`threadId`, `runId`, `messages`, `tools`, `context`, `state`,
`forwardedProps`, `resume`) per POST; steering means another POST on the same `threadId`. `STATE_DELTA` is a good
fit for self-reported progress (a JSON Patch onto a run-scoped progress object).

**Auth.** none in the protocol; it is plain HTTP, so whatever headers you put on the POST.

**Adoption.** framework-side, not CLI-side: LangChain, Microsoft Agent Framework, Google ADK, AWS Strands, Mastra,
Pydantic AI, Agno, LlamaIndex, CrewAI, AG2, Langroid, **Claude Managed Agents**, and **Claude Agent SDK**
(<https://docs.ag-ui.com/integrations>, source at
<https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/claude-agent-sdk>). **no Codex CLI, Gemini CLI, or
OpenCode integration exists.** for the four harnesses this is not close to free.

**Verdict.** the best *shape* for our outbound feed (an event stream designed for exactly a spectator UI), but the
wrong direction for a laptop, no live usage, no status event, and no adoption among coding-agent CLIs.

---

## 3. A2A (Agent2Agent), Linux Foundation

- spec: <https://a2a-protocol.org/latest/specification/> · repo: <https://github.com/a2aproject/A2A>

**Direction — the outsider hosts a server; we are the client.** "The A2A Client initiates requests to an A2A
Server (remote agent)." discovery is by Agent Card at `https://{agent-server-domain}/.well-known/agent-card.json`
(<https://a2a-protocol.org/latest/topics/agent-discovery/>), which also declares the server's security schemes. so
BYOA over A2A means every entrant publishes a reachable HTTPS endpoint.

**Transport.** three bindings: JSON-RPC 2.0 over HTTP, gRPC, HTTP+JSON/REST (spec §; also
<https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto>). streaming is SSE for the HTTP bindings.

**Methods** (`service A2AService`, a2a.proto): `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`,
`CancelTask`, `SubscribeToTask`, `CreateTaskPushNotificationConfig` (+ get/list/delete),
`GetExtendedAgentCard`. **push notifications** invert the direction back: the server POSTs `StreamResponse`
payloads to a client-registered webhook — the one mechanism here that could survive a client behind NAT, at the
cost of the *arena* being the webhook host.

**Task lifecycle** (`enum TaskState`, a2a.proto lines 187-208): `TASK_STATE_UNSPECIFIED`, `TASK_STATE_SUBMITTED`,
`TASK_STATE_WORKING`, `TASK_STATE_COMPLETED` (terminal), `TASK_STATE_FAILED` (terminal), `TASK_STATE_CANCELED`
(terminal), `TASK_STATE_INPUT_REQUIRED` (interrupted), `TASK_STATE_REJECTED` (terminal),
`TASK_STATE_AUTH_REQUIRED` (interrupted). this is a genuinely task-agnostic lifecycle and maps onto our run
states well.

**Vocabulary — too coarse.** `StreamResponse` is a `oneof` over exactly four payloads: `Task`, `Message`,
`TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent` (a2a.proto:791). `Part` is `text` | `raw` bytes | `url` |
`data` (arbitrary JSON) (a2a.proto:224). **there are no tool-call, tool-result, reasoning, or usage events.**
message ✔, status ✔, self-reported progress ✔ (artifacts + status message); reasoning ✖, tool call ✖, tool
result ✖, usage ✖ — all of which would have to be smuggled inside `data` parts, i.e. we would be designing our own
vocabulary anyway.

**Auth — the strongest of the group.** API keys, HTTP Basic/Bearer, OAuth 2.0, mTLS, OpenID Connect, declared per
security scheme in the Agent Card.

**Adoption.** zero among the four harnesses. no `--a2a` flag, no adapter in any of the four repos.

**Verdict.** the right *federation and auth* story for strangers over the internet, and a good task lifecycle, but
its event vocabulary is a task-status protocol, not an activity-stream protocol. it cannot carry a spectator lane
without us inventing the payloads.

---

## 4. Vercel AI SDK — UI message stream protocol

- docs: <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>

**Direction / transport.** SSE from a server the frontend calls; a non-AI-SDK backend must set the header
`x-vercel-ai-ui-message-stream: v1` and terminate with `[DONE]`. same host-side-server shape as AG-UI.

**Part types** (verbatim `z.literal` values in
<https://github.com/vercel/ai/blob/main/packages/ai/src/ui-message-stream/ui-message-chunks.ts>):
`start`, `start-step`, `finish-step`, `reset-step`, `finish`, `abort`, `error`,
`text-start`, `text-delta`, `text-end`,
`reasoning-start`, `reasoning-delta`, `reasoning-end`, `reasoning-file`,
`tool-input-start`, `tool-input-delta`, `tool-input-available`, `tool-input-error`,
`tool-output-available`, `tool-output-error`, `tool-output-denied`,
`tool-approval-request`, `tool-approval-response`,
`source-url`, `source-document`, `file`, `custom`, `message-metadata`, and open-ended `data-*`.

mapping: message ✔, reasoning ✔, tool call ✔ (input phases), tool result ✔ (output phases),
**blocked ✔ natively** (`tool-approval-request` — the glossary already notes this), step boundaries ✔.
**usage has no part type**; it rides in `message-metadata` (which is why our glossary cites this protocol for the
reasoning/status cuts but not for usage).

**Lifecycle.** message-scoped, not task-scoped. there is no session, no task id, no cancel method, no resume — the
stream is one assistant message. no auth model of its own.

**Adoption.** none of the four harnesses emit it. it is a *rendering* contract, not an agent-attachment contract.

**Verdict.** already the right reference for how we shape our own frames (as the glossary says), and worth staying
compatible with for the spectator UI, but it does not answer direction, session lifecycle, or auth, so it is not a
BYOA protocol.

---

## 5. OpenTelemetry GenAI semantic conventions

- repo (moved from `opentelemetry/semantic-conventions`):
  <https://github.com/open-telemetry/semantic-conventions-genai> — the old
  <https://opentelemetry.io/docs/specs/semconv/gen-ai/> page now only says the conventions "have moved to the
  OpenTelemetry GenAI semantic conventions repository."

**Status: Development**, stated at the top of
[docs/gen-ai/gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md);
every `gen_ai.*` attribute in
[the registry](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md)
carries a `Development` badge. nothing here is stable.

**Direction / transport.** OTLP push (gRPC or HTTP) from the harness to a collector endpoint we would host. this is
the *only* surveyed option where the outsider's process dials out to us with no inbound port — architecturally the
right direction for a laptop, and it comes with `OTEL_EXPORTER_OTLP_HEADERS` for bearer-token auth.

**Vocabulary.** `gen_ai.operation.name` ∈ `chat`, `create_agent`, `invoke_agent`, `invoke_workflow`,
`execute_tool`, `plan`, … Spans: create agent, invoke agent (client + internal), invoke workflow, plan, execute
tool. attributes include `gen_ai.agent.id` / `.name`, `gen_ai.conversation.id`, `gen_ai.tool.name`,
`gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.usage.input_tokens` / `.output_tokens` (+ cache/audio splits).
mapping: tool call ✔, tool result ✔ (span end + status), usage ✔, status ~ (span start/end), message ~ (only via
opt-in content-bearing attributes), reasoning ✖. **spans are closed intervals — there is no partial-output or
delta event**, so a live spectator lane would show tool calls only when they finish.

**Harness support today.**

- **Claude Code** — yes. `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus standard `OTEL_*` vars; metrics
  `claude_code.session.count`, `.token.usage`, `.cost.usage`, `.lines_of_code.count`, `.code_edit_tool.decision`,
  `.active_time.total`, …; log events `claude_code.user_prompt`, `.assistant_response`, `.tool_result`,
  `.tool_decision`, `.api_request`, `.api_error`, … (<https://code.claude.com/docs/en/monitoring-usage>). names are
  vendor-prefixed, not `gen_ai.*`. tracing is behind `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and the docs note the
  extra content attributes "are not part of the stable span schema."
- **Gemini CLI** — yes, logs + metrics + traces, configured via `GEMINI_TELEMETRY_*` /
  `.gemini/settings.json`, OTLP gRPC or HTTP, or written to a file
  ([docs/cli/telemetry.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)).
- **Codex CLI** — yes. the repo ships a `codex-otel` crate depending on `opentelemetry-otlp` and
  `opentelemetry-semantic-conventions`, with `[otel]` config in `config.toml`
  ([codex-rs/otel/README.md](https://github.com/openai/codex/blob/main/codex-rs/otel/README.md),
  [codex-rs/Cargo.toml](https://github.com/openai/codex/blob/main/codex-rs/Cargo.toml)). event and metric names are
  `codex.*` (e.g. `codex.session_started`), again not `gen_ai.*`.
- **OpenCode** — no OTLP exporter documented; it exposes its own HTTP/SSE server instead (see §7).

**Verdict.** right direction (outbound push, token auth) and a real usage/tool story, but Development-status
conventions, three mutually incompatible vendor namespaces in practice, no streaming deltas, and no reasoning —
good as a *side-channel* for cost/usage, not as the spectator feed.

---

## 6. MCP — briefly, and no

MCP is a context-supply protocol: the AI application is the **host**, it creates one **client** per **server**, and
servers expose tools/resources/prompts to the client (<https://modelcontextprotocol.io/docs/learn/architecture>).
the arrow points the wrong way for reporting — an agent does not "report" to an MCP server, it *calls* one.
notably, the same page deprecates MCP's own logging primitive and redirects it elsewhere: "**Logging**: ... New
implementations should log to `stderr` (stdio transport) or use OpenTelemetry."

the one MCP-shaped affordance worth keeping: giving a BYOA entrant a small arena MCP server (`report_progress`,
`get_briefing`, `submit`) is a legitimate way to collect **self-reported progress**, because that *is* a tool call
the agent makes. it is not a way to get the activity stream.

---

## 7. The native line-JSON outputs (what we parse today)

| harness | invocation | stability |
| --- | --- | --- |
| Codex CLI | `codex exec --json` | see below |
| Claude Code | `claude -p --output-format stream-json --verbose [--include-partial-messages]` | see below |
| Gemini CLI | `gemini -p --output-format stream-json` | see below |
| OpenCode | `opencode run --format json` | see below |

**Codex** — docs: <https://learn.chatgpt.com/docs/non-interactive-mode> (the repo's
[docs/exec.md](https://github.com/openai/codex/blob/main/docs/exec.md) is a two-line pointer to it). the
authoritative shape is
[codex-rs/exec/src/exec_events.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs):
`ThreadEvent` = `thread.started` | `turn.started` | `turn.completed` | `turn.failed` | `item.started` |
`item.updated` | `item.completed` | `error`; `ThreadItemDetails` (snake_case `type` tag) = `agent_message`,
`reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list`,
`error`. `turn.completed` carries `Usage { input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens }`. **no stability guarantee is stated anywhere**; the types live in the
CLI's own crate and the `--json` output is described only as a JSON Lines stream.

**Claude Code** — <https://code.claude.com/docs/en/headless> and
<https://code.claude.com/docs/en/cli-reference>. `--output-format` ∈ `text` | `json` | `stream-json`;
`--include-partial-messages` "Include partial streaming events in output. Requires `--print` and
`--output-format stream-json`". the stream carries `system` messages (`subtype: init`, `api_retry`,
`plugin_install`, `permission_denied`), `assistant` / `user` messages, `stream_event` deltas, and a final `result`
with cost and session metadata. subagent messages carry `parent_tool_use_id` (this is where our `parentToolCallId`
comes from). **no stability guarantee**, but the docs are unusually explicit about version gates
("Requires Claude Code v2.1.205 or later", "Before v2.1.219 …") and about feature-detecting via the `capabilities`
array in `system/init` "instead of comparing version strings" — that is the closest thing to a compatibility
contract any of the four offers.

**Gemini CLI** — [docs/cli/headless.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md):
`--output-format` ∈ `text` | `json` | `stream-json` (also in
[cli-reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)). streaming
JSON event types are `init`, `message`, `tool_use`, `tool_result`, `error`, `result` (with per-model token usage).
exit codes are documented (`0`, `1`, `42` input error, `53` turn limit). **no stability guarantee stated.**

**OpenCode** — <https://opencode.ai/docs/cli/>: `--format` is "default (formatted) or json (raw JSON events)" —
the doc itself calls them *raw* events. **no stability guarantee.** OpenCode is the outlier that also ships a
network server: `opencode serve [--port] [--hostname] [--cors]` (default `127.0.0.1:4096`) publishes an OpenAPI 3.1
document at `/doc`, an SSE stream at `/event` (first message `server.connected`, then bus events) and
`/global/event`, with HTTP basic auth via `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`
(<https://opencode.ai/docs/server/>). `opencode run --attach` reuses a running server.

**common finding: none of the four publish a versioned schema or a compatibility promise for their JSON output.**
that is the real cost of today's approach — four private, silently-changing vocabularies.

---

## Comparison

| | direction | transport | msg | reasoning | tool call | tool result | usage | status | task lifecycle | auth | our 4 harnesses |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **ACP** | client spawns agent (local) | JSON-RPC/stdio; HTTP draft | ✔ | ✔ | ✔ | ✔ | ✔ live | ✔ `running`/`idle`/`requires_action` | session + prompt turn + cancel | agent→provider only | **all 4** |
| **AG-UI** | UI POSTs to agent's HTTP endpoint | SSE / HTTP binary | ✔ | ✔ | ✔ | ✔ | end-of-run only | inferred | run/step, thread id, resume | none (plain HTTP) | 0 (Claude Agent SDK only) |
| **A2A** | client calls agent's server; webhooks reverse it | JSON-RPC/gRPC/REST + SSE | ✔ | ✖ | ✖ | ✖ | ✖ | ✔ 8 `TaskState`s | task, first-class | OAuth2/mTLS/OIDC/API key | 0 |
| **AI SDK UI stream** | UI calls server | SSE | ✔ | ✔ | ✔ | ✔ | in `message-metadata` | approval-request = blocked | message-scoped only | none | 0 |
| **OTel GenAI** | harness pushes out to collector | OTLP gRPC/HTTP | ~ | ✖ | ✔ | ✔ | ✔ | ~ span open/close | trace/span | OTLP headers | Claude, Gemini, Codex (3 namespaces) |
| **MCP** | agent calls server | JSON-RPC stdio / Streamable HTTP | — | — | — | — | — | — | — | OAuth | n/a (wrong direction) |
| **native line-JSON** | we spawn, read stdout | pipes | ✔ | ✔ | ✔ | ✔ | ✔ | partial | per-CLI | n/a | all 4, 4 dialects |

---

## Recommendations

*the sections above are sourced; this section is my assessment.*

1. **Adopt ACP as the BYOA wire vocabulary, and supply the network hop ourselves.** it is the only protocol whose
   event set covers all six of our normalized events *and* whose session/prompt/cancel lifecycle already matches
   our entrant-session + turn-injection model — `state_update` (`running`/`idle`/`requires_action`) is literally
   our `working`/`idle`/`blocked`, and `usage_update` is live rather than end-of-run. crucially, all four harnesses
   have a registry-listed ACP entrypoint, so "attach a Codex/Claude/Gemini/OpenCode agent" reduces to running one
   documented command. the spec explicitly permits custom transports, so this is extending ACP, not fighting it.

2. **Make the outsider dial us — a thin `arena-connect` client that speaks ACP over an outbound WebSocket.** the
   outsider runs `arena-connect --run <id> --token <t> -- npx @agentclientprotocol/codex-acp`; the tool is the ACP
   *client* locally (spawning the agent on stdio, exactly as the spec intends) and tunnels the JSON-RPC frames over
   one authenticated outbound WebSocket to the arena. this solves NAT, laptops, and firewalls in one move, keeps the
   arena the only server, and keeps our permission policy (`dontAsk`) enforceable client-side. every other option
   requires a stranger to host a reachable HTTPS endpoint, which will not happen on a livestream deadline.

3. **Borrow A2A's auth and admission model, not its event model.** issue a per-entrant bearer token bound to
   `(runId, entrantId)`; have the outsider present an agent-card-shaped self-description at attach time (name,
   harness, pinned model, wallet address) so the arena can journal what is racing. do not try to carry the activity
   stream over A2A — `StreamResponse` has no tool-call or reasoning payload and we would end up inventing our own
   frames inside `data` parts.

4. **Keep the arena's `ArenaEvent` the canonical journal type; treat ACP as one more harness adapter.** the ADR-0018
   seam already exists. a BYOA connection is a new adapter that parses ACP `session/update` instead of a CLI's
   stdout, so the journal, SSE feed, solve poller, and frontend never learn that an entrant is remote. this also
   keeps the platform task-agnostic: nothing in ACP or in our mapping is CTF-specific.

5. **Use OTel as an optional side-channel and MCP for self-reported progress — neither as the main feed.** if an
   entrant sets `OTEL_EXPORTER_OTLP_ENDPOINT` at our collector we get cost and token truth from Claude Code, Gemini
   CLI, and Codex for free; but the conventions are Development-status, the three harnesses use three vendor
   namespaces, and spans have no deltas, so it cannot drive a live lane. for the agent's *own* claim of progress,
   ship a tiny arena MCP server (`get_briefing`, `report_progress`, `submit`) — that is a tool call the agent makes,
   which is the only direction MCP supports — and keep on-chain state as the only judge, per the existing solve-poller
   design.

**One thing to verify before committing:** whether the ACP Transports Working Group's Streamable HTTP RFD lands
close enough to our timeline to replace recommendation 2's custom tunnel. as of the 2026-04-22 announcement it was
a draft; if it ships, `arena-connect` becomes a compatibility shim rather than a permanent component.
