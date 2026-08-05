# agents-arena-backend

Backend for BuidlGuidl's **Agents Arena** — up to ten coding agents race to solve the on-chain AI CTF, live, each in its own Docker container. Entrants use the `codex`, `opencode`, or `claude` harness. Every step streams to the frontend over server-sent events. Scores come from on-chain flag state, not an off-chain answer key.

Backend only — the frontend lives in a separate ai-ctf fork. This repo ships a small mock React frontend so the backend team can exercise the full slice (SSE → browser) on its own.

## Status

Working today:
- Up to ten real agents using `codex`, `opencode`, or `claude` boot in isolated, hardened containers, run bash / `forge` / `cast`, reach the chain, and stream normalized events.
- One replayable SSE feed per run. A reconnect replays from `Last-Event-ID` with no gap and no duplicate.
- A mock React frontend renders one lane per entrant and a run log.
- Seed-derived burner wallets + watcher-only funding gate, proven against the local chain by a drill. Exactly-once scoring, tested against a local node.
- A docker-duel run scores itself. The solve poller reads each entrant's flag state from `NFTFlags` on an interval and journals `score.flag`.

Not wired yet:
- Auto-nudge. An idle entrant that still has flags to win is not nudged.
- The `base` profile addresses in `config/chains.json` are stale until the CTF contracts are redeployed. ADR-0009's startup cross-check throws until they are.
- The `base` profile's `funderAddress` is the zero address, which rejects every seed signature. Before any base run, set it to the treasury wallet that will sign and fund — and that wallet must be a plain EOA: burner keys derive from its signature (ADR-0013), and a Safe or MPC signer cannot re-produce one to recover funds.

In any real deployment, serve `POST /runs/:id/seed` over TLS. Configure proxies not to log request bodies on that route because the signature is a bearer secret.

## How it works

One process owns a run: lifecycle, containers, credentials, the event journal, and score state. It holds an open Docker socket and a SQLite file. No queue, no websockets, no Kubernetes.

- **Entrant** — a coding-agent CLI + model + funded wallet, running in its own container as one long-lived, steerable session.
- **Ready barrier** — all entrants prepare and hold. The run releases them together on one recorded start time, so boot time never decides the race.
- **Steer** — an operator injects a free-text turn into a live agent mid-race. An idle agent that still has flags to win is auto-nudged from on-chain truth. Both use one injection path.
- **Journal** — every fact is one append-only row with a global `id` and a per-source `seq`. The feed is a projection; a reconnect replays it.
- **Chain profile** — selects addresses, RPC, confirmation depth, funder address, funding threshold, and funding timeout for local or Base.

Transport is each CLI's line-JSON stdout (`codex --json`, `opencode --format json`, `claude --output-format stream-json`), normalized into one `ArenaEvent` stream. SSE, not websockets — `Last-Event-ID` replay is native and the traffic is asymmetric (a steer is a plain POST).

## Stack

TypeScript on Node, one pnpm workspace, `tsx` (no build step), vitest. Fastify (HTTP + SSE), drizzle-orm + better-sqlite3 (the journal), viem (chain reads, signatures, and the local dev faucet), dockerode (containers). Mock frontend: Vite + React + TanStack Query + native EventSource. One pinned Docker image carries Foundry, the `codex`, `opencode`, and `claude` CLIs, and the in-container runner.

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
cp .env.example .env                           # then fill in AI_CTF_REPO and the harness keys
pnpm --filter backend dev                      # Fastify on :4177
```

`.env` at the repo root is loaded by `dev` and `start` through Node's own `--env-file`, so
the operator token and the harness credentials live in one gitignored file instead of a
shell prompt. A variable already exported in the shell wins over the file, which keeps
one-off overrides working:

```bash
ARENA_DB=:memory: pnpm --filter backend dev
```

Every variable is documented in `.env.example`. Node 22.9 or newer is required — that is
where `--env-file-if-exists` landed.

Create a run and watch the feed:

```bash
curl -X POST http://127.0.0.1:4177/runs \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ARENA_OPERATOR_TOKEN" \
  -d '{"preset":"docker-duel","autoStart":true}'

