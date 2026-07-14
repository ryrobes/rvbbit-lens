# Desktop Assistant — "the OS speaks"

Status: **P0 SHIPPED end-to-end 2026-07-12** (uncommitted in both repos); design converged same day.
Repos involved: `rvbbit-lens` (UI, applier, persistence) + `rvbbit-sql` (operator, agent-loop additions).

## P0 as built (2026-07-12)

- Operator: `rvbbit.desktop_assistant_turn` — migration `rvbbit-sql/crates/pg_rvbbit/sql/migrations/0146_desktop_assistant_turn_operator.sql` (+ registered in migrations.rs). Opus 4.8 via OpenRouter (`anthropic/claude-opus-4.8`), `max_iters:30`, `budget:{cost_usd:5, wall_ms:240000}`, `tool_result_max_chars:60000`, plus `rvbbit.desktop_try_jsonb()` (fence/embedded-JSON tolerant parse; prose ⇒ zero-command conversational turn).
- Query tool honesty: builtin agent query tool now returns `{rows_returned, truncated, cap:500, rows}` (`unit_of_work.rs`) — shipped in the rebuilt pg-rvbbit image.
- Lens: `assistant` window kind (`types.ts`), `assistant-window.tsx` (aether styling: translucent blur pane, ✦ floating utterances, command chips as receipts, theme tokens only), `lib/desktop/assistant.ts` (context builder w/ resolved SQL via buildDesktopRuntimeGraph, turn transport, thread persistence), applier + viewport-aware placement in `desktop-shell.tsx` (`applyAssistantCommands`), homebase `lens_assistant_messages` (lens-db v3) + `/api/lens/assistant`, Rabbit launcher in the Semantic folder.
- Verified live (Playwright): create×2 with `place:near`, update_block (+ next-tick runSignal), emit_param → PARAMS shelf + cascade, focus, thread survives desktop reset, user-correction loop.

Hard-won P0 lessons (do not relearn):
1. React updater staleness: a variable assigned inside a `setMessages` updater is still stale when the fetch fires — mirror state in a ref (`messagesRef`) for sync reads. This silently sent an EMPTY conversation for a while; found via `agent_messages` receipts (the task row shows exactly what she saw — always debug from receipts).
2. Same-batch runSignal re-runs the STALE draft (payload.sql syncs into the editor draft in an effect); bump the run signal on a ~80ms next tick.
3. Placement must be confined to the visible world rect (`(screen - viewport.xy)/scale`) — the first version walked blocks off-screen; "applied" chips + empty canvas.
4. Models wrap JSON in prose/fences on conversational turns — parse leniently (outermost `{…}` fallback) AND keep the prose-⇒-conversation fallback.
5. Claims-vs-does: the model will describe actions it didn't command; the contract now requires reply ∧ commands to match, and chips-next-to-words makes violations visible. The `did` field on conversation entries gives her memory of past builds across desktop resets.

## Thesis

A desktop-level Assistant: a chat that creates and manipulates blocks on the user's
SQL Desktop canvas — everything the in-block App builder can do, but materialized as
*separate first-class blocks* instead of content inside its own scope. It is not a
window with a content panel; it is the OS talking.

The key architectural decision: **the desktop verbs are NOT MCP tools.** The
Assistant is a semantic operator turn (sibling of `html_block_turn`) that returns a
`{reply, commands[]}` artifact which the lens client applies through the existing
shell mutation API. External MCP clients (Claude Desktop → warehouse-mcp) can never
see, call, or be confused by desktop tools because they exist only in the operator
contract and the lens applier. Scoping by construction, not by prompt or gating.

Why this beats "give the MCP eyes and hands":

- warehouse-mcp has no conditional tool exposure (all ~80 tools go to every client;
  `services/warehouse-mcp/server.py:3791` `_register` is one unconditional list).
- There is no server→browser push channel for desktop state (homebase is a
  write-only shadow; nothing reads it back into a live session).
- The lens in-block AI already works exactly this way: `rvbbit.html_block_turn()`
  returns a spec artifact the client applies (`data-grid-window.tsx:1745`).
  The client is already the materializer.
