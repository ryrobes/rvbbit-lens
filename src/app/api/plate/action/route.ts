import { NextResponse } from "next/server"
import { runPlateAction } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    plateId?: string
    action?: string
    args?: Record<string, unknown>
  } | null
  if (!body?.connectionId || !body?.plateId || !body?.action) {
    return NextResponse.json(
      { ok: false, error: "connectionId, plateId, action required" },
      { status: 400 },
    )
  }
  const result = await runPlateAction(body.connectionId, body.plateId, body.action, body.args ?? {})
  return NextResponse.json(result)
}
