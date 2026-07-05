import type {
  DesktopColumnRef,
  DesktopQueryLineage,
  RollupAgg,
  RollupCompareOp,
  RollupFilter,
  RollupFilterOp,
  RollupGrain,
  RollupGroupTerm,
  RollupLimit,
  RollupMeasure,
  RollupOp,
  RollupOrderTerm,
  RollupSpec,
  SemanticArg,
  SemanticProjection,
} from "./types"

/** Row cap for a spawned semantic-projection preview — a per-row LLM op must
 *  never silently fan out across a whole table. */
export const PROJECTION_PREVIEW_LIMIT = 200

const NUMERIC_TYPE_IDS = new Set([
  20,    // int8
  21,    // int2
  23,    // int4
  700,   // float4
  701,   // float8
  790,   // money
  1700,  // numeric
])

// Postgres reserved keywords — a simple identifier that IS one of these must
// still be double-quoted (e.g. a table named `order`/`user`/`group`), or the
// generated SQL is a syntax error.
const RESERVED_KEYWORDS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization",
  "binary", "both", "case", "cast", "check", "collate", "collation", "column", "concurrently",
  "constraint", "create", "cross", "current_catalog", "current_date", "current_role",
  "current_schema", "current_time", "current_timestamp", "current_user", "default", "deferrable",
  "desc", "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign", "freeze",
  "from", "full", "grant", "group", "having", "ilike", "in", "initially", "inner", "intersect",
  "into", "is", "isnull", "join", "lateral", "leading", "left", "like", "limit", "localtime",
  "localtimestamp", "natural", "not", "notnull", "null", "offset", "on", "only", "or", "order",
  "outer", "overlaps", "placing", "primary", "references", "returning", "right", "select",
  "session_user", "similar", "some", "symmetric", "system_user", "table", "tablesample", "then",
  "to", "trailing", "true", "union", "unique", "user", "using", "variadic", "verbose", "when",
  "where", "window", "with",
])

export function quoteSqlIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED_KEYWORDS.has(name.toLowerCase())
    ? name
    : `"${name.replace(/"/g, '""')}"`
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

export function previewSqlForTable(schema: string, name: string): string {
  return `SELECT *\nFROM ${quoteSqlIdent(schema)}.${quoteSqlIdent(name)}\nLIMIT 200;`
}

// ── DML scaffolds (right-click "generate …" templates) ─────────────────

function qualified(schema: string, name: string): string {
  return `${quoteSqlIdent(schema)}.${quoteSqlIdent(name)}`
}

export function selectTopSql(schema: string, name: string, n: number): string {
  return `SELECT *\nFROM ${qualified(schema, name)}\nLIMIT ${n};`
}

export function insertTemplateSql(schema: string, name: string, columns: { name: string }[]): string {
  const t = qualified(schema, name)
  if (columns.length === 0) return `INSERT INTO ${t} DEFAULT VALUES;`
  const cols = columns.map((c) => quoteSqlIdent(c.name))
  const vals = columns.map(() => "NULL")
  return `INSERT INTO ${t} (\n  ${cols.join(",\n  ")}\n) VALUES (\n  ${vals.join(",\n  ")}\n);`
}

export function updateTemplateSql(schema: string, name: string, columns: { name: string }[]): string {
  const sets = columns.map((c) => `${quoteSqlIdent(c.name)} = NULL`)
  const body = sets.length > 0 ? `\n  ${sets.join(",\n  ")}` : " /* col = value */"
  return `UPDATE ${qualified(schema, name)} SET${body}\nWHERE /* condition */;`
}

export function deleteTemplateSql(schema: string, name: string): string {
  return `DELETE FROM ${qualified(schema, name)}\nWHERE /* condition */;`
}

// ── Declarative rollup spec ────────────────────────────────────────────
//
// `RollupSpec` is the source of truth for a column-aggregate window.
// `buildRollupQuery` renders it to SQL (a pure function), `applyRollupOp`
// folds a dropped column into it, and `availableRollupOps` decides which
// drop tiles to show for a given column type.

const DATE_TYPE_RE = /\b(date|time|timestamp|timestamptz|interval)\b/

export function isNumericRef(c: DesktopColumnRef): boolean {
  if (c.role === "metric") return true
  if (c.dataTypeId != null && NUMERIC_TYPE_IDS.has(c.dataTypeId)) return true
  return inferDesktopColumnRole({ type: c.type, dataTypeId: c.dataTypeId }) === "metric"
}

export function isDateRef(c: DesktopColumnRef): boolean {
  return DATE_TYPE_RE.test((c.type ?? "").toLowerCase())
}

/** Does an op make sense for a given column's type? */
export function opAppliesToColumn(op: RollupOp, c: DesktopColumnRef): boolean {
  if (op.kind === "group-by" || op.kind === "order-by") return true
  // Pivot fans a column's distinct values into headers — only sane for
  // (low-cardinality) non-numeric dimensions.
  if (op.kind === "pivot") return !isNumericRef(c)
  // Semantic ops are offered via availableSemanticOps, not the rollup tiles.
  if (op.kind === "semantic-op") return false
  switch (op.agg) {
    case "sum":
    case "avg":
    case "median":
    case "stddev":
    case "variance":
      return isNumericRef(c)
    case "min":
    case "max":
      return isNumericRef(c) || isDateRef(c)
    case "count":
    case "count_distinct":
      return true
  }
}

export interface RollupOpTile {
  op: RollupOp
  /** Tile face label. */
  label: string
  /** Tooltip / sublabel, e.g. `avg(col)`. */
  hint: string
  group: "measure" | "dimension" | "pivot"
}

/** Short human label for a measure, e.g. `sum(amount)` or `count`. */
export function measureLabel(m: RollupMeasure): string {
  if (m.alias === "row_count") return "count"
  if (m.agg === "count_distinct") return `distinct(${m.column?.name ?? "*"})`
  return `${m.agg}(${m.column?.name ?? "*"})`
}

