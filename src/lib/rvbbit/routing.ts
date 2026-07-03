"use client"

/**
 * Client-side model for rvbbit's adaptive query router — the system that
 * picks one of the configured execution paths for a SELECT against an
 * rvbbit-enabled table, based on the query's shape and a trained profile.
 *
 * Surfaces (see rvbbit docs/RVBBIT_ROUTING_UI.md):
 *   - route_decisions / route_executions — online telemetry (paths taken)
 *   - route_observations                 — forced benchmark timings (training input)
 *   - route_profiles / route_profile_entries / route_profile_points — the trained model
 *   - route_*_summary views              — pre-rolled aggregates
 *   - route_explain(sql)                 — explain a route without running the query
 */

// ── Engines ─────────────────────────────────────────────────────────

export type EngineId =
  | "rvbbit_native"
  | "duck_vector"
  | "duck_vortex"
  | "duck_hive"
  | "datafusion_vector"
  | "datafusion_vortex"
  | "datafusion_hive"
  | "gpu_gqe"
  | "pg_rowstore"

export interface EngineMeta {
  id: EngineId
  label: string
  color: string
  blurb: string
}

/** The candidate engines, in router-display order. */
export const ENGINES: EngineMeta[] = [
  {
    id: "rvbbit_native",
    label: "native",
    color: "var(--viz-engine-native)",
    blurb: "PostgreSQL executor over rvbbit native rewrites & custom scans",
  },
  {
    id: "duck_vector",
    label: "duck",
    color: "var(--viz-engine-duck-vector)",
    blurb: "DuckDB over authoritative rvbbit parquet row groups",
  },
  {
    id: "duck_vortex",
    label: "duck vortex",
    color: "var(--viz-engine-duck-vortex)",
    blurb: "DuckDB over the Vortex columnar layout",
  },
  {
    id: "duck_hive",
    label: "duck hive",
    color: "var(--viz-engine-duck-hive)",
    blurb: "DuckDB over hive-partitioned parquet variants",
  },
  {
    id: "datafusion_vector",
    label: "datafusion",
    color: "var(--viz-engine-datafusion-vector)",
    blurb: "DataFusion over authoritative rvbbit parquet row groups",
  },
  {
    id: "datafusion_vortex",
    label: "datafusion vortex",
    color: "var(--viz-engine-datafusion-vortex)",
    blurb: "DataFusion over the Vortex columnar layout",
  },
  {
    id: "datafusion_hive",
    label: "datafusion hive",
    color: "var(--viz-engine-datafusion-hive)",
    blurb: "DataFusion over hive-partitioned parquet variants",
  },
  {
    id: "gpu_gqe",
    label: "gpu gqe",
    color: "var(--viz-engine-gpu-gqe)",
    blurb: "GPU/GQE over authoritative rvbbit parquet row groups",
  },
  {
    id: "pg_rowstore",
    label: "pg rowstore",
    color: "var(--viz-engine-pg-rowstore)",
    blurb: "PostgreSQL rowstore over a retained shadow heap",
  },
]

export function engineMeta(id: string): EngineMeta {
  // Virtual "native·<path>" ids split the native family by the physical storage
  // actually read (heap/parquet/vortex/mixed) for the sankey + log chips. Same
  // native colour, tinted by path: heap dimmed (unaccelerated), vortex brighter.
  if (id.startsWith(NATIVE_PATH_PREFIX)) {
    const path = id.slice(NATIVE_PATH_PREFIX.length)
    const native = ENGINES.find((e) => e.id === "rvbbit_native")
    const base = native?.color ?? "var(--viz-engine-native)"
    return {
      id: id as EngineId,
      label: `native·${path}`,
      color:
        path === "heap"
          ? `color-mix(in oklch, ${base} 50%, var(--chrome-border))`
          : path === "vortex"
            ? `color-mix(in oklch, ${base} 75%, var(--foreground))`
            : base,
      blurb: native?.blurb ?? "",
    }
  }
  return (
    ENGINES.find((e) => e.id === id) ?? {
      id: id as EngineId,
      label: id || "unknown",
      color: "var(--chrome-text)",
      blurb: "",
    }
  )
}

const NATIVE_PATH_PREFIX = "native::"
const PHYS_PATH_ORDER = ["heap", "parquet", "vortex", "mixed", "hive", "mem"]

/** The native engine family (heap SeqScan, parquet/vortex custom scan) all log
 *  candidate "rvbbit_native" / "rvbbit_native_vortex"; physical_path tells them
 *  apart. Non-native engines' storage is implied by the engine itself. */
function isNativeFamily(candidate: string): boolean {
  return candidate === "rvbbit_native" || candidate === "rvbbit_native_vortex"
}

/** Sankey/chip target id: split the native family into native·heap/parquet/vortex
 *  by physical_path; everything else stays its candidate id. */
export function engineFlowTarget(candidate: string, physicalPath: string): string {
  return isNativeFamily(candidate) && physicalPath
    ? `${NATIVE_PATH_PREFIX}${physicalPath}`
    : candidate
}

/** Stable ordering for sankey target nodes: by base-engine order, native
 *  sub-paths grouped together in physical-path order. */
export function engineFlowOrder(id: string): [number, number] {
  if (id.startsWith(NATIVE_PATH_PREFIX)) {
    const nativeIdx = ENGINES.findIndex((e) => e.id === "rvbbit_native")
    const p = PHYS_PATH_ORDER.indexOf(id.slice(NATIVE_PATH_PREFIX.length))
    return [nativeIdx < 0 ? 999 : nativeIdx, p < 0 ? 99 : p + 1]
  }
  const idx = ENGINES.findIndex((e) => e.id === id)
  return [idx < 0 ? 999 : idx, 0]
}

/**
 * Older candidate aliases (`duck`, `datafusion`, `native`, `df_hive`,
 * `df_vortex`, `pg_heap`) may surface in legacy profile JSON or scripts.
 * Normalize to the canonical engine ids before storing in UI state.
 */
const CANDIDATE_ALIASES: Record<string, EngineId> = {
  duck: "duck_vector",
  datafusion: "datafusion_vector",
  "datafusion-vortex": "datafusion_vortex",
  df_vortex: "datafusion_vortex",
  vortex: "datafusion_vortex",
  gqe: "gpu_gqe",
  "gpu-gqe": "gpu_gqe",
  rvbbit_gpu_gqe: "gpu_gqe",
  gpu_gqe_forced: "gpu_gqe",
  rvbbit_gpu_gqe_forced: "gpu_gqe",
  native: "rvbbit_native",
  df_hive: "datafusion_hive",
  pg_heap: "pg_rowstore",
}

export function normalizeCandidate(s: string | null | undefined): string {
  if (!s) return ""
  return CANDIDATE_ALIASES[s] ?? s
}

/** A per-engine timing map. `null` = not measured / unsupported / failed. */
export type EngineMs = Record<EngineId, number | null>

function engineMsFromRow(r: Record<string, unknown>): EngineMs {
  return {
    rvbbit_native: numOrNull(r.native_ms),
    duck_vector: numOrNull(r.duck_ms),
    duck_vortex: numOrNull(r.duck_vortex_ms),
    duck_hive: numOrNull(r.duck_hive_ms),
    datafusion_vector: numOrNull(r.datafusion_ms),
    datafusion_vortex: numOrNull(r.datafusion_vortex_ms),
    datafusion_hive: numOrNull(r.datafusion_hive_ms),
    gpu_gqe: numOrNull(r.gpu_gqe_ms),
    pg_rowstore: numOrNull(r.pg_ms),
  }
}

function engineMediansFromRow(r: Record<string, unknown>): EngineMs {
  return {
    rvbbit_native: numOrNull(r.native_median_ms),
    duck_vector: numOrNull(r.duck_median_ms),
    duck_vortex: numOrNull(r.duck_vortex_median_ms),
    duck_hive: numOrNull(r.duck_hive_median_ms),
    datafusion_vector: numOrNull(r.datafusion_median_ms),
    datafusion_vortex: numOrNull(r.datafusion_vortex_median_ms),
    datafusion_hive: numOrNull(r.datafusion_hive_median_ms),
    gpu_gqe: numOrNull(r.gpu_gqe_median_ms),
    pg_rowstore: numOrNull(r.pg_median_ms),
  }
}