- Client-applied commands execute over the user's own lens connection (their PG
  role, their grants) — better provenance than a shared service key.

## Grounding (what exists, file:line)

rvbbit-lens:
- Block = `DesktopWindowState` (`src/lib/desktop/types.ts:87`); ~70 window kinds;
  SQL block is `kind:"data"` with `DataPayload` (`types.ts:251`).
- Stable human handles exist: `reactive.blockName`; cross-block refs are
  `block.<name>` / `param.<block>.<field>` (`types.ts:296-302`).
- Central mutation API in `desktop-shell.tsx`: `openWindow` (:1581), `move` (:1573),
  `resize` (:1577), `close` (:1565), `updatePayload` (:1597), `emitParam` (:1639).
  Dev proof-of-concept "hands": `window.__rvbbitTest.addBlock()` (:1728).
- Undo stack (:691, 400ms debounce, depth 80) + Scenes (named desktop snapshots,
  `src/lib/desktop/scenes.ts`) = checkpoint/undo substrate.
- Reactive rewrite happens client-side before SQL ships
  (`src/lib/desktop/reactive-sql.ts`) — see snapshot spec below (resolved SQL).
- Homebase: `node:sqlite` at `.lens-data/lens.db` (`src/lib/server/lens-db.ts`),
  browser→server debounced shadow (`src/lib/desktop/server-sync.ts:63`).
- In-block AI: `runAsk` → `rvbbit.synth_sql` (`data-grid-window.tsx:1693`);
  App builder → `rvbbit.html_block_turn` (:1745), applied client-side.
- No free-standing chat window exists today; `agent-messages-window.tsx` is a
  read-only receipts viewer (this becomes the audit/archive surface).

rvbbit-sql:
- `html_block_turn` operator: `crates/pg_rvbbit/sql/migrations/0120_*.sql` —
  agent step, `tools:[{"builtin":"query"}]`, `max_iters:8`,
  `tool_result_max_chars:12000`, `budget:{cost_usd:0.75}`, `cache_policy:never`.
- Agent-step tool registry (`crates/pg_rvbbit/src/unit_of_work.rs:737-780`)
  supports THREE kinds today: `{"builtin":"query"}` (read-only, 200-row cap),
  `{"server":X,"tool":Y}` (arbitrary MCP tools via rvbbit's MCP-client capability
  layer), and Hindsight memory tools (`memory_recall`, :781).
- Live telemetry mid-run: `live_call_counts()` + `agent_messages` receipts.

## Turn protocol

Client → operator `rvbbit.desktop_assistant_turn(user_message, conversation_window,
desktop_context, opts)` via `POST /api/db/query` (same path as all in-block AI).

Returns:

```json
{
  "reply": "short utterance",
  "commands": [ ... ],            // see vocabulary
  "agent_run_id": "...",
  "status": "ok|budget|error"
}
```

The assistant window applies `commands` through the shell mutation API, then
includes an **apply report** (per-command ok/skip + final block names/ids) in the
next turn's `desktop_context`. The agent never assumes an apply succeeded; it is
told next turn.

### Desktop context snapshot (the "eyes")

Sent fresh EVERY turn — the conversation carries intent; the snapshot carries
truth. This is what makes the design state-anchored rather than history-anchored:
drift is structurally resisted because the world is re-handed to her each turn.

Active workspace ONLY (decided). Contents:

- workspace slot id, viewport rect, focused window
- per block: `{ name, id, kind, title, rect, minimized }`
- data blocks add: **resolved SQL as last executed** (post reactive rewrite — the
  raw `payload.sql` may contain `block.*`/`param.*` refs and is NOT what ran;
  shipping raw SQL causes silent divergence between what she re-runs and what the
  user sees), result metadata `{ rows_returned, truncated, cap, columns[] }`, and
  a 3–5 row scent labeled "N of M rows"
- param graph: current `params` + subscription edges
- apply report from the previous turn

Full result pulls are NOT in the snapshot — the agent uses the builtin query tool
on demand (targeted, receipted, evictable). The snapshot is the recurring baseline
tax; keep it lean.

### Command vocabulary v1 (prove create / target / read)

Schema-versioned: `rvbbit.desktop_commands.v1`.

