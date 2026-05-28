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
  switch (op.agg) {
    case "sum":
    case "avg":
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
  group: "measure" | "dimension"
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
 */
export function availableRollupOps(columns: DesktopColumnRef[]): RollupOpTile[] {
  if (columns.length === 0) return []
  return TILE_ORDER.filter((tile) => columns.some((c) => opAppliesToColumn(tile.op, c)))
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

/** Flatten a spec back to the legacy column list (for `lineage.columns`). */
export function rollupSpecColumns(spec: RollupSpec): DesktopColumnRef[] {
  const out: DesktopColumnRef[] = [...spec.groupBy]
  for (const m of spec.measures) if (m.column) out.push(m.column)
  return uniqueColumns(out)
}

function renderMeasure(m: RollupMeasure): string {
  if (m.agg === "count" && m.column == null) return "  count(1) AS row_count"
  const col = quoteSqlIdent(m.column!.name)
  const alias = quoteSqlIdent(m.alias)
  if (m.agg === "count") return `  count(${col}) AS ${alias}`
  if (m.agg === "count_distinct") return `  count(DISTINCT ${col}) AS ${alias}`
  return `  ${m.agg}(${col}) AS ${alias}`
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

/** Render a `RollupSpec` to SQL over a parent block reference. */
export function buildRollupQuery(
  spec: RollupSpec,
  args: { parentBlockName: string; parentTitle: string },
): { sql: string; title: string } {
  const dims = spec.groupBy
  const measures = spec.measures.length > 0
    ? spec.measures
    : dims.length > 0
      ? [rowCountMeasure()]
      : []

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
