"use client"

/**
 * Field-focused SQL — when a single COLUMN is opened (from Scry or the Data
 * Search window) we want a view OF THAT FIELD, not `SELECT *` of its table:
 *   - categorical → value distribution (GROUP BY + count)
 *   - numeric     → aggregate summary (sum / avg / min / max / count)
 * Numeric-ness is detected best-effort via information_schema; on any doubt we
 * fall back to the distribution (which is meaningful for any type).
 */

// Always double-quote identifiers (unlike sql-builder's quoteSqlIdent, which
// leaves simple lowercase names bare and so breaks on reserved words like
// a column/table literally named "order").
function quoteIdent(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`
}

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "real",
  "double precision",
  "money",
])

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

export async function fetchFieldFocusSql(
  connectionId: string,
  schema: string,
  rel: string,
  col: string,
): Promise<string> {
  let numeric = false
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql:
          `SELECT data_type FROM information_schema.columns ` +
          `WHERE table_schema = ${sqlStr(schema)} AND table_name = ${sqlStr(rel)} ` +
          `AND column_name = ${sqlStr(col)} LIMIT 1`,
        rowLimit: 1,
      }),
    })
    const j = (await res.json()) as { ok?: boolean; rows?: Array<{ data_type?: unknown }> }
    const dt = j?.ok && j.rows?.[0]?.data_type ? String(j.rows[0].data_type).toLowerCase() : ""
    numeric = NUMERIC_TYPES.has(dt)
  } catch {
    // leave numeric=false → distribution
  }

  const tbl = `${quoteIdent(schema)}.${quoteIdent(rel)}`
  const c = quoteIdent(col)
  return numeric
    ? `SELECT count(*) AS n_rows,\n       count(${c}) AS n_non_null,\n       sum(${c}) AS sum,\n       avg(${c}) AS avg,\n       min(${c}) AS min,\n       max(${c}) AS max\nFROM ${tbl};`
    : `SELECT ${c} AS value, count(*) AS n\nFROM ${tbl}\nGROUP BY 1\nORDER BY n DESC\nLIMIT 200;`
}
