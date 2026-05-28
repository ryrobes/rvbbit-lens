/**
 * Shelf model + Vega-Lite spec round-trip.
 *
 * The persisted DSL is plain Vega-Lite (matching what `chartSpec` already
 * stores). The shelf editor reads a spec → ShelfState, lets the user edit
 * pills, and writes ShelfState → Vega-Lite spec. Anything the shelf doesn't
 * understand is preserved in `residual` so it round-trips unchanged.
 */

import type { QueryResultColumn } from "@/lib/db/types"
import { classifyColumn, type ColumnRole } from "./chart-infer"

// ── Types ───────────────────────────────────────────────────────────

export type VegaType = "quantitative" | "temporal" | "ordinal" | "nominal"

export type AggregateOp =
  | "sum"
  | "mean"
  | "median"
  | "min"
  | "max"
  | "count"
  | "distinct"
  | "stdev"
  | "variance"

export const AGGREGATE_OPS: AggregateOp[] = [
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "count",
  "distinct",
  "stdev",
  "variance",
]

export type TimeUnit =
  | "year"
  | "quarter"
  | "month"
  | "yearmonth"
  | "yearmonthdate"
  | "date"
  | "day"
  | "hours"
  | "minutes"

export const TIME_UNITS: TimeUnit[] = [
  "year",
  "quarter",
  "month",
  "yearmonth",
  "yearmonthdate",
  "date",
  "day",
  "hours",
  "minutes",
]

export type SortDir = "ascending" | "descending" | "-y" | "y" | "-x" | "x"

export type MarkType =
  | "bar"
  | "line"
  | "area"
  | "point"
  | "tick"
  | "rect"
  | "text"
  | "boxplot"

export const MARK_TYPES: MarkType[] = [
  "bar",
  "line",
  "area",
  "point",
  "tick",
  "rect",
  "text",
  "boxplot",
]

export type StackMode = "zero" | "normalize" | "center" | null

export interface ChannelPill {
  /** Empty when aggregate === "count" without a field — Vega-Lite count is field-less. */
  field: string
  /**
   * Vega-Lite type. Defaulted from column role but user-overridable so a
   * numeric id column can be re-cast as "nominal" etc.
   */
  type: VegaType
  aggregate?: AggregateOp | null
  /** Only valid when type === "temporal". */
  timeUnit?: TimeUnit | null
  /** Only valid when type === "quantitative". */
  bin?: boolean | { maxbins: number } | null
  sort?: SortDir | null
  title?: string | null
}

export type FilterOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "in" | "between" | "non-null"

export interface FilterPill {
  field: string
  type: VegaType
  op: FilterOp
  /** Single-value ops use `value`; list/range ops use `values`. */
  value?: unknown
  values?: unknown[]
}

export interface MarkConfig {
  type: MarkType
  /** Stack mode for bar/area (null = side-by-side). */
  stack?: StackMode
  /** For line: draw points along the line. */
  point?: boolean
  /** For point: filled (vs hollow). */
  filled?: boolean
  /** For area: opacity. */
  opacity?: number | null
}

export interface ResidualBag {
  /** Encoding channels we don't manage (e.g. row/column facet, href). */
  encoding: Record<string, unknown>
  /** Transforms we couldn't safely parse — bundled at the end. */
  transform: unknown[]
  /** Selection / param blocks the user authored — preserved. */
  params: unknown[]
  /** Other top-level keys (`$schema`, `title`, `description`, …). */
  other: Record<string, unknown>
}

export interface FacetState {
  /** column = trellis across columns (Vega-Lite `encoding.column`). */
  column: ChannelPill | null
  /** row = trellis down rows (Vega-Lite `encoding.row`). */
  row: ChannelPill | null
}