// Canonical tile order, independent of which columns are dragged.
const TILE_ORDER: RollupOpTile[] = [
  { op: { kind: "measure", agg: "sum" }, label: "Sum", hint: "sum(col)", group: "measure" },
  { op: { kind: "measure", agg: "avg" }, label: "Avg", hint: "avg(col)", group: "measure" },
  { op: { kind: "measure", agg: "min" }, label: "Min", hint: "min(col)", group: "measure" },
  { op: { kind: "measure", agg: "max" }, label: "Max", hint: "max(col)", group: "measure" },
  { op: { kind: "measure", agg: "count" }, label: "Count", hint: "count(col)", group: "measure" },
  { op: { kind: "measure", agg: "count_distinct" }, label: "Distinct", hint: "count(distinct col)", group: "measure" },
  { op: { kind: "group-by" }, label: "Group by", hint: "GROUP BY col", group: "dimension" },
  { op: { kind: "order-by" }, label: "Order by", hint: "ORDER BY col", group: "dimension" },
]

// For a temporal column the generic "Group by" is swapped for these
// grain tiles (the shelf dropdown exposes the full set incl. week/day/hour).
const GRAIN_TILES: RollupOpTile[] = [
  { op: { kind: "group-by", grain: "month" }, label: "By month", hint: "GROUP BY date_trunc(month)", group: "dimension" },
  { op: { kind: "group-by", grain: "quarter" }, label: "By quarter", hint: "GROUP BY date_trunc(quarter)", group: "dimension" },
  { op: { kind: "group-by", grain: "year" }, label: "By year", hint: "GROUP BY date_trunc(year)", group: "dimension" },
]

/**
 * The set of drop tiles to offer for a (possibly multi-column) drag.
 * A tile is shown when it applies to at least one dragged column; on
 * drop, `applyRollupOp` only affects the columns it actually fits.
 *
 * `targetMeasures` are the existing measures of the block being hovered.
 * When a single dimension is dragged over a block that already has
 * measures, per-measure "Pivot …" tiles (plus a "Pivot all") are appended
 * so the dimension's distinct values can fan out into columns.
 */
export function availableRollupOps(
  columns: DesktopColumnRef[],
  targetMeasures: RollupMeasure[] = [],
): RollupOpTile[] {
  if (columns.length === 0) return []
  let base = TILE_ORDER.filter((tile) => columns.some((c) => opAppliesToColumn(tile.op, c)))

  // A single temporal dimension groups by a grain, not the raw timestamp:
  // swap the generic "Group by" tile for the grain tiles.
  const singleDate = columns.length === 1 && isDateRef(columns[0]) && !isNumericRef(columns[0])
  if (singleDate) {
    base = base.flatMap((tile) => (tile.op.kind === "group-by" ? GRAIN_TILES : [tile]))
  }

  // Pivot is single-dimension only (which column fans out must be
  // unambiguous), and needs at least one measure to spread.
  const canPivot = columns.length === 1
    && opAppliesToColumn({ kind: "pivot" }, columns[0])
    && targetMeasures.length > 0
  if (!canPivot) return base

  // Temporal pivots default to month grain (changeable in the shelf chip).
  const pivotGrain: RollupGrain | undefined = singleDate ? "month" : undefined
  const grainNote = pivotGrain ? ` (by ${pivotGrain})` : ""
  const pivotTiles: RollupOpTile[] = targetMeasures.map((m) => ({
    op: { kind: "pivot", measureIds: [m.id], grain: pivotGrain },
    label: `Pivot ${measureLabel(m)}`,
    hint: `${measureLabel(m)} per ${columns[0].name} value${grainNote}`,
    group: "pivot",
  }))
  if (targetMeasures.length > 1) {
    pivotTiles.push({
      op: { kind: "pivot", grain: pivotGrain },
      label: "Pivot all",
      hint: `every measure per ${columns[0].name} value${grainNote}`,
      group: "pivot",
    })
  }
  return [...base, ...pivotTiles]
}

function rowCountMeasure(): RollupMeasure {
  return { id: "count:*", column: null, agg: "count", alias: "row_count" }
}

function measureId(agg: RollupAgg, column: DesktopColumnRef | null): string {
  return `${agg}:${column?.name ?? "*"}`
}

function aggAliasBase(agg: RollupAgg, column: DesktopColumnRef): string {
  const suffix = aliasSuffix(column.name)
  if (agg === "count_distinct") return `distinct_${suffix}`
  return `${agg}_${suffix}`
}

