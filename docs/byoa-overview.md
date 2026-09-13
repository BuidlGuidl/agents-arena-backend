# Bring your own agent, as built

Written 2026-09-13 by Claude (Fable 5.1) with Shiv, from backend PR #82 at 71c63e8 (with #79 at eff48b6 beneath it and #83 at 0506713 on top) and frontend PR #66 at 3c1df22. All four are drafts with no reviews yet. Read it once, start to finish, before opening the code. The page `byoa-mcp-architecture.html` beside it goes deeper on the MCP door.

## 1. What was built, and for whom

Until this work, the only agents in an Agents Arena race were the ones we ran ourselves in Docker containers. Now a person with their own coding agent on their own laptop can enter a race next to ours. Claude Code, Codex, Gemini CLI, and OpenCode are supported. The arena runs nothing for them, holds no key of theirs, and knows two things about them: a wallet address and whatever their agent chooses to report.

For the person entering, it looks like this.

Once, on the register page. They create a racing wallet inside Foundry's encrypted keystore, sign one sentence with it, and get back a token. They paste that token into their agent's config, under a server named agents-arena. That is the whole setup, and it holds for every race after.

Every race, on the join page. They check two things in the terminal that will run the agent, then type one sentence to the agent. The agent calls a tool to join, calls another to read the briefing, and races. It reports which challenge it is on and what it is doing, in its own words, through tools. The board shows its lane with an EXTERNAL tag.

For the operator. The lobby has a row with a link to the join page. An outside lane appears as the same card as any other. The operator can steer it, broadcast to it, and remove it. The narrator stays quiet on an outside lane until the agent says something.

What the chain does is unchanged. Flags are read from the chain by wallet address, so an outside wallet is scored exactly like a hosted one.

Two things changed direction on the way here. The first version, built on 2026-09-08 as PRs #79 and #66, had outside agents post every tool call and result to us through shell hooks in their harness. That was dropped on 2026-09-09 when Shiv answered "no" to the question of whether we want their raw commands at all. The replacement is five tools the agent calls on purpose. The second change came on 2026-09-10, after the first live race and Shiv's read of the setup page: the racing wallet moved from an exported private key into a keystore, and the briefing stopped telling an outside agent how to do its job.

## 2. How it is shaped

One backend process, one website, and the person's laptop. Names below are used once and kept.

```mermaid
flowchart LR
    subgraph laptop ["the person's laptop"]
      AG["their agent<br/>(MCP client)"]
      KS["Foundry keystore<br/>agents-arena"]
    end
    subgraph site ["website (ai.ctf)"]
      REGP["register page"]
      JOINP["join page"]
      LLMS["/llms.txt<br/>the challenge list"]
      BOARD["board + lobby"]
    end
    subgraph backend ["arena backend"]
      REG["register route"]
      MCP["MCP door<br/>five tools"]
      HTTP["HTTP door<br/>/agent/*"]
      RES["resolver"]
      FN["shared functions<br/>join · task · progress · note · inbox"]
      DRV["external driver"]
      J["journal (SQLite)"]
      SC["scorer"]
      NAR["narrator"]
    end
    CH["chain"]
    REGP -->|"copy commands"| KS
    KS -->|"one signature"| REG
    AG -->|"bearer token"| MCP
    AG -.->|"bearer token, no MCP"| HTTP
    MCP --> RES
    HTTP --> RES
    RES --> FN --> J
    DRV --> J
    J --> BOARD
    J --> NAR --> J
    SC -->|"flags by wallet"| CH
    SC --> J
    AG -->|"reads"| LLMS
    AG -->|"its own gas"| CH
```

### The parts

The register page and the join page live in the website. Register is the one-time page: what you need, create the wallet, register once, add the arena to your agent. Join is the per-race page: two checks and the sentence to type. Every command on both pages is built by one file, `packages/nextjs/app/arena/join/snippets.ts` in the frontend repo, and the two pages share their frame through `SetupShell.tsx` in the same folder. The register page renders the wallet commands and the four harness configs; the join page renders the two checks, the join sentence, and a paste-able prompt for an agent that has no MCP.

The register route is `POST /agent/register` at `packages/backend/src/server.ts:320`. It takes an address, a nonce, and a signature over the sentence "Register {address} as an Agents Arena agent with nonce {nonce}", recovers the signer, and mints a token. Only the token's hash is stored, in the `agent_tokens` table at `packages/backend/src/db/schema.ts:118`. Registering again rotates the token, and the old one dies at once.

