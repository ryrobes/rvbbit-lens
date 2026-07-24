import { NextResponse } from "next/server"
import { publishDeck, type DeckSpec } from "@/lib/server/decks"

export const runtime = "nodejs"

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    name?: string
    description?: string
    spec?: DeckSpec
  } | null
  if (!body?.connectionId || !body?.name || !body?.spec) {
    return NextResponse.json(
      { ok: false, error: "connectionId, name, and spec required" },
      { status: 400 },
    )
  }
  try {
    const result = await publishDeck(body.connectionId, {
      name: body.name,
      description: body.description,
      spec: body.spec,
    })
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
