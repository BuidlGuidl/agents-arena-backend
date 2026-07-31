# Agents Arena v1 backend — PRD

frozen from the design session on 2026-07-22. locked decisions are in `docs/adr/decisions-log.md`; later ADRs amend this historical plan. vocabulary is in glossary.md. this PRD defines the vertical slices. it covers the **backend only** — damu and pablo own the real frontend in their ai-ctf fork.

## goal

one authoritative backend that runs a live race: one Codex entrant and one OpenCode entrant (Claude Code deferred, ADR-0008), in isolated Docker containers, solving the real ai-ctf repo on Base. the funder signs and funds through the waiting room before Austin releases the race; Austin can steer either agent mid-race. the browser sees a normalized, replayable event feed; the leaderboard is on-chain `FlagMinted` truth.

## success bars

1. a codex-vs-opencode run survives a browser reconnect and a backend restart without losing timeline or double-counting a flag.
2. after the signature and funding gates pass, Austin releases both entrants from the same ready barrier, so boot time never decides the race.
3. Austin can inject a free-text steer into either entrant while it runs, and the arena auto-nudges an idle entrant that still has flags to win.
4. every mint is scored from chain events, mapped to the right entrant wallet, exactly once.
5. the whole vertical slice is demoable in a mock frontend against the ai-ctf local chain — no live ETH until the rehearsal slice.

## locked decisions (see ADRs)

- **separate repo** `agents-arena-backend`, its own mock React frontend for demos (ADR-0001).
- **API contract as checked-in files** (`contract/API.md` + `contract/arena-types.ts`), copied by the frontend fork (ADR-0002).
- **entrant = persistent steerable session**, not a one-shot process; Austin-steer and auto-nudge are one injection path (ADR-0003).
- **transport = stdout JSON**; hooks deferred (ADR-0004).
- **fresh wallet per entrant per run**; its private key comes from a verified funder seed signature and lives only in process memory, while SQLite stores the address. the funding gate only watches balances (ADR-0005, amended by ADR-0013 and ADR-0014).
- **agent self-registers its ERC-8004 identity**; the backend never writes to a registry (ADR-0006).
- **dev substrate = ai-ctf local chain via a chain profile**; real Base only at rehearsal (ADR-0007).

## stack

TypeScript on Node, Fastify (HTTP + SSE), `dockerode` (containers), `viem` (chain watch + funding), SQLite (journal + snapshots), `codex` and `opencode` pinned CLIs inside one pinned image with Foundry. toolchain: pnpm workspaces, `tsx` runtime (no build step), `vitest`. no Redis, NATS, Kubernetes, or worker queue. mock frontend: minimal React (Vite), deliberately ugly.

## run lifecycle

`created → awaiting_signature → preparing → awaiting_funding → ready → running → stopping → finished` (any state can move to `failed`). the run manager is the only writer of this state; on restart it reconciles SQLite against containers carrying `runId`/`entrantId` Docker labels.

## backend modules (the seams)

- **run manager** — owns lifecycle, readiness, one start time, stop, restart reconciliation.
- **entrant runtime** (`arena-runner`, container PID 1 via `--init`) — creates the container, injects the in-memory burner key + private credential home, runs preflight, holds behind the barrier, owns the persistent session, injects turns, forwards stdout, tears down.
- **harness adapter** — per-CLI: command, credential home, preflight, stdout parser, mapping to `ArenaEvent`, turn injection. Codex and OpenCode in v1; Claude later behind the same seam (ADR-0008).
- **event journal** — SQLite, append-only, global `id`, per-source `seq`, one run-level SSE stream, `Last-Event-ID` replay, Docker-log dedup on restart.
- **game-state adapter** — `viem` watches `FlagMinted`, maps wallet → entrant, projects score events (unique on `(runId, entrantAddress, challengeId)`, two confirmations), `Ponder` for reconciliation.
- **wallet/funding** — verifies the funder signature, derives burner keys in memory, stores addresses only, watches balances, and drops keys at teardown. the funder can re-sign and re-derive offline to sweep leftovers.

## endpoints (contract)

| endpoint | use |
|---|---|
| `POST /runs` | create from a preset; accepts `autoStart` and an idempotency key |
| `POST /runs/:id/start` | begin the signature, preparation, and funding flow; release a ready run |
| `POST /runs/:id/seed` | accept the funder's EIP-191 seed signature while the run is in `awaiting_signature` |
| `POST /runs/:id/stop` | stop and clean up |
| `POST /runs/:id/entrants/:eid/steer` | inject an Austin steer turn into one entrant |
| `POST /runs/:id/broadcast` | fan one director message into every live entrant, recorded once on the feed |
| `GET /runs/:id` | snapshot: state, entrants, addresses, scores, last event id |
| `GET /runs/:id/events` | replayable SSE feed for the whole run |