function engineObservationsFromRow(r: Record<string, unknown>): Record<EngineId, number | null> {
  return {
    rvbbit_native: numOrNull(r.native_observations),
    duck_vector: numOrNull(r.duck_observations),
    duck_vortex: numOrNull(r.duck_vortex_observations),
    duck_hive: numOrNull(r.duck_hive_observations),
    datafusion_vector: numOrNull(r.datafusion_observations),
    datafusion_vortex: numOrNull(r.datafusion_vortex_observations),
    datafusion_hive: numOrNull(r.datafusion_hive_observations),
    gpu_gqe: numOrNull(r.gpu_gqe_observations),
    pg_rowstore: numOrNull(r.pg_observations),
  }
}

// ── Row types ───────────────────────────────────────────────────────

export interface RouteExecution {
  executedAt: number
  candidate: string
  /** Physical storage actually read (heap|parquet|vortex|hive|mem|mixed) — splits
   *  the native family that `candidate` collapses to "native". "" if unreported. */
  physicalPath: string
  routeSource: string
  elapsedMs: number
  rowsReturned: number
  cacheHit: boolean
  status: string
  shapeFamily: string
  reason: string
}

export interface DecisionSummaryRow {
  candidate: string
  /** Physical storage read (heap|parquet|vortex|…); splits native in the sankey. */
  physicalPath: string
  routeSource: string
  decisions: number
  cacheHits: number
  rewritten: number
}

export interface EngineRuntimeRow {
  candidate: string
  runs: number
  medianMs: number
  p95Ms: number
}

export interface LogStatus {
  enabled: boolean
  started: boolean
  scope: string
  backendPid: number
  queueLen: number
  queueCapacity: number | null
  enqueued: number | null
  dropped: number | null
  written: number | null
  writeErrors: number | null
  connectErrors: number | null
}

export interface RouteProfile {
  name: string
  active: boolean
  createdAt: string | null
  updatedAt: string | null
  version: string | null
  suite: string | null
  generatedAt: string | null
  minObservations: number | null
  minGainPct: number | null
  entryCount: number | null
  observationCount: number | null
  pointCount: number | null
  importedBy: string | null
}

export interface ProfileEntry {
  shapeKey: string
  choice: string
  confidence: number
  observations: number
  engineTimes: EngineMs
  reason: string
}

export interface ShapeSummaryRow {
  shapeFamily: string
  observations: number
  bestCandidate: string
  bestMedianMs: number | null
  observedGain: number | null
  needsExploration: boolean
  medianByEngine: EngineMs
  observationsByEngine: Record<EngineId, number | null>
}

export interface ProfilePoint {
  shapeFamily: string
  tableRows: number
  engineTimes: EngineMs
}

export interface ObservationGroup {
  source: string
  candidate: string
  count: number
  avgMs: number
}

export interface ColumnarTable {
  schema: string
  name: string
  estRows: number
}

export interface RouteExplainCandidate {
  name: string
  route: string
  reason: string
  selected: boolean
  available: boolean
}

export interface RouteExplainTable {
  table: string
  schema: string
  rows: number
  bytes: number
  rowGroups: number
  deleteCount: number
}

export interface RouteExplain {
  route: string
  reason: string
  routeSource: string
  chosenCandidate: string
  /** Physical storage actually read: heap | parquet | vortex | hive | mem | mixed.
   *  Splits the native family (heap SeqScan vs parquet/vortex custom scan) that
   *  the engine label alone collapses to "native". "" when not reported. */
  physicalPath: string
  confidence: number | null
  safeSelect: boolean
  candidates: RouteExplainCandidate[]
  features: Record<string, unknown>
  tables: RouteExplainTable[]
  postgresExplain: string
}

// ── Query plumbing ──────────────────────────────────────────────────

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

interface QueryOpts {
  rowLimit?: number
  readOnly?: boolean
  statementTimeout?: number
  poolLane?: "interactive" | "meta"
}

async function runQuery(connectionId: string, sql: string, opts: QueryOpts = {}): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql,
        rowLimit: opts.rowLimit ?? 5000,
        ...(opts.readOnly ? { readOnly: true } : {}),
        ...(opts.statementTimeout != null ? { statementTimeout: opts.statementTimeout } : {}),
        ...(opts.poolLane ? { poolLane: opts.poolLane } : {}),
      }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function strOrNull(v: unknown): string | null {
  return v == null || v === "" ? null : String(v)
}
function bool(v: unknown): boolean {
  return v === true || v === "t"
}
function compactCount(v: number): string {
  return Number.isFinite(v) ? new Intl.NumberFormat("en", { notation: "compact" }).format(v) : "0"
}
function epoch(v: unknown): number {
  return v ? new Date(String(v)).getTime() : 0
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

const ACTIVE_PROFILE_SUBQUERY =
  "(SELECT name FROM rvbbit.route_profiles ORDER BY active DESC, updated_at DESC LIMIT 1)"

// ── Time window ─────────────────────────────────────────────────────
//
// The Flow tab is time-bounded, not row-capped: every chart aggregates
// the raw route_decisions / route_executions tables server-side within
// the selected window, so counts and percentiles stay accurate no matter
// how much telemetry has accrued.

export const ROUTE_WINDOW_OPTIONS = [
  { hours: 1, label: "1h" },
  { hours: 3, label: "3h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
] as const

/** `col >= now() - interval 'N hours'`, with N clamped to a sane range. */
function windowClause(col: string, hours: number): string {
  const h = Math.max(1, Math.min(720, Math.floor(hours)))
  return `${col} >= now() - interval '${h} hours'`
}

// ── Live telemetry ──────────────────────────────────────────────────

export async function fetchRouteExecutions(
  connectionId: string,
  windowHours: number,
): Promise<{ rows: RouteExecution[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT executed_at, candidate, route_doc->>'physical_path' AS physical_path, " +
      "route_source, elapsed_ms, rows_returned, " +
      "cache_hit, status, shape_family, reason FROM rvbbit.route_executions " +
      "WHERE " + windowClause("executed_at", windowHours) +
      " ORDER BY executed_at DESC LIMIT 500",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      executedAt: epoch(r.executed_at),
      candidate: normalizeCandidate(String(r.candidate ?? "")),
      physicalPath: String(r.physical_path ?? ""),
      routeSource: String(r.route_source ?? ""),
      elapsedMs: num(r.elapsed_ms),
      rowsReturned: num(r.rows_returned),
      cacheHit: bool(r.cache_hit),
      status: String(r.status ?? ""),
      shapeFamily: String(r.shape_family ?? ""),
      reason: String(r.reason ?? ""),
    })),
  }
}

/** Per-(candidate, source) decision counts within the window. Drives the
 *  flow diagram and each engine card's decision/cache totals. */
export async function fetchDecisionSummary(
  connectionId: string,
  windowHours: number,
): Promise<DecisionSummaryRow[]> {
  const res = await runQuery(
    connectionId,
    "SELECT candidate, route_doc->>'physical_path' AS physical_path, route_source, " +
      "count(*) AS decisions, " +
      "count(*) FILTER (WHERE cache_hit) AS cache_hits, " +
      "count(*) FILTER (WHERE rewritten) AS rewritten " +
      "FROM rvbbit.route_decisions WHERE " + windowClause("decided_at", windowHours) +
      " GROUP BY candidate, route_doc->>'physical_path', route_source",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    candidate: normalizeCandidate(String(r.candidate ?? "")),
    physicalPath: String(r.physical_path ?? ""),
    routeSource: String(r.route_source ?? "unknown"),
    decisions: num(r.decisions),
    cacheHits: num(r.cache_hits),
    rewritten: num(r.rewritten),
  }))
}

/** Per-engine execution count + latency percentiles within the window —
 *  computed server-side so they aren't distorted by any row cap. */
export async function fetchEngineRuntime(
  connectionId: string,
  windowHours: number,
): Promise<EngineRuntimeRow[]> {
  const res = await runQuery(
    connectionId,
    "SELECT candidate, count(*) AS runs, " +
      "percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms) AS median_ms, " +
      "percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms) AS p95_ms " +
      "FROM rvbbit.route_executions WHERE " + windowClause("executed_at", windowHours) +
      " GROUP BY candidate",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    candidate: normalizeCandidate(String(r.candidate ?? "")),
    runs: num(r.runs),
    medianMs: num(r.median_ms),
    p95Ms: num(r.p95_ms),
  }))
}

