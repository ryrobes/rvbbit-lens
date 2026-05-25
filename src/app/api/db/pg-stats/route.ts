import { NextResponse } from "next/server"
import { fetchPgStats } from "@/lib/db/pg-stats"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  try {
    const snap = await fetchPgStats(id)
    return NextResponse.json(snap)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
