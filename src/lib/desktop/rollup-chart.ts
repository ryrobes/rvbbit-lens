/**
 * Bridge: turn a `RollupSpec` into a Vega-Lite spec so a column-aggregate
 * window's Chart tab is seeded from the *spec* (which dims are dimensions,
 * which are temporal, which columns are measures) instead of re-guessing
 * from the result's column types.
 *
 * The window already ran the aggregate SQL, so the chart plots the
 * pre-aggregated result: dims become positional/color/facet encodings and
 * each measure is a plain quantitative field with **no** Vega aggregate —
 * fixing the auto-inferrer's spurious `sum()` that double-aggregates an
 * avg/distinct column. Encodings are titled with the rollup's own labels
 * (`sum(amount)`, `order_date (month)`) so the chart speaks the same
 * vocabulary as the rollup shelf.
 */

import type { AggregateOp } from "./chart-shelf"
import type { RollupAgg, RollupGroupTerm, RollupMeasure, RollupSpec } from "./types"
import { isDateRef, measureLabel } from "./sql-builder"

/**
 * Canonical reconciliation of the two aggregate vocabularies. SQL-native
 * names (`avg`, `count_distinct`, `stddev`) on the rollup side; Vega-Lite
 * names (`mean`, `distinct`, `stdev`) on the chart side. One source of
 * truth so a future shelf→SQL materialization stays consistent.
 */
export const ROLLUP_AGG_TO_CHART_OP: Record<RollupAgg, AggregateOp> = {
  sum: "sum",
  avg: "mean",
  min: "min",
  max: "max",
  count: "count",
  count_distinct: "distinct",
  median: "median",
  stddev: "stdev",
  variance: "variance",
}

export const CHART_OP_TO_ROLLUP_AGG: Partial<Record<AggregateOp, RollupAgg>> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
  count: "count",
  distinct: "count_distinct",
  median: "median",
  stdev: "stddev",
  variance: "variance",
}

function dimIsTemporal(term: RollupGroupTerm): boolean {
  return term.grain != null || isDateRef(term.column)
}

function dimTitle(term: RollupGroupTerm): string {
  return term.grain ? `${term.column.name} (${term.grain})` : term.column.name
}

function clickParams(field: string): Record<string, unknown>[] {
  // toggle: "true" (the STRING vega expression — boolean true only toggles on
  // shift-click) so every plain click adds/removes a mark and re-clicking a
  // selected one de-selects it (clearing its param). Matches chart-infer.ts.
  return [{ name: "click", select: { type: "point", fields: [field], toggle: "true" } }]
}

function selectionOpacity() {
  return { condition: { param: "click", value: 1, empty: true }, value: 0.35 }
}

/**
 * Build a Vega-Lite spec from a rollup spec, or null when charting from the
 * spec doesn't apply (a pivot's wide output, or no dimension to anchor an
 * axis — in those cases the caller falls back to column inference).
 */
export function rollupChartSpec(spec: RollupSpec): Record<string, unknown> | null {
  if (spec.pivot) return null
  const dims = spec.groupBy
  if (dims.length === 0) return null

  const measures: RollupMeasure[] = spec.measures.length > 0
    ? spec.measures
    : [{ id: "count:*", column: null, agg: "count", alias: "row_count" }]
  const primary = measures.find((m) => m.alias !== "row_count") ?? measures[0]
  if (!primary) return null

  // X anchor: prefer a temporal dim (it reads as a time axis); else the
  // first dim. Remaining dims fan into color then a column facet.
  const xDim = dims.find(dimIsTemporal) ?? dims[0]
  const rest = dims.filter((d) => d !== xDim)
  const colorDim = rest[0]
  const facetDim = rest[1]
  const overflow = rest.slice(2) // beyond 3 dims → tooltip only

  const xTemporal = dimIsTemporal(xDim)
  const xEnc: Record<string, unknown> = {
    field: xDim.column.name,
    type: xTemporal ? "temporal" : "nominal",
    title: dimTitle(xDim),
    ...(xTemporal ? {} : { sort: "-y" }),
  }
  const yEnc: Record<string, unknown> = {
    field: primary.alias,
    type: "quantitative",
    title: measureLabel(primary),
  }

  const tooltip: Record<string, unknown>[] = [
    { field: xDim.column.name, type: xTemporal ? "temporal" : "nominal", title: dimTitle(xDim) },
    { field: primary.alias, type: "quantitative", title: measureLabel(primary) },
  ]
  if (colorDim) tooltip.push({ field: colorDim.column.name, type: "nominal", title: dimTitle(colorDim) })
  if (facetDim) tooltip.push({ field: facetDim.column.name, type: "nominal", title: dimTitle(facetDim) })
  for (const d of overflow) tooltip.push({ field: d.column.name, type: "nominal", title: dimTitle(d) })
  // Secondary measures ride along in the tooltip.
  for (const m of measures) {
    if (m === primary) continue
    tooltip.push({ field: m.alias, type: "quantitative", title: measureLabel(m) })
  }

  const encoding: Record<string, unknown> = {
    x: xEnc,
    y: yEnc,
    opacity: selectionOpacity(),
    tooltip,
  }
  if (colorDim) encoding.color = { field: colorDim.column.name, type: "nominal", title: dimTitle(colorDim) }
  if (facetDim) encoding.column = { field: facetDim.column.name, type: "nominal", title: dimTitle(facetDim) }

  const mark = xTemporal
    ? { type: "line", point: true, interpolate: "monotone" }
    : { type: "bar" }

  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    mark,
    params: clickParams(xDim.column.name),
    encoding,
  }
}
