import { NextResponse } from "next/server"

import { getViews, putViews } from "@/lib/server/lens-db"

// The home's Saved Views shadow. PUT replaces the home's full view set with the
// supplied list (the client sends its whole local store); GET returns it for
// restore-on-adopt. localStorage stays the source of truth — this is durable
// backup. Node runtime — node:sqlite needs Node.
export const runtime = "nodejs"

export async function GET(req: Request) {
  const home = new URL(req.url).searchParams.get("home")
  if (!home) return NextResponse.json({ ok: false, error: "home required" }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, views: getViews(home)?.views ?? [] })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { home?: string; views?: unknown[] } | null
  if (!body?.home || !Array.isArray(body.views)) {
    return NextResponse.json({ ok: false, error: "home + views[] required" }, { status: 400 })
  }
  try {
    putViews(body.home, body.views)
    return NextResponse.json({ ok: true, count: body.views.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
