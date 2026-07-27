# agent-arena ADR log

hard-to-reverse decisions from the design session, 2026-07-22. one entry per decision that is costly to change, surprising without context, and the result of a real trade-off.

---

## ADR-0001 — separate backend repo, not a monorepo

**Status:** accepted (2026-07-22)

**Decision:** the arena backend is its own repo, `agents-arena-backend`, under BuidlGuidl. damu and pablo build the frontend in their own fork of the ai-ctf repo. no shared monorepo for v1.

**Why:** the frontend team is already forking ai-ctf; forcing a monorepo now would couple two teams' deploy cycles for no v1 payoff. a monorepo may come later.

**Trade-off:** the API contract can't be a shared workspace package. it becomes a first-class deliverable — checked-in `API.md` + `arena-types.ts` the frontend copies (ADR-0002).

**Consequence:** the repo ships a small mock React frontend of its own, so the backend team can exercise the full vertical slice (SSE → browser) without waiting on the real frontend.

---

## ADR-0002 — API contract travels as checked-in files, not a package

**Status:** accepted (2026-07-22)

**Decision:** the contract is `API.md` (endpoints, auth, SSE semantics) plus one `arena-types.ts` (the `ArenaEvent` envelope, event payloads, run states, request/response types), checked into the backend repo. the frontend fork copies the types file.

**Why:** a published npm package means a publish cycle on every contract tweak during the phase the contract churns most. files cost nothing and freeze naturally.

**Trade-off:** the frontend re-copies on change. acceptable while the contract is small and changes rarely; graduate to `@buidlguidl/arena-types` once it survives the first real race.

---

## ADR-0003 — an entrant is a persistent steerable session, not a one-shot process

**Status:** accepted (2026-07-22) — supersedes an earlier one-shot-process model

**Decision:** each entrant runs one long-lived harness session that the arena injects turns into. Claude: `claude -p --input-format stream-json` held open (or `--resume`). Codex: `codex exec` then `codex exec resume <session-id>`. three turn sources share one injection mechanism: opening prompt, auto-nudge, Austin steer.

**Why:** steering is now a product goal — Austin intervenes live ("Codex, you're missing flag 7, keep going"). one-shot processes can't be steered, go silent when the model exits early (bad television), and lose the agent's memory of failed attempts across relaunches. a persistent session makes Austin-steer and auto-nudge the same code path.

**Trade-off:** the runner is more complex than spawn-and-forget, and it leans on each harness's session/stdin-injection support (verified present in both installed CLIs). the escape hatch, if stdio steering proves flaky in rehearsal, is the structured control plane (`codex app-server` JSON-RPC, Claude Agent SDK) — deferred, not adopted, because it costs the clean "both harnesses are line-buffered JSON on stdout" adapter symmetry.

**Consequence:** auto-nudge and Austin-steer are one endpoint family. nudge prompts are built from on-chain flag truth, never the agent's self-report.

---

## ADR-0004 — v1 transport is stdout JSON; hooks deferred

**Status:** accepted (2026-07-22)

**Decision:** v1 gets structured activity only from each harness's stdout JSON (Claude `stream-json`, Codex `--json`). agent hooks are deferred to a later iteration.

**Why:** stdout JSON already carries the whole public feed (messages, tool calls, results, usage) and a turn-end signal for idle detection. hooks add a second, harness-specific, CLI-version-fragile channel; not worth the adapter cost until the content path is proven.

**Trade-off:** the exciting "agent just broadcast a transaction" moment surfaces via the `FlagMinted` watcher (a few seconds late) rather than a `PreToolUse` hook firing the instant `cast send` runs. accepted for v1.

**When we revisit:** the headline reason to add hooks later is tx-interception (emit `arena.tx_submitted` before the chain confirms). secondary uses: a cleaner `Stop`-hook idle signal and a network guardrail. each hook stays tiny — write one JSON line to a fifo the runner reads — so the adapter still normalizes into one `ArenaEvent` stream.

**Consequence:** v1 idle detection reads the terminal result line in each harness's stdout stream, not a hook.

---

## ADR-0005 — fresh wallet + identity per entrant per run, gated on a balance-watch

