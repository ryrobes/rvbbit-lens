/**
 * SQL → RollupSpec parser. Keeps the rollup shelf in sync when the user
 * hand-edits the SQL in the rail: if the edited SQL matches the (narrow)
 * grammar `buildRollupQuery` emits, we recover the spec so the pills stay
 * truthful. Anything we don't fully understand returns null → the caller
 * detaches the shelf (window keeps running as plain SQL). This is
 * deliberately conservative: a recovered spec must regenerate equivalent
 * SQL, so we never silently drop a clause the shelf can't represent.
 *
 * Not a general SQL parser — it recognizes our own output:
 *   SELECT <dims…>, <measures…> FROM {block}
 *   [WHERE …] [GROUP BY …] [HAVING …] [ORDER BY …] [LIMIT n]
 * Pivots (FILTER), JOIN/subqueries/UNION/DISTINCT/CTEs → null.
 */

import type {
  DesktopColumnRef,
  DesktopQueryLineage,
  RollupAgg,
  RollupCompareOp,
  RollupFilter,
  RollupFilterOp,
  RollupGrain,
  RollupGroupTerm,
  RollupHavingTerm,
  RollupMeasure,
  RollupOrderTerm,
  RollupSpec,
} from "./types"
import {
  buildRollupQuery,
  defaultOrderExpr,
  dimExpr,
  effectiveRollup,
  measureExpr,
  rollupSpecColumns,
} from "./sql-builder"

const GRAINS = new Set<RollupGrain>(["year", "quarter", "month", "week", "day", "hour"])
const FORBIDDEN = new Set(["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "USING", "ON", "WITH", "DISTINCT", "OFFSET"])

function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
function norm(s: string): string {
  return normWs(s).toLowerCase()
}

// ── Top-level scanner ──────────────────────────────────────────────────

interface Word { up: string; start: number; end: number }

/**
 * Alphabetic word tokens that sit at paren-depth 0 and outside any
 * string. Returns null if a comment is encountered (we don't generate
 * them; treat as un-modelable). Used to locate clause keywords safely.
 */
function topLevelWords(sql: string): Word[] | null {
  const words: Word[] = []
  let depth = 0
  let quote: "'" | "\"" | null = null
  let i = 0
  let wordStart = -1
  const flush = (end: number) => {
    if (wordStart >= 0) {
      words.push({ up: sql.slice(wordStart, end).toUpperCase(), start: wordStart, end })
      wordStart = -1
    }
  }
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]
    if (quote) {
      if (c === quote) { if (n === quote) i += 1; else quote = null }
      i += 1
      continue
    }
    if (c === "-" && n === "-") return null
    if (c === "/" && n === "*") return null
    if (c === "'" || c === "\"") { flush(i); quote = c; i += 1; continue }
    if (c === "(") { flush(i); depth += 1; i += 1; continue }
    if (c === ")") { flush(i); depth -= 1; i += 1; continue }
    if (depth === 0 && /[A-Za-z_]/.test(c)) {
      if (wordStart < 0) wordStart = i
      i += 1
      continue
    }
    flush(i)
    i += 1
  }
  flush(i)
  return words
}

/** Split a clause body at top-level occurrences of `sep` (',' or a word). */
function splitTop(s: string, sep: "," | "AND"): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: "'" | "\"" | null = null
  let last = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const n = s[i + 1]
    if (quote) {
      if (c === quote) { if (n === quote) i += 1; else quote = null }
      i += 1
      continue
    }
    if (c === "'" || c === "\"") { quote = c; i += 1; continue }
    if (c === "(") { depth += 1; i += 1; continue }
    if (c === ")") { depth -= 1; i += 1; continue }
    if (depth === 0) {
      if (sep === "," && c === ",") { parts.push(s.slice(last, i)); last = i + 1; i += 1; continue }
      if (sep === "AND" && /\s/.test(c)) {
        const m = s.slice(i).match(/^\s+AND\s+/i)
        if (m) { parts.push(s.slice(last, i)); last = i + m[0].length; i += m[0].length; continue }
      }
    }
    i += 1
  }
  parts.push(s.slice(last))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

function unquoteIdent(raw: string): string {
  const s = raw.trim()
  if (s.startsWith("\"") && s.endsWith("\"") && s.length >= 2) {
    return s.slice(1, -1).replace(/""/g, "\"")
  }
  return s
}

function stripTerminator(sql: string): string {
  const t = sql.trim()
  return t.endsWith(";") ? t.slice(0, -1).trim() : t
}

// ── Select-item parsers ────────────────────────────────────────────────

function dim(name: string, role: DesktopColumnRef["role"] = "dimension"): DesktopColumnRef {
  return { name, role }
}