export interface ShelfState {
  mark: MarkConfig
  /**
   * Positional shelves are multi-pill (Tableau-style). The emit path inspects
   * the pill composition:
   *   • 0 pills → channel omitted
   *   • 1 pill → direct encoding
   *   • N pills, all dims → `calculate`+`join` emits a single nested-label axis
   *   • N pills, all measures → wraps the spec in vconcat / hconcat (one
   *     small-multiple panel per measure, every other channel shared)
   * Mixed composition cannot be produced by the editor's drop rules; if a
   * hand-edited spec lands here, the last pill wins as a safe fallback.
   */
  x: ChannelPill[]
  y: ChannelPill[]
  color: ChannelPill | null
  size: ChannelPill | null
  shape: ChannelPill | null
  /** Small-multiple facet — maps to `encoding.column` / `encoding.row`. */
  facet: FacetState
  tooltip: ChannelPill[]
  filters: FilterPill[]
  residual: ResidualBag
}

export type ShelfChannel = "x" | "y" | "color" | "size" | "shape" | "tooltip" | "column" | "row"

/** Channels the editor manages — emitted to spec.encoding[channel]. */
export const MANAGED_CHANNELS: ShelfChannel[] = [
  "x",
  "y",
  "color",
  "size",
  "shape",
  "tooltip",
  "column",
  "row",
]

/**
 * A pill is "dim-style" when it neither carries an aggregate nor lives on
 * the quantitative/temporal scale. These compose cleanly into a nested
 * categorical axis via `calculate`+`join`; anything else needs to be the
 * sole occupant of its positional shelf.
 */
export function isDimPill(p: ChannelPill): boolean {
  if (p.aggregate) return false
  if (p.type === "quantitative") return false
  if (p.type === "temporal") return false
  return true
}

/** A pill that carries an aggregate — composes into vconcat / hconcat panels. */
export function isMeasurePill(p: ChannelPill): boolean {
  return !!p.aggregate
}

/** Field name marker for the synthesized join field on x/y. */
const MULTI_DIM_AS_PREFIX = "__shelf_"
/** Separator used in the join — also shown in tick labels. */
export const MULTI_DIM_JOIN_SEP = " · "

// ── Defaults / role mapping ─────────────────────────────────────────

export function defaultVegaType(role: ColumnRole): VegaType {
  switch (role) {
    case "numeric":
      return "quantitative"
    case "temporal":
      return "temporal"
    case "boolean":
      return "nominal"
    default:
      return "nominal"
  }
}

export function emptyShelfState(): ShelfState {
  return {
    mark: { type: "bar", stack: "zero" },
    x: [],
    y: [],
    color: null,
    size: null,
    shape: null,
    facet: { column: null, row: null },
    tooltip: [],
    filters: [],
    residual: { encoding: {}, transform: [], params: [], other: {} },
  }
}

/** Build a fresh pill from a column drop. */
export function pillFromColumn(
  col: QueryResultColumn,
  opts: { channel?: ShelfChannel } = {},
): ChannelPill {
  const role = classifyColumn(col)
  const type = defaultVegaType(role)
  const pill: ChannelPill = { field: col.name, type }
  // On the y shelf, sensible default = sum for numerics
  if (opts.channel === "y" && type === "quantitative") {
    pill.aggregate = "sum"
  }
  if (opts.channel === "x" && type === "temporal") {
    pill.timeUnit = "yearmonth"
  }
  return pill
}

/** A field-less "Count" pill — the special-case for Vega-Lite count(). */
export function countPill(channel: ShelfChannel): ChannelPill {
  return {
    field: "",
    type: "quantitative",
    aggregate: "count",
    title: channel === "y" || channel === "x" ? "Count of records" : null,
  }
}

// ── Pill → encoding fragment ────────────────────────────────────────

function pillToEncoding(p: ChannelPill): Record<string, unknown> {
  const out: Record<string, unknown> = { type: p.type }
  // Count is field-less. Other aggregates require a field.
  if (p.aggregate === "count") {
    out.aggregate = "count"
    if (p.field) out.field = p.field // tolerate but not required
  } else {
    if (p.field) out.field = p.field
    if (p.aggregate) out.aggregate = p.aggregate
  }
  if (p.type === "temporal" && p.timeUnit) out.timeUnit = p.timeUnit
  if (p.type === "quantitative" && p.bin) {
    out.bin = p.bin === true ? true : { maxbins: (p.bin as { maxbins: number }).maxbins }
  }
  if (p.sort) out.sort = p.sort
  if (p.title) out.title = p.title
  return out
}

