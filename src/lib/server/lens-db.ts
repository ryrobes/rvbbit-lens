import "server-only"

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

// node:sqlite (Node 22.5+; we run 25). Loaded via process.getBuiltinModule
// (Node 22.3+) rather than import/require: turbopack doesn't yet recognise
// node:sqlite as a builtin and errors on any literal import ("Unsupported
// external type"). A runtime call on `process` has no import literal for the
// bundler to touch. Its types are also absent from the pinned @types/node 20,
// so we describe the slice we use locally.
interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
}
const { DatabaseSync } = (
  process as unknown as {
    getBuiltinModule(id: string): {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb
    }
  }
).getBuiltinModule("node:sqlite")

/**
 * Lens "homebase" store (Phase 1 — the spine).
 *
 * A single server-controlled SQLite file that durably *shadows* the browser's
 * localStorage state. The browser stays the synchronous source of truth (so
 * dragging windows is always snappy); this is the eventually-consistent mirror
 * that survives a cleared cache and is the substrate sharing will build on.
 *
 * Phase 1 is write-only from the client's perspective: load behaviour is
 * unchanged (the UI still reads localStorage). Keyed by a per-browser "home id"
 * for now; soft identity + sharing land in Phase 2, global connections in
 * Phase 3. Pluggable by design — this whole module is the seam to swap SQLite
 * for a homebase Postgres later without touching the client.
 *
 * Uses Node's built-in node:sqlite (Node 22.5+), so there is no native
 * dependency to compile.
 */

const DATA_DIR = process.env.LENS_DATA_DIR ?? join(process.cwd(), ".lens-data")
const DB_PATH = process.env.LENS_DB_PATH ?? join(DATA_DIR, "lens.db")

// Cache the handle on globalThis so Next dev hot-reload doesn't reopen the file
// (and re-run migrations) on every module evaluation.
type Cache = typeof globalThis & { __lensDb?: SqliteDb }

