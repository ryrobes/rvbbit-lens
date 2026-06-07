import { NextResponse } from "next/server"

export const runtime = "nodejs"

/**
 * Browse the Hugging Face Hub for models we can serve. Public, keyless
 * (HF_TOKEN only widens visibility to gated repos + raises rate limits).
 *
 * The Hub list endpoint takes ONE pipeline_tag per request, so a task
 * with multiple HF tags (embedding ← feature-extraction + sentence-
 * similarity) fans out into several calls that we merge + dedupe here.
 *
 * Query params:
 *   pipeline_tag=<comma-separated HF tags>   (required)
 *   search=<text>   library=<lib>   author=<org>
 *   sort=downloads|likes|trending|lastModified   (default downloads)
 *   limit=<n>   (default 25, capped 50)
 *
 * Returns: { ok, hits: [{ id, pipelineTag, downloads, likes, library, gated }] }
 */

const HF_API = "https://huggingface.co/api/models"
const SORTS = new Set(["downloads", "likes", "trending", "lastModified"])

function authHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}

interface Hit {
  id: string
  pipelineTag: string | null
  downloads: number
  likes: number
  library: string | null
  gated: boolean | string
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const tags = (q.get("pipeline_tag") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length === 0) {
    return NextResponse.json({ ok: false, error: "pipeline_tag required" }, { status: 400 })
  }
  const search = (q.get("search") ?? "").trim()
  const library = (q.get("library") ?? "").trim()
  const author = (q.get("author") ?? "").trim()
  const sort = SORTS.has(q.get("sort") ?? "") ? (q.get("sort") as string) : "downloads"
  const limit = Math.min(Math.max(Number(q.get("limit")) || 25, 1), 50)

  const headers = authHeaders()

  const buildUrl = (tag: string) => {
    const p = new URLSearchParams()
    p.set("pipeline_tag", tag)
    p.set("sort", sort)
    p.set("direction", "-1")
    p.set("limit", String(limit))
    if (search) p.set("search", search)
    if (library) p.set("library", library)
    if (author) p.set("author", author)
    return `${HF_API}?${p.toString()}`
  }

  let results: Array<Record<string, unknown>[]>
  try {
    results = await Promise.all(
      tags.map(async (tag) => {
        const r = await fetch(buildUrl(tag), { headers })
        if (!r.ok) return []
        return (await r.json().catch(() => [])) as Record<string, unknown>[]
      }),
    )
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Hugging Face unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    )
  }

  // Merge the per-tag pages, dedupe by id, re-sort by the chosen metric.
  const byId = new Map<string, Hit>()
  for (const page of results) {
    for (const m of page) {
      const id = m.id as string
      if (!id || byId.has(id)) continue
      byId.set(id, {
        id,
        pipelineTag: (m.pipeline_tag as string) ?? null,
        downloads: (m.downloads as number) ?? 0,
        likes: (m.likes as number) ?? 0,
        library: (m.library_name as string) ?? null,
        gated: (m.gated as boolean | string) ?? false,
      })
    }
  }
  const hits = [...byId.values()]
    .sort((a, b) => (sort === "likes" ? b.likes - a.likes : b.downloads - a.downloads))
    .slice(0, limit)

  return NextResponse.json({ ok: true, hits })
}
