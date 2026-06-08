"use client"

// Data layer for the Metrics / BI apps (Creator, Inspector, Catalog). All
// queries run through /api/db/query against the active (rvbbit) connection.
//
// A metric is a named, versioned SQL template stored in rvbbit.metric_defs
// (a PLAIN append-versioned table). Two independent temporal axes:
//   * DEF-TIME  — which definition version (created_at filter), p_def_as_of
//   * DATA-TIME — rvbbit AS OF over the underlying tables, p_data_as_of
// Backend surface: define_metric / metric_catalog / metric_versions /
// metric_sql / preview_metric_sql / metric(SETOF jsonb). Tokens in a metric's
// SQL: {param} (safe literal), {param!} (raw), {metric:NAME} (subquery).

export interface MetricSummary {
  name: string
  version: number
  grain: string | null
  description: string | null
  owner: string | null
  params: Record<string, unknown>
  labels: Record<string, unknown>
  createdAt: number | null // epoch ms
  sql: string
}

export interface MetricVersion {
  version: number
  createdAt: number | null // epoch ms (for display)
  /** Full-microsecond-precision created_at, as a timestamptz literal string.
   *  Use THIS as def_as_of to pin a version exactly — round-tripping createdAt
   *  through epoch-ms truncates microseconds and can select the prior version. */
  createdAtIso: string | null
  sql: string
  params: Record<string, unknown>
  grain: string | null
  description: string | null
  owner: string | null
}

export interface DefineMetricInput {
  name: string
  sql: string
  params: Record<string, unknown>
  grain?: string | null
  description?: string | null
  owner?: string | null
  labels?: Record<string, unknown>
}

/** One expanded result row of rvbbit.metric() plus the ordered column union. */
export interface MetricRunResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  error: string | null
}

interface Ok {
  ok: true
  rows: Array<Record<string, unknown>>
  columns?: Array<{ name: string }>
}
interface Err {
  ok: false
  error: string
}

async function run(connectionId: string, sql: string, rowLimit = 5000): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal (the query API has no bind params). */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** A jsonb literal from a JS object/value. */
function jb(value: unknown): string {
  return `${q(JSON.stringify(value ?? {}))}::jsonb`
}

/** def-time arg: ISO string -> timestamptz literal; null/undefined -> now(). */
function defArg(iso: string | null | undefined): string {
  return iso ? `${q(iso)}::timestamptz` : "now()"
}

/** data-time arg: ISO string -> timestamptz literal; null/undefined -> NULL (latest). */
function dataArg(iso: string | null | undefined): string {
  return iso ? `${q(iso)}::timestamptz` : "NULL::timestamptz"
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}
/** node-postgres returns jsonb as a parsed object, but be defensive. */
function asObject(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return typeof v === "object" ? (v as Record<string, unknown>) : {}
}

// ─────────────────────────────────────────────────────────────────────────
// Catalog + versions
// ─────────────────────────────────────────────────────────────────────────

