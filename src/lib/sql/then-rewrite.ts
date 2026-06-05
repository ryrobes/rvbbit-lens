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
import type { JsonbProjectionColumn } from "@/lib/desktop/types"

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

/**
 * True if `sql` selects from the executing text-to-SQL source `rvbbit.synth(…)`
 * (which returns one jsonb column per row, like flow). Matches `rvbbit.synth(`
 * but NOT `rvbbit.synth_sql(` (that returns the SQL text, not a rowset), so its
 * results get the same key-expansion treatment as a pipeline.
 */
export function isSynthQuery(sql: string): boolean {
  return /\brvbbit\.synth\s*\(/i.test(sql)
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
export function expandFlowResult(result: QueryResult, cols?: JsonbProjectionColumn[]): QueryResult {
  if (result.columns.length !== 1) return result
  const col = result.columns[0].name
  const objs = result.rows.map((r) => r[col])
  if (objs.length === 0) return result
  if (!objs.every((o) => o !== null && typeof o === "object" && !Array.isArray(o))) {
    return result
  }
  // Tag each expanded column with its Postgres type (not a blanket "jsonb") so the
  // grid formats it and the rollup/drag-out UI classifies numeric fields as
  // aggregatable metrics. Prefer the compiler's AUTHORITATIVE schema (synth_schema)
  // when supplied; otherwise infer from the rows. Display types mirror
  // buildJsonbProjection's casts, so the grid and the derived SQL agree.
  const schema = cols && cols.length > 0 ? cols : inferJsonbColumns(objs as Record<string, unknown>[])
  if (schema.length === 0) return result
  const columns: QueryResultColumn[] = schema.map((c) => ({
    name: c.name,
    dataTypeId: JSONB_KIND_OID[c.kind],
    dataTypeName: c.pgType ?? c.kind,
  }))
  return { ...result, columns, rows: objs as Record<string, unknown>[] }
}

/** Postgres type OIDs for inferred jsonb-column kinds, so the rollup classifier's
 * OID-based numeric check (and the type-name regex) both agree. */
const JSONB_KIND_OID: Record<JsonbProjectionColumn["kind"], number> = {
  numeric: 1700, // numeric
  boolean: 16, // bool
  jsonb: 3802, // jsonb
  text: 25, // text
}

/**
 * Infer the column shape of an expanded jsonb result (the rows produced by
 * expandFlowResult) so a SQL-level projection can cast each field for
 * aggregation. Per key: all-number → numeric, all-bool → boolean, any
 * object/array → jsonb, else text (the safe default for mixed/null).
 */
export function inferJsonbColumns(objs: Record<string, unknown>[]): JsonbProjectionColumn[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of objs) {
    if (o === null || typeof o !== "object") continue
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k) }
    }
  }
  return keys.map((name) => {
    let sawNum = false
    let sawBool = false
    let sawStr = false
    let sawNested = false
    for (const o of objs) {
      const v = (o as Record<string, unknown>)[name]
      if (v === null || v === undefined) continue
      if (typeof v === "number") sawNum = true
      else if (typeof v === "boolean") sawBool = true
      else if (typeof v === "object") sawNested = true
      else sawStr = true
    }
    const kind: JsonbProjectionColumn["kind"] = sawNested
      ? "jsonb"
      : sawStr
        ? "text"
        : sawBool && !sawNum
          ? "boolean"
          : sawNum && !sawBool
            ? "numeric"
            : "text"
    return { name, kind }
  })
}

function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Build a typed projection that lifts a jsonb-returning block's single column
 * into real columns, e.g.
 *   SELECT (__v->>'season') AS "season", (__v->>'n')::numeric AS "n"
 *   FROM ( <innerSql> ) _rvbbit_src(__v)
 * The single output column is renamed positionally to `__v` via the
 * `_rvbbit_src(__v)` alias list, so the projection is agnostic to its real name
 * (both rvbbit.synth and rvbbit.flow emit a column named `value`; `SELECT *` over a
 * function can surface other names). `innerSql` MUST be valid standalone SQL — used
 * for rvbbit.synth (it is); a bare-`then` pipeline is not (it needs flow() wrapping)
 * so those are not projected here.
 */
export function buildJsonbProjection(innerSql: string, cols: JsonbProjectionColumn[]): string {
  const inner = innerSql.trim().replace(/;\s*$/, "")
  const proj = cols
    .map((c) => {
      const key = c.name.replace(/'/g, "''")
      const alias = quoteSqlIdent(c.name)
      if (c.kind === "jsonb") return `(__v->'${key}') AS ${alias}`
      // Authoritative cast when the compiler gave us the exact Postgres type
      // (rvbbit.synth_schema) — exact for bigint/date/etc., not a numeric guess.
      const pg = c.pgType && safePgType(c.pgType) ? c.pgType : null
      if (pg) return `(__v->>'${key}')::${pg} AS ${alias}`
      if (c.kind === "numeric") return `(__v->>'${key}')::numeric AS ${alias}`
      if (c.kind === "boolean") return `(__v->>'${key}')::boolean AS ${alias}`
      return `(__v->>'${key}') AS ${alias}`
    })
    .join(", ")
  return `SELECT ${proj} FROM (\n${inner}\n) _rvbbit_src(__v)`
}

/** A Postgres type name is safe to inline in a `::cast` if it's a canonical type
 * name (letters, digits, spaces, and `()[],` for modifiers/arrays). The value comes
 * from the server's catalog (regtype::text), so this is defense-in-depth. */
function safePgType(t: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9 _]*(\(\d+(,\s*\d+)?\))?(\s*\[\])?$/.test(t.trim())
}

/** Map a Postgres type name to the coarse projection kind for UI classification. */
export function pgTypeToKind(type: string): JsonbProjectionColumn["kind"] {
  const t = type.toLowerCase().trim()
  if (t === "boolean" || t === "bool") return "boolean"
  if (t === "jsonb" || t === "json" || t.endsWith("[]") || t.includes("record")) return "jsonb"
  if (
    /\b(int|integer|bigint|smallint|numeric|decimal|double|real|float|money)\b/.test(t) ||
    t.includes("number")
  ) {
    return "numeric"
  }
  return "text"
}

/** Build projection columns from rvbbit.synth_schema's authoritative output. */
export function columnsFromServerSchema(
  rows: { column_name: string; data_type: string }[],
): JsonbProjectionColumn[] {
  return rows.map((r) => ({
    name: r.column_name,
    kind: pgTypeToKind(r.data_type),
    pgType: r.data_type,
  }))
}

/** Extract the intent literal from a `rvbbit.synth('…')` query so the lens can ask
 * the server for its authoritative schema. Handles doubled single-quote escapes.
 * Returns null if it can't be confidently extracted (caller falls back to
 * inferring types from the result rows). */
export function extractSynthIntent(sql: string): string | null {
  const m = /\brvbbit\.synth\s*\(\s*'((?:[^']|'')*)'/i.exec(sql)
  return m ? m[1].replace(/''/g, "'") : null
}
