import { NextResponse } from "next/server"
import { txnEnd, txnQuery } from "@/lib/db/query"

// Manual-transaction control. `query` runs a statement inside the pinned
// transaction (beginning it lazily); `commit`/`rollback` ends it and releases
// the connection. Node runtime — the pinned client lives in a module map.
export const runtime = "nodejs"

interface Body {
  action?: "query" | "commit" | "rollback"
  sessionId?: string
  connectionId?: string
  sql?: string
  rowLimit?: number
  database?: string
  cancelToken?: string
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.action || !body.sessionId) {
    return NextResponse.json({ ok: false, error: "action + sessionId required" }, { status: 400 })
  }
  try {
    if (body.action === "query") {
      if (!body.connectionId || !body.sql) {
        return NextResponse.json({ ok: false, error: "connectionId + sql required" }, { status: 400 })
      }
      const result = await txnQuery(body.sessionId, body.connectionId, body.sql, {
        rowLimit: body.rowLimit,
        database: body.database,
        cancelToken: body.cancelToken,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    if (body.action === "commit" || body.action === "rollback") {
      const ended = await txnEnd(body.sessionId, body.action)
      return NextResponse.json({ ok: true, ended })
    }
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 })
  } catch (err) {
    const e = err as Error & { code?: string; position?: string; detail?: string; hint?: string }
    return NextResponse.json(
      {
        ok: false,
        error: e.message ?? String(err),
        code: e.code,
        position: e.position ? Number(e.position) : null,
        detail: e.detail,
        hint: e.hint,
      },
      { status: 200 },
    )
  }
}
