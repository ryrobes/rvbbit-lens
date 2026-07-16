import { NextResponse } from "next/server"

import { fetchPgStatementCatalog } from "@/lib/db/pg-stats"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  }
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10)
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 500
  try {
    return NextResponse.json(await fetchPgStatementCatalog(connectionId, limit))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
