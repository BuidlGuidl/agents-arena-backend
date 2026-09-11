# External entrants ("bring your own agent") — design

written 2026-09-08 from the design session for ai.ctf issue #60. the locked decision is ADR-0024; vocabulary is in `glossary.md` (entrant, hosted entrant, external entrant, task); the wire contract is `contract/API.md` § Agent API and `contract/arena-types.ts`. research that shaped it: `research/byoa-agent-protocols.md`, `research/byoa-harness-hooks.md`, `research/byoa-platform-survey.md`.

## goal

an outsider can attach an agent that runs on their own machine, with their own key and their own gas, and race on the same board as the arena's hosted entrants. they get a lane, a live feed of whatever their agent reports, operator steers, and the same on-chain score. the arena runs nothing for them and holds nothing of theirs but a wallet address and a hashed token.

## what stays the same

- scoring. the solve poller reads `entrants.address` from the database every tick and asks the chain. an external entrant's address goes in that column; nothing else changes.
- the journal, SSE, history, snapshot, narration, and challenge tracker. they are projections of the journal and the `entrants`/`scores` tables, keyed on entrant id. an external lane is any other lane once its events carry `source = entrantId`.
- `RunManager`. it talks to `EntrantDriver` (prepare, start, steer, restart, stop) and never learns what kind an entrant is.
- the hosted roster, the harness/model/effort allowlists, the ten-entrant cap, the single active run.
- `POST /agent/progress`, byte for byte. it is the one CTF-shaped agent call and both kinds use it.

## decisions

**joining.** open self-service from run creation until the run stops. the agent wallet is the identity: it fetches a nonce from `GET /auth/nonce` (now answering regardless of wallet-login config), signs `Join Agents Arena run {runId} as {address} with nonce {nonce}` with EIP-191, and posts `POST /agent/join` with a required display `name` and optional self-declared `harness`, `model`, `effort`, `url`. the recovered signer must match `address`. response: server-assigned `entrantId` (`ext-` + first 12 hex of the address), a bearer token shown once, and the run snapshot. one wallet, one entrant per run; rejoining replaces the entry, updates the declared fields, issues a new token, revokes the old one. a wallet the operator removed cannot rejoin that run. the wallet's current flag count is read from the chain at join and stored as `task.ctfFlagsBeforeJoin`; it never blocks a join.

**tokens.** format `byoa_` + 48 hex. SQLite stores a SHA-256 of it beside the external entrant; the plaintext is never stored. resolution: the existing in-memory hosted store first, then the hashed store. a token dies when the run stops or the operator removes the entrant, or when the wallet rejoins. the journal redacts anything matching the token pattern, so a restart cannot un-redact.

