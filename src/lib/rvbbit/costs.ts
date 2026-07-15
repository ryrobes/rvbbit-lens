"use client"

/**
 * Client-side data model for the Costs window.
 *
 * Talks to the cost / receipt surface introduced in pg_rvbbit 0.48 —
 * see /rvbbit/docs/COSTS_UI_CONTRACT.md for the stable shapes. The
 * UI is read-only: no maintenance actions, no policy edits in v1.
 *
 * Every fetcher takes the same CostsFilter so panels can stay coupled
 * via one shared state object in the window component.
 */

import { fetchOperators } from "./operators"

// ─── Filter ──────────────────────────────────────────────────────────

export type CostsWindowDays = 1 | 7 | 30

export interface CostsFilter {
  /** Default window when no brush range is set. */
  windowDays: CostsWindowDays
  /** Optional brushed range from the timeline. Overrides windowDays. */
  brushRange: { startIso: string; endIso: string } | null
  /** Single-axis cross-panel filters. null = unfiltered. */
  operator: string | null
  model: string | null
  auditStatus: AuditStatus | null
  costStatus: CostStatus | null
  /** Cross-window deep-link from Query Lens etc. */
  queryId: string | null
}

export const DEFAULT_FILTER: CostsFilter = {
  windowDays: 7,
  brushRange: null,
  operator: null,
  model: null,
  auditStatus: null,
  costStatus: null,
  queryId: null,
}

// ─── Status enums (from the contract) ────────────────────────────────

export type AuditStatus =
  | "ok"
  | "no_chargeable_sub_calls"
  | "missing_cost_events"
  | "pending"
  | "stale_pending"
  | "uncosted"
  | "errors"

export type CostStatus = "pending" | "settled" | "estimated" | "free" | "uncosted" | "error"

/** Map a status to a desktop theme token for consistent coloring across all panels. */
export function statusColor(s: CostStatus | AuditStatus | string): string {
  switch (s) {
    case "settled":
    case "ok":
      return "var(--success)"
    case "estimated":
      return "var(--info)"
    case "pending":
      return "var(--viz-status-pending)"
    case "stale_pending":
    case "uncosted":
    case "missing_cost_events":
      return "var(--warning)"
    case "free":
      return "var(--chrome-text)"
    case "error":
    case "errors":
      return "var(--danger)"
    case "no_chargeable_sub_calls":
      return "var(--chrome-text)"
    default:
      return "var(--chrome-text)"
  }
}

// ─── Internal helpers ────────────────────────────────────────────────

interface QueryOk<R = Record<string, unknown>> {
  ok: true
  columns: { name: string; dataTypeId: number; dataTypeName?: string }[]
  rows: R[]
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery<R = Record<string, unknown>>(
  connectionId: string,
  sql: string,
): Promise<QueryOk<R> | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 5000 }),
    })
    return (await res.json()) as QueryOk<R> | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

/**
 * Build a `r.invocation_at >= ...` clause from the filter. Brush range
 * (if present) wins over windowDays; both fall back to a now()-relative
 * interval so the planner can use indexes cleanly.
 */
function timeClause(filter: CostsFilter, column: string): string {
  if (filter.brushRange) {
    return `${column} >= ${sqlStr(filter.brushRange.startIso)}::timestamptz AND ${column} <= ${sqlStr(filter.brushRange.endIso)}::timestamptz`
  }
  return `${column} >= now() - interval '${filter.windowDays} days'`
}

/** Optional AND clauses for the cross-panel filters. */
function filterClauses(filter: CostsFilter, opts: { receiptAlias?: string } = {}): string {
  const r = opts.receiptAlias ?? "r"
  const parts: string[] = []
  if (filter.operator) parts.push(`${r}.operator = ${sqlStr(filter.operator)}`)
  if (filter.model) parts.push(`${r}.model = ${sqlStr(filter.model)}`)
  if (filter.queryId) parts.push(`${r}.query_id = ${sqlStr(filter.queryId)}::uuid`)
  return parts.length > 0 ? " AND " + parts.join(" AND ") : ""
}

// ─── Summary ─────────────────────────────────────────────────────────

export interface CostSummary {
  receipts: {
    total: number
    ok: number
    no_chargeable_sub_calls: number
    missing_cost_events: number
    pending: number
    stale_pending: number
    uncosted: number
    errors: number
  }
  cost_events: {
    latest_calls: number
    pending: number
    settled: number
    estimated: number
    free: number
    uncosted: number
    error: number
  }
  receipt_queue_pending: number
}

