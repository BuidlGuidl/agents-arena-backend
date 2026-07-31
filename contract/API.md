# Agents Arena API

The backend listens on `PORT`, or port `4177` when `PORT` is unset. JSON request bodies use `Content-Type: application/json`.

## Runs

### `POST /runs`

Creates a run from the `fake-duel` preset. The preset creates `codex-1` and `opencode-1`. Set `autoStart` to `true` to begin the start flow.

```json
{"preset":"fake-duel","autoStart":true,"idempotencyKey":"demo-1"}
```

The response has status `201` for a new run and status `200` for an existing idempotent run.
The chainless `fake-duel` preset skips wallet seeding. The `docker-duel` preset uses the seed and funding gates.

```json
{"run":{"id":"...","state":"running","preset":"fake-duel","entrants":[],"startedAt":"...","deadlineAt":null,"lastEventId":4}}
```

The service supports one preset in this slice. An unknown preset returns status `400`.

### `GET /runs/:id`

Returns the current `RunSnapshot`. A missing run returns status `404`.

Each entrant carries its confirmed solves in journal order, and `flags` equals `solves.length`, so a reload can repaint the board without replaying events.

```json
{"id":"codex-1","harness":"codex","model":"...","address":"0x...","status":"working","flags":2,"solves":[{"challengeId":3,"ts":"...","txHash":"0x..."},{"challengeId":7,"ts":"...","txHash":"0x..."}],"inputTokens":36126,"outputTokens":126,"costUsd":0.046418}
```

`inputTokens` and `outputTokens` total every `usage` event for that entrant, and `costUsd` totals the priced ones. Both survive a reload, and a client that folds live `usage` events into its own copy reaches the same numbers.

`costUsd` is display only and can be `null`. A harness that prices its own turns (opencode through OpenRouter) reports the cost; a harness that reports tokens only (codex on a ChatGPT-account login) gets one from the backend rate table when its model is listed there; otherwise the field stays `null`. Cost is therefore partial — present for one entrant and absent for another in the same run.

A derived cost prices the `usage` event's `cachedInputTokens` at the model's cached rate, roughly a tenth of fresh input. Most of a codex turn is repeated context, so skipping that would overstate a turn about threefold.

Each `usage` event counts only the work it covers, never a running total, and `inputTokens` is the whole prompt with `cachedInputTokens` counted inside it. Events are not turns: codex emits one per turn, opencode one per step, so a turn that calls tools produces several. The harnesses also disagree upstream — codex reports a running session total that `exec resume` keeps growing, opencode reports its input net of cache reads — so the adapters normalize both to this shape before journalling.

### `POST /runs/:id/start`

Starts the run and returns its current snapshot. With local automatic signing, the request waits until the run reaches `running`. Without automatic signing, it returns after the run enters `awaiting_signature`. The run advances asynchronously after seed submission and funding. A run already at `ready` starts without preparation.

The `docker-duel` lifecycle is:

```text
created → awaiting_signature → preparing → awaiting_funding → ready → running → stopping → finished
```

Every nonterminal state can also advance to `failed`.
The chainless `fake-duel` preset moves from `created` to `preparing` and skips `awaiting_signature`.

The backend does not resume pre-terminal runs after a restart. Stop runs parked in `awaiting_signature` or another pre-terminal state, then create a new run.

### `POST /runs/:id/seed`

Accepts the funder's EIP-191 signature while the run is in `awaiting_signature`.
The signature is the recovery secret for the run's funds and travels in the POST body. Production deployments must serve this route over TLS only, and reverse proxies must not log its request body.

```json
{"signature":"0x..."}
```

The signed message contains one literal newline:

```text
agents-arena seed v1
run: <runId>
```

The backend verifies the signature against the active chain profile's `funderAddress`. It derives each entrant wallet in memory, stores each address on the entrant, and emits one `wallet.assigned` event per entrant. The signature and private keys never enter the event journal or database.

A valid request returns status `202` with the current run snapshot. A malformed or non-canonical signature returns status `400`. A canonical signature from another address returns status `403`. A run outside `awaiting_signature` returns status `409`.

### `POST /runs/:id/stop`

Stops every entrant and advances a running run through `stopping` to `finished`. A run in `awaiting_signature` also advances through `stopping` to `finished`.

### `POST /runs/:id/entrants/:eid/steer`

Sends text to one entrant.

```json
{"text":"Inspect the contract first."}
```

The response has status `202`. An entrant that exists but cannot take a turn — stopping, or degraded — returns status `409`, and the refusal is recorded on that entrant's feed as an `entrant.error`.

### `POST /runs/:id/broadcast`

Sends one director message to every entrant that is not `done`. Each recipient takes it as a steer turn, and the run emits one `director.broadcast` event, payload `{text, targetEntrantIds}`, so every viewer sees the message once. `targetEntrantIds` is who the director addressed; delivery truth is the response below.

```json
{"text":"Five minutes left, ship what you have."}
```

The run must be `running`; any other state returns status `400` and nothing reaches the entrants. Before the opening turn the harness has no session to resume, so there is nothing a broadcast could inject into.

The response has status `202`. An entrant that cannot take the turn is named in `failed` and gets an `entrant.error` event; the rest still receive the message.

`delivered` means the entrant accepted the message, not that it has read it yet: an entrant that is mid-turn queues it and takes it when that turn ends, exactly as a per-entrant steer does. The `director.broadcast` event lands immediately either way, so the feed shows the message the moment the director sends it.

```json
{"accepted":true,"delivered":["codex-1"],"failed":[{"entrantId":"opencode-1","message":"Entrant opencode-1 is stopping"}]}
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
