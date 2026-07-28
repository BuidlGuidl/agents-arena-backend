# Demo runbook

Read the [README](README.md) for the API and project details.

## Prerequisites

Set `AI_CTF_REPO` to your local checkout of [ai.ctf.buidlguidl.com](https://github.com/BuidlGuidl/ai.ctf.buidlguidl.com).

- `docker info`
- `docker image inspect arena-entrant:dev`
- `fnm exec --using=22.20.0 node --version`
- `fnm exec --using=22.20.0 pnpm --version`
- `fnm exec --using=22.20.0 yarn --version`
- `test -f "$AI_CTF_REPO/package.json"`
- `test -f ~/.codex/auth.json`
- `test -n "$OPENROUTER_API_KEY"`

## Two-minute fake demo

From the backend repo, start the services:

```bash
./scripts/demo.sh up
```

Create the fake run:

```bash
./scripts/demo.sh fake
```

The command prints the run ID, the SSE command, and the frontend URL. Open
`http://127.0.0.1:5173`. Two entrant lanes and the run log appear. The fake events
move both entrants through the race without starting entrant containers.

Run the printed SSE command in another terminal if you want the raw event feed:

```bash
curl -N http://127.0.0.1:4177/runs/<run-id>/events
```

Stop the processes that the launcher started:

```bash
./scripts/demo.sh down
```

## Real duel demo

Start the chain, backend, and frontend:

```bash
./scripts/demo.sh up
```

Check each entrant harness before the duel:

```bash
./scripts/demo.sh smoke
```

Create the Docker duel:

```bash
./scripts/demo.sh real
```

During startup the backend assigns each entrant a burner wallet, injects the
private key and chain RPC URL into its container, and self-funds both burners on
the local chain profile. The run stays in `awaiting_funding` until both balances
clear the local threshold, then it moves to ready and starts both entrants.

Open the printed frontend URL. The Codex and OpenCode lanes enter the ready
barrier, start together, and stream their status and tool events into the run log.

Copy the printed run ID. Steer Codex while the run is active:

```bash
RUN_ID=<run-id>
curl -fsS -X POST \
  "http://127.0.0.1:4177/runs/$RUN_ID/entrants/codex-1/steer" \
  -H 'content-type: application/json' \
  -d '{"text":"Check the chain state again and try the next unsolved challenge."}'
```

The next Codex turn appears in its lane and in the run log.

Address both entrants at once, the way a streamer would:

```bash
curl -fsS -X POST \
  "http://127.0.0.1:4177/runs/$RUN_ID/broadcast" \
  -H 'content-type: application/json' \
  -d '{"text":"Five minutes left, ship what you have."}'
```

The reply names who took the message. The run log shows one `broadcast` row, then
each lane takes its own turn. Stop the launcher-owned processes after the demo:

```bash
./scripts/demo.sh down
```

## Troubleshooting

**Funding diagnostic.**
The standalone funding drill still exists for watcher checks:

```bash
fnm exec --using=22.20.0 pnpm --filter backend exec tsx scripts/demo-funding.ts
```

Run `packages/backend/scripts/fund-drill.sh` in another terminal when the drill prints the burner
addresses. The drill does not start a duel.

Problems seen during setup and their fixes:

**Backend tests or server crash with a `NODE_MODULE_VERSION` error.**
better-sqlite3 was rebuilt for a different Node. Rebuild it for the project runtime:

```bash
fnm exec --using=22.20.0 pnpm rebuild -r better-sqlite3
```

Run the backend through `fnm exec --using=22.20.0`, never the shell default Node —
the launcher already does this.

**`up` fails with "yarn is unavailable under Node 22".**
The chain scripts need yarn under the fnm Node. One-time fix:

```bash
fnm exec --using=22.20.0 corepack enable
fnm exec --using=22.20.0 corepack prepare yarn@3.2.3 --activate
```

**A run fails instantly with "Container exited with code 0" during prepare.**
This was a backend bug (the death watcher used Docker's default wait condition,
which fires immediately for a created container). Fixed on master — pull if you
see it.
