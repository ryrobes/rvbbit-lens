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
