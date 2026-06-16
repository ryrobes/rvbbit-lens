import { NextResponse } from "next/server"
import { loadRvbbitStatus } from "@/lib/db/rvbbit-status"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  try {
    return NextResponse.json(await loadRvbbitStatus(id))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
