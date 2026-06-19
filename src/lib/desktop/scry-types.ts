"use client"

/**
 * Scry object-"type" model — the dimension the type filter + color legend act on.
 *
 * A node's `objectType` is **source-aware**: for brain `document` nodes it's the
 * provider+source ("Linear · all", "Fireflies · meetings", …) so meeting notes
 * read separately from Linear tickets; for everything else (entities like
 * person/event/topic, or structure like db_table/db_column) it's the KG `kind`.
 *
 * The JS derivation here and the SQL `SQL_OBJECT_TYPE` below MUST stay identical
 * so the legend's counts, the search filter, and the node colors all agree.
 */

/** Object type from a search hit (carries `kind` + enriched `source`). */
export function objectType(hit: { kind: string; source: string | null }): string {
  if (hit.kind === "document") return hit.source && hit.source.trim() ? hit.source : "document"
  return hit.kind
}

/** Object type from a context/neighborhood node (carries `kind` + `properties`). */
export function objectTypeFromProps(kind: string, properties: unknown): string {
  if (kind !== "document") return kind
  const src =
    properties && typeof properties === "object" && typeof (properties as Record<string, unknown>).source === "string"
      ? ((properties as Record<string, unknown>).source as string).trim()
      : ""
  return src || "document"
}

/** SQL expression computing the SAME objectType over `rvbbit.kg_nodes`. */
export const SQL_OBJECT_TYPE =
  "CASE WHEN kind = 'document' " +
  "THEN coalesce(nullif(trim(properties->>'source'), ''), 'document') " +
  "ELSE kind END"

/** Friendly label for a type token (the token is already human-readable; just
 *  de-prefix the db structure kinds). */
export function objectTypeLabel(type: string): string {
  if (type === "db_table") return "table"
  if (type === "db_column") return "column"
  return type
}

export interface ScryTypeBucket {
  type: string
  count: number
  color: string
}

// Deterministic color per type token — stable across renders, shared by the
// legend swatches and the node fills in "type" color mode.
const TYPE_PALETTE = [
  "#34d3e0", "#f5c15d", "#a78bfa", "#55c979", "#fb7185", "#60a5fa",
  "#f97316", "#14b8a6", "#e879f9", "#facc15", "#38bdf8", "#fb923c",
  "#4ade80", "#c084fc", "#2dd4bf", "#f472b6", "#818cf8", "#fdba74",
]
// A few common kinds get fixed hues so the palette reads consistently.
const FIXED_COLOR: Record<string, string> = {
  db_table: "#60a5fa",
  db_column: "#38bdf8",
  document: "#f5c15d",
  person: "#fb7185",
  organization: "#a78bfa",
  event: "#55c979",
  topic: "#34d3e0",
}
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
export function colorForType(type: string): string {
  return FIXED_COLOR[type] ?? TYPE_PALETTE[hashStr(type) % TYPE_PALETTE.length]
}

// ── Type distribution (legend source) ───────────────────────────────

interface QueryResp {
  ok: boolean
  rows?: Array<Record<string, unknown>>
  error?: string
}
async function runQuery(connectionId: string, sql: string): Promise<QueryResp> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 200 }),
    })
    return (await res.json()) as QueryResp
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * The object-type composition of a KG graph — every type present + its count,
 * newest-dominant first. Drives the filter dropdown + the color legend, so a
 * toggled-off type stays listed (you can turn it back on).
 */
export async function fetchGraphTypeDistribution(
  connectionId: string,
  graph: string,
): Promise<{ buckets: ScryTypeBucket[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${SQL_OBJECT_TYPE} AS type, count(*) AS n
       FROM rvbbit.kg_nodes
      WHERE graph_id = ${sqlStr(graph)}
      GROUP BY 1
      ORDER BY n DESC, type`,
  )
  if (!res.ok || !res.rows) return { buckets: [], error: res.error }
  const buckets: ScryTypeBucket[] = res.rows
    .map((r) => ({ type: String(r.type ?? ""), count: Number(r.n ?? 0), color: colorForType(String(r.type ?? "")) }))
    .filter((b) => b.type)
  return { buckets }
}
