import { NextResponse } from "next/server"
import { testConnection } from "@/lib/db/test"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { connectionId?: string } | null
  const id = body?.connectionId
  if (!id) return NextResponse.json({ ok: false, error: "connectionId required" }, { status: 400 })
  const result = await testConnection(id)
  return NextResponse.json(result)
}
