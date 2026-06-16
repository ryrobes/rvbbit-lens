import { NextResponse } from "next/server"
import { getPool } from "@/lib/db/pool"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Rvbbit-vision palette endpoint.
 *
 * Discovery (GET):  /api/desktop/palette-vision?connectionId=…
 *   → { available, specialistName?, model?, endpointUrl? }
 *
 * Extraction (POST): { connectionId, imageBase64, prompt? }
 *   → { palette: ImagePalette } | { error }
 *
 * Convention: the user registers a vision-capable HTTP endpoint as a
 * backend *named "vision"*, like:
 *
 *   SELECT rvbbit.register_backend(
 *     'vision', 'https://api.openai.com/v1/chat/completions', 'openai',
 *     backend_opts => '{"model":"gpt-4o","kind":"vision"}',
 *     backend_auth_env => 'OPENAI_API_KEY'
 *   );
 *
 * The endpoint must speak OpenAI-compatible /v1/chat/completions with
 * vision support. The route formats a deterministic prompt asking for
 * a JSON palette and parses the response.
 */

const PALETTE_PROMPT = `You are a UI palette extractor. Given the attached image, identify six colors that would form a cohesive desktop theme:

- vibrant: a punchy, saturated dominant color taken directly from the image
- darkVibrant: a darker version of that color for deep highlights and main accents on light backgrounds
- lightVibrant: a lighter, brighter version for gentle highlights on dark backgrounds
- muted: a subtle, desaturated supporting color for chrome / frame surfaces
- darkMuted: a darker muted color for background depth
- lightMuted: a lighter muted color for soft surfaces in light themes

Return ONLY a JSON object — no markdown, no explanation — with this exact shape:

{
  "vibrant": "oklch(L% C H)",
  "darkVibrant": "oklch(L% C H)",
  "lightVibrant": "oklch(L% C H)",
  "muted": "oklch(L% C H)",
  "darkMuted": "oklch(L% C H)",
  "lightMuted": "oklch(L% C H)",
  "baseHue": 0-360,
  "chroma": 0.0-0.4
}

L is lightness percent (0-100). C is chroma (0-0.4 typical). H is hue degrees (0-360).
baseHue should be the image's dominant hue identity. chroma should be the typical saturation of the punchy swatches.

Aim for harmony over literal pixel-frequency dominance — pick colors that would feel good together on a UI, not just the most-pixels color.`

interface Specialist {
  name: string
  transport: string
  endpoint_url: string
  model: string | null
  auth_header_env: string | null
}

async function findVisionSpecialist(connectionId: string): Promise<Specialist | null> {
  try {
    const { pool } = await getPool(connectionId, undefined, "meta")
    const r = await pool.query<Specialist>(
      `SELECT name, transport, endpoint_url,
              (transport_opts->>'model') AS model,
              auth_header_env
       FROM rvbbit.backends
       WHERE name = 'vision'
          OR (transport_opts->>'kind') = 'vision'
       ORDER BY name = 'vision' DESC
       LIMIT 1`,
    )
    return r.rows[0] ?? null
  } catch {
    // rvbbit not installed, or schema missing.
    return null
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const connectionId = url.searchParams.get("connectionId")
  if (!connectionId) {
    return NextResponse.json({ available: false, error: "connectionId required" }, { status: 400 })
  }
  const s = await findVisionSpecialist(connectionId)
  if (!s) return NextResponse.json({ available: false })
  return NextResponse.json({
    available: true,
    specialistName: s.name,
    model: s.model,
    endpointUrl: s.endpoint_url,
    authEnvSet: !!(s.auth_header_env && process.env[s.auth_header_env]),
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as
    | { connectionId?: string; imageBase64?: string; prompt?: string }
    | null
  if (!body?.connectionId || !body?.imageBase64) {
    return NextResponse.json({ error: "connectionId and imageBase64 required" }, { status: 400 })
  }

  const specialist = await findVisionSpecialist(body.connectionId)
  if (!specialist) {
    return NextResponse.json({ error: "no vision specialist registered" }, { status: 404 })
  }

  // Read API key from the env var the specialist record points at.
  // We never log or echo the key.
  const apiKey = specialist.auth_header_env ? process.env[specialist.auth_header_env] : null
  if (specialist.auth_header_env && !apiKey) {
    return NextResponse.json(
      { error: `env var ${specialist.auth_header_env} is not set on the rvbbit-lens server` },
      { status: 503 },
    )
  }

  const model = specialist.model ?? "gpt-4o"
  const dataUrl = body.imageBase64.startsWith("data:")
    ? body.imageBase64
    : `data:image/png;base64,${body.imageBase64}`

  try {
    const resp = await fetch(specialist.endpoint_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: body.prompt ?? PALETTE_PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 400,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      return NextResponse.json(
        { error: `vision endpoint returned ${resp.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      )
    }

    const result = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = result.choices?.[0]?.message?.content
    if (!content) {
      return NextResponse.json({ error: "vision endpoint returned no content" }, { status: 502 })
    }

    const parsed = parsePaletteContent(content)
    if (!parsed) {
      return NextResponse.json({ error: "could not parse palette JSON from vision response", raw: content.slice(0, 400) }, { status: 502 })
    }

    return NextResponse.json({
      palette: {
        ...parsed,
        source: `rvbbit-vision (${model})`,
        generatedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}

interface VisionPalette {
  vibrant: string
  darkVibrant: string
  lightVibrant: string
  muted: string
  darkMuted: string
  lightMuted: string
  baseHue: number
  chroma: number
}

function parsePaletteContent(content: string): VisionPalette | null {
  // Strip any markdown fencing the model might've added.
  const stripped = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const p = parsed as Record<string, unknown>
  const required = ["vibrant", "darkVibrant", "lightVibrant", "muted", "darkMuted", "lightMuted"]
  for (const k of required) {
    if (typeof p[k] !== "string") return null
  }
  const baseHue = typeof p.baseHue === "number" ? p.baseHue : 0
  const chroma = typeof p.chroma === "number" ? p.chroma : 0.1
  return {
    vibrant: String(p.vibrant),
    darkVibrant: String(p.darkVibrant),
    lightVibrant: String(p.lightVibrant),
    muted: String(p.muted),
    darkMuted: String(p.darkMuted),
    lightMuted: String(p.lightMuted),
    baseHue,
    chroma,
  }
}
