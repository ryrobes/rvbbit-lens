/**
 * Auto-spec inference for the Chart tab.
 *
 * Given the columns + rows of a QueryResult, pick a sensible default
 * Vega-Lite spec. Deliberately dumb — no semantic intent, no fancy
 * heuristics. The spec edit pane is the escape hatch for everything
 * the inference misses.
 *
 * Rules (in priority order):
 *   1 numeric + 1 temporal              → line
 *   1 numeric + 1 categorical           → bar  (x=cat, y=sum(num))
 *   2 numeric                            → scatter (point)
 *   1 numeric only                       → histogram (binned bar)
 *   1 categorical only                   → bar of counts
 *   N>=3 cols with usable shape          → first numeric as y, first
 *                                           temporal/categorical as x,
 *                                           next categorical as color
 *   anything else                        → null (empty state)
 *
 * Categorical encodings get an opportunistic top-30 limit at infer
 * time so a column with thousands of distinct values doesn't render
 * an unreadable chart by default.
 */

import type { QueryResultColumn } from "@/lib/db/types"

export type ColumnRole = "numeric" | "temporal" | "categorical" | "boolean" | "unknown"

export type ChartMarkType = "bar" | "line" | "point" | "histogram" | "bar-counts"

export interface InferResult {
  spec: Record<string, unknown>
  markType: ChartMarkType
  /** Field used on the x axis (or for histogram, the binned field). Drives selection wiring. */
  xField: string
  /** Field used on the y axis when applicable. */
  yField?: string
  /** Whether the spec already includes a point-selection param. */
  selectable: boolean
}

// Postgres dataTypeId OIDs we care about. Keeping the list narrow on
// purpose — the dataTypeName fallback below covers the rest.
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700, 790])
const TEMPORAL_OIDS = new Set([1082, 1083, 1114, 1184, 1266])
const BOOLEAN_OIDS = new Set([16])

export function classifyColumn(col: QueryResultColumn): ColumnRole {
  if (NUMERIC_OIDS.has(col.dataTypeId)) return "numeric"
  if (TEMPORAL_OIDS.has(col.dataTypeId)) return "temporal"
  if (BOOLEAN_OIDS.has(col.dataTypeId)) return "boolean"
  const name = (col.dataTypeName ?? "").toLowerCase()
  if (!name) return "unknown"
  if (
    name.includes("int") ||
    name === "numeric" ||
    name.includes("float") ||
    name === "real" ||
    name === "double" ||
    name === "money"
  )
    return "numeric"
  if (name.includes("timestamp") || name === "date" || name === "time" || name === "timetz") return "temporal"
  if (name === "bool" || name === "boolean") return "boolean"
  return "categorical"
}

interface RoleSlot {
  col: QueryResultColumn
  role: ColumnRole
}

function classifyAll(columns: QueryResultColumn[]): RoleSlot[] {
  return columns.map((col) => ({ col, role: classifyColumn(col) }))
}

function first(slots: RoleSlot[], role: ColumnRole): RoleSlot | undefined {
  return slots.find((s) => s.role === role)
}