function uniqueAlias(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}_${taken.size}`
}

// Date grain → Postgres date_trunc unit (names already align 1:1).
const DEFAULT_DATE_GRAIN: RollupGrain = "month"

export function grainTruncExpr(quotedCol: string, grain: RollupGrain): string {
  return `date_trunc('${grain}', ${quotedCol})`
}

/** The grain to use when a temporal column becomes a dimension with none set. */
function defaultGrainFor(c: DesktopColumnRef, explicit?: RollupGrain): RollupGrain | undefined {
  if (explicit) return explicit
  return isDateRef(c) ? DEFAULT_DATE_GRAIN : undefined
}

/** Build the default spec for the initial canvas drop (legacy behavior). */
export function rollupSpecFromColumns(columns: DesktopColumnRef[]): RollupSpec {
  const cols = uniqueColumns(columns)
  const dimensions = cols.filter((c) => !isNumericRef(c))
  const metrics = cols.filter((c) => isNumericRef(c))
  const includeRowCount = dimensions.length > 0 || metrics.length === 0

  const measures: RollupMeasure[] = []
  const taken = new Set<string>()
  if (includeRowCount) {
    measures.push(rowCountMeasure())
    taken.add("row_count")
  }
  for (const c of metrics) {
    const alias = uniqueAlias(aggAliasBase("sum", c), taken)
    taken.add(alias)
    measures.push({ id: measureId("sum", c), column: c, agg: "sum", alias })
  }
  const groupBy: RollupGroupTerm[] = dimensions.map((c) => ({ column: c, grain: defaultGrainFor(c) }))
  return { groupBy, measures }
}

/** Dedup key fragment for a projection's bound args, so the same op on the same
 *  column with *different* binds (a different criterion, or a different sibling
 *  column) counts as distinct. */
function argsKey(args: SemanticArg[] | undefined): string {
  if (!args || args.length === 0) return ""
  return ":" + args.map((a) => (a.kind === "column" ? `c=${a.column}` : `l=${a.value}`)).join("|").toLowerCase()
}

/** Build one semantic projection (a `rvbbit.<op>(col)` derived column). */
function makeProjection(
  column: DesktopColumnRef,
  operator: string,
  returnType: SemanticProjection["returnType"],
  args: SemanticArg[] | undefined,
  taken: Set<string>,
): SemanticProjection {
  const alias = uniqueAlias(`${operator}_${column.name}`, taken)
  return {
    id: `${operator}:${column.name.toLowerCase()}${argsKey(args)}`,
    column,
    operator,
    returnType,
    args: args && args.length > 0 ? args : undefined,
    alias,
  }
}

/** A fresh pure-projection spec for spawning a semantic projection block. */
export function projectionSpecFromOp(
  column: DesktopColumnRef,
  operator: string,
  returnType: SemanticProjection["returnType"],
  args?: SemanticArg[],
): RollupSpec {
  return {
    groupBy: [],
    measures: [],
    projections: [makeProjection(column, operator, returnType, args, new Set())],
  }
}

/**
 * Frequency table for a DIMENSION operator dropped on a text column: fan the
 * column out through the op (one row → a set of canonical labels) and GROUP BY
 * the label to count rows per bucket. Source rows are capped to the preview
 * LIMIT first so a per-row LLM op never fans out across a whole table.
 *
 *   SELECT t.label AS <op>, count(*) AS n
 *   FROM (SELECT * FROM {block} LIMIT 200) b,
 *        LATERAL rvbbit.<op>(b."col"::text) AS t(label)
 *   GROUP BY 1 ORDER BY n DESC
 */
/**
 * rvbbit operator names are interpolated unquoted into `rvbbit.<op>(…)`. They
 * come from catalog rows, so validate they are bare lowercase SQL identifiers —
 * an op with uppercase/hyphens/quotes would break the SQL (or be an injection
 * vector from a hostile catalog row). Throw a clear error rather than emit it.
 */
function safeOperatorName(op: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(op)) {
    throw new Error(`Invalid rvbbit operator name: ${JSON.stringify(op)}`)
  }
  return op
}

export function buildDimensionRollup(
  operator: string,
  column: DesktopColumnRef,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  const col = quoteSqlIdent(column.name)
  const out = quoteSqlIdent(operator)
  // Skip NULL/blank inputs so a per-row LLM op never burns calls on empty cells.
  const sql = [
    `SELECT t.label AS ${out}, count(*) AS n`,
    `FROM (SELECT * FROM {${args.parentBlockName}}`,
    `      WHERE ${col} IS NOT NULL AND ${col}::text <> '' LIMIT ${PROJECTION_PREVIEW_LIMIT}) b,`,
    `     LATERAL rvbbit.${safeOperatorName(operator)}(b.${col}::text) AS t(label)`,
    `GROUP BY 1`,
    `ORDER BY n DESC;`,
  ].join("\n")
  return { sql, title: `${args.parentTitle} · ${operator}` }
}

/** The projected column as a draggable/aggregable column ref (its alias). */
function projectionColumnRef(p: SemanticProjection): DesktopColumnRef {
  const type =
    p.returnType === "float8" ? "double precision"
      : p.returnType === "bool" ? "boolean"
        : p.returnType === "jsonb" ? "jsonb"
          : "text"
  return { name: p.alias, type, role: p.returnType === "float8" ? "metric" : "dimension" }
}

export function removeProjection(spec: RollupSpec, id: string): RollupSpec {
  const proj = (spec.projections ?? []).find((p) => p.id === id)
  const projections = (spec.projections ?? []).filter((p) => p.id !== id)
  const next: RollupSpec = { ...spec, projections: projections.length > 0 ? projections : undefined }
  if (!proj) return next
  // Drop any group-by/measure/order that referenced the removed projection's
  // alias, so we never emit a dangling column reference.
  const alias = proj.alias.toLowerCase()
  next.groupBy = spec.groupBy.filter((t) => t.column.name.toLowerCase() !== alias)
  next.measures = spec.measures.filter((m) => (m.column?.name ?? "").toLowerCase() !== alias)
  const orderBy = (spec.orderBy ?? []).filter((o) => o.ref.toLowerCase() !== alias)
  next.orderBy = orderBy.length > 0 ? orderBy : undefined
  return next
}

/**
 * Compose: group by a projected column + ensure a row count — turns a raw
 * semantic projection into "count of rows by <semantic value>". The
 * derived-table wrap in buildRollupQuery renders it.
 */
export function groupCountByProjection(spec: RollupSpec, proj: SemanticProjection): RollupSpec {
  const col = projectionColumnRef(proj)
  const already = spec.groupBy.some((t) => t.column.name.toLowerCase() === col.name.toLowerCase())
  const groupBy = already ? spec.groupBy : [...spec.groupBy, { column: col }]
  const hasCount = spec.measures.some((m) => m.alias === "row_count")
  const measures = hasCount ? spec.measures : [...spec.measures, rowCountMeasure()]
  return { ...spec, groupBy, measures }
}

/** Compose: aggregate a numeric (float8) projection — e.g. avg of a score. */
export function aggregateProjection(
  spec: RollupSpec,
  proj: SemanticProjection,
  agg: RollupAgg = "avg",
): RollupSpec {
  const col = projectionColumnRef(proj)
  const id = measureId(agg, col)
  if (spec.measures.some((m) => m.id === id)) return spec
  const taken = new Set(spec.measures.map((m) => m.alias))
  const alias = uniqueAlias(aggAliasBase(agg, col), taken)
  return { ...spec, measures: [...spec.measures, { id, column: col, agg, alias }] }
}

/**
 * Coerce a possibly-legacy spec into the current shape. Phase-1 windows
 * persisted `groupBy` as bare column refs; wrap those as group terms so
 * older saved desktops keep working.
 */
export function normalizeRollupSpec(spec: RollupSpec): RollupSpec {
  const groupBy = (spec.groupBy as unknown as Array<RollupGroupTerm | DesktopColumnRef>).map((g) =>
    g && typeof g === "object" && "column" in g
      ? (g as RollupGroupTerm)
      : { column: g as DesktopColumnRef },
  )
  return { ...spec, groupBy }
}

/**
 * The rollup spec a column-aggregate window currently presents to the
 * shelf, or `null` when it has none to show:
 *   - `rollup === null` → detached (hand-edited into un-modelable SQL).
 *   - `rollup` present → normalized spec (source of truth).
 *   - `rollup === undefined` → legacy window; derive from the flat columns.
 * Returns null for any non-column-aggregate lineage.
 */
export function effectiveRollup(lineage: DesktopQueryLineage): RollupSpec | null {
  if (lineage.kind !== "column-aggregate") return null
  if (lineage.rollup === null) return null
  if (lineage.rollup) return normalizeRollupSpec(lineage.rollup)
  return rollupSpecFromColumns(lineage.columns ?? [])
}

/**
 * Fold a dropped column (or multi-selection) into a spec via the chosen
 * op. Returns the next spec plus whether anything actually changed (so a
 * no-op drop — e.g. a dim already grouped — can be ignored upstream).
 */
export function applyRollupOp(
  spec: RollupSpec,
  columns: DesktopColumnRef[],
  op: RollupOp,
): { spec: RollupSpec; changed: boolean } {
  const groupBy = [...spec.groupBy]
  const measures = [...spec.measures]
  const orderBy = [...(spec.orderBy ?? [])]
  const groupNames = new Set(groupBy.map((t) => t.column.name.toLowerCase()))
  const measureIds = new Set(measures.map((m) => m.id))
  const aliases = new Set(measures.map((m) => m.alias))
  const orderRefs = new Set(orderBy.map((t) => t.ref.toLowerCase()))
  let changed = false

  const addGroupBy = (c: DesktopColumnRef, grain?: RollupGrain) => {
    if (groupNames.has(c.name.toLowerCase())) return
    groupBy.push({ column: c, grain: defaultGrainFor(c, grain) })
    groupNames.add(c.name.toLowerCase())
    changed = true
  }

  // Pivot is resolved on an async path (it needs distinct values), not here.
  if (op.kind === "pivot") return { spec, changed: false }

  // Semantic op → append a row-level projection (no aggregation).
  if (op.kind === "semantic-op") {
    const projections = [...(spec.projections ?? [])]
    const taken = new Set(projections.map((p) => p.alias))
    for (const c of columns) {
      const proj = makeProjection(c, op.operator.name, op.operator.returnType, op.args, taken)
      if (projections.some((p) => p.id === proj.id)) continue
      taken.add(proj.alias)
      projections.push(proj)
      changed = true
    }
    return { spec: { ...spec, projections }, changed }
  }

  for (const c of columns) {
    if (!opAppliesToColumn(op, c)) continue
    if (op.kind === "group-by") {
      addGroupBy(c, op.grain)
    } else if (op.kind === "order-by") {
      // Ordering by a raw column requires it to be grouped; ensure that.
      addGroupBy(c)
      if (!orderRefs.has(c.name.toLowerCase())) {
        orderBy.push({ ref: c.name, dir: "asc" })
        orderRefs.add(c.name.toLowerCase())
        changed = true
      }
    } else {
      const id = measureId(op.agg, c)
      if (measureIds.has(id)) continue
      const alias = uniqueAlias(aggAliasBase(op.agg, c), aliases)
      aliases.add(alias)
      measureIds.add(id)
      measures.push({ id, column: c, agg: op.agg, alias })
      changed = true
    }
  }

  return {
    spec: { ...spec, groupBy, measures, orderBy: orderBy.length ? orderBy : undefined },
    changed,
  }
}

// ── Shelf edits (pure spec transforms) ─────────────────────────────────
//
// The rollup shelf mutates the spec through these; the host rebuilds SQL
// with `buildRollupQuery`, exactly like a drag merge. The drop tiles stay
// "Standard", but cycling a measure pill walks the full agg vocabulary —
// that's where median / stddev / variance become reachable.

const NUMERIC_AGG_CYCLE: RollupAgg[] = [
  "sum", "avg", "min", "max", "count", "count_distinct", "median", "stddev", "variance",
]
const TEXT_AGG_CYCLE: RollupAgg[] = ["count", "count_distinct"]

function aggCycleFor(m: RollupMeasure): RollupAgg[] {
  if (!m.column) return ["count"]
  return isNumericRef(m.column) ? NUMERIC_AGG_CYCLE : TEXT_AGG_CYCLE
}

/** Cycle a measure to the next aggregate valid for its column type. */
export function cycleMeasureAgg(spec: RollupSpec, id: string): RollupSpec {
  const idx = spec.measures.findIndex((m) => m.id === id)
  if (idx < 0) return spec
  const m = spec.measures[idx]
  if (!m.column) return spec // row count — nothing to cycle
  const cycle = aggCycleFor(m)
  const here = cycle.indexOf(m.agg)
  const existingIds = new Set(spec.measures.map((x) => x.id))
  for (let step = 1; step <= cycle.length; step += 1) {
    const nextAgg = cycle[(here + step) % cycle.length]
    const nextId = measureId(nextAgg, m.column)
    if (nextId !== m.id && existingIds.has(nextId)) continue // would collide
    const taken = new Set(spec.measures.filter((_, i) => i !== idx).map((x) => x.alias))
    const alias = uniqueAlias(aggAliasBase(nextAgg, m.column), taken)
    const measures = [...spec.measures]
    measures[idx] = { id: nextId, column: m.column, agg: nextAgg, alias }
    // The measure's id (agg:col) changed — repoint anything keyed to it.
    const having = spec.having?.map((h) => (h.measureId === id ? { ...h, measureId: nextId } : h))
    const limit = spec.limit?.byMeasureId === id ? { ...spec.limit, byMeasureId: nextId } : spec.limit
    return reconcilePivot({ ...spec, measures, having, limit })
  }
  return spec
}

/** Remove a group-by dimension (and any order term that referenced it). */
export function removeGroupBy(spec: RollupSpec, colName: string): RollupSpec {
  const lower = colName.toLowerCase()
  const groupBy = spec.groupBy.filter((t) => t.column.name.toLowerCase() !== lower)
  if (groupBy.length === spec.groupBy.length) return spec
  const orderBy = spec.orderBy?.filter((t) => t.ref.toLowerCase() !== lower)
  return { ...spec, groupBy, orderBy: orderBy?.length ? orderBy : undefined }
}

/** Set (or clear) the temporal grain on a group-by dimension. */
export function setGroupByGrain(spec: RollupSpec, colName: string, grain: RollupGrain): RollupSpec {
  const lower = colName.toLowerCase()
  let changed = false
  const groupBy = spec.groupBy.map((t) => {
    if (t.column.name.toLowerCase() !== lower || t.grain === grain) return t
    changed = true
    return { ...t, grain }
  })
  return changed ? { ...spec, groupBy } : spec
}

/** Remove a measure (and any order/having/limit/pivot scoping for it). */
export function removeMeasure(spec: RollupSpec, id: string): RollupSpec {
  const removed = spec.measures.find((m) => m.id === id)
  if (!removed) return spec
  const measures = spec.measures.filter((m) => m.id !== id)
  const orderBy = spec.orderBy?.filter((t) => t.ref.toLowerCase() !== removed.alias.toLowerCase())
  const having = spec.having?.filter((h) => h.measureId !== id)
  const limit = spec.limit?.byMeasureId === id ? { ...spec.limit, byMeasureId: undefined } : spec.limit
  return reconcilePivot({
    ...spec,
    measures,
    orderBy: orderBy?.length ? orderBy : undefined,
    having: having?.length ? having : undefined,
    limit,
  })
}

/** Set or replace a HAVING condition on a measure. */
export function setMeasureHaving(spec: RollupSpec, measureId: string, op: RollupCompareOp, value: number): RollupSpec {
  const having = (spec.having ?? []).filter((h) => h.measureId !== measureId)
  having.push({ measureId, op, value })
  return { ...spec, having }
}

/** Remove the HAVING condition on a measure. */
export function clearMeasureHaving(spec: RollupSpec, measureId: string): RollupSpec {
  const having = spec.having?.filter((h) => h.measureId !== measureId)
  return { ...spec, having: having?.length ? having : undefined }
}

/** Current sort direction for a pill ref (group col name or measure alias). */
export function orderDir(spec: RollupSpec, ref: string): "asc" | "desc" | null {
  const t = spec.orderBy?.find((o) => o.ref.toLowerCase() === ref.toLowerCase())
  return t?.dir ?? null
}

/** 0-based priority of a ref within the explicit ORDER BY (−1 if absent). */
export function orderIndex(spec: RollupSpec, ref: string): number {
  return (spec.orderBy ?? []).findIndex((o) => o.ref.toLowerCase() === ref.toLowerCase())
}

/** Cycle a pill's sort: none → asc → desc → none. New sorts append (lowest priority). */
export function cycleOrderBy(spec: RollupSpec, ref: string): RollupSpec {
  const cur = spec.orderBy ?? []
  const i = cur.findIndex((o) => o.ref.toLowerCase() === ref.toLowerCase())
  let next: RollupOrderTerm[]
  if (i < 0) next = [...cur, { ref, dir: "asc" }]
  else if (cur[i].dir === "asc") { next = [...cur]; next[i] = { ref, dir: "desc" } }
  else next = cur.filter((_, j) => j !== i)
  return { ...spec, orderBy: next.length ? next : undefined }
}

/** Set the Top-N cap (and ranking measure / direction). */
export function setLimit(spec: RollupSpec, limit: RollupLimit): RollupSpec {
  return { ...spec, limit }
}

/** Clear the Top-N cap. */
export function clearLimit(spec: RollupSpec): RollupSpec {
  if (!spec.limit) return spec
  return { ...spec, limit: null }
}

/** Drop the pivot, collapsing the grid back to a plain rollup. */
export function clearPivot(spec: RollupSpec): RollupSpec {
  if (!spec.pivot) return spec
  return { ...spec, pivot: null }
}

/** All WHERE filters targeting a given column. */
export function columnFilters(spec: RollupSpec, colName: string): RollupFilter[] {
  const lower = colName.toLowerCase()
  return (spec.filters ?? []).filter((f) => f.column.name.toLowerCase() === lower)
}

/** Replace every filter on a column with `next` (pass [] to clear it). */
export function setColumnFilters(spec: RollupSpec, colName: string, next: RollupFilter[]): RollupSpec {
  const lower = colName.toLowerCase()
  const others = (spec.filters ?? []).filter((f) => f.column.name.toLowerCase() !== lower)
  const filters = [...others, ...next]
  return { ...spec, filters: filters.length ? filters : undefined }
}

export function clearColumnFilters(spec: RollupSpec, colName: string): RollupSpec {
  return setColumnFilters(spec, colName, [])
}

/** Compact human summary of a column's filters for the shelf badge. */
export function filterBadge(filters: RollupFilter[]): string {
  if (filters.length === 0) return ""
  const byOp = (op: RollupFilterOp) => filters.find((f) => f.op === op)
  const inF = byOp("in")
  if (inF) return `in ${inF.values?.length ?? 0}`
  const notIn = byOp("not_in")
  if (notIn) return `not in ${notIn.values?.length ?? 0}`
  if (byOp("is_null")) return "is null"
  if (byOp("not_null")) return "not null"
  const gte = byOp("gte") ?? byOp("gt")
  const lte = byOp("lte") ?? byOp("lt")
  if (gte && lte) return `${gte.value} – ${lte.value}`
  if (gte) return `≥ ${gte.value}`
  if (lte) return `≤ ${lte.value}`
  const eq = byOp("eq")
  if (eq) return `= ${eq.value}`
  const neq = byOp("neq")
  if (neq) return `≠ ${neq.value}`
  return `${filters.length} filter${filters.length === 1 ? "" : "s"}`
}

/** Keep `pivot.measureIds` pointing only at measures that still exist. */
function reconcilePivot(spec: RollupSpec): RollupSpec {
  if (!spec.pivot?.measureIds) return spec
  const live = new Set(spec.measures.map((m) => m.id))
  const ids = spec.pivot.measureIds.filter((id) => live.has(id))
  return { ...spec, pivot: { ...spec.pivot, measureIds: ids.length ? ids : undefined } }
}

/** Flatten a spec back to the legacy column list (for `lineage.columns`). */
export function rollupSpecColumns(spec: RollupSpec): DesktopColumnRef[] {
  const out: DesktopColumnRef[] = spec.groupBy.map((t) => t.column)
  for (const m of spec.measures) if (m.column) out.push(m.column)
  return uniqueColumns(out)
}

/** The aggregate expression for a measure, without the `AS alias`. */
export function measureExpr(m: RollupMeasure): string {
  if (m.agg === "count" && m.column == null) return "count(1)"
  const col = quoteSqlIdent(m.column!.name)
  switch (m.agg) {
    case "count": return `count(${col})`
    case "count_distinct": return `count(DISTINCT ${col})`
    case "median": return `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${col})`
    case "stddev": return `stddev_samp(${col})`
    case "variance": return `var_samp(${col})`
    default: return `${m.agg}(${col})` // sum / avg / min / max
  }
}

function renderMeasure(m: RollupMeasure): string {
  if (m.agg === "count" && m.column == null) return "  count(1) AS row_count"
  return `  ${measureExpr(m)} AS ${quoteSqlIdent(m.alias)}`
}

/** The SQL expression a group-by dim contributes (grained or raw). */
export function dimExpr(term: RollupGroupTerm): string {
  const col = quoteSqlIdent(term.column.name)
  return term.grain ? grainTruncExpr(col, term.grain) : col
}

/** SELECT line for a group-by dim — aliased to the column name when grained. */
function dimSelectLine(term: RollupGroupTerm): string {
  const col = quoteSqlIdent(term.column.name)
  return term.grain ? `  ${grainTruncExpr(col, term.grain)} AS ${col}` : `  ${col}`
}

function renderOrderBy(spec: RollupSpec): string {
  const explicit = spec.orderBy ?? []
  if (explicit.length > 0) {
    const terms = explicit.map((t) => `${quoteSqlIdent(t.ref)} ${t.dir.toUpperCase()}`)
    return `\nORDER BY ${terms.join(", ")}`
  }
  const measures = spec.measures
  if (measures.some((m) => m.alias === "row_count")) return "\nORDER BY row_count DESC"
  if (measures.length > 0) return `\nORDER BY ${quoteSqlIdent(measures[0].alias)} DESC`
  if (spec.groupBy.length > 0) return "\nORDER BY 1"
  return ""
}

/** The default ORDER BY body (no `ORDER BY ` prefix) for a spec's dims/measures. */
export function defaultOrderExpr(spec: RollupSpec): string {
  return renderOrderBy({ ...spec, orderBy: undefined }).replace(/^\nORDER BY /, "")
}

function sqlLiteral(v: string | number | null): string {
  if (v === null) return "NULL"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL"
  return `'${String(v).replace(/'/g, "''")}'`
}

