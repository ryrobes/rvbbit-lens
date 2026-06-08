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
  /** When non-null the metric is a KPI (has a threshold/assertion check). */
  checkSql: string | null
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
  checkSql: string | null
}

export interface DefineMetricInput {
  name: string
  sql: string
  params: Record<string, unknown>
  grain?: string | null
  description?: string | null
  owner?: string | null
  labels?: Record<string, unknown>
  /** Optional KPI check SQL — runs against the `metric` CTE, yields `ok`. */
  check?: string | null
}

/** A KPI verdict (rvbbit.check_metric / preview_check_sql jsonb). Carries at
 *  least `ok` + `status`; the rest (value/target/...) is whatever the check
 *  yielded. `ok === null` means unknown (e.g. NULL over missing data) — never
 *  "pass". */
export interface MetricVerdict {
  ok: boolean | null
  status: string
  value?: unknown
  target?: unknown
  [k: string]: unknown
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
    `SELECT name, version, grain, description, owner, params, labels, sql, check_sql,
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
      checkSql: str(row.check_sql),
    })),
  }
}

export async function fetchMetricVersions(
  connectionId: string,
  name: string,
): Promise<{ versions: MetricVersion[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT version, sql, params, grain, description, owner, check_sql,
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
      checkSql: str(row.check_sql),
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
      ${jb(input.labels ?? {})},
      ${input.check && input.check.trim() ? q(input.check) : "NULL"}
    ) AS version`
  const r = await run(connectionId, sql)
  if (!r.ok) return { version: null, error: r.error }
  return { version: num(r.rows[0]?.version), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// KPI checks (verdicts)
// ─────────────────────────────────────────────────────────────────────────

function asVerdict(v: unknown): MetricVerdict | null {
  const obj = v == null ? null : typeof v === "string" ? (() => { try { return JSON.parse(v) } catch { return null } })() : v
  if (obj == null || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>
  return {
    ...o,
    ok: o.ok == null ? null : o.ok === true || o.ok === "true" || o.ok === "t",
    status: o.status == null ? (o.ok ? "pass" : "fail") : String(o.status),
  }
}

/** Evaluate a SAVED metric's KPI check. Returns null when it is not a KPI. */
export async function checkMetric(
  connectionId: string,
  name: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
  dataAsOf?: string | null,
): Promise<{ verdict: MetricVerdict | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.check_metric(${q(name)}, ${jb(params)}, ${defArg(defAsOf)}, ${dataArg(dataAsOf)}) AS verdict`,
  )
  if (!r.ok) return { verdict: null, error: r.error }
  return { verdict: asVerdict(r.rows[0]?.verdict), error: null }
}

/** Preview a DRAFT check (Creator) against draft metric + check bodies. */
export async function previewCheckSql(
  connectionId: string,
  metricSql: string,
  checkSql: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
): Promise<{ verdict: MetricVerdict | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.preview_check_sql(${q(metricSql)}, ${q(checkSql)}, ${jb(params)}, ${defArg(defAsOf)}) AS verdict`,
  )
  if (!r.ok) return { verdict: null, error: r.error }
  return { verdict: asVerdict(r.rows[0]?.verdict), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Materialization (the durable observation log)
// ─────────────────────────────────────────────────────────────────────────

export interface MetricObservation {
  observationId: number
  metricVersion: number | null
  dataGeneration: number | null
  dataAsOf: number | null // epoch ms
  dataAsOfIso: string | null
  observedAt: number | null // epoch ms
  value: unknown // jsonb (array of row objects)
  verdict: MetricVerdict | null
  status: string | null
  trigger: string
}

/** The durable materialized series for a metric (newest data first). */
export async function fetchMetricHistory(
  connectionId: string,
  name: string,
  limit = 200,
): Promise<{ observations: MetricObservation[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT observation_id, metric_version, data_generation, value, verdict, status, trigger,
            extract(epoch FROM data_as_of) * 1000 AS data_ms,
            data_as_of::text AS data_iso,
            extract(epoch FROM observed_at) * 1000 AS obs_ms
     FROM rvbbit.metric_history(${q(name)}, ${Math.max(1, Math.min(limit, 2000))})`,
  )
  if (!r.ok) return { observations: [], error: r.error }
  return {
    error: null,
    observations: r.rows.map((row) => ({
      observationId: Number(row.observation_id),
      metricVersion: num(row.metric_version),
      dataGeneration: num(row.data_generation),
      dataAsOf: num(row.data_ms),
      dataAsOfIso: str(row.data_iso),
      observedAt: num(row.obs_ms),
      value: typeof row.value === "string" ? safeJson(row.value) : row.value,
      verdict: asVerdict(row.verdict),
      status: str(row.status),
      trigger: String(row.trigger ?? "manual"),
    })),
  }
}

/** Append a manual observation at the current axes. Returns the observation id. */
export async function materializeMetric(
  connectionId: string,
  name: string,
  params: Record<string, unknown>,
  defAsOf?: string | null,
  dataAsOf?: string | null,
): Promise<{ id: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.materialize_metric(${q(name)}, ${jb(params)}, ${defArg(defAsOf)}, ${dataArg(dataAsOf)}, NULL, 'manual') AS id`,
  )
  if (!r.ok) return { id: null, error: r.error }
  return { id: num(r.rows[0]?.id), error: null }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Pull a single headline number out of an observation (verdict.value first,
 *  else the first numeric field of the first result row) — for the trend line. */
export function observationHeadline(obs: MetricObservation): number | null {
  const v = obs.verdict?.value
  if (typeof v === "number") return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  const rows = Array.isArray(obs.value) ? (obs.value as Array<Record<string, unknown>>) : []
  const first = rows[0]
  if (first) {
    for (const k of Object.keys(first)) {
      const n = first[k]
      if (typeof n === "number") return n
      if (typeof n === "string" && n.trim() !== "" && Number.isFinite(Number(n))) return Number(n)
    }
  }
  return null
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
