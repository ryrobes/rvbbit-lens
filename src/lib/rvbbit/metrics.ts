"use client"

// Data layer for the Metrics / BI apps (Creator, Inspector, Catalog). All
// queries run through /api/db/query against the active (rvbbit) connection.
//
// A metric is a named, versioned SQL template stored in rvbbit.metric_defs
// (a PLAIN append-versioned table). Two independent temporal axes:
//   * DEF-TIME  — which definition version (created_at filter), p_def_as_of
//   * DATA-TIME — rvbbit AS OF over the underlying tables, p_data_as_of
// Backend surface: define_metric / metric_catalog / metric_versions /
// metric_sql / preview_metric_sql / metric_scalar / metric(SETOF jsonb).
// Tokens in a metric's SQL: {param} (safe literal), {param!} (raw),
// {metric:NAME} (subquery).

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
  category: string | null
  subcategory: string | null
}

export interface MetricDependencyFreshness {
  metric: string
  table: string
  freshnessColumn: string | null
  maxFreshness: string | null
  stale: boolean | null
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
            category, subcategory,
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
      category: str(row.category),
      subcategory: str(row.subcategory),
    })),
  }
}

export async function fetchMetricDependencyFreshness(
  connectionId: string,
  metrics?: string[],
): Promise<{ rows: MetricDependencyFreshness[]; error: string | null }> {
  const metricsArg =
    metrics && metrics.length
      ? `ARRAY[${metrics.map((m) => q(m)).join(",")}]::text[]`
      : "NULL::text[]"
  const r = await run(
    connectionId,
    `SELECT metric_name,
            table_schema || '.' || table_name AS dep_table,
            freshness_column,
            max_freshness::text AS max_freshness,
            stale
       FROM rvbbit.metric_dependency_freshness(${metricsArg}, interval '2 days')`,
  )
  if (!r.ok) return { rows: [], error: r.error }
  return {
    error: null,
    rows: r.rows.map((row) => ({
      metric: String(row.metric_name),
      table: String(row.dep_table),
      freshnessColumn: str(row.freshness_column),
      maxFreshness: str(row.max_freshness),
      stale: row.stale == null ? null : Boolean(row.stale),
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
 * underlying rvbbit data (data-time). The Inspector uses rvbbit.metric's
 * lower-level rowset runner for preview/debugging; persisted observations use
 * rvbbit.metric_scalar.
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
  value: unknown // jsonb scalar payload; older observations may be arrays of row objects
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

/** Pull a single headline number out of a (value, verdict) pair: verdict.value
 *  first, then scalar observation value, then legacy row-array payloads. */
/** Generic row-count column names — used only as a last resort for the headline,
 *  so e.g. `{n, region, revenue}` surfaces `revenue`, not the `n` counter. */
const COUNTER_KEYS = new Set(["n", "count", "cnt", "rows", "num", "row_count", "total_count"])

function asNumber(x: unknown): number | null {
  if (typeof x === "number") return x
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x)
  return null
}

function headlineOf(value: unknown, verdict: MetricVerdict | null): number | null {
  const v = asNumber(verdict?.value)
  if (v != null) return v
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    const scalar = asNumber((value as { value?: unknown }).value)
    if (scalar != null) return scalar
  }
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
  const first = rows[0]
  if (first) {
    let counterFallback: number | null = null
    for (const k of Object.keys(first)) {
      const n = asNumber(first[k])
      if (n == null) continue
      if (!COUNTER_KEYS.has(k.toLowerCase())) return n // prefer a real measure
      if (counterFallback == null) counterFallback = n
    }
    if (counterFallback != null) return counterFallback
  }
  return null
}

/** The headline number of a materialized observation (for the trend line). */
export function observationHeadline(obs: MetricObservation): number | null {
  return headlineOf(obs.value, obs.verdict)
}

/** The headline number of a board cell. */
export function boardCellHeadline(cell: MetricBoardCell): number | null {
  return headlineOf(cell.value, cell.verdict)
}

/** One cell of the KPI board: the latest observation that landed in a
 *  (metric, data-time bucket). Mirrors rvbbit.metric_board(). */
export interface MetricBoardCell {
  metric: string
  /** Bucket start, epoch ms (the column key). */
  bucketMs: number
  /** Exact data-time of the observation behind this cell, epoch ms. */
  dataAsOf: number | null
  /** The definition-time this observation was recorded under, epoch ms. */
  defAsOf: number | null
  /** The params this observation was recorded with (for exact reproduction). */
  params: Record<string, unknown>
  dataGeneration: number | null
  metricVersion: number | null
  value: unknown
  verdict: MetricVerdict | null
  status: string | null
  trigger: string
}

// "raw" = no date_trunc rollup: every distinct materialization (per metric ×
// exact data-instant) becomes its own column.
export type BoardBucket = "hour" | "day" | "week" | "month" | "quarter" | "raw"

export function metricSeriesSql(
  name: string,
  opts: { days?: number; bucket?: BoardBucket; params?: Record<string, unknown>; domainPadPct?: number } = {},
): string {
  const days = Math.max(1, Math.min(opts.days ?? 90, 3650))
  const bucket = opts.bucket === "raw" ? "day" : (opts.bucket ?? "day")
  const padPct = Math.max(0, Math.min(opts.domainPadPct ?? 0.08, 1))
  return `WITH series AS (
  SELECT bucket,
       value,
       status,
       ok,
       target,
       metric_version,
       data_as_of,
       observed_at,
       trigger,
       stale_source_count,
       source_freshness
  FROM rvbbit.metric_series(
    ${q(name)},
    now() - make_interval(days => ${days}),
    now(),
    ${q(bucket)},
    ${jb(opts.params ?? {})}
  )
),
bounds AS (
  SELECT
    min(value) FILTER (WHERE value IS NOT NULL) AS min_value,
    max(value) FILTER (WHERE value IS NOT NULL) AS max_value
  FROM series
),
padded AS (
  SELECT
    s.*,
    CASE
      WHEN b.min_value IS NULL THEN NULL
      WHEN b.max_value = b.min_value THEN
        b.min_value - CASE WHEN b.min_value = 0 THEN 1.0 ELSE abs(b.min_value) * ${padPct} END
      ELSE b.min_value - abs(b.max_value - b.min_value) * ${padPct}
    END AS axis_floor,
    CASE
      WHEN b.max_value IS NULL THEN NULL
      WHEN b.max_value = b.min_value THEN
        b.max_value + CASE WHEN b.max_value = 0 THEN 1.0 ELSE abs(b.max_value) * ${padPct} END
      ELSE b.max_value + abs(b.max_value - b.min_value) * ${padPct}
    END AS axis_ceiling
  FROM series s
  CROSS JOIN bounds b
)
SELECT *
FROM padded
ORDER BY bucket;`
}

export function metricProvenanceSql(name: string): string {
  return `SELECT rvbbit.metric_provenance(${q(name)}) AS provenance;`
}

/** Fetch the (metric × data-time) board grid from the observation log. */
export async function fetchMetricBoard(
  connectionId: string,
  opts: { days?: number; bucket?: BoardBucket; metrics?: string[]; kpisOnly?: boolean } = {},
): Promise<{ cells: MetricBoardCell[]; error: string | null }> {
  const days = Math.max(1, Math.min(opts.days ?? 90, 3650))
  const bucket = opts.bucket ?? "day"
  const metricsArg =
    opts.metrics && opts.metrics.length
      ? `ARRAY[${opts.metrics.map((m) => q(m)).join(",")}]::text[]`
      : opts.kpisOnly
        ? // COALESCE to an empty array: array_agg over zero KPIs is NULL, which the
          // `metricsArg IS NULL OR …` guard reads as "no filter" → shows ALL metrics.
          // An empty array instead filters to nothing, the correct kpisOnly result.
          `COALESCE((SELECT array_agg(name ORDER BY name) FROM rvbbit.metric_catalog WHERE check_sql IS NOT NULL), '{}')::text[]`
      : "NULL::text[]"
  // Raw mode reads the observation log directly, keying each column by the
  // exact data-instant (no date_trunc). DISTINCT ON the instant still folds
  // a re-materialization of the SAME data-time to its latest value (Restate
  // mode surfaces those changes) — so columns are distinct materializations,
  // not duplicate same-instant rows. Mirrors rvbbit.metric_board's projection.
  const sql =
    bucket === "raw"
      ? `SELECT DISTINCT ON (o.metric_name, COALESCE(o.data_as_of, o.observed_at))
                o.metric_name                                              AS metric,
                extract(epoch FROM COALESCE(o.data_as_of, o.observed_at)) * 1000 AS bucket_ms,
                extract(epoch FROM COALESCE(o.data_as_of, o.observed_at)) * 1000 AS data_ms,
                extract(epoch FROM o.def_as_of) * 1000                    AS def_ms,
                o.params, o.data_generation, o.metric_version,
                o.value, o.verdict, o.status, o.trigger
           FROM rvbbit.metric_observations o
          WHERE COALESCE(o.data_as_of, o.observed_at) >= now() - make_interval(days => ${days})
            AND (${metricsArg} IS NULL OR o.metric_name = ANY(${metricsArg}))
          ORDER BY o.metric_name,
                   COALESCE(o.data_as_of, o.observed_at),
                   o.observed_at DESC`
      : `SELECT c->>'metric'                                           AS metric,
                extract(epoch FROM (c->>'bucket')::timestamptz) * 1000 AS bucket_ms,
                extract(epoch FROM (c->>'data_as_of')::timestamptz) * 1000 AS data_ms,
                extract(epoch FROM (c->>'def_as_of')::timestamptz) * 1000 AS def_ms,
                (c->'params')                                          AS params,
                (c->'data_generation')                                 AS data_generation,
                (c->'metric_version')                                  AS metric_version,
                (c->'value')                                           AS value,
                (c->'verdict')                                         AS verdict,
                (c->>'status')                                         AS status,
                (c->>'trigger')                                        AS trigger
         FROM rvbbit.metric_board(${metricsArg}, now() - interval '${days} days', now(), ${q(bucket)}) c`
  const r = await run(connectionId, sql)
  if (!r.ok) return { cells: [], error: r.error }
  return {
    error: null,
    cells: r.rows.map((row) => {
      const p = typeof row.params === "string" ? safeJson(row.params) : row.params
      return {
        metric: String(row.metric),
        bucketMs: num(row.bucket_ms) ?? 0,
        dataAsOf: num(row.data_ms),
        defAsOf: num(row.def_ms),
        params: (p && typeof p === "object" ? (p as Record<string, unknown>) : {}),
        dataGeneration: num(row.data_generation),
        metricVersion: num(row.metric_version),
        value: typeof row.value === "string" ? safeJson(row.value) : row.value,
        verdict: asVerdict(row.verdict),
        status: str(row.status),
        trigger: String(row.trigger ?? "manual"),
      }
    }),
  }
}

/** Live-recompute a single cell's headline + verdict at a given (def-time,
 *  data-time) — the basis for the board's Restatement and def-time-scrub modes.
 *  Restatement compares this against the stored observation; def-scrub replaces
 *  it. Two round-trips (metric + check); callers should batch/throttle. */
export async function recomputeCell(
  connectionId: string,
  name: string,
  params: Record<string, unknown>,
  defAsOfIso: string | null,
  dataAsOfIso: string | null,
): Promise<{ headline: number | null; verdict: MetricVerdict | null; error: string | null }> {
  const [res, chk] = await Promise.all([
    runMetric(connectionId, name, params, defAsOfIso, dataAsOfIso),
    checkMetric(connectionId, name, params, defAsOfIso, dataAsOfIso),
  ])
  return {
    headline: headlineOf(res.rows, chk.verdict),
    verdict: chk.verdict,
    error: res.error ?? chk.error,
  }
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

// ─────────────────────────────────────────────────────────────────────────
// Propose (agent-drafted metric → human-blessed) — mirrors cubes' proposeCube
// ─────────────────────────────────────────────────────────────────────────

export interface MetricProposeResult {
  name: string
  sql: string
  grain: string | null
  description: string | null
  params: Record<string, unknown>
  checkSql: string | null
  source: string | null
  confidence: number | null
  candidateSources: string[]
  error: string | null
}

function arrLit(values?: string[] | null): string {
  if (!values || values.length === 0) return "NULL::text[]"
  return `ARRAY[${values.map((v) => q(v)).join(",")}]::text[]`
}
function asArr(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p : []
    } catch {
      return []
    }
  }
  return []
}

/** Draft a metric from a subject (prefers cubes as the source). Returns a draft only — the
 *  human reviews + saves via defineMetric. */
export async function proposeMetric(
  connectionId: string,
  subject: string,
  seedSources?: string[] | null,
  schema?: string | null,
): Promise<{ draft: MetricProposeResult | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.propose_metric(${q(subject)}, ${arrLit(seedSources)}, ${schema ? q(schema) : "NULL"}) AS d`,
  )
  if (!r.ok) return { draft: null, error: r.error }
  const d = asObject(r.rows[0]?.d)
  if (Object.keys(d).length === 0) return { draft: null, error: "no draft" }
  return {
    error: null,
    draft: {
      name: String(d.name ?? ""),
      sql: String(d.sql ?? ""),
      grain: str(d.grain),
      description: str(d.description),
      params: asObject(d.params),
      checkSql: str(d.check_sql),
      source: str(d.source),
      confidence: num(d.confidence),
      candidateSources: asArr(d.candidate_sources).map((s) => String(s)),
      error: str(d.error),
    },
  }
}