function rankingMeasure(measures: RollupMeasure[], byId?: string): RollupMeasure | undefined {
  if (byId) {
    const m = measures.find((x) => x.id === byId)
    if (m) return m
  }
  return measures.find((m) => m.alias !== "row_count") ?? measures[0]
}

const FILTER_OP_SQL: Record<"eq" | "neq" | "gt" | "gte" | "lt" | "lte", string> = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
}

/** A single WHERE predicate for a filter, or null if it has no effect. */
function filterPredicate(f: RollupFilter): string | null {
  const col = quoteSqlIdent(f.column.name)
  if (f.op === "is_null") return `${col} IS NULL`
  if (f.op === "not_null") return `${col} IS NOT NULL`
  if (f.op === "in" || f.op === "not_in") {
    const vals = (f.values ?? []).filter((v) => v !== null)
    if (vals.length === 0) return null
    const list = vals.map(sqlLiteral).join(", ")
    return `${col} ${f.op === "in" ? "IN" : "NOT IN"} (${list})`
  }
  if (f.value === undefined || f.value === null) return null
  return `${col} ${FILTER_OP_SQL[f.op]} ${sqlLiteral(f.value)}`
}

/** `WHERE <pred> AND …` over the source columns (pre-aggregation). */
function renderWhere(spec: RollupSpec): string {
  const preds = (spec.filters ?? []).map(filterPredicate).filter((p): p is string => p != null)
  return preds.length > 0 ? `\nWHERE ${preds.join("\n  AND ")}` : ""
}