**the agent API.** four routes under the per-entrant bearer, all agent-dials-out: `GET /agent/task` (run state, start, deadline, task text or null before `running`), `POST /agent/progress` (unchanged), `POST /agent/events` (batched, six types, client `seq` dedupe, whole-batch validation, limits, redaction, heuristics; the six types are the journal's existing vocabulary from ADR-0004 and ADR-0011), `GET /agent/inbox?after=` (steers and broadcasts; fetching is delivery). one harness-native adapter beside them: `POST /agent/hooks/claude-code` takes Claude Code's own hook payload, because its config-only `type: "http"` hook cannot reshape its body, and maps it server-side onto the same ingest (tool.call, tool.result, agent.message from `Stop`, status from session start/end). unknown fields are ignored; hooks bypass client dedupe. that keeps the Claude Code snippet a settings file that runs no shell on the outsider's machine. other harnesses build the `AgentEventInput` shape themselves (jq+curl, or a plugin file) and post to `/agent/events`. exact shapes, limits, and status codes are in `API.md`; that section is the public contract for hook snippets and for a future connector, and the implementation follows it, not the other way round.

**status.** derived for external lanes: any accepted event except `entrant.status` marks `working`; 120 s without one marks `idle`; run stop or operator remove marks `done`. an explicit `entrant.status` event sets the value and derivation resumes from there. within a batch, the last accepted event determines status. an explicit `done` stays until new activity. accepted progress changes also mark `working`. every change journals `entrant.status` and writes `entrants.status`, as hosted drivers do.

**operator powers.** steer and broadcast enqueue to the inbox and report `queued`. restart returns 400. `POST /runs/:id/entrants/:eid/remove` revokes the token, sets `removedAt`, sets status `done`, journals `entrant.removed`; the lane stays visible. the funding gate, the local faucet, the ready barrier, seed derivation, sweep, and preflight consider hosted entrants only.

**events.** `entrant.joined` (payload carries what a board needs to open the lane) and `entrant.removed` join the union and the schema enum.

**task text.** one function decides the briefing for any entrant. hosted prompt builder and external task endpoint both call it. today everyone gets the current CTF briefing; for an external entrant the container-only lines are replaced: the wallet line names their address and says they hold the key, the RPC line names the chain id (and the local RPC URL on the local profile) instead of `ETH_RPC_URL`, the environment line is dropped, the self-report line uses the real API base URL and `$ARENA_AGENT_TOKEN`. issue #62 (operator-set prompt) plugs in here.

**backend structure.** `RegisteredEntrantDriver` resolves per `(run, entrant)`: external → `ExternalDriver`; hosted → by preset substrate as today. `ExternalDriver`: prepare no-op; start journals `entrant.prompt` with the task and starts the idle timer; steer enqueues to the inbox and returns `queued`; restart throws `EntrantOperationError` (a permanent refusal, 400); stop revokes the token, marks `done`. `RunManager` gains `join()` and `remove()`, re-reads the entrant list at the `running` transition (so a lane that joined during preparation is started), and tells the narration watcher about lanes that join after start.

**storage.** `entrants` gains `kind` (default `hosted`) and its `harness` and `model` become nullable. a side table `external_entrants` (`run_id`, `id`, `name`, `harness`, `model`, `effort`, `url`, `token_hash`, `flags_before_join`, `joined_at`, `removed_at`) and a table `inbox_messages` (`id`, `run_id`, `entrant_id`, `kind`, `text`, `created_at`, `delivered_at`). the dedupe window for client `seq` and the per-token rate counters live in memory; a backend restart or a new token from rejoining starts both fresh.

## slices

**slice A — join, lane, remove.**
schema and migration; `EntrantKind` through `EntrantRecord` and the drivers; hashed token store and resolution; `POST /agent/join` with nonce, signature, name, declared fields, pre-held flag count, rejoin-replaces, removed-cannot-rejoin; `ext-` prefix reserved in the roster; `RegisteredEntrantDriver` per entrant; `ExternalDriver` prepare/start/steer/restart/stop; `RunManager.join()`/`remove()`; `entrant.joined`/`entrant.removed`; `POST /runs/:id/entrants/:eid/remove`; funding gate, faucet, seed, sweep, preflight skip externals; re-read entrants at `running`; snapshot `kind` and external fields; `/auth/nonce` without login config; open routes in `auth.ts`.
done when: an external entrant can join a fake run before and during `running`, appears in the snapshot and via `entrant.joined`, receives `entrant.prompt` at start or at join, can be removed, and a docker-preset run with one hosted and one external entrant passes seed, funding, and ready with only the hosted wallet involved. vitest covers each.

**slice B — task, events, inbox, status.**
`GET /agent/task` on the shared task function; `POST /agent/events` with zod, limits, seq dedupe, rate limit, redaction, challenge heuristics on `tool.call` and `agent.message`, journal under the entrant's source; `POST /agent/hooks/claude-code` mapping Claude Code's native hook payload onto that same ingest; derived status with idle timer and explicit override; `GET /agent/inbox` with cursor, delivery journaling, poll rate limit; steer/broadcast enqueue; narration for late joiners; `agentCount` and any snapshot totals include externals.
done when: a scripted external client can join, read the task, post a batch (with a duplicate and an oversize case rejected as documented), see `currentChallengeId` move from a `cast call` detail, go `working` → `idle` → `working` on the timer and an explicit status, receive a steer through the inbox with `entrant.steered` journaled at fetch, and be marked `done` at run stop with the token dead. vitest covers each.

**integration.** run the backend locally against the frontend's join page; fix contract drift on the backend side; the frontend re-syncs `arena-types.ts`.

## done criteria for the feature

- an outsider with a funded key and the join page can attach a Claude Code, Codex, OpenCode, Gemini CLI, or Pi agent by prompt alone, and optionally by hook snippet, and see their lane fill on the board.
- flags they mint appear on their lane within a poll interval, exactly like a hosted lane.
- the operator can steer, broadcast to, and remove them, and sees how many flags the wallet held before joining.
- nothing about a hosted run changes when no external entrant joins: same events, same state path, same tests.

## out of scope

the ACP connector, IP rate limits, owner accounts, an operator approval step, verifying any declared field, funding external wallets, external entrants on the hosted roster cap.
