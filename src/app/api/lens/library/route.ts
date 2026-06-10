import { NextResponse } from "next/server"

import { listSharedScenes } from "@/lib/server/lens-db"

// The Scene Library: scenes other homes have shared. `home` is the caller's own
// home (excluded — your shared scenes already show in your local tray).
export const runtime = "nodejs"

export async function GET(req: Request) {
  const home = new URL(req.url).searchParams.get("home") ?? ""
  try {
    return NextResponse.json({ ok: true, shared: listSharedScenes(home) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