export async function fetchLogStatus(connectionId: string): Promise<LogStatus | null> {
  const res = await runQuery(connectionId, "SELECT rvbbit.route_decision_log_status() AS s")
  if (!res.ok || res.rows.length === 0) return null
  const s = (res.rows[0].s ?? {}) as Record<string, unknown>
  return {
    enabled: bool(s.enabled),
    started: bool(s.started),
    scope: String(s.scope ?? "backend"),
    backendPid: num(s.backend_pid),
    queueLen: num(s.queue_len),
    queueCapacity: numOrNull(s.queue_capacity),
    enqueued: numOrNull(s.enqueued),
    dropped: numOrNull(s.dropped),
    written: numOrNull(s.written),
    writeErrors: numOrNull(s.write_errors),
    connectErrors: numOrNull(s.connect_errors),
  }
}

// ── Trained profile ─────────────────────────────────────────────────

export async function fetchRouteProfile(connectionId: string): Promise<RouteProfile | null> {
  const res = await runQuery(
    connectionId,
    "SELECT name, active, created_at, updated_at, " +
      "profile->>'version' AS version, profile->>'suite' AS suite, " +
      "profile->>'generated_at' AS generated_at, " +
      "profile->>'min_observations' AS min_observations, " +
      "profile->>'min_gain_pct' AS min_gain_pct, " +
      "profile->>'entry_count' AS entry_count, " +
      "profile->>'observation_count' AS observation_count, " +
      "profile->>'profile_point_count' AS point_count, " +
      "profile->>'imported_by' AS imported_by " +
      "FROM rvbbit.route_profiles ORDER BY active DESC, updated_at DESC LIMIT 1",
  )
  if (!res.ok || res.rows.length === 0) return null
  const r = res.rows[0]
  return {
    name: String(r.name ?? ""),
    active: bool(r.active),
    createdAt: r.created_at ? String(r.created_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
    version: r.version ? String(r.version) : null,
    suite: r.suite ? String(r.suite) : null,
    generatedAt: r.generated_at ? String(r.generated_at) : null,
    minObservations: numOrNull(r.min_observations),
    minGainPct: numOrNull(r.min_gain_pct),
    entryCount: numOrNull(r.entry_count),
    observationCount: numOrNull(r.observation_count),
    pointCount: numOrNull(r.point_count),
    importedBy: r.imported_by ? String(r.imported_by) : null,
  }
}

export async function fetchProfileEntries(connectionId: string): Promise<ProfileEntry[]> {
  const res = await runQuery(
    connectionId,
    "SELECT shape_key, choice, confidence, observations, native_ms, duck_ms, " +
      "duck_vortex_ms, duck_hive_ms, datafusion_ms, datafusion_vortex_ms, " +
      "datafusion_hive_ms, gpu_gqe_ms, pg_ms, reason " +
      "FROM rvbbit.route_profile_entries " +
      `WHERE profile_name = ${ACTIVE_PROFILE_SUBQUERY} ` +
      "ORDER BY confidence DESC NULLS LAST",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    shapeKey: String(r.shape_key ?? ""),
    choice: normalizeCandidate(String(r.choice ?? "")),
    confidence: num(r.confidence),
    observations: num(r.observations),
    engineTimes: engineMsFromRow(r),
    reason: String(r.reason ?? ""),
  }))
}

export async function fetchShapeSummary(connectionId: string): Promise<ShapeSummaryRow[]> {
  const res = await runQuery(
    connectionId,
    "SELECT shape_family, observations, best_candidate, best_median_ms, " +
      "native_median_ms, duck_median_ms, duck_vortex_median_ms, duck_hive_median_ms, " +
      "datafusion_median_ms, datafusion_vortex_median_ms, datafusion_hive_median_ms, " +
      "gpu_gqe_median_ms, pg_median_ms, " +
      "native_observations, duck_observations, duck_vortex_observations, " +
      "duck_hive_observations, " +
      "datafusion_observations, datafusion_vortex_observations, " +
      "datafusion_hive_observations, gpu_gqe_observations, pg_observations, " +
      "observed_gain, needs_exploration FROM rvbbit.route_shape_summary " +
      "ORDER BY observations DESC",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    shapeFamily: String(r.shape_family ?? ""),
    observations: num(r.observations),
    bestCandidate: normalizeCandidate(String(r.best_candidate ?? "")),
    bestMedianMs: numOrNull(r.best_median_ms),
    observedGain: numOrNull(r.observed_gain),
    needsExploration: bool(r.needs_exploration),
    medianByEngine: engineMediansFromRow(r),
    observationsByEngine: engineObservationsFromRow(r),
  }))
}

