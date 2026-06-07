import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

interface Body {
  connectionId?: string
  sql?: string
  rowLimit?: number
  readOnly?: boolean
  /** Sibling-database override (same server, different db) — e.g. pg_cron's home db. */
  database?: string
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.connectionId || !body?.sql) {
    return NextResponse.json({ ok: false, error: "connectionId and sql required" }, { status: 400 })
  }
  try {
    const result = await executeQuery(body.connectionId, body.sql, {
      rowLimit: body.rowLimit,
      readOnly: body.readOnly,
      database: body.database,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const e = err as Error & { code?: string; position?: string; detail?: string; hint?: string }
    return NextResponse.json({
      ok: false,
      error: e.message ?? String(err),
      code: e.code,
      position: e.position ? Number(e.position) : null,
      detail: e.detail,
      hint: e.hint,
    }, { status: 200 })
  }
}
