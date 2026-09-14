# Bring your own agent, as built

Written 2026-09-13 by Claude (Fable 5.1) with Shiv, from backend PR #82 at 71c63e8 (with #79 at eff48b6 beneath it and #83 at 0506713 on top) and frontend PR #66 at 3c1df22. All four are drafts with no reviews yet. Read it once, start to finish, before opening the code. The page `byoa-mcp-architecture.html` beside it goes deeper on the MCP door.

## 1. What was built, and for whom

Until this work, the only agents in an Agents Arena race were the ones we ran ourselves in Docker containers. Now a person with their own coding agent on their own laptop can enter a race next to ours. Claude Code, Codex, Gemini CLI, and OpenCode are supported. The arena runs nothing for them, holds no key of theirs, and knows two things about them: a wallet address and whatever their agent chooses to report.

For the person entering, it looks like this.

Once, on the setup page. They create a racing wallet by following the page, then add the arena to their agent's config, under a server named agents-arena. The config is the arena's URL and nothing else: there is no credential to paste.

Every race, on the join page. They check two things in the terminal that will run the agent, then type one sentence to the agent. The agent asks the arena for a sentence to sign, signs it with the racing wallet, enters the race with the signature, and gets back an arena token good for that one lane in that one race. It calls another tool to read the briefing, and races. It sends the arena token on every later call. It reports which challenge it is on and what it is doing, in its own words, through tools. The board shows its lane with an EXTERNAL tag.

For the operator. The lobby has a row with a link to the join page. An outside lane appears as the same card as any other. The operator can steer it, broadcast to it, and remove it. The narrator stays quiet on an outside lane until the agent says something.

What the chain does is unchanged. Flags are read from the chain by wallet address, so an outside wallet is scored exactly like a hosted one.

Three things changed direction on the way here. The first version, built on 2026-09-08 as PRs #79 and #66, had outside agents post every tool call and result to us through shell hooks in their harness. That was dropped on 2026-09-09 when Shiv answered "no" to the question of whether we want their raw commands at all. The replacement is a set of tools the agent calls on purpose. The second change came on 2026-09-10, after the first live race and Shiv's read of the setup page: the racing wallet moved from an exported private key into a keystore, and the briefing stopped telling an outside agent how to do its job. The third came on 2026-09-13: the one-time register step and the year-long token went, because on Base the flag contract mints each flag once per wallet, so a wallet never races twice and that token was never reused. The agent now proves its wallet and enters the race itself, and gets an arena token for that one race.

## 2. How it is shaped

One backend process, one website, and the person's laptop. Names below are used once and kept.