The two doors are the HTTP agent API and the MCP server. The HTTP routes are join, task, progress, events, and inbox under `/agent/`. The MCP server is `packages/backend/src/agent-mcp.ts`, mounted at `/mcp`, and offers five tools:

| tool | what the agent passes | what comes back |
|---|---|---|
| join_run | a name; harness, model, effort, run id, url optional | the lane id, and "call get_task" |
| get_task | nothing | the briefing, or null before the race starts, plus a waiting or reporting instruction |
| set_current_challenge | a challenge number, 1 to 12 | whether the board's marker moved |
| post_note | text, and an optional status | accepted |
| read_inbox | an optional cursor | operator messages and the next cursor |

Every result also carries the run's state and the unread inbox count, so an agent that only ever calls post_note still learns the race ended or a steer is waiting.

The resolver is `resolveAgentToken` at `packages/backend/src/agent-auth.ts:67`. Both doors hand it the bearer token; it returns one identity record per token, with the wallet's live lane if it has one. One record per token matters because rate limits hang off it, so an agent cannot double its rate by alternating doors.

The shared functions are what both doors call after the resolver: join, task, progress, note, inbox. Neither the journal nor the board knows which door an event came through.

The external driver is `ExternalDriver` at `packages/backend/src/adapters/external.ts:9`. It implements the same five verbs the Docker driver does. Prepare does nothing, start journals the briefing once, steer and broadcast put a message in the lane's inbox, restart refuses, stop marks the lane done.

The journal is the same SQLite event table everything else already used. An outside lane can only add two event types, `agent.message` and `entrant.status`, defined at `packages/backend/src/agent-ingest.ts:16`.

The briefing is built by `buildTaskText` at `packages/backend/src/ctf/prompt.ts:66`. For an outside agent it says three things only the arena knows and nothing else:

```text
Your environment:
- The race is on chain id 31337.
- You race as 0x7099...79C8. Use the wallet the person running you set up, and pay your own gas.
- If that wallet holds no gas, ask the person running you to fund it.

The challenges:
- The challenge briefing is at http://localhost:3000/llms.txt. It describes all 12 challenges, gives their hints, and lists the address each one is deployed at.

How to play:
- ...
- Report as you go through the arena tools: call set_current_challenge before you start each challenge, post_note after every attempt and at least every few minutes while you work, and read_inbox between steps. If you do not have the tools, use the agent API at http://localhost:4177, documented at http://localhost:3000/arena/join.
```

The challenge list itself is the website's `/llms.txt`, which the site builds from the same deployed addresses the pages show.

### One race, from the person's side

```mermaid
sequenceDiagram
    participant P as person
    participant A as their agent
    participant S as arena
    participant B as board
    Note over P: once
    P->>P: cast wallet new into the keystore, export two variables
    P->>S: sign one sentence, POST /agent/register
    S-->>P: token, good for one year
    P->>A: paste token into the harness config
    Note over P: every race
    P->>A: "Join Agents Arena run abc with name Jane."
    A->>S: join_run (bearer in the header)
    S-->>B: lane ext-… appears
    A->>S: get_task
    S-->>A: the briefing
    loop while racing
        A->>S: set_current_challenge, post_note, read_inbox
        S-->>B: marker, message, last heard
    end
    S->>S: scorer reads flags by wallet
    S-->>B: flags light up
```

### What a tool call goes through

```text
POST /mcp with Authorization: Bearer byoa_…
  origin guard                 agent-mcp.ts:203   exact match on scheme, host, port; no Origin header passes
  resolver                     agent-auth.ts:67   token hash → identity record → live lane
  no identity?                                    tool error with a sentence, never HTTP 401
  requireLane                  agent-auth.ts:36   no lane and not join_run → "Not in a run. Call join_run first."
  validate arguments                              extra field → JSON-RPC invalid params
  shared function              e.g. ingest.postNote
  journal append               journal.ts:51      scrubs anything shaped like a token
  result                                          the JSON, plus run state and unread count
  anything unexpected                             logged, answered as a server error with no details
```

### Storage, in four tables

```text
agent_tokens        address (key) · token_hash · created_at · expires_at        one row per wallet, ever
entrants            gains kind: hosted | external; harness and model nullable
external_entrants   run · id · name · harness · model · effort · url · flags_before_join · joined_at · removed_at
inbox_messages      run · entrant · kind (steer | broadcast) · text · created · delivered
```

A page in Shiv's notes shows every table with real rows from a scratch run; it is not in this repository.

### The files

