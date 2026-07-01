"use client"

export const DATA_MOVER_RUNTIME_NAME = "fletch_data_mover"
export const CURRENT_CONNECTION_URI = "rvbbit-current://active"

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
      body: JSON.stringify({ connectionId, sql, rowLimit: 100, poolLane: "meta" }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function truthy(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1 || v === "1"
}

export interface DataMoverAvailability {
  installed: boolean
  ready: boolean
  endpoint: string | null
  status: string | null
  error?: string
}

export async function detectDataMover(connectionId: string): Promise<DataMoverAvailability> {
  const res = await runQuery(
    connectionId,
    `SELECT
       to_regclass('rvbbit.python_runtimes') IS NOT NULL AS has_table,
       (
         SELECT endpoint_url
         FROM rvbbit.python_runtimes
         WHERE name = '${DATA_MOVER_RUNTIME_NAME}'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
       ) AS endpoint,
       (
         SELECT status
         FROM rvbbit.python_runtimes
         WHERE name = '${DATA_MOVER_RUNTIME_NAME}'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
       ) AS status`,
  )
  if (!res.ok) return { installed: false, ready: false, endpoint: null, status: null, error: res.error }
  const row = res.rows[0] ?? {}
  const status = row.status == null ? null : String(row.status)
  const endpoint = row.endpoint == null ? null : String(row.endpoint)
  const installed = truthy(row.has_table) && !!endpoint
  return {
    installed,
    ready: installed && status === "ready",
    endpoint,
    status,
  }
}

export interface DataMoverEndpoint {
  driver: string
  uri: string
}

export interface DataMoverTransferRequest {
  source: DataMoverEndpoint
  destination: DataMoverEndpoint
  dest_table: string
  query: string
  ingest_mode: "create" | "append" | "replace"
  transfer_mode: "batch" | "streaming"
  dry_run?: boolean
  auto_install_drivers?: boolean
  timeout_ms?: number
}

export interface DataMoverProxyResponse<T = unknown> {
  ok: boolean
  installed?: boolean
  result?: T
  error?: string
  endpoint?: string
}

async function dataMoverRequest<T>(
  connectionId: string,
  action: string,
  payload?: unknown,
): Promise<DataMoverProxyResponse<T>> {
  try {
    const res = await fetch("/api/rvbbit/data-mover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, action, payload }),
    })
    return (await res.json()) as DataMoverProxyResponse<T>
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function fetchDataMoverStatus(connectionId: string) {
  return dataMoverRequest(connectionId, "status")
}

export function fetchDataMoverDrivers(connectionId: string) {
  return dataMoverRequest(connectionId, "drivers")
}

export function installDataMoverDriver(connectionId: string, driver: string) {
  return dataMoverRequest(connectionId, "install-driver", { driver })
}

export function probeDataMoverConnection(
  connectionId: string,
  driver: string,
  uri: string,
) {
  return dataMoverRequest(connectionId, "probe", { driver, uri })
}

export function runDataMoverTransfer(
  connectionId: string,
  request: DataMoverTransferRequest,
) {
  return dataMoverRequest(connectionId, "transfer", request)
}
