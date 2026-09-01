# Agents Arena API

The backend listens on `PORT`, or port `4177` when `PORT` is unset. JSON request bodies use `Content-Type: application/json`.

## Operations and environment

Set `ARENA_CORS_ORIGINS` to a comma-separated list of browser origins that can call the backend. Each entry is an exact origin, including its scheme and port when present. For local development, use `ARENA_CORS_ORIGINS=http://localhost:3000`.

When the variable is unset or blank, the backend registers no CORS support and sends no CORS headers. When set, CORS allows credentials, methods `GET`, `POST`, `HEAD`, and `OPTIONS`, and request headers `Content-Type` and `Authorization`. It exposes no extra response headers.

## Operator auth

Every mutating route (create, start, stop, steer, restart, broadcast) needs one of two credentials. The snapshot, the event stream, and the history read are open, so spectators need neither.

**Shared token** — for scripts, the launcher, and a frontend that proxies from its own server:

```text
Authorization: Bearer <ARENA_OPERATOR_TOKEN>
```

**Wallet session** — for the operator signing in on a site with his wallet. Cookie `arena_operator`, minted by `POST /auth/verify` below and sent by the browser automatically.

A request carrying neither returns status `401` and `{"error":"Operator token required"}`.

`ARENA_OPERATOR_TOKEN` is required — the backend refuses to start without it, so a deployment cannot leave the controls open by accident. `ARENA_OPERATOR_ADDRESSES` authorizes wallet login and seed signing. With it unset, the `/auth` routes answer `503`, the arena is token-only, and only local auto-sign can seed a run.

**For a frontend:** either credential works, and both keep the secret out of the browser. With the token, proxy the control calls through your own server — a route handler that holds `ARENA_OPERATOR_TOKEN` in its environment and adds the header. With wallet login, the cookie is `HttpOnly`, so page scripts cannot read it either. What you must not do is ship the token to the page and send it from there: that exposes it to any XSS and to anyone reading devtools over the operator's shoulder on a live stream. See ADR-0012.

## Wallet login

Sign-In with Ethereum ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)). Three steps: take a nonce, have the operator sign a message carrying it, exchange the signature for a session.

### `GET /auth/nonce`

```json
{"nonce":"8Vf3kPqR2sT"}
```

Single use and valid for 10 minutes. `Cache-Control: no-store`. The value carries its own expiry under a MAC, so the backend stores nothing until a signature spends it — take one per login attempt and do not cache it.

### `POST /auth/verify`

Body is the EIP-4361 message the wallet signed, verbatim, plus its signature.

```json
{"message":"arena.example.com wants you to sign in with your Ethereum account:\n0x…","signature":"0x…"}
```

Status `200` mints the session and sets the cookie.

```json
{"address":"0x…","expiresAt":"2026-07-31T04:12:00.000Z"}
```

Status `401` names what failed: an unknown or already used nonce, a message domain that is not this server's, an expired message, an address outside the allowlist, or a signature that does not match. Status `503` means wallet login is not configured.

The message's `domain` must match one of the hosts listed in `ARENA_SIWE_DOMAINS`, and the message's `uri` must carry that same host. `ARENA_SIWE_DOMAINS` is required whenever wallet login is on, and the backend refuses to start without it: checking the signed domain against the request's own `Host` would compare two values the caller supplies, which accepts a phished origin. List the hostname the operator's browser is on — the one your frontend serves — because that is what the wallet shows him before he signs, and it is the anti-phishing check.

The signed message must also carry `Version: 1`, and its `uri` must be `https` unless the domain is a loopback host — the local demo is the only thing served over plain http.

Only externally owned accounts are verified. A smart-contract wallet (ERC-1271 / ERC-6492) needs a client on the chain that holds it and is not supported yet.

### `GET /auth/session`

```json
{"authenticated":true,"address":"0x…","expiresAt":"2026-07-31T04:12:00.000Z"}
```

