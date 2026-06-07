/**
 * Shared visualization color references.
 *
 * These are CSS variable names, not resolved colors. Keeping them as live
 * variables lets charts, graph nodes, telemetry bars, and KG chips follow
 * dark/light changes and wallpaper-derived theme overrides.
 */

export const VIZ_SERIES_COLORS = [
  "var(--viz-series-1)",
  "var(--viz-series-2)",
  "var(--viz-series-3)",
  "var(--viz-series-4)",
  "var(--viz-series-5)",
  "var(--viz-series-6)",
  "var(--viz-series-7)",
  "var(--viz-series-8)",
  "var(--viz-series-9)",
]

export function colorForVizSeriesIndex(index: number): string {
  return VIZ_SERIES_COLORS[index % VIZ_SERIES_COLORS.length]
}

export function colorForVizKind(value: string): string {
  return `var(--viz-kind-${stableSlot(value, 10)})`
}

export const VIZ_CHIP_FG = "var(--viz-chip-fg)"

function stableSlot(value: string, slots: number): number {
  let h = 0
  for (let i = 0; i < value.length; i += 1) {
    h = ((h << 5) - h + value.charCodeAt(i)) | 0
  }
  return (((h % slots) + slots) % slots) + 1
}