/** Parse a GROUP BY / dim expression → a group term, or null. */
function parseDimExpr(expr: string): RollupGroupTerm | null {
  const e = expr.trim()
  const dt = e.match(/^date_trunc\(\s*'([a-z]+)'\s*,\s*(.+?)\s*\)$/i)
  if (dt) {
    const grain = dt[1].toLowerCase() as RollupGrain
    if (!GRAINS.has(grain)) return null
    return { column: dim(unquoteIdent(dt[2])), grain }
  }
  // bare identifier (quoted or simple) — reject anything with a call/operator
  if (/^"(?:[^"]|"")+"$/.test(e) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) {
    return { column: dim(unquoteIdent(e)) }
  }
  return null
}

const AGG_FN: Record<string, RollupAgg> = {
  sum: "sum", avg: "avg", min: "min", max: "max",
  stddev_samp: "stddev", var_samp: "variance",
}

/** Split `<expr> AS <alias>` at the top-level ` AS `. */
function splitAlias(item: string): { expr: string; alias: string | null } {
  const words = topLevelWords(item)
  if (!words) return { expr: item.trim(), alias: null }
  const asWord = words.find((w) => w.up === "AS")
  if (!asWord) return { expr: item.trim(), alias: null }
  return {
    expr: item.slice(0, asWord.start).trim(),
    alias: unquoteIdent(item.slice(asWord.end).trim()),
  }
}

