import type { DesktopColumnRef } from "./types"

const NUMERIC_TYPE_IDS = new Set([
  20,    // int8
  21,    // int2
  23,    // int4
  700,   // float4
  701,   // float8
  790,   // money
  1700,  // numeric
])

export function quoteSqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

export function inferDesktopColumnRole(column: { type?: string; dataTypeId?: number }): DesktopColumnRef["role"] {
  if (column.dataTypeId != null && NUMERIC_TYPE_IDS.has(column.dataTypeId)) return "metric"
  const t = column.type?.toLowerCase() ?? ""
  if (/\b(int|integer|bigint|smallint|numeric|decimal|double|float|real|money)\b/.test(t) || t.includes("number")) {
    return "metric"
  }
  return "dimension"
}

function uniqueColumns(columns: DesktopColumnRef[]): DesktopColumnRef[] {
  const seen = new Set<string>()
  const out: DesktopColumnRef[] = []
  for (const c of columns) {
    const key = c.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function aliasSuffix(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned || "value"
}

/**
 * Build a derived "rollup" query from a parent block + a set of dragged
 * columns.
 *
 * Uses the `{parentBlockName}` reference syntax instead of inlining the
 * parent's SQL. That gives us live cascading: clicking a cell on the
 * parent filters its compiled SQL (via the implicit self-subscription),
 * which flows into every downstream `{X}` reference automatically.
 *
 * Note: the reactive engine strips trailing LIMIT/OFFSET from the inner
 * compiled SQL when expanding `{X}`, so the derived rollup runs over the
 * whole filtered result rather than a 200-row preview window.
 *
 * String-walking SQL is not a parser; if we hit dollar-quoted edge cases
 * in practice, swap in `node-sql-parser` here.
 */
export function buildColumnAggregateQuery(args: {
  parentBlockName: string
  parentTitle: string
  relationKey: string
  columns: DesktopColumnRef[]
}): { sql: string; title: string } {
  const columns = uniqueColumns(args.columns)
  const dimensions = columns.filter((c) => c.role === "dimension")
  const metrics = columns.filter((c) => c.role === "metric")
  const includeRowCount = dimensions.length > 0 || metrics.length === 0

  const selectLines = [
    ...dimensions.map((c) => `  ${quoteSqlIdent(c.name)}`),
    ...(includeRowCount ? ["  count(1) AS row_count"] : []),
    ...metrics.map((c) =>
      `  sum(${quoteSqlIdent(c.name)}) AS ${quoteSqlIdent(`sum_${aliasSuffix(c.name)}`)}`,
    ),
  ]

  const groupBy = dimensions.length > 0
    ? `\nGROUP BY ${dimensions.map((c) => quoteSqlIdent(c.name)).join(", ")}`
    : ""
  const orderBy = dimensions.length > 0 ? "\nORDER BY row_count DESC" : ""

  const sql = [
    `SELECT`,
    selectLines.join(",\n"),
    `FROM {${args.parentBlockName}}${groupBy}${orderBy};`,
  ].join("\n")

  const title = titleForColumns(args.parentTitle, columns)
  return { sql, title }
}

function titleForColumns(parentTitle: string, columns: DesktopColumnRef[]): string {
  const dimensions = columns.filter((c) => c.role === "dimension")
  const metrics = columns.filter((c) => c.role === "metric")
  if (dimensions.length > 0 && metrics.length > 0) {
    return `${parentTitle}: ${dimensions.map((c) => c.name).join(", ")} metrics`
  }
  if (dimensions.length > 0) {
    return `${parentTitle}: ${dimensions.map((c) => c.name).join(", ")} counts`
  }
  return `${parentTitle}: ${metrics.map((c) => c.name).join(", ")} sums`
}

export function previewSqlForTable(schema: string, name: string): string {
  return `SELECT *\nFROM ${quoteSqlIdent(schema)}.${quoteSqlIdent(name)}\nLIMIT 200;`
}
