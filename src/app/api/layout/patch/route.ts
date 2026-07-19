import { NextResponse } from "next/server"
import { patchLayout, type LayoutPatchInput } from "@/lib/server/layouts"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    patch?: LayoutPatchInput
  } | null
  if (!body?.connectionId || !body?.patch) {
    return NextResponse.json({ ok: false, error: "connectionId and patch required" }, { status: 400 })
  }
  const result = await patchLayout(body.connectionId, body.patch)
  return NextResponse.json(result)
}
