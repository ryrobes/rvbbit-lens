import { NextResponse } from "next/server"
import { installPlate, type PlateInstallInput } from "@/lib/server/plates"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    plate?: PlateInstallInput
  } | null
  if (!body?.connectionId || !body?.plate) {
    return NextResponse.json({ ok: false, error: "connectionId and plate required" }, { status: 400 })
  }
  const result = await installPlate(body.connectionId, body.plate)
  return NextResponse.json(result)
}
