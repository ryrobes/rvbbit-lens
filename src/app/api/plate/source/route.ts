import { NextResponse } from "next/server"
import { loadPlateSource } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    plateId?: string
  } | null
  if (!body?.connectionId || !body.plateId) {
    return NextResponse.json({ ok: false, error: "connectionId and plateId required" }, { status: 400 })
  }
  try {
    const source = await loadPlateSource(body.connectionId, body.plateId)
    if (!source) return NextResponse.json({ ok: false, error: `plate ${body.plateId} not found` })
    return NextResponse.json({ ok: true, ...source })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
