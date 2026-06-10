import { NextResponse } from "next/server"

import { getProfile, putProfile } from "@/lib/server/lens-db"

// The per-home desktop-state shadow. The browser PUTs its localStorage blob
// here (debounced); GET is for Phase-2 hydration + verification. Node runtime —
// node:sqlite needs Node, not the edge runtime.
export const runtime = "nodejs"

export async function GET(req: Request) {
  const home = new URL(req.url).searchParams.get("home")
  if (!home) return NextResponse.json({ ok: false, error: "home required" }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, profile: getProfile(home) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { home?: string; state?: unknown } | null
  if (!body?.home) return NextResponse.json({ ok: false, error: "home required" }, { status: 400 })
  try {
    putProfile(body.home, body.state)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