function filterToTransform(f: FilterPill): Record<string, unknown> {
  // Vega-Lite native filter shapes — keep the spec idiomatic so users
  // hand-editing the YAML see something recognizable.
  const base: Record<string, unknown> = { field: f.field }
  switch (f.op) {
    case "eq":
      return { filter: { ...base, equal: f.value } }
    case "neq":
      return { filter: `datum[${jsStringLiteral(f.field)}] !== ${jsLiteral(f.value)}` }
    case "gt":
      return { filter: { ...base, range: [Number(f.value), null] } }
    case "lt":
      return { filter: { ...base, range: [null, Number(f.value)] } }
    case "gte":
      return { filter: `datum[${jsStringLiteral(f.field)}] >= ${jsLiteral(f.value)}` }
    case "lte":
      return { filter: `datum[${jsStringLiteral(f.field)}] <= ${jsLiteral(f.value)}` }
    case "in":
      return { filter: { ...base, oneOf: f.values ?? [] } }
    case "between": {
      const [lo, hi] = f.values ?? []
      return { filter: { ...base, range: [lo ?? null, hi ?? null] } }
    }
    case "non-null":
      return { filter: { ...base, valid: true } }
    default:
      return { filter: { ...base, equal: f.value } }
  }
}

function jsStringLiteral(s: string): string {
  return JSON.stringify(s)
}
function jsLiteral(v: unknown): string {
  if (v == null) return "null"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}

function markToVega(m: MarkConfig): Record<string, unknown> | string {
  const extras: Record<string, unknown> = {}
  if (m.type === "line" && m.point) extras.point = true
  if (m.type === "point") {
    if (m.filled !== undefined) extras.filled = m.filled
  }
  if (m.type === "area" && m.opacity != null) extras.opacity = m.opacity
  // Use the long-form { type } so we can attach extras cleanly. Even
  // an empty extras keeps the parse simple.
  return { type: m.type, ...extras }
}

// ── ShelfState → Vega-Lite spec ─────────────────────────────────────

/**
 * Escape a field name for embedding into a Vega expression literal. We use
 * `datum['Field Name']` form so spaces / dots in field names survive.
 */
function exprField(name: string): string {
  return `datum['${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`
}

/** Build the calculate expression: `join([toString(datum['F1']), …], ' · ')`. */
function buildJoinCalculate(pills: ChannelPill[]): string {
  const parts = pills.map((p) => `toString(${exprField(p.field)})`).join(", ")
  return `join([${parts}], '${MULTI_DIM_JOIN_SEP}')`
}

/** Best-effort parse of the join expression we emit — returns ordered field names. */
export function parseJoinCalculate(expr: string): string[] | null {
  const m = expr.match(/^join\(\[(.+)\],\s*'(.*?)'\)$/s)
  if (!m) return null
  const inner = m[1]
  const re = /toString\(datum\[\s*'((?:\\.|[^'\\])+)'\s*\]\)/g
  const fields: string[] = []
  let mm: RegExpExecArray | null
  while ((mm = re.exec(inner)) != null) {
    fields.push(mm[1].replace(/\\(.)/g, "$1"))
  }
  return fields.length > 0 ? fields : null
}

/**
 * Apply a positional shelf (x or y) to the encoding map. Side effects: may
 * push a calculate transform into `transform`. The single-pill path is
 * byte-identical to the pre-multi-pill emit so existing specs are stable.
 */
function applyPositional(
  channel: "x" | "y",
  pills: ChannelPill[],
  encoding: Record<string, unknown>,
  transform: unknown[],
): void {
  if (pills.length === 0) {
    delete encoding[channel]
    return
  }
  if (pills.length === 1) {
    encoding[channel] = pillToEncoding(pills[0])
    return
  }
  // N pills: emit calc-concat if every pill is a dim. Otherwise — a mixed
  // shelf shouldn't be produced by the editor, but if hand-edited YAML
  // lands here, prefer the last pill (the user's most recent intent).
  if (pills.every(isDimPill)) {
    const asName = `${MULTI_DIM_AS_PREFIX}${channel}`
    transform.push({ calculate: buildJoinCalculate(pills), as: asName })
    const enc: Record<string, unknown> = {
      type: "nominal",
      field: asName,
      title: pills.map((p) => p.title ?? p.field).join(MULTI_DIM_JOIN_SEP),
    }
    const sort = pills[pills.length - 1].sort
    if (sort) enc.sort = sort
    encoding[channel] = enc
    return
  }
  encoding[channel] = pillToEncoding(pills[pills.length - 1])
}