/** `HAVING <expr> <op> <val> AND …` over the (resolved) measures. */
function renderHaving(spec: RollupSpec, measures: RollupMeasure[]): string {
  const terms = (spec.having ?? [])
    .map((h) => {
      const m = measures.find((x) => x.id === h.measureId)
      return m ? `${measureExpr(m)} ${h.op} ${h.value}` : null
    })
    .filter((t): t is string => t != null)
  return terms.length > 0 ? `\nHAVING ${terms.join(" AND ")}` : ""
}

/** Top-N ordering + LIMIT clauses, or null when no limit is set. */
function renderTopN(spec: RollupSpec, measures: RollupMeasure[]): { orderBy: string; limit: string } | null {
  if (!spec.limit) return null
  const rank = rankingMeasure(measures, spec.limit.byMeasureId)
  const dir = (spec.limit.dir ?? "desc").toUpperCase()
  const orderBy = rank ? `\nORDER BY ${measureExpr(rank)} ${dir}` : ""
  const n = Number.isFinite(spec.limit.n) ? Math.max(1, Math.floor(spec.limit.n)) : 100
  return { orderBy, limit: `\nLIMIT ${n}` }
}

function valueSlug(v: string | number | null): string {
  if (v === null) return "null"
  let s = String(v)
  // Truncated dates serialize as midnight timestamps; keep just the date
  // part so pivot aliases read `2024_01_01_…` not `2024_01_01t00_00_00z`.
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[ T]00:00:00/)
  if (iso) s = iso[1]
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned || "val"
}

