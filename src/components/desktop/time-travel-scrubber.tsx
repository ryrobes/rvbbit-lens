"use client"

/**
 * Vertical time-travel scrubber for rvbbit-backed tables.
 *
 * Visual language is a geological strata cross-section: each `committed_at`
 * generation is a horizontal tick of length log-scaled by `rows_written`,
 * stacked top-down with NOW at the top. The handle is a thin line you drag
 * up/down; hovering a tick (or scrubbing past it) surfaces a snapshot card
 * with the gen's metadata. A small datetime-local input lets you punch in
 * an exact moment.
 *
 * The scrubber owns no SQL state — it only emits `onChange(asOf | null)`.
 * The parent rewrites the editor text via `withAsOf` and schedules the
 * re-run, debounced so a drag doesn't queue twenty queries.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Calendar, Clock, X } from "@/lib/icons"
import {
  fmtAgoShort,
  fmtScrubberTime,
  isoToLocalInput,
  localInputToIso,
  seriesKey,
  type TimelineSeries,
  type TimelineTick,
} from "@/lib/rvbbit/time-travel"

interface Props {
  series: TimelineSeries[]
  /** ISO timestamp the editor is currently pinned to, or null for "now". */
  asOf: string | null
  onChange: (next: string | null) => void
}

// Geometry — sized so the whole scrubber column is ~64px wide. The tick area
// (TRACK + lane fanout + max tick length) fits in 28px so up to 5 colored
// lanes of 4px stacked side-by-side leave room for an 8px tick reach.
const TRACK_X = 16
const TRACK_W = 4
const TICK_MAX_LEN = 12 // per-lane stem length
const TICK_START_X = TRACK_X + TRACK_W + 2
const LANE_W = 4
// Bucket size for the activity heatmap on the track itself.
const HEAT_BUCKET_PX = 4

interface HoveredTickInfo {
  tick: TimelineTick
  series: TimelineSeries
}

