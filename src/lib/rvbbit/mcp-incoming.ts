"use client"

export type McpIncomingRange = "24h" | "7d" | "30d"

export interface McpIncomingOverview {
  calls: number
  callers: number
  tools: number
  objects: number
  errors: number
  sqlCalls: number
  rowsReturned: number
  avgMs: number | null
  p95Ms: number | null
  lastSeen: number | null
}

export interface McpIncomingActivity {
  id: number
  ts: number | null
  caller: string | null
  clientId: string | null
  actor: string
  tool: string
  args: Record<string, unknown>
  ok: boolean | null
  error: Record<string, unknown> | null
  objects: string[]
  rows: number | null
  engine: string | null
  elapsedMs: number | null
  asOf: string | null
  resultSummary: Record<string, unknown> | null
  sql: string | null
  subject: string | null
  errorCode: string | null
  errorMessage: string | null
}

export interface McpIncomingCaller {
  actor: string
  caller: string | null
  clientId: string | null
  calls: number
  errors: number
  sqlCalls: number
  rowsReturned: number
  avgMs: number | null
  lastSeen: number | null
  topTool: string | null
}

export interface McpIncomingTool {
  tool: string
  calls: number
  errors: number
  sqlCalls: number
  rowsReturned: number
  avgMs: number | null
  p95Ms: number | null
  callers: number
  lastSeen: number | null
}

export interface McpIncomingObject {
  object: string
  touches: number
  callers: number
  tools: number
  errors: number
  lastTouch: number | null
}

export interface McpIncomingError {
  tool: string
  code: string
  message: string
  calls: number
  callers: number
  lastSeen: number | null
  sampleSql: string | null
}

export interface McpIncomingBucket {
  bucket: number | null
  calls: number
  errors: number
  sqlCalls: number
}

export interface McpIncomingSnapshot {
  detected: boolean
  range: McpIncomingRange
  overview: McpIncomingOverview
  activities: McpIncomingActivity[]
  callers: McpIncomingCaller[]
  tools: McpIncomingTool[]
  objects: McpIncomingObject[]
  errors: McpIncomingError[]
  buckets: McpIncomingBucket[]
  error?: string
}

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}

interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string, rowLimit = 1000): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, readOnly: true, poolLane: "meta" }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function rangeSql(range: McpIncomingRange): string {
  switch (range) {
    case "24h": return "interval '24 hours'"
    case "7d": return "interval '7 days'"
    case "30d": return "interval '30 days'"
  }
}

function bucketSeconds(range: McpIncomingRange): number {
  switch (range) {
    case "24h": return 60 * 60
    case "7d": return 6 * 60 * 60
    case "30d": return 24 * 60 * 60
  }
}

export async function fetchMcpIncomingSnapshot(
  connectionId: string,
  range: McpIncomingRange = "24h",
): Promise<McpIncomingSnapshot> {
  const exists = await runQuery(
    connectionId,
    "SELECT to_regclass('rvbbit.mcp_activity') IS NOT NULL AS detected",
    1,
  )
  if (!exists.ok) return emptySnapshot(range, false, exists.error)
  if (!bool(exists.rows[0]?.detected)) return emptySnapshot(range, false)

  const interval = rangeSql(range)
  const step = bucketSeconds(range)
  const [overview, activities, callers, tools, objects, errors, buckets] = await Promise.all([
    fetchOverview(connectionId, interval),
    fetchActivities(connectionId, interval),
    fetchCallers(connectionId, interval),
    fetchTools(connectionId, interval),
    fetchObjects(connectionId, interval),
    fetchErrors(connectionId, interval),
    fetchBuckets(connectionId, interval, step),
  ])

  const firstErr = [overview, activities, callers, tools, objects, errors, buckets].find((r) => !r.ok)
  return {
    detected: true,
    range,
    overview: overview.ok ? overview.value : emptyOverview(),
    activities: activities.ok ? activities.value : [],
    callers: callers.ok ? callers.value : [],
    tools: tools.ok ? tools.value : [],
    objects: objects.ok ? objects.value : [],
    errors: errors.ok ? errors.value : [],
    buckets: buckets.ok ? buckets.value : [],
    error: firstErr && !firstErr.ok ? firstErr.error : undefined,
  }
}

