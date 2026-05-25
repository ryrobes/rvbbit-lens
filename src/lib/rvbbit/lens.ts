"use client"

/**
 * Query Lens — a cross-surface trace for a single query_id.
 *
 * Compounds every observability stream rvbbit maintains:
 *   - rvbbit.receipts            (operator runs)
 *   - receipt.sub_calls           (per-step LLM / specialist / MCP / SQL / code)
 *   - rvbbit.mcp_invocations      (per-call MCP audit)
 *   - rvbbit.route_decisions      (rewrite-time route picks — time-correlated; no query_id column)
 *   - rvbbit.route_executions     (executor-time runtime — time-correlated; no query_id column)
 *
 * The receipt + mcp_invocation surfaces link directly via query_id; the
 * routing surfaces are soft-linked by falling within the query's time
 * window. The window renders the linkage as such — explicit linked
 * events first, time-correlated co-occurring events labelled separately.
 */

export type LensSurface =
  | "receipt"
  | "subcall"
  | "mcp"
  | "route_decision"
  | "route_execution"
  | "kg_write"

interface LensEventBase {
  id: string
  surface: LensSurface
  startAt: number
  endAt: number
  durationMs: number
  /** "linked" — direct query_id match. "time" — soft-linked via time window. */
  linkage: "linked" | "time"
}

export interface LensReceiptEvent extends LensEventBase {
  surface: "receipt"
  receiptId: string
  operator: string
  model: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number | null
  error: string | null
  takeIndex: number | null
  takeVerdict: string | null
  subCallCount: number
}

export interface LensSubcallEvent extends LensEventBase {
  surface: "subcall"
  receiptId: string
  step: string
  kind: string
  model: string | null
  tokensIn: number
  tokensOut: number
  error: string | null
  index: number
}

export interface LensMcpEvent extends LensEventBase {
  surface: "mcp"
  invocationId: number
  server: string
  tool: string
  args: unknown
  cacheHit: boolean
  error: string | null
}

export interface LensRouteDecisionEvent extends LensEventBase {
  surface: "route_decision"
  decisionId: number
  candidate: string
  route: string
  routeSource: string
  reason: string
  confidence: number | null
  cacheHit: boolean
  shapeFamily: string
}

export interface LensRouteExecutionEvent extends LensEventBase {
  surface: "route_execution"
  executionId: number
  candidate: string
  routeSource: string
  rowsReturned: number
  cacheHit: boolean
  status: string
  shapeFamily: string
  reason: string
}

export interface LensKgEvent extends LensEventBase {
  surface: "kg_write"
  evidenceId: number
  /** edge_id or node_id — never both populated, but typed loose for safety. */
  edgeId: number | null
  nodeId: number | null
  /** Logical graph this fact lives in — needed for KG window cross-links. */
  graphId: string | null
  /** Direct node IDs for clickable cross-links (avoids re-resolution). */
  subjectNodeId: number | null
  objectNodeId: number | null
  /** Display fields resolved server-side via LEFT JOIN to kg_nodes/kg_edges. */
  subjectKind: string | null
  subjectLabel: string | null
  predicate: string | null
  objectKind: string | null
  objectLabel: string | null
  confidence: number | null
  evidenceText: string | null
  sourceTable: string | null
  sourcePk: string | null
  sourceColumn: string | null
}

export type LensEvent =
  | LensReceiptEvent
  | LensSubcallEvent
  | LensMcpEvent
  | LensRouteDecisionEvent
  | LensRouteExecutionEvent
  | LensKgEvent

export interface LensTrace {
  queryId: string
  events: LensEvent[]
  span: { min: number; max: number; durationMs: number }
  counts: Record<LensSurface, number>
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  totalReceiptLatencyMs: number
  errorCount: number
  cacheHitCount: number
}

