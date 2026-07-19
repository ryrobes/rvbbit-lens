import { NextResponse } from "next/server"
import { patchPlate, type PlatePatchInput } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    patch?: PlatePatchInput
  } | null
  if (!body?.connectionId || !body?.patch) {
    return NextResponse.json({ ok: false, error: "connectionId and patch required" }, { status: 400 })
  }
  const result = await patchPlate(body.connectionId, body.patch)
  return NextResponse.json(result)
}