function migrate(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS lens_meta (key TEXT PRIMARY KEY, value TEXT)`)
  const row = db.prepare(`SELECT value FROM lens_meta WHERE key = 'schema_version'`).get() as
    | { value?: string }
    | undefined
  const version = row?.value ? Number.parseInt(row.value, 10) : 0

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lens_profile (
        home_id    TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lens_scene (
        id         TEXT PRIMARY KEY,
        home_id    TEXT NOT NULL,
        name       TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        spec_json  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lens_scene_home_idx ON lens_scene (home_id);
    `)
    db.prepare(
      `INSERT INTO lens_meta (key, value) VALUES ('schema_version', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run()
  }
  if (version < 2) {
    // Saved Views (the artifacts formerly known as View Apps) — one JSON blob
    // per home, mirroring lens_profile. Previously localStorage-only.
    db.exec(`
      CREATE TABLE IF NOT EXISTS lens_views (
        home_id    TEXT PRIMARY KEY,
        views_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.prepare(
      `INSERT INTO lens_meta (key, value) VALUES ('schema_version', '2')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run()
  }
  // Future migrations: `if (version < 3) { ...; bump to '3' }`.
}

export function lensDb(): SqliteDb {
  const g = globalThis as Cache
  if (g.__lensDb) return g.__lensDb
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA busy_timeout = 5000;")
  migrate(db)
  g.__lensDb = db
  return db
}

// ── profile (the per-home desktop state blob) ───────────────────────────────

export function getProfile(homeId: string): { state: unknown; updatedAt: string } | null {
  const row = lensDb()
    .prepare(`SELECT state_json, updated_at FROM lens_profile WHERE home_id = ?`)
    .get(homeId) as { state_json?: string; updated_at?: string } | undefined
  if (!row?.state_json) return null
  try {
    return { state: JSON.parse(row.state_json), updatedAt: row.updated_at ?? "" }
  } catch {
    return null
  }
}

export function putProfile(homeId: string, state: unknown): void {
  lensDb()
    .prepare(
      `INSERT INTO lens_profile (home_id, state_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(home_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .run(homeId, JSON.stringify(state ?? null), new Date().toISOString())
}

// ── saved views (the per-home Saved Views blob) ─────────────────────────────

export function getViews(homeId: string): { views: unknown[]; updatedAt: string } | null {
  const row = lensDb()
    .prepare(`SELECT views_json, updated_at FROM lens_views WHERE home_id = ?`)
    .get(homeId) as { views_json?: string; updated_at?: string } | undefined
  if (!row?.views_json) return null
  try {
    const parsed = JSON.parse(row.views_json)
    return { views: Array.isArray(parsed) ? parsed : [], updatedAt: row.updated_at ?? "" }
  } catch {
    return null
  }
}

export function putViews(homeId: string, views: unknown[]): void {
  lensDb()
    .prepare(
      `INSERT INTO lens_views (home_id, views_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(home_id) DO UPDATE SET views_json = excluded.views_json, updated_at = excluded.updated_at`,
    )
    .run(homeId, JSON.stringify(Array.isArray(views) ? views : []), new Date().toISOString())
}

// ── home discovery ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Named homes on this server, for the Home switcher's discovery list. Excludes
 * the per-browser UUID "unnamed" scratch homes by design — those stay private;
 * only homes someone deliberately named are discoverable.
 */
export function listHomes(): Array<{ id: string; scenes: number; updatedAt: string }> {
  const rows = lensDb()
    .prepare(
      `SELECT h.home_id AS id, MAX(h.updated_at) AS updated_at,
              (SELECT count(*) FROM lens_scene s WHERE s.home_id = h.home_id) AS scenes
       FROM (
         SELECT home_id, updated_at FROM lens_profile
         UNION ALL
         SELECT home_id, updated_at FROM lens_scene
       ) h
       GROUP BY h.home_id`,
    )
    .all() as Array<{ id?: string; updated_at?: string; scenes?: number }>
  return rows
    .filter((r) => typeof r.id === "string" && !UUID_RE.test(r.id))
    .map((r) => ({ id: r.id as string, scenes: Number(r.scenes ?? 0), updatedAt: r.updated_at ?? "" }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// ── scenes (one row per saved desktop, owned by a home) ──────────────────────

interface SceneLike {
  id?: unknown
  name?: unknown
  visibility?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export function listScenes(homeId: string): unknown[] {
  const rows = lensDb()
    .prepare(`SELECT spec_json FROM lens_scene WHERE home_id = ? ORDER BY name`)
    .all(homeId) as Array<{ spec_json?: string }>
  const out: unknown[] = []
  for (const r of rows) {
    if (!r.spec_json) continue
    try {
      out.push(JSON.parse(r.spec_json))
    } catch {
      /* skip a corrupt row rather than fail the whole list */
    }
  }
  return out
}

/**
 * Scenes other homes have shared (visibility='shared'), for the Scene Library.
 * Returns the owning home + the full scene spec (scenes are small, so one call
 * gives the library everything it needs to render + fork).
 */
export function listSharedScenes(excludeHome: string): Array<{ owner: string; scene: unknown }> {
  const rows = lensDb()
    .prepare(
      `SELECT home_id, spec_json FROM lens_scene
       WHERE visibility = 'shared' AND home_id <> ? ORDER BY updated_at DESC`,
    )
    .all(excludeHome) as Array<{ home_id?: string; spec_json?: string }>
  const out: Array<{ owner: string; scene: unknown }> = []
  for (const r of rows) {
    if (!r.spec_json) continue
    try {
      out.push({ owner: r.home_id ?? "", scene: JSON.parse(r.spec_json) })
    } catch {
      /* skip a corrupt row */
    }
  }
  return out
}

/**
 * Replace this home's scene set with the supplied list: upsert each incoming
 * scene (preserving its original created_at) and delete any of the home's
 * scenes no longer present. Runs in one transaction so a reader never sees a
 * half-written set.
 */
export function replaceScenes(homeId: string, scenes: unknown[]): void {
  const db = lensDb()
  const now = new Date().toISOString()
  const keepIds: string[] = []
  db.exec("BEGIN")
  try {
    const upsert = db.prepare(
      `INSERT INTO lens_scene (id, home_id, name, visibility, spec_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, visibility = excluded.visibility,
         spec_json = excluded.spec_json, updated_at = excluded.updated_at`,
    )
    for (const s of scenes) {
      const scene = (s ?? {}) as SceneLike
      const id = typeof scene.id === "string" ? scene.id : null
      if (!id) continue
      keepIds.push(id)
      const name = typeof scene.name === "string" ? scene.name : "Untitled scene"
      const visibility = scene.visibility === "shared" ? "shared" : "private"
      const createdAt = typeof scene.createdAt === "string" ? scene.createdAt : now
      const updatedAt = typeof scene.updatedAt === "string" ? scene.updatedAt : now
      upsert.run(id, homeId, name, visibility, JSON.stringify(s), createdAt, updatedAt)
    }
    // Delete the home's scenes that weren't in the incoming set.
    const existing = db
      .prepare(`SELECT id FROM lens_scene WHERE home_id = ?`)
      .all(homeId) as Array<{ id: string }>
    const keep = new Set(keepIds)
    const del = db.prepare(`DELETE FROM lens_scene WHERE id = ?`)
    for (const e of existing) if (!keep.has(e.id)) del.run(e.id)
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}
