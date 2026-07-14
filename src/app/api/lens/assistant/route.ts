import { NextResponse } from "next/server"

import { appendAssistantMessages, listAssistantMessages } from "@/lib/server/lens-db"

// The home's Desktop Assistant thread — append-only (one unbroken conversation
// per home; localStorage is the L1 cache, this is the durable record). POST
// appends new messages idempotently by msg id; GET returns the tail for
// hydration on a fresh browser. Node runtime — node:sqlite needs Node.
export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const home = url.searchParams.get("home")
  if (!home) return NextResponse.json({ ok: false, error: "home required" }, { status: 400 })
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "400", 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 400
  try {
    return NextResponse.json({ ok: true, messages: listAssistantMessages(home, limit) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { home?: string; messages?: unknown[] }
    | null
  if (!body?.home || !Array.isArray(body.messages)) {
    return NextResponse.json({ ok: false, error: "home + messages[] required" }, { status: 400 })
  }
  try {
    const appended = appendAssistantMessages(body.home, body.messages)
    return NextResponse.json({ ok: true, appended })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