export async function fetchCostSummary(connectionId: string): Promise<CostSummary | null> {
  const res = await runQuery<{ cost_audit_summary: CostSummary }>(
    connectionId,
    "SELECT rvbbit.cost_audit_summary() AS cost_audit_summary",
  )
  if (!res.ok) return null
  return res.rows[0]?.cost_audit_summary ?? null
}

// ─── Timeline ────────────────────────────────────────────────────────

export interface CostByBucketRow {
  /** ISO timestamp for the bucket's left edge. */
  bucket: string
  total_cost_usd: number
  calls: number
  pending_calls: number
  estimated_calls: number
  uncosted_calls: number
  error_calls: number
}

/** Bucket granularity for the timeline given the window. */
export function bucketUnit(windowDays: CostsWindowDays): "hour" | "day" {
  return windowDays === 1 ? "hour" : "day"
}

export async function fetchCostByBucket(
  connectionId: string,
  windowDays: CostsWindowDays,
): Promise<CostByBucketRow[]> {
  // Timeline range follows the range picker. Granularity adapts so a
  // 1-day window shows hourly buckets (~24 points) instead of one
  // collapsed day; 7d / 30d stay at day granularity.
  // NOT filtered by operator/model — the timeline is the "where did
  // the cost land in time" view independent of the cross-panel filter.
  const unit = bucketUnit(windowDays)
  const res = await runQuery<Record<string, unknown>>(
    connectionId,
    `SELECT date_trunc('${unit}', last_event_at) AS bucket,
            sum(total_cost_usd)::float8 AS total_cost_usd,
            sum(costed_calls)::int AS calls,
            sum(pending_calls)::int AS pending_calls,
            sum(estimated_calls)::int AS estimated_calls,
            sum(uncosted_calls)::int AS uncosted_calls,
            sum(error_calls)::int AS error_calls
       FROM rvbbit.query_costs
      WHERE last_event_at >= now() - interval '${windowDays} days'
      GROUP BY bucket
      ORDER BY bucket`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    bucket: new Date(String(r.bucket)).toISOString(),
    total_cost_usd: num(r.total_cost_usd),
    calls: num(r.calls),
    pending_calls: num(r.pending_calls),
    estimated_calls: num(r.estimated_calls),
    uncosted_calls: num(r.uncosted_calls),
    error_calls: num(r.error_calls),
  }))
}

// ─── By operator ─────────────────────────────────────────────────────

export interface CostByOperatorRow {
  operator: string
  receipts: number
  total_cost_usd: number
  pending_calls: number
  estimated_calls: number
  uncosted_calls: number
  error_calls: number
}

export async function fetchCostByOperator(
  connectionId: string,
  filter: CostsFilter,
): Promise<CostByOperatorRow[]> {
  // Apply cross-panel filters EXCEPT operator (the chart shows the
  // breakdown across operators, so filtering by operator would
  // collapse it to one row). Backend/model filtering is intentionally
  // light here — the chart is operator-level.
  const localFilter: CostsFilter = { ...filter, operator: null }
  const sql = `
    SELECT r.operator,
           count(DISTINCT r.receipt_id)::int AS receipts,
           coalesce(sum(c.total_cost_usd), 0)::float8 AS total_cost_usd,
           coalesce(sum(c.pending_calls), 0)::int AS pending_calls,
           coalesce(sum(c.estimated_calls), 0)::int AS estimated_calls,
           coalesce(sum(c.uncosted_calls), 0)::int AS uncosted_calls,
           coalesce(sum(c.error_calls), 0)::int AS error_calls
      FROM rvbbit.receipts r
      LEFT JOIN rvbbit.receipt_costs c USING (receipt_id)
     WHERE ${timeClause(localFilter, "r.invocation_at")}${filterClauses(localFilter)}
     GROUP BY r.operator
     ORDER BY total_cost_usd DESC, receipts DESC
     LIMIT 25
  `
  const res = await runQuery<Record<string, unknown>>(connectionId, sql)
  if (!res.ok) return []
  return res.rows.map((r) => ({
    operator: String(r.operator ?? "unknown"),
    receipts: num(r.receipts),
    total_cost_usd: num(r.total_cost_usd),
    pending_calls: num(r.pending_calls),
    estimated_calls: num(r.estimated_calls),
    uncosted_calls: num(r.uncosted_calls),
    error_calls: num(r.error_calls),
  }))
}