```json
{"authenticated":false,"configured":true}
```

Open to anyone, so a page can render its own login state. `configured` is `false` when the backend has no operator allowlist — hide the sign-in control rather than offer one that can only answer `503`.

### `POST /auth/logout`

Drops the session and clears the cookie. Takes no credential, since it only destroys the caller's own session.

### Session and cookie

The cookie is `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` unless the request host is loopback. `SameSite=Strict` is the CSRF defence: a browser will not attach the cookie to a request started by another site, so a hostile page cannot stop a race with the operator's own session.

A session lasts 12 hours. Sessions and nonces live in the backend process, so a restart signs the operator out — the same restart already drops the run it was driving.

## Runs

### `POST /runs`

Creates a run from a required preset. The preset selects the fake or Docker substrate. It supplies entrants when `roster` is absent. Set `autoStart` to `true` to begin the start flow. The optional `durationMs` must be an integer from `60000` through `86400000`.

```json
{"preset":"fake-duel","autoStart":true,"idempotencyKey":"demo-1","durationMs":3600000}
```

The backend stores `durationMs` when it creates the run. When the run enters `running`, it sets `deadlineAt` to that transition time plus `durationMs`. The deadline is display only. The backend does not stop or enforce the run at that time; the operator stops it manually. If `durationMs` is absent, `deadlineAt` stays `null`.

An optional `roster` replaces the preset entrants. It accepts 1–10 entries:

```json
{
  "preset":"fake-duel",
  "autoStart":true,
  "roster":[
    {"id":"claude-a","harness":"claude","model":"claude-opus-5"},
    {"id":"claude-b","harness":"claude","model":"claude-sonnet-5"}
  ]
}
```

Each `id` must match `^[a-z][a-z0-9-]*$`, contain at most 20 characters, and be unique within the roster. Docker names allow 63 characters; `arena-`, the 36-character run UUID, and their separator leave 20 characters for the entrant ID. The ID `run` is reserved for run-level feed events. `harness` must be `codex`, `opencode`, or `claude`. The `model` must appear in the selected harness's allowlist:

- `codex`: `gpt-5.5`
- `claude`: `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`
- `opencode`: `openrouter/z-ai/glm-5.3`, `openrouter/moonshotai/kimi-k3`, `openrouter/deepseek/deepseek-v4-pro-0813`, `openrouter/qwen/qwen3.8-2.4t-a95b`

All three harnesses accept the optional `effort` field. Codex and Claude accept `low`, `medium`, `high`, `xhigh`, or `max`. OpenCode accepts `low`, `medium`, or `high` because OpenRouter supports only those effort levels.

The response has status `201` for a new run and status `200` for an existing idempotent run.
The chainless `fake-duel` preset skips wallet seeding. The `docker-duel` preset uses the seed and funding gates.

```json
{"run":{"id":"...","state":"running","preset":"fake-duel","chainId":31337,"entrants":[],"startedAt":"2026-08-05T10:00:00.000Z","deadlineAt":"2026-08-05T11:00:00.000Z","lastEventId":4}}
```

An unknown preset or invalid roster returns status `400`.

### `GET /runs`

Returns `{"runs": RunListItem[]}` with the newest runs first by `createdAt`. Each item carries `id`, `state`, `createdAt`, `startedAt`, `seededBy`, and `agentCount` — the number of entrants. `seededBy` is the seed signer address or `null` before seeding. The list is deliberately thin: finish time, winner, scores, and events live on `GET /runs/:id`.

The optional `limit` query accepts an integer from 1 to 200 and defaults to 50. An invalid `limit` returns status `400`.

```json
{"runs":[{"id":"...","state":"finished","createdAt":"2026-08-05T10:00:00.000Z","startedAt":"2026-08-05T10:01:00.000Z","seededBy":"0x...","agentCount":2}]}
```

### `GET /runs/:id`

Returns `{"run": RunSnapshot}` — every run endpoint (create, get, start, seed, stop) wraps the snapshot in this same envelope, the `RunResponse` type in the contract file. A missing run returns status `404`.

