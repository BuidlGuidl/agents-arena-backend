# narration — a cheap model writes what each entrant is doing

Status: design agreed 2026-08-20, from ai.ctf issue #46 (Austin's feedback). See ADR-0021.

## the problem

A spectator watching five terminals cannot tell what any agent is doing. The live feed
is noise and the per-agent console is a wall of text. `currentChallengeId` says *which*
challenge, never *what* the agent is doing about it.

## the shape

A backend-side watcher reads each running entrant's events from the journal and asks a
cheap model (Haiku by default, over OpenRouter, through the Vercel AI SDK) for one or two
short present-tense sentences, 30 words at most. The result is journaled as a new event,
`entrant.narration`, under the entrant's own source. The snapshot exposes the latest line
per entrant as `EntrantSummary.narration`. Nothing touches the harness driver, the
parsers, or the `EntrantStatus` enum (ADR-0011 stands: lifecycle in the enum, activity
on the feed).

The frontend renders it three ways: a hover tooltip on the agent handle, a "Narration"
toggle in the per-agent console that filters to narration rows, and the status strip in
each multiview card. The live feed is untouched.

## when a line is written

Per entrant, while the run is `running` and the entrant is `working` or `blocked`:

- New events since the last line **and** at least `ARENA_NARRATION_MIN_MS` (default
  10 000) since the last call for this entrant → call.
- No new events for `ARENA_NARRATION_MAX_MS` (default 90 000) while the entrant is
  `working` or `blocked` → call anyway. The prompt says "no new events since your last
  line; the last command started N seconds ago", so the model narrates the wait instead
  of inventing progress.
- `idle` is the between-turns state (`finishTurn` sets it after every turn; a steer or
  nudge sets `working` again), not the end. An idle entrant gets a line when the status
  change arrives (it is an event) and then only on new events; the 90 s ceiling does
  not apply while idle, so a parked lane costs nothing.
- `done` is terminal: one closing line, then stop. A backend restart must not repeat it.
  `done` is written by `driver.stop` during run teardown, so `RunManager.stop` does not
  abort the watcher up front: it lets teardown finish, then aborts after a 45 s grace
  window. Each lane writes its closing line and returns on its own inside that window.
- One in-flight call per entrant. Entrants never wait on each other. Every call has a
  timeout and is aborted when the run stops.
- The first line for an entrant is not held back by the floor: there is no previous
  call to measure from.

Why both bounds: a fixed interval burns calls on idle agents and lags on busy ones. A
pure event trigger goes silent inside a long `forge test`. The opencode parser emits
`tool.call` and `tool.result` together on completion (`opencode-parser.ts:30`), so an
opencode lane mid-command produces nothing; the max bound is what keeps it alive.

## what the model sees

System prompt: the race in one line, the 12 challenge names from the pack, then the voice:
every line is about the same agent, so no name and no pronoun, start with the verb; say
plainly what it is doing, one or two short sentences, present tense, the actual commands
and files; no metaphors, no drama, no jargon; name the challenge number when known; don't
repeat elapsed time or status; if nothing changed, say what it is waiting on. The call runs
at temperature 0.3, output capped at 80 tokens, first two sentences kept as a backstop.

User turn, built from the journal (full payloads, not the 4000-char wire cap):

- Events since `basedOnEventId` of the last line, capped at 40, each rendered as one
  text line the way the mock frontend's `describeEvent` does. Every text field is
  trimmed to ~300 chars (`tool.call` detail can be a whole file body from opencode's
  edit tool), and the whole prompt is capped at ~12k chars. Steers, prompts,
  broadcasts, errors included.
- The entrant's last 3–5 narration lines, so it can say "third attempt" without
  recomputing.
- `currentChallengeId` and its `via`, the status, solved flags, the open tool call and
  its age, elapsed run time. Open tool calls are loop state, capped at 20, and cleared
  when the turn ends (`idle`, `done`) or the session restarts, so an aborted turn's
  dangling call is never reported as still running.

Target 2–3k input tokens per call.

## the event

```ts
{
  type: 'entrant.narration',
  payload: { entrantId: string; text: string; basedOnEventId: number }
}
```

`basedOnEventId` is the highest journal id the window read, relevant to this entrant or
not, so the next read starts at the head instead of re-parsing other lanes' rows. It
makes the line auditable and is the cursor the watcher resumes from after a restart. It
is not unique:
a ceiling-triggered line with no new events repeats the previous cursor. Clients order
and dedupe narration rows by the event's own journal `id`.

The watcher must not rescan the whole journal on every wake-up. It checks the timing
gate first, and reads only the rows it needs through the indexed journal queries
(`after(runId, cursor)` for new events, `history` with `types`/`sources` filters for
previous lines and the last challenge row).

Snapshot: `EntrantSummary.narration?: { text: string; ts: string; basedOnEventId: number }`,
derived last-write-wins the same way `challengeByEntrant` derives `currentChallengeId`
(`run-manager.ts`).

## config and failure

| var | default | meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | already used by the opencode adapter; narration is off without it |
| `ARENA_NARRATION` | `on` | `off` disables the watcher entirely |
| `ARENA_NARRATION_MODEL` | `anthropic/claude-haiku-4.5` | any OpenRouter model id; cheap alternatives worth trying: `google/gemini-2.5-flash-lite`, `openai/gpt-5-nano` |
| `ARENA_NARRATION_MIN_MS` | `10000` | floor between calls for one entrant |
| `ARENA_NARRATION_MAX_MS` | `90000` | ceiling before a call with no new events |

On an API failure: log at warn, exponential backoff to 60 s (same shape as
`SolvePoller`), no `run.error`, nothing in the `usage` event. A missing line beats a red
error on the spectator board, and narration tokens must not leak into the leaderboard
cost column.

## code layout

- `packages/backend/src/narration/watch.ts` — the per-run watcher, `(run, entrants,
  signal) => void`, started and aborted by `RunManager` exactly like `SolveWatch`.
- `packages/backend/src/narration/window.ts` — builds the prompt input from the journal.
- `packages/backend/src/narration/openrouter.ts` — the AI SDK call. The only file that
  talks to the network; injected through `ServerOptions.narrate` so tests use a fake.
- `contract/arena-types.ts`, `contract/API.md`, `db/schema.ts` `eventTypes`, and the mock
  frontend's `describeEvent` / `event-style.ts` / `project-snapshot.ts` gain the new type.

## tests

Unit, no network: the window builder (trimming, caps, previous lines), the timing rules
(min, max, idle, done, one in-flight), the journal write and snapshot derivation, and
the history endpoint accepting `types=entrant.narration`.
