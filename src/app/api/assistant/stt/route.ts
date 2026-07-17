import { NextResponse } from "next/server"

export const runtime = "nodejs"

// ElevenLabs Scribe speech-to-text proxy. Same key-handling stance as TTS:
// the browser's local key rides the request, never persisted, forwarded to
// ElevenLabs server-side (multipart is far cleaner here than from the browser).
export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 })
  }
  const audio = form.get("audio")
  const key = String(form.get("key") ?? "").trim()
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "audio file required" }, { status: 400 })
  }
  if (!key) {
    return NextResponse.json({ error: "ElevenLabs key required" }, { status: 400 })
  }

  try {
    const upstream = new FormData()
    upstream.append("file", audio, "clip.webm")
    upstream.append("model_id", "scribe_v1")
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: upstream,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      return NextResponse.json(
        { error: detail || `ElevenLabs error ${res.status}` },
        { status: res.status === 401 ? 401 : 502 },
      )
    }
    const body = (await res.json()) as { text?: string }
    return NextResponse.json({ text: body.text ?? "" })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STT proxy failed" },
      { status: 502 },
    )
  }
}