export interface RecentQuery {
  queryId: string
  firstAt: number
  lastAt: number
  durationMs: number
  receiptCount: number
  operators: string[]
  totalLatencyMs: number
  errorCount: number
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
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** Slack on each side of the query span when correlating routing events. */
const TIME_BUFFER_MS = 50

// ── Recent queries (the picker rail) ────────────────────────────────

export async function fetchRecentQueryIds(
  connectionId: string,
  limit: number = 50,
): Promise<{ rows: RecentQuery[]; error?: string }> {
  const lim = Math.max(1, Math.min(200, limit))
  const res = await runQuery(
    connectionId,
    `SELECT query_id::text AS qid, ` +
      `count(*) AS n_receipts, ` +
      `array_agg(DISTINCT operator) AS ops, ` +
      `min(invocation_at) AS first_at, ` +
      `max(invocation_at) AS last_at, ` +
      `sum(latency_ms) AS total_ms, ` +
      `count(*) FILTER (WHERE error IS NOT NULL) AS errors ` +
      `FROM rvbbit.receipts WHERE query_id IS NOT NULL ` +
      `GROUP BY query_id ORDER BY last_at DESC LIMIT ${lim}`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => {
      const firstAt = epoch(r.first_at)
      const lastAt = epoch(r.last_at)
      return {
        queryId: String(r.qid ?? ""),
        firstAt,
        lastAt,
        durationMs: Math.max(0, lastAt - firstAt),
        receiptCount: num(r.n_receipts),
        operators: Array.isArray(r.ops) ? (r.ops as string[]) : [],
        totalLatencyMs: num(r.total_ms),
        errorCount: num(r.errors),
      }
    }),
  }
}

// ── Trace for one query_id ──────────────────────────────────────────

interface ReceiptRow {
  receipt_id: string
  operator: string
  model: string | null
  inputs: unknown
  output: unknown
  take_index: number | null
  take_verdict: string | null
  n_tokens_in: number
  n_tokens_out: number
  cost_usd: number | null
  latency_ms: number
  error: string | null
  sub_calls: SubCallRow[] | null
  invocation_at: string
}

interface SubCallRow {
  step?: string
  kind?: string
  model?: string
  tokens_in?: number
  tokens_out?: number
  latency_ms?: number
  error?: string | null
}