function isMeasureExpr(expr: string): boolean {
  return /^(count|sum|avg|min|max|stddev_samp|var_samp|percentile_cont)\s*\(/i.test(expr.trim())
    || /^percentile_cont/i.test(expr.trim())
}

/** Parse a measure SELECT item → measure, or null. */
function parseMeasureItem(item: string): RollupMeasure | null {
  const { expr, alias } = splitAlias(item)
  const e = expr.trim()

  if (/^count\s*\(\s*1\s*\)$/i.test(e)) {
    return { id: "count:*", column: null, agg: "count", alias: alias ?? "row_count" }
  }
  const distinct = e.match(/^count\s*\(\s*distinct\s+(.+?)\s*\)$/i)
  if (distinct) return mk("count_distinct", unquoteIdent(distinct[1]), alias)
  const cnt = e.match(/^count\s*\(\s*(.+?)\s*\)$/i)
  if (cnt) return mk("count", unquoteIdent(cnt[1]), alias)
  const median = e.match(/^percentile_cont\s*\(\s*0\.5\s*\)\s*within\s+group\s*\(\s*order\s+by\s+(.+?)\s*\)$/i)
  if (median) return mk("median", unquoteIdent(median[1]), alias)
  const fn = e.match(/^([a-z_]+)\s*\(\s*(.+?)\s*\)$/i)
  if (fn) {
    const agg = AGG_FN[fn[1].toLowerCase()]
    if (agg) return mk(agg, unquoteIdent(fn[2]), alias)
  }
  return null

  function mk(agg: RollupAgg, colName: string, a: string | null): RollupMeasure | null {
    // Reject anything that isn't a plain (possibly quoted) identifier — an
    // expression like `a + b` inside the call isn't representable.
    if (!/^[A-Za-z_][\w ]*$/.test(colName)) return null
    const column = dim(colName, "metric")
    return { id: `${agg}:${colName}`, column, agg, alias: a ?? `${agg}_${colName}` }
  }
}

// ── Top-level parse ─────────────────────────────────────────────────────

export interface ParsedRollup {
  spec: RollupSpec
  blockName: string
}

export function parseRollupSql(sqlRaw: string): ParsedRollup | null {
  const sql = stripTerminator(sqlRaw)
  const words = topLevelWords(sql)
  if (!words || words.length === 0) return null
  if (words[0].up !== "SELECT") return null
  // A pivot's conditional aggregation isn't recoverable here.
  if (/\bfilter\s*\(/i.test(sql)) return null
  for (const w of words) {
    if (FORBIDDEN.has(w.up)) return null
  }

  // Locate clause keywords (first top-level occurrence in canonical order).
  const find = (kw: string) => words.find((w) => w.up === kw) ?? null
  const fromW = find("FROM")
  if (!fromW) return null
  const whereW = find("WHERE")
  const groupW = words.find((w) => w.up === "GROUP")
  const havingW = find("HAVING")
  const orderW = words.find((w) => w.up === "ORDER")
  const limitW = find("LIMIT")

  // Bounds for each clause body, in source order.
  const ends: number[] = [fromW.start]
  if (whereW) ends.push(whereW.start)
  if (groupW) ends.push(groupW.start)
  if (havingW) ends.push(havingW.start)
  if (orderW) ends.push(orderW.start)
  if (limitW) ends.push(limitW.start)
  const nextAfter = (pos: number) => ends.filter((e) => e > pos).sort((a, b) => a - b)[0] ?? sql.length

  const selectBody = sql.slice(words[0].end, fromW.start)
  const fromBody = sql.slice(fromW.end, nextAfter(fromW.start)).trim()

  // FROM must be exactly a single block reference `{name}`.
  const blockRef = fromBody.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (!blockRef) return null
  const blockName = blockRef[1]

  // ── SELECT items → dims + measures ──
  const items = splitTop(selectBody, ",")
  if (items.length === 0) return null
  const groupBy: RollupGroupTerm[] = []
  const measures: RollupMeasure[] = []
  for (const item of items) {
    if (isMeasureExpr(item)) {
      const m = parseMeasureItem(item)
      if (!m) return null
      if (measures.some((x) => x.id === m.id)) return null
      measures.push(m)
    } else {
      const { expr } = splitAlias(item)
      const term = parseDimExpr(expr)
      if (!term) return null
      groupBy.push(term)
    }
  }

  // ── GROUP BY must match the dims exactly ──
  if (groupW) {
    const byAfterGroup = words.find((w) => w.up === "BY" && w.start > groupW.start)
    if (!byAfterGroup) return null
    const gbBody = sql.slice(byAfterGroup.end, nextAfter(groupW.start))
    const gbExprs = splitTop(gbBody, ",").map(norm)
    const dimExprs = groupBy.map((t) => norm(dimExpr(t)))
    if (gbExprs.length !== dimExprs.length) return null
    const a = [...gbExprs].sort()
    const b = [...dimExprs].sort()
    if (a.some((x, i) => x !== b[i])) return null
  } else if (groupBy.length > 0) {
    return null // dims without GROUP BY → not our shape
  }

  const spec: RollupSpec = { groupBy, measures }

  // ── WHERE → source-column filters ──
  if (whereW) {
    const wBody = sql.slice(whereW.end, nextAfter(whereW.start))
    const conds = splitTop(wBody, "AND")
    const filters: RollupFilter[] = []
    for (const c of conds) {
      const parsed = parseFilterCond(c)
      if (!parsed) return null
      filters.push(parsed)
    }
    if (filters.length > 0) spec.filters = filters
  }

  // ── HAVING → having terms (each must map to a known measure) ──
  if (havingW) {
    const hBody = sql.slice(havingW.end, nextAfter(havingW.start))
    const terms = splitTop(hBody, "AND")
    const having: RollupHavingTerm[] = []
    for (const t of terms) {
      const parsed = parseHavingTerm(t, measures)
      if (!parsed) return null
      having.push(parsed)
    }
    if (having.length > 0) spec.having = having
  }

  // ── ORDER BY / LIMIT ──
  const orderBody = orderW
    ? (() => {
        const byAfterOrder = words.find((w) => w.up === "BY" && w.start > orderW.start)
        if (!byAfterOrder) return null
        return sql.slice(byAfterOrder.end, nextAfter(orderW.start)).trim()
      })()
    : ""
  if (orderBody === null) return null

  if (limitW) {
    const limitBody = sql.slice(limitW.end, sql.length).trim()
    const n = Number(limitBody)
    if (!Number.isInteger(n) || n < 1) return null
    // Top-N: ORDER BY must be a single measure expr/alias with a direction.
    if (!orderBody) return null
    const rank = parseRankTerm(orderBody, measures)
    if (!rank) return null
    spec.limit = { n, byMeasureId: rank.measureId, dir: rank.dir }
  } else if (orderBody) {
    // No limit: either the default ordering (don't store) or explicit terms.
    if (norm(orderBody) !== norm(defaultOrderExpr(spec))) {
      const orderBy = parseOrderTerms(orderBody, spec)
      if (!orderBy) return null
      spec.orderBy = orderBy
    }
  }

  return { spec, blockName }
}

const OP_RE = /(>=|<=|!=|>|<|=)/

/** A SQL literal → JS value, or `undefined` when not a plain literal. */
function parseLiteral(raw: string): string | number | null | undefined {
  const s = raw.trim()
  if (/^null$/i.test(s)) return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  return undefined
}

/** Peel a leading column identifier (bare or quoted) off a condition. */
function leadingIdent(s: string): { name: string; rest: string } | null {
  const t = s.trimStart()
  if (t.startsWith("\"")) {
    let i = 1
    for (; i < t.length; i += 1) {
      if (t[i] === "\"") { if (t[i + 1] === "\"") { i += 1; continue } break }
    }
    if (i >= t.length) return null
    return { name: t.slice(1, i).replace(/""/g, "\""), rest: t.slice(i + 1).trim() }
  }
  const m = t.match(/^[A-Za-z_][A-Za-z0-9_]*/)
  if (!m) return null
  return { name: m[0], rest: t.slice(m[0].length).trim() }
}

const FILTER_OP_FROM_SQL: Record<string, RollupFilterOp> = {
  ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "=": "eq", "<>": "neq", "!=": "neq",
}

/** Parse one WHERE conjunct into a filter, or null if unrecognized. */
function parseFilterCond(cond: string): RollupFilter | null {
  const lead = leadingIdent(cond.trim())
  if (!lead) return null
  const column: DesktopColumnRef = { name: lead.name, role: "dimension" }
  const rest = lead.rest

  const nul = rest.match(/^IS\s+(NOT\s+)?NULL$/i)
  if (nul) return { column, op: nul[1] ? "not_null" : "is_null" }

  const inMatch = rest.match(/^(NOT\s+)?IN\s*\((.+)\)$/is)
  if (inMatch) {
    const vals = splitTop(inMatch[2], ",").map(parseLiteral)
    if (vals.length === 0 || vals.some((v) => v === undefined)) return null
    return { column, op: inMatch[1] ? "not_in" : "in", values: vals as (string | number | null)[] }
  }

  const bin = rest.match(/^(>=|<=|<>|!=|>|<|=)\s*(.+)$/s)
  if (bin) {
    const value = parseLiteral(bin[2].trim())
    if (value === undefined) return null
    return { column, op: FILTER_OP_FROM_SQL[bin[1]], value }
  }
  return null
}

function parseHavingTerm(term: string, measures: RollupMeasure[]): RollupHavingTerm | null {
  const m = term.match(OP_RE)
  if (!m || m.index === undefined) return null
  const lhs = term.slice(0, m.index).trim()
  const rhs = term.slice(m.index + m[0].length).trim()
  const value = Number(rhs)
  if (!Number.isFinite(value)) return null
  const measure = measures.find((x) => norm(measureExpr(x)) === norm(lhs))
  if (!measure) return null
  return { measureId: measure.id, op: m[0] as RollupCompareOp, value }
}

function parseRankTerm(body: string, measures: RollupMeasure[]): { measureId: string; dir: "asc" | "desc" } | null {
  const dirMatch = body.match(/\s+(asc|desc)\s*$/i)
  const dir = dirMatch ? (dirMatch[1].toLowerCase() as "asc" | "desc") : "desc"
  const ref = (dirMatch ? body.slice(0, dirMatch.index) : body).trim()
  const measure = measures.find((x) => norm(measureExpr(x)) === norm(ref))
    ?? measures.find((x) => norm(x.alias) === norm(unquoteIdent(ref)))
  if (!measure) return null
  return { measureId: measure.id, dir }
}

function parseOrderTerms(body: string, spec: RollupSpec): RollupOrderTerm[] | null {
  const out: RollupOrderTerm[] = []
  for (const raw of splitTop(body, ",")) {
    const dirMatch = raw.match(/\s+(asc|desc)\s*$/i)
    const dir = dirMatch ? (dirMatch[1].toLowerCase() as "asc" | "desc") : "asc"
    const ref = unquoteIdent((dirMatch ? raw.slice(0, dirMatch.index) : raw).trim())
    const known = spec.groupBy.some((t) => t.column.name.toLowerCase() === ref.toLowerCase())
      || spec.measures.some((m) => m.alias.toLowerCase() === ref.toLowerCase())
    if (!known) return null
    out.push({ ref, dir })
  }
  return out.length > 0 ? out : null
}

// ── Reconcile a window's lineage against (possibly hand-edited) SQL ──────

/**
 * Given a column-aggregate window's lineage and its current SQL, return an
 * updated lineage whose `rollup` reflects the SQL. Fast-paths the common
 * case (SQL still equals what the current spec generates — protects pivots
 * and untouched windows). On genuine divergence: re-parse, or detach
 * (`rollup: null`) when the SQL is no longer a recognizable rollup.
 */
export function reconcileRollupLineage(lineage: DesktopQueryLineage, sql: string): DesktopQueryLineage {
  if (lineage.kind !== "column-aggregate") return lineage

  const current = effectiveRollup(lineage)
  if (current) {
    const canonical = buildRollupQuery(current, {
      parentBlockName: lineage.parentBlockName ?? "",
      parentTitle: lineage.parentTitle,
    }).sql
    if (normWs(canonical) === normWs(sql)) return lineage
  }

  const parsed = parseRollupSql(sql)
  if (!parsed) {
    return lineage.rollup === null ? lineage : { ...lineage, rollup: null }
  }
  return {
    ...lineage,
    parentBlockName: parsed.blockName || lineage.parentBlockName,
    rollup: parsed.spec,
    columns: rollupSpecColumns(parsed.spec),
  }
}