/**
 * Build the body of a mark spec (mark + encoding + transform + params) from
 * the shelf state, optionally narrowing one positional shelf to a single
 * pill. Returns `{ body, perBodyTransforms }` so the caller can pull calc
 * transforms up to the outer concat spec or keep them inside each subspec.
 */
function buildSpecBody(
  state: ShelfState,
  override?: { axis: "x" | "y"; pills: ChannelPill[] },
): {
  mark: unknown
  encoding: Record<string, unknown>
  transform: unknown[]
  params: unknown[]
} {
  const encoding: Record<string, unknown> = { ...state.residual.encoding }
  const transform: unknown[] = []
  const xPills = override?.axis === "x" ? override.pills : state.x
  const yPills = override?.axis === "y" ? override.pills : state.y

  applyPositional("x", xPills, encoding, transform)
  applyPositional("y", yPills, encoding, transform)

  if (state.color) encoding.color = pillToEncoding(state.color)
  else delete encoding.color
  if (state.size) encoding.size = pillToEncoding(state.size)
  else delete encoding.size
  if (state.shape) encoding.shape = pillToEncoding(state.shape)
  else delete encoding.shape
  if (state.facet.column) encoding.column = pillToEncoding(state.facet.column)
  else delete encoding.column
  if (state.facet.row) encoding.row = pillToEncoding(state.facet.row)
  else delete encoding.row
  if (state.tooltip.length > 0) encoding.tooltip = state.tooltip.map(pillToEncoding)
  else delete encoding.tooltip

  const stack = state.mark.stack
  if ((state.mark.type === "bar" || state.mark.type === "area") && stack !== undefined) {
    const target = positionalAggregateAxis(xPills, yPills) ?? "y"
    const enc = encoding[target] as Record<string, unknown> | undefined
    if (enc) enc.stack = stack
  }

  for (const f of state.filters) transform.push(filterToTransform(f))
  for (const t of state.residual.transform) transform.push(t)

  return {
    mark: markToVega(state.mark),
    encoding,
    transform,
    params: state.residual.params.slice(),
  }
}

function positionalAggregateAxis(
  xPills: ChannelPill[],
  yPills: ChannelPill[],
): "x" | "y" | null {
  if (xPills.some((p) => p.aggregate)) return "x"
  if (yPills.some((p) => p.aggregate)) return "y"
  return null
}

/**
 * Decide whether a positional shelf is in panel mode (multi-measure ⇒
 * vconcat/hconcat). Pure single-pill and pure nested-dims stay flat.
 */
function inPanelMode(pills: ChannelPill[]): boolean {
  return pills.length >= 2 && pills.every(isMeasurePill)
}

export function specFromShelf(state: ShelfState): Record<string, unknown> {
  const xPanels = inPanelMode(state.x)
  const yPanels = inPanelMode(state.y)

  // Edge case — both axes are multi-measure. We pick rows (vconcat) so the
  // panels stack vertically; users who want a grid can hand-edit YAML.
  if (yPanels) {
    return buildConcatSpec(state, "vconcat", "y", state.y)
  }
  if (xPanels) {
    return buildConcatSpec(state, "hconcat", "x", state.x)
  }

  const body = buildSpecBody(state)
  const spec: Record<string, unknown> = {
    ...state.residual.other,
    mark: body.mark,
    encoding: body.encoding,
  }
  if (body.transform.length > 0) spec.transform = body.transform
  if (body.params.length > 0) spec.params = body.params
  if (!("$schema" in spec)) {
    spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json"
  }
  return spec
}

/**
 * Wrap the chart in vconcat/hconcat — one subspec per measure pill on the
 * target axis. Filters and other transforms are emitted once at the top
 * level so the data flows through them before splitting into panels.
 */
