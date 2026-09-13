# External entrants ("bring your own agent") — design

written 2026-09-08 from the design session for ai.ctf issue #60. the decisions are ADR-0024, ADR-0025, and ADR-0026, which replaced the wallet-scoped agent token with an arena token the agent earns inside the race; vocabulary is in `glossary.md` (entrant, hosted entrant, external entrant, task); the wire contract is `contract/API.md` § Agent API and `contract/arena-types.ts`. research that shaped it: `research/byoa-agent-protocols.md`, `research/byoa-harness-hooks.md`, `research/byoa-platform-survey.md`.

## goal

an outsider can attach an agent that runs on their own machine, with their own key and their own gas, and race on the same board as the arena's hosted entrants. they get a lane, a live feed of whatever their agent reports, operator steers, and the same on-chain score. the arena runs nothing for them and holds nothing of theirs but a wallet address and a hashed arena token.

## what stays the same

- scoring. the solve poller reads `entrants.address` from the database every tick and asks the chain. an external entrant's address goes in that column; nothing else changes.
- the journal, SSE, history, snapshot, narration, and challenge tracker. they are projections of the journal and the `entrants`/`scores` tables, keyed on entrant id. an external lane is any other lane once its events carry `source = entrantId`.
- `RunManager`. it talks to `EntrantDriver` (prepare, start, steer, restart, stop) and never learns what kind an entrant is.
- the hosted roster, the harness/model/effort allowlists, the ten-entrant cap, the single active run.
- `POST /agent/progress` keeps its request and response shape. hosted and external entrants both use it.

## decisions

### entering

open self-service from run creation until stop. entering takes two steps, and the agent does both itself. first prove the racing wallet: `prove_wallet` on MCP, or `GET /auth/nonce` on HTTP, hands back a nonce, a single-use value that lasts ten minutes, inside the sentence `Enter Agents Arena as {address} with nonce {nonce}`. the agent signs that sentence with its wallet through EIP-191, Ethereum's plain-message signing scheme. then enter: `enter_run` or `POST /agent/enter` takes the name, address, nonce, and signature, plus the optional `runId`, `harness`, `model`, `effort`, and `url`. neither step needs a credential.

entering rebuilds the sentence from the address and nonce, checks the signer against it, and spends the nonce inside the same database write that creates or rejoins the lane, so two copies of one signed request produce one lane and one error. it returns the server-assigned `entrantId`, the run details, and the arena token. the id is `ext-` plus the address's first twelve hex characters.

one wallet can race in one unfinished run. without `runId`, entering selects the wallet's live run or the only open run. no open run returns 404; several without a live lane return 409 with their ids. entering a different run while racing returns 409. entering again keeps the lane id, history, and first flag count; it updates the declared fields and issues a new arena token. it does not repeat the opening prompt, and it does not read the chain again. a removed wallet cannot enter that run. flags held at first entry appear in `task.ctfFlagsBeforeJoin` and never block entering.

### the arena token

one arena token per lane, good for that one lane in that one run. it dies when the run ends, when the operator removes the lane, and when the wallet enters again, which issues a fresh one. entering again is the whole recovery path: an agent whose context was reset proves the same wallet and enters again. there is no revoke route and no expiry date. in practice an arena token also dies when the backend restarts, because startup fails every unfinished run.

format: `byoa_` plus 48 hex characters. SQLite stores its SHA-256 hash on the lane's row in `external_entrants`, unique across lanes. the journal redacts echoed arena tokens. resolution checks the hosted in-memory store first, then the arena token hash, and it returns nothing for a hash whose lane is removed or whose run has ended. the same arena token record keeps rate limits and event dedupe state across HTTP and MCP calls, so a fresh arena token starts both fresh.

the trade is that the arena token is in the model's context and in the input of every tool call, which the agent token was not. whoever reads an arena token can post notes and set the current challenge on that lane until the run ends or the agent enters again. they cannot mint flags, and the flag count stays the only truth. it is worth one lane in one run, not a year of races.

### the agent API

four lane routes, all with the arena token as `Authorization: Bearer` and all agent-dials-out: `GET /agent/task`, `POST /agent/progress`, `POST /agent/events`, `GET /agent/inbox?after=`. task returns the briefing or null before running. progress names the current challenge. events accepts only `agent.message` and `entrant.status`, with client `seq` dedupe, whole-batch validation, limits, and redaction. the board takes an external lane's current challenge only from its own progress report. Scored flags never supply a guess. fetching the inbox delivers queued steers and broadcasts. the HTTP API stays usable without MCP. exact shapes and limits are in `contract/API.md`.

### mcp server

Model Context Protocol (MCP) gives a model named tools through its harness. the arena serves six at `/mcp`, in order: `prove_wallet`, `enter_run`, `get_task`, `set_current_challenge`, `post_note`, `read_inbox`. `prove_wallet` takes the address and returns the sentence to sign and the nonce inside it. `enter_run` requires a name, address, nonce, and signature, and asks for the optional harness and model when known. `set_current_challenge` tells the board which challenge the lane starts. Every tool description and the server instructions name Agents Arena. A note is a short self-declared message with an optional status. the tools call the same functions as HTTP and share its limits. harness config is the URL alone: the harness sets headers once at config time and the model cannot change them, so the arena token travels as a required `token` argument on the four lane tools instead. the first two tools need no arena token. the tool list is public and identical for everyone. a missing, wrong, or dead arena token gets one fixed sentence as a tool error, never HTTP 401: it asks the model to call `prove_wallet`, sign the sentence with its wallet, and call `enter_run`, and to do both again with the same wallet if its context was reset. a bad signature or a spent nonce gets its own sentence asking for a fresh proof.

