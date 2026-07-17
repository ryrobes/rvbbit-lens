import { NextResponse } from "next/server"

export const runtime = "nodejs"

// ElevenLabs text-to-speech proxy. The key travels from the browser's local
// voice settings; we never persist it. Server-side so streaming + CORS are
// non-issues and the key isn't embedded in a client bundle.
export async function POST(req: Request) {
  let body: { text?: string; voiceId?: string; key?: string }
  try {
    body = await req.json()
  } catch {
    return new NextResponse("bad request body", { status: 400 })
  }
  const text = (body.text ?? "").trim()
  const voiceId = (body.voiceId ?? "").trim()
  const key = (body.key ?? "").trim()
  if (!text) return new NextResponse("text required", { status: 400 })
  if (!voiceId) return new NextResponse("voiceId required", { status: 400 })
  if (!key) return new NextResponse("ElevenLabs key required", { status: 400 })

  // Cap length defensively — a runaway reply shouldn't bill a novel.
  const clipped = text.length > 5000 ? text.slice(0, 5000) : text

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: clipped,
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.4, similarity_boost: 0.75 },
        }),
      },
    )
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "")
      // Surface ElevenLabs' own error (bad key, unknown voice, quota) verbatim.
      return new NextResponse(detail || `ElevenLabs error ${upstream.status}`, {
        status: upstream.status === 401 ? 401 : 502,
      })
    }
    const audio = await upstream.arrayBuffer()
    return new NextResponse(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    })
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "TTS proxy failed", {
      status: 502,
    })
  }
}
