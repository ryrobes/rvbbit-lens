import type { ChartAssemblyInput, ChartEncoding } from "flint-chart"
import type { QueryResultColumn } from "@/lib/db/types"
import type { ChartRendererKind } from "./types"
import { classifyColumn } from "./chart-infer"

export const DEFAULT_CHART_RENDERER: ChartRendererKind = "vega-lite"

export const CHART_RENDERER_OPTIONS: { id: ChartRendererKind; label: string; shortLabel: string }[] = [
  { id: "vega-lite", label: "Vega-Lite", shortLabel: "Vega" },
  { id: "flint-vega-lite", label: "Flint Vega-Lite", shortLabel: "Flint" },
  { id: "flint-echarts", label: "Flint ECharts", shortLabel: "ECharts" },
  { id: "flint-chartjs", label: "Flint Chart.js", shortLabel: "Chart.js" },
]

export interface FlintChartBuild {
  input: ChartAssemblyInput
  xField: string
}

type VegaEncoding = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function vegaEncodingField(spec: Record<string, unknown> | null | undefined, channel: string): string {
  const encoding = spec?.encoding
  if (!isRecord(encoding)) return ""
  const channelDef = encoding[channel]
  if (!isRecord(channelDef)) return ""
  const field = channelDef.field
  return typeof field === "string" ? field : ""
}

function encodingForChannel(spec: Record<string, unknown>, channel: string): VegaEncoding | null {
  const encoding = spec.encoding
  if (!isRecord(encoding)) return null
  const channelDef = encoding[channel]
  return isRecord(channelDef) ? channelDef : null
}

function vegaMarkType(spec: Record<string, unknown>): string {
  const mark = spec.mark
  if (typeof mark === "string") return mark
  if (isRecord(mark) && typeof mark.type === "string") return mark.type
  return ""
}

function vegaType(value: unknown): ChartEncoding["type"] | undefined {
  return value === "quantitative" || value === "nominal" || value === "ordinal" || value === "temporal"
    ? value
    : undefined
}

function vegaAggregate(value: unknown): ChartEncoding["aggregate"] | undefined {
  if (value === "sum" || value === "count" || value === "mean") return value
  if (value === "average") return "average"
  return undefined
}

function sortOrder(value: unknown): ChartEncoding["sortOrder"] | undefined {
  if (value === "ascending" || value === "y" || value === "x") return "ascending"
  if (value === "descending" || value === "-y" || value === "-x") return "descending"
  return undefined
}

function fieldExists(columns: QueryResultColumn[], field: string): boolean {
  return columns.some((column) => column.name === field)
}

function hasCountTransform(spec: Record<string, unknown>, asField: string): boolean {
  const transforms = spec.transform
  if (!Array.isArray(transforms)) return false
  return transforms.some((transform) => {
    if (!isRecord(transform)) return false
    const aggregate = transform.aggregate
    return Array.isArray(aggregate) && aggregate.some((agg) => {
      if (!isRecord(agg)) return false
      return agg.op === "count" && agg.as === asField
    })
  })
}

function flintEncoding(
  channelDef: VegaEncoding | null,
  columns: QueryResultColumn[],
  spec: Record<string, unknown>,
): ChartEncoding | null {
  if (!channelDef) return null
  const field = typeof channelDef.field === "string" ? channelDef.field : ""
  const aggregate = vegaAggregate(channelDef.aggregate)
  if (!field && aggregate !== "count") return null

  const encoded: ChartEncoding = {}
  if (field && fieldExists(columns, field)) encoded.field = field
  else if (field && hasCountTransform(spec, field)) encoded.aggregate = "count"
  else if (field) return null

  const type = vegaType(channelDef.type)
  if (type) encoded.type = type
  if (aggregate) encoded.aggregate = aggregate
  const order = sortOrder(channelDef.sort)
  if (order) encoded.sortOrder = order
  return encoded
}

function chartTypeForSpec(spec: Record<string, unknown>, encodings: Record<string, ChartEncoding>): string | null {
  if ("vconcat" in spec || "hconcat" in spec || "layer" in spec || "facet" in spec) return null
  const mark = vegaMarkType(spec)
  const x = encodingForChannel(spec, "x")
  const y = encodingForChannel(spec, "y")
  const color = encodings.color
  const xIsBinned = isRecord(x) && !!x.bin

  if (mark === "rect") return "Heatmap"
  if (xIsBinned || (mark === "bar" && encodings.y?.aggregate === "count" && encodings.x?.type === "quantitative")) {
    return "Histogram"
  }
  if (mark === "line") return "Line Chart"
  if (mark === "area") return "Area Chart"
  if (mark === "point" || mark === "circle" || mark === "tick") return "Scatter Plot"
  if (mark === "bar" || !mark) {
    const stack = isRecord(y) ? y.stack : undefined
    if (color && stack === null) return "Grouped Bar Chart"
    if (color) return "Stacked Bar Chart"
    return "Bar Chart"
  }
  return null
}

function semanticTypeForColumn(column: QueryResultColumn): string {
  const role = classifyColumn(column)
  const name = column.name.toLowerCase()
  if (role === "temporal") {
    const typeName = (column.dataTypeName ?? "").toLowerCase()
    return typeName === "date" ? "Date" : "DateTime"
  }
  if (role === "numeric") {
    if (name.includes("percent") || name.includes("pct") || name.includes("rate") || name.includes("ratio")) return "Percentage"
    if (name.includes("count") || name.endsWith("_n") || name === "n") return "Count"
    if (name.includes("amount") || name.includes("revenue") || name.includes("sales") || name.includes("spend") || name.includes("cost") || name.includes("price")) return "Amount"
    if (name.endsWith("id") || name.endsWith("_id")) return "ID"
    return "Quantity"
  }
  if (role === "boolean") return "Boolean"
  if (name.includes("country")) return "Country"
  if (name.includes("state")) return "State"
  if (name.includes("city")) return "City"
  if (name.includes("region")) return "Region"
  if (name.endsWith("id") || name.endsWith("_id")) return "ID"
  if (name.includes("status") || name.includes("stage")) return "Status"
  return "Category"
}

export function buildFlintChartInput({
  spec,
  columns,
  rows,
  canvasSize,
}: {
  spec: Record<string, unknown> | null
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  canvasSize?: { width: number; height: number } | null
}): FlintChartBuild | null {
  if (!spec || rows.length === 0) return null
  const encodings: Record<string, ChartEncoding> = {}
  for (const channel of ["x", "y", "color", "size", "shape", "column", "row"] as const) {
    const encoded = flintEncoding(encodingForChannel(spec, channel), columns, spec)
    if (encoded) encodings[channel] = encoded
  }
  const xField = encodings.x?.field ?? vegaEncodingField(spec, "x")
  if (!xField || !encodings.x) return null

  const chartType = chartTypeForSpec(spec, encodings)
  if (!chartType) return null

  const semanticTypes = Object.fromEntries(columns.map((column) => [column.name, semanticTypeForColumn(column)]))
  const width = Math.max(320, Math.round(canvasSize?.width ?? 720))
  const height = Math.max(240, Math.round(canvasSize?.height ?? 420))
  return {
    xField,
    input: {
      data: { values: rows },
      semantic_types: semanticTypes,
      chart_spec: {
        chartType,
        encodings,
        baseSize: { width, height },
        canvasSize: { width, height },
      },
      options: {
        addTooltips: true,
        maxStretch: 1,
      },
      field_display_names: Object.fromEntries(columns.map((column) => [column.name, column.name])),
    },
  }
}
