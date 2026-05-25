"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Shared instrument-cluster primitives for the rvbbit monitor windows.
 * Visual language matches pg-monitor: bordered panels, mono tabular
 * numbers, teal accent. These add what Sparkline/Gauge don't cover —
 * distributions (Histogram), raw event scatter (ScatterStrip),
 * ranked bars (HBars) and composition (CompositionBar).
 */

// ── palette ─────────────────────────────────────────────────────────

/** Stable per-series colors — used for specialist composition / legends. */
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
]

/** Teal → amber → red, keyed off a 0..1 load ratio. */
export function loadColor(ratio: number): string {
  return ratio >= 0.85 ? "var(--danger)" : ratio >= 0.5 ? "var(--warning)" : "var(--rvbbit-accent)"
}

// ── formatters ──────────────────────────────────────────────────────

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

export function fmtAgo(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "never"
  const secs = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function fmtClock(epochMs: number): string {
  if (!epochMs || !Number.isFinite(epochMs)) return "—"
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

// ── stats helpers ───────────────────────────────────────────────────

/** Percentile of an ascending-sorted array. p in [0,1]. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round(p * (sortedAsc.length - 1))),
  )
  return sortedAsc[idx]
}

/** Count how many values fall into each of `nBuckets` bins over [min,max]. */
export function bucketCounts(
  values: number[],
  nBuckets: number,
  min: number,
  max: number,
): number[] {
  const out = new Array<number>(Math.max(0, nBuckets)).fill(0)
  if (nBuckets <= 0) return out
  const span = max - min
  for (const v of values) {
    let idx = span <= 0 ? nBuckets - 1 : Math.floor(((v - min) / span) * nBuckets)
    if (idx < 0) idx = 0
    if (idx >= nBuckets) idx = nBuckets - 1
    out[idx] += 1
  }
  return out
}

// ── element-width hook (for px-accurate scatter / hit-testing) ───────

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setW(cr.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

// ── Panel ───────────────────────────────────────────────────────────

export function Panel({
  icon: Icon,
  title,
  right,
  children,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3",
        className,
      )}
    >
      <header className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text">
        {Icon ? <Icon className="h-3 w-3 text-rvbbit-accent" /> : null}
        <span>{title}</span>
        {right ? (
          <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal text-chrome-text/60">
            {right}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  )
}

// ── Readout — a headline mono number with unit + caption ────────────

export function Readout({
  value,
  unit,
  label,
  accent,
  tone,
}: {
  value: string
  unit?: string
  label?: string
  accent?: boolean
  tone?: "danger" | "warning" | "success"
}) {
  const toneCls =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "success"
          ? "text-success"
          : accent
            ? "text-rvbbit-accent"
            : "text-foreground"
  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className={cn("font-mono text-2xl leading-none tabular-nums", toneCls)}>
          {value}
        </span>
        {unit ? (
          <span className="text-[10px] uppercase tracking-wider text-chrome-text/70">{unit}</span>
        ) : null}
      </div>
      {label ? (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-chrome-text/55">{label}</div>
      ) : null}
    </div>
  )
}

/** Compact label/value pair for stat rows. */
export function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: ReactNode
  tone?: "danger" | "warning" | "muted"
}) {
  const toneCls =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "muted"
          ? "text-chrome-text/55"
          : "text-foreground"
  return (
    <div className="min-w-0">
      <div className={cn("truncate font-mono text-[12px] tabular-nums", toneCls)}>{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
    </div>
  )
}

// ── Histogram — a distribution, with optional percentile markers ────

interface HistogramMarker {
  value: number
  label?: string
  color?: string
}

export function Histogram({
  values,
  bins = 22,
  height = 64,
  domainMax,
  markers = [],
  barColor = "var(--rvbbit-accent)",
  className,
}: {
  values: number[]
  bins?: number
  height?: number
  domainMax?: number
  markers?: HistogramMarker[]
  /** Solid color, or a function of the bin's [start,end] domain values. */
  barColor?: string | ((binStart: number, binEnd: number) => string)
  className?: string
}) {
  const { counts, maxCount, dMax } = useMemo(() => {
    const dMax = Math.max(1, domainMax ?? Math.max(1, ...values))
    const counts = bucketCounts(values, bins, 0, dMax)
    return { counts, maxCount: Math.max(1, ...counts), dMax }
  }, [values, bins, domainMax])

  const gap = 1.1
  const bw = (100 - gap * (bins - 1)) / bins

  return (
    <div className={cn("relative", className)}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
      >
        {counts.map((c, i) => {
          const h = c === 0 ? 0 : Math.max(1.4, (c / maxCount) * (height - 2))
          const x = i * (bw + gap)
          const fill =
            typeof barColor === "function"
              ? barColor((i / bins) * dMax, ((i + 1) / bins) * dMax)
              : barColor
          return (
            <rect
              key={i}
              x={x}
              y={height - h}
              width={bw}
              height={h}
              rx={0.4}
              fill={fill}
              opacity={c === 0 ? 0 : 0.88}
            />
          )
        })}
        {markers.map((m, i) => {
          const x = Math.min(100, Math.max(0, (m.value / dMax) * 100))
          return (
            <line
              key={i}
              x1={x}
              x2={x}
              y1={0}
              y2={height}
              stroke={m.color ?? "var(--foreground)"}
              strokeWidth={1}
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
          )
        })}
      </svg>
      {markers.some((m) => m.label) ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0">
          {markers.map((m, i) =>
            m.label ? (
              <span
                key={i}
                className="absolute -top-px font-mono text-[8px] leading-none text-chrome-text/80"
                style={{
                  left: `${Math.min(94, Math.max(6, (m.value / dMax) * 100))}%`,
                  transform: "translateX(-50%)",
                  color: m.color,
                }}
              >
                {m.label}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── ScatterStrip — every event as a dot: time × value, error-aware ──

export interface ScatterPoint {
  x: number
  y: number
  error?: boolean
  label?: string
}

export function ScatterStrip({
  points,
  height = 150,
  yMax,
  yUnit = "ms",
  refLines = [],
  className,
}: {
  points: ScatterPoint[]
  height?: number
  yMax?: number
  yUnit?: string
  refLines?: { y: number; label: string; color?: string }[]
  className?: string
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ cx: number; cy: number; label: string; error: boolean } | null>(
    null,
  )

  const padL = 6
  const padR = 6
  const padT = 8
  const padB = 16

  const { xMin, xMax, yTop, screen } = useMemo(() => {
    if (points.length === 0) {
      return { xMin: 0, xMax: 1, yTop: 1, screen: [] as { cx: number; cy: number; p: ScatterPoint }[] }
    }
    let xMin = Infinity
    let xMax = -Infinity
    let yObs = 0
    for (const p of points) {
      if (p.x < xMin) xMin = p.x
      if (p.x > xMax) xMax = p.x
      if (p.y > yObs) yObs = p.y
    }
    const yTop = Math.max(1, yMax ?? yObs * 1.12)
    const xSpan = Math.max(1, xMax - xMin)
    const plotW = Math.max(1, w - padL - padR)
    const plotH = Math.max(1, height - padT - padB)
    const screen = points.map((p) => ({
      cx: padL + ((p.x - xMin) / xSpan) * plotW,
      cy: padT + plotH - (Math.min(p.y, yTop) / yTop) * plotH,
      p,
    }))
    return { xMin, xMax, yTop, screen }
  }, [points, w, height, yMax])

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (screen.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let best: (typeof screen)[number] | null = null
    let bestD = 26 * 26
    for (const s of screen) {
      const d = (s.cx - mx) ** 2 + (s.cy - my) ** 2
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    setHover(
      best
        ? {
            cx: best.cx,
            cy: best.cy,
            error: !!best.p.error,
            label: best.p.label ?? `${Math.round(best.p.y)}${yUnit}`,
          }
        : null,
    )
  }

  return (
    <div
      ref={ref}
      className={cn("relative select-none", className)}
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {w > 0 ? (
        <svg width={w} height={height} role="img">
          {/* horizontal gridlines */}
          {[0.25, 0.5, 0.75].map((g) => {
            const y = padT + (height - padT - padB) * g
            return (
              <line
                key={g}
                x1={padL}
                x2={w - padR}
                y1={y}
                y2={y}
                stroke="var(--chrome-border)"
                strokeWidth={1}
                opacity={0.3}
              />
            )
          })}
          {/* reference lines (p50 / p95 / …) — labels nudged apart when close */}
          {(() => {
            const plotH = height - padT - padB
            const lines = refLines
              .map((r) => ({
                ...r,
                lineY: padT + plotH * (1 - Math.min(1, r.y / yTop)),
              }))
              .sort((a, b) => a.lineY - b.lineY)
            let prevLabelY = -Infinity
            return lines.map((r, i) => {
              const labelY = Math.max(r.lineY - 3, prevLabelY + 9)
              prevLabelY = labelY
              return (
                <g key={i}>
                  <line
                    x1={padL}
                    x2={w - padR}
                    y1={r.lineY}
                    y2={r.lineY}
                    stroke={r.color ?? "var(--foreground)"}
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    opacity={0.55}
                  />
                  <text
                    x={w - padR - 2}
                    y={labelY}
                    textAnchor="end"
                    className="font-mono"
                    fontSize={8}
                    fill={r.color ?? "var(--chrome-text)"}
                    opacity={0.95}
                  >
                    {r.label}
                  </text>
                </g>
              )
            })
          })()}
          {/* event dots */}
          {screen.map((s, i) => (
            <circle
              key={i}
              cx={s.cx}
              cy={s.cy}
              r={s.p.error ? 2.6 : 2.1}
              fill={s.p.error ? "var(--danger)" : "var(--rvbbit-accent)"}
              opacity={s.p.error ? 0.9 : 0.5}
            />
          ))}
          {/* hovered dot ring */}
          {hover ? (
            <circle
              cx={hover.cx}
              cy={hover.cy}
              r={4.4}
              fill="none"
              stroke={hover.error ? "var(--danger)" : "var(--foreground)"}
              strokeWidth={1.4}
            />
          ) : null}
          {/* y-axis ticks */}
          <text x={padL} y={padT - 1} fontSize={8} fill="var(--chrome-text)" opacity={0.7}>
            {Math.round(yTop)}
            {yUnit}
          </text>
          {/* x-axis range */}
          <text x={padL} y={height - 4} fontSize={8} fill="var(--chrome-text)" opacity={0.7}>
            {fmtClock(xMin)}
          </text>
          <text
            x={w - padR}
            y={height - 4}
            textAnchor="end"
            fontSize={8}
            fill="var(--chrome-text)"
            opacity={0.7}
          >
            {fmtClock(xMax)}
          </text>
        </svg>
      ) : null}
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border border-chrome-border bg-chrome-bg px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow"
          style={{
            left: Math.min(Math.max(hover.cx, 40), Math.max(40, w - 40)),
            top: hover.cy - 6,
          }}
        >
          {hover.label}
        </div>
      ) : null}
      {points.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-[10px] text-chrome-text/45">
          no calls in the receipt log
        </div>
      ) : null}
    </div>
  )
}

// ── HBars — a ranked horizontal-bar list ────────────────────────────

export interface HBarRow {
  label: ReactNode
  /** Raw magnitude — bar width is value/max. */
  value: number
  valueLabel: string
  sub?: string
  color?: string
  title?: string
  muted?: boolean
}

export function HBars({
  rows,
  max,
  className,
}: {
  rows: HBarRow[]
  max?: number
  className?: string
}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className={cn("space-y-1", className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2" title={r.title}>
          <div
            className={cn(
              "w-32 shrink-0 truncate font-mono text-[10px]",
              r.muted ? "text-chrome-text/45" : "text-foreground",
            )}
          >
            {r.label}
          </div>
          <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
            <div
              className="absolute inset-y-0 left-0 rounded-sm"
              style={{
                width: `${Math.max(1.5, (r.value / m) * 100)}%`,
                background: r.color ?? "var(--rvbbit-accent)",
                opacity: r.muted ? 0.4 : 0.9,
              }}
            />
          </div>
          <div className="flex w-[88px] shrink-0 items-baseline justify-end gap-1">
            <span className="font-mono text-[10px] tabular-nums text-foreground">
              {r.valueLabel}
            </span>
            {r.sub ? (
              <span className="font-mono text-[9px] tabular-nums text-chrome-text/50">{r.sub}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── CompositionBar — one bar split into proportional segments ───────

export function CompositionBar({
  segments,
  height = 10,
  className,
}: {
  segments: { label: string; value: number; color: string }[]
  height?: number
  className?: string
}) {
  const total = Math.max(1, segments.reduce((s, x) => s + x.value, 0))
  return (
    <div
      className={cn("flex w-full overflow-hidden rounded-sm bg-foreground/[0.05]", className)}
      style={{ height }}
    >
      {segments.map((s, i) =>
        s.value > 0 ? (
          <div
            key={i}
            title={`${s.label} · ${s.value}`}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
          />
        ) : null,
      )}
    </div>
  )
}

// ── ScatterPlot — multi-series X/Y plot with optional log axes ───────

export interface PlotPoint {
  x: number
  y: number
  label?: string
}
export interface PlotSeries {
  label: string
  color: string
  points: PlotPoint[]
}

function log10safe(v: number): number {
  return Math.log10(Math.max(v, 1e-9))
}

function decadeTicks(loExp: number, hiExp: number): number[] {
  const out: number[] = []
  for (let e = Math.ceil(loExp); e <= Math.floor(hiExp); e += 1) out.push(10 ** e)
  return out
}

function fmtTick(v: number): string {
  if (v >= 1_000_000) return `${Math.round(v / 1_000_000)}M`
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`
  if (v >= 1) return String(Math.round(v))
  return v.toPrecision(1)
}

/**
 * A scatter of several series. Optional log axes — used for the
 * "engine cost vs table size" view where both span 3+ decades. Pins
 * gridlines to decade boundaries so the eye reads orders of magnitude.
 */
export function ScatterPlot({
  series,
  height = 200,
  xLog = false,
  yLog = false,
  xUnit = "",
  yUnit = "",
  className,
}: {
  series: PlotSeries[]
  height?: number
  xLog?: boolean
  yLog?: boolean
  xUnit?: string
  yUnit?: string
  className?: string
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<
    { cx: number; cy: number; color: string; label: string } | null
  >(null)

  const padL = 36
  const padR = 10
  const padT = 10
  const padB = 18

  const model = useMemo(() => {
    const tx = (v: number) => (xLog ? log10safe(v) : v)
    const ty = (v: number) => (yLog ? log10safe(v) : v)
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    for (const s of series) {
      for (const p of s.points) {
        if ((xLog && p.x <= 0) || (yLog && p.y <= 0)) continue
        const X = tx(p.x)
        const Y = ty(p.y)
        if (X < xMin) xMin = X
        if (X > xMax) xMax = X
        if (Y < yMin) yMin = Y
        if (Y > yMax) yMax = Y
      }
    }
    if (!Number.isFinite(xMin)) {
      xMin = 0
      xMax = 1
      yMin = 0
      yMax = 1
    }
    const xPad = (xMax - xMin) * 0.05 || 0.5
    const yPad = (yMax - yMin) * 0.08 || 0.5
    xMin -= xPad
    xMax += xPad
    yMin -= yPad
    yMax += yPad
    const plotW = Math.max(1, w - padL - padR)
    const plotH = Math.max(1, height - padT - padB)
    const sx = (v: number) => padL + ((tx(v) - xMin) / (xMax - xMin || 1)) * plotW
    const sy = (v: number) =>
      padT + plotH - ((ty(v) - yMin) / (yMax - yMin || 1)) * plotH
    const dots: { cx: number; cy: number; color: string; label: string }[] = []
    for (const s of series) {
      for (const p of s.points) {
        if ((xLog && p.x <= 0) || (yLog && p.y <= 0)) continue
        dots.push({
          cx: sx(p.x),
          cy: sy(p.y),
          color: s.color,
          label: p.label ?? `${fmtTick(p.x)}${xUnit} · ${fmtTick(p.y)}${yUnit}`,
        })
      }
    }
    return {
      sx,
      sy,
      dots,
      xTicks: xLog ? decadeTicks(xMin, xMax) : [],
      yTicks: yLog ? decadeTicks(yMin, yMax) : [],
    }
  }, [series, w, height, xLog, yLog, xUnit, yUnit])

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (model.dots.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let best: (typeof model.dots)[number] | null = null
    let bestD = 24 * 24
    for (const d of model.dots) {
      const dist = (d.cx - mx) ** 2 + (d.cy - my) ** 2
      if (dist < bestD) {
        bestD = dist
        best = d
      }
    }
    setHover(best)
  }

  return (
    <div
      ref={ref}
      className={cn("relative select-none", className)}
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {w > 0 ? (
        <svg width={w} height={height} role="img">
          {model.yTicks.map((t) => {
            const y = model.sy(t)
            if (y < padT || y > height - padB) return null
            return (
              <g key={`y${t}`}>
                <line
                  x1={padL}
                  x2={w - padR}
                  y1={y}
                  y2={y}
                  stroke="var(--chrome-border)"
                  strokeWidth={1}
                  opacity={0.35}
                />
                <text x={padL - 4} y={y + 2.5} textAnchor="end" fontSize={8} fill="var(--chrome-text)" opacity={0.7}>
                  {fmtTick(t)}
                </text>
              </g>
            )
          })}
          {model.xTicks.map((t) => {
            const x = model.sx(t)
            if (x < padL || x > w - padR) return null
            return (
              <g key={`x${t}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={padT}
                  y2={height - padB}
                  stroke="var(--chrome-border)"
                  strokeWidth={1}
                  opacity={0.35}
                />
                <text x={x} y={height - padB + 9} textAnchor="middle" fontSize={8} fill="var(--chrome-text)" opacity={0.7}>
                  {fmtTick(t)}
                </text>
              </g>
            )
          })}
          {model.dots.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={2.5} fill={d.color} opacity={0.62} />
          ))}
          {hover ? (
            <circle
              cx={hover.cx}
              cy={hover.cy}
              r={4.6}
              fill="none"
              stroke="var(--foreground)"
              strokeWidth={1.4}
            />
          ) : null}
        </svg>
      ) : null}
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border border-chrome-border bg-chrome-bg px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow"
          style={{
            left: Math.min(Math.max(hover.cx, 48), Math.max(48, w - 48)),
            top: hover.cy - 6,
          }}
        >
          {hover.label}
        </div>
      ) : null}
      {model.dots.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center text-[10px] text-chrome-text/45">
          no data points
        </div>
      ) : null}
    </div>
  )
}