export async function fetchProfilePoints(connectionId: string): Promise<ProfilePoint[]> {
  const res = await runQuery(
    connectionId,
    "SELECT shape_family, table_rows, native_ms, duck_ms, duck_vortex_ms, duck_hive_ms, " +
      "datafusion_ms, datafusion_vortex_ms, datafusion_hive_ms, gpu_gqe_ms, pg_ms " +
      `FROM rvbbit.route_profile_points WHERE profile_name = ${ACTIVE_PROFILE_SUBQUERY}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    shapeFamily: String(r.shape_family ?? ""),
    tableRows: num(r.table_rows),
    engineTimes: engineMsFromRow(r),
  }))
}

export async function fetchObservationGroups(
  connectionId: string,
): Promise<ObservationGroup[]> {
  const res = await runQuery(
    connectionId,
    "SELECT source, candidate, count(*) AS n, avg(elapsed_ms) AS avg_ms " +
      "FROM rvbbit.route_observations GROUP BY source, candidate ORDER BY n DESC",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    source: String(r.source ?? ""),
    candidate: normalizeCandidate(String(r.candidate ?? "")),
    count: num(r.n),
    avgMs: num(r.avg_ms),
  }))
}

export async function fetchColumnarTables(connectionId: string): Promise<ColumnarTable[]> {
  const res = await runQuery(
    connectionId,
    "SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS est_rows " +
      "FROM rvbbit.tables t " +
      "JOIN pg_class c ON c.oid = t.table_oid " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE c.relkind IN ('r','p','m') " +
      "AND coalesce(t.acceleration_enabled, true) " +
      "ORDER BY n.nspname, c.relname",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    schema: String(r.schema ?? ""),
    name: String(r.name ?? ""),
    estRows: num(r.est_rows),
  }))
}

// ── Aggregate bundles (one per window data-load) ────────────────────

export interface FlowData {
  executions: RouteExecution[]
  decisionSummary: DecisionSummaryRow[]
  engineRuntime: EngineRuntimeRow[]
  logStatus: LogStatus | null
}

export interface ProfileData {
  profile: RouteProfile | null
  entries: ProfileEntry[]
  shapeSummary: ShapeSummaryRow[]
  points: ProfilePoint[]
  observations: ObservationGroup[]
}

// ── route_explain ───────────────────────────────────────────────────

/** Explain a query's route without executing it. Safe — plan only. */
export async function routeExplain(
  connectionId: string,
  sql: string,
): Promise<{ explain: RouteExplain | null; error?: string }> {
  const res = await runQuery(connectionId, `SELECT rvbbit.route_explain(${sqlStr(sql)}) AS r`)
  if (!res.ok) return { explain: null, error: res.error }
  if (res.rows.length === 0) return { explain: null, error: "route_explain returned nothing" }
  const r = (res.rows[0].r ?? {}) as Record<string, unknown>
  const cands = Array.isArray(r.candidates) ? (r.candidates as Record<string, unknown>[]) : []
  const tables = Array.isArray(r.rvbbit_tables)
    ? (r.rvbbit_tables as Record<string, unknown>[])
    : []
  return {
    explain: {
      route: String(r.route ?? ""),
      reason: String(r.reason ?? ""),
      routeSource: String(r.route_source ?? ""),
      chosenCandidate: normalizeCandidate(String(r.chosen_candidate ?? "")),
      physicalPath: String(r.physical_path ?? ""),
      confidence: numOrNull(r.confidence),
      safeSelect: bool(r.safe_select),
      candidates: cands.map((c) => ({
        name: normalizeCandidate(String(c.name ?? "")),
        route: String(c.route ?? ""),
        reason: String(c.reason ?? ""),
        selected: bool(c.selected),
        available: bool(c.available),
      })),
      features: (r.features as Record<string, unknown>) ?? {},
      tables: tables.map((t) => ({
        table: String(t.table ?? ""),
        schema: String(t.schema ?? ""),
        rows: num(t.rows),
        bytes: num(t.bytes),
        rowGroups: num(t.row_groups),
        deleteCount: num(t.delete_count),
      })),
      postgresExplain: String(r.postgres_explain ?? ""),
    },
  }
}

// ── Shape-string helpers ────────────────────────────────────────────

/** Split a `k=v|k=v|…` shape string into tokens. */
export function parseShapeTokens(shape: string): { k: string; v: string }[] {
  if (!shape) return []
  return shape.split("|").map((t) => {
    const i = t.indexOf("=")
    return i < 0 ? { k: t, v: "" } : { k: t.slice(0, i), v: t.slice(i + 1) }
  })
}

const BORING_SHAPE_VALUES = new Set(["<=0", "0", "none", "", "unknown"])

/**
 * The non-default tokens of a shape — what actually distinguishes it.
 * Drops empty/zero buckets and opaque expression-signature hashes.
 */
export function shapeHighlights(shape: string): { k: string; v: string }[] {
  return parseShapeTokens(shape).filter(
    (t) => !BORING_SHAPE_VALUES.has(t.v) && !t.k.endsWith("_sig"),
  )
}

/** Human-friendly single token, e.g. `tables ≤2`. */
export function prettyToken(k: string, v: string): string {
  return `${k} ${v.replace("<=", "≤")}`
}

/** Pull the "Nx faster" multiplier out of a route reason, if present. */
export function routeSpeedup(reason: string | null | undefined): number | null {
  if (!reason) return null
  const m = reason.match(/([\d.]+)x faster/)
  return m ? Number(m[1]) : null
}

// ── Accelerator freshness (the cockpit) ─────────────────────────────
//
// One lane per accelerated rvbbit table, fusing the freshness rollup
// (rvbbit.accel_freshness) with the effective policy (accel_policy_effective).
// Staleness is correctness-safe (a dirty table just falls back to a slow heap
// scan), so this is a value-vs-cost view, not a coherence one.

export type AccelStrategy = "manual" | "scheduled" | "target" | "demand" | "continuous"
export const ACCEL_STRATEGIES: AccelStrategy[] = [
  "manual",
  "scheduled",
  "target",
  "demand",
  "continuous",
]

export interface AccelFreshnessRow {
  tableName: string
  schema: string
  dirty: boolean
  authoritative: boolean
  opRunning: boolean
  lance: boolean
  secondsDirty: number | null
  secondsSinceRefresh: number | null
  lastRefreshAt: number
  parquetRows: number
  rowGroups: number
  tombstones: number
  driftRows: number
  driftRatio: number | null
  heapSeqScans: number
  lastRebuildMs: number | null
  lastRebuildRows: number | null
  lastOperation: string | null
  lastOperationStatus: string | null
  lastOperationAt: number | null
  lastOperationError: string | null
  lastOperationSwap: string | null
  lastFinalLockAttempts: number | null
  lastQueuedOrphanFiles: number | null
  lastCatchupRows: number | null
  lastRemappedTombstones: number | null
  lastRowsWritten: number | null
  // policy
  strategy: AccelStrategy
  targetSecs: number | null
  minIntervalSecs: number
  maxRowGroupsBeforeRebuild: number | null
  maxTombstonesBeforeRebuild: number | null
  explicit: boolean
  active: boolean
  deniedEngines: string[]
  deniedLayouts: string[]
}

// Engines + layouts that can be toggled per table. native/pg_rowstore are the
// correctness floor and are intentionally absent (never deniable).
export const TOGGLE_ENGINES = ["duck", "datafusion"] as const
export const TOGGLE_LAYOUTS = ["vortex", "hive"] as const

function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (v == null) return []
  const s = String(v).trim()
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(",").map((x) => x.replace(/^"|"$/g, "").trim()).filter(Boolean)
  }
  return s ? [s] : []
}

export interface AccelTickPlanRow {
  tableName: string
  action: string // delta | full | skip
  reason: string
  status: string // planned | deferred | skip
  driftRows: number
  driftRatio: number | null
  secondsDirty: number | null
}

const ACCEL_FRESHNESS_SQL =
  "SELECT f.table_name, n.nspname AS schema, f.shadow_heap_dirty, f.parquet_authoritative, f.op_running, " +
  "f.lance_accelerated, f.seconds_dirty, f.seconds_since_refresh, f.last_refresh_at, " +
  "f.parquet_rows, f.row_groups, f.tombstones, f.drift_rows, f.drift_ratio, f.heap_seq_scans, " +
  "f.last_rebuild_ms, f.last_rebuild_rows, e.strategy, e.freshness_target_secs, " +
  "e.min_interval_secs, e.max_row_groups_before_rebuild, e.max_tombstones_before_rebuild, " +
  "e.explicit, e.active, e.denied_engines, e.denied_layouts, " +
  "op.operation AS last_operation, op.status AS last_operation_status, op.started_at AS last_operation_at, " +
  "op.error AS last_operation_error, op.rows_written AS last_rows_written, " +
  "op.settings->>'metadata_swap' AS last_operation_swap, " +
  "(op.settings->>'final_lock_attempts')::bigint AS last_final_lock_attempts, " +
  "(op.settings->>'queued_orphan_files')::bigint AS last_queued_orphan_files, " +
  "(op.settings->>'catchup_rows')::bigint AS last_catchup_rows, " +
  "(op.settings->>'remapped_tombstones')::bigint AS last_remapped_tombstones " +
  "FROM rvbbit.accel_freshness f " +
  "JOIN rvbbit.accel_policy_effective e ON e.table_oid = f.table_oid " +
  "LEFT JOIN pg_class c ON c.oid = f.table_oid " +
  "LEFT JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "LEFT JOIN LATERAL ( " +
  "SELECT o.operation, o.status, o.started_at, o.error, o.rows_written, o.settings " +
  "FROM rvbbit.acceleration_operations o " +
  "WHERE o.table_oid = f.table_oid " +
  "ORDER BY o.started_at DESC, o.id DESC LIMIT 1 " +
  ") op ON true " +
  "ORDER BY n.nspname, (f.drift_rows * (1 + f.heap_seq_scans)) DESC, f.table_name"

export async function fetchAccelFreshness(
  connectionId: string,
): Promise<{ rows: AccelFreshnessRow[]; error?: string }> {
  const res = await runQuery(connectionId, ACCEL_FRESHNESS_SQL)
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      tableName: String(r.table_name ?? ""),
      schema: String(r.schema ?? ""),
      dirty: bool(r.shadow_heap_dirty),
      authoritative: bool(r.parquet_authoritative),
      opRunning: bool(r.op_running),
      lance: bool(r.lance_accelerated),
      secondsDirty: numOrNull(r.seconds_dirty),
      secondsSinceRefresh: numOrNull(r.seconds_since_refresh),
      lastRefreshAt: epoch(r.last_refresh_at),
      parquetRows: num(r.parquet_rows),
      rowGroups: num(r.row_groups),
      tombstones: num(r.tombstones),
      driftRows: num(r.drift_rows),
      driftRatio: numOrNull(r.drift_ratio),
      heapSeqScans: num(r.heap_seq_scans),
      lastRebuildMs: numOrNull(r.last_rebuild_ms),
      lastRebuildRows: numOrNull(r.last_rebuild_rows),
      lastOperation: strOrNull(r.last_operation),
      lastOperationStatus: strOrNull(r.last_operation_status),
      lastOperationAt: r.last_operation_at ? epoch(r.last_operation_at) : null,
      lastOperationError: strOrNull(r.last_operation_error),
      lastOperationSwap: strOrNull(r.last_operation_swap),
      lastFinalLockAttempts: numOrNull(r.last_final_lock_attempts),
      lastQueuedOrphanFiles: numOrNull(r.last_queued_orphan_files),
      lastCatchupRows: numOrNull(r.last_catchup_rows),
      lastRemappedTombstones: numOrNull(r.last_remapped_tombstones),
      lastRowsWritten: numOrNull(r.last_rows_written),
      strategy: (String(r.strategy ?? "manual") as AccelStrategy) ?? "manual",
      targetSecs: numOrNull(r.freshness_target_secs),
      minIntervalSecs: num(r.min_interval_secs),
      maxRowGroupsBeforeRebuild: numOrNull(r.max_row_groups_before_rebuild),
      maxTombstonesBeforeRebuild: numOrNull(r.max_tombstones_before_rebuild),
      explicit: bool(r.explicit),
      active: bool(r.active),
      deniedEngines: pgArray(r.denied_engines),
      deniedLayouts: pgArray(r.denied_layouts),
    })),
  }
}

/** Dry-run plan = the "projected consequence" of a tick (no execution). */
export async function fetchAccelTickPlan(
  connectionId: string,
  budget: number | null,
): Promise<{ rows: AccelTickPlanRow[]; error?: string }> {
  const b = budget == null ? "NULL" : String(Math.max(0, Math.floor(budget)))
  const res = await runQuery(
    connectionId,
    "SELECT table_name, action, reason, status, drift_rows, drift_ratio, seconds_dirty " +
      `FROM rvbbit.accel_tick(${b}, true)`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      tableName: String(r.table_name ?? ""),
      action: String(r.action ?? ""),
      reason: String(r.reason ?? ""),
      status: String(r.status ?? ""),
      driftRows: num(r.drift_rows),
      driftRatio: numOrNull(r.drift_ratio),
      secondsDirty: numOrNull(r.seconds_dirty),
    })),
  }
}

/** Run an accelerator mutation; returns ok/err for a toast. */
export async function execAccel(
  connectionId: string,
  sql: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await runQuery(connectionId, sql)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

const qIdent = (table: string) => `'${table.replace(/'/g, "''")}'::regclass`

