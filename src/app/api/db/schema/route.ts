import { NextResponse } from "next/server"
import type { SchemaSnapshot } from "@/lib/db/types"
import { getConnection } from "@/lib/db/registry"
import { loadSchema, loadStructureFingerprint } from "@/lib/db/schema"

export const runtime = "nodejs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("connectionId")
  if (!id) return NextResponse.json({ error: "connectionId required" }, { status: 400 })
  const connection = await getConnection(id)
  if (!connection) return NextResponse.json({ error: "connection not found" }, { status: 404 })
  try {
    // Fingerprint-gated: when the client's last-seen structure fingerprint
    // still matches, skip building (and shipping) the ~1MB snapshot entirely.
    // A null fingerprint (query failed) falls through to a full load.
    const clientFp = url.searchParams.get("fp")
    const fingerprint = await loadStructureFingerprint(id)
    if (clientFp && fingerprint && clientFp === fingerprint) {
      return NextResponse.json({ unchanged: true, fingerprint })
    }
    const snapshot = await loadSchema(id)
    snapshot.fingerprint = fingerprint
    return NextResponse.json(snapshot)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const database = connection.database || "postgres"
    const snapshot: SchemaSnapshot = {
      connectionId: id,
      generatedAt: new Date().toISOString(),
      databases: [database],
      currentDatabase: database,
      schemas: [],
      tables: [],
      functions: [],
      extensions: [],
      hasRvbbit: false,
      rvbbitVersion: null,
      error,
    }
    return NextResponse.json(snapshot)
  }
}