type FetchResult<T> = { ok: true; value: T } | { ok: false; error: string }

async function fetchOverview(connectionId: string, interval: string): Promise<FetchResult<McpIncomingOverview>> {
  const res = await runQuery(
    connectionId,
    `WITH base AS (
       SELECT *
       FROM rvbbit.mcp_activity
       WHERE ts >= now() - ${interval}
     )
     SELECT count(*)::bigint AS calls,
            count(DISTINCT coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous'))::bigint AS callers,
            count(DISTINCT tool)::bigint AS tools,
            coalesce((
              SELECT count(DISTINCT obj)::bigint
              FROM base b
              CROSS JOIN LATERAL unnest(coalesce(b.objects, ARRAY[]::text[])) AS obj
            ), 0)::bigint AS objects,
            count(*) FILTER (WHERE ok IS FALSE)::bigint AS errors,
            count(*) FILTER (WHERE coalesce(args, '{}'::jsonb) ? 'sql')::bigint AS sql_calls,
            coalesce(sum(rows), 0)::bigint AS rows_returned,
            round(avg(elapsed_ms))::bigint AS avg_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE elapsed_ms IS NOT NULL) AS p95_ms,
            max(ts) AS last_seen
     FROM base`,
    1,
  )
  if (!res.ok) return res
  const r = res.rows[0] ?? {}
  return {
    ok: true,
    value: {
      calls: num(r.calls),
      callers: num(r.callers),
      tools: num(r.tools),
      objects: num(r.objects),
      errors: num(r.errors),
      sqlCalls: num(r.sql_calls),
      rowsReturned: num(r.rows_returned),
      avgMs: numOrNull(r.avg_ms),
      p95Ms: numOrNull(r.p95_ms),
      lastSeen: epoch(r.last_seen),
    },
  }
}

async function fetchActivities(connectionId: string, interval: string): Promise<FetchResult<McpIncomingActivity[]>> {
  const res = await runQuery(
    connectionId,
    `SELECT id,
            ts,
            caller,
            client_id,
            coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous') AS actor,
            tool,
            coalesce(args, '{}'::jsonb) AS args,
            ok,
            error,
            coalesce(objects, ARRAY[]::text[]) AS objects,
            rows,
            engine,
            elapsed_ms,
            as_of,
            result_summary,
            args->>'sql' AS sql,
            CASE
              WHEN coalesce(args, '{}'::jsonb) ? 'query' THEN args->>'query'
              WHEN coalesce(args, '{}'::jsonb) ? 'metric' THEN args->>'metric'
              WHEN coalesce(args, '{}'::jsonb) ? 'name' THEN args->>'name'
              WHEN coalesce(args, '{}'::jsonb) ? 'table' THEN args->>'table'
              WHEN coalesce(args, '{}'::jsonb) ? 'dashboard' THEN args->>'dashboard'
              WHEN coalesce(args, '{}'::jsonb) ? 'subject' THEN args->>'subject'
              WHEN coalesce(args, '{}'::jsonb) ? 'sql' THEN left(regexp_replace(args->>'sql', '\\s+', ' ', 'g'), 240)
              WHEN array_length(objects, 1) > 0 THEN array_to_string(objects, ', ')
              ELSE NULL
            END AS subject,
            error->>'code' AS error_code,
            error->>'message' AS error_message
     FROM rvbbit.mcp_activity
     WHERE ts >= now() - ${interval}
     ORDER BY ts DESC NULLS LAST, id DESC
     LIMIT 500`,
    500,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      id: num(r.id),
      ts: epoch(r.ts),
      caller: strOrNull(r.caller),
      clientId: strOrNull(r.client_id),
      actor: str(r.actor) || "anonymous",
      tool: str(r.tool) || "(unknown)",
      args: asObject(r.args),
      ok: boolOrNull(r.ok),
      error: r.error == null ? null : asObject(r.error),
      objects: asStringArray(r.objects),
      rows: numOrNull(r.rows),
      engine: strOrNull(r.engine),
      elapsedMs: numOrNull(r.elapsed_ms),
      asOf: strOrNull(r.as_of),
      resultSummary: r.result_summary == null ? null : asObject(r.result_summary),
      sql: strOrNull(r.sql),
      subject: strOrNull(r.subject),
      errorCode: strOrNull(r.error_code),
      errorMessage: strOrNull(r.error_message),
    })),
  }
}

