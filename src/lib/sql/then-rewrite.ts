// Client-side sugar for rvbbit pipeline cascades.
//
// rvbbit.flow('select … then op(…) then op2') runs a base query then pipes the
// rowset through chained semantic operators. The THENs live inside the
// dollar-quoted string arg, so Postgres never parses them — rvbbit splits them
// itself. This module lets the SQL Desktop accept the bare form
//   select … then op(…) then op2
// by detecting a *statement-level* THEN and wrapping the whole statement as
//   SELECT * FROM rvbbit.flow($$ … $$)
// before sending. Detection mirrors the engine's splitter (it ignores THEN
// inside strings / comments / parens / CASE…END), so a normal
//   SELECT CASE WHEN x THEN 1 ELSE 0 END FROM t
// is left untouched.

import type { QueryResult, QueryResultColumn } from "@/lib/db/types"

function isWordChar(c: string): boolean {
  return c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "_"
}
function isWordStart(c: string): boolean {
  return c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c === "_"
}

function dollarTagEnd(s: string, i: number): number | null {
  if (s[i] !== "$") return null
  let j = i + 1
  while (j < s.length && isWordChar(s[j])) j++
  return s[j] === "$" ? j + 1 : null
}

/**
 * True if `sql` contains a statement-level THEN — a pipeline cascade — i.e. a
 * THEN outside strings, comments, parentheses, and CASE…END. Mirrors the Rust
 * splitter so we only wrap genuine pipelines, never a CASE…THEN query.
 */
export function hasTopLevelThen(sql: string): boolean {
  const n = sql.length
  let i = 0
  let paren = 0
  let caseDepth = 0
  while (i < n) {
    const c = sql[i]
    if (c === "-" && sql[i + 1] === "-") {
      i += 2
      while (i < n && sql[i] !== "\n") i++
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === "$") {
      const tagEnd = dollarTagEnd(sql, i)
      if (tagEnd !== null) {
        const tag = sql.slice(i, tagEnd)
        let j = tagEnd
        let closed = false
        while (j + tag.length <= n) {
          if (sql.slice(j, j + tag.length) === tag) { j += tag.length; closed = true; break }
          j++
        }
        i = closed ? j : n
        continue
      }
    }
    if (isWordStart(c)) {
      const start = i
      i++
      while (i < n && isWordChar(sql[i])) i++
      const word = sql.slice(start, i).toUpperCase()
      if (word === "CASE") caseDepth++
      else if (word === "END") { if (caseDepth > 0) caseDepth-- }
      else if (word === "THEN" && paren === 0 && caseDepth === 0) return true
      continue
    }
    if (c === "(") paren++
    else if (c === ")") { if (paren > 0) paren-- }
    i++
  }
  return false
}

const FLOW_TAGS = ["$rvbbitflow$", "$rvbbit_flow$", "$flowpipe$"]

/**
 * Wrap a pipeline statement so Postgres runs it via rvbbit.flow(); the THENs
 * stay inside the dollar-quoted string and never reach the PG parser.
 */
export function wrapFlow(sql: string): string {
  const body = sql.trim().replace(/;\s*$/, "")
  const tag = FLOW_TAGS.find((t) => !body.includes(t)) ?? "$rvbbitflowx$"
  return `SELECT * FROM rvbbit.flow(${tag}${body}${tag})`
}

/**
 * rvbbit.flow() returns one jsonb column ("value") per row. Expand those objects
 * into real columns (union of keys, first-seen order) for display in the grid.
 */
export function expandFlowResult(result: QueryResult): QueryResult {
  if (result.columns.length !== 1) return result
  const col = result.columns[0].name
  const objs = result.rows.map((r) => r[col])
  if (objs.length === 0) return result
  if (!objs.every((o) => o !== null && typeof o === "object" && !Array.isArray(o))) {
    return result
  }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of objs as Record<string, unknown>[]) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k) }
    }
  }
  if (keys.length === 0) return result
  const columns: QueryResultColumn[] = keys.map((name) => ({
    name,
    dataTypeId: 0,
    dataTypeName: "jsonb",
  }))
  return { ...result, columns, rows: objs as Record<string, unknown>[] }
}