function buildConcatSpec(
  state: ShelfState,
  kind: "vconcat" | "hconcat",
  axis: "x" | "y",
  pills: ChannelPill[],
): Record<string, unknown> {
  // Per-subspec body. We strip top-level transforms out and put them into
  // the wrapper so they apply once.
  const subspecs = pills.map((p) => {
    const body = buildSpecBody(state, { axis, pills: [p] })
    const sub: Record<string, unknown> = { mark: body.mark, encoding: body.encoding }
    // Subspec params (e.g. selections) are duplicated per panel so each
    // panel is independently interactive — same as Vega-Lite docs example.
    if (body.params.length > 0) sub.params = body.params.map((q) => ({ ...(q as object) }))
    return sub
  })

  // Wrapper-level transforms = the shared transforms (filters + residual).
  // We use the FIRST subspec's transform list as the source — every subspec
  // has the same since they only differ on the target axis pill.
  const sharedTransform =
    pills.length > 0 ? buildSpecBody(state, { axis, pills: [pills[0]] }).transform : []

  const spec: Record<string, unknown> = {
    ...state.residual.other,
    [kind]: subspecs,
  }
  if (sharedTransform.length > 0) spec.transform = sharedTransform
  if (!("$schema" in spec)) {
    spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json"
  }
  return spec
}

// ── Vega-Lite spec → ShelfState ─────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parsePillFromEncoding(enc: unknown): ChannelPill | null {
  const o = asObject(enc)
  if (!o) return null
  const t = o.type
  const type: VegaType =
    t === "quantitative" || t === "temporal" || t === "ordinal" || t === "nominal"
      ? (t as VegaType)
      : "nominal"
  const field = typeof o.field === "string" ? o.field : ""
  const aggregate =
    typeof o.aggregate === "string" && AGGREGATE_OPS.includes(o.aggregate as AggregateOp)
      ? (o.aggregate as AggregateOp)
      : null
  if (!field && !aggregate) return null
  const pill: ChannelPill = { field, type }
  if (aggregate) pill.aggregate = aggregate
  if (type === "temporal" && typeof o.timeUnit === "string" && TIME_UNITS.includes(o.timeUnit as TimeUnit)) {
    pill.timeUnit = o.timeUnit as TimeUnit
  }
  if (type === "quantitative") {
    if (o.bin === true) pill.bin = true
    else if (typeof o.bin === "object" && o.bin) pill.bin = o.bin as { maxbins: number }
  }
  if (typeof o.sort === "string") pill.sort = o.sort as SortDir
  if (typeof o.title === "string") pill.title = o.title
  return pill
}

function parseTooltipPills(enc: unknown): ChannelPill[] {
  if (!enc) return []
  if (Array.isArray(enc)) {
    return enc.map((e) => parsePillFromEncoding(e)).filter((p): p is ChannelPill => p !== null)
  }
  const single = parsePillFromEncoding(enc)
  return single ? [single] : []
}

function parseMark(raw: unknown): MarkConfig {
  if (typeof raw === "string") {
    const t = raw as MarkType
    const known = MARK_TYPES.includes(t) ? t : "bar"
    return { type: known, stack: "zero" }
  }
  const o = asObject(raw)
  if (!o) return { type: "bar", stack: "zero" }
  const t = (o.type as MarkType) ?? "bar"
  const type = MARK_TYPES.includes(t) ? t : "bar"
  const m: MarkConfig = { type, stack: "zero" }
  if (type === "line" && o.point === true) m.point = true
  if (type === "point" && typeof o.filled === "boolean") m.filled = o.filled
  if (type === "area" && typeof o.opacity === "number") m.opacity = o.opacity
  return m
}

