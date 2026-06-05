import type {
  DataPayload,
  DesktopBlockRef,
  DesktopParamSubscription,
  DesktopParamValue,
  DesktopWindowState,
  JsonbProjectionColumn,
} from "./types"
import { buildJsonbProjection, isSynthQuery } from "@/lib/sql/then-rewrite"

/**
 * The reactive SQL engine — every data window declares a block name and an
 * optional source SQL. Other windows can reference upstream results by name:
 *
 *   SELECT count(*) FROM {sightings_by_state} WHERE state = param.filter_state.code
 *
 * `{name}` is rewritten as an *inline aliased subquery* that splices in the
 * upstream window's compiled SQL — so filtering the upstream window
 * automatically cascades into every downstream reference. Curly braces are
 * chosen because they cannot appear in unquoted Postgres identifiers, so the
 * substitution is unambiguous and clearly marks "this is a frontend-only
 * reference, not a real SQL name".
 *
 * `param.<block>.<field>` is rewritten as a SQL literal taken from the
 * active param map. Param *subscriptions* (declarative, not inline) wrap the
 * SQL in `SELECT * FROM (...) WHERE <field> = <value>` so a single
 * subscription drives a cascading filter without editing the SQL.
 */

interface RuntimeBlockInput {
  windowId: string
  title: string
  blockName: string
  sourceSql: string
  subscriptions: DesktopParamSubscription[]
  /** Run-inferred jsonb shape for synth/flow blocks (see DataPayload). */
  jsonbProjection?: JsonbProjectionColumn[]
}

export interface DesktopCompiledBlock {
  windowId: string
  title: string
  blockName: string
  sourceSql: string
  compiledSql: string
  /** For synth/flow blocks: a typed projection over compiledSql that exposes the
   * expanded jsonb columns as real columns. Used when this block is *referenced*
   * by another (block.<name>) so downstream SQL sees real columns. Undefined for
   * ordinary blocks (references then inline compiledSql directly). */
  projectionSql?: string
  refs: DesktopBlockRef[]
  paramRefs: string[]
  subscriptions: DesktopParamSubscription[]
  missingRefs: string[]
  missingParams: string[]
  downstreamWindowIds: string[]
  upstreamWindowIds: string[]
}

export interface DesktopRuntimeGraph {
  blocks: Map<string, DesktopCompiledBlock>
  params: DesktopParamValue[]
}

const BLOCK_REF_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const PARAM_REF_RE = /\bparam\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g

export function slugifyBlockName(value: string, fallback = "block"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const safe = slug && /^[a-z_]/.test(slug) ? slug : `${fallback}_${slug || "sql"}`
  return safe.slice(0, 42)
}