**Status:** accepted (2026-07-22) — supersedes an earlier manual-fixture model

**Decision:** at `preparing`, the arena generates a fresh keypair per entrant. it does NOT hold a hot treasury key as a hard dependency. funding arrives one of two ways into the same gate:
- **live event:** the dashboard shows both addresses, Austin sends Base ETH from the BuidlGuidl treasury on stream.
- **rehearsal:** an optional operator treasury key auto-sends, so runs iterate without a human.

the run holds in a new `awaiting_funding` state until each entrant's balance crosses a threshold, then runs preflight (funded, flag #1 not yet minted) and moves to `ready`. the arena does NOT register the ERC-8004 identity — the agent does it itself in-race as its first action (see ADR-0006).

**Why:** flags can't be minted twice to one address, so every rehearsal needs a virgin wallet — manual fixtures don't survive the iteration count. generating per run makes every race repeatable. the balance-watch gate is where the "Austin funds live" product moment and the "don't start the timer until wallets are real" correctness gate become one mechanism.

**Trade-off:** adds one lifecycle state (`awaiting_funding`) and a chain-balance watcher to preflight. the arena depends on treasury ETH arriving; if Austin forgets to send, the run sits waiting (correct behavior, but needs a visible prompt on the dashboard).

**Consequence:** the run state machine is `created → preparing → awaiting_funding → ready → running → stopping → finished` (or `failed`).

---

## ADR-0006 — the agent self-registers its ERC-8004 identity; the backend never writes to a registry

**Status:** accepted (2026-07-22)

**Decision:** the arena does not register ERC-8004 identities. each agent registers its own identity on the real Base registry (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) as its first in-race action, then calls `Challenge1.registerAgent(agentId)` for flag #1. verified feasible: the registry sets `agentWallet = msg.sender`, so a wallet self-registers with the key it already holds.

**Why:** it removes registry-write logic and pre-registration gas timing from the backend, and it's more faithful to the test — deriving how to register from the live registry ABI is exactly the on-chain autonomy being measured, and it's watchable on stream. same task for both entrants, so fair.

**Trade-off:** registration is now a hard gate the agent can fumble — a failed registration means zero flags. mitigated by stating the entry sequence as an operational instruction in the prompt (not a puzzle hint), the same way flag #1 is stated as mandatory.

**Consequence:** preflight checks only funded + flag-#1-not-minted; there is no identity to verify at ready-time. scoring stays per-wallet-address (the arena never needs the agentId — it watches `FlagMinted` by the address it generated).

