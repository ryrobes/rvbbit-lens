import { NextResponse } from "next/server"
import { getPool } from "@/lib/db/pool"
import { getConnection } from "@/lib/db/registry"
import { putImport } from "@/lib/db/import-store"
import { includedColumns } from "@/lib/import/ddl"
import type { ImportConfig } from "@/lib/import/types"

export const runtime = "nodejs"

interface Body {
  config?: ImportConfig
}

/**
 * Validate an import config and pre-flight it (connection exists, target table
 * does NOT already exist — this importer only creates new tables), then stash
 * it under a one-time id for the streaming `run` request. Fails fast here so we
 * never start streaming a multi-GB file into a doomed import.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  const config = body?.config
  if (!config?.connectionId || !config.schema?.trim() || !config.table?.trim()) {
    return NextResponse.json({ ok: false, error: "connectionId, schema and table are required" }, { status: 400 })
  }
  if (includedColumns(config.columns ?? []).length === 0) {
    return NextResponse.json({ ok: false, error: "Select at least one column to import" }, { status: 400 })
  }

  const record = await getConnection(config.connectionId)
  if (!record) {
    return NextResponse.json({ ok: false, error: "Unknown connection" }, { status: 400 })
  }

  try {
    const { pool } = await getPool(config.connectionId, undefined, "meta")
    const exists = await pool.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 LIMIT 1`,
      [config.schema, config.table],
    )
    if (exists.rowCount && exists.rowCount > 0) {
      return NextResponse.json(
        { ok: false, error: `Table "${config.schema}.${config.table}" already exists — choose a different name.` },
        { status: 200 },
      )
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 200 })
  }

  const importId = putImport(config)
  return NextResponse.json({ ok: true, importId })
}