`chainId` is the active chain profile's chain ID. Clients use it for seed typed data and chain links instead of assuming Anvil's `31337`. `seededBy` is the recovered seed signer address and appears only after a successful seed. `deadlineAt` is the display-only deadline set when the run enters `running`; it does not trigger a timer or state change.

Each entrant carries its confirmed solves in journal order, and `flags` equals `solves.length`, so a reload can repaint the board without replaying events.

```json
{"id":"codex-1","harness":"codex","model":"...","address":"0x...","status":"working","flags":2,"solves":[{"challengeId":3,"ts":"...","txHash":"0x..."},{"challengeId":7,"ts":"...","txHash":"0x..."}],"inputTokens":36126,"outputTokens":126,"costUsd":0.046418,"currentChallengeId":5,"narration":{"text":"The entrant is testing challenge #5.","ts":"...","basedOnEventId":42}}
```

`inputTokens` and `outputTokens` total every `usage` event for that entrant, and `costUsd` totals the priced ones. Both survive a reload, and a client that folds live `usage` events into its own copy reaches the same numbers.

`costUsd` is display only and can be `null`. A harness that prices its own turns (opencode through OpenRouter) reports the cost; a harness that reports tokens only (codex on a ChatGPT-account login) gets one from the backend rate table when its model is listed there; otherwise the field stays `null`. Cost is therefore partial — present for one entrant and absent for another in the same run.

A derived cost prices the `usage` event's `cachedInputTokens` at the model's cached rate, roughly a tenth of fresh input. Most of a codex turn is repeated context, so skipping that would overstate a turn about threefold.

A claude turn that delegates to a subagent spends tokens on more than one model, so its cost is derived per model rather than from the entrant's model alone — a model the rate table does not list falls back to the entrant's rate. The tokens on the event stay aggregate; only the cost is split.

Each `usage` event counts only the work it covers, never a running total, and `inputTokens` is the whole prompt with `cachedInputTokens` counted inside it. Events are not turns: codex emits one per turn, opencode one per step, so a turn that calls tools produces several. The harnesses also disagree upstream — codex reports a running session total that `exec resume` keeps growing, opencode reports its input net of cache reads — so the adapters normalize both to this shape before journalling.

The agent's `POST /agent/progress` announcement is the authoritative `currentChallengeId` and journals with `via: "self"`. The backend also guesses from commands (`via: "command"`) and agent prose (`via: "message"`). A guess replaces an empty target, a solved target, or another guess. It never replaces a live self-reported target. A guess refused by a live self-report is kept as a pending guess and applied when that challenge is solved; the latest one wins. Solved challenge ids are ignored when matching commands and prose. Each accepted change journals `entrant.challenge`, and `evidence` records the matched text. The snapshot stays `null` until a source names a challenge; old events without `via` or `evidence` count as self-reports.

`narration` is absent until the backend writes an `entrant.narration` event. The
latest row wins. Its `basedOnEventId` is the highest journal row used for that
line, and `ts` is the narration event time. Narration model calls never add to
entrant `usage` totals.

### `POST /agent/progress`

The agent-facing announce route. Authenticated by the per-entrant bearer token the driver injects into the container as `ARENA_AGENT_TOKEN` — the operator credential is rejected here, and the token dies with the entrant's container. The backend base URL is injected as `ARENA_API_URL` (override with `ARENA_AGENT_API_URL`; defaults to `http://host.docker.internal:<port>`).

```json
{"challengeId": 5}
```

`challengeId` must be an integer from 1 to 12. Announcing the value already current answers `{"ok":true,"changed":false}` without journalling. A change journals `entrant.challenge` with `via: "self"` and answers `{"ok":true,"changed":true}`; changes faster than once a second get status `429`. A missing or unknown token gets status `401`. Journalled announcements stream and replay like every other event.

### `POST /runs/:id/start`

