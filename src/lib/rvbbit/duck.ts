"use client"

/**
 * Client-side model for the rvbbit-duck sidecar broker telemetry — the
 * Duck/Vortex execution layer. Pure SQL against the `rvbbit.duck_sidecar_*`
 * views (no separate sidecar REST API).
 *
 * Spec: ../rvbbit-sql/docs/RVBBIT_DUCK_UI_CONTRACT.md (pg_rvbbit 0.60.5+).
 *
 * Everything is read-only. Each fetch returns `{ …, error? }`; callers
 * degrade gracefully when the views are missing (older extension).
 */

// ── /api/db/query helper (same shape as sibling modules) ────────────

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
function str(v: unknown): string {
  return v == null ? "" : String(v)
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}
function jsonVal(v: unknown): unknown {
  return v ?? null
}

// ── Capability probe ────────────────────────────────────────────────

export interface DuckCapability {
  available: boolean
  hasLatest: boolean
  hasQueryEvents: boolean
  hasFallbackEvents: boolean
  version: string | null
  error?: string
}

export async function fetchDuckCapability(connectionId: string): Promise<DuckCapability> {
  const res = await runQuery(
    connectionId,
    `SELECT
       to_regclass('rvbbit.duck_sidecar_latest') IS NOT NULL AS has_latest,
       to_regclass('rvbbit.duck_sidecar_query_events') IS NOT NULL AS has_query_events,
       to_regclass('rvbbit.duck_sidecar_fallback_events') IS NOT NULL AS has_fallback_events,
       (SELECT extversion FROM pg_extension WHERE extname = 'pg_rvbbit') AS version`,
  )
  if (!res.ok) {
    return {
      available: false,
      hasLatest: false,
      hasQueryEvents: false,
      hasFallbackEvents: false,
      version: null,
      error: res.error,
    }
  }
  const r = res.rows[0] ?? {}
  const truthy = (v: unknown) => v === true || v === "t" || v === "true"
  const hasLatest = truthy(r.has_latest)
  return {
    available: hasLatest,
    hasLatest,
    hasQueryEvents: truthy(r.has_query_events),
    hasFallbackEvents: truthy(r.has_fallback_events),
    version: strOrNull(r.version),
  }
}

// ── Header aggregate ────────────────────────────────────────────────

export interface DuckHeader {
  instances: number
  online: number
  stale: number
  sharedBrokers: number
  localSidecars: number
  rssBytes: number
  queueDepth: number
  activeWorkers: number
  telemetryDrops: number
  fallbacksLastHour: number
}

export async function fetchDuckHeader(
  connectionId: string,
  hasFallback: boolean,
): Promise<{ header: DuckHeader | null; error?: string }> {
  const fallbackExpr = hasFallback
    ? `(SELECT count(*) FROM rvbbit.duck_sidecar_fallback_events
         WHERE observed_at >= clock_timestamp() - interval '1 hour')`
    : `0`
  const res = await runQuery(
    connectionId,
    `SELECT
       count(*) AS instances,
       count(*) FILTER (WHERE effective_status = 'online') AS online,
       count(*) FILTER (WHERE effective_status = 'stale') AS stale,
       count(*) FILTER (WHERE mode = 'shared_broker') AS shared_brokers,
       count(*) FILTER (WHERE mode = 'local_persistent') AS local_sidecars,
       coalesce(sum(rss_bytes), 0) AS rss_bytes,
       coalesce(sum(queue_depth), 0) AS queue_depth,
       coalesce(sum(active_workers), 0) AS active_workers,
       coalesce(sum(events_dropped), 0) AS telemetry_drops,
       ${fallbackExpr} AS fallbacks_last_hour
     FROM rvbbit.duck_sidecar_latest`,
  )
  if (!res.ok) return { header: null, error: res.error }
  const r = res.rows[0] ?? {}
  return {
    header: {
      instances: num(r.instances),
      online: num(r.online),
      stale: num(r.stale),
      sharedBrokers: num(r.shared_brokers),
      localSidecars: num(r.local_sidecars),
      rssBytes: num(r.rss_bytes),
      queueDepth: num(r.queue_depth),
      activeWorkers: num(r.active_workers),
      telemetryDrops: num(r.telemetry_drops),
      fallbacksLastHour: num(r.fallbacks_last_hour),
    },
  }
}

// ── Instance grid ───────────────────────────────────────────────────

export type DuckStatus = "starting" | "online" | "stale" | "offline" | "error" | string