/** Render a `RollupSpec` to SQL over a parent block reference. */
/** `rvbbit.<op>(col::text[, 'literal'…]) AS alias` for a semantic projection. */
function projectionExpr(p: SemanticProjection): string {
  // arg0 is the dragged column, cast to text (op arg types are text/jsonb).
  // Extra args are either a bound literal or a reference to a sibling column
  // (also cast to text) — e.g. rvbbit.contradicts(claim::text, evidence::text).
  const extra = (p.args ?? []).map((a) =>
    a.kind === "column" ? `${quoteSqlIdent(a.column)}::text` : sqlLiteral(a.value),
  )
  const argExprs = [`${quoteSqlIdent(p.column.name)}::text`, ...extra]
  return `rvbbit.${safeOperatorName(p.operator)}(${argExprs.join(", ")}) AS ${quoteSqlIdent(p.alias)}`
}
function renderProjection(p: SemanticProjection): string {
  return `  ${projectionExpr(p)}`
}

/**
 * Derived-table FROM clause that computes the semantic projections over the
 * source (capped), so an outer query can GROUP BY / aggregate the projected
 * columns: `(SELECT *, rvbbit.op(col) AS x FROM {block} [WHERE …] LIMIT N) s`.
 * This is what lets a single block both project a semantic column and
 * aggregate by it.
 */
