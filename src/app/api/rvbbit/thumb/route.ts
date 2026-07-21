import { NextRequest, NextResponse } from "next/server"
import { artifactInternalBase } from "@/lib/server/plates"

// Artifact thumbnail proxy (the Hub, docs/HUB_PLAN.md). rv-shot islands
// point here with a kind+slug handle; we fetch the PNG from warehouse-mcp's
// capture store server-side so the browser never needs the warehouse origin
// for images and a missing capture is a clean 404 (the island shows its
// monogram tile). Same validation as the island: handles, never URLs.
const SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i
const KINDS = new Set(["app", "dashboard"])

export async function GET(req: NextRequest) {
  const kind = (req.nextUrl.searchParams.get("kind") ?? "app").toLowerCase()
  const slug = req.nextUrl.searchParams.get("slug") ?? ""
  if (!KINDS.has(kind) || !SLUG.test(slug)) {
    return NextResponse.json({ ok: false, error: "bad artifact handle" }, { status: 400 })
  }
  const base = artifactInternalBase()
  if (!base) {
    return NextResponse.json({ ok: false, error: "RVBBIT_APP_BASE is not configured" }, { status: 404 })
  }
  try {
    // The warehouse gates /thumbs behind its static key when one is set —
    // this proxy authenticates server-side so the browser never needs it.
    const key = process.env.WAREHOUSE_MCP_KEY ?? ""
    const upstream = await fetch(`${base}/thumbs/${kind}/${slug}.png`, {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
      // Thumbnails change on republish; a short shared cache keeps the
      // gallery snappy without pinning stale shots for long.
      next: { revalidate: 60 },
    })
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ ok: false }, { status: 404 })
    }
    return new NextResponse(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=60",
      },
    })
  } catch {
    return NextResponse.json({ ok: false }, { status: 404 })
  }
}
