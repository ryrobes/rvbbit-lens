import { NextResponse } from "next/server"

export const runtime = "nodejs"

/**
 * Proxy + normalize Hugging Face Hub metadata for a model id, so the
 * desktop can infer a deploy plan without hitting CORS or leaking an
 * HF token to the browser.
 *
 * Reads two public endpoints:
 *   - https://huggingface.co/api/models/{id}   (pipeline_tag, tags, …)
 *   - https://huggingface.co/{id}/resolve/main/config.json  (best-effort)
 *
 * Returns a flat `meta` shape consumed by inferHfModel(). The actual
 * task/handler/signature inference lives client-side (hf-models.ts) so
 * it stays pure and testable.
 */

const HF_API = "https://huggingface.co/api/models"
const HF_RESOLVE = "https://huggingface.co"

function authHeaders(): Record<string, string> {
  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}

interface HfConfig {
  architectures?: string[]
  id2label?: Record<string, string>
  num_labels?: number
  problem_type?: string | null
  max_position_embeddings?: number
}

/**
 * Pull a one-paragraph description out of a model card README:
 * drop the YAML frontmatter, headings, badges/images, and HTML, then
 * take the first substantive prose paragraph (capped).
 */
function extractDescription(md: string): string | null {
  let body = md.replace(/^﻿/, "")
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3)
    if (end !== -1) body = body.slice(body.indexOf("\n", end + 1) + 1)
  }
  const paras = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/<[^>]+>/g, "") // html tags
    .split(/\n\s*\n/)
  for (const raw of paras) {
    const p = raw
      .replace(/^#{1,6}\s.*$/gm, "") // heading lines
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
      .replace(/[*_`>#|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (p.length >= 40 && /[a-zA-Z]/.test(p)) {
      return p.length > 320 ? p.slice(0, 317).trimEnd() + "…" : p
    }
  }
  return null
}

export async function GET(req: Request) {
  const id = (new URL(req.url).searchParams.get("id") ?? "").trim()
  if (!id) {
    return NextResponse.json({ ok: false, error: "id query param required" }, { status: 400 })
  }
  // owner/name or bare name; no path traversal or query smuggling.
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(id)) {
    return NextResponse.json({ ok: false, error: `invalid model id: ${id}` }, { status: 400 })
  }

  const headers = authHeaders()

  let api: Response
  try {
    api = await fetch(`${HF_API}/${id}`, { headers })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Hugging Face unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    )
  }
  if (api.status === 404) {
    return NextResponse.json({ ok: false, error: `model not found on Hugging Face: ${id}` }, { status: 404 })
  }
  if (api.status === 401 || api.status === 403) {
    return NextResponse.json(
      { ok: false, error: `model is gated or private: ${id}. Set HF_TOKEN to inspect it.` },
      { status: api.status },
    )
  }
  if (!api.ok) {
    return NextResponse.json({ ok: false, error: `Hugging Face API error ${api.status}` }, { status: 502 })
  }

  const apiJson = (await api.json().catch(() => ({}))) as Record<string, unknown>

  // config.json (labels/problem_type) + README (description) in parallel —
  // both best-effort: a few repos omit one or the other.
  const [config, description] = await Promise.all([
    (async (): Promise<HfConfig | null> => {
      try {
        const c = await fetch(`${HF_RESOLVE}/${id}/resolve/main/config.json`, {
          headers,
          redirect: "follow",
        })
        if (!c.ok) return null
        const raw = (await c.json()) as HfConfig
        return {
          architectures: raw.architectures,
          id2label: raw.id2label,
          num_labels: raw.num_labels,
          problem_type: raw.problem_type ?? null,
          max_position_embeddings: raw.max_position_embeddings,
        }
      } catch {
        return null
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        const r = await fetch(`${HF_RESOLVE}/${id}/resolve/main/README.md`, {
          headers,
          redirect: "follow",
        })
        if (!r.ok) return null
        return extractDescription(await r.text())
      } catch {
        return null
      }
    })(),
  ])

  const cardData = (apiJson.cardData as Record<string, unknown>) ?? {}
  const lang = cardData.language
  const safetensors = (apiJson.safetensors as Record<string, unknown>) ?? {}

  const meta = {
    id,
    pipelineTag: (apiJson.pipeline_tag as string) ?? null,
    libraryName: (apiJson.library_name as string) ?? null,
    tags: Array.isArray(apiJson.tags) ? (apiJson.tags as string[]) : [],
    gated: (apiJson.gated as boolean | string) ?? false,
    config,
    downloads: (apiJson.downloads as number) ?? 0,
    likes: (apiJson.likes as number) ?? 0,
    author: (apiJson.author as string) ?? null,
    license: (cardData.license as string) ?? null,
    languages: Array.isArray(lang) ? (lang as string[]) : lang ? [String(lang)] : [],
    params: (safetensors.total as number) ?? null,
    lastModified: (apiJson.lastModified as string) ?? null,
    description,
  }

  return NextResponse.json({ ok: true, meta })
}
