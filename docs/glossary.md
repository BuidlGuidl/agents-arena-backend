# Agents Arena — glossary

canonical vocabulary for the arena backend. terms only, no implementation. built during the design session on 2026-07-22.

## core terms

- **arena backend** — the one authoritative server that owns a run: lifecycle, containers, credentials, the event journal, and score state. the mock frontend and damu/pablo's real frontend are clients, never a second source of truth.
- **run** — one race instance. has a lifecycle state, a fixed set of entrants, one canonical start time, and a deadline. created from a preset.
- **preset** — the server-side definition of a run: which harnesses, pinned models, prompt, tool policy, wallet fixtures, time limit. the frontend sends a preset name plus `autoStart`, never raw config.
- **entrant** — one competitor in a run: a harness + pinned model + funded wallet + erc-8004 identity + private credential home, running in its own container. the compared unit is the harness together with its model, not the model alone.
- **harness** — a coding-agent CLI: Claude Code, Codex, or OpenCode later. each is wrapped by an adapter.
- **entrant session** — the long-lived, steerable harness conversation for one entrant. NOT a one-shot process. the runner injects turns into it: the opening prompt, an auto-nudge, or an Austin steer. survives across nudges, keeping the agent's memory of what it already tried.
- **turn injection** — feeding a user message into a live entrant session. three sources, one mechanism: opening prompt, auto-nudge, Austin steer.
- **auto-nudge** — a turn the arena injects on its own when an entrant goes idle before the deadline while holding fewer than 12 flags. built from on-chain truth (flags the wallet actually minted), so a hallucinated "I'm done" gets corrected by reality.
- **Austin steer** — a free-text turn Austin types mid-race, targeted at one entrant or both, appended to the session like any user turn. the live-caster intervention.
- **arena-runner** — the container entrypoint process. holds the entrant session, waits behind the ready barrier, injects turns, forwards structured output, terminates at the deadline. it is PID 1's real work, not a `docker exec`.
- **harness adapter** — the seam that hides harness-specific details. owns the CLI command, credential home, preflight, raw-event parser, and mapping into `ArenaEvent`. the run lifecycle only knows: prepare, report ready, start, steer, stop, emit events.
- **arena event** — one normalized, journaled fact about a run: an agent message, tool call, command, file change, transaction, score, nudge, steer, error, or usage line. the public unit of the feed.
- **event journal** — the append-only store of arena events (SQLite). one global id, stable per-source seq, replayable after `Last-Event-ID`.
- **tool call id** — the id minted where a tool call is born (the harness, or the model api behind it), carried on `tool.call` and `tool.result` so a client pairs a result to its call without guessing arrival order. the arena threads it through, never re-mints it.
- **solve poller** — reads each entrant's flag state straight from `NFTFlags.hasMinted` on an interval, maps wallet → entrant, and projects new solves into the journal as score events. the only judge; there is no off-chain answer and no indexer in the path. replaces the term *game-state adapter* used in the PRD and the v1 spec.
- **flag** — an nft minted on-chain when an entrant solves a challenge. the atomic scoring unit. 12 exist; flag #1 (register) is mandatory and gates the rest.
- **solve** — one entrant capturing one flag: the `(runId, entrantId, challengeId)` fact plus the `txHash`, `tokenId`, and timestamp read off the mint log. the unit `EntrantSummary.solves` carries. deduped on `(runId, entrantAddress, challengeId)`, so it is a set membership, never a counter.
- **ready barrier** — the hold point. both entrants must report READY before either receives the opening prompt, so container boot time never decides the race.
- **chain profile** — the swappable bundle that points the arena at a chain: `{ rpcUrl, chainId, nftFlags, challenge1, identityRegistry }`. local (the ai-ctf repo `yarn chain`) is one profile, real Base another. runner, solve poller, and adapters don't change. also the switch between "clean benchmark" (fresh local deploy, no shared state) and "live shared board." since ADR-0009 it selects one more thing: how an entrant learns the challenges — the mounted challenge pack on local, the public CTF site on base.
- **challenge pack** — the challenge material the arena hands an entrant on a local chain: the twelve challenge descriptions in the CTF team's own words, the address each contract sits at on this run's chain, the Solidity source, and the deploy script. assembled per run, mounted read-only. it stands in for what an entrant reads off the CTF site and Basescan during the real race.
- **funding gate** — the `awaiting_funding` hold where the run waits for each entrant's balance to cross the profile's floor. the gate only watches; it never sends. the funder pays the displayed addresses himself (Austin on stream, possibly via a multisend); on local a dev-only helper auto-funds from the anvil account so the loop stays one-click (ADR-0013).
- **seed signature** — the funder's EIP-712 signature over per-run typed data (domain `agents-arena` + chainId, type `Seed {runId}`), made with the wallet that funds the race. the single secret every entrant key derives from (ADR-0012). lives in process memory and in the funder's ability to re-sign; never at rest, never journaled.
- **derived burner** — an entrant's wallet whose key is a pure function of the seed signature and the entrant id. the arena stores only its address; the funder can re-derive the key offline any time by re-signing.

## state vocabulary

per-entrant lifecycle, distinct from run state:

- **working** — the session is actively producing output.
- **idle** — the session settled with no pending turn. triggers auto-nudge if flags < 12 and time remains.
- **blocked** — the session is waiting on an approval/permission prompt. under the `dontAsk` policy this should never happen; if it does, it's a policy bug to surface.
- **done** — finished AND the arena has consumed the exit (checked flag count, decided not to nudge). a process exiting is NOT the entrant being done.

the set is closed until a state has an honest emitter: `submitting` becomes possible once on-chain solve detection can see a transaction before the flag confirms; a `thinking` state would need a reasoning channel that does not exist yet. the UI maps its display vocabulary onto these four, not the reverse. outside reference: vercel's ai sdk — the widest-deployed public protocol for streaming agent activity to a UI — makes the same cuts: reasoning is a channel, not a status, and its `tool-approval-request` frame is our `blocked`.