export const accelRefreshSql = (table: string) =>
  `SELECT rvbbit.refresh_acceleration(${qIdent(table)}, true)`
export const accelRebuildSql = (table: string) =>
  `SELECT rvbbit.rebuild_acceleration(${qIdent(table)}, true)`
export const clearAccelPolicySql = (table: string) =>
  `SELECT rvbbit.clear_accel_policy(${qIdent(table)})`
export function setAccelPolicySql(
  table: string,
  strategy: AccelStrategy,
  targetSecs: number | null,
  maxRowGroupsBeforeRebuild: number | null = null,
  maxTombstonesBeforeRebuild: number | null = null,
  minIntervalSecs = 60,
): string {
  const t = targetSecs == null ? "NULL" : String(Math.max(1, Math.floor(targetSecs)))
  const minInterval = String(Math.max(0, Math.floor(minIntervalSecs)))
  const maxRgs =
    maxRowGroupsBeforeRebuild == null ? "NULL" : String(Math.max(1, Math.floor(maxRowGroupsBeforeRebuild)))
  const maxTombs =
    maxTombstonesBeforeRebuild == null ? "NULL" : String(Math.max(1, Math.floor(maxTombstonesBeforeRebuild)))
  return (
    `SELECT rvbbit.set_accel_policy(${qIdent(table)}, ` +
    `strategy => ${sqlStr(strategy)}, ` +
    `freshness_target_secs => ${t}, ` +
    `min_interval_secs => ${minInterval}, ` +
    `max_row_groups_before_rebuild => ${maxRgs}, ` +
    `max_tombstones_before_rebuild => ${maxTombs})`
  )
}
/** Run the executor for real (budgeted). */
export const runAccelTickSql = (budget: number) =>
  `SELECT count(*) FROM rvbbit.accel_tick(${Math.max(1, Math.floor(budget))}, false)`

/** Toggle one engine/layout on or off for a table (reduces routing pathways +
 *  stops the rebuilder materializing a denied layout). */
export const setTableEngineSql = (table: string, target: string, enabled: boolean) =>
  `SELECT rvbbit.set_table_engine(${qIdent(table)}, ${sqlStr(target)}, ${enabled ? "true" : "false"})`

export interface PolicyRecommendation {
  strategy: AccelStrategy
  targetSecs: number | null
  why: string
}

/**
 * Suggest a policy from the value signals. Hot + cheap-to-keep-fresh → a tight
 * freshness target; never-queried → leave manual; expensive (Lance) → relax.
 */
export function recommendPolicy(r: AccelFreshnessRow): PolicyRecommendation {
  if (r.heapSeqScans === 0 && !r.dirty) {
    return { strategy: "manual", targetSecs: null, why: "never queried on the slow path — not worth auto-refreshing" }
  }
  if (r.lance) {
    return { strategy: "target", targetSecs: 1800, why: "Lance is a full overwrite — keep fresh, but on a relaxed 30m target" }
  }
  const hot = r.heapSeqScans >= 5
  const cheapDelta = (r.driftRatio ?? 1) < 0.5
  if (hot && cheapDelta) {
    return { strategy: "target", targetSecs: 300, why: "queried on the slow path and cheap to minor-refresh — keep within ~5 min" }
  }
  if (hot) {
    return { strategy: "scheduled", targetSecs: null, why: "queried on the slow path — refresh whenever dirty" }
  }
  return { strategy: "demand", targetSecs: null, why: "low traffic — only refresh when it's actually being hit" }
}

// ── workload layout advisor ─────────────────────────────────────────

export type WorkloadLayoutKind = "cluster" | "hive"
export type WorkloadLayoutStatus = "candidate" | "accepted" | "rejected" | "retired"

export interface WorkloadLayoutCatalog {
  catalogPresent: boolean
  statusViewPresent: boolean
  advisorPresent: boolean
  buildHelperPresent: boolean
}

export interface WorkloadLayoutTable {
  tableName: string
  schema: string
  name: string
  parquetRows: number
  rowGroups: number
  heapSeqScans: number
  dirty: boolean
  opRunning: boolean
  recommendations: number
  accepted: number
  ready: number
}

export interface WorkloadRoleCounts {
  where: number
  groupBy: number
  orderBy: number
  countDistinct: number
}

export interface WorkloadLayoutRecommendation {
  tableName: string
  tableOid: string
  layoutKind: WorkloadLayoutKind
  columnName: string
  layout: string
  status: WorkloadLayoutStatus
  score: number
  observations: number
  weightedMs: number
  roleCounts: WorkloadRoleCounts
  sampleShapes: string[]
  layoutStatus: string | null
  layoutRows: number | null
  layoutFiles: number | null
  reason: string
  details: Record<string, unknown>
  recommendedAt: number
  updatedAt: number
}

export interface WorkloadAdvisorRun {
  table: string
  ok: boolean
  recommendations: number
  matchedShapes: number
  error?: string
}

export interface WorkloadLayoutBuildRun {
  table: string
  ok: boolean
  status: string
  acceptedLayouts: number | null
  readyLayouts: number | null
  layoutRows: number | null
  baseAction: string | null
  message: string
  error?: string
}

export interface AccelerationCandidate {
  tableName: string
  schema: string
  name: string
  rowEstimate: number
  sizeBytes: number
  seqScans: number
  seqRows: number
  idxScans: number
  writes: number
  inserts: number
  updates: number
  deletes: number
  modSinceAnalyze: number
  heapBlocksRead: number
  heapBlocksHit: number
  slowQueries: number
  queryCalls: number
  totalMs: number
  maxMeanMs: number | null
  querySamples: string[]
  mutationRatio: number
  readWriteRatio: number
  score: number
  recommendation: "strong" | "watch" | "low"
  writeProfile: string
  reason: string
  registered: boolean
  lastMaintenanceAt: number | null
}

export async function fetchWorkloadLayoutCatalog(
  connectionId: string,
): Promise<{ catalog: WorkloadLayoutCatalog | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT " +
      "to_regclass('rvbbit.workload_layout_recommendations') IS NOT NULL AS catalog_present, " +
      "to_regclass('rvbbit.workload_layout_recommendation_status') IS NOT NULL AS status_view_present, " +
      "EXISTS ( " +
      "  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
      "  WHERE n.nspname = 'rvbbit' AND p.proname = 'recommend_workload_layouts' " +
      ") AS advisor_present, " +
      "EXISTS ( " +
      "  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
      "  WHERE n.nspname = 'rvbbit' AND p.proname = 'build_accepted_workload_layouts' " +
      ") AS build_helper_present",
  )
  if (!res.ok) return { catalog: null, error: res.error }
  const r = res.rows[0] ?? {}
  return {
    catalog: {
      catalogPresent: bool(r.catalog_present),
      statusViewPresent: bool(r.status_view_present),
      advisorPresent: bool(r.advisor_present),
      buildHelperPresent: bool(r.build_helper_present),
    },
  }
}