function parseFilterTransform(t: unknown): FilterPill | null {
  const o = asObject(t)
  if (!o || !("filter" in o)) return null
  const f = o.filter
  // Object form: { field, equal | range | oneOf | valid }
  const fo = asObject(f)
  if (fo) {
    const field = typeof fo.field === "string" ? fo.field : null
    if (!field) return null
    if ("equal" in fo)
      return { field, type: "nominal", op: "eq", value: fo.equal as unknown }
    if ("oneOf" in fo && Array.isArray(fo.oneOf))
      return { field, type: "nominal", op: "in", values: fo.oneOf as unknown[] }
    if ("range" in fo && Array.isArray(fo.range)) {
      const r = fo.range as unknown[]
      const lo = r[0]
      const hi = r[1]
      if (lo == null && hi != null) return { field, type: "quantitative", op: "lt", value: hi }
      if (lo != null && hi == null) return { field, type: "quantitative", op: "gt", value: lo }
      return { field, type: "quantitative", op: "between", values: [lo, hi] }
    }
    if ("valid" in fo && fo.valid === true) return { field, type: "nominal", op: "non-null" }
  }
  // String predicate — punt for v1 (kept in residual).
  return null
}

/**
 * Try to parse a multi-pill x/y encoding. If the encoding points at our
 * synthetic `__shelf_<channel>` field AND a matching calculate transform
 * is present, returns the parsed pills plus the transform that should be
 * consumed (i.e. not echoed into residual).
 */
function tryParseMultiPositional(
  channel: "x" | "y",
  encVal: unknown,
  transforms: unknown[],
): { pills: ChannelPill[]; consumed: unknown | null } | null {
  const o = asObject(encVal)
  const expected = `${MULTI_DIM_AS_PREFIX}${channel}`
  if (!o || o.field !== expected) return null
  for (const t of transforms) {
    const to = asObject(t)
    if (!to) continue
    if (to.as !== expected) continue
    if (typeof to.calculate !== "string") continue
    const fields = parseJoinCalculate(to.calculate)
    if (!fields) continue
    const pills: ChannelPill[] = fields.map((f) => ({
      field: f,
      type: "nominal" as VegaType,
    }))
    if (typeof o.sort === "string") {
      pills[pills.length - 1].sort = o.sort as SortDir
    }
    return { pills, consumed: t }
  }
  return null
}

/**
 * Parse a single mark spec (no concat) into the channel/encoding parts of
 * ShelfState. The caller assembles the rest (residual.other and concat
 * detection).
 */
function parseMarkSpecBody(
  state: ShelfState,
  spec: Record<string, unknown>,
): void {
  if ("mark" in spec) state.mark = parseMark(spec.mark)

  const enc = asObject(spec.encoding) ?? {}
  const transforms = Array.isArray(spec.transform) ? spec.transform : []
  const consumedTransforms = new Set<unknown>()

  if ("x" in enc) {
    const multi = tryParseMultiPositional("x", enc.x, transforms)
    if (multi) {
      state.x = multi.pills
      if (multi.consumed) consumedTransforms.add(multi.consumed)
    } else {
      const p = parsePillFromEncoding(enc.x)
      state.x = p ? [p] : []
    }
  }
  if ("y" in enc) {
    const multi = tryParseMultiPositional("y", enc.y, transforms)
    if (multi) {
      state.y = multi.pills
      if (multi.consumed) consumedTransforms.add(multi.consumed)
    } else {
      const p = parsePillFromEncoding(enc.y)
      state.y = p ? [p] : []
    }
  }
  if ("color" in enc) state.color = parsePillFromEncoding(enc.color)
  if ("size" in enc) state.size = parsePillFromEncoding(enc.size)
  if ("shape" in enc) state.shape = parsePillFromEncoding(enc.shape)
  if ("column" in enc) state.facet.column = parsePillFromEncoding(enc.column)
  if ("row" in enc) state.facet.row = parsePillFromEncoding(enc.row)
  if ("tooltip" in enc) state.tooltip = parseTooltipPills(enc.tooltip)

  for (const ch of ["x", "y"] as const) {
    const o = asObject(enc[ch])
    if (o && "stack" in o) {
      const s = o.stack
      if (s === "normalize" || s === "zero" || s === "center" || s === null) {
        state.mark.stack = s
      }
    }
  }

  const residualEncoding: Record<string, unknown> = { ...state.residual.encoding }
  for (const [k, v] of Object.entries(enc)) {
    if (!MANAGED_CHANNELS.includes(k as ShelfChannel)) residualEncoding[k] = v
  }
  state.residual.encoding = residualEncoding

  for (const t of transforms) {
    if (consumedTransforms.has(t)) continue
    const f = parseFilterTransform(t)
    if (f) state.filters.push(f)
    else state.residual.transform.push(t)
  }

  if (Array.isArray(spec.params)) {
    state.residual.params = [...state.residual.params, ...spec.params]
  }
}

