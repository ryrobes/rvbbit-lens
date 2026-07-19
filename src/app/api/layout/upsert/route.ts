import { NextResponse } from "next/server"
import { installLayout, type LayoutInstallInput } from "@/lib/server/layouts"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    layout?: LayoutInstallInput
  } | null
  if (!body?.connectionId || !body?.layout) {
    return NextResponse.json({ ok: false, error: "connectionId and layout required" }, { status: 400 })
  }
  const result = await installLayout(body.connectionId, body.layout)
  return NextResponse.json(result)
}
