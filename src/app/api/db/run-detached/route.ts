import { NextResponse } from "next/server"
import { Client } from "pg"
import { getConnection } from "@/lib/db/registry"
import { buildClientConfig } from "@/lib/db/pool"

export const runtime = "nodejs"

interface Body {
  connectionId?: string
  sql?: string
  /** Sibling-database override (same server, different db) — e.g. a cron job's
   *  schedule_in_database target where rvbbit lives. */
  database?: string
}

/**
 * Fire a command on a dedicated, statement_timeout-disabled connection and
 * return immediately — the command keeps running in this (persistent) Node
 * process, independent of the request that started it.
 *
 * For long ad-hoc jobs (e.g. CALL rvbbit.catalog_crawl_run()) that must outlive
 * the pool's 30-min statement_timeout and must NOT block or poison a pool slot.
 * The caller watches status out-of-band (e.g. rvbbit.catalog_crawl_progress /
 * rvbbit.catalog_runs). Closing Lens ends this process and cancels the command;
 * durable per-table commits keep partial progress, and the scheduled cron run
 * (background worker) is the unattended path.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.connectionId || !body?.sql) {
    return NextResponse.json({ ok: false, error: "connectionId and sql required" }, { status: 400 })
  }
  const base = await getConnection(body.connectionId)
  if (!base) {
    return NextResponse.json({ ok: false, error: "Unknown connection" }, { status: 400 })
  }
  // Mirror getPool's sibling-db override (ignored for connectionString mode,
  // where the dbname is baked into the URL).
  const record =
    body.database && body.database !== base.database && !base.connectionString
      ? { ...base, database: body.database }
      : base

  const client = new Client(
    buildClientConfig(record, { statementTimeout: 0, applicationName: "rvbbit-lens-runnow" }),
  )
  try {
    await client.connect()
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    )
  }

  // Fire-and-forget: do NOT await the command. It runs in the background until
  // it settles, then we release the dedicated connection. The handlers keep the
  // promise (and client) alive past this response in the long-lived Node server.
  const sql = body.sql
  client
    .query(sql)
    .then(() => client.end().catch(() => {}))
    .catch((err) => {
      console.error("[run-detached] command failed:", err instanceof Error ? err.message : err)
      client.end().catch(() => {})
    })

  return NextResponse.json({ ok: true, started: true })
}