function accelerationCandidateSql(includePgStatStatements: boolean): string {
  const matched = includePgStatStatements
    ? "pgss AS ( " +
      "SELECT queryid::text AS query_id, calls::bigint AS calls, " +
      "total_exec_time::double precision AS total_ms, mean_exec_time::double precision AS mean_ms, " +
      "rows::bigint AS rows_returned, query " +
      "FROM pg_stat_statements " +
      "WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) " +
      "AND query IS NOT NULL " +
      "AND query !~* '^\\s*(create|alter|drop|vacuum|analyze|explain)' " +
      "ORDER BY total_exec_time DESC LIMIT 250 " +
      "), matched AS ( " +
      "SELECT h.oid, " +
      "count(*) FILTER (WHERE p.mean_ms >= 50 OR p.total_ms >= 1000) AS slow_queries, " +
      "coalesce(sum(p.calls), 0)::bigint AS query_calls, " +
      "coalesce(sum(p.total_ms), 0)::double precision AS total_ms, " +
      "max(p.mean_ms)::double precision AS max_mean_ms, " +
      "(array_agg(left(regexp_replace(p.query, '\\s+', ' ', 'g'), 180) ORDER BY p.total_ms DESC))[1:3] AS query_samples " +
      "FROM heap_tables h " +
      "JOIN pgss p ON position(lower(h.name) in lower(p.query)) > 0 " +
      "  OR position(lower(h.table_name) in lower(p.query)) > 0 " +
      "GROUP BY h.oid " +
      ") "
    : "matched AS ( " +
      "SELECT oid, 0::bigint AS slow_queries, 0::bigint AS query_calls, " +
      "0::double precision AS total_ms, NULL::double precision AS max_mean_ms, " +
      "ARRAY[]::text[] AS query_samples FROM heap_tables " +
      ") "

  return (
    "WITH heap_tables AS ( " +
    "SELECT c.oid::int8 AS oid, c.oid::regclass::text AS table_name, n.nspname AS schema, c.relname AS name, " +
    "GREATEST(c.reltuples, 0)::bigint AS row_estimate, pg_total_relation_size(c.oid)::bigint AS size_bytes, " +
    "coalesce(s.seq_scan, 0)::bigint AS seq_scans, coalesce(s.seq_tup_read, 0)::bigint AS seq_rows, " +
    "coalesce(s.idx_scan, 0)::bigint AS idx_scans, " +
    "(coalesce(s.n_tup_ins, 0) + coalesce(s.n_tup_upd, 0) + coalesce(s.n_tup_del, 0))::bigint AS writes, " +
    "coalesce(s.n_tup_ins, 0)::bigint AS inserts, coalesce(s.n_tup_upd, 0)::bigint AS updates, " +
    "coalesce(s.n_tup_del, 0)::bigint AS deletes, coalesce(s.n_mod_since_analyze, 0)::bigint AS mod_since_analyze, " +
    "NULLIF(GREATEST(coalesce(s.last_vacuum, 'epoch'::timestamptz), coalesce(s.last_autovacuum, 'epoch'::timestamptz), " +
    "coalesce(s.last_analyze, 'epoch'::timestamptz), coalesce(s.last_autoanalyze, 'epoch'::timestamptz)), 'epoch'::timestamptz) AS last_maintenance_at, " +
    "coalesce(io.heap_blks_read, 0)::bigint AS heap_blks_read, coalesce(io.heap_blks_hit, 0)::bigint AS heap_blks_hit, " +
    "t.table_oid IS NOT NULL AS registered, coalesce(t.acceleration_enabled, false) AS acceleration_enabled " +
    "FROM pg_class c " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace " +
    "LEFT JOIN rvbbit.tables t ON t.table_oid = c.oid " +
    "LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid " +
    "LEFT JOIN pg_statio_user_tables io ON io.relid = c.oid " +
    "WHERE c.relkind IN ('r','p','m') " +
    "AND n.nspname NOT IN ('pg_catalog','information_schema','rvbbit') " +
    "AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' " +
    "AND NOT coalesce(t.acceleration_enabled, false) " +
    "), " +
    matched +
    ", scored AS ( " +
    "SELECT h.*, coalesce(m.slow_queries, 0)::bigint AS slow_queries, coalesce(m.query_calls, 0)::bigint AS query_calls, " +
    "coalesce(m.total_ms, 0)::double precision AS total_ms, m.max_mean_ms, coalesce(m.query_samples, ARRAY[]::text[]) AS query_samples, " +
    "(h.writes::double precision / GREATEST(h.row_estimate, 1)) AS mutation_ratio, " +
    "(h.seq_rows::double precision / GREATEST(h.writes, 1)) AS read_write_ratio, " +
    "LEAST(95.0, GREATEST(0.0, " +
    "LEAST(35.0, ln(1 + GREATEST(h.seq_rows, 0)) * 2.2) + " +
    "LEAST(25.0, GREATEST(h.seq_scans, 0) * 2.0) + " +
    "LEAST(30.0, coalesce(m.total_ms, 0) / 1000.0) + " +
    "LEAST(15.0, coalesce(m.slow_queries, 0) * 5.0) + " +
    "CASE WHEN h.row_estimate >= 100000 THEN 8.0 WHEN h.row_estimate >= 10000 THEN 4.0 ELSE 0.0 END - " +
    "LEAST(45.0, (h.writes::double precision / GREATEST(h.row_estimate, 1)) * 100.0) - " +
    "CASE WHEN h.mod_since_analyze::double precision > GREATEST(h.row_estimate, 1) * 0.25 THEN 12.0 ELSE 0.0 END " +
    "))::double precision AS score " +
    "FROM heap_tables h LEFT JOIN matched m ON m.oid = h.oid " +
    ") " +
    "SELECT table_name, schema, name, row_estimate, size_bytes, seq_scans, seq_rows, idx_scans, writes, " +
    "inserts, updates, deletes, mod_since_analyze, heap_blks_read, heap_blks_hit, slow_queries, query_calls, " +
    "total_ms, max_mean_ms, query_samples, mutation_ratio, read_write_ratio, score, registered, last_maintenance_at, " +
    "CASE WHEN score >= 70 THEN 'strong' WHEN score >= 35 THEN 'watch' ELSE 'low' END AS recommendation, " +
    "CASE WHEN writes = 0 AND mod_since_analyze = 0 THEN 'stable' " +
    "WHEN mutation_ratio < 0.02 AND mod_since_analyze::double precision < GREATEST(row_estimate, 1) * 0.05 THEN 'low churn' " +
    "WHEN mutation_ratio < 0.15 THEN 'moderate churn' ELSE 'high churn' END AS write_profile, " +
    "concat_ws(' · ', " +
    "CASE WHEN slow_queries > 0 THEN slow_queries || ' slow query sample' || CASE WHEN slow_queries = 1 THEN '' ELSE 's' END END, " +
    "CASE WHEN seq_scans > 0 THEN seq_scans || ' sequential scan' || CASE WHEN seq_scans = 1 THEN '' ELSE 's' END END, " +
    "CASE WHEN seq_rows > 0 THEN seq_rows || ' rows read by seq scans' END, " +
    "CASE WHEN writes = 0 THEN 'no observed writes' WHEN mutation_ratio < 0.02 THEN 'low write ratio' ELSE 'write-heavy' END " +
    ") AS reason " +
    "FROM scored " +
    "WHERE score >= 5 OR slow_queries > 0 OR seq_scans > 0 " +
    "ORDER BY score DESC, total_ms DESC, seq_rows DESC LIMIT 80"
  )
}

