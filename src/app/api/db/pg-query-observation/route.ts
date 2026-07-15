import { NextResponse } from "next/server"
import {
  fetchPgQueryObservation,
  type PgQueryObservationTarget,
} from "@/lib/db/pg-stats"

export const runtime = "nodejs"

interface ObservationRequest extends PgQueryObservationTarget {
  connectionId?: string
}

export async function POST(req: Request) {
  let body: ObservationRequest
  try {
    body = await req.json() as ObservationRequest
  } catch {
    return NextResponse.json({ error: "valid JSON body required" }, { status: 400 })
  }

  if (!body.connectionId) {
    return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  }
  if (!Number.isInteger(body.pid) || body.pid <= 0) {
    return NextResponse.json({ error: "positive pid required" }, { status: 400 })
  }
  if (typeof body.backendStart !== "string" || body.backendStart.length === 0) {
    return NextResponse.json({ error: "backendStart required" }, { status: 400 })
  }
  if (body.queryId != null && typeof body.queryId !== "string") {
    return NextResponse.json({ error: "queryId must be a string or null" }, { status: 400 })
  }
  if (body.query != null && typeof body.query !== "string") {
    return NextResponse.json({ error: "query must be a string or null" }, { status: 400 })
  }

  try {
    const snapshot = await fetchPgQueryObservation(body.connectionId, {
      pid: body.pid,
      backendStart: body.backendStart,
      queryId: body.queryId ?? null,
      query: body.query ?? null,
    })
    return NextResponse.json(snapshot)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