function buildProjectionFrom(spec: RollupSpec, parentBlockName: string): string {
  const projections = spec.projections ?? []
  const where = renderWhere(spec) // applied in the inner so filters run before the LLM projection + LIMIT
  return [
    "(",
    "  SELECT *,",
    projections.map((p) => `    ${projectionExpr(p)}`).join(",\n"),
    `  FROM {${parentBlockName}}${where}`,
    `  LIMIT ${PROJECTION_PREVIEW_LIMIT}`,
    ") s",
  ].join("\n")
}

/**
 * A pure row-level projection block: the source columns the projections read,
 * plus each `rvbbit.<op>(col)` derived column, capped to a preview LIMIT so a
 * per-row LLM op never fans out across a whole table.
 */
function buildProjectionQuery(
  spec: RollupSpec,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  const projections = spec.projections ?? []
  const seen = new Set<string>()
  const srcCols: DesktopColumnRef[] = []
  for (const p of projections) {
    const key = p.column.name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      srcCols.push(p.column)
    }
  }
  const selectLines = [
    ...srcCols.map((c) => `  ${quoteSqlIdent(c.name)}`),
    ...projections.map(renderProjection),
  ]
  const sql = [
    "SELECT",
    selectLines.join(",\n"),
    `FROM {${args.parentBlockName}}\nLIMIT ${PROJECTION_PREVIEW_LIMIT};`,
  ].join("\n")
  const opLabel = projections.map((p) => p.operator).join(", ")
  return { sql, title: `${args.parentTitle} · ${opLabel}` }
}

