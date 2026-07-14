import "server-only"

import { Pool, type ClientConfig, type PoolConfig } from "pg"
import type { ConnectionRecord, SslMode } from "./types"
import { getConnection } from "./registry"
import { resolveEndpoint, disposeAllTunnels } from "./tunnel"

export type PoolLane = "interactive" | "meta" | "observer"

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

function positiveEnvInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** Interactive/user SQL pool size. Configurable via RVBBIT_POOL_MAX. */
const POOL_MAX = (() => {
  return positiveEnvInt("RVBBIT_POOL_MAX", 24)
})()

/** Metadata/status pool size. Isolated so monitor/schema fan-out cannot consume
 *  the interactive query pool. Configurable via RVBBIT_META_POOL_MAX. */
const META_POOL_MAX = (() => {
  return positiveEnvInt("RVBBIT_META_POOL_MAX", 4)
})()

/** Live observability stays available when schema/catalog discovery is queued
 * behind relation locks. Keep it separate from both user SQL and metadata. */
const OBSERVER_POOL_MAX = (() => {
  return positiveEnvInt("RVBBIT_OBSERVER_POOL_MAX", 4)
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

function buildPoolConfig(c: ConnectionRecord, lane: PoolLane): PoolConfig {
  const applicationName = lane === "observer"
    ? "rvbbit-lens-observer"
    : lane === "meta" ? "rvbbit-lens-meta" : "rvbbit-lens"
  return {
    ...buildClientConfig(c, {
      applicationName,
    }),
    max: lane === "observer" ? OBSERVER_POOL_MAX : lane === "meta" ? META_POOL_MAX : POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
  }
}

function connectionStringWithDatabase(connectionString: string, database: string): string | null {
  try {
    const url = new URL(connectionString)
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null
    url.pathname = `/${encodeURIComponent(database)}`
    return url.toString()
  } catch {
    return null
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
  lane: PoolLane = "interactive",
): Promise<{ pool: Pool; record: ConnectionRecord }> {
  const base = await getConnection(connectionId)
  if (!base) throw new Error(`Unknown connection: ${connectionId}`)

  // Optional sibling-database override (e.g. pg_cron's home db, 'postgres'): reuse
  // this connection's host + credentials but target a different database on the same
  // server, pooled separately. For URL-style connection strings, rewrite only the
  // path/database segment and keep the same auth/host/query options.
  let record: ConnectionRecord = base
  if (databaseOverride && databaseOverride !== base.database) {
    if (base.connectionString) {
      const overridden = connectionStringWithDatabase(base.connectionString, databaseOverride)
      if (overridden) {
        record = { ...base, database: databaseOverride, connectionString: overridden }
      }
    } else {
      record = { ...base, database: databaseOverride }
    }
  }
  const baseCacheKey =
    record.database !== base.database ? `${connectionId}::${record.database}` : connectionId
  const cacheKey = `${lane}::${baseCacheKey}`

  // If this connection tunnels over SSH, resolve (and lazily build) the tunnel and
  // point the pool at the local forwarded port. `record` (real host) is returned
  // to callers; only the pool config uses the rewritten endpoint. The resolved
  // local port lands in the signature, so a tunnel rebuild rebuilds the pool too.
  const endpoint = await resolveEndpoint(record)

  const sig = signatureOf(endpoint)
  const cached = POOL_CACHE.get(cacheKey)
  if (cached && cached.signature === sig) return { pool: cached.pool, record }

  if (cached) {
    cached.pool.end().catch(() => {})
    POOL_CACHE.delete(cacheKey)
  }

  const pool = new Pool(buildPoolConfig(endpoint, lane))
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
  await disposeAllTunnels()
}
