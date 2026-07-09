"use client"

/**
 * Client fetchers for the Dashboards app — reads the Warehouse MCP's registry
 * (rvbbit.dashboards / dashboard_versions / dashboard_sources, all created by the
 * warehouse-mcp service) over the standard /api/db/query route. The data-broker
 * (runDashboardQuery) is what the sandboxed artifact's rvbbitQuery() calls through
 * a postMessage bridge, so dashboards render live inside lens, read-only.
 */

import type { QueryResultColumn } from "@/lib/db/types"

interface QueryOk {
  ok: true
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  rowCount?: number
  /** Per-statement breakdown on multi-statement runs. */
  results?: { columns?: QueryResultColumn[]; rows: Record<string, unknown>[] }[]
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string, rowLimit = 5000): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, readOnly: true }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

const esc = (s: string) => s.replace(/'/g, "''")

export interface DashboardRow {
  slug: string
  name: string
  description: string | null
  team: string | null
  owner_email: string | null
  status: string
  runtime_kind?: string | null
  app_kind?: string | null
  manifest?: Record<string, unknown> | null
  last_health?: Record<string, unknown> | null
  last_debug_at?: string | null
  queries?: number | null
  tables?: number | null
  metrics?: number | null
  latest_version: number
  updated_at: string
}

export interface SourceRow {
  kind: string
  object_ref: string | null
  base_sql: string | null
  source: string
}

export interface DashboardDetail {
  slug: string
  name: string
  html: string
  status: string
  runtime_kind?: string | null
  app_kind?: string | null
  manifest?: Record<string, unknown> | null
  last_health?: Record<string, unknown> | null
  sources: SourceRow[]
}

export async function fetchDashboards(
  connectionId: string,
): Promise<{ dashboards: DashboardRow[]; error?: string }> {
  const r = await runQuery(
    connectionId,
    `SELECT slug, name, description, team, owner_email, status, runtime_kind, app_kind,
            latest_version, manifest, last_health, last_debug_at::text AS last_debug_at,
            queries, tables, metrics, updated_at::text AS updated_at
     FROM rvbbit.live_apps ORDER BY updated_at DESC`,
  )
  if (!r.ok) {
    const fallback = await runQuery(
      connectionId,
      `SELECT slug, name, description, team, owner_email, status, latest_version, updated_at::text AS updated_at
       FROM rvbbit.dashboards ORDER BY updated_at DESC`,
    )
    if (!fallback.ok) return { dashboards: [], error: r.error }
    return { dashboards: fallback.rows as unknown as DashboardRow[] }
  }
  return { dashboards: r.rows as unknown as DashboardRow[] }
}

export async function fetchDashboard(
  connectionId: string,
  slug: string,
): Promise<{ dashboard?: DashboardDetail; error?: string }> {
  const s = esc(slug)
  const meta = await runQuery(
    connectionId,
    `SELECT d.slug, d.name, d.status, d.runtime_kind, d.app_kind, d.manifest, d.last_health, v.html
     FROM rvbbit.dashboards d
     JOIN rvbbit.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.latest_version
     WHERE d.slug = '${s}'`,
    1,
  )
  const resolvedMeta = meta.ok
    ? meta
    : await runQuery(
        connectionId,
        `SELECT d.slug, d.name, d.status, v.html
         FROM rvbbit.dashboards d
         JOIN rvbbit.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.latest_version
         WHERE d.slug = '${s}'`,
        1,
      )
  if (!resolvedMeta.ok) return { error: resolvedMeta.error }
  if (!resolvedMeta.rows.length) return { error: "live app not found" }
  const m = resolvedMeta.rows[0] as Record<string, unknown>
  const src = await runQuery(
    connectionId,
    `SELECT kind, object_ref, base_sql, source FROM rvbbit.dashboard_sources
     WHERE slug = '${s}' ORDER BY kind, object_ref NULLS LAST`,
  )
  return {
    dashboard: {
      slug: String(m.slug),
      name: String(m.name),
      html: m.html ? String(m.html) : "",
      status: String(m.status),
      runtime_kind: m.runtime_kind ? String(m.runtime_kind) : null,
      app_kind: m.app_kind ? String(m.app_kind) : null,
      manifest: (m.manifest as Record<string, unknown> | null) ?? null,
      last_health: (m.last_health as Record<string, unknown> | null) ?? null,
      sources: (src.ok ? src.rows : []) as unknown as SourceRow[],
    },
  }
}

/**
 * Publish a desktop block app into the dashboards registry — the "open form →
 * closed form" promotion. Upserts by slug (re-publish bumps the version), and
 * the named queries ride in the manifest so the published artifact keeps its
 * source map. The DDL prelude mirrors warehouse-mcp's registry bootstrap so
 * publishing works even on a warehouse the service hasn't touched yet.
 */
/** Collect `Schema`.`Relation Name` pairs from an EXPLAIN (FORMAT JSON, VERBOSE) plan. */
function collectPlanRelations(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPlanRelations(item, out)
    return
  }
  if (!node || typeof node !== "object") return
  const rec = node as Record<string, unknown>
  const rel = rec["Relation Name"]
  if (typeof rel === "string" && rel) {
    const schema = typeof rec["Schema"] === "string" && rec["Schema"] ? `${rec["Schema"]}.` : ""
    out.add(`${schema}${rel}`)
  }
  for (const value of Object.values(rec)) {
    if (value && typeof value === "object") collectPlanRelations(value, out)
  }
}