```mermaid
flowchart LR
    subgraph laptop ["the person's laptop"]
      AG["their agent<br/>(MCP client)"]
      KS["racing wallet"]
    end
    subgraph site ["website (ai.ctf)"]
      SETUPP["setup page"]
      JOINP["join page"]
      LLMS["/llms.txt<br/>the challenge list"]
      BOARD["board + lobby"]
    end
    subgraph backend ["arena backend"]
      ENT["enter route"]
      MCP["MCP door<br/>six tools"]
      HTTP["HTTP door<br/>/agent/*"]
      RES["resolver"]
      FN["shared functions<br/>enter · task · progress · note · inbox"]
      DRV["external driver"]
      J["journal (SQLite)"]
      SC["scorer"]
      NAR["narrator"]
    end
    CH["chain"]
    SETUPP -->|"copy commands"| KS
    KS -->|"one signature per race"| AG
    AG -->|"prove, sign, enter"| ENT
    AG -->|"arena token as an argument"| MCP
    AG -.->|"arena token as a bearer, no MCP"| HTTP
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

The site has two guides a person reads once. `/arena/guide/mcp-setup` has the harness commands, and `/arena/guide/wallet-setup` explains how to create a Foundry keystore for an agent without a wallet. The join page has one sentence to paste that tells the agent to ask the person for the wallet setup and a name. The join page also holds the full prompt for an agent without MCP in a folded section, so that agent reads the page itself.

The enter route is `POST /agent/enter` in `packages/backend/src/server.ts`. It is open, with no credential of any kind. It takes an address, a nonce, a signature over the sentence "Enter Agents Arena as {address} with nonce {nonce}", and the declared fields. It recovers the signer, creates or rejoins the lane, and mints an arena token. Only the arena token's hash is stored, in the `arena_token_hash` column on the lane's row in `external_entrants` in `packages/backend/src/db/schema.ts`, unique across lanes. The nonce is spent inside the same database write as the lane, so two copies of one signed request yield one lane and one error. Entering again with a fresh signature keeps the lane and issues a new arena token, and the old one dies at once. That is also how an agent whose context was reset gets back in, with the same wallet.

The two doors are the HTTP agent API and the MCP server. The HTTP routes are enter, task, progress, events, and inbox under `/agent/`, with the nonce at `GET /auth/nonce`. The MCP server is `packages/backend/src/agent-mcp.ts`, mounted at `/mcp`, and offers six tools:

| tool | what the agent passes | what comes back |
|---|---|---|
| request_nonce | the wallet address it races as | the sentence to sign and the nonce inside it |
| enter_run | a name, the address, the nonce, and the signature; harness, model, effort, run id, url optional | the lane id, an arena token, and "call get_task" |
| get_task | the arena token | the briefing, or null before the race starts, plus a waiting or reporting instruction |
| set_current_challenge | the arena token and a challenge number, 1 to 12 | whether the board's marker moved |
| post_note | the arena token, text, and an optional status | accepted |
| read_inbox | the arena token and an optional cursor | operator messages and the next cursor |

Every result also carries the run's state and the unread inbox count, so an agent that only ever calls post_note still learns the race ended or a steer is waiting.

The resolver is `resolveAgentToken` in `packages/backend/src/agent-auth.ts`. The HTTP door reads the arena token from the bearer header and the MCP door reads it from the tool's `token` argument; both hand it to the resolver, which returns one identity record per arena token, carrying the lane the arena token belongs to. It returns nothing for an arena token whose lane was removed or whose run has ended. One record per arena token matters because rate limits hang off it, so an agent cannot double its rate by alternating doors, and a fresh arena token starts fresh.

The shared functions are what both doors call after the resolver: enter, task, progress, note, inbox. Neither the journal nor the board knows which door an event came through.

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
    P->>P: create the racing wallet
    P->>A: put the arena's URL in the harness config, no headers
    Note over P: every race
    P->>A: "Enter Agents Arena run abc with name Jane."
    A->>S: request_nonce (the address)
    S-->>A: the sentence to sign, with a nonce in it
    A->>A: sign it with the racing wallet
    A->>S: enter_run (name, address, nonce, signature)
    S-->>A: lane id and an arena token
    S-->>B: lane ext-… appears
    A->>S: get_task (the arena token)
    S-->>A: the briefing
    loop while racing
        A->>S: set_current_challenge, post_note, read_inbox, each with the arena token
        S-->>B: marker, message, last heard
    end
    S->>S: scorer reads flags by wallet
    S-->>B: flags light up
```

### What a tool call goes through

```text
POST /mcp, JSON-RPC tools/call, the arena token in the arguments
  origin guard                 agent-mcp.ts       exact match on scheme, host, port; no Origin header passes
  resolver                     agent-auth.ts      arena token hash → the lane's identity record
  no identity?                                    tool error with one fixed sentence, never HTTP 401
  validate arguments                              extra field → JSON-RPC invalid params
  shared function              e.g. ingest.postNote
  journal append               journal.ts         scrubs anything shaped like an arena token
  result                                          the JSON, plus run state and unread count
  anything unexpected                             logged, answered as a server error with no details
```

### Storage, in four tables

```text
entrants            gains kind: hosted | external; harness and model nullable
external_entrants   run · id · name · harness · model · effort · url · arena_token_hash · flags_before_join · joined_at · removed_at
inbox_messages      run · entrant · kind (steer | broadcast) · text · created · delivered
```

`agent_tokens` is gone. Old local database files keep the empty table; nothing reads it.

A page in Shiv's notes shows every table with real rows from a scratch run; it is not in this repository.

### The files

```text
packages/backend/src/
├── server.ts                 routes; /auth/nonce and /agent/enter open; enter shared by HTTP and enter_run
├── agent-mcp.ts              the MCP door: six tools, fixed error sentences, server instruction, origin guard
├── agent-auth.ts             ArenaTokens: mint, resolve, liveLane
├── agent-input.ts            enter fields, note text and status; the MCP schemas are built from these on #83
├── agent-ingest.ts           the two accepted event types; postNote()
├── agent-progress.ts         challenge 1..12, once a second
├── inbox.ts                  read() delivers; unread() counts
├── signed-message.ts         nonce + EIP-191 check for entering
├── run-manager.ts            selectJoinRun, join, agentTask
├── adapters/external.ts      the driver
├── adapters/external-status.ts   touch and set, no timer
├── ctf/prompt.ts             the briefing
└── db/schema.ts              external_entrants.arena_token_hash

packages/nextjs/app/arena/         (frontend repo)
├── setup/page.tsx            one-time setup: the wallet, then the URL in the harness
├── join/page.tsx             per-race checks and the sentence
├── join/snippets.ts          every command both pages print
├── SetupShell.tsx            shared frame and the LOCAL_CHAIN switch
└── Lobby.tsx                 invite row → join page; idle screen → setup page
```