export function TimeTravelScrubber({ series, asOf, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [trackH, setTrackH] = useState(0)
  const [hoverY, setHoverY] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  // Wall-clock anchor — kept in state so the render path is pure and the
  // "now" cap drifts forward over time when the editor sits idle.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  // Measure the track for px math.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const obs = new ResizeObserver(() => setTrackH(el.clientHeight))
    obs.observe(el)
    setTrackH(el.clientHeight)
    return () => obs.disconnect()
  }, [])

  // Flat ticks-with-series view — useful for nearest-tick search + per-series
  // operations.
  const allTickRefs = useMemo(() => {
    const out: { tick: TimelineTick; series: TimelineSeries }[] = []
    for (const s of series) for (const t of s.ticks) out.push({ tick: t, series: s })
    return out
  }, [series])

  // Time domain — newest at the top of the scrubber, oldest at the bottom.
  const { maxMs, span } = useMemo(() => {
    if (allTickRefs.length === 0) {
      return { maxMs: nowMs, span: 3600_000 }
    }
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const r of allTickRefs) {
      const ms = new Date(r.tick.committedAt).getTime()
      if (!Number.isFinite(ms)) continue
      if (ms < min) min = ms
      if (ms > max) max = ms
    }
    if (nowMs > max) max = nowMs
    return { maxMs: max, span: Math.max(1, max - min) }
  }, [allTickRefs, nowMs])

  // Padding — leaves room for NOW label at top and OLD/handle chrome at bottom.
  const padTop = 26
  const padBottom = 30
  const usable = Math.max(40, trackH - padTop - padBottom)

  const timeToY = useCallback(
    (ms: number) => {
      const frac = (maxMs - ms) / span
      return padTop + Math.max(0, Math.min(1, frac)) * usable
    },
    [maxMs, span, usable, padTop],
  )
  const yToTime = useCallback(
    (y: number) => {
      const frac = Math.max(0, Math.min(1, (y - padTop) / Math.max(1, usable)))
      return maxMs - frac * span
    },
    [maxMs, span, usable, padTop],
  )

  // Log-scaled bar lengths so a 50-row gen and a 5M-row gen are both legible.
  const maxRows = useMemo(
    () => Math.max(1, ...allTickRefs.map((r) => r.tick.rowsWritten)),
    [allTickRefs],
  )
  const tickLen = useCallback(
    (rowsWritten: number) => {
      if (rowsWritten <= 0) return 3
      const n = Math.log10(rowsWritten + 1) / Math.log10(maxRows + 1)
      return 3 + n * (TICK_MAX_LEN - 3)
    },
    [maxRows],
  )

  // Activity heatmap on the track itself — each y-bucket's brightness encodes
  // the aggregate log-rows-written across ALL series in its time window. This
  // gives a one-glance read of "when was the table actually busy" even when
  // ticks are too small to see individually.
  const heatBuckets = useMemo(() => {
    const N = Math.max(1, Math.floor(usable / HEAT_BUCKET_PX))
    const acc = new Array<number>(N).fill(0)
    for (const r of allTickRefs) {
      const ms = new Date(r.tick.committedAt).getTime()
      if (!Number.isFinite(ms)) continue
      const frac = (maxMs - ms) / span
      const idx = Math.min(N - 1, Math.max(0, Math.floor(frac * N)))
      acc[idx] += Math.log10(r.tick.rowsWritten + 1)
    }
    const max = Math.max(0.0001, ...acc)
    return acc.map((v, i) => ({
      y: padTop + i * HEAT_BUCKET_PX,
      opacity: v <= 0 ? 0.04 : Math.min(1, 0.14 + 0.86 * (v / max)),
    }))
  }, [allTickRefs, maxMs, span, usable, padTop])

  // Current selected position
  const asOfMs = asOf ? new Date(asOf).getTime() : null
  const handleY = asOfMs != null && Number.isFinite(asOfMs) ? timeToY(asOfMs) : padTop

  // Hover / drag tracking
  const onPointer = useCallback(
    (e: React.PointerEvent) => {
      if (!wrapRef.current) return
      const r = wrapRef.current.getBoundingClientRect()
      const y = e.clientY - r.top
      setHoverY(y)
      if (dragging) {
        const ms = yToTime(y)
        // Within ~3px of the top → clear (back to "now").
        if (y <= padTop + 4) onChange(null)
        else onChange(new Date(ms).toISOString())
      }
    },
    [dragging, onChange, padTop, yToTime],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      ;(e.target as Element).setPointerCapture(e.pointerId)
      setDragging(true)
      // Immediate click-to-position.
      const r = wrapRef.current!.getBoundingClientRect()
      const y = e.clientY - r.top
      if (y <= padTop + 4) onChange(null)
      else onChange(new Date(yToTime(y)).toISOString())
    },
    [onChange, padTop, yToTime],
  )
  const onPointerUp = useCallback(() => {
    setDragging(false)
  }, [])

  // Nearest tick (across all series) for the tooltip card.
  const hoveredInfo = useMemo<HoveredTickInfo | null>(() => {
    if (hoverY == null || allTickRefs.length === 0) return null
    let best: HoveredTickInfo | null = null
    let bestDist = Infinity
    for (const r of allTickRefs) {
      const tms = new Date(r.tick.committedAt).getTime()
      if (!Number.isFinite(tms)) continue
      const ty = timeToY(tms)
      const d = Math.abs(ty - hoverY)
      if (d < bestDist) {
        bestDist = d
        best = r
      }
    }
    return bestDist < 12 ? best : null
  }, [hoverY, allTickRefs, timeToY])

  // For each series, the latest tick at-or-before asOf — that's the snapshot
  // rvbbit will actually read for that table. Stored by series key for the
  // SVG render path's highlight check.
  const pinnedGenBySeries = useMemo(() => {
    const m = new Map<string, number>()
    if (asOfMs == null) return m
    for (const s of series) {
      let best: TimelineTick | null = null
      for (const t of s.ticks) {
        const tms = new Date(t.committedAt).getTime()
        if (Number.isFinite(tms) && tms <= asOfMs) {
          if (!best || tms > new Date(best.committedAt).getTime()) best = t
        }
      }
      if (best) m.set(seriesKey(s.table), best.generation)
    }
    return m
  }, [asOfMs, series])

  // Header label & tooltip — show distinct color dots per table.
  const headerTitle =
    series.length === 0
      ? "time travel"
      : `time travel · ${series.map((s) => `${s.table.schema}.${s.table.name}`).join(", ")}`

  return (
    <div className="flex h-full w-[64px] shrink-0 flex-col border-l border-chrome-border/60 bg-chrome-bg/30">
      <div
        className="flex items-center gap-1 border-b border-chrome-border/40 px-1 py-1 text-[9px] uppercase tracking-wider text-chrome-text/55"
        title={headerTitle}
      >
        <Clock className="h-3 w-3 text-rvbbit-accent" />
        <span className="truncate">tt</span>
        <span className="ml-auto flex items-center gap-px">
          {series.slice(0, 5).map((s) => (
            <span
              key={seriesKey(s.table)}
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: s.color }}
              title={`${s.table.schema}.${s.table.name}`}
            />
          ))}
        </span>
      </div>
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 select-none"
        onPointerMove={onPointer}
        onPointerLeave={() => {
          setHoverY(null)
          setDragging(false)
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        style={{ cursor: dragging ? "grabbing" : "ns-resize" }}
      >
        {trackH > 0 ? (
          <svg className="absolute inset-0" width="100%" height="100%">
            {/* Activity heatmap on the track itself — each y-bucket's opacity
                encodes log-summed rows_written across every series. Bright
                bands = busy periods, faint = quiet. */}
            {heatBuckets.map((b, i) => (
              <rect
                key={i}
                x={TRACK_X}
                y={b.y}
                width={TRACK_W}
                height={HEAT_BUCKET_PX}
                fill="var(--rvbbit-accent)"
                opacity={b.opacity}
              />
            ))}
            {/* Faint track outline so the empty regions still read as a track. */}
            <rect
              x={TRACK_X}
              y={padTop}
              width={TRACK_W}
              height={usable}
              rx={2}
              fill="none"
              stroke="var(--chrome-border)"
              strokeWidth={0.5}
              opacity={0.6}
            />

            {/* NOW cap */}
            <line
              x1={TRACK_X - 4}
              x2={TRACK_X + TRACK_W + LANE_W * Math.max(1, series.length) + TICK_MAX_LEN}
              y1={padTop}
              y2={padTop}
              stroke="var(--rvbbit-accent)"
              strokeWidth={1}
              opacity={0.7}
            />
            <text
              x={TRACK_X - 4}
              y={padTop - 6}
              fontSize={8}
              fill="var(--rvbbit-accent)"
              className="font-mono"
              opacity={0.85}
            >
              NOW
            </text>

            {/* Per-table tick lanes — each series gets a 4px lane, ticks
                extend right by log-scaled rows_written. */}
            {series.map((s, lanIdx) => {
              const laneX = TICK_START_X + lanIdx * LANE_W
              const pinnedGen = pinnedGenBySeries.get(seriesKey(s.table))
              return (
                <g key={seriesKey(s.table)}>
                  {s.ticks.map((t) => {
                    const ms = new Date(t.committedAt).getTime()
                    if (!Number.isFinite(ms)) return null
                    const y = timeToY(ms)
                    const len = tickLen(t.rowsWritten)
                    const isPinned = pinnedGen === t.generation
                    const isHovered =
                      hoveredInfo != null &&
                      hoveredInfo.tick.generation === t.generation &&
                      seriesKey(hoveredInfo.series.table) === seriesKey(s.table)
                    return (
                      <g key={t.generation}>
                        <line
                          x1={laneX}
                          x2={laneX + len}
                          y1={y}
                          y2={y}
                          stroke={s.color}
                          strokeWidth={isPinned || isHovered ? 1.6 : 1}
                          opacity={isPinned ? 1 : isHovered ? 0.95 : 0.78}
                        />
                        {t.tombstonesVisible > 0 ? (
                          <circle
                            cx={TRACK_X - 3}
                            cy={y}
                            r={1.4}
                            fill="var(--danger)"
                            opacity={0.85}
                          />
                        ) : null}
                      </g>
                    )
                  })}
                </g>
              )
            })}

            {/* OLD label */}
            <text
              x={TRACK_X - 4}
              y={padTop + usable + 12}
              fontSize={8}
              fill="var(--chrome-text)"
              className="font-mono"
              opacity={0.6}
            >
              OLD
            </text>

            {/* Drag handle — drawn last so it's always on top. */}
            <g pointerEvents="none">
              <line
                x1={4}
                x2={TRACK_X + TRACK_W + LANE_W * Math.max(1, series.length) + TICK_MAX_LEN + 2}
                y1={handleY}
                y2={handleY}
                stroke="var(--foreground)"
                strokeWidth={1}
                strokeDasharray={asOf ? undefined : "3 2"}
                opacity={asOf ? 0.9 : 0.4}
              />
              <circle
                cx={TRACK_X + TRACK_W / 2}
                cy={handleY}
                r={3.5}
                fill={asOf ? "var(--rvbbit-accent)" : "var(--chrome-text)"}
                stroke="var(--doc-bg)"
                strokeWidth={1.4}
              />
            </g>
          </svg>
        ) : null}

        {/* Hover tooltip — pinned to the right of the scrubber. */}
        {hoveredInfo && hoverY != null ? (
          <div
            className="pointer-events-none absolute z-10 w-[210px] -translate-y-1/2 rounded-md border border-chrome-border bg-chrome-bg/95 px-2 py-1.5 text-[10px] shadow-lg backdrop-blur"
            style={{
              right: 70,
              top: timeToY(new Date(hoveredInfo.tick.committedAt).getTime()),
            }}
          >
            <div className="flex items-center gap-1.5 font-mono text-foreground">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: hoveredInfo.series.color }}
              />
              <span className="min-w-0 flex-1 truncate text-[10px]">
                {hoveredInfo.series.table.schema}.{hoveredInfo.series.table.name}
              </span>
              <span className="shrink-0 text-chrome-text/55">{fmtAgoShort(hoveredInfo.tick.committedAt)}</span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between font-mono text-[9px] text-chrome-text/70">
              <span>gen {hoveredInfo.tick.generation}</span>
              <span>{fmtScrubberTime(hoveredInfo.tick.committedAt)}</span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[9px] text-chrome-text/85">
              <span className="text-chrome-text/55">+ rows</span>
              <span className="text-right tabular-nums">{fmt(hoveredInfo.tick.rowsWritten)}</span>
              <span className="text-chrome-text/55">row groups</span>
              <span className="text-right tabular-nums">{fmt(hoveredInfo.tick.rowGroupsWritten)}</span>
              <span className="text-chrome-text/55">visible</span>
              <span className="text-right tabular-nums">{fmt(hoveredInfo.tick.visibleRowsEstimate)}</span>
              {hoveredInfo.tick.tombstonesVisible > 0 ? (
                <>
                  <span className="text-danger/85">tombstones</span>
                  <span className="text-right tabular-nums text-danger/85">
                    {fmt(hoveredInfo.tick.tombstonesVisible)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer — current as-of readout + datetime-local picker. */}
      <div className="border-t border-chrome-border/40 px-1 py-1 text-[9px]">
        {asOf ? (
          pickerOpen ? (
            <DateTimePicker
              value={asOf}
              onApply={(iso) => {
                onChange(iso)
                setPickerOpen(false)
              }}
              onCancel={() => setPickerOpen(false)}
            />
          ) : (
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-0.5 text-left font-mono text-[9px] text-chrome-text/90 hover:text-foreground"
                title={`as_of = '${asOf}' — click to edit`}
              >
                <Calendar className="h-2.5 w-2.5 shrink-0 text-rvbbit-accent" />
                <span className="truncate">{fmtScrubberTime(asOf).split(" · ").join("\n")}</span>
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="inline-flex items-center gap-0.5 self-start rounded text-[9px] text-chrome-text/55 hover:text-foreground"
                title="Back to now"
              >
                <X className="h-2.5 w-2.5" />
                now
              </button>
            </div>
          )
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="font-mono text-[9px] text-chrome-text/55 hover:text-foreground"
            title="Pin to a specific timestamp"
          >
            <Calendar className="mr-0.5 inline h-2.5 w-2.5" />
            pick…
          </button>
        )}
      </div>
    </div>
  )
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function DateTimePicker({
  value,
  onApply,
  onCancel,
}: {
  value: string
  onApply: (iso: string) => void
  onCancel: () => void
}) {
  const [local, setLocal] = useState(() => isoToLocalInput(value))
  return (
    <div className="flex flex-col gap-0.5">
      <input
        type="datetime-local"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        className="w-full rounded border border-chrome-border bg-doc-bg px-0.5 py-0.5 font-mono text-[9px] text-foreground outline-none focus:border-rvbbit-accent/60"
      />
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => {
            const iso = localInputToIso(local)
            if (iso) onApply(iso)
          }}
          className="rounded border border-rvbbit-accent/40 bg-rvbbit-bg px-1 py-0.5 text-[9px] text-rvbbit-accent hover:bg-rvbbit-accent/15"
        >
          set
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-1 py-0.5 text-[9px] text-chrome-text/65 hover:text-foreground"
        >
          ×
        </button>
      </div>
    </div>
  )
}