export async function listMetrics(
  connectionId: string,
): Promise<{ metrics: MetricSummary[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT name, version, grain, description, owner, params, labels, sql,
            extract(epoch FROM created_at) * 1000 AS created_ms
     FROM rvbbit.metric_catalog ORDER BY name`,
  )
  if (!r.ok) return { metrics: [], error: r.error }
  return {
    error: null,
    metrics: r.rows.map((row) => ({
      name: String(row.name),
      version: Number(row.version),
      grain: str(row.grain),
      description: str(row.description),
      owner: str(row.owner),
      params: asObject(row.params),
      labels: asObject(row.labels),
      createdAt: num(row.created_ms),
      sql: String(row.sql ?? ""),
    })),
  }
}

export async function fetchMetricVersions(
  connectionId: string,
  name: string,
): Promise<{ versions: MetricVersion[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT version, sql, params, grain, description, owner,
            extract(epoch FROM created_at) * 1000 AS created_ms,
            created_at::text AS created_iso
     FROM rvbbit.metric_versions(${q(name)})`,
  )
  if (!r.ok) return { versions: [], error: r.error }
  return {
    error: null,
    versions: r.rows.map((row) => ({
      version: Number(row.version),
      createdAt: num(row.created_ms),
      createdAtIso: str(row.created_iso),
      sql: String(row.sql ?? ""),
      params: asObject(row.params),
      grain: str(row.grain),
      description: str(row.description),
      owner: str(row.owner),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SQL composition (previews) — the observable / debuggable surface
// ─────────────────────────────────────────────────────────────────────────

/** Resolve + compose an UNSAVED draft body (creator live preview). */
export async function previewMetricSql(
  connectionId: string,
  draftSql: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
): Promise<{ sql: string | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.preview_metric_sql(${q(draftSql)}, ${jb(params)}, ${defArg(defAsOf)}) AS sql`,
  )
  if (!r.ok) return { sql: null, error: r.error }
  const sql = r.rows[0]?.sql
  return { sql: sql == null ? null : String(sql), error: null }
}

/** Resolve + compose a SAVED metric as of a given def-time (inspector preview). */
export async function resolveMetricSql(
  connectionId: string,
  name: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
): Promise<{ sql: string | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.metric_sql(${q(name)}, ${jb(params)}, ${defArg(defAsOf)}) AS sql`,
  )
  if (!r.ok) return { sql: null, error: r.error }
  const sql = r.rows[0]?.sql
  return { sql: sql == null ? null : String(sql), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run a metric. defAsOf pins the definition (def-time); dataAsOf pins the
 * underlying rvbbit data (data-time). rvbbit.metric returns SETOF jsonb (one
 * object per result row); we expand each into a flat row + ordered column union.
 */
export async function runMetric(
  connectionId: string,
  name: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
  dataAsOf?: string | null,
  rowLimit = 5000,
): Promise<MetricRunResult> {
  const r = await run(
    connectionId,
    `SELECT m.obj
     FROM rvbbit.metric(${q(name)}, ${jb(params)}, ${defArg(defAsOf)}, ${dataArg(dataAsOf)}) AS m(obj)`,
    rowLimit,
  )
  if (!r.ok) return { columns: [], rows: [], error: r.error }
  const rows = r.rows.map((row) => asObject(row.obj))
  const columns: string[] = []
  const seen = new Set<string>()
  for (const obj of rows) {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  return { columns, rows, error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────

/** Append a new version of a metric definition. Returns the new version. */
export async function defineMetric(
  connectionId: string,
  input: DefineMetricInput,
): Promise<{ version: number | null; error: string | null }> {
  const sql = `SELECT rvbbit.define_metric(
      ${q(input.name)},
      ${q(input.sql)},
      ${jb(input.params ?? {})},
      ${input.grain ? q(input.grain) : "NULL"},
      ${input.description ? q(input.description) : "NULL"},
      ${input.owner ? q(input.owner) : "NULL"},
      ${jb(input.labels ?? {})}
    ) AS version`
  const r = await run(connectionId, sql)
  if (!r.ok) return { version: null, error: r.error }
  return { version: num(r.rows[0]?.version), error: null }
}

/** Remove every version of a metric (Creator delete). */
export async function deleteMetric(
  connectionId: string,
  name: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `DELETE FROM rvbbit.metric_defs WHERE name = ${q(name)}`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

// ─────────────────────────────────────────────────────────────────────────
// Param map helpers (the KV editor works in string-valued maps)
// ─────────────────────────────────────────────────────────────────────────

export type ParamRow = { key: string; value: string }

export function paramsToRows(params: Record<string, unknown>): ParamRow[] {
  return Object.entries(params ?? {}).map(([key, value]) => ({
    key,
    value: value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value),
  }))
}

export function rowsToParams(rows: ParamRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { key, value } of rows) {
    const k = key.trim()
    if (!k) continue
    out[k] = value
  }
  return out
}
