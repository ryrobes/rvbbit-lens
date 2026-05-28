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

export interface ShelfState {
  mark: MarkConfig
  x: ChannelPill | null
  y: ChannelPill | null
  color: ChannelPill | null
  size: ChannelPill | null
  shape: ChannelPill | null
  tooltip: ChannelPill[]
  filters: FilterPill[]
  residual: ResidualBag
}

export type ShelfChannel = "x" | "y" | "color" | "size" | "shape" | "tooltip"

/** Channels the editor manages — emitted to spec.encoding[channel]. */
export const MANAGED_CHANNELS: ShelfChannel[] = ["x", "y", "color", "size", "shape", "tooltip"]

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
    x: null,
    y: null,
    color: null,
    size: null,
    shape: null,
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

export function specFromShelf(state: ShelfState): Record<string, unknown> {
  const encoding: Record<string, unknown> = { ...state.residual.encoding }
  if (state.x) encoding.x = pillToEncoding(state.x)
  else delete encoding.x
  if (state.y) encoding.y = pillToEncoding(state.y)
  else delete encoding.y
  if (state.color) encoding.color = pillToEncoding(state.color)
  else delete encoding.color
  if (state.size) encoding.size = pillToEncoding(state.size)
  else delete encoding.size
  if (state.shape) encoding.shape = pillToEncoding(state.shape)
  else delete encoding.shape
  if (state.tooltip.length > 0) encoding.tooltip = state.tooltip.map(pillToEncoding)
  else delete encoding.tooltip

  // Stack — applied to x or y depending on mark+orientation. The vega-lite
  // convention is to put `stack` on the *quantitative* axis. We choose the
  // axis whose pill has an aggregate; if neither, fall back to y.
  const stack = state.mark.stack
  if (stack != null && (state.mark.type === "bar" || state.mark.type === "area")) {
    const target = aggregateAxis(state) ?? "y"
    const enc = encoding[target] as Record<string, unknown> | undefined
    if (enc) enc.stack = stack === null ? null : stack
  } else if (stack === null && (state.mark.type === "bar" || state.mark.type === "area")) {
    const target = aggregateAxis(state) ?? "y"
    const enc = encoding[target] as Record<string, unknown> | undefined
    if (enc) enc.stack = null
  }

  const transform: unknown[] = []
  for (const f of state.filters) transform.push(filterToTransform(f))
  for (const t of state.residual.transform) transform.push(t)

  const spec: Record<string, unknown> = {
    ...state.residual.other,
    mark: markToVega(state.mark),
    encoding,
  }
  if (transform.length > 0) spec.transform = transform
  if (state.residual.params.length > 0) spec.params = state.residual.params
  // Ensure schema is present for hand-edit friendliness.
  if (!("$schema" in spec)) {
    spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json"
  }
  return spec
}

function aggregateAxis(state: ShelfState): "x" | "y" | null {
  if (state.x?.aggregate) return "x"
  if (state.y?.aggregate) return "y"
  return null
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
 * Parse a Vega-Lite spec into ShelfState. Anything the editor can't
 * round-trip (unknown channels, opaque transforms, params) is preserved
 * in `residual` so re-emitting matches the original byte-for-byte for
 * those parts.
 */
export function shelfFromSpec(
  spec: Record<string, unknown> | null,
): ShelfState {
  const state = emptyShelfState()
  if (!spec) return state

  // Mark
  if ("mark" in spec) state.mark = parseMark(spec.mark)

  // Encoding
  const enc = asObject(spec.encoding) ?? {}
  if ("x" in enc) state.x = parsePillFromEncoding(enc.x)
  if ("y" in enc) state.y = parsePillFromEncoding(enc.y)
  if ("color" in enc) state.color = parsePillFromEncoding(enc.color)
  if ("size" in enc) state.size = parsePillFromEncoding(enc.size)
  if ("shape" in enc) state.shape = parsePillFromEncoding(enc.shape)
  if ("tooltip" in enc) state.tooltip = parseTooltipPills(enc.tooltip)

  // Stack from x/y encoding
  for (const ch of ["x", "y"] as const) {
    const o = asObject(enc[ch])
    if (o && "stack" in o) {
      const s = o.stack
      if (s === "normalize" || s === "zero" || s === "center" || s === null) {
        state.mark.stack = s
      }
    }
  }

  // Residual encoding — unknown channels
  const residualEncoding: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(enc)) {
    if (!MANAGED_CHANNELS.includes(k as ShelfChannel)) residualEncoding[k] = v
  }
  state.residual.encoding = residualEncoding

  // Filters + residual transforms
  if (Array.isArray(spec.transform)) {
    for (const t of spec.transform) {
      const f = parseFilterTransform(t)
      if (f) state.filters.push(f)
      else state.residual.transform.push(t)
    }
  }

  // Params
  if (Array.isArray(spec.params)) state.residual.params = [...spec.params]

  // Other top-level keys
  const other: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec)) {
    if (k === "mark" || k === "encoding" || k === "transform" || k === "params") continue
    if (k === "data" || k === "width" || k === "height" || k === "autosize" || k === "config")
      continue // chart-view applies these
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

/** Best valid mark types for the current pill assignment. */
export function suggestedMarks(state: ShelfState): MarkType[] {
  const xType = state.x?.type ?? null
  const yType = state.y?.type ?? null
  // 1-D: histogram-ish → bar+bin; categorical bar of counts.
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
