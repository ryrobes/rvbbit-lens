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
  sources: SourceRow[]
}

export async function fetchDashboards(
  connectionId: string,
): Promise<{ dashboards: DashboardRow[]; error?: string }> {
  const r = await runQuery(
    connectionId,
    `SELECT slug, name, description, team, owner_email, status, latest_version, updated_at::text AS updated_at
     FROM rvbbit.dashboards ORDER BY updated_at DESC`,
  )
  if (!r.ok) return { dashboards: [], error: r.error }
  return { dashboards: r.rows as unknown as DashboardRow[] }
}

export async function fetchDashboard(
  connectionId: string,
  slug: string,
): Promise<{ dashboard?: DashboardDetail; error?: string }> {
  const s = esc(slug)
  const meta = await runQuery(
    connectionId,
    `SELECT d.slug, d.name, d.status, v.html
     FROM rvbbit.dashboards d
     JOIN rvbbit.dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.latest_version
     WHERE d.slug = '${s}'`,
    1,
  )
  if (!meta.ok) return { error: meta.error }
  if (!meta.rows.length) return { error: "dashboard not found" }
  const m = meta.rows[0] as Record<string, unknown>
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
      sources: (src.ok ? src.rows : []) as unknown as SourceRow[],
    },
  }
}

/** The data-broker: run an artifact's query read-only and return the warehouse shape. */
export async function runDashboardQuery(
  connectionId: string,
  sql: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const r = await runQuery(connectionId, sql, 10000)
  if (!r.ok) return { ok: false, error: r.error }
  return {
    ok: true,
    result: {
      columns: (r.columns ?? []).map((c) => ({ name: c.name, type: String(c.dataTypeId) })),
      rows: r.rows ?? [],
      row_count: (r.rows ?? []).length,
    },
  }
}