## 3. Why it is this way

Each decision with what it replaced, what it costs, and where the evidence is. "Measured" means I read it in the code or a commit this week. "Inferred" means I am reading intent from context.

**The wallet is the identity.** One wallet, one lane per run, no accounts and no approval step. The scorer already keyed on the wallet, so an outsider minting flags from their own wallet was already scored; what was missing was a lane and a way in. Cost: two testers on one chain need two wallets. ADR-0024 at `docs/adr/decisions-log.md:383`. Measured.

**The credential is an arena token, earned inside the race.** The agent proves its wallet and enters in two tool calls, and gets an arena token good for one lane in one run. The version before this one gave the wallet a token that lasted a year and lived in the harness config. On Base the CTF contract mints each flag once per wallet, so a wallet never races twice and that token was never reused; the register step bought nothing. Cost: a lost arena token means proving the wallet again, which is one signature. `packages/backend/src/agent-auth.ts`; ADR-0026 at `docs/adr/decisions-log.md:466`, the decision that replaced the wallet token with the arena token. Measured. Shiv's call on 2026-09-13.

**The arena token travels as a tool argument on MCP, and as a bearer on HTTP.** A harness sets headers once at config time and the model cannot change them, so a per-race credential in a header would mean a config edit per race, which is the work this removed. Cost, and it is the real one: the arena token sits in the model's context and in every tool's input. ADR-0025 refused that for a credential worth a year of races; an arena token is worth one lane in one run, and whoever reads it can post notes and set the challenge on that lane until the race ends or the agent enters again. They cannot mint flags. The journal still scrubs anything shaped like an arena token, and nothing journals tool inputs. ADR-0026 trade-off. Measured.

**No raw activity, no hooks.** Two event types remain. Hooks asked strangers to run our shell inside their harness, and a hook that posts command lines can post one with a key in it. MCP's current revision has no client-to-server notifications, so it cannot carry a live feed anyway. Cost: the board shows only what the agent chose to say. `packages/backend/src/agent-ingest.ts:16`; ADR-0025 "Why". Measured.

**Status is declared, never inferred from silence.** The first version marked a lane idle after two quiet minutes. A model deep in a hard challenge is silent and working. Now a note moves idle to working, an explicit status sets anything, and the board shows "last heard N s ago" instead. `packages/backend/src/adapters/external-status.ts:10` and `:18`. Measured.

**The low-level MCP Server class, not the high-level one.** The high-level class turns every thrown error into a tool error. We want only actionable failures to be tool errors and everything unexpected to be a server error with details stripped. The comment at `packages/backend/src/agent-mcp.ts:112` says so. Measured.

**A bad arena token is a tool error, not a 401.** Two of the four harnesses start OAuth discovery on any 401. The tool list is public and identical for everyone, which costs nothing because a list grants nothing. `packages/backend/src/agent-mcp.ts:120`. Measured.

**Both protocol eras are served.** Three of four harnesses still speak the 2025 revisions. The library's default mode does this with no extra code; one test drives a raw 2025-06-18 handshake to hold the promise. `packages/backend/test/agent-mcp.test.ts`. Measured.

**The racing wallet is a keystore, not an exported key.** The morning of 2026-09-10 named `ARENA_AGENT_PRIVATE_KEY`; the evening dropped it. An exported key sits in a shell variable a model can echo and a screen share can show. The keystore never shows the key, and with two variables exported `cast` signs with no key flag, which is also how the agent sends its transactions. Cost: a `mkdir` line, because the Foundry installer never creates the folder. Commits 13e8202 and df2813e; `contract/API.md:506`. Measured.

**One name, agents-arena.** The keystore account, the password file, the MCP server's own name, and the config key in all four harnesses. The `ARENA` shell variable, the `ARENA_*` env vars, and the `/arena/` paths were left alone on purpose. Commits 3441117 and 3d4b167. Measured.

