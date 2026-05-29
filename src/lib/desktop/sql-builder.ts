import type {
  DesktopColumnRef,
  RollupAgg,
  RollupMeasure,
  RollupOp,
  RollupSpec,
} from "./types"

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

export function previewSqlForTable(schema: string, name: string): string {
  return `SELECT *\nFROM ${quoteSqlIdent(schema)}.${quoteSqlIdent(name)}\nLIMIT 200;`
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
  const base = TILE_ORDER.filter((tile) => columns.some((c) => opAppliesToColumn(tile.op, c)))

  // Pivot is single-dimension only (which column fans out must be
  // unambiguous), and needs at least one measure to spread.
  const canPivot = columns.length === 1
    && opAppliesToColumn({ kind: "pivot" }, columns[0])
    && targetMeasures.length > 0
  if (!canPivot) return base

  const pivotTiles: RollupOpTile[] = targetMeasures.map((m) => ({
    op: { kind: "pivot", measureIds: [m.id] },
    label: `Pivot ${measureLabel(m)}`,
    hint: `${measureLabel(m)} per ${columns[0].name} value`,
    group: "pivot",
  }))
  if (targetMeasures.length > 1) {
    pivotTiles.push({
      op: { kind: "pivot" },
      label: "Pivot all",
      hint: `every measure per ${columns[0].name} value`,
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
  return { groupBy: dimensions, measures }
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
  const groupNames = new Set(groupBy.map((c) => c.name.toLowerCase()))
  const measureIds = new Set(measures.map((m) => m.id))
  const aliases = new Set(measures.map((m) => m.alias))
  const orderRefs = new Set(orderBy.map((t) => t.ref.toLowerCase()))
  let changed = false

  const addGroupBy = (c: DesktopColumnRef) => {
    if (groupNames.has(c.name.toLowerCase())) return
    groupBy.push(c)
    groupNames.add(c.name.toLowerCase())
    changed = true
  }

  // Pivot is resolved on an async path (it needs distinct values), not here.
  if (op.kind === "pivot") return { spec, changed: false }

  for (const c of columns) {
    if (!opAppliesToColumn(op, c)) continue
    if (op.kind === "group-by") {
      addGroupBy(c)
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
    return reconcilePivot({ ...spec, measures })
  }
  return spec
}

/** Remove a group-by dimension (and any order term that referenced it). */
export function removeGroupBy(spec: RollupSpec, colName: string): RollupSpec {
  const lower = colName.toLowerCase()
  const groupBy = spec.groupBy.filter((c) => c.name.toLowerCase() !== lower)
  if (groupBy.length === spec.groupBy.length) return spec
  const orderBy = spec.orderBy?.filter((t) => t.ref.toLowerCase() !== lower)
  return { ...spec, groupBy, orderBy: orderBy?.length ? orderBy : undefined }
}

/** Remove a measure (and any order/pivot scoping that referenced it). */
export function removeMeasure(spec: RollupSpec, id: string): RollupSpec {
  const removed = spec.measures.find((m) => m.id === id)
  if (!removed) return spec
  const measures = spec.measures.filter((m) => m.id !== id)
  const orderBy = spec.orderBy?.filter((t) => t.ref.toLowerCase() !== removed.alias.toLowerCase())
  return reconcilePivot({ ...spec, measures, orderBy: orderBy?.length ? orderBy : undefined })
}

/** Drop the pivot, collapsing the grid back to a plain rollup. */
export function clearPivot(spec: RollupSpec): RollupSpec {
  if (!spec.pivot) return spec
  return { ...spec, pivot: null }
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
  const out: DesktopColumnRef[] = [...spec.groupBy]
  for (const m of spec.measures) if (m.column) out.push(m.column)
  return uniqueColumns(out)
}

/** The aggregate expression for a measure, without the `AS alias`. */
function measureExpr(m: RollupMeasure): string {
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

function sqlLiteral(v: string | number | null): string {
  if (v === null) return "NULL"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL"
  return `'${String(v).replace(/'/g, "''")}'`
}

function valueSlug(v: string | number | null): string {
  if (v === null) return "null"
  const cleaned = String(v).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned || "val"
}

/** Render a `RollupSpec` to SQL over a parent block reference. */
export function buildRollupQuery(
  spec: RollupSpec,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  if (spec.pivot && spec.pivot.values.length > 0) {
    return buildPivotQuery(spec, spec.pivot, args)
  }

  const dims = spec.groupBy
  // Always keep at least a row count, so an emptied shelf still yields a
  // valid SELECT (the grand-total count) rather than an empty projection.
  const measures = spec.measures.length > 0 ? spec.measures : [rowCountMeasure()]

  const selectLines = [
    ...dims.map((c) => `  ${quoteSqlIdent(c.name)}`),
    ...measures.map(renderMeasure),
  ]
  const groupBy = dims.length > 0
    ? `\nGROUP BY ${dims.map((c) => quoteSqlIdent(c.name)).join(", ")}`
    : ""
  const orderBy = renderOrderBy({ ...spec, measures })

  const sql = [
    `SELECT`,
    selectLines.join(",\n"),
    `FROM {${args.parentBlockName}}${groupBy}${orderBy};`,
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
  const rowDims = spec.groupBy.filter((d) => d.name.toLowerCase() !== pivotColLower)
  const allMeasures = spec.measures.length > 0 ? spec.measures : [rowCountMeasure()]
  const scoped = pivot.measureIds && pivot.measureIds.length > 0
    ? new Set(pivot.measureIds)
    : null
  const pivoted = scoped ? allMeasures.filter((m) => scoped.has(m.id)) : allMeasures
  const plain = scoped ? allMeasures.filter((m) => !scoped.has(m.id)) : []

  const taken = new Set<string>()
  const selectLines: string[] = [
    ...rowDims.map((c) => `  ${quoteSqlIdent(c.name)}`),
    ...plain.map((m) => {
      const alias = uniqueAlias(m.alias, taken)
      taken.add(alias)
      return `  ${measureExpr(m)} AS ${quoteSqlIdent(alias)}`
    }),
  ]

  const pivotCol = quoteSqlIdent(pivot.column.name)
  for (const v of pivot.values) {
    const pred = v === null ? `${pivotCol} IS NULL` : `${pivotCol} = ${sqlLiteral(v)}`
    for (const m of pivoted) {
      const alias = uniqueAlias(`${valueSlug(v)}_${m.alias}`, taken)
      taken.add(alias)
      selectLines.push(`  ${measureExpr(m)} FILTER (WHERE ${pred}) AS ${quoteSqlIdent(alias)}`)
    }
  }

  const groupBy = rowDims.length > 0
    ? `\nGROUP BY ${rowDims.map((c) => quoteSqlIdent(c.name)).join(", ")}`
    : ""
  const orderBy = rowDims.length > 0 ? "\nORDER BY 1" : ""

  const sql = [
    `SELECT`,
    selectLines.join(",\n"),
    `FROM {${args.parentBlockName}}${groupBy}${orderBy};`,
  ].join("\n")

  const rowLabel = rowDims.length > 0 ? rowDims.map((c) => c.name).join(", ") : "totals"
  return {
    sql,
    title: `${args.parentTitle}: ${rowLabel} × ${pivot.column.name}`,
  }
}

function titleForRollup(parentTitle: string, spec: RollupSpec): string {
  const dims = spec.groupBy.map((c) => c.name)
  const meas = spec.measures
    .filter((m) => m.alias !== "row_count")
    .map((m) => `${m.agg === "count_distinct" ? "distinct" : m.agg}(${m.column?.name ?? "*"})`)
  if (dims.length > 0 && meas.length > 0) return `${parentTitle}: ${dims.join(", ")} · ${meas.join(", ")}`
  if (dims.length > 0) return `${parentTitle}: ${dims.join(", ")} counts`
  if (meas.length > 0) return `${parentTitle}: ${meas.join(", ")}`
  return `${parentTitle}: rollup`
}