function vegaType(role: ColumnRole): "quantitative" | "temporal" | "nominal" | "ordinal" {
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

/**
 * Selection block. Single point select, keyed on the x field so the
 * signal payload comes back as `{ [xField]: [value] }` — easy to
 * forward to the desktop's param-emit flow.
 */
function pointSelectionParams(field: string): Record<string, unknown>[] {
  return [
    {
      name: "click",
      // toggle: "true" (the STRING vega expression, NOT boolean true which only
      // toggles on shift-click) → EVERY plain click adds/removes a mark, so
      // re-clicking a selected mark de-selects it (and clears its param).
      select: { type: "point", fields: [field], toggle: "true" },
    },
  ]
}

/**
 * Highlight opacity tied to the selection — selected mark stays full
 * opacity, unselected dims. Gives the click visible feedback even
 * though we don't move the chart.
 */
function selectionOpacity() {
  return {
    condition: { param: "click", value: 1, empty: true },
    value: 0.35,
  }
}

export function inferChartSpec(
  columns: QueryResultColumn[],
  rows: Record<string, unknown>[],
): InferResult | null {
  if (columns.length === 0 || rows.length === 0) return null

  const slots = classifyAll(columns)
  const numeric = first(slots, "numeric")
  const temporal = first(slots, "temporal")
  const categorical =
    first(slots, "categorical") ?? first(slots, "boolean") ?? first(slots, "unknown")
  const secondCategorical = slots.filter(
    (s) => s !== categorical && (s.role === "categorical" || s.role === "boolean"),
  )[0]

  // 1 numeric + 1 temporal → line
  if (numeric && temporal) {
    const xField = temporal.col.name
    const yField = numeric.col.name
    return {
      markType: "line",
      xField,
      yField,
      selectable: true,
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        mark: { type: "line", point: true, interpolate: "monotone" },
        params: pointSelectionParams(xField),
        encoding: {
          x: { field: xField, type: "temporal" },
          y: { field: yField, type: "quantitative", aggregate: "sum" },
          ...(secondCategorical
            ? { color: { field: secondCategorical.col.name, type: "nominal" } }
            : {}),
          opacity: selectionOpacity(),
          tooltip: [
            { field: xField, type: "temporal" },
            { field: yField, type: "quantitative", aggregate: "sum" },
            ...(secondCategorical ? [{ field: secondCategorical.col.name, type: "nominal" as const }] : []),
          ],
        },
      },
    }
  }

  // 1 numeric + 1 categorical → bar
  if (numeric && categorical) {
    const xField = categorical.col.name
    const yField = numeric.col.name
    const colorField = secondCategorical?.col.name
    // Pre-aggregate to sum(y) per category FIRST, then rank categories and keep
    // the top 30 (mirrors the bar-counts path). The old code summed with a WINDOW
    // — a *running* sum (default cumulative frame) — and ranked rows, not
    // categories, so raw un-aggregated input produced a couple of undercounted
    // bars. When a color split is present we aggregate per (category, color) and
    // skip the cap: collapsing to one row per category would lose the breakdown.
    const transform = colorField
      ? [{ aggregate: [{ op: "sum" as const, field: yField, as: "__agg" }], groupby: [xField, colorField] }]
      : [
          { aggregate: [{ op: "sum" as const, field: yField, as: "__agg" }], groupby: [xField] },
          { window: [{ op: "row_number" as const, as: "__rank" }], sort: [{ field: "__agg", order: "descending" as const }] },
          { filter: "datum.__rank <= 30" },
        ]
    return {
      markType: "bar",
      xField,
      yField,
      selectable: true,
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        mark: { type: "bar" },
        params: pointSelectionParams(xField),
        transform,
        encoding: {
          // y is the pre-summed __agg, so no encoding-level aggregate (that would
          // double-aggregate); title keeps the axis readable.
          x: { field: xField, type: vegaType(categorical.role), sort: "-y" },
          y: { field: "__agg", type: "quantitative", title: yField },
          ...(colorField ? { color: { field: colorField, type: "nominal" } } : {}),
          opacity: selectionOpacity(),
          tooltip: [
            { field: xField, type: vegaType(categorical.role) },
            { field: "__agg", type: "quantitative", title: yField },
            ...(colorField ? [{ field: colorField, type: "nominal" as const }] : []),
          ],
        },
      },
    }
  }

  // 2 numeric → scatter
  const numerics = slots.filter((s) => s.role === "numeric")
  if (numerics.length >= 2) {
    const xField = numerics[0].col.name
    const yField = numerics[1].col.name
    return {
      markType: "point",
      xField,
      yField,
      selectable: true,
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        mark: { type: "point", filled: true, size: 60 },
        params: pointSelectionParams(xField),
        encoding: {
          x: { field: xField, type: "quantitative" },
          y: { field: yField, type: "quantitative" },
          ...(categorical
            ? { color: { field: categorical.col.name, type: "nominal" } }
            : {}),
          opacity: selectionOpacity(),
          tooltip: slots.slice(0, 4).map((s) => ({ field: s.col.name, type: vegaType(s.role) })),
        },
      },
    }
  }

  // 1 numeric only → histogram
  if (numeric && !categorical && !temporal) {
    const xField = numeric.col.name
    return {
      markType: "histogram",
      xField,
      selectable: false,
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        mark: { type: "bar" },
        encoding: {
          x: { field: xField, type: "quantitative", bin: { maxbins: 30 } },
          y: { aggregate: "count", type: "quantitative" },
          tooltip: [
            { field: xField, type: "quantitative", bin: { maxbins: 30 } },
            { aggregate: "count", type: "quantitative" },
          ],
        },
      },
    }
  }

  // 1 categorical only → bar of counts
  if (categorical) {
    const xField = categorical.col.name
    return {
      markType: "bar-counts",
      xField,
      selectable: true,
      spec: {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        mark: { type: "bar" },
        params: pointSelectionParams(xField),
        transform: [
          {
            aggregate: [{ op: "count", as: "__count" }],
            groupby: [xField],
          },
          {
            window: [{ op: "row_number", as: "__rank" }],
            sort: [{ field: "__count", order: "descending" }],
          },
          { filter: "datum.__rank <= 30" },
        ],
        encoding: {
          x: { field: xField, type: vegaType(categorical.role), sort: "-y" },
          y: { field: "__count", type: "quantitative" },
          opacity: selectionOpacity(),
          tooltip: [
            { field: xField, type: vegaType(categorical.role) },
            { field: "__count", type: "quantitative", title: "count" },
          ],
        },
      },
    }
  }

  return null
}

/**
 * Build the schema comment string for the spec editor — gives the
 * reader (human or AI) immediate context for what fields are
 * available without having to scan the data.
 */
export function schemaComment(columns: QueryResultColumn[], rowCount: number): string {
  const lines = ["# Result schema (paste this with the spec when asking an LLM for help):"]
  for (const col of columns) {
    const role = classifyColumn(col)
    const ty = col.dataTypeName ?? `oid:${col.dataTypeId}`
    lines.push(`#   ${col.name}  (${ty}, ${role})`)
  }
  lines.push(`# ${rowCount} row${rowCount === 1 ? "" : "s"}`)
  lines.push("")
  return lines.join("\n")
}
