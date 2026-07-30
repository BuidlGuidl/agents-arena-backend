# agents-arena-backend

Backend for BuidlGuidl's **Agents Arena** — two coding agents race to solve the on-chain AI CTF, live, each in its own Docker container. One `codex` entrant and one `opencode` entrant. Every step streams to the frontend over server-sent events. Scores come from on-chain flag state, not an off-chain answer key.

Backend only — the frontend lives in a separate ai-ctf fork. This repo ships a small mock React frontend so the backend team can exercise the full slice (SSE → browser) on its own.

## Status

Working today:
- Two real agents (`codex` + `opencode`) boot in isolated, hardened containers, run bash / `forge` / `cast`, reach the chain, and stream normalized events.
- One replayable SSE feed per run. A reconnect replays from `Last-Event-ID` with no gap and no duplicate.
- A mock React frontend renders two lanes and a run log.
- Burner wallet + funding gate, proven against the local chain by a drill. Exactly-once scoring, tested against a local node.
- A docker-duel run scores itself. The solve poller reads each entrant's flag state from `NFTFlags` on an interval and journals `score.flag`.

Not wired yet:
- Auto-nudge. An idle entrant that still has flags to win is not nudged.
- The `base` profile addresses in `config/chains.json` are stale until the CTF contracts are redeployed. ADR-0009's startup cross-check throws until they are.

## How it works

One process owns a run: lifecycle, containers, credentials, the event journal, and score state. It holds an open Docker socket and a SQLite file. No queue, no websockets, no Kubernetes.

- **Entrant** — a coding-agent CLI + model + funded wallet, running in its own container as one long-lived, steerable session.
- **Ready barrier** — both entrants prepare and hold. The run releases them together on one recorded start time, so boot time never decides the race.
- **Steer** — an operator injects a free-text turn into a live agent mid-race. An idle agent that still has flags to win is auto-nudged from on-chain truth. Both use one injection path.
- **Journal** — every fact is one append-only row with a global `id` and a per-source `seq`. The feed is a projection; a reconnect replays it.
- **Chain profile** — moves the arena between the local chain and Base by changing only addresses, RPC, and confirmation depth.

Transport is each CLI's line-JSON stdout (`codex --json`, `opencode --format json`), normalized into one `ArenaEvent` stream. SSE, not websockets — `Last-Event-ID` replay is native and the traffic is asymmetric (a steer is a plain POST).

## Stack

TypeScript on Node, one pnpm workspace, `tsx` (no build step), vitest. Fastify (HTTP + SSE), drizzle-orm + better-sqlite3 (the journal), viem (chain reads + funding), dockerode (containers). Mock frontend: Vite + React + TanStack Query + native EventSource. One pinned Docker image carries Foundry, the `codex` and `opencode` CLIs, and the in-container runner.

## Run it

```bash
pnpm install
pnpm -r typecheck && pnpm -r test
```

Start the dev chain — the ai-ctf repo's own local Scaffold-ETH node:

```bash
# in the ai-ctf repo
yarn chain        # hardhat node on :8545
yarn deploy       # 12 challenges + NFTFlags + registry
```

Build the entrant image and run the backend:

```bash
docker/build.sh                                # -> arena-entrant:dev
ARENA_DB=:memory: pnpm --filter backend dev    # Fastify on :4177
```

Create a run and watch the feed:

```bash
curl -X POST http://127.0.0.1:4177/runs \
  -H 'content-type: application/json' \
  -d '{"preset":"docker-duel","autoStart":true}'

curl -N http://127.0.0.1:4177/runs/<id>/events # SSE
```

Smoke one real agent, or the funding gate, without a full run:

```bash
# one real turn in a container: forge --version, cast chain-id, summarize
tsx packages/backend/scripts/demo-entrant.ts codex
tsx packages/backend/scripts/demo-entrant.ts opencode

# funding drill — two terminals
tsx packages/backend/scripts/demo-funding.ts 0.05   # creates + watches burners
packages/backend/scripts/fund-drill.sh              # funds them; gate passes
```

Credentials come from the host: `codex` reads `~/.codex/auth.json`, `opencode` reads `OPENROUTER_API_KEY` (or its `auth.json`). Nothing is committed. For a ChatGPT-account `codex` login, leave the model as `default` — API-only model ids are rejected.

## What happens on start

`POST /runs/:id/start`:

1. Prepare each entrant — build a fresh container, seed its credentials, mount the challenge pack read-only at `/ctf` on a local chain (Base mounts nothing), run preflight (`forge`, `cast`, the CLI version).
2. Hold at the ready barrier until both report ready.
3. Record one start time and release both with their opening prompt, which points at `/ctf` on a local chain and at the public CTF site on Base (ADR-0009).
4. Parse each agent's stdout into `ArenaEvent`s, append them to the journal, and stream them to the browser.

If either preflight fails, the run fails and both containers are torn down. Neither starts.

## API

| method | path | role |
|---|---|---|
| POST | `/runs` | create from a preset; accepts `autoStart` and `idempotencyKey` |
| POST | `/runs/:id/start` | release a prepared run through the ready barrier |
| POST | `/runs/:id/stop` | stop and tear down |
| POST | `/runs/:id/entrants/:eid/steer` | inject a turn into one live agent |
| POST | `/runs/:id/broadcast` | inject one director message into every live agent |
| GET | `/runs/:id` | snapshot: state, entrants, addresses, scores, last event id |
| GET | `/runs/:id/events` | replayable SSE feed |

Control endpoints are operator-only for v1. The API contract travels as checked-in files (`contract/API.md` + `contract/arena-types.ts`); the frontend fork copies the types.