export async function fetchAccelerationCandidates(
  connectionId: string,
): Promise<{ rows: AccelerationCandidate[]; error?: string; pgStatStatements: boolean }> {
  const catalog = await runQuery(
    connectionId,
    "SELECT to_regclass('rvbbit.tables') IS NOT NULL AS rvbbit_present, " +
      "to_regclass('pg_stat_statements') IS NOT NULL AS pgss_present",
  )
  if (!catalog.ok) return { rows: [], error: catalog.error, pgStatStatements: false }
  if (!bool(catalog.rows[0]?.rvbbit_present)) {
    return { rows: [], error: "rvbbit registry is not installed on this connection", pgStatStatements: false }
  }

  const wantsPgss = bool(catalog.rows[0]?.pgss_present)
  let res = await runQuery(connectionId, accelerationCandidateSql(wantsPgss))
  let usedPgss = wantsPgss
  if (!res.ok && wantsPgss) {
    res = await runQuery(connectionId, accelerationCandidateSql(false))
    usedPgss = false
  }
  if (!res.ok) return { rows: [], error: res.error, pgStatStatements: usedPgss }

  return {
    pgStatStatements: usedPgss,
    rows: res.rows.map((r) => ({
      tableName: String(r.table_name ?? ""),
      schema: String(r.schema ?? ""),
      name: String(r.name ?? ""),
      rowEstimate: num(r.row_estimate),
      sizeBytes: num(r.size_bytes),
      seqScans: num(r.seq_scans),
      seqRows: num(r.seq_rows),
      idxScans: num(r.idx_scans),
      writes: num(r.writes),
      inserts: num(r.inserts),
      updates: num(r.updates),
      deletes: num(r.deletes),
      modSinceAnalyze: num(r.mod_since_analyze),
      heapBlocksRead: num(r.heap_blks_read),
      heapBlocksHit: num(r.heap_blks_hit),
      slowQueries: num(r.slow_queries),
      queryCalls: num(r.query_calls),
      totalMs: num(r.total_ms),
      maxMeanMs: numOrNull(r.max_mean_ms),
      querySamples: pgArray(r.query_samples),
      mutationRatio: num(r.mutation_ratio),
      readWriteRatio: num(r.read_write_ratio),
      score: num(r.score),
      recommendation: String(r.recommendation ?? "low") as AccelerationCandidate["recommendation"],
      writeProfile: String(r.write_profile ?? ""),
      reason: String(r.reason ?? ""),
      registered: bool(r.registered),
      lastMaintenanceAt: r.last_maintenance_at ? epoch(r.last_maintenance_at) : null,
    })),
  }
}

export async function enableAccelerationCandidate(
  connectionId: string,
  tableName: string,
  build: boolean,
): Promise<{ ok: boolean; message: string; error?: string }> {
  const sql = build
    ? `WITH enabled AS (SELECT rvbbit.enable_table(${qIdent(tableName)}) AS enabled) ` +
      `SELECT enabled.enabled AS enabled, rvbbit.refresh_acceleration(${qIdent(tableName)}, true) AS refresh FROM enabled`
    : `SELECT rvbbit.enable_table(${qIdent(tableName)}) AS enabled`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { ok: false, message: "failed", error: res.error }
  const row = res.rows[0] ?? {}
  const enabled = (row.enabled as Record<string, unknown> | null) ?? {}
  const refresh = (row.refresh as Record<string, unknown> | null) ?? null
  const enableStatus = String(enabled.status ?? "enabled")
  const refreshStatus = refresh ? String(refresh.status ?? "ok") : null
  const rowsWritten = refresh ? numOrNull(refresh.rows_written ?? refresh.visible_rows_estimate) : null
  const message = build
    ? `${enableStatus} · refresh ${refreshStatus}${rowsWritten != null ? ` · ${compactCount(rowsWritten)} rows` : ""}`
    : enableStatus
  return { ok: true, message }
}

export async function fetchWorkloadLayoutTables(
  connectionId: string,
): Promise<{ rows: WorkloadLayoutTable[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "WITH rec AS ( " +
      "SELECT table_oid, count(*) AS recommendations, " +
      "count(*) FILTER (WHERE status = 'accepted') AS accepted, " +
      "count(*) FILTER (WHERE layout_status = 'ready') AS ready " +
      "FROM rvbbit.workload_layout_recommendation_status GROUP BY table_oid " +
      ") " +
      "SELECT c.oid::regclass::text AS table_name, n.nspname AS schema, c.relname AS name, " +
      "coalesce(f.parquet_rows, 0) AS parquet_rows, coalesce(f.row_groups, 0) AS row_groups, " +
      "coalesce(f.heap_seq_scans, 0) AS heap_seq_scans, " +
      "coalesce(f.shadow_heap_dirty, false) AS dirty, coalesce(f.op_running, false) AS op_running, " +
      "coalesce(rec.recommendations, 0) AS recommendations, " +
      "coalesce(rec.accepted, 0) AS accepted, coalesce(rec.ready, 0) AS ready " +
      "FROM rvbbit.tables t " +
      "JOIN pg_class c ON c.oid = t.table_oid " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "LEFT JOIN rvbbit.accel_freshness f ON f.table_oid = t.table_oid " +
      "LEFT JOIN rec ON rec.table_oid = t.table_oid " +
      "WHERE coalesce(t.acceleration_enabled, true) " +
      "ORDER BY n.nspname, c.relname",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      tableName: String(r.table_name ?? ""),
      schema: String(r.schema ?? ""),
      name: String(r.name ?? ""),
      parquetRows: num(r.parquet_rows),
      rowGroups: num(r.row_groups),
      heapSeqScans: num(r.heap_seq_scans),
      dirty: bool(r.dirty),
      opRunning: bool(r.op_running),
      recommendations: num(r.recommendations),
      accepted: num(r.accepted),
      ready: num(r.ready),
    })),
  }
}

export async function fetchWorkloadLayoutRecommendations(
  connectionId: string,
): Promise<{ rows: WorkloadLayoutRecommendation[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT table_name, table_oid::text AS table_oid, layout_kind, column_name, layout, status, " +
      "score, observations, weighted_ms, role_counts, sample_shapes, layout_status, " +
      "layout_rows, layout_files, reason, details, recommended_at, updated_at " +
      "FROM rvbbit.workload_layout_recommendation_status " +
      "ORDER BY table_name, " +
      "CASE status WHEN 'accepted' THEN 0 WHEN 'candidate' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END, " +
      "score DESC, updated_at DESC",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => {
      const roles = (r.role_counts as Record<string, unknown> | null) ?? {}
      return {
        tableName: String(r.table_name ?? ""),
        tableOid: String(r.table_oid ?? ""),
        layoutKind: normalizeLayoutKind(r.layout_kind),
        columnName: String(r.column_name ?? ""),
        layout: String(r.layout ?? ""),
        status: normalizeLayoutStatus(r.status),
        score: num(r.score),
        observations: num(r.observations),
        weightedMs: num(r.weighted_ms),
        roleCounts: {
          where: num(roles.where),
          groupBy: num(roles.group_by),
          orderBy: num(roles.order_by),
          countDistinct: num(roles.count_distinct),
        },
        sampleShapes: pgArray(r.sample_shapes),
        layoutStatus: strOrNull(r.layout_status),
        layoutRows: numOrNull(r.layout_rows),
        layoutFiles: numOrNull(r.layout_files),
        reason: String(r.reason ?? ""),
        details: (r.details as Record<string, unknown> | null) ?? {},
        recommendedAt: epoch(r.recommended_at),
        updatedAt: epoch(r.updated_at),
      }
    }),
  }
}

