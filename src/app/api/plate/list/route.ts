import { NextResponse } from "next/server"
import { listPlates } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { connectionId?: string } | null
  if (!body?.connectionId) {
    return NextResponse.json({ ok: false, error: "connectionId required" }, { status: 400 })
  }
  try {
    return NextResponse.json({ ok: true, plates: await listPlates(body.connectionId) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
