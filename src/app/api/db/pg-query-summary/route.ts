import { NextResponse } from "next/server"

import {
  fetchPgQuerySummaryCapability,
  generatePgQuerySummary,
  type PgStatementStats,
} from "@/lib/db/pg-stats"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const connectionId = new URL(req.url).searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  }
  return NextResponse.json(await fetchPgQuerySummaryCapability(connectionId))
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as {
    connectionId?: string
    query?: string
    stats?: Partial<PgStatementStats>
  } | null
  if (!body?.connectionId) {
    return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  }
  if (typeof body.query !== "string" || body.query.trim().length === 0) {
    return NextResponse.json({ error: "query required" }, { status: 400 })
  }
  return NextResponse.json(await generatePgQuerySummary(
    body.connectionId,
    body.query,
    body.stats,
  ))
}
