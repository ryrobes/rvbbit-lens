# Lens Homebase — durable, shareable persistence

## The problem

Lens state (desktops, scenes, prefs) persists to **browser localStorage**. That
was the right default — Lens is a SQL client, not bound to any one server, so
saving on "the server" makes no conceptual sense. But localStorage is ephemeral,
single-profile-per-browser, and unshareable. You can't recover work after a
cleared cache, run multiple profiles, or share a desktop/dashboard with a
coworker.

## The model

Local-first with a server **shadow**. The browser stays the synchronous source
of truth (so dragging windows is always snappy); a server-controlled store is
the eventually-consistent mirror that makes state durable and shareable. Three
scopes:

| Tier | Scope | Sync | Holds |
|---|---|---|---|
| **Global** | org-wide | server-authoritative (browsers read) | data connections (shared service-account creds) |
| **Profile** | per-user "home" | local-primary + debounced shadow | desktops, prefs, draft scenes — the scratchpad |
| **Scene** | shareable artifact | eager shadow on save | a portable saved desktop, loadable across homes |

Making **connections global** is the load-bearing decision: scenes become
portable for free (everyone resolves the same connection ids), which is what
turns a personal scratchpad into a shareable presentation surface.

### Access & semantics (high-trust internal, no auth)

- **Capability URLs**, not auth: a profile/scene has an unguessable slug, and
  the link *is* the grant ("anyone with the link"). Soft identity (a name) for
  attribution, not enforcement. Real security stays at the DB-connection layer.
- **Load = wiki / last-write-wins; Save As = fork.** Opening a shared scene and
  saving overwrites the canonical (fine for a trusted team); "Save As" makes an
  independent copy in your home. No live co-edit (a 10× scope jump we don't
  need).
- **Presentation mode = a flag.** A `readOnly` behavior flag (UI toggle or
  `?present=1`) gates writes; the "less chrome" *rendering* is a deferred visual
  pass over the same flag.

The one cost we accept: global connections ⇒ a **shared DB identity** per
connection. That's correct for an internal org, and it's the clean trigger for
auth later (the soft label becomes a real user; the service account becomes
per-user creds).

## Storage

A single server-controlled **SQLite** file (`node:sqlite`, no native dep). One
file → `cp` to back up, and a read-here/write-there script migrates to a homebase
Postgres later if desired. This whole module (`lib/server/lens-db.ts`) is the
seam to swap SQLite for Postgres without touching the client.

## Phases

1. **Spine (DONE)** — SQLite store + migrations + CRUD API + debounced
   write-shadow + first-run seed. No user-visible change; durability under the
   hood, keyed by a per-browser home id.
2. **Sharing** — soft identity, the Scene Library, share URLs, the `readOnly` /
   `?present=1` flag.
   - **2.1 identity + hydration (DONE)** — `home-identity.ts` + a menu-bar
     `HomeIndicator`. A home is a slug (no auth, capability-URL style). Switching
     is **lossless** (your current home stays shadowed): *claim* an empty home
     (switch + seed from local, no reload) or *adopt* an existing one (pull
     state+scenes → reload, with a confirm). `?home=<slug>` deep-links auto-adopt.
   - **2.2a Scene Library (DONE)** — scenes carry a `visibility` (private|shared,
     client-tracked + shadowed). The scene tray gets a per-scene share toggle (the
     globe) and a "Shared by other homes" section that lists others' shared scenes
     with a **Fork** (copies into your home). `GET /api/lens/library?home=` returns
     shared scenes from all *other* homes.
   - **2.2b present flag (DONE)** — `present-mode.ts` (a per-tab sessionStorage
     flag) + a menu-bar `PresentToggle`; `?present=1` enters it on load.
     `saveDesktopState` no-ops in present mode, so a presented desktop is a stable
     read-only surface (React state still updates; only persistence stops). The
     "less chrome" rendering pass is still deferred.
3. **Globalize connections** — move connections into `lens_connection`
   (server-authoritative, shared creds in the server secret store).

## Phase 1 as-built

- **`lib/server/lens-db.ts`** — opens `.lens-data/lens.db` (WAL), runs a tiny
  versioned migration runner, exposes `getProfile/putProfile` and
  `listScenes/replaceScenes`. Tables: `lens_profile` (per-home desktop blob) and
  `lens_scene` (one row per saved desktop — individual rows now so the Phase-2
  Scene Library is a query, not a migration). `node:sqlite` is loaded via
  `process.getBuiltinModule("node:sqlite")` because turbopack doesn't yet
  recognise it as a builtin and errors on a literal import.
- **`app/api/lens/{profile,scenes}/route.ts`** — Node-runtime GET/PUT.
- **`lib/desktop/server-sync.ts`** — `shadowDesktopState` / `shadowScenes`
  (debounced ~1.5s, fail-safe), keyed by a per-browser `rvbbit-lens.home-id`.
- Hooked into the existing single write-funnels: `saveDesktopState`
  (state-store) and `writeStore` (scenes). **Write-only** — load behaviour is
  unchanged (the UI still reads localStorage).
- Config: `LENS_DATA_DIR` / `LENS_DB_PATH` override the store location;
  `.lens-data/` is gitignored.

**Phase-1 limitations (by design):** no read-back/hydration yet (Phase 2); a
saved scene that's never re-touched isn't shadowed until its next mutation (the
mount-seed that covered this lives wherever the desktop shell settles — a
one-liner once that file's other WIP lands); SQLite is single-writer (ample for
an internal tool).