export async function runWorkloadLayoutAdvisor(
  connectionId: string,
  tableName: string,
  lookbackHours: number,
  minObservations: number,
  maxRecommendations = 8,
): Promise<WorkloadAdvisorRun> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.recommend_workload_layouts(${qIdent(tableName)}, ` +
      `${Math.max(1, Math.floor(lookbackHours))}, ` +
      `${Math.max(1, Math.floor(minObservations))}, ` +
      `${Math.max(1, Math.floor(maxRecommendations))}, true) AS r`,
  )
  if (!res.ok) return { table: tableName, ok: false, recommendations: 0, matchedShapes: 0, error: res.error }
  const doc = (res.rows[0]?.r as Record<string, unknown> | null) ?? {}
  return {
    table: tableName,
    ok: bool(doc.ok),
    recommendations: Array.isArray(doc.recommendations) ? doc.recommendations.length : 0,
    matchedShapes: num(doc.sample_shapes_matched),
    error: bool(doc.ok) ? undefined : String(doc.reason ?? "advisor returned ok=false"),
  }
}

export async function setWorkloadLayoutRecommendationStatus(
  connectionId: string,
  tableName: string,
  layoutKind: WorkloadLayoutKind,
  columnName: string,
  status: "accepted" | "rejected",
): Promise<{ ok: boolean; error?: string }> {
  const fn = status === "accepted" ? "accept_workload_layout" : "reject_workload_layout"
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.${fn}(${qIdent(tableName)}, ${sqlStr(layoutKind)}, ${sqlStr(columnName)}) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  const doc = (res.rows[0]?.r as Record<string, unknown> | null) ?? {}
  return bool(doc.ok) ? { ok: true } : { ok: false, error: String(doc.reason ?? "status update failed") }
}

export async function refreshAcceptedWorkloadLayouts(
  connectionId: string,
  tableName: string,
): Promise<WorkloadLayoutBuildRun> {
  const helper = await runQuery(
    connectionId,
    "SELECT EXISTS ( " +
      "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
      "WHERE n.nspname = 'rvbbit' AND p.proname = 'build_accepted_workload_layouts' " +
      ") AS present",
  )
  const helperPresent = helper.ok && bool(helper.rows[0]?.present)
  const sql = helperPresent
    ? `SELECT rvbbit.build_accepted_workload_layouts(${qIdent(tableName)}) AS r`
    : `SELECT rvbbit.refresh_acceleration(${qIdent(tableName)}, true) AS r`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) {
    return {
      table: tableName,
      ok: false,
      status: "failed",
      acceptedLayouts: null,
      readyLayouts: null,
      layoutRows: null,
      baseAction: null,
      message: "layout build failed",
      error: res.error,
    }
  }
  const doc = (res.rows[0]?.r as Record<string, unknown> | null) ?? {}
  const status = String(doc.status ?? "ok")
  const acceptedLayouts = numOrNull(doc.accepted_layouts)
  const readyLayouts = numOrNull(doc.ready_layouts)
  const layoutRows = numOrNull(doc.layout_rows ?? doc.variants_rows)
  const baseAction = strOrNull(doc.base_action ?? doc.operation)
  const ok = helperPresent
    ? status === "ok" || status === "partial"
    : status === "ok" || status === "noop"
  const message =
    readyLayouts != null && acceptedLayouts != null
      ? `${compactCount(readyLayouts)}/${compactCount(acceptedLayouts)} ready · ${compactCount(layoutRows ?? 0)} layout rows`
      : `${status} · ${compactCount(layoutRows ?? 0)} layout rows`
  return {
    table: tableName,
    ok,
    status,
    acceptedLayouts,
    readyLayouts,
    layoutRows,
    baseAction,
    message,
    error: ok ? undefined : String(doc.reason ?? "no accepted layouts were built"),
  }
}

export async function runRvbbitMigrate(connectionId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await runQuery(connectionId, "SELECT rvbbit.migrate()")
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

function normalizeLayoutKind(v: unknown): WorkloadLayoutKind {
  return String(v ?? "") === "hive" ? "hive" : "cluster"
}

function normalizeLayoutStatus(v: unknown): WorkloadLayoutStatus {
  const s = String(v ?? "")
  return s === "accepted" || s === "rejected" || s === "retired" ? s : "candidate"
}

// ── routing overlay (tested pins) + auto-optimizer ──────────────────────
// The overlay supersedes the named-profile model: a flat set of tested
// shape→engine pins layered on the base rules, grown by the benchmarker.

export interface OverlayPin {
  shapeKey: string
  shapeFamily: string
  engine: string
  baseEngine: string
  marginPct: number
  source: string
  testedAt: number
  sampleMs: Record<string, number> | null
}

export async function fetchOverlayPins(
  connectionId: string,
): Promise<{ rows: OverlayPin[]; error: string | null }> {
  const res = await runQuery(
    connectionId,
    "SELECT shape_key, shape_family, engine, base_engine, margin_pct, source, " +
      "tested_at, sample_ms FROM rvbbit.route_overlay WHERE enabled " +
      "ORDER BY margin_pct DESC NULLS LAST",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      shapeKey: String(r.shape_key ?? ""),
      shapeFamily: String(r.shape_family ?? ""),
      engine: normalizeCandidate(String(r.engine ?? "")),
      baseEngine: normalizeCandidate(String(r.base_engine ?? "")),
      marginPct: num(r.margin_pct),
      source: String(r.source ?? ""),
      testedAt: epoch(r.tested_at),
      sampleMs: (r.sample_ms as Record<string, number> | null) ?? null,
    })),
  }
}

export interface OptimizeCandidate {
  shapeKey: string
  shapeFamily: string
  executions: number
  avgMs: number
  potentialMs: number
  lastSeen: number
  /** Engine this shape currently routes to (the base-rule target you'd be trying to beat). */
  engine: string
}

export async function fetchOptimizationCandidates(
  connectionId: string,
): Promise<{ rows: OptimizeCandidate[]; error: string | null }> {
  // Enrich each candidate with the engine it predominantly runs on today. Routing is
  // deterministic per shape, so this is effectively the base-rule target — the engine a
  // benchmark would have to beat. The candidate set itself stays sourced from the view.
  const res = await runQuery(
    connectionId,
    "SELECT c.shape_key, c.shape_family, c.executions, c.avg_ms, c.potential_ms, c.last_seen, " +
      "(SELECT mode() WITHIN GROUP (ORDER BY e.candidate) FROM rvbbit.route_executions e " +
      "WHERE e.shape_key = c.shape_key AND e.executed_at > now() - interval '1 day' " +
      "AND e.status = 'ok' AND e.candidate IS NOT NULL) AS engine " +
      "FROM rvbbit.route_optimization_candidates c LIMIT 50",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      shapeKey: String(r.shape_key ?? ""),
      shapeFamily: String(r.shape_family ?? ""),
      executions: num(r.executions),
      avgMs: num(r.avg_ms),
      potentialMs: num(r.potential_ms),
      lastSeen: epoch(r.last_seen),
      engine: normalizeCandidate(String(r.engine ?? "")),
    })),
  }
}

export interface OptimizeRunDetail {
  shape_key: string
  pinned: boolean
  winner: string | null
  margin_pct: number | null
}

export interface OptimizeRun {
  runId: number
  startedAt: number
  finishedAt: number | null
  trigger: string
  shapesTested: number
  pinned: number
  errors: number
  elapsedSec: number | null
  detail: OptimizeRunDetail[] | null
}

export async function fetchOptimizeRuns(
  connectionId: string,
): Promise<{ rows: OptimizeRun[]; error: string | null }> {
  const res = await runQuery(
    connectionId,
    "SELECT run_id, started_at, finished_at, trigger, shapes_tested, pinned, errors, " +
      "elapsed_sec, detail FROM rvbbit.route_optimize_runs ORDER BY started_at DESC LIMIT 30",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      runId: num(r.run_id),
      startedAt: epoch(r.started_at),
      finishedAt: r.finished_at == null ? null : epoch(r.finished_at),
      trigger: String(r.trigger ?? ""),
      shapesTested: num(r.shapes_tested),
      pinned: num(r.pinned),
      errors: num(r.errors),
      elapsedSec: numOrNull(r.elapsed_sec),
      detail: (r.detail as OptimizeRunDetail[] | null) ?? null,
    })),
  }
}

/** Trigger an auto-optimizer pass now (manual). Returns the function's JSON summary. */
export async function runOptimizeAuto(
  connectionId: string,
  topK: number,
  maxSeconds: number,
): Promise<{ ok: boolean; result: Record<string, unknown> | null; error: string | null }> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_optimize_auto(${Math.max(1, Math.trunc(topK))}, ${Math.max(1, Math.trunc(maxSeconds))}) AS r`,
  )
  if (!res.ok) return { ok: false, result: null, error: res.error }
  return { ok: true, result: (res.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}

/** Benchmark one query across all engines and pin it if a non-base engine wins. */
export async function runOptimizeQuery(
  connectionId: string,
  sql: string,
): Promise<{ ok: boolean; result: Record<string, unknown> | null; error: string | null }> {
  const res = await runQuery(connectionId, `SELECT rvbbit.route_optimize_query(${sqlStr(sql)}) AS r`)
  if (!res.ok) return { ok: false, result: null, error: res.error }
  return { ok: true, result: (res.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}
