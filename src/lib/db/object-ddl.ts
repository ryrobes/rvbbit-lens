"use client"

/**
 * Object DDL — reconstruct the `CREATE …` script for a database object so a SQL
 * client can show / copy it. Tables are assembled from the catalog (columns +
 * constraints + indexes); views/matviews use pg_get_viewdef. Runs through the
 * normal read-only query endpoint — no new server route.
 */

function qId(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

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
      body: JSON.stringify({ connectionId, sql, rowLimit: 2000, readOnly: true }),
    })
    return (await res.json()) as QueryResp
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface DdlColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  generated: string // '' normal | 's' STORED generated
  identity: string // '' normal | 'a' ALWAYS | 'd' BY DEFAULT
}

/** Build the CREATE script for `schema.name`. `kind` chooses the strategy. */
export async function fetchObjectDdl(
  connectionId: string,
  schema: string,
  name: string,
  kind: string,
): Promise<{ ddl: string; error?: string }> {
  const qual = `${qId(schema)}.${qId(name)}`
  const reg = lit(`${qId(schema)}.${qId(name)}`)

  if (kind === "view" || kind === "matview") {
    const res = await runQuery(connectionId, `SELECT pg_get_viewdef(${reg}::regclass, true) AS def`)
    if (!res.ok) return { ddl: "", error: res.error }
    const def = String(res.rows?.[0]?.def ?? "").trim()
    if (!def) return { ddl: "", error: "view definition not found" }
    const verb = kind === "matview" ? "MATERIALIZED VIEW" : "VIEW"
    return { ddl: `CREATE ${verb} ${qual} AS\n${def}` }
  }

  // table / partition / foreign — assemble from the catalog in one round-trip.
  const sql = `
    WITH cols AS (
      SELECT coalesce(json_agg(json_build_object(
               'name', a.attname,
               'type', format_type(a.atttypid, a.atttypmod),
               'notnull', a.attnotnull,
               'default', pg_get_expr(d.adbin, d.adrelid),
               'generated', a.attgenerated,
               'identity', a.attidentity
             ) ORDER BY a.attnum), '[]'::json) AS v
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ${reg}::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ),
    cons AS (
      SELECT coalesce(json_agg(json_build_object('name', conname, 'def', pg_get_constraintdef(oid))
               ORDER BY (contype = 'p') DESC, conname), '[]'::json) AS v
        FROM pg_constraint WHERE conrelid = ${reg}::regclass
    ),
    idx AS (
      SELECT coalesce(json_agg(indexdef ORDER BY indexname), '[]'::json) AS v
        FROM pg_indexes
       WHERE schemaname = ${lit(schema)} AND tablename = ${lit(name)}
         AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = ${reg}::regclass)
    )
    SELECT (SELECT v FROM cols) AS cols, (SELECT v FROM cons) AS cons, (SELECT v FROM idx) AS idx`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { ddl: "", error: res.error }
  const row = res.rows?.[0]
  if (!row) return { ddl: "", error: "object not found" }
  const cols = (row.cols as DdlColumn[] | null) ?? []
  const cons = (row.cons as Array<{ name: string; def: string }> | null) ?? []
  const idx = (row.idx as string[] | null) ?? []
  if (cols.length === 0) return { ddl: "", error: "no columns (not a table?)" }

  const lines: string[] = cols.map((c) => {
    let line = `  ${qId(c.name)} ${c.type}`
    if (c.identity === "a" || c.identity === "d") {
      // identity columns are implicitly NOT NULL; no DEFAULT.
      line += ` GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`
    } else if (c.generated === "s" && c.default != null) {
      // a generated column's expression lives in pg_attrdef (the `default` field).
      line += ` GENERATED ALWAYS AS (${c.default}) STORED`
      if (c.notnull) line += " NOT NULL"
    } else {
      if (c.notnull) line += " NOT NULL"
      if (c.default != null) line += ` DEFAULT ${c.default}`
    }
    return line
  })
  for (const c of cons) lines.push(`  CONSTRAINT ${qId(c.name)} ${c.def}`)

  let ddl = `CREATE TABLE ${qual} (\n${lines.join(",\n")}\n);`
  if (idx.length > 0) ddl += "\n\n" + idx.map((s) => `${s};`).join("\n")
  return { ddl }
}