export function uniqueBlockName(base: string, windows: DesktopWindowState[], excludeWindowId?: string): string {
  const root = slugifyBlockName(base)
  const used = new Set(
    windows
      .filter((w) => w.kind === "data" && w.id !== excludeWindowId)
      .map((w) => ((w.payload as DataPayload | undefined)?.reactive?.blockName ?? "").toLowerCase())
      .filter(Boolean),
  )
  if (!used.has(root)) return root
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${root}_${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${root}_${Date.now()}`
}

export function sourceSqlForPayload(payload: DataPayload): string {
  return payload.reactive?.sourceSql ?? payload.sql
}

export function paramKey(blockName: string, field: string): string {
  return `${blockName}.${field}`.toLowerCase()
}

export function shortParamValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map(shortParamValue).join(", ")
    const suffix = value.length > 3 ? ` +${value.length - 3}` : ""
    return `(${preview}${suffix})`
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return text.length > 42 ? `${text.slice(0, 39)}...` : text
}

export function quoteSqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/**
 * Strip a trailing `LIMIT n [OFFSET m]` (or the OFFSET-first variant)
 * from the *outermost* SELECT. Conservative: only matches when the
 * tail looks like a single bare LIMIT/OFFSET clause; subqueries and
 * window functions that mention LIMIT in expressions are unaffected
 * because masked string/comment content is ignored and the regex is
 * anchored at end-of-statement.
 */
export function stripTrailingLimitOffset(sql: string): string {
  const stripped = stripTrailingSqlTerminator(sql)
  const masked = maskSql(stripped)
  // Match LIMIT/OFFSET at the very end (after optional trailing whitespace).
  // Variants we accept:
  //   LIMIT 200
  //   LIMIT ALL
  //   LIMIT 200 OFFSET 10
  //   OFFSET 10
  //   OFFSET 10 LIMIT 200
  const RE = /\s+(?:LIMIT\s+(?:\d+|ALL)(?:\s+OFFSET\s+\d+)?|OFFSET\s+\d+(?:\s+LIMIT\s+(?:\d+|ALL))?)\s*$/i
  const m = masked.match(RE)
  if (!m || m.index === undefined) return stripped
  return stripped.slice(0, m.index).trimEnd()
}

export function stripTrailingSqlTerminator(sql: string): string {
  // Walk the string so we don't trim a ; that lives inside a string/comment.
  let quote: "'" | "\"" | null = null
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    const n = sql[i + 1]
    if (lineComment) { if (c === "\n") lineComment = false; continue }
    if (blockComment) { if (c === "*" && n === "/") { blockComment = false; i += 1 } ; continue }
    if (quote) {
      if (c === quote) { if (n === quote) i += 1; else quote = null }
      continue
    }
    if (c === "-" && n === "-") { lineComment = true; i += 1; continue }
    if (c === "/" && n === "*") { blockComment = true; i += 1; continue }
    if (c === "'" || c === "\"") quote = c
  }
  const trimmed = sql.trim()
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed
}

export function buildDesktopRuntimeGraph(
  windows: DesktopWindowState[],
  params: DesktopParamValue[],
): DesktopRuntimeGraph {
  const blocks = dataWindowsToRuntimeInputs(windows)
  const byId = new Map(blocks.map((b) => [b.windowId, b]))
  const byName = new Map(blocks.map((b) => [b.blockName.toLowerCase(), b]))
  const paramMap = new Map(params.map((p) => [p.key.toLowerCase(), p]))
  const compiled = new Map<string, DesktopCompiledBlock>()

  function compile(windowId: string, stack: string[] = []): DesktopCompiledBlock {
    const cached = compiled.get(windowId)
    if (cached) return cached
    const block = byId.get(windowId)
    if (!block) throw new Error(`Unknown block ${windowId}`)

    const source = stripTrailingSqlTerminator(block.sourceSql)
    const masked = maskSql(source)
    const refs: DesktopBlockRef[] = []
    const missingRefs: string[] = []
    const missingParams: string[] = []
    const paramRefs: string[] = []

    // {X} → inline aliased subquery `(compiled-upstream-sql) AS x`. The
    // upstream window's compiled output already has its own param subs
    // and {X} refs resolved, so cascading filters propagate naturally.
    // We also strip any trailing LIMIT/OFFSET from the upstream so a
    // downstream aggregate sees the *whole* filtered relation, not just
    // the table-preview slice. If the downstream needs a row cap it can
    // add its own LIMIT to the outer query.
    let rewritten = replaceMasked(source, masked, BLOCK_REF_RE, (m) => {
      const refName = m[1].toLowerCase()
      const upstream = byName.get(refName)
      if (!upstream || upstream.windowId === block.windowId || stack.includes(upstream.windowId)) {
        missingRefs.push(refName)
        return m[0]
      }
      const upstreamCompiled = compile(upstream.windowId, [...stack, block.windowId])
      refs.push({ windowId: upstream.windowId, blockName: upstream.blockName, title: upstream.title })
      // Synth/flow blocks expose a single jsonb column; inline their *projection*
      // (real, typed columns) so this block can reference fields like season/n.
      const upstreamSql = upstreamCompiled.projectionSql ?? upstreamCompiled.compiledSql
      const inner = stripTrailingLimitOffset(stripTrailingSqlTerminator(upstreamSql))
      return `(\n${indentSql(inner)}\n) AS ${quoteSqlIdent(slugifyBlockName(upstream.blockName))}`
    })

    rewritten = replaceMasked(rewritten, maskSql(rewritten), PARAM_REF_RE, (m) => {
      const key = `${m[1]}.${m[2]}`.toLowerCase()
      paramRefs.push(key)
      const p = paramMap.get(key)
      if (!p) { missingParams.push(key); return "NULL" }
      return quoteSqlLiteral(p.value)
    })

    // A synth block exposes jsonb-derived columns (season, n) that don't exist in
    // its raw SQL, so a param-subscription filter (`WHERE <field> = …` wrapped around
    // the raw SQL) would reference a column Postgres can't see and error. So synth
    // blocks run unfiltered here; a downstream block that references this one filters
    // the *projection* (real columns) instead.
    const isJsonbBlock = !!(block.jsonbProjection && block.jsonbProjection.length > 0)

    // Implicit self-subscriptions: any param whose sourceBlockName matches
    // *this* block filters the block by (field=value). The intuition is
    // "click on a cell → the window itself narrows to that value"; the
    // narrowed result then cascades into anything that references the
    // block via {X}.
    const selfSubs: DesktopParamSubscription[] = isJsonbBlock
      ? []
      : params
          .filter((p) => p.sourceBlockName.toLowerCase() === block.blockName.toLowerCase())
          .map((p) => ({ key: p.key, targetField: p.field }))

    const sub = applyParamSubscriptions(
      rewritten,
      isJsonbBlock ? [] : mergeSubscriptions(block.subscriptions, selfSubs),
      paramMap,
    )
    rewritten = sub.sql
    missingParams.push(...sub.missingParams)

    const dedupedRefs = dedupeRefs(refs)
    // A synth block (single jsonb column) carries a typed projection so that
    // *references* to it inline real columns. Its own compiledSql stays raw — the
    // window expands the jsonb client-side when it runs itself. The isSynthQuery
    // re-check guards against a stale jsonbProjection lingering after the source was
    // edited to a non-synth query (projecting a non-synth shape would mis-alias).
    const projectionSql =
      isJsonbBlock && block.jsonbProjection && isSynthQuery(rewritten)
        ? buildJsonbProjection(stripTrailingSqlTerminator(rewritten), block.jsonbProjection)
        : undefined
    const next: DesktopCompiledBlock = {
      windowId: block.windowId,
      title: block.title,
      blockName: block.blockName,
      sourceSql: block.sourceSql,
      compiledSql: rewritten,
      projectionSql,
      refs: dedupedRefs,
      paramRefs: [...new Set(paramRefs)],
      subscriptions: block.subscriptions,
      missingRefs: [...new Set(missingRefs)],
      missingParams: [...new Set(missingParams)],
      downstreamWindowIds: [],
      upstreamWindowIds: dedupedRefs.map((r) => r.windowId),
    }
    compiled.set(windowId, next)
    return next
  }

  for (const b of blocks) compile(b.windowId)
  for (const b of compiled.values()) {
    for (const u of b.upstreamWindowIds) {
      const upstream = compiled.get(u)
      if (!upstream) continue
      upstream.downstreamWindowIds.push(b.windowId)
    }
  }
  for (const b of compiled.values()) b.downstreamWindowIds = [...new Set(b.downstreamWindowIds)]

  return { blocks: compiled, params }
}

function dataWindowsToRuntimeInputs(windows: DesktopWindowState[]): RuntimeBlockInput[] {
  return windows.flatMap((w) => {
    if (w.kind !== "data") return []
    const payload = w.payload as DataPayload | undefined
    if (!payload) return []
    const fallback = slugifyBlockName(payload.title || w.title || w.id)
    return [{
      windowId: w.id,
      title: payload.title || w.title,
      blockName: payload.reactive?.blockName || fallback,
      sourceSql: sourceSqlForPayload(payload),
      subscriptions: payload.reactive?.paramSubscriptions ?? [],
      jsonbProjection: payload.jsonbProjection,
    }]
  })
}

function indentSql(sql: string) {
  return stripTrailingSqlTerminator(sql).split("\n").map((l) => `  ${l}`).join("\n")
}

function mergeSubscriptions(
  explicit: DesktopParamSubscription[],
  implicit: DesktopParamSubscription[],
): DesktopParamSubscription[] {
  // Explicit (user-dragged) subs win over implicit (self) subs on key clash.
  const byKey = new Map<string, DesktopParamSubscription>()
  for (const s of implicit) byKey.set(s.key.toLowerCase(), s)
  for (const s of explicit) byKey.set(s.key.toLowerCase(), s)
  return Array.from(byKey.values())
}

function applyParamSubscriptions(
  sql: string,
  subs: DesktopParamSubscription[],
  paramMap: Map<string, DesktopParamValue>,
): { sql: string; missingParams: string[] } {
  if (subs.length === 0) return { sql: `${stripTrailingSqlTerminator(sql)};`, missingParams: [] }
  const missing: string[] = []
  const predicates = subs.flatMap((s) => {
    const p = paramMap.get(s.key.toLowerCase())
    if (!p) { missing.push(s.key); return [] }
    return predicateForParam(s.targetField, p)
  })
  if (predicates.length === 0) return { sql: `${stripTrailingSqlTerminator(sql)};`, missingParams: missing }
  const stripped = stripTrailingSqlTerminator(sql)
  if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) return { sql: `${stripped};`, missingParams: missing }
  return {
    sql: [
      "SELECT *",
      "FROM (",
      indentSql(stripped),
      ") __desktop_param_source",
      `WHERE ${predicates.join("\n  AND ")};`,
    ].join("\n"),
    missingParams: missing,
  }
}

function quoteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (Array.isArray(value)) return `(${value.map(quoteSqlLiteral).join(", ") || "NULL"})`
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  return `'${String(value).replace(/'/g, "''")}'`
}