// ─── By backend / model ──────────────────────────────────────────────

export interface CostByBackendModelRow {
  backend: string
  model_or_tool: string
  status: CostStatus
  calls: number
  total_cost_usd: number
}

export async function fetchCostByBackendModel(
  connectionId: string,
  filter: CostsFilter,
): Promise<CostByBackendModelRow[]> {
  // cost_latest doesn't carry r.operator directly; for v1 we filter
  // only by the time window + model. Operator filter is approximated
  // via cost_latest.model joining receipts is too expensive here.
  const localFilter: CostsFilter = { ...filter, operator: null }
  const modelPart = filter.model
    ? ` AND coalesce(model, tool, 'unknown') = ${sqlStr(filter.model)}`
    : ""
  const sql = `
    SELECT coalesce(backend, 'unknown') AS backend,
           coalesce(model, tool, 'unknown') AS model_or_tool,
           status,
           count(*)::int AS calls,
           coalesce(sum(cost_usd), 0)::float8 AS total_cost_usd
      FROM rvbbit.cost_latest
     WHERE ${timeClause(localFilter, "created_at")}${modelPart}
     GROUP BY backend, model_or_tool, status
     ORDER BY total_cost_usd DESC, calls DESC
     LIMIT 60
  `
  const res = await runQuery<Record<string, unknown>>(connectionId, sql)
  if (!res.ok) return []
  return res.rows.map((r) => ({
    backend: String(r.backend ?? "unknown"),
    model_or_tool: String(r.model_or_tool ?? "unknown"),
    status: String(r.status ?? "uncosted") as CostStatus,
    calls: num(r.calls),
    total_cost_usd: num(r.total_cost_usd),
  }))
}

// ─── Receipts (the bottom-of-window table) ───────────────────────────

export interface CostReceiptRow {
  receipt_id: string
  operator: string
  model: string | null
  query_id: string | null
  n_tokens_in: number
  n_tokens_out: number
  latency_ms: number
  error: string | null
  invocation_at: string // ISO
  audit_status: AuditStatus | null
  chargeable_sub_calls: number
  cost_event_sub_calls: number
  pending_calls: number
  estimated_calls: number
  uncosted_calls: number
  error_calls: number
  total_cost_usd: number
}

export async function fetchRecentReceipts(
  connectionId: string,
  filter: CostsFilter,
): Promise<CostReceiptRow[]> {
  const auditPart = filter.auditStatus
    ? ` AND a.audit_status = ${sqlStr(filter.auditStatus)}`
    : ""
  const sql = `
    SELECT r.receipt_id::text AS receipt_id,
           r.operator,
           r.model,
           r.query_id::text AS query_id,
           coalesce(r.n_tokens_in, 0)::int AS n_tokens_in,
           coalesce(r.n_tokens_out, 0)::int AS n_tokens_out,
           coalesce(r.latency_ms, 0)::int AS latency_ms,
           r.error,
           r.invocation_at,
           a.audit_status,
           coalesce(a.chargeable_sub_calls, 0)::int AS chargeable_sub_calls,
           coalesce(a.cost_event_sub_calls, 0)::int AS cost_event_sub_calls,
           coalesce(a.pending_calls, 0)::int AS pending_calls,
           coalesce(a.estimated_calls, 0)::int AS estimated_calls,
           coalesce(a.uncosted_calls, 0)::int AS uncosted_calls,
           coalesce(a.error_calls, 0)::int AS error_calls,
           coalesce(a.total_cost_usd, 0)::float8 AS total_cost_usd
      FROM rvbbit.receipts r
      LEFT JOIN rvbbit.receipt_cost_audit a USING (receipt_id)
     WHERE ${timeClause(filter, "r.invocation_at")}${filterClauses(filter)}${auditPart}
     ORDER BY r.invocation_at DESC
     LIMIT 500
  `
  const res = await runQuery<Record<string, unknown>>(connectionId, sql)
  if (!res.ok) return []
  return res.rows.map((r) => ({
    receipt_id: String(r.receipt_id ?? ""),
    operator: String(r.operator ?? "unknown"),
    model: r.model == null ? null : String(r.model),
    query_id: r.query_id == null ? null : String(r.query_id),
    n_tokens_in: num(r.n_tokens_in),
    n_tokens_out: num(r.n_tokens_out),
    latency_ms: num(r.latency_ms),
    error: r.error == null ? null : String(r.error),
    invocation_at: String(r.invocation_at),
    audit_status: (r.audit_status as AuditStatus | null) ?? null,
    chargeable_sub_calls: num(r.chargeable_sub_calls),
    cost_event_sub_calls: num(r.cost_event_sub_calls),
    pending_calls: num(r.pending_calls),
    estimated_calls: num(r.estimated_calls),
    uncosted_calls: num(r.uncosted_calls),
    error_calls: num(r.error_calls),
    total_cost_usd: num(r.total_cost_usd),
  }))
}

