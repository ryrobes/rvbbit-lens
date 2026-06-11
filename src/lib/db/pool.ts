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
 * for a long COPY) so a big import never ties up one of the pool's slots.
 */
/** Default statement_timeout (ms) for interactive queries. Configurable via
 *  RVBBIT_QUERY_TIMEOUT_MS; 0 disables it entirely. Semantic queries that warm
 *  large tables can run for many minutes, so the default is generous (30m). */
export const DEFAULT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RVBBIT_QUERY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_800_000
})()

/** Pool size. Configurable via RVBBIT_POOL_MAX (default 10, was 5). */
const POOL_MAX = (() => {
  const raw = Number(process.env.RVBBIT_POOL_MAX)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10
})()

/** Connection-acquire timeout (ms). CRITICAL: without it, pool.connect() parks
 *  FOREVER when all slots are busy — so a slow spell (e.g. a running sync) silently
 *  queues every UI poll, then flushes them in a burst when pressure drops ("freeze
 *  then flood"). A bounded timeout makes a starved request error fast, so the UI
 *  degrades gracefully (stale/retry) instead of freezing. Configurable via
 *  RVBBIT_POOL_ACQUIRE_TIMEOUT_MS (default 8s; 0 = wait forever, the old behavior). */
const POOL_ACQUIRE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RVBBIT_POOL_ACQUIRE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 8_000
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
  return {
    ...buildClientConfig(c),
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
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

export async function getPool(
  connectionId: string,
  databaseOverride?: string,
): Promise<{ pool: Pool; record: ConnectionRecord }> {
  const base = await getConnection(connectionId)
  if (!base) throw new Error(`Unknown connection: ${connectionId}`)

  // Optional sibling-database override (e.g. pg_cron's home db, 'postgres'): reuse
  // this connection's host + credentials but target a different database on the same
  // server, pooled separately. Ignored for connectionString-mode connections (the
  // dbname is baked into the URL) — those must register a dedicated connection.
  const record: ConnectionRecord =
    databaseOverride && databaseOverride !== base.database && !base.connectionString
      ? { ...base, database: databaseOverride }
      : base
  const cacheKey =
    record.database !== base.database ? `${connectionId}::${record.database}` : connectionId

  const sig = signatureOf(record)
  const cached = POOL_CACHE.get(cacheKey)
  if (cached && cached.signature === sig) return { pool: cached.pool, record }

  if (cached) {
    cached.pool.end().catch(() => {})
    POOL_CACHE.delete(cacheKey)
  }

  const pool = new Pool(buildPoolConfig(record))
  pool.on("error", (err) => {
    console.warn(`[rvbbit-lens] pool ${cacheKey} error:`, err.message)
  })
  POOL_CACHE.set(cacheKey, { pool, signature: sig })
  return { pool, record }
}

export async function disposeAllPools(): Promise<void> {
  const entries = Array.from(POOL_CACHE.values())
  POOL_CACHE.clear()
  await Promise.allSettled(entries.map((e) => e.pool.end()))
}
