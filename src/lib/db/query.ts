import "server-only"

import type { PoolClient, QueryResult as PgQueryResult, QueryResultRow } from "pg"
import { getPool, type PoolLane } from "./pool"
import type { QueryResult, QueryResultColumn } from "./types"

const DEFAULT_ROW_LIMIT = 5_000

const TYPE_NAME_CACHE = new Map<string, Map<number, string>>()

function pickPrimaryResult(
  raw: PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[],
): PgQueryResult<QueryResultRow> {
  if (!Array.isArray(raw)) return raw
  if (raw.length === 0) {
    return { rows: [], fields: [], command: "", rowCount: 0, oid: 0 } as unknown as PgQueryResult<QueryResultRow>
  }
  // Prefer the last result that returned rows; otherwise the last result.
  for (let i = raw.length - 1; i >= 0; i--) {
    const r = raw[i]
    if (r && Array.isArray(r.rows) && r.rows.length > 0) return r
  }
  return raw[raw.length - 1]
}

async function loadTypeNames(client: PoolClient, key: string): Promise<Map<number, string>> {
  const cached = TYPE_NAME_CACHE.get(key)
  if (cached) return cached

  const result = await client.query<{ oid: number; typname: string }>(
    "SELECT oid::int4 AS oid, typname FROM pg_type",
  )
  const map = new Map<number, string>()
  for (const row of result.rows) map.set(row.oid, row.typname)
  TYPE_NAME_CACHE.set(key, map)
  return map
}

export interface ExecuteOpts {
  rowLimit?: number
  /** If true, wrap the query in a read-only transaction. */
  readOnly?: boolean
  /** Run against a different database on the same server (e.g. pg_cron's home db). */
  database?: string
  /**
   * Per-query statement_timeout (ms) overriding the connection default (the
   * pool's 30m DEFAULT_STATEMENT_TIMEOUT_MS). 0 disables the timeout entirely.
   * Postgres arms statement_timeout once, when a query message arrives, from the
   * session GUC at that instant — nothing inside the called function (set_config,
   * a function SET clause, or COMMIT in a procedure) can move it afterward. So a
   * long server-side job like rvbbit.catalog_crawl() must have the timeout set on
   * the connection BEFORE the call, as its own statement. We do that here via a
   * separate `SET` message, then RESET so the pooled connection's default is
   * restored for the next borrower.
   */
  statementTimeout?: number
  /** Pool lane. User SQL uses the interactive lane; progress/metadata probes
   *  use the meta lane so they do not starve SQL blocks. */
  poolLane?: PoolLane
  /** Client-supplied token registering this query's backend PID so a separate
   *  request can pg_cancel_backend() exactly it (see cancelQueryByToken). */
  cancelToken?: string
}

// token -> the backend running it, so a Stop button can cancel that exact query.
const CANCEL_REGISTRY = new Map<string, { connectionId: string; pid: number; database?: string }>()

// ── Manual transactions (autocommit off) ────────────────────────────────────
//
// A manual transaction must run all its statements on ONE pinned backend, but the
// pool releases the client after each query. So a window's transaction checks out
// a client, holds it across runs, and releases it on COMMIT/ROLLBACK. An idle
// sweep rolls back + releases any forgotten session so it can't pin a connection
// forever.

interface TxnSession {
  client: PoolClient
  connectionId: string
  database?: string
  recordId: string
  /** Backend PID of the pinned client, so a Stop can pg_cancel_backend exactly it. */
  pid: number | null
  lastUsed: number
}
const TXN_SESSIONS = new Map<string, TxnSession>()
const TXN_IDLE_MS = 10 * 60_000
let txnSweepStarted = false
function ensureTxnSweep(): void {
  if (txnSweepStarted) return
  txnSweepStarted = true
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of TXN_SESSIONS) {
      if (now - s.lastUsed <= TXN_IDLE_MS) continue
      TXN_SESSIONS.delete(id)
      void (async () => {
        try { await s.client.query("ROLLBACK") } catch { /* ignore */ } finally { s.client.release() }
      })()
    }
  }, 60_000)
  // Don't keep the process alive just for the sweep.
  ;(timer as { unref?: () => void }).unref?.()
}