async function fetchCallers(connectionId: string, interval: string): Promise<FetchResult<McpIncomingCaller[]>> {
  const res = await runQuery(
    connectionId,
    `WITH base AS (
       SELECT *,
              coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous') AS actor
       FROM rvbbit.mcp_activity
       WHERE ts >= now() - ${interval}
     ),
     grouped AS (
       SELECT actor,
              max(caller) FILTER (WHERE caller IS NOT NULL AND caller <> '') AS caller,
              max(client_id) FILTER (WHERE client_id IS NOT NULL AND client_id <> '') AS client_id,
              count(*)::bigint AS calls,
              count(*) FILTER (WHERE ok IS FALSE)::bigint AS errors,
              count(*) FILTER (WHERE coalesce(args, '{}'::jsonb) ? 'sql')::bigint AS sql_calls,
              coalesce(sum(rows), 0)::bigint AS rows_returned,
              round(avg(elapsed_ms))::bigint AS avg_ms,
              max(ts) AS last_seen
       FROM base
       GROUP BY actor
     ),
     top_tool AS (
       SELECT DISTINCT ON (actor) actor, tool
       FROM (
         SELECT actor, tool, count(*) AS calls
         FROM base
         GROUP BY actor, tool
       ) x
       ORDER BY actor, calls DESC, tool
     )
     SELECT grouped.*, top_tool.tool AS top_tool
     FROM grouped
     LEFT JOIN top_tool USING (actor)
     ORDER BY grouped.calls DESC, grouped.last_seen DESC NULLS LAST
     LIMIT 50`,
    50,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      actor: str(r.actor) || "anonymous",
      caller: strOrNull(r.caller),
      clientId: strOrNull(r.client_id),
      calls: num(r.calls),
      errors: num(r.errors),
      sqlCalls: num(r.sql_calls),
      rowsReturned: num(r.rows_returned),
      avgMs: numOrNull(r.avg_ms),
      lastSeen: epoch(r.last_seen),
      topTool: strOrNull(r.top_tool),
    })),
  }
}

async function fetchTools(connectionId: string, interval: string): Promise<FetchResult<McpIncomingTool[]>> {
  const res = await runQuery(
    connectionId,
    `SELECT tool,
            count(*)::bigint AS calls,
            count(*) FILTER (WHERE ok IS FALSE)::bigint AS errors,
            count(*) FILTER (WHERE coalesce(args, '{}'::jsonb) ? 'sql')::bigint AS sql_calls,
            coalesce(sum(rows), 0)::bigint AS rows_returned,
            round(avg(elapsed_ms))::bigint AS avg_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY elapsed_ms) FILTER (WHERE elapsed_ms IS NOT NULL) AS p95_ms,
            count(DISTINCT coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous'))::bigint AS callers,
            max(ts) AS last_seen
     FROM rvbbit.mcp_activity
     WHERE ts >= now() - ${interval}
     GROUP BY tool
     ORDER BY calls DESC, last_seen DESC NULLS LAST
     LIMIT 50`,
    50,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      tool: str(r.tool) || "(unknown)",
      calls: num(r.calls),
      errors: num(r.errors),
      sqlCalls: num(r.sql_calls),
      rowsReturned: num(r.rows_returned),
      avgMs: numOrNull(r.avg_ms),
      p95Ms: numOrNull(r.p95_ms),
      callers: num(r.callers),
      lastSeen: epoch(r.last_seen),
    })),
  }
}