- `create_block { kind: "data"|"note"|"artifact", name?, spec: {sql?, title?,
  chartSpec?, viewKind?, htmlBlock?}, place: "auto" | {near: "<blockName>"} }`
- `update_block { target: "<blockName|id>", patch: {...} }`
- `emit_param  { block, field, value, operator? }`
- `focus_block { target }`  — scroll/spotlight; the pointing affordance
- `close_block { target }`

Semantics:
- **Names are the foreign keys.** The agent chooses `name`s; the applier honors
  them (slug-collision-safe). A later command in the same batch may reference an
  earlier command's block (`param.sales_by_region.region`) before it exists —
  the reactive graph already resolves by name.
- Placement is `auto|near` only. The applier owns a free-rect packer near the
  viewport center; the model never does pixel math.
- Per-turn command cap (start: 12). Apply-time validation: a missing target is a
  per-command SKIP reported next turn, never a batch failure.
- The applier snapshots BEFORE applying (single undo entry per turn; optionally an
  auto-scene checkpoint for multi-create turns). Agent turn = one Ctrl-Z.

### Deferred-tool evolution (P1)

P0 ships the vocabulary as a final-JSON contract (zero Rust — html_block_turn
pattern). P1 promotes it to real tools: a fourth `AgentTool` variant in
`unit_of_work.rs` (`{"virtual":"desktop"}`) that advertises the command schemas to
the model, buffers calls, and returns synthetic acks carrying the provisional
block name. Tool-shaped calls are more reliable than end-of-turn JSON once the
vocabulary grows, and provisional-name acks let her wire A→B mid-loop without a
real round trip.

## Operator definition (P0 migration, sibling of 0120)

- Agent step, frontier model, quality-over-cost posture:
  `max_iters: 30+`, `tool_result_max_chars: ~100k`, real dollar `budget`
  (`agent_messages` receipts + cost accounting already absorb this).
- `tools: [{"builtin":"query"}]` (+ `memory_recall` once memory config is on;
  + `{"server":"warehouse","tool":...}` in P2).
- **Truncation honesty is structural**: the query-tool result envelope must always
  carry `{rows_returned, truncated: bool, cap}` — never let a silent cap
  masquerade as completeness ("asked for top 100, got 30, guess there are 30").
  Same rule for snapshot scents. This is P0, in the tool handler, not the prompt.
- System prompt register: SHORT utterances. The floating-message UX depends on it,
  and it is what makes voice feel inevitable later.
- `cache_policy: never`.

## Context & memory model

Three tiers:

| Tier | Carrier | Lifetime | Bound |
|---|---|---|---|
| Present | desktop snapshot | one turn, re-sent fresh | lean by spec |
| Session | conversation spine | unbroken, forever | window at assembly |
| Forever | Hindsight `memory_recall` | cross-session | on-demand |

- **Loop-of-loops materialization**: each turn's agent run (queries, dead ends,
  fat results) is scaffolding that collapses to reply + commands. The conversation
  spine carries ONLY user/assistant text + command summaries — never tool
  payloads. Cross-turn eviction therefore mostly doesn't exist as a problem;
  it's a contract discipline.
- **In-turn eviction (P1/P2)**: for 30-iteration runs, keep last K tool results
  verbatim; collapse older ones to
  `[evicted: query returned N rows — re-run if needed: <sql>]` (stub is free —
  the tool call args are already in the transcript). Per-operator config
  (`tool_result_keep_last`). **Cache nuance**: eviction mutates earlier messages
  and busts the prompt-cache prefix — evict in batches at size thresholds (one
  cache bust per epoch), never eagerly per iteration.
- **One unbroken thread. No sessions, no thread management.** System-tray
  continuity: next day you pop back in mid-conversation.
  - Persistence: new homebase table (e.g. `lens_assistant_messages`, keyed by
    `home`, append-only) in `lens-db.ts`; localStorage is the L1 cache of the
    same data (snappy + survives reload; DB is authority).
  - Conversation is NOT part of `DesktopSavedState` and NOT part of scenes —
    restoring a scene must not rewind the chat. Decide this in the schema, not by
    accident.
  - Prompt assembly windows the spine (recent N + optional rolling summary of the
    middle); persistence is unbounded; `memory_recall` reaches the aged-out past.
    Unbroken *feel*, bounded *attention*, permanent *record*.
  - P2: periodically ingest the spine into Hindsight so "forever" includes the
    conversation itself.