export interface DuckInstance {
  instanceId: string
  nodeId: string
  hostname: string
  pid: number | null
  mode: string
  engine: string
  layout: string
  status: DuckStatus
  socketPath: string | null
  workerCount: number
  duckThreads: number
  startedAt: number | null
  lastHeartbeatAt: number | null
  queueDepth: number
  activeWorkers: number
  rssBytes: number
  eventsWritten: number
  eventsDropped: number
}

function parseInstance(r: Record<string, unknown>): DuckInstance {
  return {
    instanceId: str(r.instance_id),
    nodeId: str(r.node_id),
    hostname: str(r.hostname),
    pid: numOrNull(r.pid),
    mode: str(r.mode),
    engine: str(r.engine),
    layout: str(r.layout),
    status: str(r.effective_status),
    socketPath: strOrNull(r.socket_path),
    workerCount: num(r.worker_count),
    duckThreads: num(r.duck_threads),
    startedAt: epoch(r.started_at),
    lastHeartbeatAt: epoch(r.last_heartbeat_at),
    queueDepth: num(r.queue_depth),
    activeWorkers: num(r.active_workers),
    rssBytes: num(r.rss_bytes),
    eventsWritten: num(r.events_written),
    eventsDropped: num(r.events_dropped),
  }
}

export async function fetchDuckInstances(
  connectionId: string,
): Promise<{ instances: DuckInstance[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT instance_id, node_id, hostname, pid, mode, engine, layout,
            effective_status, socket_path, worker_count, duck_threads,
            started_at, last_heartbeat_at, queue_depth, active_workers,
            rss_bytes, events_written, events_dropped
     FROM rvbbit.duck_sidecar_latest
     ORDER BY
       CASE effective_status WHEN 'online' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
       node_id, mode, engine, layout, started_at DESC`,
  )
  if (!res.ok) return { instances: [], error: res.error }
  return { instances: res.rows.map(parseInstance) }
}

// ── Query events (live stream + overview derivations) ───────────────

export interface DuckEvent {
  id: number
  observedAt: number | null
  nodeId: string
  mode: string
  engine: string
  layout: string
  workerId: string | null
  status: string
  queryHash: string
  elapsedMs: number
  queueWaitMs: number
  executeMs: number
  rowCount: number
  resultFormat: string | null
  arrowIpcBytes: number | null
  error: string | null
}

function parseEvent(r: Record<string, unknown>): DuckEvent {
  return {
    id: num(r.id),
    observedAt: epoch(r.observed_at),
    nodeId: str(r.node_id),
    mode: str(r.mode),
    engine: str(r.engine),
    layout: str(r.layout),
    workerId: strOrNull(r.worker_id),
    status: str(r.status) || "ok",
    queryHash: str(r.query_hash),
    elapsedMs: num(r.elapsed_ms),
    queueWaitMs: num(r.queue_wait_ms),
    executeMs: num(r.execute_ms),
    rowCount: num(r.row_count),
    resultFormat: strOrNull(r.result_format),
    arrowIpcBytes: numOrNull(r.arrow_ipc_bytes),
    error: strOrNull(r.error),
  }
}

const EVENT_COLS = `id, observed_at, node_id, mode, engine, layout, worker_id,
       status, query_hash,
       round(elapsed_ms::numeric, 1) AS elapsed_ms,
       round(coalesce(queue_wait_ms, 0)::numeric, 1) AS queue_wait_ms,
       round(coalesce(execute_ms, 0)::numeric, 1) AS execute_ms,
       row_count, result_format, arrow_ipc_bytes,
       left(coalesce(error, ''), 200) AS error`

/** Most-recent events — feeds the overview path-mix, activity strip, latency band. */
export async function fetchDuckRecentEvents(
  connectionId: string,
  limit = 300,
): Promise<{ events: DuckEvent[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${EVENT_COLS}
     FROM rvbbit.duck_sidecar_query_events
     ORDER BY id DESC
     LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  )
  if (!res.ok) return { events: [], error: res.error }
  // Return oldest→newest so charts read left→right in time.
  return { events: res.rows.map(parseEvent).reverse() }
}

/** Incremental tail by id cursor for the live stream. Pass 0 for first call. */
export async function fetchDuckEventsSince(
  connectionId: string,
  sinceId: number,
): Promise<{ events: DuckEvent[]; error?: string }> {
  const cursor = Number.isFinite(sinceId) ? sinceId : 0
  const res = await runQuery(
    connectionId,
    cursor > 0
      ? `SELECT ${EVENT_COLS}
         FROM rvbbit.duck_sidecar_query_events
         WHERE id > ${Math.floor(cursor)}
         ORDER BY id ASC
         LIMIT 500`
      : `SELECT * FROM (
           SELECT ${EVENT_COLS}
           FROM rvbbit.duck_sidecar_query_events
           ORDER BY id DESC LIMIT 200
         ) t ORDER BY id ASC`,
  )
  if (!res.ok) return { events: [], error: res.error }
  return { events: res.rows.map(parseEvent) }
}

// ── Event detail drawer (cache / tables / metadata + related) ───────

export interface DuckEventDetail {
  id: number
  observedAt: number | null
  queryHash: string
  status: string
  cache: unknown
  tables: unknown
  metadata: unknown
  error: string | null
}

export async function fetchDuckEventDetail(
  connectionId: string,
  id: number,
): Promise<{ detail: DuckEventDetail | null; related: DuckEvent[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT id, observed_at, query_hash, status, cache, tables, metadata,
            coalesce(error, '') AS error
     FROM rvbbit.duck_sidecar_query_events WHERE id = ${Math.floor(id)} LIMIT 1`,
  )
  if (!res.ok) return { detail: null, related: [], error: res.error }
  const r = res.rows[0]
  if (!r) return { detail: null, related: [] }
  const detail: DuckEventDetail = {
    id: num(r.id),
    observedAt: epoch(r.observed_at),
    queryHash: str(r.query_hash),
    status: str(r.status),
    cache: jsonVal(r.cache),
    tables: jsonVal(r.tables),
    metadata: jsonVal(r.metadata),
    error: strOrNull(r.error) || null,
  }
  let related: DuckEvent[] = []
  if (detail.queryHash) {
    const rel = await runQuery(
      connectionId,
      `SELECT ${EVENT_COLS}
       FROM rvbbit.duck_sidecar_query_events
       WHERE query_hash = '${detail.queryHash.replace(/'/g, "''")}'
       ORDER BY id DESC LIMIT 30`,
    )
    if (rel.ok) related = rel.rows.map(parseEvent)
  }
  return { detail, related }
}