control endpoints are operator-only; snapshot + events can be spectator-readable, but stay private for v1 (the backend owns the Docker socket).

## vertical slices

each slice ends demoable in the mock frontend against the ai-ctf local chain. thin and independently verifiable, so the team can parallelize where deps allow.

### slice 1 — skeleton: API + journal + SSE
Fastify server, SQLite journal, `POST /runs` (fake preset), `GET /runs/:id`, `GET /runs/:id/events` SSE. a fake event source emits sample `ArenaEvent`s. mock frontend renders two lanes + a live log.
**done:** browser shows streamed fake events; reconnect replays from `Last-Event-ID`; `contract/arena-types.ts` + `contract/API.md` exist and the frontend imports the types.

### slice 2 — one real Codex entrant in a container
pinned Docker image (codex + opencode CLIs + Foundry + Node + `arena-runner`). Codex adapter: `CODEX_HOME=… codex exec --json --dangerously-bypass-approvals-and-sandbox` (no `--ephemeral` — resume needs the session; steer = `codex exec resume <thread_id>`), private `CODEX_HOME` seeded from host auth. run manager brings up one container, streams normalized events to the journal.
**done:** a real Codex session runs a harmless task (read a file, `forge --version`, `cast chain-id` against local chain) in a clean container; its structured activity appears in the mock frontend; cleanup removes the container + credential copy.

### slice 3 — one real OpenCode entrant
OpenCode adapter: `opencode run --format json --auto -m <preset model>`, OpenRouter key via env; steer = `opencode run -s <sessionID>`. same preflight rehearsal, same normalized events.
**done:** OpenCode passes the same harmless rehearsal and streams normalized events; both adapters emit the same `ArenaEvent` shape.

### slice 4 — ready barrier + two lanes
`POST /runs` with `autoStart` prepares both after seeding, holds in `ready` until both report READY, records one start time, releases together. persistent sessions stay open for injection.
**done:** the zero-touch local flow starts both; if either preflight fails, neither starts; two lanes stream side by side from one SSE connection.

### slice 5 — wallets + funding gate
[update, 2026-07-30: the funder signs `agents-arena seed v1\nrun: <runId>` before preparation. derive each entrant key as `keccak256(signature bytes ‖ utf8 entrantId)`, keep keys in memory, and store only `entrants.address`. the gate watches balances on every profile. a local-only helper auto-funds; Base waits for a human.]
**done:** a run pauses for the signature, then for funding, and advances to ready; preflight confirms funded + flag-#1-not-minted. startup drops the old `wallets` table.

### slice 6 — FlagMinted watcher → scores
game-state adapter watches `FlagMinted` on the chain profile, maps wallet → entrant, projects score events idempotently (two confirmations, dedup on `(runId, entrantAddress, challengeId)`). agent runs the real CTF prompt and mints flag #1.
**done:** an entrant registers its ERC-8004 identity, calls `Challenge1.registerAgent`, and the score appears once in the feed; a replay/reconnect never double-counts.

### slice 7 — steer + auto-nudge
`POST /runs/:id/entrants/:eid/steer` appends an Austin turn to a live session. auto-nudge fires when an entrant goes idle (stdout turn-end) with flags < 12 and time remaining, built from on-chain flag truth. both emit `entrant.steered` / `entrant.nudged` events.
**done:** Austin's typed steer reaches a running agent and changes its behavior; an idle agent gets auto-nudged and resumes; both show in the feed.

### slice 8 — recovery + real-Base rehearsal
restart the backend mid-run, rebuild missed events from Docker logs, reconcile scores against Ponder. then flip the chain profile to real Base and run one paired race end to end.
**done:** success bar 1 holds under a real restart; one codex-vs-opencode race completes against real Base with correct scoring and full cleanup.

## out of scope for v1

frontend polish (damu + pablo), Claude Code in the race (subscription ban risk, ADR-0008; adapter seam reserved), agent chat / `arena say`, a literal interactive terminal, more than two entrants, public spectator scale, managed sandboxes / microVMs, hooks (deferred to a later iteration, headline use = tx-interception).

## open questions (parked — don't block the build)

- prod runner host: the long-lived machine that owns the backend, Docker Engine, and reverse proxy.
- which BuidlGuidl Claude + ChatGPT subscription tiers / org credentials for the public event, and the terms fit for headless subscription use.
- how much Base ETH per entrant and safe replenishment for the live event.
- exact model, effort, system prompt, tool policy per harness (rehearsed, not guessed).
- first OpenCode provider/model.
- live event: accept the ai-ctf shared-state interference (challenges 5/8/11) as part of the race, or deploy a clean competition instance.
- naming — `agents-arena-backend` is a working name.

## first build target

slices 1-4 are the spine (API → containers → both harnesses → barrier). build order: slice 1 solo (unblocks the contract), then slices 2 and 3 in parallel (independent adapters), then slice 4 integrates. slices 5-8 follow the chain-and-race path.
