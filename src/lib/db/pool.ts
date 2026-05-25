import "server-only"

import { Pool, type PoolConfig } from "pg"
import type { ConnectionRecord, SslMode } from "./types"
import { getConnection } from "./registry"

const POOL_CACHE = new Map<string, { pool: Pool; signature: string }>()

function sslOption(mode: SslMode | undefined): PoolConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false
    case "no-verify":
      return { rejectUnauthorized: false }
    case "require":
      return true
    case "prefer":
    case undefined:
    default:
      // node-postgres has no "prefer" — treat as undefined (let pg decide).
      return undefined
  }
}

function buildPoolConfig(c: ConnectionRecord): PoolConfig {
  if (c.connectionString && c.connectionString.length > 0) {
    return {
      connectionString: c.connectionString,
      ssl: sslOption(c.sslMode),
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 600_000,
      application_name: "rvbbit-lens",
    }
  }
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    ssl: sslOption(c.sslMode),
    max: 5,
    idleTimeoutMillis: 30_000,
    statement_timeout: 600_000,
    application_name: "rvbbit-lens",
  }
}

function signatureOf(c: ConnectionRecord): string {
  return JSON.stringify({
    cs: c.connectionString,
    h: c.host,
    p: c.port,
    d: c.database,
    u: c.user,
    pw: c.password,
    s: c.sslMode,
  })
}

export async function getPool(connectionId: string): Promise<{ pool: Pool; record: ConnectionRecord }> {
  const record = await getConnection(connectionId)
  if (!record) throw new Error(`Unknown connection: ${connectionId}`)

  const sig = signatureOf(record)
  const cached = POOL_CACHE.get(connectionId)
  if (cached && cached.signature === sig) return { pool: cached.pool, record }

  if (cached) {
    cached.pool.end().catch(() => {})
    POOL_CACHE.delete(connectionId)
  }

  const pool = new Pool(buildPoolConfig(record))
  pool.on("error", (err) => {
    console.warn(`[rvbbit-lens] pool ${connectionId} error:`, err.message)
  })
  POOL_CACHE.set(connectionId, { pool, signature: sig })
  return { pool, record }
}

export async function disposeAllPools(): Promise<void> {
  const entries = Array.from(POOL_CACHE.values())
  POOL_CACHE.clear()
  await Promise.allSettled(entries.map((e) => e.pool.end()))
}
