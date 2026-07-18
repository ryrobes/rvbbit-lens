import { NextResponse } from "next/server"
import { renderPlate } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    plateId?: string
    params?: Record<string, unknown>
  } | null
  if (!body?.connectionId || !body?.plateId) {
    return NextResponse.json({ ok: false, error: "connectionId and plateId required" }, { status: 400 })
  }
  try {
    const rendered = await renderPlate(body.connectionId, body.plateId, body.params ?? {})
    return NextResponse.json({ ok: true, ...rendered })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