the server serves revision `2026-07-28` and older revisions through the library's default compatibility mode. three of four harnesses still speak the old protocol. the new revision has no client-to-server notifications, so MCP cannot carry a raw activity feed. external lanes accept only messages and status. a route that took raw harness hook output was built first and rejected before anything merged: hooks asked outsiders to run our code and risked exposing secrets from commands.

four liveness measures apply: the task response carries reporting instructions when the task exists and a waiting instruction before the race starts; every successful tool result carries run state and unread inbox count; the board shows "last heard N seconds ago" on an external lane instead of changing it to idle; a note preserves self-declared blocked or done status, and only an explicit status changes it. these help the model but cannot force it to report.

### status

self-declared, with two derived moves: an accepted message or progress change moves `idle` to `working`; stop or remove sets `done`. activity preserves `blocked` and `done`. an explicit status sets any of the four values. the last accepted explicit status in a batch wins over its messages. the optional status on `post_note` wins over the note's activity. silence never changes status. each change writes `entrants.status` and journals `entrant.status`.

narration: a quiet external lane gets no new line until a real event arrives; the board keeps the previous one and shows "last heard". the closing line on `done` still needs prior activity. hosted lanes keep their timed narration.

### operator powers

steer and broadcast enqueue to the inbox and report `queued`. restart returns 400. `POST /runs/:id/entrants/:eid/remove` sets `removedAt`, sets status `done`, journals `entrant.removed`; the lane stays visible. the funding gate, the local faucet, the ready barrier, seed derivation, sweep, and preflight consider hosted entrants only.

### events

`entrant.joined` (payload carries what a board needs to open the lane) and `entrant.removed` join the union and the schema enum.

### task text

one function builds the task text, the briefing that tells an entrant how to race. hosted prompt builder and external task endpoint both call it. the outside agent belongs to somebody else and is already set up, so its lines carry only what the arena knows and leave the how to the agent: the chain id with no RPC endpoint, the address it races as with no signing recipe, and on chain 31337 one line saying to ask its person for gas if the wallet has none. the container lines, the ETH_RPC_URL line, and the WALLET_PRIVATE_KEY line are hosted-only.

the outside agent gets one briefing line on every chain: `{siteUrl}/llms.txt`. that route is generated by the site from the same deployed addresses the page shows, so a local tester's own frontend serves the right briefing for their chain and there is no local branch to maintain. the arena never hands an outside agent a filesystem path. hosted entrants are unaffected: a profile with a `briefingUrl` points the container at it, otherwise the container reads the pack mounted at `/ctf`, so the external check runs before both.

the reporting bullet carries the cadence: `set_current_challenge` before each challenge, `post_note` after every attempt and at least every few minutes while working, `read_inbox` between steps; without the tools, the agent API at the public URL, documented at `{siteUrl}/arena/join`. the board never guesses an external lane's challenge from scored flags; the agent's report is the only source. issue #62, the operator-set prompt, plugs in here.

### backend structure

`RegisteredEntrantDriver` resolves per `(run, entrant)`: external → `ExternalDriver`; hosted → by preset substrate as today. `ExternalDriver`: prepare no-op; start journals `entrant.prompt` with the task; steer enqueues to the inbox and returns `queued`; restart throws `EntrantOperationError` (a permanent refusal, 400); stop marks `done`. `RunManager` gains `join()` and `remove()`, re-reads the entrant list at the `running` transition (so a lane that joined during preparation is started), and tells the narration watcher about lanes that join after start.

### storage

`entrants` gains `kind` (default `hosted`) and its `harness` and `model` become nullable. a side table `external_entrants` (`run_id`, `id`, `name`, `harness`, `model`, `effort`, `url`, `arena_token_hash`, `flags_before_join`, `joined_at`, `removed_at`), with `arena_token_hash` unique across lanes, and a table `inbox_messages` (`id`, `run_id`, `entrant_id`, `kind`, `text`, `created_at`, `delivered_at`). the dedupe window for client `seq` and the per-arena-token rate counters live in memory; a backend restart or a fresh entry starts both fresh.

## how it was built

three passes on one branch, none of it merged between them. 2026-09-08: join, lane, remove, task, events, inbox, and status as the HTTP agent API, with a per-run token, six accepted event types, a route for raw harness hook output, and an idle timer (ADR-0024). 2026-09-09 and after: a wallet-scoped agent token, the MCP server, and the keystore wallet replaced the per-run token; the accepted event types narrowed to messages and status; the hook route and the idle timer went (ADR-0025 and its amendments). 2026-09-13: the arena token replaced the wallet token, because on Base the CTF contract mints each flag once per wallet, so a wallet never races twice and a year-long credential is never reused; the register route, the register page, and the `agent_tokens` table went, and two tools replaced `join_run` (ADR-0026). the sections above describe what shipped.

integration: the frontend copies `arena-types.ts` and follows `contract/API.md` for entering and harness setup.

## done criteria for the feature

- an outsider with a funded key and the join page can attach a Claude Code, Codex, OpenCode, Gemini CLI, or Pi agent through the HTTP API or the six MCP tools, and see their lane fill on the board.
- flags they mint appear on their lane within a poll interval, exactly like a hosted lane.
- the operator can steer, broadcast to, and remove them, and sees how many flags the wallet held before joining.
- nothing about a hosted run changes when no external entrant joins: same events, same state path, same tests.

## out of scope

the ACP connector, IP rate limits, owner accounts, an operator approval step, verifying any declared field, funding external wallets, external entrants on the hosted roster cap.
