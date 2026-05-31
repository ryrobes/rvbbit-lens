import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

interface Body {
  connectionId?: string
  url?: string
  catalogSource?: string
  prune?: boolean
}

interface ImportableEntry {
  id: string
  catalogEntry: Record<string, unknown>
  capabilityManifest: Record<string, unknown>
}

function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function sourceFromUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `url:${u.hostname}${u.pathname}`
  } catch {
    return "url:external"
  }
}

function normalizeEntry(item: unknown, index: number): ImportableEntry {
  if (!isObj(item)) throw new Error(`capabilities[${index}] is not an object`)

  const catalogEntry = isObj(item.catalog_entry)
    ? item.catalog_entry
    : Object.fromEntries(
        Object.entries(item).filter(
          ([k]) => k !== "capability_manifest" && k !== "manifest" && k !== "catalog_entry",
        ),
      )
  const manifest = item.capability_manifest ?? item.manifest

  if (!isObj(catalogEntry)) {
    throw new Error(`capabilities[${index}] has no catalog entry object`)
  }
  if (!isObj(manifest)) {
    throw new Error(
      `capabilities[${index}] is missing capability_manifest; publish a seed-json style catalog for installs`,
    )
  }

  const id = String(catalogEntry.id ?? catalogEntry.manifest_path ?? manifest.name ?? "").trim()
  if (!id) throw new Error(`capabilities[${index}] has no id`)

  return { id, catalogEntry, capabilityManifest: manifest }
}

function parseCatalog(doc: unknown): ImportableEntry[] {
  if (!isObj(doc)) throw new Error("catalog document must be a JSON object")
  const rows = doc.capabilities
  if (!Array.isArray(rows)) throw new Error("catalog document must contain capabilities[]")
  return rows.map(normalizeEntry)
}

function buildImportSql(entries: ImportableEntry[], source: string, prune: boolean): string {
  const keepIds = entries.map((e) => e.id)
  const calls = entries.map((e) =>
    [
      "SELECT rvbbit.upsert_capability_catalog_entry(",
      `  catalog_entry       => ${sqlLit(JSON.stringify(e.catalogEntry))}::jsonb,`,
      `  capability_manifest => ${sqlLit(JSON.stringify(e.capabilityManifest))}::jsonb,`,
      `  catalog_source      => ${sqlLit(source)},`,
      "  entry_active        => true",
      ");",
    ].join("\n"),
  )
  if (prune) {
    const ids = `ARRAY[${keepIds.map(sqlLit).join(",")}]::text[]`
    calls.push(
      `SELECT rvbbit.prune_capability_catalog(catalog_source => ${sqlLit(source)}, keep_ids => ${ids}) AS pruned;`,
    )
  }
  calls.push(
    `SELECT ${entries.length}::int AS imported, ${sqlLit(source)}::text AS catalog_source, ${sqlLit(keepIds.join(","))}::text AS ids;`,
  )
  return calls.join("\n\n")
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.connectionId || !body?.url) {
    return NextResponse.json(
      { ok: false, error: "connectionId and url required" },
      { status: 400 },
    )
  }

  let url: URL
  try {
    url = new URL(body.url)
  } catch {
    return NextResponse.json({ ok: false, error: "url must be absolute" }, { status: 400 })
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json(
      { ok: false, error: "catalog url must use http or https" },
      { status: 400 },
    )
  }

  try {
    const fetched = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
    })
    if (!fetched.ok) {
      return NextResponse.json(
        { ok: false, error: `catalog fetch failed: HTTP ${fetched.status}` },
        { status: 200 },
      )
    }
    const doc = (await fetched.json()) as unknown
    const entries = parseCatalog(doc)
    if (entries.length === 0) {
      return NextResponse.json({ ok: false, error: "catalog contains no capabilities" })
    }

    const source = body.catalogSource?.trim() || sourceFromUrl(body.url)
    const sql = buildImportSql(entries, source, body.prune === true)
    const result = await executeQuery(body.connectionId, sql, { rowLimit: 20 })
    return NextResponse.json({
      ok: true,
      imported: entries.length,
      catalogSource: source,
      ids: entries.map((e) => e.id),
      durationMs: result.durationMs,
      rowCount: result.rowCount,
    })
  } catch (err) {
    const e = err as Error & { code?: string; detail?: string; hint?: string }
    return NextResponse.json({
      ok: false,
      error: e.message ?? String(err),
      code: e.code,
      detail: e.detail,
      hint: e.hint,
    })
  }
}