export async function publishAppBlock(input: {
  connectionId: string
  slug: string
  name: string
  description?: string
  html: string
  manifest: Record<string, unknown>
  /** Named queries — become 'query' dep rows and are EXPLAINed for 'table'
   *  edges, so a published block app is born with live lineage instead of
   *  waiting for (or needing) the regex crawler. */
  queries?: { id: string; sql: string }[]
}): Promise<{ ok: true; slug: string; version: number } | { ok: false; error: string }> {
  const slug = esc(input.slug)
  const jsonLit = (v: unknown) => `'${esc(JSON.stringify(v ?? null))}'::jsonb`
  const sql = `
CREATE SCHEMA IF NOT EXISTS rvbbit;
CREATE TABLE IF NOT EXISTS rvbbit.dashboards (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text UNIQUE NOT NULL,
  name        text NOT NULL,
  description text,
  owner_email text,
  team        text,
  status      text DEFAULT 'live',
  latest_version int DEFAULT 1,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);
ALTER TABLE rvbbit.dashboards ADD COLUMN IF NOT EXISTS runtime_kind text NOT NULL DEFAULT 'html';
ALTER TABLE rvbbit.dashboards ADD COLUMN IF NOT EXISTS app_kind text NOT NULL DEFAULT 'dashboard';
ALTER TABLE rvbbit.dashboards ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rvbbit.dashboards ADD COLUMN IF NOT EXISTS last_health jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rvbbit.dashboards ADD COLUMN IF NOT EXISTS last_debug_at timestamptz;
CREATE TABLE IF NOT EXISTS rvbbit.dashboard_versions (
  dashboard_id bigint NOT NULL REFERENCES rvbbit.dashboards(id) ON DELETE CASCADE,
  version      int NOT NULL,
  html         text NOT NULL,
  kind         text DEFAULT 'live',
  created_by   text, created_at timestamptz DEFAULT now(), notes text,
  PRIMARY KEY (dashboard_id, version)
);
ALTER TABLE rvbbit.dashboard_versions ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rvbbit.dashboard_versions ADD COLUMN IF NOT EXISTS source_files jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE IF NOT EXISTS rvbbit.dashboard_deps (
  dashboard_id bigint NOT NULL REFERENCES rvbbit.dashboards(id) ON DELETE CASCADE,
  version      int NOT NULL,
  kind         text NOT NULL,
  object_ref   text,
  base_sql     text,
  source       text,
  confidence   real DEFAULT 1.0,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_deps_did_idx ON rvbbit.dashboard_deps (dashboard_id);
CREATE INDEX IF NOT EXISTS dashboard_deps_obj_idx ON rvbbit.dashboard_deps (object_ref);
CREATE OR REPLACE VIEW rvbbit.dashboard_sources AS
  SELECT d.slug, d.name, d.team, dd.kind, dd.object_ref, dd.base_sql, dd.source
  FROM rvbbit.dashboard_deps dd JOIN rvbbit.dashboards d
    ON d.id = dd.dashboard_id AND d.latest_version = dd.version;
CREATE OR REPLACE VIEW rvbbit.dashboard_dependents AS
  SELECT dd.object_ref AS object, dd.kind, count(DISTINCT d.id) AS dashboards,
         array_agg(DISTINCT d.slug) AS slugs
  FROM rvbbit.dashboard_deps dd JOIN rvbbit.dashboards d
    ON d.id = dd.dashboard_id AND d.latest_version = dd.version
  WHERE dd.kind IN ('table', 'metric') AND dd.object_ref IS NOT NULL
  GROUP BY dd.object_ref, dd.kind;
CREATE OR REPLACE VIEW rvbbit.live_apps AS
  SELECT d.id, d.slug, d.name, d.description, d.owner_email, d.team, d.status,
         d.runtime_kind, d.app_kind, d.latest_version, d.manifest, d.last_health,
         d.last_debug_at, d.created_at, d.updated_at,
         coalesce(dep.queries, 0)::int AS queries,
         coalesce(dep.tables, 0)::int AS tables,
         coalesce(dep.metrics, 0)::int AS metrics
  FROM rvbbit.dashboards d
  LEFT JOIN (
    SELECT dashboard_id,
           count(*) FILTER (WHERE kind = 'query') AS queries,
           count(*) FILTER (WHERE kind = 'table') AS tables,
           count(*) FILTER (WHERE kind = 'metric') AS metrics
    FROM rvbbit.dashboard_deps
    GROUP BY dashboard_id
  ) dep ON dep.dashboard_id = d.id;
WITH up AS (
  INSERT INTO rvbbit.dashboards (slug, name, description, status, latest_version, runtime_kind, app_kind, manifest)
  VALUES ('${slug}', '${esc(input.name)}', ${input.description ? `'${esc(input.description)}'` : "NULL"}, 'live', 1, 'html', 'app', ${jsonLit(input.manifest)})
  ON CONFLICT (slug) DO UPDATE
    SET latest_version = rvbbit.dashboards.latest_version + 1,
        name = EXCLUDED.name,
        description = COALESCE(EXCLUDED.description, rvbbit.dashboards.description),
        manifest = EXCLUDED.manifest,
        updated_at = now()
  RETURNING id, latest_version
)
INSERT INTO rvbbit.dashboard_versions (dashboard_id, version, html, kind, created_by, notes, manifest)
SELECT id, latest_version, '${esc(input.html)}', 'live', 'lens', 'published from SQL block app', ${jsonLit(input.manifest)}
FROM up
RETURNING dashboard_id, version;`
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: input.connectionId, sql, rowLimit: 10, readOnly: false }),
    })
    const body = (await res.json()) as
      | { ok: true; rows: Record<string, unknown>[]; results?: { rows: Record<string, unknown>[] }[] }
      | { ok: false; error: string; detail?: string }
    if (body.ok === false) return { ok: false, error: [body.error, body.detail].filter(Boolean).join("\n") }
    const stmts = body.results
    const lastRows = stmts?.length ? stmts[stmts.length - 1].rows : body.rows
    const version = Number(lastRows?.[0]?.version ?? 1)
    const dashboardId = Number(lastRows?.[0]?.dashboard_id ?? NaN)

    // Lineage at birth: the named queries ARE the data edges — write them as
    // dep rows (kind='query') and EXPLAIN each for table edges. No crawler
    // needed; this is what "still a live-query app" means in the registry.
    const queries = (input.queries ?? []).filter((q) => q.sql?.trim())
    if (Number.isFinite(dashboardId) && queries.length > 0) {
      const perQueryTables = await Promise.all(
        queries.map(async (q) => {
          const bare = q.sql.trim().replace(/;+\s*$/g, "")
          // Pin the plan to the heap: the rvbbit route-rewrite hook fires even
          // under EXPLAIN, and a routed plan is a Function Scan over the engine
          // sidecar's result — the real relations never appear. SET LOCAL scopes
          // the pin to this read-only transaction. Harmless on plain Postgres
          // (custom-prefixed GUCs are settable without the extension).
          const r = await runQuery(
            input.connectionId,
            `SET LOCAL rvbbit.route_force_candidate = 'heap';\nEXPLAIN (FORMAT JSON, VERBOSE) ${bare}`,
            5,
          )
          const refs = new Set<string>()
          if (r.ok) {
            const last = r.results?.length ? r.results[r.results.length - 1] : r
            const col = (last.columns ?? r.columns)?.[0]?.name ?? "QUERY PLAN"
            const cell = last.rows?.[0]?.[col]
            try {
              collectPlanRelations(typeof cell === "string" ? JSON.parse(cell) : cell, refs)
            } catch { /* unparseable plan — table edges just stay empty */ }
          }
          return refs
        }),
      )
      const tables = new Set<string>()
      for (const refs of perQueryTables) for (const t of refs) tables.add(t)
      const values: string[] = [
        ...queries.map((q) => `(${dashboardId}, ${version}, 'query', '${esc(q.id)}', '${esc(q.sql.trim())}', 'manifest')`),
        ...[...tables].map((t) => `(${dashboardId}, ${version}, 'table', '${esc(t)}', NULL, 'manifest')`),
      ]
      // Deps are a derived index ("safe to truncate + rebuild" per the crawler),
      // and the views only ever read the latest version — so clear ALL prior
      // rows for this dashboard, keeping live_apps' unversioned counts honest.
      const depsSql = `
DELETE FROM rvbbit.dashboard_deps WHERE dashboard_id = ${dashboardId};
INSERT INTO rvbbit.dashboard_deps (dashboard_id, version, kind, object_ref, base_sql, source)
VALUES ${values.join(",\n       ")};`
      const depsRes = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: input.connectionId, sql: depsSql, rowLimit: 1, readOnly: false }),
      })
      const depsBody = (await depsRes.json()) as { ok: boolean }
      if (!depsBody.ok) {
        // Registry row landed; lineage didn't — surface softly rather than fail the publish.
        return { ok: true, slug: input.slug, version: Number.isFinite(version) ? version : 1 }
      }
    }

    return { ok: true, slug: input.slug, version: Number.isFinite(version) ? version : 1 }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** The data-broker: run an artifact's query read-only and return the warehouse shape. */
export async function runDashboardQuery(
  connectionId: string,
  sql: string,
): Promise<{ ok: true; result: unknown; columns: QueryResultColumn[] } | { ok: false; error: string }> {
  const r = await runQuery(connectionId, sql, 10000)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    // Rich columns (with pg provenance) ride along for the caller's own use —
    // the linked-filters bridge caches them to wrap subsequent runs safely.
    columns: r.columns ?? [],
    result: {
      columns: (r.columns ?? []).map((c) => ({ name: c.name, type: String(c.dataTypeId) })),
      rows: r.rows ?? [],
      row_count: (r.rows ?? []).length,
    },
  }
}
