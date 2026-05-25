"use client"

import { useMemo } from "react"

interface SparklineProps {
  /** Oldest → newest. Empty / single-element arrays render a flat baseline. */
  values: number[]
  height?: number
  width?: number | string
  /** Stroke color — accepts CSS vars like `var(--main)`. */
  color?: string
  /** Optional fill below the line, color-mixed with `color`. */
  fillOpacity?: number
  /** Maximum number of points to display (older points dropped). */
  maxPoints?: number
  /** Force min/max y-axis instead of auto-scaling. */
  yMin?: number
  yMax?: number
  className?: string
}

/**
 * Minimal SVG sparkline. Pin the Y-axis to [0, observedMax] by default
 * so anomalous spikes stay readable instead of dragging the rest to a
 * line. Uses a quadratic-smooth path for that "btop oscilloscope" feel
 * without spending real CPU on Bezier control points.
 */
export function Sparkline({
  values,
  height = 32,
  width = "100%",
  color = "var(--main)",
  fillOpacity = 0.12,
  maxPoints = 60,
  yMin,
  yMax,
  className,
}: SparklineProps) {
  const series = values.slice(-maxPoints)
  const { d, area, lastY, hasPoints } = useMemo(
    () => buildPath(series, height, yMin, yMax),
    [series, height, yMin, yMax],
  )

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
    >
      {hasPoints ? (
        <>
          <path d={area} fill={color} fillOpacity={fillOpacity} stroke="none" />
          <path
            d={d}
            stroke={color}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={100} cy={lastY} r={1.6} fill={color} vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <line x1={0} x2={100} y1={height - 1} y2={height - 1} stroke={color} strokeOpacity={0.25} />
      )}
    </svg>
  )
}

function buildPath(
  values: number[],
  height: number,
  forcedMin?: number,
  forcedMax?: number,
): { d: string; area: string; lastY: number; hasPoints: boolean } {
  if (values.length === 0) return { d: "", area: "", lastY: height - 1, hasPoints: false }
  const min = forcedMin ?? Math.min(0, ...values)
  const max = forcedMax ?? Math.max(...values, min + 1e-6)
  const span = Math.max(1e-9, max - min)
  const stepX = values.length > 1 ? 100 / (values.length - 1) : 0
  const padTop = 2
  const inner = Math.max(1, height - padTop - 2)
  const toY = (v: number) => padTop + inner - ((v - min) / span) * inner

  let d = ""
  let area = ""
  if (values.length === 1) {
    const y = toY(values[0])
    d = `M 0 ${y} L 100 ${y}`
    area = `M 0 ${height - 1} L 0 ${y} L 100 ${y} L 100 ${height - 1} Z`
    return { d, area, lastY: y, hasPoints: true }
  }

  const points = values.map((v, i) => ({ x: i * stepX, y: toY(v) }))
  d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i += 1) {
    // Quadratic smoothing: control point is midpoint of (prev, curr).
    const p = points[i]
    const prev = points[i - 1]
    const cx = (prev.x + p.x) / 2
    d += ` Q ${cx} ${prev.y} ${p.x} ${p.y}`
  }
  const lastY = points[points.length - 1].y
  area = `${d} L 100 ${height - 1} L 0 ${height - 1} Z`
  return { d, area, lastY, hasPoints: true }
}
