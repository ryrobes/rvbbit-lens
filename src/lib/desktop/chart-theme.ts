/**
 * Map the desktop's live theme tokens + font preferences onto a
 * Vega-Lite `config` block. Resolved at render time by reading
 * computed CSS vars from :root, so dark/light toggles, wallpaper
 * palette changes, and font-pref edits flow through to every chart.
 *
 * Vega doesn't know about `var(--main)`, so we read the resolved
 * color string and hand it the literal. The chart re-derives this
 * whenever its callsite re-renders — ChartView observes
 * documentElement style mutations and bumps a stamp.
 */

interface ResolvedTokens {
  background: string
  foreground: string
  chromeText: string
  chromeBorder: string
  main: string
  category: string[]
  fontSans: string
  fontMono: string
  fontPx: number
}

function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v.length > 0 ? v : fallback
}

function readResolvedTokens(): ResolvedTokens {
  // Fallbacks match globals.css dark defaults so SSR (and the
  // moment-before-hydration) doesn't render a chartreuse mess.
  // globals.css canonical names use hyphens (--chart-1 … --chart-5).
  // The hyphen-less variants written by applyTokensToRoot aren't
  // consumed elsewhere; read the canonical ones so dark/light works.
  const category = [
    readVar("--chart-1", "oklch(76% 0.14 195)"),
    readVar("--chart-2", "oklch(70% 0.18 145)"),
    readVar("--chart-3", "oklch(80% 0.16 85)"),
    readVar("--chart-4", "oklch(70% 0.20 310)"),
    readVar("--chart-5", "oklch(72% 0.17 25)"),
  ]
  const rootFontSize = (() => {
    if (typeof window === "undefined") return 14
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize || "14")
    return Number.isFinite(px) && px > 0 ? px : 14
  })()
  return {
    background: readVar("--doc-bg", "transparent"),
    foreground: readVar("--foreground", "#e7e7e7"),
    chromeText: readVar("--chrome-text", "#a8a8a8"),
    chromeBorder: readVar("--chrome-border", "#2a2a2a"),
    main: readVar("--main", "oklch(76% 0.16 250)"),
    category,
    fontSans: readVar("--font-family-sans", "ui-sans-serif, system-ui, sans-serif"),
    fontMono: readVar("--font-family-mono", "ui-monospace, SFMono-Regular, monospace"),
    fontPx: rootFontSize,
  }
}

/**
 * The Vega-Lite `config` block. Applied via spread into the user
 * (or inferred) spec so authored configs in `userSpec` can override
 * specific fields without losing the rest of the theme.
 */
export function vegaConfigFromTheme(): Record<string, unknown> {
  const t = readResolvedTokens()
  const small = Math.max(10, Math.round(t.fontPx * 0.78))
  const medium = Math.max(11, Math.round(t.fontPx * 0.86))
  return {
    background: "transparent",
    font: t.fontSans,
    view: { stroke: "transparent", fill: "transparent" },
    padding: 8,
    autosize: { type: "fit", contains: "padding" },
    title: {
      color: t.foreground,
      font: t.fontSans,
      fontSize: medium,
      fontWeight: 500,
      anchor: "start",
      offset: 8,
    },
    axis: {
      labelColor: t.chromeText,
      titleColor: t.foreground,
      gridColor: t.chromeBorder,
      gridOpacity: 0.35,
      domainColor: t.chromeBorder,
      tickColor: t.chromeBorder,
      labelFont: t.fontSans,
      titleFont: t.fontSans,
      labelFontSize: small,
      titleFontSize: medium,
      titleFontWeight: 500,
      labelPadding: 4,
      titlePadding: 6,
      domainOpacity: 0.6,
      tickOpacity: 0.6,
    },
    axisX: { labelAngle: -25 },
    legend: {
      labelColor: t.chromeText,
      titleColor: t.foreground,
      labelFont: t.fontSans,
      titleFont: t.fontSans,
      labelFontSize: small,
      titleFontSize: small,
      symbolStrokeWidth: 1,
      orient: "right",
    },
    header: {
      labelColor: t.chromeText,
      titleColor: t.foreground,
      labelFont: t.fontSans,
      titleFont: t.fontSans,
    },
    range: {
      category: t.category,
      ordinal: t.category,
      ramp: { scheme: "blues" },
    },
    mark: { color: t.category[0] },
    bar: { color: t.category[0], cornerRadiusTopLeft: 2, cornerRadiusTopRight: 2 },
    line: { stroke: t.category[0], strokeWidth: 2 },
    point: { fill: t.category[0], stroke: t.category[0], size: 64 },
    rule: { stroke: t.chromeBorder },
    tick: { color: t.foreground },
    text: { color: t.foreground, font: t.fontSans, fontSize: small },
  }
}

/**
 * Strings that identify the current theme well enough for memoization.
 * When this changes, ChartView should re-derive its merged spec.
 */
export function themeFingerprint(): string {
  if (typeof window === "undefined") return "ssr"
  const t = readResolvedTokens()
  return [t.background, t.foreground, t.main, ...t.category, t.fontSans, t.fontPx].join("|")
}
