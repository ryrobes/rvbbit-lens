import "server-only"

import { getPool } from "./pool"
import type { ConnectionTestResult } from "./types"

export async function testConnection(connectionId: string): Promise<ConnectionTestResult> {
  const start = Date.now()
  try {
    const { pool } = await getPool(connectionId)
    const client = await pool.connect()
    try {
      const [version, db, schemas, tables, rvbbit] = await Promise.all([
        client.query<{ version: string }>("SELECT version() AS version"),
        client.query<{ database: string }>("SELECT current_database() AS database"),
        client.query<{ n: number }>(
          `SELECT COUNT(*)::int4 AS n FROM pg_namespace
           WHERE nspname NOT IN ('pg_catalog','information_schema')
             AND nspname NOT LIKE 'pg_toast%'
             AND nspname NOT LIKE 'pg_temp_%'`,
        ),
        client.query<{ n: number }>(
          `SELECT COUNT(*)::int4 AS n FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','v','m','f','p')
             AND n.nspname NOT IN ('pg_catalog','information_schema')`,
        ),
        client.query<{ version: string | null }>(
          "SELECT extversion AS version FROM pg_extension WHERE extname IN ('rvbbit','pg_rvbbit') ORDER BY extname LIMIT 1",
        ),
      ])
      return {
        ok: true,
        serverVersion: version.rows[0]?.version,
        database: db.rows[0]?.database,
        schemaCount: schemas.rows[0]?.n ?? 0,
        tableCount: tables.rows[0]?.n ?? 0,
        hasRvbbit: rvbbit.rowCount! > 0,
        rvbbitVersion: rvbbit.rows[0]?.version ?? null,
        durationMs: Date.now() - start,
      }
    } finally {
      client.release()
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }
}