function predicateForParam(field: string, p: DesktopParamValue): string {
  const q = quoteSqlIdent(field)
  if (p.operator !== "in" && !Array.isArray(p.value)) {
    return `${q} = ${quoteSqlLiteral(p.value)}`
  }
  const vals = Array.isArray(p.value) ? p.value : [p.value]
  const nonNull = vals.filter((v) => v !== null && v !== undefined)
  const hasNull = nonNull.length !== vals.length
  const clauses: string[] = []
  if (nonNull.length > 0) clauses.push(`${q} IN (${nonNull.map(quoteSqlLiteral).join(", ")})`)
  if (hasNull) clauses.push(`${q} IS NULL`)
  if (clauses.length === 0) return "FALSE"
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`
}

function dedupeRefs(refs: DesktopBlockRef[]): DesktopBlockRef[] {
  const seen = new Set<string>()
  const out: DesktopBlockRef[] = []
  for (const r of refs) {
    if (seen.has(r.windowId)) continue
    seen.add(r.windowId)
    out.push(r)
  }
  return out
}

function maskSql(sql: string): string {
  // Replace string/comment content with spaces so regex matches don't fire
  // inside literals. Preserves indices 1:1 with the source.
  const chars = [...sql]
  let quote: "'" | "\"" | null = null
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    const n = chars[i + 1]
    if (lineComment) { chars[i] = " "; if (c === "\n") lineComment = false; continue }
    if (blockComment) {
      chars[i] = " "
      if (c === "*" && n === "/") { chars[i + 1] = " "; blockComment = false; i += 1 }
      continue
    }
    if (quote) {
      chars[i] = " "
      if (c === quote) {
        if (n === quote) { chars[i + 1] = " "; i += 1 } else quote = null
      }
      continue
    }
    if (c === "-" && n === "-") { chars[i] = " "; chars[i + 1] = " "; lineComment = true; i += 1; continue }
    if (c === "/" && n === "*") { chars[i] = " "; chars[i + 1] = " "; blockComment = true; i += 1; continue }
    if (c === "'" || c === "\"") { chars[i] = " "; quote = c }
  }
  return chars.join("")
}

function replaceMasked(
  source: string,
  masked: string,
  pattern: RegExp,
  replacer: (m: RegExpExecArray) => string,
): string {
  const out: string[] = []
  let cursor = 0
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(masked)) !== null) {
    out.push(source.slice(cursor, m.index))
    out.push(replacer(m))
    cursor = m.index + m[0].length
  }
  out.push(source.slice(cursor))
  return out.join("")
}

export function sameParamValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}
