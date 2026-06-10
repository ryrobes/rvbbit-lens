import { NextResponse } from "next/server"

import { listScenes, replaceScenes } from "@/lib/server/lens-db"

// The home's saved-desktop (scene) shadow. PUT replaces the home's full scene
// set with the supplied list (the client sends its whole local store);
// individual rows now so Phase 2 (the shared Scene Library) is a query, not a
// migration. Node runtime — node:sqlite needs Node.
export const runtime = "nodejs"

export async function GET(req: Request) {
  const home = new URL(req.url).searchParams.get("home")
  if (!home) return NextResponse.json({ ok: false, error: "home required" }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, scenes: listScenes(home) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { home?: string; scenes?: unknown[] } | null
  if (!body?.home || !Array.isArray(body.scenes)) {
    return NextResponse.json({ ok: false, error: "home + scenes[] required" }, { status: 400 })
  }
  try {
    replaceScenes(body.home, body.scenes)
    return NextResponse.json({ ok: true, count: body.scenes.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
