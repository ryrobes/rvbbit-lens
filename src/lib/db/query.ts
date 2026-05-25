import "server-only"

import type { PoolClient, QueryResult as PgQueryResult, QueryResultRow } from "pg"
import { getPool } from "./pool"
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
}

export async function executeQuery(
  connectionId: string,
  sql: string,
  opts: ExecuteOpts = {},
): Promise<QueryResult> {
  const { pool, record } = await getPool(connectionId)
  const limit = opts.rowLimit ?? DEFAULT_ROW_LIMIT
  const client = await pool.connect()
  const start = Date.now()
  try {
    if (opts.readOnly) {
      await client.query("BEGIN READ ONLY")
    }
    const raw = await client.query<QueryResultRow>({ text: sql })
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
      command: result.command,
    }
  } catch (err) {
    if (opts.readOnly) {
      try { await client.query("ROLLBACK") } catch { /* ignore */ }
    }
    throw err
  } finally {
    client.release()
  }
}