export function buildRollupQuery(
  spec: RollupSpec,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  const hasProjections = (spec.projections?.length ?? 0) > 0
  // Pure semantic projection (no grouping/aggregation) → projection block.
  if (hasProjections && spec.groupBy.length === 0 && spec.measures.length === 0) {
    return buildProjectionQuery(spec, args)
  }
  if (spec.pivot && spec.pivot.values.length > 0) {
    return buildPivotQuery(spec, spec.pivot, args)
  }

  const dims = spec.groupBy
  // Always keep at least a row count, so an emptied shelf still yields a
  // valid SELECT (the grand-total count) rather than an empty projection.
  const measures = spec.measures.length > 0 ? spec.measures : [rowCountMeasure()]

  const selectLines = [
    ...dims.map(dimSelectLine),
    ...measures.map(renderMeasure),
  ]
  // With projections, the source is wrapped in a derived table that computes
  // them (and applies WHERE before the LLM projection); the outer query
  // GROUP BYs / aggregates the projected columns. Without, it's the plain
  // block reference and WHERE goes on the outer.
  const fromClause = hasProjections
    ? buildProjectionFrom(spec, args.parentBlockName)
    : `{${args.parentBlockName}}`
  const where = hasProjections ? "" : renderWhere(spec)
  // With projections, GROUP BY must be POSITIONAL: rvbbit's planner inlines a
  // group-by *alias* back to its `rvbbit.op(col)` definition, which pulls the
  // source column out of the derived table ("col must appear in GROUP BY").
  // Grouping by SELECT position (dims are emitted first) sidesteps the inline.
  const groupBy = dims.length > 0
    ? hasProjections
      ? `\nGROUP BY ${dims.map((_, i) => i + 1).join(", ")}`
      : `\nGROUP BY ${dims.map(dimExpr).join(", ")}`
    : ""
  const having = renderHaving(spec, measures)
  const topN = renderTopN(spec, measures)
  // Explicit pill sorts win the ORDER BY; a Top-N limit still caps rows.
  const hasExplicitOrder = (spec.orderBy?.length ?? 0) > 0
  // Composed (projection) queries omit ORDER BY / Top-N: rvbbit's planner
  // rewrite breaks both alias- and position-based ORDER BY over a derived
  // table containing an operator. The grid sorts client-side; the inner LIMIT
  // already caps the row (and LLM-call) count.
  const orderBy = hasProjections ? "" : hasExplicitOrder || !topN ? renderOrderBy({ ...spec, measures }) : topN.orderBy
  const limit = hasProjections ? "" : topN ? topN.limit : ""

  const sql = [
    `SELECT`,
    selectLines.join(",\n"),
    `FROM ${fromClause}${where}${groupBy}${having}${orderBy}${limit};`,
  ].join("\n")

  return { sql, title: titleForRollup(args.parentTitle, spec) }
}

/**
 * Tableau-style pivot via conditional aggregation: each (pivot value ×
 * pivoted measure) becomes a `agg(col) FILTER (WHERE pivotcol = v)` column.
 * Portable (no `crosstab`/tablefunc) and a pure function of the resolved
 * `pivot.values`. Non-pivoted measures stay as ordinary columns.
 */
function buildPivotQuery(
  spec: RollupSpec,
  pivot: NonNullable<RollupSpec["pivot"]>,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  const pivotColLower = pivot.column.name.toLowerCase()
  const rowDims = spec.groupBy.filter((d) => d.column.name.toLowerCase() !== pivotColLower)
  const allMeasures = spec.measures.length > 0 ? spec.measures : [rowCountMeasure()]
  const scoped = pivot.measureIds && pivot.measureIds.length > 0
    ? new Set(pivot.measureIds)
    : null
  const pivoted = scoped ? allMeasures.filter((m) => scoped.has(m.id)) : allMeasures
  const plain = scoped ? allMeasures.filter((m) => !scoped.has(m.id)) : []

  const taken = new Set<string>()
  const selectLines: string[] = [
    ...rowDims.map(dimSelectLine),
    ...plain.map((m) => {
      const alias = uniqueAlias(m.alias, taken)
      taken.add(alias)
      return `  ${measureExpr(m)} AS ${quoteSqlIdent(alias)}`
    }),
  ]

  const pivotColExpr = pivot.grain
    ? grainTruncExpr(quoteSqlIdent(pivot.column.name), pivot.grain)
    : quoteSqlIdent(pivot.column.name)
  for (const v of pivot.values) {
    const pred = v === null ? `${pivotColExpr} IS NULL` : `${pivotColExpr} = ${sqlLiteral(v)}`
    for (const m of pivoted) {
      const alias = uniqueAlias(`${valueSlug(v)}_${m.alias}`, taken)
      taken.add(alias)
      selectLines.push(`  ${measureExpr(m)} FILTER (WHERE ${pred}) AS ${quoteSqlIdent(alias)}`)
    }
  }

  const where = renderWhere(spec)
  const groupBy = rowDims.length > 0
    ? `\nGROUP BY ${rowDims.map(dimExpr).join(", ")}`
    : ""
  // HAVING/Top-N reference measure *totals* (un-pivoted aggregates), so a
  // pivot can still be filtered to "row groups whose total sales > X" or
  // capped to the top N row groups by a measure.
  const having = renderHaving(spec, allMeasures)
  const topN = renderTopN(spec, allMeasures)
  const hasExplicitOrder = (spec.orderBy?.length ?? 0) > 0
  const orderBy = hasExplicitOrder
    ? renderOrderBy({ ...spec, measures: allMeasures })
    : topN ? topN.orderBy : (rowDims.length > 0 ? "\nORDER BY 1" : "")
  const limit = topN ? topN.limit : ""

  const sql = [
    `SELECT`,
    selectLines.join(",\n"),
    `FROM {${args.parentBlockName}}${where}${groupBy}${having}${orderBy}${limit};`,
  ].join("\n")

  const rowLabel = rowDims.length > 0 ? rowDims.map((c) => c.column.name).join(", ") : "totals"
  return {
    sql,
    title: `${args.parentTitle}: ${rowLabel} × ${pivot.column.name}`,
  }
}

function titleForRollup(parentTitle: string, spec: RollupSpec): string {
  const dims = spec.groupBy.map((t) => t.column.name)
  const meas = spec.measures
    .filter((m) => m.alias !== "row_count")
    .map((m) => `${m.agg === "count_distinct" ? "distinct" : m.agg}(${m.column?.name ?? "*"})`)
  if (dims.length > 0 && meas.length > 0) return `${parentTitle}: ${dims.join(", ")} · ${meas.join(", ")}`
  if (dims.length > 0) return `${parentTitle}: ${dims.join(", ")} counts`
  if (meas.length > 0) return `${parentTitle}: ${meas.join(", ")}`
  return `${parentTitle}: rollup`
}