/** Run a statement inside the pinned transaction for `sessionId`, beginning the
 *  transaction lazily on the first statement. The held client stays checked out
 *  (even on a statement error, so the user can ROLLBACK) until txnEnd. */
export async function txnQuery(
  sessionId: string,
  connectionId: string,
  sql: string,
  opts: { rowLimit?: number; database?: string; cancelToken?: string } = {},
): Promise<QueryResult> {
  ensureTxnSweep()
  const limit = opts.rowLimit ?? DEFAULT_ROW_LIMIT
  let session = TXN_SESSIONS.get(sessionId)
  if (session) {
    // A transaction is pinned to ONE backend (its original connection + database).
    // Refuse a statement that arrived for a different target — otherwise it would
    // silently run on the pinned backend while the caller believes it hit the new
    // one (e.g. the db-switcher changed mid-transaction).
    if (session.connectionId !== connectionId || (session.database ?? "") !== (opts.database ?? "")) {
      throw new Error(
        "This window has an open transaction pinned to its original connection/database. Commit or roll back before switching.",
      )
    }
  } else {
    const { pool, record } = await getPool(connectionId, opts.database, "interactive")
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
    } catch (e) {
      client.release()
      throw e
    }
    let pid = (client as unknown as { processID?: number | null }).processID ?? null
    if (pid == null) {
      try {
        pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? null
      } catch {
        pid = null
      }
    }
    session = { client, connectionId, database: opts.database, recordId: record.id, pid, lastUsed: Date.now() }
    TXN_SESSIONS.set(sessionId, session)
  }
  session.lastUsed = Date.now()
  const client = session.client
  const start = Date.now()
  // Register the pinned backend for cancellation, but only around THIS statement —
  // pg_cancel_backend has no statement identity, so the token must be gone before
  // the next statement reuses the same backend (mirrors executeQuery).
  let registered = false
  if (opts.cancelToken && session.pid != null) {
    CANCEL_REGISTRY.set(opts.cancelToken, { connectionId, pid: session.pid, database: opts.database })
    registered = true
  }
  let raw: PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[]
  try {
    raw = await client.query<QueryResultRow>({ text: sql })
  } finally {
    if (registered) CANCEL_REGISTRY.delete(opts.cancelToken!)
  }
  const durationMs = Date.now() - start
  const result = pickPrimaryResult(raw)
  const safeRows = result.rows ?? []
  const truncated = safeRows.length > limit
  const rows = truncated ? safeRows.slice(0, limit) : safeRows
  const typeNames = await loadTypeNames(client, session.recordId)
  const columns: QueryResultColumn[] = (result.fields || []).map(
    (f: { name: string; dataTypeID: number }) => ({
      name: f.name,
      dataTypeId: f.dataTypeID,
      dataTypeName: typeNames.get(f.dataTypeID),
    }),
  )
  return {
    sql,
    connectionId,
    columns,
    rows,
    rowCount: typeof result.rowCount === "number" ? result.rowCount : rows.length,
    truncated,
    durationMs,
    queueWaitMs: 0,
    command: result.command,
  }
}

/** Commit or roll back the pinned transaction for `sessionId` and release its
 *  connection back to the pool. Returns false if there was no open session. */
export async function txnEnd(sessionId: string, action: "commit" | "rollback"): Promise<boolean> {
  const session = TXN_SESSIONS.get(sessionId)
  if (!session) return false
  TXN_SESSIONS.delete(sessionId)
  try {
    await session.client.query(action === "commit" ? "COMMIT" : "ROLLBACK")
  } catch {
    /* the connection is being discarded anyway */
  } finally {
    session.client.release()
  }
  return true
}

/** Cancel the in-flight query registered under `token` via pg_cancel_backend on a
 *  separate (meta-lane) connection. Returns true if a backend was signalled. */
