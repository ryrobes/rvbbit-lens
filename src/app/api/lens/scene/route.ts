import { NextResponse } from "next/server"
import { getSharedSceneById } from "@/lib/server/lens-db"

export const runtime = "nodejs"

// Share-link resolver: one scene by id, shared-visibility only. The id (a
// UUIDv4) is the capability — same trust model as the rest of homebase.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("id")?.trim()
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 })
  const hit = getSharedSceneById(id)
  if (!hit) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 })
  return NextResponse.json({ ok: true, owner: hit.owner, scene: hit.scene })
}