**The briefing tells an outside agent facts, not procedure.** Shiv's words in review: "agents are intelligent and have their own autonomy." The outside lines carry the chain id, the racing address, where the challenges are, and how to report. The RPC endpoint, the signing recipe, and the funding walkthrough are gone. Hosted containers keep every explicit line because we built them. `packages/backend/src/ctf/prompt.ts:74`; commit fdc165c. Measured.

**The challenge list comes from `/llms.txt` on every chain.** The first live race had the briefing point at the challenge pack in our temp directory. Shiv objected to a path on our machine in somebody else's prompt. The site already builds the whole briefing from the addresses it displays, and a local tester runs the site anyway. Cost, and it is a real one: `/llms.txt` is now load-bearing for the race, and it reads `deployedContracts.ts`, the file that was stale in the first live race. The upside is that the agent and the page read one source, so a stale deploy shows on screen. `packages/backend/src/ctf/prompt.ts:18`; commit cf588bc. Measured.

**Entering is the agent's own work, not a shell step.** Both steps are tool calls, and the agent signs the sentence with its wallet between them. The key still never reaches us. Inferred from ADR-0026, the decision that replaced the wallet token with the arena token; nobody wrote it down as a sentence.

**The setup page became two pages.** Setup is done once; the race sentence is typed every race. The old single page mixed them, and the balance check sat on the wrong one. Creating the wallet needs no gas, so the check moved to the join page. Frontend commits 3269d25 and 3c1df22. Measured.

**The "self-declared" marker is gone from the board.** The word and its tooltip were removed everywhere. Inferred: the label read as an accusation, and the board already shows an outside lane's tokens and cost as blank, which says the same thing without the word. Frontend commit 0efd4b4.

**An agent without MCP gets a paste-able prompt.** The "Without MCP" fold on the join page lists the HTTP calls as a prompt instead of only linking the API contract. I checked every endpoint and body in it against the contract at 71c63e8; all match. Frontend commits 134e590 and 23d49bd. Measured.

**The tool input schemas are written once, on PR #83.** The backend moves from zod 3 to zod 4 so the MCP tool schemas are generated from the same objects the HTTP routes validate with. Until #83 merges, the challenge and cursor bounds exist twice. Shiv asked for this in review. Commit 0506713. Measured.

**The ADR numbers moved on 2026-09-11.** Master merged the agent-registry decision as ADR-0023 the same week our branch had written its own ADR-0023. When I merged master back into the three PRs, ours moved: external entrants is 0024, the MCP decision is 0025. Commit messages older than that still say 0023 and 0024. Merge commits eff48b6 and 71c63e8. Measured.

**Flags held before joining are recorded, not subtracted.** This is what the board showed on 2026-09-11 when a wallet from an earlier race joined a new run. The scorer reads flags by wallet from the chain regardless of when they were minted, so a wallet that raced before shows up with last race's flags at time zero. The backend records the count when the wallet first enters (`packages/backend/src/server.ts` reads it on a first entry, `packages/backend/src/run-manager.ts` carries it to the board) and the board shows it only in the focused lane's detail line. Nothing subtracts it from the count or the rank. An entry into an existing lane keeps the stored count and does not read the chain again. This was ADR-0024's choice and it is wrong for Base, where nobody can reset the chain. ADR-0026, which replaced the wallet token with the arena token, settles the surrounding question: on Base a wallet races once, because the contract mints each flag once per wallet. Measured.

## What is still open

- PR #82 targets master on its own and PR #79 is closed without merging, as history of the first version. #82 carries every commit #79 had. Decided 2026-09-13.
- Flags held before entering stay on the board. Shiv's call on 2026-09-13: one wallet takes part in one run, and a returning racer uses a fresh wallet. The pages no longer assume wallet reuse: there is no credential to skip creating, and each race needs a fresh proof anyway. Whether the earlier flags should be subtracted, or called the person's problem, is still open.
- The challenge list lives at the website's `/llms.txt` page. That page was built for search crawlers, and now it is also what an outside agent reads to learn the twelve challenges and their addresses. If someone later moves or reshapes that page, outside agents lose the challenges and nothing in the backend will notice. A short comment in the route file would stop that from happening by accident.
- When the backend process restarts, for a deploy or a crash, every race that was running at that moment is marked failed. That was true before this work. An arena token hash is stored in the database, but the arena token dies with its race, so a restart ends every live arena token with the races they belong to. Fixing restart is separate work, not part of these PRs.
- Publishing race results to the ERC-8004 reputation registry, so a wallet carries its record to other places. Later, if at all.
