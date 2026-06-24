import { NextResponse } from "next/server"
import { getConnection } from "@/lib/db/registry"
import { loadRvbbitStatus } from "@/lib/db/rvbbit-status"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  const connection = await getConnection(id)
  if (!connection) return NextResponse.json({ error: "connection not found" }, { status: 404 })
  const start = Date.now()
  try {
    return NextResponse.json(await loadRvbbitStatus(id))
  } catch (err) {
    return NextResponse.json({
      connectionId: id,
      hasRvbbit: false,
      rvbbitVersion: null,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
