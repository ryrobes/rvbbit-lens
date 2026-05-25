import { NextResponse } from "next/server"
import {
  listConnections,
  upsertConnection,
  sanitize,
} from "@/lib/db/registry"
import type { ConnectionInput } from "@/lib/db/types"

export const runtime = "nodejs"

export async function GET() {
  const all = await listConnections()
  return NextResponse.json({ connections: all.map(sanitize) })
}

export async function POST(req: Request) {
  let body: ConnectionInput
  try {
    body = (await req.json()) as ConnectionInput
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 })
  }
  if (!body || typeof body.label !== "string") {
    return NextResponse.json({ error: "label required" }, { status: 400 })
  }
  const saved = await upsertConnection(body)
  return NextResponse.json({ connection: sanitize(saved) })
}
