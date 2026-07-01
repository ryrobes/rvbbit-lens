import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"
import { getConnection } from "@/lib/db/registry"
import type { ConnectionRecord } from "@/lib/db/types"

export const runtime = "nodejs"

const RUNTIME_NAME = "fletch_data_mover"
const CURRENT_URI = "rvbbit-current://active"

interface Body {
  connectionId?: string
  action?: "status" | "drivers" | "install-driver" | "probe" | "transfer"
  payload?: unknown
}

function joinEndpoint(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function sslModeForUri(mode: ConnectionRecord["sslMode"]): string {
  if (mode === "disable" || mode === "prefer" || mode === "require") return mode
  return "require"
}

function hostForUri(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`
  return host
}

function connectionUri(record: ConnectionRecord): string {
  if (record.connectionString?.trim()) return record.connectionString.trim()
  const user = encodeURIComponent(record.user)
  const password = record.password ? `:${encodeURIComponent(record.password)}` : ""
  const host = hostForUri(record.host)
  const database = encodeURIComponent(record.database)
  const sslmode = sslModeForUri(record.sslMode)
  return `postgresql://${user}${password}@${host}:${record.port}/${database}?sslmode=${sslmode}`
}

async function resolveCurrentConnectionUri(connectionId: string): Promise<string> {
  const record = await getConnection(connectionId)
  if (!record) throw new Error("connection not found")
  return connectionUri(record)
}

function replaceCurrentUri(value: unknown, uri: string): unknown {
  if (typeof value === "string") return value === CURRENT_URI ? uri : value
  if (Array.isArray(value)) return value.map((v) => replaceCurrentUri(v, uri))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = replaceCurrentUri(v, uri)
    return out
  }
  return value
}

async function resolveRuntimeEndpoint(connectionId: string): Promise<string | null> {
  const sql = `
    SELECT endpoint_url
    FROM rvbbit.python_runtimes
    WHERE name = '${RUNTIME_NAME}'
      AND status = 'ready'
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1`
  try {
    const result = await executeQuery(connectionId, sql, { rowLimit: 1, poolLane: "meta" })
    const endpoint = result.rows?.[0]?.endpoint_url
    return typeof endpoint === "string" && endpoint.trim() ? endpoint.trim() : null
  } catch {
    return null
  }
}

async function proxy(endpoint: string, path: string, method: "GET" | "POST", payload?: unknown) {
  const res = await fetch(joinEndpoint(endpoint, path), {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // keep text body
  }
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, installed: true, error: typeof body === "object" && body && "detail" in body ? String((body as { detail: unknown }).detail) : text },
      { status: 200 },
    )
  }
  return NextResponse.json({ ok: true, installed: true, result: body })
}

async function proxyWithFallback(endpoint: string, path: string, method: "GET" | "POST", payload?: unknown) {
  try {
    return await proxy(endpoint, path, method, payload)
  } catch (err) {
    const fallback =
      process.env.RVBBIT_FLETCH_DATA_MOVER_URL ||
      `http://127.0.0.1:${process.env.RVBBIT_FLETCH_DATA_MOVER_PORT || "9181"}`
    if (fallback && fallback !== endpoint) {
      try {
        return await proxy(fallback, path, method, payload)
      } catch {
        // report the original error below
      }
    }
    return NextResponse.json(
      {
        ok: false,
        installed: true,
        error: err instanceof Error ? err.message : String(err),
        endpoint,
      },
      { status: 200 },
    )
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.connectionId || !body.action) {
    return NextResponse.json({ ok: false, error: "connectionId and action required" }, { status: 400 })
  }

  const endpoint = await resolveRuntimeEndpoint(body.connectionId)
  if (!endpoint) {
    return NextResponse.json({ ok: true, installed: false, result: null })
  }

  let payload = body.payload
  if (payload && JSON.stringify(payload).includes(CURRENT_URI)) {
    const uri = await resolveCurrentConnectionUri(body.connectionId)
    payload = replaceCurrentUri(payload, uri)
  }

  switch (body.action) {
    case "status":
      return proxyWithFallback(endpoint, "/health", "GET")
    case "drivers":
      return proxyWithFallback(endpoint, "/drivers", "GET")
    case "install-driver":
      return proxyWithFallback(endpoint, "/drivers/install", "POST", payload)
    case "probe":
      return proxyWithFallback(endpoint, "/probe", "POST", payload)
    case "transfer":
      return proxyWithFallback(endpoint, "/transfer", "POST", payload)
    default:
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 })
  }
}
