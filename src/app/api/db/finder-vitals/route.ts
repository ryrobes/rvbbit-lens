import { NextResponse } from "next/server"
import { getConnection } from "@/lib/db/registry"
import { loadFinderVitals } from "@/lib/db/finder-vitals"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  const connection = await getConnection(id)
  if (!connection) return NextResponse.json({ error: "connection not found" }, { status: 404 })
  try {
    const vitals = await loadFinderVitals(id)
    return NextResponse.json({ connectionId: id, generatedAt: new Date().toISOString(), vitals })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // Vitals are decoration on the tree — a failure degrades to neutral rows,
    // never an error state in the Finder.
    return NextResponse.json({ connectionId: id, generatedAt: new Date().toISOString(), vitals: [], error })
  }
}