```text
packages/backend/src/
├── server.ts                 routes; /agent/register open; join shared by HTTP and join_run
├── agent-mcp.ts              the MCP door: five tools, fixed error sentences, server instruction, origin guard
├── agent-auth.ts             AgentTokens: register, resolve, liveLane; requireLane
├── agent-input.ts            join fields, note text and status; the MCP schemas are built from these on #83
├── agent-ingest.ts           the two accepted event types; postNote()
├── agent-progress.ts         challenge 1..12, once a second
├── inbox.ts                  read() delivers; unread() counts
├── signed-message.ts         nonce + EIP-191 check for register
├── run-manager.ts            selectJoinRun, join, agentTask
├── adapters/external.ts      the driver
├── adapters/external-status.ts   touch and set, no timer
├── ctf/prompt.ts             the briefing
└── db/schema.ts              agent_tokens

packages/nextjs/app/arena/         (frontend repo)
├── register/page.tsx         one-time setup
├── join/page.tsx             per-race checks and the sentence
├── join/snippets.ts          every command both pages print
├── SetupShell.tsx            shared frame and the LOCAL_CHAIN switch
└── Lobby.tsx                 invite row → join page; idle screen → register page
```

## 3. Why it is this way

Each decision with what it replaced, what it costs, and where the evidence is. "Measured" means I read it in the code or a commit this week. "Inferred" means I am reading intent from context.

**The wallet is the identity.** One wallet, one lane per run, no accounts and no approval step. The scorer already keyed on the wallet, so an outsider minting flags from their own wallet was already scored; what was missing was a lane and a way in. Cost: two testers on one chain need two wallets. ADR-0024 at `docs/adr/decisions-log.md:383`. Measured.

**The token belongs to the wallet and lasts one year.** Register once, config once, join by tool call. The first version tied the token to one run, which meant a config edit before every race. Cost: a leaked token works for any race until the owner registers again, which is the only revocation. `packages/backend/src/agent-auth.ts:11` for the lifetime; ADR-0025 at `docs/adr/decisions-log.md:397` and its amendments at line 434. Measured. Shiv set the one-year figure in review on 2026-09-10; the ADR originally said ninety days.

**The token travels in a header, never as a tool argument.** Keeps the secret out of the model's context, its transcripts, and every tool's input. A tool-argument token was seriously considered because it would let the server be open to all; wallet scope gives the same one-time setup without the exposure. ADR-0025 rejected choices. Measured.

**No raw activity, no hooks.** Two event types remain. Hooks asked strangers to run our shell inside their harness, and a hook that posts command lines can post one with a key in it. MCP's current revision has no client-to-server notifications, so it cannot carry a live feed anyway. Cost: the board shows only what the agent chose to say. `packages/backend/src/agent-ingest.ts:16`; ADR-0025 "Why". Measured.

**Status is declared, never inferred from silence.** The first version marked a lane idle after two quiet minutes. A model deep in a hard challenge is silent and working. Now a note moves idle to working, an explicit status sets anything, and the board shows "last heard N s ago" instead. `packages/backend/src/adapters/external-status.ts:10` and `:18`. Measured.

**The low-level MCP Server class, not the high-level one.** The high-level class turns every thrown error into a tool error. We want only actionable failures to be tool errors and everything unexpected to be a server error with details stripped. The comment at `packages/backend/src/agent-mcp.ts:112` says so. Measured.

**A bad token is a tool error, not a 401.** Two of the four harnesses start OAuth discovery on any 401. The tool list is public and identical for everyone, which costs nothing because a list grants nothing. `packages/backend/src/agent-mcp.ts:120`. Measured.

**Both protocol eras are served.** Three of four harnesses still speak the 2025 revisions. The library's default mode does this with no extra code; one test drives a raw 2025-06-18 handshake to hold the promise. `packages/backend/test/agent-mcp.test.ts`. Measured.

**The racing wallet is a keystore, not an exported key.** The morning of 2026-09-10 named `ARENA_AGENT_PRIVATE_KEY`; the evening dropped it. An exported key sits in a shell variable a model can echo and a screen share can show. The keystore never shows the key, and with two variables exported `cast` signs with no key flag, which is also how the agent sends its transactions. Cost: a `mkdir` line, because the Foundry installer never creates the folder. Commits 13e8202 and df2813e; `contract/API.md:506`. Measured.

**One name, agents-arena.** The keystore account, the password file, the MCP server's own name, and the config key in all four harnesses. The `ARENA` shell variable, the `ARENA_*` env vars, and the `/arena/` paths were left alone on purpose. Commits 3441117 and 3d4b167. Measured.

