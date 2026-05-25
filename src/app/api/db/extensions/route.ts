import { NextResponse } from "next/server"
import { loadExtensions } from "@/lib/db/schema"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  try {
    const ext = await loadExtensions(id)
    const rvbbit = ext.find((e) => e.name === "rvbbit" || e.name === "pg_rvbbit") ?? null
    return NextResponse.json({
      extensions: ext,
      hasRvbbit: !!rvbbit,
      rvbbitVersion: rvbbit?.version ?? null,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
