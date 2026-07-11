"use client"

/**
 * Client fetchers for the Fleet window — the read-fleet registry (0136) plus
 * the publication plane (0134/0135). Everything is a live SQL call against
 * rvbbit.* functions; the window is a rendering of these calls, per house
 * religion. Probes and doctors WRITE (they record health on registry rows),
 * so they run readOnly:false.
 */

export interface FleetNode {
  name: string
  endpoint: string
  engine: string
  enabled: boolean
  last_probe_ok: boolean | null
  last_probe_ms: number | null
  last_probe_at: string | null
  last_probe_error: string | null
  added_at: string
  notes: string | null
}

export interface PublishTableState {
  table_name: string
  row_groups: number
  published: number
  evicted: number
  local_generation: number
  publish_enabled: boolean
}

export interface StoreConfig {
  url_prefix: string
  enabled: boolean
}

export interface StoreDoctorReport {
  configured: boolean
  enabled?: boolean
  url_prefix?: string
  ok?: boolean
  put_ms?: number
  head_ms?: number
  delete_ms?: number
  error?: string
  hint?: string
}

export interface ProbeReport {
  name: string
  endpoint: string
  ok: boolean
  probe_ms: number
  error: string | null
}

export interface HareInvocation {
  invoked_at: string
  ok: boolean
  row_count: number | null
  engine_ms: number | null
  server_ms: number | null
  wire_ms: number | null
  total_ms: number | null
  sql: string | null
  error: string | null
}

/** The serverless side of the fleet: a hare has no registry row to probe —
 * it exists only while answering. What we CAN show is the configured
 * endpoint (rvbbit.hare_endpoint) and the invocation ledger, whose timing
 * decomposition (engine vs artifact-fetch vs wire) is the whole targeting
 * story. `available:false` = pre-0140 warehouse. */
export interface HareInfo {
  available: boolean
  endpoint: string | null
  recent: HareInvocation[]
}

const esc = (s: string) => s.replace(/'/g, "''")

async function runQuery(
  connectionId: string,
  sql: string,
  readOnly = true,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 500, readOnly }),
    })
    const body = (await res.json()) as
      | { ok: true; rows: Record<string, unknown>[] }
      | { ok: false; error: string }
    return body
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function jsonCell(row: Record<string, unknown> | undefined): unknown {
  if (!row) return null
  const v = Object.values(row)[0]
  return typeof v === "string" ? JSON.parse(v) : v
}

/** Registry + brain identity in one round trip. `registry:false` = pre-0136. */
export async function fetchFleet(connectionId: string): Promise<{
  registry: boolean
  brain: string
  nodes: FleetNode[]
  error?: string
}> {
  const probe = await runQuery(
    connectionId,
    "SELECT current_database() AS db, to_regclass('rvbbit.fleet_endpoints') IS NOT NULL AS has_registry",
  )
  if (!probe.ok) return { registry: false, brain: "?", nodes: [], error: probe.error }
  const row = probe.rows[0] ?? {}
  const brain = String(row.db ?? "?")
  if (!row.has_registry) return { registry: false, brain, nodes: [] }
  const r = await runQuery(connectionId, "SELECT * FROM rvbbit.fleet")
  if (!r.ok) return { registry: true, brain, nodes: [], error: r.error }
  return { registry: true, brain, nodes: r.rows as unknown as FleetNode[] }
}

export async function fetchPublishState(connectionId: string): Promise<PublishTableState[]> {
  const r = await runQuery(
    connectionId,
    "SELECT table_name, row_groups, published, evicted, local_generation, publish_enabled FROM rvbbit.publish_state ORDER BY row_groups DESC LIMIT 20",
  )
  return r.ok ? (r.rows as unknown as PublishTableState[]) : []
}

export async function fetchStoreConfig(connectionId: string): Promise<StoreConfig | null> {
  const r = await runQuery(
    connectionId,
    "SELECT value->>'url_prefix' AS url_prefix, coalesce((value->>'enabled')::boolean, false) AS enabled FROM rvbbit.settings WHERE key = 'publish_store'",
  )
  if (!r.ok || !r.rows.length) return null
  const row = r.rows[0]
  return { url_prefix: String(row.url_prefix ?? ""), enabled: Boolean(row.enabled) }
}

/** Per-placement workload over the last N hours: total executions, median
 * latency, and hourly buckets (oldest→newest) for spark-bars. 'brain' is a
 * placement like any other; hares appear as 'hare:<endpoint>'. This is what
 * lets the topology show WORK, not just wiring. */
export interface NodeActivity {
  placement: string
  executions: number
  medianMs: number
  buckets: number[]
}

