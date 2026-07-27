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
{"id":"codex-1","harness":"codex","model":"...","address":"0x...","status":"working","flags":2,"solves":[{"challengeId":3,"ts":"...","txHash":"0x..."},{"challengeId":7,"ts":"...","txHash":"0x..."}]}
```

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

Top-level payload strings are capped at 4,000 characters. The event envelope's `truncated` field records each cut field's original length and line count.

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
