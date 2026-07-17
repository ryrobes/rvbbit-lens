import { NextResponse } from "next/server"
import { getConnection } from "@/lib/db/registry"
import { loadSystemHealth } from "@/lib/db/system-health"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  const connection = await getConnection(id)
  if (!connection) return NextResponse.json({ error: "connection not found" }, { status: 404 })
  try {
    return NextResponse.json(await loadSystemHealth(id))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