Starts the run and returns `{"run": RunSnapshot}`. **A docker run needs this route twice.** The first call prepares and funds it and leaves it at `ready`; the second takes it to `running`, and that second call is what sets `startedAt` and the deadline and feeds the entrants their opening prompts. Funding is a step the operator drives by hand, so the race waits for them rather than for the last wallet to be topped up.

With local automatic signing, the first call waits until the run reaches `ready`. Without automatic signing, it returns after the run enters `awaiting_signature` and the run advances asynchronously — through seed submission and funding — to `ready`. The second call returns once the run is `running`; the entrants' first turns are still spinning up behind it.

Chainless presets have nothing to fund, so their single start call runs straight through to `running`.

A run parked at `ready` holds the single active-run slot until it is started or stopped. `POST /runs/:id/stop` is legal there and ends it `failed` with an operator-stop reason.

The `docker-duel` lifecycle is:

```text
created → awaiting_signature → preparing → awaiting_funding → ready →[start]→ running → stopping → finished
```

Every nonterminal state can also advance to `failed`.
The chainless `fake-duel` preset moves from `created` to `preparing`, skips `awaiting_signature`, and does not stop at `ready`.

The backend does not resume pre-terminal runs after a restart. Stop runs parked in `awaiting_signature` or another pre-terminal state, then create a new run.

### `POST /runs/:id/seed`

Accepts an allowlisted operator's EIP-712 signature while the run is in `awaiting_signature`.
The signature is the recovery secret for the run's funds and travels in the POST body. Production deployments must serve this route over TLS only, and reverse proxies must not log its request body.

```json
{"signature":"0x..."}
```

The seed signer signs this typed data. `chainId` is the active chain profile's chain ID; this example uses the local profile:

```json
{
  "domain": {
    "name": "agents-arena",
    "version": "1",
    "chainId": 31337
  },
  "types": {
    "EIP712Domain": [
      {
        "name": "name",
        "type": "string"
      },
      {
        "name": "version",
        "type": "string"
      },
      {
        "name": "chainId",
        "type": "uint256"
      }
    ],
    "Seed": [
      {
        "name": "runId",
        "type": "string"
      }
    ]
  },
  "primaryType": "Seed",
  "message": {
    "runId": "<runId>"
  }
}
```

The domain has no `verifyingContract`. The backend verifies that the recovered address is in `ARENA_OPERATOR_ADDRESSES`. It derives each entrant wallet in memory, stores the signer as `seededBy`, stores each address on the entrant, and emits one `wallet.assigned` event per entrant. The signature and private keys never enter the event journal or database. Local automatic signing bypasses the allowlist and records the local dev signer.

A valid request returns status `202` with `{"run": RunSnapshot}`. A malformed or non-canonical signature returns status `400`. A canonical signature from a non-operator address returns status `403`. A run outside `awaiting_signature` returns status `409`.

### `POST /runs/:id/sweep`

Sweeps leftover native funds from the run's entrant wallets to its seed signer. The global operator credential protects this route. The signature is the fund-recovery capability: it must recover to the run's stored `seededBy` address.

```json
{"signature":"0x..."}
```

Sign the exact `Seed` typed data from `POST /runs/:id/seed` again. Use the same `runId` and the active `chainId`. Deterministic EOA signing recreates the run's original seed signature and, therefore, the same derived wallet keys. The request has no destination field. Every transfer targets the verified signer.

The route accepts runs in `awaiting_funding`, `ready`, `finished`, or `failed`. It rejects `created`, `awaiting_signature`, `preparing`, `running`, and `stopping` runs. It also rejects a run with a start in flight. Before any RPC call, it derives every addressed entrant wallet again and compares each address with the database. A mismatch rejects the whole request because the signature did not reproduce the keys that created the stored wallets.