async function fetchObjects(connectionId: string, interval: string): Promise<FetchResult<McpIncomingObject[]>> {
  const res = await runQuery(
    connectionId,
    `WITH base AS (
       SELECT *
       FROM rvbbit.mcp_activity
       WHERE ts >= now() - ${interval}
     ),
     exploded AS (
       SELECT obj AS object,
              coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous') AS actor,
              tool,
              ok,
              ts
       FROM base
       CROSS JOIN LATERAL unnest(coalesce(objects, ARRAY[]::text[])) AS obj
     )
     SELECT object,
            count(*)::bigint AS touches,
            count(DISTINCT actor)::bigint AS callers,
            count(DISTINCT tool)::bigint AS tools,
            count(*) FILTER (WHERE ok IS FALSE)::bigint AS errors,
            max(ts) AS last_touch
     FROM exploded
     GROUP BY object
     ORDER BY touches DESC, last_touch DESC NULLS LAST
     LIMIT 80`,
    80,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      object: str(r.object),
      touches: num(r.touches),
      callers: num(r.callers),
      tools: num(r.tools),
      errors: num(r.errors),
      lastTouch: epoch(r.last_touch),
    })),
  }
}

async function fetchErrors(connectionId: string, interval: string): Promise<FetchResult<McpIncomingError[]>> {
  const res = await runQuery(
    connectionId,
    `SELECT tool,
            coalesce(nullif(error->>'code', ''), 'ERROR') AS code,
            left(coalesce(nullif(error->>'message', ''), error::text, 'call failed'), 280) AS message,
            count(*)::bigint AS calls,
            count(DISTINCT coalesce(nullif(caller, ''), nullif(client_id, ''), 'anonymous'))::bigint AS callers,
            max(ts) AS last_seen,
            (array_agg(args->>'sql' ORDER BY ts DESC NULLS LAST, id DESC) FILTER (WHERE args ? 'sql'))[1] AS sample_sql
     FROM rvbbit.mcp_activity
     WHERE ts >= now() - ${interval}
       AND ok IS FALSE
     GROUP BY tool, code, message
     ORDER BY calls DESC, last_seen DESC NULLS LAST
     LIMIT 50`,
    50,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      tool: str(r.tool) || "(unknown)",
      code: str(r.code) || "ERROR",
      message: str(r.message) || "call failed",
      calls: num(r.calls),
      callers: num(r.callers),
      lastSeen: epoch(r.last_seen),
      sampleSql: strOrNull(r.sample_sql),
    })),
  }
}

async function fetchBuckets(connectionId: string, interval: string, seconds: number): Promise<FetchResult<McpIncomingBucket[]>> {
  const res = await runQuery(
    connectionId,
    `SELECT to_timestamp(floor(extract(epoch FROM ts) / ${seconds}) * ${seconds}) AS bucket,
            count(*)::bigint AS calls,
            count(*) FILTER (WHERE ok IS FALSE)::bigint AS errors,
            count(*) FILTER (WHERE coalesce(args, '{}'::jsonb) ? 'sql')::bigint AS sql_calls
     FROM rvbbit.mcp_activity
     WHERE ts >= now() - ${interval}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    1000,
  )
  if (!res.ok) return res
  return {
    ok: true,
    value: res.rows.map((r) => ({
      bucket: epoch(r.bucket),
      calls: num(r.calls),
      errors: num(r.errors),
      sqlCalls: num(r.sql_calls),
    })),
  }
}

function emptySnapshot(range: McpIncomingRange, detected: boolean, error?: string): McpIncomingSnapshot {
  return {
    detected,
    range,
    overview: emptyOverview(),
    activities: [],
    callers: [],
    tools: [],
    objects: [],
    errors: [],
    buckets: [],
    error,
  }
}

function emptyOverview(): McpIncomingOverview {
  return {
    calls: 0,
    callers: 0,
    tools: 0,
    objects: 0,
    errors: 0,
    sqlCalls: 0,
    rowsReturned: 0,
    avgMs: null,
    p95Ms: null,
    lastSeen: null,
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === "string") {
    return value
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter(Boolean)
  }
  return []
}

function epoch(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000
    return Number.isFinite(ms) ? ms : null
  }
  const t = new Date(String(value)).getTime()
  return Number.isFinite(t) ? t : null
}

function num(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string {
  return value == null ? "" : String(value)
}

function strOrNull(value: unknown): string | null {
  if (value == null) return null
  const s = String(value)
  return s.length ? s : null
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === 1 || value === "1"
}

function boolOrNull(value: unknown): boolean | null {
  if (value == null) return null
  return bool(value)
}