// ── Fallback monitor ────────────────────────────────────────────────

export interface DuckFallback {
  observedAt: number | null
  nodeId: string
  hostname: string
  databaseName: string | null
  roleName: string | null
  engine: string
  layout: string
  socketPath: string | null
  fallbackMode: string | null
  queryHash: string
  reason: string
}

function parseFallback(r: Record<string, unknown>): DuckFallback {
  return {
    observedAt: epoch(r.observed_at),
    nodeId: str(r.node_id),
    hostname: str(r.hostname),
    databaseName: strOrNull(r.database_name),
    roleName: strOrNull(r.role_name),
    engine: str(r.engine),
    layout: str(r.layout),
    socketPath: strOrNull(r.socket_path),
    fallbackMode: strOrNull(r.fallback_mode),
    queryHash: str(r.query_hash),
    reason: str(r.reason),
  }
}

export async function fetchDuckFallbacks(
  connectionId: string,
): Promise<{ fallbacks: DuckFallback[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT observed_at, node_id, hostname, database_name, role_name,
            engine, layout, socket_path, fallback_mode, query_hash,
            left(reason, 240) AS reason
     FROM rvbbit.duck_sidecar_fallback_events
     WHERE observed_at >= clock_timestamp() - interval '24 hours'
     ORDER BY observed_at DESC
     LIMIT 100`,
  )
  if (!res.ok) return { fallbacks: [], error: res.error }
  return { fallbacks: res.rows.map(parseFallback) }
}

// ── Shared severity + formatting helpers ────────────────────────────

export type DuckSeverity = "ok" | "warn" | "error" | "muted"

export function instanceSeverity(i: DuckInstance): DuckSeverity {
  if (i.status === "offline" || i.status === "error") return "error"
  if (i.status === "stale") return "warn"
  if (i.status === "online") return i.eventsDropped > 0 ? "warn" : "ok"
  return "muted"
}

export function instanceStatusText(i: DuckInstance): string {
  if (i.status === "offline" || i.status === "error") return "Offline / error"
  if (i.status === "stale") return "Stale heartbeat"
  if (i.status === "online") return i.eventsDropped > 0 ? "Online · telemetry drops" : "Online"
  if (i.status === "starting") return "Starting"
  return i.status || "unknown"
}

/** IEC byte formatting (KiB/MiB/GiB) for rss / arrow IPC sizes. */
export function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  const u = ["B", "KiB", "MiB", "GiB", "TiB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