The backend reads the RPC gas price once. For each entrant, it reads the native balance and estimates a plain transfer. Chains with a gas price oracle in viem's registry also estimate the L1 data fee. The transfer value is `balance - gas * gasPrice - 2 * l1Fee`. The L1 fee buffer covers changes before inclusion and leaves any dust in the wallet. A non-positive value gets `skipped_low_balance`.

Any balance, gas, fee, wallet, or send error gets `failed`, and the backend continues with the remaining entrants. Error text uses the transport's short message when available and never includes an HTTP RPC URL. If the run leaves a sweepable state before a send, that entrant and all remaining entrants get `failed` with `run state changed during sweep`. The response keeps earlier transaction hashes and does not wait for receipts.

```json
{
  "runId":"...",
  "to":"0x...",
  "chainId":31337,
  "results":[
    {
      "entrantId":"codex-1",
      "address":"0x...",
      "balanceWei":"10000000000000000",
      "status":"swept",
      "txHash":"0x..."
    },
    {
      "entrantId":"opencode-1",
      "address":"0x...",
      "balanceWei":"12000",
      "status":"skipped_low_balance"
    }
  ]
}
```

The route returns these errors:

| Status | Cause |
| --- | --- |
| `400` | The body is malformed, has extra fields, or lacks a 65-byte hex signature. |
| `400` | The signature encoding is non-canonical, including a high-s signature. |
| `401` | The request lacks valid operator auth. |
| `403` | The signature does not recover to the run's stored seed signer. |
| `404` | The run does not exist. |
| `409` | The run state is not sweepable, a start is in flight, or the run has no seeded addressed wallets. |
| `409` | The signature does not reproduce the run's wallets. The signer must re-sign deterministically with an RFC 6979 EOA on the run's original chain. |

A per-entrant error does not change the HTTP status. The matching result uses `status: "failed"` and includes `error`; other entrant sweeps continue. `balanceWei` is absent if the balance was not read.

### `POST /runs/:id/stop`

Stops every entrant and advances a running run through `stopping` to `finished`. A run in `awaiting_signature` also advances through `stopping` to `finished`. Returns `{"run": RunSnapshot}`.

### `POST /runs/:id/entrants/:eid/steer`

Sends text to one entrant.

```json
{"text":"Inspect the contract first."}
```

The response has status `202`. `status` is `injected` when the turn entered the session now, or `queued` when it waits behind a turn in flight.

```json
{"accepted":true,"status":"injected"}
```

An entrant that exists but cannot take a turn — stopping, or degraded — returns status `409`, and the refusal is recorded on that entrant's feed as an `entrant.error`.

### `POST /runs/:id/entrants/:eid/restart`

Recovers one lane whose session went stale or blocked. The turn in flight is killed, anything queued behind it is dropped and journaled as an `entrant.error`, and the harness starts a **new** session on the entrant's opening prompt — the entrant's container, wallet, credentials, and challenge pack are kept, and no other lane is touched. A `blocked` entrant becomes steerable again.

There is no request body. The opening prompt is rebuilt by the backend, so this route cannot be used to feed an entrant something else — that is what steer is for.

The response has status `202`.

```json
{"accepted":true}
```

The lane emits `entrant.restarted`, payload `{entrantId}`, followed by the usual `entrant.prompt` carrying the re-fed prompt. Solves, usage totals, and the run's own state are unchanged.

An unknown run or entrant returns status `404`, whatever state the run is in. Otherwise the run must be `running`; any other state returns status `400`. A lane that cannot be restarted right now — one already stopping or restarting — returns status `409`. Any failure is also recorded on that entrant's feed as an `entrant.error`.

A restart that fails after the old session is already killed leaves the entrant `blocked`: `entrant.restarted` is on the feed with no `entrant.prompt` behind it, and because the lane has no session left, a steer cannot revive it — only another restart can.

### `POST /runs/:id/broadcast`

Sends one director message to every entrant that is not `done`. Each recipient takes it as a steer turn, and the run emits one `director.broadcast` event, payload `{text, targetEntrantIds}`, so every viewer sees the message once. `targetEntrantIds` is who the director addressed; delivery truth is the response below.