**Prompt posture (iterable, not carved; amended by ADR-0009 — no longer silent, and now varies by chain profile):** silent on the 12 puzzles (discovery-based, keeps challenge 9's empty-ABI signal), explicit on operational mechanics (wallet + key location, Base RPC, the register→flag-#1 entry sequence, same-address rule, gas funded, helper contracts allowed). identical for both entrants bar a one-line per-harness tool note.

---

## ADR-0007 — dev substrate is the ai-ctf repo's own local chain, selected via a chain profile

**Status:** accepted (2026-07-22) — substrate choice stands; ADR-0009 changes what a profile switch carries

**Decision:** dev and early slices run against the ai-ctf repo's local Scaffold-ETH chain (`yarn chain` + `yarn deploy`), which deploys all 12 challenges, `NFTFlags`, and the `MockIdentityRegistry`. the arena selects a chain via a **chain profile**: `{ rpcUrl, chainId, nftFlags, challenge1, identityRegistry }`. local is one profile; real Base is another. only addresses + RPC change between them — runner, watcher, and adapters are identical.

**Why:** the target's own deploy scripts stand up the whole game for free, deterministically, resettably, maintained by the contract owners so local can't drift from theirs. real Base ETH and double-mint wallet burn stay out of the hundreds of dev runs. a fresh local deploy also has no shared-state interference (challenges 5/8/11), so early dev measures the agent in isolation.

**Trade-off:** the mock registry's `registerAgent(string domain)` signature differs from the real Base registry, so the agent's registration path in local dev is not byte-identical to production. closed in the dedicated real-Base rehearsal slice, which flips the chain profile. the profile switch is also the "clean benchmark vs live shared board" distinction — two different products.

**Consequence:** slices 1-7 need no mainnet dependency; slice 8 (rehearsal) flips to the Base profile to exercise the real registry signature, real `FlagMinted`, and gas.

---

## ADR-0008 — v1 entrant lineup is codex + opencode; claude-code deferred

**Status:** accepted (2026-07-22) — supersedes the claude-vs-codex lineup in the PRD and ADR-0003's claude examples

**Decision:** the two v1 entrants are Codex and OpenCode. the Claude Code adapter is deferred behind the same harness-adapter seam it was designed into. opencode runs via the OpenRouter api key (dev default deepseek; model pinned per preset, free `opencode/deepseek-v4-flash-free` available for cheap loops).

**Why:** running a claude subscription headless inside arena containers risks the account (team decision, 2026-07-22). codex and opencode both expose the same shape the ADRs already require: line-JSON stdout (`codex exec --json`, `opencode run --format json`) and session resume for turn injection (`codex exec resume <thread_id>`, `opencode run -s <sessionID>`). api-key-based opencode has no subscription-ToS exposure.

**Trade-off:** the marquee "claude vs codex" matchup becomes "codex vs opencode" until a sanctioned claude credential exists (org api key or explicit blessing). adapter symmetry is preserved, so claude is an adapter away.

**Consequence:** slice 2 = codex adapter, slice 3 = opencode adapter. the pinned image ships codex + opencode CLIs, no claude CLI. toolchain locked the same day: pnpm workspaces, tsx runtime, vitest.

---

## ADR-0009 — the challenge material ships into the container as a mounted pack; the opening prompt varies by chain profile

**Status:** accepted (2026-07-27) — amends the prompt posture in ADR-0006; ADR-0007's substrate choice stands

**Decision:** at prepare time the arena assembles a **challenge pack** from a local ai-ctf checkout (`AI_CTF_REPO`) and mounts it read-only at `/ctf` in every entrant container: `BRIEFING.md` (the CTF's own twelve challenge markdown files, verbatim, under an address table read from the deploy artifacts), `contracts/`, and the deploy script. the opening prompt points at `/ctf` on the local profile and at the public CTF site on the base profile. the base prompt names no contract addresses.

**Why:** the prompt told the agent to "read each challenge contract with `cast`", which returns runtime bytecode on a local chain — an instruction that cannot be followed. it also never mentioned the site where the twelve descriptions and hints live.

forking Base was the first candidate and was rejected on a live check: `NFTFlags.enabled()` is `false` at `0xD60C911a…` and `enabledAt` is `0` (checked 2026-07-27). the contracts are deployed there but minting was never switched on, so a fork inherits a board where every `mintFlag` reverts and both entrants score zero.

pointing at the site alone does not close the gap either. the challenge text is server-rendered and a plain `curl` returns it, but the per-challenge address comes from `ChallengeContractLink`, a client component — so `curl` gets descriptions without addresses, and `/leaderboard` returns nothing at all. the ai-ctf repo is private, so the site's challenge-9 hint linking its own deploy script 404s for an entrant. shipping the material is the only route that hands the agent instructions, addresses, and source on a local chain.

**Trade-off:** the ai-ctf checkout becomes a build input, not only an RPC endpoint. a file that moves upstream now breaks the pack, where before only the chain shape mattered — so the assembler throws and names the missing path rather than shipping a briefing with holes. the larger cost is that local and base now differ in more than addresses and RPC: the prompt differs too. that is a behavioural fork of the chain profile, not the data swap ADR-0007 described. accepted because production is expected to point agents at the site (team call, still open), so the base prompt is the one that has to match the race and the local pack is the stand-in.

**Consequence:** this repo is public and ai-ctf is private, so the pack is never checked in — it is assembled per run from `AI_CTF_REPO`, and a `docker-duel` run fails at prepare when that path is missing. the pack's address table is read from `deployments/<network>/`, which is what `yarn deploy` actually wrote, and the three addresses the arena itself uses are cross-checked against the active profile so nonce drift becomes a startup error instead of a silent wrong answer. ADR-0006's "silent on the 12 puzzles" posture is amended: still identical across entrants, no longer silent, no longer identical across profiles.
