import { NextResponse } from "next/server"
import { loadLayout } from "@/lib/server/layouts"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    layoutId?: string
  } | null
  if (!body?.connectionId || !body.layoutId) {
    return NextResponse.json({ ok: false, error: "connectionId and layoutId required" }, { status: 400 })
  }
  try {
    const layout = await loadLayout(body.connectionId, body.layoutId)
    if (!layout) return NextResponse.json({ ok: false, error: `layout ${body.layoutId} not found` })
    return NextResponse.json({ ok: true, layout })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
