import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/** Assistant-facing kit registration: metadata only (title/version/
 *  description/requires). Setup DDL, contracts, and targets stay
 *  operator/Fitting-Room work. Downgrades are refused by the engine. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    kit?: string
    title?: string
    description?: string
    version?: string
    requires?: unknown
  } | null
  if (!body?.connectionId || !body?.kit || !body?.title) {
    return NextResponse.json({ ok: false, error: "connectionId, kit and title required" }, { status: 400 })
  }
  try {
    await executeQuery(
      body.connectionId,
      `SELECT rvbbit.upsert_kit(
         ${sqlLit(body.kit)}, ${sqlLit(body.title)},
         ${body.description == null ? "NULL" : sqlLit(body.description)},
         NULL,
         ${sqlLit(body.version ?? "0.1.0")},
         ${sqlLit(JSON.stringify(body.requires ?? {}))}::jsonb)`,
      { rowLimit: 1 },
    )
    return NextResponse.json({ ok: true, kit: body.kit })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
