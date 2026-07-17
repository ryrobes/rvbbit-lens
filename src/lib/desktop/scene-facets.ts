"use client"

/**
 * Scene facets — what a scene is ABOUT, derived from its own saved windows.
 *
 * Nothing is declared: tables come from window payloads (explicit table refs
 * plus a light FROM/JOIN scan of any embedded SQL), kinds from the windows
 * themselves, the connection from the saved fingerprint. Facets make the
 * gallery searchable ("show me scenes that touch enrollments") and give each
 * card chips that say what world it opens onto.
 */

import type { Scene } from "./types"

export interface SceneFacets {
  /** Distinct relation names touched (schema.table or bare table). */
  tables: string[]
  /** Distinct window kinds in the scene. */
  kinds: string[]
  connectionLabel: string | null
}

const SQL_KEYWORDS = new Set([
  "select",
  "lateral",
  "unnest",
  "generate_series",
  "values",
  "json_each",
  "jsonb_each",
  "the", // guards against prose in non-SQL strings that happen to say "from the"
  "a",
  "an",
])

/** Pull relation identifiers out of a SQL string via FROM/JOIN scanning.
 *  Deliberately a heuristic, not a parser — facet chips, not lineage. */
function tablesFromSql(sql: string): string[] {
  const out: string[] = []
  const re = /\b(?:from|join)\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const raw = m[1].replace(/"/g, "").trim()
    const lower = raw.toLowerCase()
    if (!raw || raw.startsWith("(")) continue
    if (SQL_KEYWORDS.has(lower)) continue
    out.push(lower)
  }
  return out
}

/** Deep-walk a payload for table references: `table: {schema, name}` objects
 *  and any string stored under a key named (or ending in) "sql". */
function walkPayload(node: unknown, tables: Set<string>, depth = 0): void {
  if (depth > 6 || node == null) return
  if (Array.isArray(node)) {
    for (const item of node) walkPayload(item, tables, depth + 1)
    return
  }
  if (typeof node !== "object") return
  const obj = node as Record<string, unknown>
  const t = obj.table as { schema?: unknown; name?: unknown } | undefined
  if (t && typeof t === "object" && typeof t.name === "string") {
    const schema = typeof t.schema === "string" && t.schema ? `${t.schema}.` : ""
    tables.add(`${schema}${t.name}`.toLowerCase())
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && /(^|_)sql$/i.test(key)) {
      for (const rel of tablesFromSql(value)) tables.add(rel)
    } else if (typeof value === "object" && value !== null) {
      walkPayload(value, tables, depth + 1)
    }
  }
}

const cache = new Map<string, SceneFacets>()

export function extractSceneFacets(scene: Scene): SceneFacets {
  const key = `${scene.id}:${scene.contentHash}`
  const hit = cache.get(key)
  if (hit) return hit

  const tables = new Set<string>()
  const kinds = new Set<string>()
  for (const w of scene.body.windows) {
    kinds.add(w.kind)
    walkPayload(w.payload, tables)
  }

  const facets: SceneFacets = {
    tables: [...tables].sort(),
    kinds: [...kinds].sort(),
    connectionLabel:
      scene.connection?.label ?? scene.connection?.database ?? null,
  }
  // Bounded cache — scenes are few; guard against pathological growth anyway.
  if (cache.size > 500) cache.clear()
  cache.set(key, facets)
  return facets
}

/** Case-insensitive match across name, tables, kinds, window titles, and
 *  connection — the gallery search contract. */
export function sceneMatchesQuery(scene: Scene, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (scene.name.toLowerCase().includes(q)) return true
  const facets = extractSceneFacets(scene)
  if (facets.connectionLabel?.toLowerCase().includes(q)) return true
  if (facets.tables.some((t) => t.includes(q))) return true
  if (facets.kinds.some((k) => k.includes(q))) return true
  return scene.body.windows.some((w) => (w.title ?? "").toLowerCase().includes(q))
}
