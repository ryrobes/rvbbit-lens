"use client"

/**
 * Client-side model for rvbbit's adaptive query router — the system that
 * picks one of six execution engines for a SELECT against an rvbbit
 * columnar table, based on the query's shape and a trained profile.
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
  | "datafusion_hive"
  | "pg_rowstore"

export interface EngineMeta {
  id: EngineId
  label: string
  color: string
  blurb: string
}

/** The six candidate engines, in router-display order. */
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
    id: "datafusion_hive",
    label: "datafusion hive",
    color: "var(--viz-engine-datafusion-hive)",
    blurb: "DataFusion over hive-partitioned parquet variants",
  },
  {
    id: "pg_rowstore",
    label: "pg rowstore",
    color: "var(--viz-engine-pg-rowstore)",
    blurb: "PostgreSQL rowstore over a retained shadow heap",
  },
]

export function engineMeta(id: string): EngineMeta {
  return (
    ENGINES.find((e) => e.id === id) ?? {
      id: id as EngineId,
      label: id || "unknown",
      color: "var(--chrome-text)",
      blurb: "",
    }
  )
}

/**
 * Older candidate aliases (`duck`, `datafusion`, `native`, `df_hive`,
 * `pg_heap`) may surface in legacy profile JSON or scripts. Normalize
 * to the canonical six before storing in UI state.
 */
const CANDIDATE_ALIASES: Record<string, EngineId> = {
  duck: "duck_vector",
  datafusion: "datafusion_vector",
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
    datafusion_hive: numOrNull(r.datafusion_hive_ms),
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
    datafusion_hive: numOrNull(r.datafusion_hive_median_ms),
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
    datafusion_hive: numOrNull(r.datafusion_hive_observations),
    pg_rowstore: numOrNull(r.pg_observations),
  }
}

// ── Row types ───────────────────────────────────────────────────────

export interface RouteExecution {
  executedAt: number
  candidate: string
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

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 5000 }),
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
function bool(v: unknown): boolean {
  return v === true || v === "t"
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
    "SELECT executed_at, candidate, route_source, elapsed_ms, rows_returned, " +
      "cache_hit, status, shape_family, reason FROM rvbbit.route_executions " +
      "WHERE " + windowClause("executed_at", windowHours) +
      " ORDER BY executed_at DESC LIMIT 500",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      executedAt: epoch(r.executed_at),
      candidate: normalizeCandidate(String(r.candidate ?? "")),
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
    "SELECT candidate, route_source, count(*) AS decisions, " +
      "count(*) FILTER (WHERE cache_hit) AS cache_hits, " +
      "count(*) FILTER (WHERE rewritten) AS rewritten " +
      "FROM rvbbit.route_decisions WHERE " + windowClause("decided_at", windowHours) +
      " GROUP BY candidate, route_source",
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    candidate: normalizeCandidate(String(r.candidate ?? "")),
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
      "duck_vortex_ms, duck_hive_ms, datafusion_ms, datafusion_hive_ms, pg_ms, reason " +
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
      "datafusion_median_ms, datafusion_hive_median_ms, pg_median_ms, " +
      "native_observations, duck_observations, duck_vortex_observations, " +
      "duck_hive_observations, " +
      "datafusion_observations, datafusion_hive_observations, pg_observations, " +
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
      "datafusion_ms, datafusion_hive_ms, pg_ms " +
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
      "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "JOIN pg_am am ON am.oid = c.relam " +
      "WHERE c.relkind = 'r' AND am.amname = 'rvbbit' ORDER BY n.nspname, c.relname",
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
  dirty: boolean
  authoritative: boolean
  opRunning: boolean
  lance: boolean
  secondsDirty: number | null
  secondsSinceRefresh: number | null
  lastRefreshAt: number
  parquetRows: number
  rowGroups: number
  driftRows: number
  driftRatio: number | null
  heapSeqScans: number
  lastRebuildMs: number | null
  lastRebuildRows: number | null
  // policy
  strategy: AccelStrategy
  targetSecs: number | null
  minIntervalSecs: number
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
  "SELECT f.table_name, f.shadow_heap_dirty, f.parquet_authoritative, f.op_running, " +
  "f.lance_accelerated, f.seconds_dirty, f.seconds_since_refresh, f.last_refresh_at, " +
  "f.parquet_rows, f.row_groups, f.drift_rows, f.drift_ratio, f.heap_seq_scans, " +
  "f.last_rebuild_ms, f.last_rebuild_rows, e.strategy, e.freshness_target_secs, " +
  "e.min_interval_secs, e.explicit, e.active, e.denied_engines, e.denied_layouts " +
  "FROM rvbbit.accel_freshness f " +
  "JOIN rvbbit.accel_policy_effective e ON e.table_oid = f.table_oid " +
  "ORDER BY (f.drift_rows * (1 + f.heap_seq_scans)) DESC, f.table_name"

export async function fetchAccelFreshness(
  connectionId: string,
): Promise<{ rows: AccelFreshnessRow[]; error?: string }> {
  const res = await runQuery(connectionId, ACCEL_FRESHNESS_SQL)
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      tableName: String(r.table_name ?? ""),
      dirty: bool(r.shadow_heap_dirty),
      authoritative: bool(r.parquet_authoritative),
      opRunning: bool(r.op_running),
      lance: bool(r.lance_accelerated),
      secondsDirty: numOrNull(r.seconds_dirty),
      secondsSinceRefresh: numOrNull(r.seconds_since_refresh),
      lastRefreshAt: epoch(r.last_refresh_at),
      parquetRows: num(r.parquet_rows),
      rowGroups: num(r.row_groups),
      driftRows: num(r.drift_rows),
      driftRatio: numOrNull(r.drift_ratio),
      heapSeqScans: num(r.heap_seq_scans),
      lastRebuildMs: numOrNull(r.last_rebuild_ms),
      lastRebuildRows: numOrNull(r.last_rebuild_rows),
      strategy: (String(r.strategy ?? "manual") as AccelStrategy) ?? "manual",
      targetSecs: numOrNull(r.freshness_target_secs),
      minIntervalSecs: num(r.min_interval_secs),
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
): string {
  const t = targetSecs == null ? "NULL" : String(Math.max(1, Math.floor(targetSecs)))
  return `SELECT rvbbit.set_accel_policy(${qIdent(table)}, ${sqlStr(strategy)}, ${t})`
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
    return { strategy: "target", targetSecs: 300, why: "queried on the slow path and cheap to delta — keep within ~5 min" }
  }
  if (hot) {
    return { strategy: "scheduled", targetSecs: null, why: "queried on the slow path — refresh whenever dirty" }
  }
  return { strategy: "demand", targetSecs: null, why: "low traffic — only refresh when it's actually being hit" }
}