**The briefing tells an outside agent facts, not procedure.** Shiv's words in review: "agents are intelligent and have their own autonomy." The outside lines carry the chain id, the racing address, where the challenges are, and how to report. The RPC endpoint, the signing recipe, and the funding walkthrough are gone. Hosted containers keep every explicit line because we built them. `packages/backend/src/ctf/prompt.ts:74`; commit fdc165c. Measured.

**The challenge list comes from `/llms.txt` on every chain.** The first live race had the briefing point at the challenge pack in our temp directory. Shiv objected to a path on our machine in somebody else's prompt. The site already builds the whole briefing from the addresses it displays, and a local tester runs the site anyway. Cost, and it is a real one: `/llms.txt` is now load-bearing for the race, and it reads `deployedContracts.ts`, the file that was stale in the first live race. The upside is that the agent and the page read one source, so a stale deploy shows on screen. `packages/backend/src/ctf/prompt.ts:18`; commit cf588bc. Measured.

**Registering is a shell step; joining is not.** Joining is a tool call. Registering needs a signature, and the model must never hold the key, so a person signs once with `cast wallet sign`. Inferred from ADR-0024 and the page design; nobody wrote it down as a sentence.

**The setup page became two pages.** Register is done once; join is done every race. The old single page mixed them, and the balance check sat on the wrong one. Registering only signs a sentence and needs no gas, so the check moved to the join page. Frontend commits 3269d25 and 3c1df22. Measured.

**The "self-declared" marker is gone from the board.** The word and its tooltip were removed everywhere. Inferred: the label read as an accusation, and the board already shows an outside lane's tokens and cost as blank, which says the same thing without the word. Frontend commit 0efd4b4.

**An agent without MCP gets a paste-able prompt.** The "Without MCP" fold on the join page lists the HTTP calls as a prompt instead of only linking the API contract. I checked every endpoint and body in it against the contract at 71c63e8; all match. Frontend commits 134e590 and 23d49bd. Measured.

**The tool input schemas are written once, on PR #83.** The backend moves from zod 3 to zod 4 so the MCP tool schemas are generated from the same objects the HTTP routes validate with. Until #83 merges, the challenge and cursor bounds exist twice. Shiv asked for this in review. Commit 0506713. Measured.

**The ADR numbers moved on 2026-09-11.** Master merged the agent-registry decision as ADR-0023 the same week our branch had written its own ADR-0023. When I merged master back into the three PRs, ours moved: external entrants is 0024, the MCP decision is 0025. Commit messages older than that still say 0023 and 0024. Merge commits eff48b6 and 71c63e8. Measured.

**Flags held before joining are recorded, not subtracted.** This is what the board showed on 2026-09-11 when a wallet from an earlier race joined a new run. The scorer reads flags by wallet from the chain regardless of when they were minted, so a wallet that raced before shows up with last race's flags at time zero. The backend records the count at join time (`packages/backend/src/server.ts:334` reads it at join, `packages/backend/src/run-manager.ts:425` carries it to the board) and the board shows it only in the focused lane's detail line. Nothing subtracts it from the count or the rank. This was ADR-0024's choice and it is wrong for Base, where nobody can reset the chain. Measured. Not fixed; see below.

## What is still open

- PR #82 targets master on its own and PR #79 is closed without merging, as history of the first version. #82 carries every commit #79 had. Decided 2026-09-13.
- Flags held before joining stay on the board. Shiv's call on 2026-09-13: for now one wallet takes part in one run, and a returning racer uses a fresh wallet. One thing to know before Carlos and Rinat read the pages: the register page says "skip if you already have one" and the token is described as good for every race after, which assumes wallet reuse. If one wallet means one run, the page should say to create a new wallet and register again for each race, or the rule should say the flags are the person's problem. Not changed; needs a decision from Shiv.
- The challenge list lives at the website's `/llms.txt` page. That page was built for search crawlers, and now it is also what an outside agent reads to learn the twelve challenges and their addresses. If someone later moves or reshapes that page, outside agents lose the challenges and nothing in the backend will notice. A short comment in the route file would stop that from happening by accident.
- When the backend process restarts, for a deploy or a crash, every race that was running at that moment is marked failed. That was true before this work. The new tokens are stored in the database and survive a restart, but a token surviving does not help when the race it was in is already gone. Fixing restart is separate work, not part of these PRs.
- Publishing race results to the ERC-8004 reputation registry, so a wallet carries its record to other places. Later, if at all.
