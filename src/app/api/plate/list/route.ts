import { NextResponse } from "next/server"
import { listAvailableKits, listKits, listPlates } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { connectionId?: string } | null
  if (!body?.connectionId) {
    return NextResponse.json({ ok: false, error: "connectionId required" }, { status: 400 })
  }
  try {
    const [plates, kits] = await Promise.all([
      listPlates(body.connectionId),
      listKits(body.connectionId),
    ])
    const available = await listAvailableKits(body.connectionId, kits)
    return NextResponse.json({ ok: true, plates, kits, available })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