curl -N http://127.0.0.1:4177/runs/<id>/events # SSE, no token needed
```

The mock frontend needs the same token in its own terminal — its dev proxy adds the
operator header, so the browser never holds the token. Without it the lanes still
stream, but "start race" and "steer" answer `401`.

```bash
export ARENA_OPERATOR_TOKEN=<the same token>
pnpm --filter mock-frontend dev
```

`scripts/demo.sh` does all of this for you (see [DEMO.md](DEMO.md)).

To try the wallet login instead, list your address before starting the backend:

```bash
export ARENA_OPERATOR_ADDRESSES=0xYourAddress
export ARENA_SIWE_DOMAINS=localhost:5173,127.0.0.1:5173   # required
```

`ARENA_SIWE_DOMAINS` lists the hosts a signed message may claim, and it has to
include the one in your address bar: `pnpm --filter mock-frontend dev` serves
`localhost:5173`, while `scripts/demo.sh` passes `--host 127.0.0.1`. Listing both
covers either route. Login answers `401 Message domain does not match this server`
when the host you are on is missing.

"sign in with wallet" then appears in the mock frontend's header. Once you are signed
in the dev proxy stops adding the token, so the buttons run on the session cookie and
you are exercising the real path rather than a masked one. Without an allowlist the
`/auth` routes answer `503` and the arena stays token-only.

Smoke one real agent, or the funding gate, without a full run:

```bash
# one real turn in a container: forge --version, cast chain-id, summarize
tsx packages/backend/scripts/demo-entrant.ts codex
tsx packages/backend/scripts/demo-entrant.ts opencode
tsx packages/backend/scripts/demo-entrant.ts claude

# funding drill — two terminals
tsx packages/backend/scripts/demo-funding.ts 0.05   # derives + watches burners
packages/backend/scripts/fund-drill.sh              # funds them; gate passes
```

Credentials come from the host: `codex` reads `~/.codex/auth.json`, `opencode` reads `OPENROUTER_API_KEY` (or its `auth.json`), and Claude reads `CLAUDE_CODE_OAUTH_TOKEN`. Nothing is committed. For a ChatGPT-account `codex` login, leave the model as `default` — API-only model ids are rejected.

## What happens on start

`POST /runs/:id/start`:

1. Move to `awaiting_signature`. The funder signs the run's EIP-712 `Seed {runId}` typed data under the active profile's chain ID and submits it to `POST /runs/:id/seed`. Local signs automatically unless `ARENA_AUTO_SIGN=false`.
2. Verify that the EIP-712 signature recovers to the profile's `funderAddress`. Derive each entrant key in memory and store only its address.
3. Prepare each entrant — build a fresh container, inject its in-memory key and RPC URL, seed its harness credentials, mount the challenge pack read-only at `/ctf` on a local chain (Base mounts nothing), and run preflight.
4. Move to `awaiting_funding`. The gate only watches balances; a local dev helper funds from anvil account 0, while a Base operator funds the displayed addresses.
5. Hold at the ready barrier until all entrants report ready. Record one start time and release them with their opening prompt.
6. Parse each agent's stdout into `ArenaEvent`s, append them to the journal, and stream them to the browser.

Keys are dropped at teardown and never enter SQLite. At race time, the funder must save the canonical seed signature because it is that run's recovery key. From `packages/backend`, `scripts/recover-keys.ts` re-derives the burner keys and can sweep their balances. If any preflight fails, the run fails and every container is torn down. No entrant starts.

## API

| method | path | role |
|---|---|---|
| POST | `/runs` | create from a preset; accepts `autoStart` and `idempotencyKey` |
| POST | `/runs/:id/start` | begin the signature, preparation, funding, and ready flow; release a ready run |
| POST | `/runs/:id/seed` | submit the funder's seed signature while the run awaits it |
| POST | `/runs/:id/stop` | stop and tear down |
| POST | `/runs/:id/entrants/:eid/steer` | inject a turn into one live agent |
| POST | `/runs/:id/broadcast` | inject one director message into every live agent |
| GET | `/runs/:id` | snapshot: state, entrants, addresses, scores, last event id |
| GET | `/runs/:id/events` | replayable SSE feed |
| GET/POST | `/auth/*` | wallet login: `nonce`, `verify`, `session`, `logout` |

Control endpoints are operator-only. Every POST needs one of two credentials — `Authorization: Bearer $ARENA_OPERATOR_TOKEN` for scripts and server-side proxies, or the `arena_operator` session cookie the operator gets by signing in with his wallet — and answers `401` with neither, while the snapshot and the SSE feed stay open for spectators. The backend refuses to start when `ARENA_OPERATOR_TOKEN` is unset, so a deploy cannot leave the controls open.

Wallet login is Sign-In with Ethereum and stays off until `ARENA_OPERATOR_ADDRESSES` lists the operator's address. When the address list is set, `ARENA_SIWE_DOMAINS` is required and must list the hostname the wallet shows. Whichever credential a frontend uses, the secret stays out of the page — see [ADR-0012](docs/adr/decisions-log.md). The API contract travels as checked-in files (`contract/API.md` + `contract/arena-types.ts`); the frontend fork copies the types.