// ── InstallStateBadge — capability install-state pills ──────────────

/**
 * The 7 states from CAPABILITIES.md § "Install State Model". Several can
 * coexist (a healthy used backend gets three badges); the consumer
 * decides which subset to render. Colors map to the existing semantic
 * tokens so the badges sit comfortably alongside HealthPill / StatusPill
 * elsewhere in the desktop.
 */
export type InstallStateKey =
  | "catalog_only"
  | "registered"
  | "used"
  | "error_seen"
  | "healthy"
  | "failing"
  | "external"

const INSTALL_STATE_THEME: Record<
  InstallStateKey,
  { label: string; bg: string; fg: string; ring: string; title: string }
> = {
  catalog_only: {
    label: "catalog only",
    bg: "bg-foreground/[0.05]",
    fg: "text-chrome-text/65",
    ring: "ring-chrome-border/40",
    title: "In the catalog, not registered as an rvbbit.backend yet",
  },
  registered: {
    label: "registered",
    bg: "bg-brand-capability/12",
    fg: "text-brand-capability",
    ring: "ring-brand-capability/30",
    title: "Backend row present in rvbbit.backend_health",
  },
  used: {
    label: "used",
    bg: "bg-rvbbit-accent/12",
    fg: "text-rvbbit-accent",
    ring: "ring-rvbbit-accent/30",
    title: "Registered backend has at least one logged call",
  },
  error_seen: {
    label: "errors seen",
    bg: "bg-warning/12",
    fg: "text-warning",
    ring: "ring-warning/40",
    title: "Registered backend has at least one logged error",
  },
  healthy: {
    label: "healthy",
    bg: "bg-success/12",
    fg: "text-success",
    ring: "ring-success/40",
    title: "Most recent backend_probe returned ok",
  },
  failing: {
    label: "failing",
    bg: "bg-danger/12",
    fg: "text-danger",
    ring: "ring-danger/40",
    title: "Most recent backend_probe failed",
  },
  external: {
    label: "external",
    bg: "bg-foreground/[0.05]",
    fg: "text-chrome-text/65",
    ring: "ring-chrome-border/40",
    title: "Backend exists with no matching catalog entry",
  },
}

export function InstallStateBadge({
  state,
  size = "sm",
  title,
}: {
  state: InstallStateKey
  size?: "sm" | "xs"
  title?: string
}) {
  const t = INSTALL_STATE_THEME[state]
  const isXs = size === "xs"
  return (
    <span
      title={title ?? t.title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full ring-1",
        isXs ? "px-1.5 py-px text-[9px]" : "px-2 py-0.5 text-[10px]",
        "uppercase tracking-wider",
        t.bg,
        t.fg,
        t.ring,
      )}
    >
      {t.label}
    </span>
  )
}

export function InstallStateBadgeGroup({
  states,
  size = "sm",
}: {
  states: InstallStateKey[]
  size?: "sm" | "xs"
}) {
  if (states.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {states.map((s) => (
        <InstallStateBadge key={s} state={s} size={size} />
      ))}
    </span>
  )
}