/**
 * Detect a uniform concat spec produced by the editor (or close to it) and
 * fold it back into a multi-pill positional shelf. "Uniform" = every subspec
 * has the same mark and the same encoding except for the target channel.
 * If the subspecs don't line up, we keep the whole concat in `residual.other`
 * so the YAML round-trips intact (the editor cannot recover the pills).
 */
function tryParseConcat(
  spec: Record<string, unknown>,
): { state: ShelfState; usedKey: "vconcat" | "hconcat" } | null {
  const kind: "vconcat" | "hconcat" | null = Array.isArray(spec.vconcat)
    ? "vconcat"
    : Array.isArray(spec.hconcat)
      ? "hconcat"
      : null
  if (!kind) return null
  const subs = (spec[kind] as unknown[]).filter(
    (s): s is Record<string, unknown> => s !== null && typeof s === "object",
  )
  if (subs.length < 2) return null
  const axis: "x" | "y" = kind === "vconcat" ? "y" : "x"

  // Parse each subspec into a temporary state, then check uniformity.
  const subStates = subs.map((sub) => {
    const s = emptyShelfState()
    parseMarkSpecBody(s, sub)
    return s
  })

  // Uniformity check — every subspec's body must match the first except on
  // the target positional channel. We don't deep-compare residuals; the
  // generated specs are deterministic.
  const ref = subStates[0]
  for (let i = 1; i < subStates.length; i++) {
    const s = subStates[i]
    if (JSON.stringify(s.mark) !== JSON.stringify(ref.mark)) return null
    if (JSON.stringify(s.color) !== JSON.stringify(ref.color)) return null
    if (JSON.stringify(s.size) !== JSON.stringify(ref.size)) return null
    if (JSON.stringify(s.shape) !== JSON.stringify(ref.shape)) return null
    if (JSON.stringify(s.facet) !== JSON.stringify(ref.facet)) return null
    if (JSON.stringify(s.tooltip) !== JSON.stringify(ref.tooltip)) return null
    if (axis === "y") {
      if (JSON.stringify(s.x) !== JSON.stringify(ref.x)) return null
    } else {
      if (JSON.stringify(s.y) !== JSON.stringify(ref.y)) return null
    }
  }

  // Assemble the merged state from the reference, then accumulate the pills.
  const out = emptyShelfState()
  out.mark = ref.mark
  out.color = ref.color
  out.size = ref.size
  out.shape = ref.shape
  out.facet = ref.facet
  out.tooltip = ref.tooltip
  out.x = axis === "y" ? ref.x : []
  out.y = axis === "x" ? ref.y : []
  out.residual.encoding = ref.residual.encoding
  out.residual.params = ref.residual.params
  // Note: per-subspec residual.transform we drop here — wrapper transform
  // is the source of truth.

  for (const s of subStates) {
    const pill = axis === "y" ? s.y[0] : s.x[0]
    if (!pill) return null
    if (axis === "y") out.y.push(pill)
    else out.x.push(pill)
  }

  return { state: out, usedKey: kind }
}

/**
 * Parse a Vega-Lite spec into ShelfState. Anything the editor can't
 * round-trip (unknown channels, opaque transforms, params) is preserved
 * in `residual` so re-emitting matches the original byte-for-byte for
 * those parts.
 */