```json
{"text":"Five minutes left, ship what you have."}
```

The run must be `running`; any other state returns status `400` and nothing reaches the entrants. Before the opening turn the harness has no session to resume, so there is nothing a broadcast could inject into.

The response has status `202`. An entrant that cannot take the turn is named in `failed` and gets an `entrant.error` event; the rest still receive the message.

`delivered` means the entrant accepted the message. `queued` names the delivered entrants whose message still waits behind a turn in flight; if such an entrant degrades or stops before its turn ends, the drop is journaled as an `entrant.error`. The `director.broadcast` event lands immediately either way, while `entrant.steered` lands only when the message enters the session.

```json
{"accepted":true,"delivered":["codex-1","opencode-1"],"queued":["codex-1"],"failed":[{"entrantId":"claude-1","message":"Entrant claude-1 is stopping"}]}
```

## Event stream

### `GET /runs/:id/events`

Returns `text/event-stream`. Each frame contains the global journal ID and the full JSON event.

```text
id: 12
data: {"id":12,"runId":"...","source":"codex-1","seq":2,"ts":"...","type":"agent.message","payload":{"entrantId":"codex-1","text":"..."}}

```

Send `Last-Event-ID: 12` or `?after=12` to replay later events before live delivery. If both values exist, the service uses the larger value. The server subscribes before replay and removes duplicate IDs. A heartbeat comment arrives every 15 seconds.

Event IDs increase across all runs. Per-source `seq` values increase within each `(runId, source)` pair.

| Event type | Payload |
| --- | --- |
| `run.state` | `{state, reason?}` |
| `entrant.status` | `{entrantId, status}` |
| `agent.message`, `agent.reasoning` | `{entrantId, text}` |
| `tool.call`, `tool.result` | Tool name, call ID, detail, and result fields |
| `entrant.steered`, `entrant.prompt` | `{entrantId, text}` |
| `entrant.restarted` | `{entrantId}` |
| `entrant.nudged` | `{entrantId, text, flags}` |
| `director.broadcast` | `{text, targetEntrantIds}` |
| `wallet.assigned`, `funding.balance` | Entrant wallet and balance fields |
| `score.flag` | `{entrantId, challengeId, txHash, tokenId}` |
| `entrant.challenge` | `{entrantId, challengeId, via?, evidence?}` |
| `entrant.narration` | `{entrantId, text, basedOnEventId}` |
| `entrant.error`, `run.error` | Entrant or run error fields |
| `usage` | Entrant token and cost fields |

The journal retains payloads in full. Payload strings are capped at 4,000 characters when delivered over the SSE stream or history read. The event envelope's `truncated` keys are dotted paths to capped fields and record each original length and line count.

### `GET /runs/:id/events/history`

Returns a bounded page from the event journal.

| Parameter | Type | Default | Rule |
| --- | --- | --- | --- |
| `limit` | integer | `50` | From `1` through `200` |
| `before` | integer | none | At least `1`; excludes the event with this ID |
| `types` | CSV | none | Each item must be an event type |
| `source` | CSV | none | Source IDs |

```json
{"events":[],"lastEventId":42,"hasMore":false}
```

Events are ordered by ascending ID. `hasMore` reports whether older matching events exist. Pass the oldest returned event ID as the exclusive `before` cursor to read the prior page.

`lastEventId` is the unfiltered run head. Open the SSE stream with it. A client that filters by type still receives every type from that stream.

A page whose `before` is at or below `lastEventId + 1` can never gain events. The service marks it `Cache-Control: public, max-age=31536000, immutable` and omits `lastEventId`, which changes as the run continues. Every other response carries `lastEventId` and uses `Cache-Control: public, max-age=1`.

## Contract file

[`arena-types.ts`](./arena-types.ts) defines the shared request, snapshot, and event types. It has no dependencies and can be copied as one file.
