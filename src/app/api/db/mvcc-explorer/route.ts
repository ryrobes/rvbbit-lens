import { NextResponse } from "next/server"

import { fetchMvccExplorerSnapshot } from "@/lib/db/mvcc-explorer"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  }
  try {
    return NextResponse.json(await fetchMvccExplorerSnapshot(connectionId))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