export function shelfFromSpec(
  spec: Record<string, unknown> | null,
): ShelfState {
  if (!spec) return emptyShelfState()

  const concat = tryParseConcat(spec)
  if (concat) {
    // Filters/transforms live on the wrapper; parse them once.
    if (Array.isArray(spec.transform)) {
      for (const t of spec.transform) {
        const f = parseFilterTransform(t)
        if (f) concat.state.filters.push(f)
        else concat.state.residual.transform.push(t)
      }
    }
    if (Array.isArray(spec.params)) {
      concat.state.residual.params = [
        ...concat.state.residual.params,
        ...spec.params,
      ]
    }
    // Other top-level keys (skip the consumed concat array + the things
    // ChartView injects at render time + everything we already parsed).
    const other: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(spec)) {
      if (k === concat.usedKey) continue
      if (k === "mark" || k === "encoding" || k === "transform" || k === "params") continue
      if (k === "data" || k === "width" || k === "height" || k === "autosize" || k === "config") continue
      other[k] = v
    }
    concat.state.residual.other = other
    return concat.state
  }

  const state = emptyShelfState()
  parseMarkSpecBody(state, spec)

  const other: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec)) {
    if (k === "mark" || k === "encoding" || k === "transform" || k === "params") continue
    if (k === "data" || k === "width" || k === "height" || k === "autosize" || k === "config") continue
    other[k] = v
  }
  state.residual.other = other

  return state
}

// ── Display helpers ─────────────────────────────────────────────────

/** Compact pill caption: "SUM(amount)" / "YEAR(date)" / "amount" / "Count". */
export function pillCaption(p: ChannelPill): string {
  if (p.aggregate === "count" && !p.field) return "Count"
  if (p.aggregate && p.aggregate !== "count") {
    return `${p.aggregate.toUpperCase()}(${p.field})`
  }
  if (p.type === "temporal" && p.timeUnit) {
    return `${p.timeUnit.toUpperCase()}(${p.field})`
  }
  if (p.bin) return `BIN(${p.field})`
  return p.field || "—"
}

/** Compact filter caption: "status = active" / "ts > 2024-01-01" / "name in (a,b,c)". */
export function filterCaption(f: FilterPill): string {
  switch (f.op) {
    case "eq":
      return `${f.field} = ${fmtVal(f.value)}`
    case "neq":
      return `${f.field} ≠ ${fmtVal(f.value)}`
    case "gt":
      return `${f.field} > ${fmtVal(f.value)}`
    case "lt":
      return `${f.field} < ${fmtVal(f.value)}`
    case "gte":
      return `${f.field} ≥ ${fmtVal(f.value)}`
    case "lte":
      return `${f.field} ≤ ${fmtVal(f.value)}`
    case "in":
      return `${f.field} in (${(f.values ?? []).slice(0, 3).map(fmtVal).join(", ")}${
        (f.values ?? []).length > 3 ? ", …" : ""
      })`
    case "between": {
      const [lo, hi] = f.values ?? []
      return `${f.field} ∈ [${fmtVal(lo)}, ${fmtVal(hi)}]`
    }
    case "non-null":
      return `${f.field} is not null`
  }
}

function fmtVal(v: unknown): string {
  if (v == null) return "null"
  if (typeof v === "string") return v.length > 18 ? `${v.slice(0, 17)}…` : v
  return String(v)
}

/**
 * Reduce a multi-pill positional shelf to a single representative type for
 * mark-suggestion purposes. With ≥2 dim pills the synthetic axis is
 * effectively nominal; otherwise use the lone pill's type.
 */
function dominantType(pills: ChannelPill[]): VegaType | null {
  if (pills.length === 0) return null
  if (pills.length >= 2 && pills.every(isDimPill)) return "nominal"
  return pills[pills.length - 1].type
}

/** Best valid mark types for the current pill assignment. */
export function suggestedMarks(state: ShelfState): MarkType[] {
  const xType = dominantType(state.x)
  const yType = dominantType(state.y)
  if (xType === "quantitative" && !yType) return ["bar", "tick", "point"]
  if (xType === "temporal" && yType === "quantitative") return ["line", "area", "bar", "point"]
  if (yType === "temporal" && xType === "quantitative") return ["line", "area", "bar", "point"]
  if (xType === "quantitative" && yType === "quantitative") return ["point", "rect"]
  if ((xType === "nominal" || xType === "ordinal") && yType === "quantitative")
    return ["bar", "point", "tick", "boxplot"]
  if ((yType === "nominal" || yType === "ordinal") && xType === "quantitative")
    return ["bar", "point", "tick", "boxplot"]
  return MARK_TYPES
}
