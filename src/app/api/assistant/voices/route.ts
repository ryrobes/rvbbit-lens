import { NextResponse } from "next/server"

export const runtime = "nodejs"

// List the user's ElevenLabs voices (id + label) for the settings dropdown.
// Key rides in the request, never persisted; forwarded server-side.
export async function POST(req: Request) {
  let body: { key?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "bad request body" }, { status: 400 })
  }
  const key = (body.key ?? "").trim()
  if (!key) return NextResponse.json({ error: "ElevenLabs key required" }, { status: 400 })

  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      return NextResponse.json(
        { error: detail || `ElevenLabs error ${res.status}` },
        { status: res.status === 401 ? 401 : 502 },
      )
    }
    const data = (await res.json()) as {
      voices?: Array<{ voice_id?: string; name?: string; category?: string }>
    }
    const voices = (data.voices ?? [])
      .filter((v) => v.voice_id)
      .map((v) => ({ id: v.voice_id as string, name: v.name || v.voice_id, category: v.category }))
    return NextResponse.json({ voices })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "voices fetch failed" },
      { status: 502 },
    )
  }
}