export async function fetchFleetActivity(connectionId: string, hours = 6): Promise<NodeActivity[]> {
  const h = Math.max(1, Math.min(hours, 48))
  const bucketed = (src: string, placement: string, at: string, ms: string, extra: string) =>
    `SELECT ${placement} AS placement, floor(extract(epoch FROM (now() - ${at})) / 3600)::int AS hours_ago, ` +
    `count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ms}) AS median_ms ` +
    `FROM ${src} WHERE ${at} > now() - interval '${h} hours' ${extra} GROUP BY 1, 2`
  const res = await runQuery(
    connectionId,
    bucketed("rvbbit.route_executions", "coalesce(node, 'brain')", "executed_at", "elapsed_ms", "AND status = 'ok'") +
      " UNION ALL " +
      bucketed("rvbbit.hare_invocations", "'hare:' || endpoint", "invoked_at", "total_ms", "AND ok"),
  )
  let rows: Record<string, unknown>[] = []
  if (res.ok) {
    rows = res.rows
  } else {
    // pre-0140 warehouse: no hare ledger — fall back to executions only
    const fallback = await runQuery(
      connectionId,
      bucketed("rvbbit.route_executions", "coalesce(node, 'brain')", "executed_at", "elapsed_ms", "AND status = 'ok'"),
    )
    if (fallback.ok) rows = fallback.rows
  }
  const byPlacement = new Map<string, { total: number; weighted: number; buckets: number[] }>()
  for (const r of rows ?? []) {
    const key = String(r.placement ?? "brain")
    const hoursAgo = Math.max(0, Math.min(h - 1, Number(r.hours_ago ?? 0)))
    const n = Number(r.n ?? 0)
    const median = Number(r.median_ms ?? 0)
    const entry = byPlacement.get(key) ?? { total: 0, weighted: 0, buckets: new Array(h).fill(0) }
    entry.total += n
    entry.weighted += median * n
    entry.buckets[h - 1 - hoursAgo] += n
    byPlacement.set(key, entry)
  }
  return Array.from(byPlacement.entries()).map(([placement, e]) => ({
    placement,
    executions: e.total,
    medianMs: e.total > 0 ? e.weighted / e.total : 0,
    buckets: e.buckets,
  }))
}

export async function fetchHare(connectionId: string): Promise<HareInfo> {
  // Endpoint resolution is layered because ALTER DATABASE ... SET only
  // reaches NEW sessions — a pooled connection may predate it. Session GUC →
  // the database-level setting straight from the catalog → the most recent
  // invocation's endpoint (something demonstrably answered from there).
  const probe = await runQuery(
    connectionId,
    "SELECT coalesce( nullif(current_setting('rvbbit.hare_endpoint', true), ''), " +
      "  (SELECT split_part(s, '=', 2) FROM pg_db_role_setting d " +
      "     JOIN pg_database db ON db.oid = d.setdatabase, unnest(d.setconfig) AS s " +
      "   WHERE db.datname = current_database() AND s LIKE 'rvbbit.hare_endpoint=%' LIMIT 1) " +
      ") AS endpoint, to_regclass('rvbbit.hare_invocations') IS NOT NULL AS has_ledger",
  )
  if (!probe.ok || !probe.rows.length) return { available: false, endpoint: null, recent: [] }
  const row = probe.rows[0]
  const available = Boolean(row.has_ledger)
  let endpoint = row.endpoint ? String(row.endpoint) : null
  if (!available) return { available, endpoint, recent: [] }
  const r = await runQuery(
    connectionId,
    "SELECT invoked_at, endpoint, ok, row_count, round(engine_ms::numeric,1)::float8 AS engine_ms, " +
      "round(server_ms::numeric,1)::float8 AS server_ms, round(wire_ms::numeric,1)::float8 AS wire_ms, " +
      "round(total_ms::numeric,1)::float8 AS total_ms, left(sql, 90) AS sql, left(coalesce(error,''), 140) AS error " +
      "FROM rvbbit.hare_invocations ORDER BY invoked_at DESC LIMIT 8",
  )
  const recent = r.ok ? (r.rows as unknown as (HareInvocation & { endpoint?: string })[]) : []
  if (!endpoint && recent.length > 0 && recent[0].endpoint) {
    endpoint = String(recent[0].endpoint)
  }
  return { available, endpoint, recent }
}

export async function probeNode(connectionId: string, name: string): Promise<ProbeReport | { error: string }> {
  const r = await runQuery(connectionId, `SELECT rvbbit.fleet_probe('${esc(name)}')`, false)
  if (!r.ok) return { error: r.error }
  return jsonCell(r.rows[0]) as ProbeReport
}

export async function storeDoctor(connectionId: string): Promise<StoreDoctorReport | { error: string }> {
  const r = await runQuery(connectionId, "SELECT rvbbit.publish_store_doctor()", false)
  if (!r.ok) return { error: r.error }
  return jsonCell(r.rows[0]) as StoreDoctorReport
}

export async function addNode(
  connectionId: string,
  name: string,
  endpoint: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await runQuery(
    connectionId,
    `SELECT rvbbit.fleet_add('${esc(name)}', '${esc(endpoint)}')`,
    false,
  )
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function removeNode(connectionId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await runQuery(connectionId, `SELECT rvbbit.fleet_remove('${esc(name)}')`, false)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function setNodeEnabled(
  connectionId: string,
  name: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const r = await runQuery(
    connectionId,
    `SELECT rvbbit.fleet_set_enabled('${esc(name)}', ${enabled ? "true" : "false"})`,
    false,
  )
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}
