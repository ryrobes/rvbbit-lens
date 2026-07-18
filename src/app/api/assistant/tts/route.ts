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

  const call = (modelId: string, voiceSettings: Record<string, number>) =>
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: clipped,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    })

  try {
    // eleven_v3 first (markedly more expressive). Its voice_settings contract
    // differs: stability is the only dial (0 creative / 0.5 natural / 1 robust)
    // — similarity_boost belongs to the v2 family. Accounts or voices without
    // v3 access get a model-related 4xx, so fall back to turbo rather than
    // breaking anyone's voice.
    let upstream = await call("eleven_v3", { stability: 0.5 })
    if (!upstream.ok && upstream.status !== 401) {
      const firstErr = await upstream.text().catch(() => "")
      if (/model/i.test(firstErr) || upstream.status === 404 || upstream.status === 400) {
        upstream = await call("eleven_turbo_v2_5", { stability: 0.4, similarity_boost: 0.75 })
      } else {
        return new NextResponse(firstErr || `ElevenLabs error ${upstream.status}`, { status: 502 })
      }
    }
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