export async function cancelQueryByToken(token: string): Promise<boolean> {
  const entry = CANCEL_REGISTRY.get(token)
  if (!entry) return false
  try {
    const { pool } = await getPool(entry.connectionId, entry.database, "meta")
    const client = await pool.connect()
    try {
      await client.query("SELECT pg_cancel_backend($1)", [entry.pid])
      return true
    } finally {
      client.release()
    }
  } catch {
    return false
  }
}

export async function executeQuery(
  connectionId: string,
  sql: string,
  opts: ExecuteOpts = {},
): Promise<QueryResult> {
  const { pool, record } = await getPool(connectionId, opts.database, opts.poolLane)
  const limit = opts.rowLimit ?? DEFAULT_ROW_LIMIT
  const acquireStart = Date.now()
  const client = await pool.connect()
  const queueWaitMs = Date.now() - acquireStart
  const start = Date.now()
  // Override the connection's default statement_timeout for this one query, as a
  // separate message so Postgres re-arms the timer from the new value (see
  // ExecuteOpts.statementTimeout). RESET in `finally` keeps the pooled connection
  // clean for the next borrower.
  const overrideTimeout = Number.isFinite(opts.statementTimeout) && opts.statementTimeout! >= 0
  try {
    if (overrideTimeout) {
      await client.query(`SET statement_timeout = ${Math.floor(opts.statementTimeout!)}`)
    }
    if (opts.readOnly) {
      await client.query("BEGIN READ ONLY")
    }
    // Register the backend PID for cancellation — but ONLY for the duration of the
    // user statement. pg_cancel_backend has no statement identity, so the token
    // must be gone before the post-query work (loadTypeNames / RESET) and before
    // the connection is released and the PID reused, or a late Stop would cancel
    // the wrong query. `processID` is captured at connect; fall back to a query.
    let registered = false
    if (opts.cancelToken) {
      let pid = (client as unknown as { processID?: number | null }).processID ?? null
      if (pid == null) {
        try {
          pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? null
        } catch {
          pid = null
        }
      }
      if (pid != null) {
        CANCEL_REGISTRY.set(opts.cancelToken, { connectionId, pid, database: opts.database })
        registered = true
      }
    }
    let raw: PgQueryResult<QueryResultRow> | PgQueryResult<QueryResultRow>[]
    try {
      raw = await client.query<QueryResultRow>({ text: sql })
    } finally {
      if (registered) CANCEL_REGISTRY.delete(opts.cancelToken!)
    }
    const durationMs = Date.now() - start

    // node-postgres returns an array of results for multi-statement queries.
    // We pick the *last* SELECT-shaped result (the one with fields) as the
    // visible payload, matching what a SQL client traditionally shows.
    const result = pickPrimaryResult(raw)
    const safeRows = result.rows ?? []
    const truncated = safeRows.length > limit
    const rows = truncated ? safeRows.slice(0, limit) : safeRows

    const typeNames = await loadTypeNames(client, record.id)
    const columns: QueryResultColumn[] = (result.fields || []).map(
      (f: { name: string; dataTypeID: number }) => ({
        name: f.name,
        dataTypeId: f.dataTypeID,
        dataTypeName: typeNames.get(f.dataTypeID),
      }),
    )

    if (opts.readOnly) {
      await client.query("COMMIT")
    }

    return {
      sql,
      connectionId,
      columns,
      rows,
      rowCount: typeof result.rowCount === "number" ? result.rowCount : rows.length,
      truncated,
      durationMs,
      queueWaitMs,
      command: result.command,
    }
  } catch (err) {
    if (opts.readOnly) {
      try { await client.query("ROLLBACK") } catch { /* ignore */ }
    }
    throw err
  } finally {
    if (opts.cancelToken) CANCEL_REGISTRY.delete(opts.cancelToken)
    if (overrideTimeout) {
      try { await client.query("RESET statement_timeout") } catch { /* ignore */ }
    }
    client.release()
  }
}
