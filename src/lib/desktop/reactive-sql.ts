import type {
  DataPayload,
  DesktopBlockRef,
  DesktopParamSubscription,
  DesktopParamValue,
  DesktopWindowState,
  JsonbProjectionColumn,
  ParamTarget,
} from "./types"
import type { SchemaSnapshot } from "@/lib/db/types"
import { buildJsonbProjection, isSynthQuery } from "@/lib/sql/then-rewrite"
import { parseAsOfComment, withAsOf } from "@/lib/rvbbit/time-travel"

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
    // Path 1 time-travel inheritance: as_of values lifted from referenced
    // upstreams (their leading comment is lost once they become a subquery).
    const inheritedAsOfs: string[] = []

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
      // Collect the upstream's as_of from its compiledSql (which always carries
      // the leading comment), then strip any leading as_of from the body we
      // actually inline (a subquery can't carry a leading comment). The lifted
      // as_of is re-applied to THIS block's leading comment below.
      const upAsOf = parseAsOfComment(upstreamCompiled.compiledSql).asOf
      if (upAsOf) inheritedAsOfs.push(upAsOf)
      const upstreamSql = upstreamCompiled.projectionSql ?? upstreamCompiled.compiledSql
      const inner = stripTrailingLimitOffset(
        stripTrailingSqlTerminator(parseAsOfComment(upstreamSql).body),
      )
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

    // Implicit self-subscriptions: a param whose sourceBlockName matches *this*
    // block filters the block by (field=value). The intuition is "click on a
    // cell → the window itself narrows to that value"; the narrowed result then
    // cascades into anything that references the block via {X}.
    // EXCEPT "pick" params (cascade === false): they are published to the shelf
    // for explicit binding but must NOT self-filter their source.
    const selfSubs: DesktopParamSubscription[] = isJsonbBlock
      ? []
      : params
          .filter(
            (p) =>
              p.sourceBlockName.toLowerCase() === block.blockName.toLowerCase() &&
              p.cascade !== false,
          )
          .map((p) => ({ key: p.key, targetField: p.field }))

    const sub = applyParamSubscriptions(
      rewritten,
      isJsonbBlock ? [] : mergeSubscriptions(block.subscriptions, selfSubs),
      paramMap,
    )
    rewritten = sub.sql
    missingParams.push(...sub.missingParams)

    // Path 1: this block's OWN leading as_of wins; otherwise inherit a referenced
    // upstream's. Re-apply the effective as_of as THIS block's leading comment so
    // the extension (which honors only a leading comment) sees it even though the
    // upstream is now a subquery. One as_of per block — mixed upstream as_ofs take
    // the first (true per-table as_of would need a real SQL clause).
    const ownAsOf = parseAsOfComment(rewritten).asOf
    const effectiveAsOf = ownAsOf ?? inheritedAsOfs.find(Boolean) ?? null
    const cleanBody = parseAsOfComment(rewritten).body

    const dedupedRefs = dedupeRefs(refs)
    // A synth block (single jsonb column) carries a typed projection so that
    // *references* to it inline real columns. Its own compiledSql stays raw — the
    // window expands the jsonb client-side when it runs itself. The isSynthQuery
    // re-check guards against a stale jsonbProjection lingering after the source was
    // edited to a non-synth query (projecting a non-synth shape would mis-alias).
    const projectionSql =
      isJsonbBlock && block.jsonbProjection && isSynthQuery(cleanBody)
        ? buildJsonbProjection(stripTrailingSqlTerminator(cleanBody), block.jsonbProjection)
        : undefined
    const next: DesktopCompiledBlock = {
      windowId: block.windowId,
      title: block.title,
      blockName: block.blockName,
      sourceSql: block.sourceSql,
      compiledSql: withAsOf(cleanBody, effectiveAsOf),
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
  let rewritten = stripTrailingSqlTerminator(sql)

  // Partition: surgical (FROM-item-targeted) predicates vs the rest, which wrap
  // the whole result. A surgical predicate that can't be placed (no single
  // FROM-item in the compiled SQL) falls back to wrap.
  const fromItemPreds: string[] = []
  const wrapPreds: string[] = []
  for (const s of subs) {
    const p = paramMap.get(s.key.toLowerCase())
    if (!p) { missing.push(s.key); continue }
    const pred = predicateForParam(s.targetField, p)
    if (s.target && s.target.kind !== "query") fromItemPreds.push(pred)
    else wrapPreds.push(pred)
  }

  // Surgical: wrap the single FROM-item in a filtered subquery — `FROM x` →
  // `FROM (SELECT * FROM x WHERE <preds>) a`. Postgres flattens it and pushes
  // the predicate to the base scan (before any aggregation). `x` is whatever the
  // FROM-item is *now* (a base table, or a {ref} already inlined to a subquery),
  // so a chart over `FROM {core}` filters on a column of `core`.
  if (fromItemPreds.length > 0) {
    const item = singleFromItem(rewritten)
    const relText = item?.type === "table" ? item.relation : item?.type === "subquery" ? item.itemText : null
    if (item && relText) {
      const inner = `(SELECT * FROM ${relText} WHERE ${fromItemPreds.join(" AND ")}) ${item.alias}`
      rewritten = rewritten.slice(0, item.start) + inner + rewritten.slice(item.end)
    } else {
      wrapPreds.push(...fromItemPreds) // couldn't place surgically → wrap instead
    }
  }

  if (wrapPreds.length === 0) return { sql: `${rewritten};`, missingParams: missing }
  if (!/^\s*(SELECT|WITH)\b/i.test(rewritten)) return { sql: `${rewritten};`, missingParams: missing }
  return {
    sql: [
      "SELECT *",
      "FROM (",
      indentSql(rewritten),
      ") __desktop_param_source",
      `WHERE ${wrapPreds.join("\n  AND ")};`,
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
  // Range/threshold comparison (datepicker / slider). `col >= v` matches whole
  // timestamps correctly (no exact-midnight problem of `col = date`).
  if (p.operator === "gte" || p.operator === "lte") {
    if (p.value === null || p.value === undefined) return "TRUE"
    return `${q} ${p.operator === "gte" ? ">=" : "<="} ${quoteSqlLiteral(p.value)}`
  }
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

/**
 * If `sql[i]` opens a Postgres dollar-quoted string (`$$` or `$tag$`), return
 * the tag (`""` for `$$`); otherwise null. A tag is an unquoted identifier, so
 * positional params like `$1` are correctly rejected.
 */
function dollarQuoteTag(sql: string, i: number): string | null {
  let j = i + 1
  if (sql[j] === "$") return "" // $$
  if (!/[A-Za-z_]/.test(sql[j] ?? "")) return null // $1, bare $, etc.
  j += 1
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1
  return sql[j] === "$" ? sql.slice(i + 1, j) : null
}

function maskSql(sql: string): string {
  // Replace string/comment content with spaces so regex matches don't fire
  // inside literals. Preserves indices 1:1 with the source.
  const chars = [...sql]
  let quote: "'" | "\"" | null = null
  let lineComment = false
  let blockComment = false
  let dollarTag: string | null = null // open dollar-quote body (e.g. "" for $$)
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    const n = chars[i + 1]
    if (lineComment) { chars[i] = " "; if (c === "\n") lineComment = false; continue }
    if (blockComment) {
      chars[i] = " "
      if (c === "*" && n === "/") { chars[i + 1] = " "; blockComment = false; i += 1 }
      continue
    }
    if (dollarTag !== null) {
      const close = `$${dollarTag}$`
      if (c === "$" && sql.startsWith(close, i)) {
        for (let j = 0; j < close.length; j += 1) chars[i + j] = " "
        i += close.length - 1
        dollarTag = null
      } else chars[i] = " "
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
    if (c === "'" || c === "\"") { chars[i] = " "; quote = c; continue }
    if (c === "$") {
      const tag = dollarQuoteTag(sql, i)
      if (tag !== null) {
        const len = tag.length + 2
        for (let j = 0; j < len; j += 1) chars[i + j] = " "
        i += len - 1
        dollarTag = tag
      }
    }
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

// ── surgical param targeting (push a predicate into a base-table reference) ────

const SQL_IDENT = `(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)`
const FROM_CLAUSE_KW = "WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|WINDOW|UNION|INTERSECT|EXCEPT|FETCH|FOR|RETURNING"
const FROM_JOIN_KW = "JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|LATERAL|ON|USING"

export interface SqlTableRef {
  relation: string
  alias: string
  start: number
  end: number
}

/**
 * Best-effort: if `sql` is a single-base-table SELECT (no CTE, no JOIN, no
 * comma, no subquery in FROM, unquoted identifiers), return that table ref +
 * its source span. Returns null for anything more complex — the caller then
 * falls back to wrapping the whole result. Uses {@link maskSql} so matches
 * never fire inside string/comment literals (quoted identifiers are blanked,
 * so they safely yield null and fall back). Phase 3 swaps this for a real PG
 * AST parser to cover joins/CTEs.
 */
export function singleTableRef(sql: string): SqlTableRef | null {
  const masked = maskSql(sql)
  if (/^\s*WITH\b/i.test(masked)) return null // CTE: ambiguous main FROM
  // top-level FROM (paren depth 0).
  let depth = 0
  let fromEnd = -1
  const scan = /\(|\)|\bFROM\b/gi
  let m: RegExpExecArray | null
  while ((m = scan.exec(masked))) {
    if (m[0] === "(") depth += 1
    else if (m[0] === ")") depth -= 1
    else if (depth === 0) { fromEnd = m.index + m[0].length; break }
  }
  if (fromEnd < 0) return null
  const sub = masked.slice(fromEnd)
  // `FROM ONLY t` (table-inheritance): `ONLY` would mis-parse as the relation.
  // Rare — bail rather than carry the prefix through the rewrite.
  if (/^\s*ONLY\b/i.test(sub)) return null
  const refRe = new RegExp(
    `^(\\s*)(${SQL_IDENT}(?:\\.${SQL_IDENT})?)` +
      `(?:\\s+(?:AS\\s+)?(?!(?:${FROM_CLAUSE_KW}|${FROM_JOIN_KW}|AS)\\b)(${SQL_IDENT}))?`,
    "i",
  )
  const mm = refRe.exec(sub)
  if (!mm) return null
  // what follows the table ref must be a clause keyword, a closing paren, an
  // optional trailing terminator, or the end — NOT a join / comma / subquery
  // (those are multi-relation → bail). Tolerate a trailing `;` so the raw,
  // un-stripped payload SQL resolves the same as the compiled form.
  const rest = sub.slice(mm[0].length).trimStart().replace(/;\s*$/, "")
  if (rest !== "" && !new RegExp(`^(?:${FROM_CLAUSE_KW})\\b`, "i").test(rest) && !rest.startsWith(")")) {
    return null
  }
  const relation = mm[2] // unquoted region: masked === source here
  const explicitAlias = mm[3]
  // Schema-qualified relation with no explicit alias: the outer query may
  // reference columns via the qualified path (`public.t.col`), which a bare
  // subquery alias can't satisfy. Bail to wrap. (With an explicit alias the
  // outer query must use it, so the rewrite is safe.)
  if (!explicitAlias && relation.includes(".")) return null
  // A quoted alias (`FROM t "My Alias"`) is blanked by maskSql, so it escapes
  // the alias capture above and would be left dangling after the rewrite. If
  // the source text after the matched ref begins with a quote, bail to wrap.
  if (/^\s*"/.test(sql.slice(fromEnd + mm[0].length))) return null
  const alias = explicitAlias || relation.split(".").pop() || relation
  return { relation, alias, start: fromEnd + mm[1].length, end: fromEnd + mm[0].length }
}

/**
 * Decide where a param should be applied to a block. If the block is a simple
 * single-table SELECT and that table actually has the field (per the loaded
 * schema), target the table (surgical); otherwise target the whole query (wrap).
 */
export function resolveParamTableTarget(
  sql: string,
  field: string,
  schema: SchemaSnapshot | null,
): ParamTarget {
  const ref = singleTableRef(sql)
  if (!ref || !schema) return { kind: "query" }
  const rel = ref.relation.toLowerCase()
  const qualified = rel.includes(".")
  // A bare relation that names tables in more than one schema is ambiguous —
  // we'd guess columns off the wrong same-named table. Require exactly one match.
  const matches = schema.tables.filter((t) => {
    const fq = `${t.schema}.${t.name}`.toLowerCase()
    return fq === rel || (!qualified && t.name.toLowerCase() === rel)
  })
  if (matches.length !== 1) return { kind: "query" }
  const table = matches[0]
  if (!table.columns.some((c) => c.name.toLowerCase() === field.toLowerCase())) {
    return { kind: "query" }
  }
  return { kind: "table", relation: ref.relation, alias: ref.alias }
}

// ── single FROM-item (generalizes singleTableRef) ──────────────────────────────
// A block's FROM can be a base table, a {ref} (block reference), or — after the
// compiler inlines a {ref} — a parenthesized subquery with an alias. Surgical
// targeting wraps whichever it is: `FROM x` → `FROM (SELECT * FROM x WHERE …) a`.

export type SqlFromItem =
  | { type: "table"; relation: string; alias: string; start: number; end: number }
  | { type: "ref"; refName: string; alias: string; start: number; end: number }
  | { type: "subquery"; itemText: string; alias: string; start: number; end: number }

const REF_HEAD_RE = /^(\s*)\{([A-Za-z_][A-Za-z0-9_]*)\}/
// optional `AS`/bare alias, excluding clause/join keywords; read from SOURCE
// (maskSql blanks a quoted alias, so the masked text can't carry it).
const FROM_ITEM_ALIAS_RE = new RegExp(
  `^\\s*(?:AS\\s+)?(?!(?:${FROM_CLAUSE_KW}|${FROM_JOIN_KW}|AS)\\b)(${SQL_IDENT})`,
  "i",
)

/** Find the top-level `FROM` (paren depth 0); returns the index just past it. */
function topLevelFromEnd(masked: string): number {
  if (/^\s*WITH\b/i.test(masked)) return -1 // CTE: ambiguous main FROM
  let depth = 0
  const scan = /\(|\)|\bFROM\b/gi
  let m: RegExpExecArray | null
  while ((m = scan.exec(masked))) {
    if (m[0] === "(") depth += 1
    else if (m[0] === ")") depth -= 1
    else if (depth === 0) return m.index + m[0].length
  }
  return -1
}

/** What follows a FROM-item must be a clause keyword / closing paren / terminator
 *  / end — anything else (JOIN, comma, …) means multiple relations → bail. */
function fromItemTailOk(maskedTail: string): boolean {
  const rest = maskedTail.trimStart().replace(/;\s*$/, "")
  return rest === "" || new RegExp(`^(?:${FROM_CLAUSE_KW})\\b`, "i").test(rest) || rest.startsWith(")")
}

export function singleFromItem(sql: string): SqlFromItem | null {
  const masked = maskSql(sql)
  const fromEnd = topLevelFromEnd(masked)
  if (fromEnd < 0) return null
  const sub = masked.slice(fromEnd)
  const lead = (/^\s*/.exec(sub)?.[0].length) ?? 0
  const head = sub[lead]

  // Leading subquery: `( … ) [AS] alias`
  if (head === "(") {
    let depth = 0
    let close = -1
    for (let i = fromEnd + lead; i < masked.length; i += 1) {
      if (masked[i] === "(") depth += 1
      else if (masked[i] === ")") { depth -= 1; if (depth === 0) { close = i; break } }
    }
    if (close < 0) return null
    const aliasM = FROM_ITEM_ALIAS_RE.exec(sql.slice(close + 1))
    if (!aliasM) return null // a subquery in FROM must be aliased
    const start = fromEnd + lead
    const end = close + 1 + aliasM[0].length
    if (!fromItemTailOk(masked.slice(end))) return null
    return { type: "subquery", itemText: sql.slice(start, end), alias: aliasM[1], start, end }
  }

  // Leading block reference: `{name} [alias]`
  if (head === "{") {
    const refM = REF_HEAD_RE.exec(sub)
    if (!refM) return null
    let end = fromEnd + refM[0].length
    let alias = refM[2]
    const aliasM = FROM_ITEM_ALIAS_RE.exec(sql.slice(end))
    if (aliasM) { alias = aliasM[1]; end += aliasM[0].length }
    if (!fromItemTailOk(masked.slice(end))) return null
    return { type: "ref", refName: refM[2], alias, start: fromEnd + refM[1].length, end }
  }

  // Plain base table (keeps all of singleTableRef's safety bails).
  const t = singleTableRef(sql)
  return t ? { type: "table", relation: t.relation, alias: t.alias, start: t.start, end: t.end } : null
}

/**
 * Permissive single-table relation name for COLUMN LOOKUP (not rewrite). Unlike
 * {@link singleTableRef} it does NOT bail on a schema-qualified / no-alias table
 * (those bails guard the surgical *rewrite*; here we only want the relation's
 * columns). Still bails on joins / commas / subqueries (the tail check).
 */
function singleFromRelation(sql: string): string | null {
  const masked = maskSql(sql)
  const fromEnd = topLevelFromEnd(masked)
  if (fromEnd < 0) return null
  const sub = masked.slice(fromEnd)
  if (/^\s*ONLY\b/i.test(sub)) return null
  const refRe = new RegExp(
    `^(\\s*)(${SQL_IDENT}(?:\\.${SQL_IDENT})?)` +
      `(?:\\s+(?:AS\\s+)?(?!(?:${FROM_CLAUSE_KW}|${FROM_JOIN_KW}|AS)\\b)(${SQL_IDENT}))?`,
    "i",
  )
  const mm = refRe.exec(sub)
  if (!mm) return null
  const rest = sub.slice(mm[0].length).trimStart().replace(/;\s*$/, "")
  if (rest !== "" && !new RegExp(`^(?:${FROM_CLAUSE_KW})\\b`, "i").test(rest) && !rest.startsWith(")")) return null
  return mm[2]
}

/** Lowercased column-name set of a relation, or null if not found / ambiguous. */
function tableColumnSet(schema: SchemaSnapshot | null, relation: string): Set<string> | null {
  if (!schema) return null
  const rel = relation.toLowerCase()
  const qualified = rel.includes(".")
  const matches = schema.tables.filter((t) => {
    const fq = `${t.schema}.${t.name}`.toLowerCase()
    return fq === rel || (!qualified && t.name.toLowerCase() === rel)
  })
  if (matches.length !== 1) return null
  return new Set(matches[0].columns.map((c) => c.name.toLowerCase()))
}

/** True when the SELECT projects `*` (a pass-through preview), so its output
 *  columns equal its FROM-item's columns — the only case we can resolve a
 *  referenced block's output without running it. */
function selectsStar(sql: string): boolean {
  return /^\s*SELECT\s+(?:ALL\s+|DISTINCT\s+)?\*\s+FROM\b/i.test(maskSql(sql).trimStart())
}

/** Lowercased output-column set of a block's single FROM-item, following
 *  pass-through {ref}s down to base tables. null = unknown (subquery / explicit
 *  projection / missing schema) — callers stay permissive on null. */
function fromItemColumnSet(
  sql: string,
  schema: SchemaSnapshot | null,
  blockSource: ((name: string) => string | null) | undefined,
  visited: Set<string>,
): Set<string> | null {
  const item = singleFromItem(sql)
  if (item?.type === "subquery") return null // opaque projection
  if (item?.type === "ref") {
    // resolve the referenced block, but only equate its output with its own
    // FROM-item columns when it's a `SELECT *` pass-through.
    const name = item.refName.toLowerCase()
    if (!blockSource || visited.has(name)) return null
    const src = blockSource(item.refName)
    if (!src || !selectsStar(src)) return null
    return fromItemColumnSet(src, schema, blockSource, new Set([...visited, name]))
  }
  // Base table — resolve permissively (singleFromItem may have bailed on a
  // qualified/no-alias table whose columns we can still look up).
  const rel = singleFromRelation(sql)
  return rel ? tableColumnSet(schema, rel) : null
}

/**
 * Decide how a param dropped on a block should be placed:
 *  - "from-item": the field is a column of the single FROM-item (possibly via a
 *    pass-through {ref}) → push the predicate INTO it (surgical).
 *  - "query": the field is in the block's own output → wrap the whole result.
 *  - "none": provably neither → the drop can't produce valid SQL, refuse it.
 * Unknown cases stay permissive (never "none") to avoid false refusals.
 */
export function resolveParamPlacement(
  sql: string,
  field: string,
  schema: SchemaSnapshot | null,
  opts: { ownColumns?: readonly string[] | null; blockSource?: (name: string) => string | null } = {},
): "from-item" | "query" | "none" {
  const f = field.toLowerCase()
  // `item` is what the COMPILER can actually push into (strict — bails on the
  // qualified/no-alias and quoted-alias shapes that break the rewrite). It must
  // be non-null for a from-item push; `fromCols` (permissive, follows {ref}s) is
  // only the column knowledge that tells us whether the field lives there.
  const pushable = singleFromItem(sql) !== null
  const fromCols = fromItemColumnSet(sql, schema, opts.blockSource, new Set())
  if (pushable && fromCols && fromCols.has(f)) return "from-item"
  const own = opts.ownColumns
  if (own && own.some((c) => c.toLowerCase() === f)) return "query"
  if (fromCols && own) return "none" // both sets known, field in neither → certainly absent
  return pushable ? "from-item" : "query" // unknown → best-effort, never refuse
}

export function sameParamValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b)
  return String(a) === String(b)
}