// ─── Total cost across the current filter ────────────────────────────

export interface CostTotal {
  total_cost_usd: number
  /** Would-be a-la-carte value of managed Clover calls (policy-estimated).
   *  Included in the subscription — value, not spend. Subtract from
   *  total_cost_usd to get real out-of-pocket spend. */
  included_value_usd: number
  receipts: number
  receipts_costed: number
  receipts_uncosted: number
  receipts_errored: number
}

export async function fetchCostTotal(
  connectionId: string,
  filter: CostsFilter,
): Promise<CostTotal> {
  const sql = `
    SELECT coalesce(sum(c.total_cost_usd), 0)::float8 AS total_cost_usd,
           count(*)::int AS receipts,
           count(*) FILTER (WHERE a.audit_status IN ('ok'))::int AS receipts_costed,
           count(*) FILTER (WHERE a.audit_status = 'uncosted')::int AS receipts_uncosted,
           count(*) FILTER (WHERE a.audit_status = 'errors')::int AS receipts_errored
      FROM rvbbit.receipts r
      LEFT JOIN rvbbit.receipt_cost_audit a USING (receipt_id)
      LEFT JOIN rvbbit.receipt_costs c USING (receipt_id)
     WHERE ${timeClause(filter, "r.invocation_at")}${filterClauses(filter)}
  `
  // Managed Clover calls carry a policy-estimated "would-be" cost —
  // subscription value, not billable spend. Split so the header never
  // conflates the two.
  const includedSql = `
    SELECT coalesce(sum(e.cost_usd), 0)::float8 AS included_value_usd
      FROM rvbbit.cost_events e
      JOIN rvbbit.receipts r2 ON r2.receipt_id = e.receipt_id
     WHERE e.backend LIKE 'clover%' AND e.cost_usd IS NOT NULL
       AND ${timeClause(filter, "r2.invocation_at")}${filterClauses(filter, { receiptAlias: "r2" })}
  `
  const [res, incRes] = await Promise.all([
    runQuery<Record<string, unknown>>(connectionId, sql),
    runQuery<Record<string, unknown>>(connectionId, includedSql),
  ])
  if (!res.ok)
    return { total_cost_usd: 0, included_value_usd: 0, receipts: 0, receipts_costed: 0, receipts_uncosted: 0, receipts_errored: 0 }
  const r = res.rows[0] ?? {}
  const inc = incRes.ok ? (incRes.rows[0] ?? {}) : {}
  return {
    total_cost_usd: num(r.total_cost_usd),
    included_value_usd: num((inc as Record<string, unknown>).included_value_usd),
    receipts: num(r.receipts),
    receipts_costed: num(r.receipts_costed),
    receipts_uncosted: num(r.receipts_uncosted),
    receipts_errored: num(r.receipts_errored),
  }
}

// ─── Composite bundle for one polling tick ───────────────────────────

export interface CostsBundle {
  summary: CostSummary | null
  total: CostTotal
  byBucket: CostByBucketRow[]
  byOperator: CostByOperatorRow[]
  byBackendModel: CostByBackendModelRow[]
  receipts: CostReceiptRow[]
}

export async function fetchCostsBundle(
  connectionId: string,
  filter: CostsFilter,
): Promise<CostsBundle> {
  const [summary, total, byBucket, byOperator, byBackendModel, receipts] = await Promise.all([
    fetchCostSummary(connectionId),
    fetchCostTotal(connectionId, filter),
    fetchCostByBucket(connectionId, filter.windowDays),
    fetchCostByOperator(connectionId, filter),
    fetchCostByBackendModel(connectionId, filter),
    fetchRecentReceipts(connectionId, filter),
  ])
  return { summary, total, byBucket, byOperator, byBackendModel, receipts }
}

// re-export so the window's policy-popover stub (deferred to v2) can
// share the operator catalog when we wire it in
export { fetchOperators }
