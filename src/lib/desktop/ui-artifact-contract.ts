export const UI_ARTIFACT_KIND = {
  META: "meta",
} as const

export const UI_RENDERER = {
  ACTION_BUTTON: "action_button",
  BASIC_CHART: "basic_chart",
  FILTER_BINDING: "filter_binding",
  FILTER_CONTROL: "filter_control",
  KPI_GAUGE: "kpi_gauge",
  KPI_TIMELINE: "kpi_timeline",
  METRIC_CARD: "metric_card",
  SPARKLINE: "sparkline",
  STATEMENT_LAYOUT: "statement_layout",
  STATEMENT_NAME: "statement_name",
  TABLE_VIEW: "table_view",
  VEGA_LITE: "vega_lite",
} as const

export const UI_VISIBLE_RENDERERS = [
  UI_RENDERER.ACTION_BUTTON,
  UI_RENDERER.BASIC_CHART,
  UI_RENDERER.FILTER_CONTROL,
  UI_RENDERER.KPI_GAUGE,
  UI_RENDERER.KPI_TIMELINE,
  UI_RENDERER.METRIC_CARD,
  UI_RENDERER.SPARKLINE,
  UI_RENDERER.TABLE_VIEW,
  UI_RENDERER.VEGA_LITE,
] as const

export const UI_META_RENDERERS = [
  UI_RENDERER.FILTER_BINDING,
  UI_RENDERER.STATEMENT_LAYOUT,
  UI_RENDERER.STATEMENT_NAME,
] as const

export const UI_BASIC_CHART_KINDS = [
  "area",
  "bar",
  "heatmap",
  "histogram",
  "line",
  "point",
  "rect",
  "scatter",
] as const

export const UI_CONTROL_KINDS = ["datepicker", "dropdown", "multiselect", "slider"] as const

export const UI_FILTER_OPERATORS = ["eq", "gte", "in", "lte"] as const

export const UI_FILTER_SOURCE_CTE = "rvbbit_filter_source"

export type UiArtifactRenderer = (typeof UI_VISIBLE_RENDERERS)[number] | (typeof UI_META_RENDERERS)[number]
export type UiBasicChartKind = (typeof UI_BASIC_CHART_KINDS)[number]
export type UiControlKind = (typeof UI_CONTROL_KINDS)[number]
export type UiFilterOperator = (typeof UI_FILTER_OPERATORS)[number]

export function isUiBasicChartKind(value: string): value is UiBasicChartKind {
  return (UI_BASIC_CHART_KINDS as readonly string[]).includes(value)
}

export function isUiControlKind(value: string): value is UiControlKind {
  return (UI_CONTROL_KINDS as readonly string[]).includes(value)
}

export function isUiFilterOperator(value: string): value is UiFilterOperator {
  return (UI_FILTER_OPERATORS as readonly string[]).includes(value)
}
