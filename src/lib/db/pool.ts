import "server-only"

import { Pool, type ClientConfig, type PoolConfig } from "pg"
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

/**
 * Base connection config shared by the pool and one-off clients. Used by the
 * CSV importer to spin up a *dedicated* `Client` (statement_timeout disabled
 * for a long COPY) so a big import never ties up one of the pool's 5 slots.
 */
/** Default statement_timeout (ms) for interactive queries. Configurable via
 *  RVBBIT_QUERY_TIMEOUT_MS; 0 disables it entirely. Semantic queries that warm
 *  large tables can run for many minutes, so the default is generous (30m). */
export const DEFAULT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RVBBIT_QUERY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_800_000
})()

export function buildClientConfig(
  c: ConnectionRecord,
  opts: { statementTimeout?: number; applicationName?: string } = {},
): ClientConfig {
  const base: ClientConfig =
    c.connectionString && c.connectionString.length > 0
      ? { connectionString: c.connectionString }
      : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password }
  return {
    ...base,
    ssl: sslOption(c.sslMode),
    statement_timeout: opts.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    application_name: opts.applicationName ?? "rvbbit-lens",
  }
}

function buildPoolConfig(c: ConnectionRecord): PoolConfig {
  return { ...buildClientConfig(c), max: 5, idleTimeoutMillis: 30_000 }
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