async function fetchReceiptsForQuery(
  connectionId: string,
  queryId: string,
): Promise<ReceiptRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT receipt_id::text AS receipt_id, operator, model, inputs, output, ` +
      `take_index, take_verdict, n_tokens_in, n_tokens_out, cost_usd, latency_ms, ` +
      `error, sub_calls, invocation_at ` +
      `FROM rvbbit.receipts WHERE query_id = ${sqlStr(queryId)}::uuid ` +
      `ORDER BY invocation_at`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    receipt_id: String(r.receipt_id ?? ""),
    operator: String(r.operator ?? ""),
    model: strOrNull(r.model),
    inputs: r.inputs ?? null,
    output: r.output ?? null,
    take_index: numOrNull(r.take_index),
    take_verdict: strOrNull(r.take_verdict),
    n_tokens_in: num(r.n_tokens_in),
    n_tokens_out: num(r.n_tokens_out),
    cost_usd: numOrNull(r.cost_usd),
    latency_ms: num(r.latency_ms),
    error: strOrNull(r.error),
    sub_calls: (r.sub_calls as SubCallRow[] | null) ?? null,
    invocation_at: String(r.invocation_at ?? ""),
  }))
}

async function fetchMcpForQuery(
  connectionId: string,
  queryId: string,
): Promise<LensMcpEvent[]> {
  const res = await runQuery(
    connectionId,
    `SELECT id, server, tool, args, cache_hit, error, latency_ms, invocation_at ` +
      `FROM rvbbit.mcp_invocations WHERE query_id = ${sqlStr(queryId)}::uuid ` +
      `ORDER BY invocation_at`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    const startAt = epoch(r.invocation_at)
    const dur = num(r.latency_ms)
    return {
      id: `mcp:${r.id}`,
      surface: "mcp" as const,
      linkage: "linked" as const,
      startAt,
      endAt: startAt + dur,
      durationMs: dur,
      invocationId: num(r.id),
      server: String(r.server ?? ""),
      tool: String(r.tool ?? ""),
      args: r.args ?? null,
      cacheHit: bool(r.cache_hit),
      error: strOrNull(r.error),
    }
  })
}

async function fetchKgForQuery(
  connectionId: string,
  queryId: string,
): Promise<LensKgEvent[]> {
  const res = await runQuery(
    connectionId,
    `SELECT e.evidence_id, e.edge_id, e.node_id, e.graph_id, e.confidence, e.evidence_text, ` +
      `e.source_table::text AS source_table, e.source_pk, e.source_column, e.created_at, ` +
      `ed.predicate AS edge_predicate, ` +
      `ed.subject_node_id AS subj_node_id, ed.object_node_id AS obj_node_id, ` +
      `sn.kind AS subj_kind, sn.label AS subj_label, ` +
      `obn.kind AS obj_kind, obn.label AS obj_label, ` +
      `nn.kind AS node_kind, nn.label AS node_label ` +
      `FROM rvbbit.kg_evidence e ` +
      `LEFT JOIN rvbbit.kg_edges ed ON ed.edge_id = e.edge_id ` +
      `LEFT JOIN rvbbit.kg_nodes sn ON sn.node_id = ed.subject_node_id ` +
      `LEFT JOIN rvbbit.kg_nodes obn ON obn.node_id = ed.object_node_id ` +
      `LEFT JOIN rvbbit.kg_nodes nn ON nn.node_id = e.node_id ` +
      `WHERE e.query_id = ${sqlStr(queryId)}::uuid ` +
      `ORDER BY e.created_at`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    const at = epoch(r.created_at)
    // For an edge-evidence row, prefer the subject/predicate/object display.
    // For a node-evidence row, fall back to the node fields.
    const isEdge = r.edge_id != null
    return {
      id: `kg:${r.evidence_id}`,
      surface: "kg_write" as const,
      linkage: "linked" as const,
      startAt: at,
      endAt: at,
      durationMs: 0,
      evidenceId: num(r.evidence_id),
      edgeId: numOrNull(r.edge_id),
      nodeId: numOrNull(r.node_id),
      graphId: strOrNull(r.graph_id),
      // For a node-evidence row, the "subject" is the node itself; the
      // "object" is N/A. For an edge-evidence row, both are populated.
      subjectNodeId: isEdge ? numOrNull(r.subj_node_id) : numOrNull(r.node_id),
      objectNodeId: isEdge ? numOrNull(r.obj_node_id) : null,
      subjectKind: isEdge ? strOrNull(r.subj_kind) : strOrNull(r.node_kind),
      subjectLabel: isEdge ? strOrNull(r.subj_label) : strOrNull(r.node_label),
      predicate: isEdge ? strOrNull(r.edge_predicate) : null,
      objectKind: isEdge ? strOrNull(r.obj_kind) : null,
      objectLabel: isEdge ? strOrNull(r.obj_label) : null,
      confidence: numOrNull(r.confidence),
      evidenceText: strOrNull(r.evidence_text),
      sourceTable: strOrNull(r.source_table),
      sourcePk: strOrNull(r.source_pk),
      sourceColumn: strOrNull(r.source_column),
    }
  })
}

async function fetchRoutingInWindow(
  connectionId: string,
  startAt: number,
  endAt: number,
): Promise<{
  decisions: LensRouteDecisionEvent[]
  executions: LensRouteExecutionEvent[]
}> {
  const startIso = new Date(startAt - TIME_BUFFER_MS).toISOString()
  const endIso = new Date(endAt + TIME_BUFFER_MS).toISOString()
  const decRes = await runQuery(
    connectionId,
    `SELECT id, candidate, route, route_source, reason, confidence, cache_hit, ` +
      `shape_family, decided_at FROM rvbbit.route_decisions ` +
      `WHERE decided_at BETWEEN ${sqlStr(startIso)}::timestamptz AND ${sqlStr(endIso)}::timestamptz ` +
      `ORDER BY decided_at`,
  )
  const execRes = await runQuery(
    connectionId,
    `SELECT id, candidate, route_source, reason, rows_returned, cache_hit, status, ` +
      `shape_family, elapsed_ms, executed_at FROM rvbbit.route_executions ` +
      `WHERE executed_at BETWEEN ${sqlStr(startIso)}::timestamptz AND ${sqlStr(endIso)}::timestamptz ` +
      `ORDER BY executed_at`,
  )
  const decisions: LensRouteDecisionEvent[] = decRes.ok
    ? decRes.rows.map((r) => {
        const at = epoch(r.decided_at)
        return {
          id: `dec:${r.id}`,
          surface: "route_decision" as const,
          linkage: "time" as const,
          startAt: at,
          endAt: at,
          durationMs: 0,
          decisionId: num(r.id),
          candidate: String(r.candidate ?? ""),
          route: String(r.route ?? ""),
          routeSource: String(r.route_source ?? ""),
          reason: String(r.reason ?? ""),
          confidence: numOrNull(r.confidence),
          cacheHit: bool(r.cache_hit),
          shapeFamily: String(r.shape_family ?? ""),
        }
      })
    : []
  const executions: LensRouteExecutionEvent[] = execRes.ok
    ? execRes.rows.map((r) => {
        const at = epoch(r.executed_at)
        const dur = num(r.elapsed_ms)
        return {
          id: `exec:${r.id}`,
          surface: "route_execution" as const,
          linkage: "time" as const,
          startAt: at,
          endAt: at + dur,
          durationMs: dur,
          executionId: num(r.id),
          candidate: String(r.candidate ?? ""),
          routeSource: String(r.route_source ?? ""),
          rowsReturned: num(r.rows_returned),
          cacheHit: bool(r.cache_hit),
          status: String(r.status ?? ""),
          shapeFamily: String(r.shape_family ?? ""),
          reason: String(r.reason ?? ""),
        }
      })
    : []
  return { decisions, executions }
}

/**
 * Pull every event linked to (or co-occurring with) a query_id, sort
 * chronologically, and compute summary stats.
 */
export async function fetchLensTrace(
  connectionId: string,
  queryId: string,
): Promise<{ trace: LensTrace | null; error?: string }> {
  if (!queryId.trim()) return { trace: null, error: "no query_id" }
  const [receipts, mcpEvents, kgEvents] = await Promise.all([
    fetchReceiptsForQuery(connectionId, queryId),
    fetchMcpForQuery(connectionId, queryId),
    fetchKgForQuery(connectionId, queryId),
  ])

  const receiptEvents: LensReceiptEvent[] = []
  const subcallEvents: LensSubcallEvent[] = []
  for (const r of receipts) {
    const startAt = epoch(r.invocation_at)
    const dur = r.latency_ms
    receiptEvents.push({
      id: `rcpt:${r.receipt_id}`,
      surface: "receipt",
      linkage: "linked",
      startAt,
      endAt: startAt + dur,
      durationMs: dur,
      receiptId: r.receipt_id,
      operator: r.operator,
      model: r.model,
      tokensIn: r.n_tokens_in,
      tokensOut: r.n_tokens_out,
      costUsd: r.cost_usd,
      error: r.error,
      takeIndex: r.take_index,
      takeVerdict: r.take_verdict,
      subCallCount: r.sub_calls?.length ?? 0,
    })
    // Stack sub_calls sequentially within the receipt (approximation —
    // concurrent ensembles overlap in reality but render readably here).
    const subs = r.sub_calls ?? []
    let cursor = startAt
    for (let i = 0; i < subs.length; i += 1) {
      const s = subs[i]
      const sd = num(s.latency_ms)
      subcallEvents.push({
        id: `sub:${r.receipt_id}:${i}`,
        surface: "subcall",
        linkage: "linked",
        startAt: cursor,
        endAt: cursor + sd,
        durationMs: sd,
        receiptId: r.receipt_id,
        step: String(s.step ?? ""),
        kind: String(s.kind ?? ""),
        model: s.model != null ? String(s.model) : null,
        tokensIn: num(s.tokens_in),
        tokensOut: num(s.tokens_out),
        error: s.error == null ? null : String(s.error),
        index: i,
      })
      cursor += sd
    }
  }

  const linkedEvents: LensEvent[] = [
    ...receiptEvents,
    ...subcallEvents,
    ...mcpEvents,
    ...kgEvents,
  ]
  if (linkedEvents.length === 0) {
    return {
      trace: {
        queryId,
        events: [],
        span: { min: 0, max: 0, durationMs: 0 },
        counts: {
          receipt: 0,
          subcall: 0,
          mcp: 0,
          route_decision: 0,
          route_execution: 0,
          kg_write: 0,
        },
        totalCostUsd: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalReceiptLatencyMs: 0,
        errorCount: 0,
        cacheHitCount: 0,
      },
    }
  }

  const spanMin = Math.min(...linkedEvents.map((e) => e.startAt))
  const spanMax = Math.max(...linkedEvents.map((e) => e.endAt))

  const { decisions, executions } = await fetchRoutingInWindow(connectionId, spanMin, spanMax)

  const all: LensEvent[] = [...linkedEvents, ...decisions, ...executions].sort(
    (a, b) => a.startAt - b.startAt,
  )

  const counts: Record<LensSurface, number> = {
    receipt: receiptEvents.length,
    subcall: subcallEvents.length,
    mcp: mcpEvents.length,
    route_decision: decisions.length,
    route_execution: executions.length,
    kg_write: kgEvents.length,
  }
  const totalReceiptLatencyMs = receiptEvents.reduce((s, e) => s + e.durationMs, 0)
  const totalCostUsd = receiptEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0)
  const totalTokensIn = receiptEvents.reduce((s, e) => s + e.tokensIn, 0)
  const totalTokensOut = receiptEvents.reduce((s, e) => s + e.tokensOut, 0)
  const errorCount =
    receiptEvents.filter((e) => e.error).length +
    subcallEvents.filter((e) => e.error).length +
    mcpEvents.filter((e) => e.error).length
  const cacheHitCount = mcpEvents.filter((e) => e.cacheHit).length

  return {
    trace: {
      queryId,
      events: all,
      span: { min: spanMin, max: spanMax, durationMs: spanMax - spanMin },
      counts,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      totalReceiptLatencyMs,
      errorCount,
      cacheHitCount,
    },
  }
}

// ── Overview (empty-state dashboard) ────────────────────────────────

/**
 * Cross-receipt rollup the Lens shows when no specific query is
 * selected — answers "what's happening across all my queries lately?"
 * without naming any one of them. Bounded by `hours` (default 24h).
 *
 * One bundled fetch (four small aggregates) keeps the empty-state
 * dashboard render to a single round-trip.
 */
export interface LensOverviewHourlyPoint {
  hour: number
  receipts: number
  queries: number
  cost: number
  tokens: number
  errors: number
}

export interface LensOverviewOperator {
  operator: string
  calls: number
  errors: number
  cost: number
  p95: number
}

export interface LensOverviewTopQuery {
  queryId: string
  receipts: number
  operators: string[]
  cost: number
  totalLatencyMs: number
  lastAt: number
  errorCount: number
}

export interface LensOverview {
  windowHours: number
  /** epoch ms of the window's start (now - hours). */
  windowStart: number
  hero: {
    queries: number
    receipts: number
    totalCostUsd: number
    totalTokensIn: number
    totalTokensOut: number
    avgLatencyMs: number
    errors: number
    operatorCount: number
  }
  hourly: LensOverviewHourlyPoint[]
  topOperators: LensOverviewOperator[]
  topQueries: LensOverviewTopQuery[]
}

export async function fetchLensOverview(
  connectionId: string,
  hours: number = 24,
): Promise<{ overview: LensOverview | null; error?: string }> {
  const h = Math.max(1, Math.min(720, hours))
  const windowExpr = `now() - interval '${h} hours'`

  const [heroRes, hourlyRes, opsRes, queriesRes] = await Promise.all([
    runQuery(
      connectionId,
      `SELECT
         count(DISTINCT query_id) FILTER (WHERE query_id IS NOT NULL) AS n_queries,
         count(*) AS n_receipts,
         coalesce(sum(cost_usd), 0)::float AS total_cost,
         coalesce(sum(n_tokens_in), 0)::bigint AS tokens_in,
         coalesce(sum(n_tokens_out), 0)::bigint AS tokens_out,
         coalesce(avg(latency_ms), 0)::int AS avg_latency_ms,
         count(*) FILTER (WHERE error IS NOT NULL) AS errors,
         count(DISTINCT operator) AS n_operators
       FROM rvbbit.receipts
       WHERE invocation_at > ${windowExpr}`,
    ),
    runQuery(
      connectionId,
      // generate_series → LEFT JOIN guarantees a row per hour so the
      // bar chart always renders the full window even with sparse data.
      `WITH hours AS (
         SELECT generate_series(
           date_trunc('hour', ${windowExpr}),
           date_trunc('hour', now()),
           interval '1 hour'
         ) AS hour
       )
       SELECT
         h.hour,
         count(r.*) AS receipts,
         count(DISTINCT r.query_id) FILTER (WHERE r.query_id IS NOT NULL) AS queries,
         coalesce(sum(r.cost_usd), 0)::float AS cost,
         coalesce(sum(r.n_tokens_in + r.n_tokens_out), 0)::bigint AS tokens,
         coalesce(count(*) FILTER (WHERE r.error IS NOT NULL), 0) AS errors
       FROM hours h
       LEFT JOIN rvbbit.receipts r
         ON date_trunc('hour', r.invocation_at) = h.hour
       GROUP BY h.hour
       ORDER BY h.hour`,
    ),
    runQuery(
      connectionId,
      `SELECT
         operator,
         count(*) AS n_calls,
         count(*) FILTER (WHERE error IS NOT NULL) AS n_errors,
         coalesce(sum(cost_usd), 0)::float AS total_cost,
         coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95
       FROM rvbbit.receipts
       WHERE invocation_at > ${windowExpr}
       GROUP BY operator
       ORDER BY n_calls DESC
       LIMIT 12`,
    ),
    runQuery(
      connectionId,
      `SELECT
         query_id::text AS qid,
         count(*) AS n_receipts,
         array_agg(DISTINCT operator) AS ops,
         coalesce(sum(cost_usd), 0)::float AS total_cost,
         sum(latency_ms) AS total_ms,
         max(invocation_at) AS last_at,
         count(*) FILTER (WHERE error IS NOT NULL) AS errors
       FROM rvbbit.receipts
       WHERE query_id IS NOT NULL
         AND invocation_at > ${windowExpr}
       GROUP BY query_id
       ORDER BY total_cost DESC NULLS LAST, total_ms DESC
       LIMIT 12`,
    ),
  ])

  // If the hero query fails, treat the whole overview as failed —
  // every other panel hangs off it. Other panel failures degrade
  // gracefully to empty.
  if (!heroRes.ok) return { overview: null, error: heroRes.error }
  const heroRow = heroRes.rows[0] ?? {}

  const hourly: LensOverviewHourlyPoint[] = hourlyRes.ok
    ? hourlyRes.rows.map((r) => ({
        hour: epoch(r.hour),
        receipts: num(r.receipts),
        queries: num(r.queries),
        cost: num(r.cost),
        tokens: num(r.tokens),
        errors: num(r.errors),
      }))
    : []

  const topOperators: LensOverviewOperator[] = opsRes.ok
    ? opsRes.rows.map((r) => ({
        operator: String(r.operator ?? ""),
        calls: num(r.n_calls),
        errors: num(r.n_errors),
        cost: num(r.total_cost),
        p95: num(r.p95),
      }))
    : []

  const topQueries: LensOverviewTopQuery[] = queriesRes.ok
    ? queriesRes.rows.map((r) => ({
        queryId: String(r.qid ?? ""),
        receipts: num(r.n_receipts),
        operators: Array.isArray(r.ops) ? (r.ops as string[]) : [],
        cost: num(r.total_cost),
        totalLatencyMs: num(r.total_ms),
        lastAt: epoch(r.last_at),
        errorCount: num(r.errors),
      }))
    : []

  return {
    overview: {
      windowHours: h,
      windowStart: Date.now() - h * 3_600_000,
      hero: {
        queries: num(heroRow.n_queries),
        receipts: num(heroRow.n_receipts),
        totalCostUsd: num(heroRow.total_cost),
        totalTokensIn: num(heroRow.tokens_in),
        totalTokensOut: num(heroRow.tokens_out),
        avgLatencyMs: num(heroRow.avg_latency_ms),
        errors: num(heroRow.errors),
        operatorCount: num(heroRow.n_operators),
      },
      hourly,
      topOperators,
      topQueries,
    },
  }
}

// ── Display helpers ─────────────────────────────────────────────────

export const SURFACE_LABEL: Record<LensSurface, string> = {
  receipt: "receipt",
  subcall: "sub-call",
  mcp: "mcp call",
  route_decision: "route decision",
  route_execution: "route execution",
  kg_write: "kg write",
}

export const SURFACE_COLOR: Record<LensSurface, string> = {
  receipt: "var(--rvbbit-accent)",
  subcall: "var(--chart-2)",
  mcp: "var(--brand-mcp)",
  route_decision: "var(--brand-routing)",
  route_execution: "var(--chart-4)",
  kg_write: "var(--info)",
}

/**
 * A short one-liner identity for an event — the bold label rendered in
 * the timeline. Stable across surfaces.
 */
export function eventIdentity(e: LensEvent): string {
  switch (e.surface) {
    case "receipt":
      return `rvbbit.${e.operator}${e.takeIndex != null ? ` · take ${e.takeIndex}` : ""}`
    case "subcall":
      return `${e.step || "?"} · ${e.kind}${e.model ? ` · ${e.model}` : ""}`
    case "mcp":
      return `${e.server}.${e.tool}`
    case "route_decision":
      return `${e.routeSource} → ${e.candidate}`
    case "route_execution":
      return `${e.candidate} ran`
    case "kg_write":
      if (e.predicate) {
        const subj = e.subjectLabel ?? "?"
        const obj = e.objectLabel ?? "?"
        return `${subj} —[${e.predicate}]→ ${obj}`
      }
      if (e.subjectLabel) return `${e.subjectKind ?? "node"}: ${e.subjectLabel}`
      return "knowledge graph write"
  }
}
