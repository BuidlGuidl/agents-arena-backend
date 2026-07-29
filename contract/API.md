# Agents Arena API

The backend listens on `PORT`, or port `4177` when `PORT` is unset. JSON request bodies use `Content-Type: application/json`.

## Runs

### `POST /runs`

Creates a run from the `fake-duel` preset. The preset creates `codex-1` and `opencode-1`. Set `autoStart` to `true` to prepare and start both entrants.

```json
{"preset":"fake-duel","autoStart":true,"idempotencyKey":"demo-1"}
```

The response has status `201` for a new run and status `200` for an existing idempotent run.

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

Prepares a new run, advances it to `ready`, and starts each entrant. A run already at `ready` starts without preparation.

### `POST /runs/:id/stop`

Stops every entrant and advances a running run through `stopping` to `finished`.

### `POST /runs/:id/entrants/:eid/steer`

Sends text to one entrant.

```json
{"text":"Inspect the contract first."}
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

## Contract file

[`arena-types.ts`](./arena-types.ts) defines the shared request, snapshot, and event types. It has no dependencies and can be copied as one file.