## UX — floating utterances, not a stenographer

- **No docked chat rectangle.** All lens content is on-canvas; a docked panel
  would be the only thing in the UI that isn't.
- Live turns render as **floating utterance bubbles** (notification × iMessage):
  messages arrive WHERE the action happened — "created `sales_by_region`"
  materializes beside the new block with a brief spotlight, then decays into a
  compact trail. The chat doesn't describe the desktop; it haunts it.
- **Archive window** (`kind:"assistant"`): the movable scrollback/court record —
  transcript + per-turn receipts (`agent_run_id` → agent-messages viewer).
  Both/and: bubbles are the voice, the window is the record.
- **Presence, not a spinner**: during a turn, poll `live_call_counts()` /
  `agent_messages` for the running agent and narrate ("reading orders… third
  query… validating"). Real heartbeat of the real work — the single strongest
  "she is the OS" signal, and it uses existing machinery.
- **Summon surface**: unify with Scry's ⌘K. Scry = the glance (ephemeral
  full-screen KG walk: open, dig, answer, closed). Assistant = the companion
  (persistent, spatial, acting). Looking vs doing — one summon, two lifetimes,
  both "her".
- TTS/STT is explicitly later ("icing after the cake"), but utterance-sized
  messages, action-anchored bubbles, and presence telemetry are its load-bearing
  substrate — no rewrite needed to get there.

## Governance & safety

- Commands execute under the user's own lens connection role — grants respected,
  no shared service key in the write path.
- Every turn receipted (`agent_messages`: cost, model, tool calls) — archive
  window links straight to it.
- Per-turn command cap; per-turn undo batch; apply-time validation with skip
  reports; operator budget as the spend backstop (generous by policy: if she
  needs 10 queries and 30 iterations, that's fine — it's accounted).

## Phases

- **P0 — prove create/target/read** (zero Rust):
  1. Migration: `desktop_assistant_turn` operator (commands contract in prompt).
  2. Truncation envelope on the builtin query tool result + labeled scents.
  3. Lens: `assistant` window kind (archive) + minimal input; command applier
     mapping ops → shell API (productionize `__rvbbitTest`); snapshot serializer
     (extend the `html_block_turn` desktop-context builder; include resolved SQL
     + result metadata + apply report).
  4. Homebase `lens_assistant_messages` + localStorage L1.
- **P1 — feel**: floating utterance layer + block spotlight/attribution; presence
  polling; deferred desktop tools (`AgentTool` variant, provisional-name acks);
  in-turn eviction config; `emit_param` demo polish ("filter everything to EU").
- **P2 — reach**: warehouse verbs in-loop via existing `{"server":...,"tool":...}`
  mechanism (publish_dashboard vs lay-out-as-blocks becomes a verb choice);
  memory config on (recall + spine ingestion); Scry/⌘K summon unification.
- **P3 — the door we're not opening yet**: external agents driving a live desktop
  over the SSE/NOTIFY bridge (`api/db/listen` → `handleNotify`) with per-session
  capability-token tool mounts. Same command schema, different executor/transport.
  Session-bound gating becomes a real (and structural) problem exactly here and
  no earlier.

## Non-goals (v1)

- No desktop tools in warehouse-mcp. Ever, for this feature.
- No multi-workspace targeting (active workspace only).
- No streaming turns (request/response like in-block chat; presence polling covers
  perceived latency).
- No TTS/STT yet.
- No pixel-level "computer use" — the scene graph is semantic; screenshots are a
  worse eye than the snapshot.

## Open questions

- Utterance decay policy (how long bubbles linger; density under rapid turns).
- Whether `create_block` should support `metric-board` / viz-block kinds in v1 or
  data+artifact only (lean: data+artifact first).
- Rolling-summary trigger for very long spines (defer until someone hits it).
- Naming her. (The rabbit already has the domain.)
