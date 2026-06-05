"use client"

import { useMemo, useRef, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  Clock,
  Eye,
  FlowArrow,
  GitBranch,
  Sparkles,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  HBars,
  Metric,
  Panel,
  Readout,
  useElementWidth,
  type HBarRow,
} from "./instruments"
import type { LensOverview, LensOverviewHourlyPoint } from "@/lib/rvbbit/lens"

interface QueryLensOverviewProps {
  overview: LensOverview | null
  loading: boolean
  windowHours: number
  onPickQuery: (queryId: string) => void
}

/**
 * Empty-state dashboard for Query Lens — answers "what's happening
 * across all queries lately?" before the user picks a specific one.
 * Mirrors the visual density and Bret-Victor scrub-ability of the
 * Specialist/Warren dashboards: hero metrics, two hourly bar panels,
 * a ranked operators panel, and a clickable top-queries list that
 * doubles as the on-ramp into the per-trace view.
 */
export function QueryLensOverview({
  overview,
  loading,
  windowHours,
  onPickQuery,
}: QueryLensOverviewProps) {
  if (loading && !overview) {
    return (
      <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" /> loading {windowHours}h overview…
        </span>
      </div>
    )
  }
  if (!overview) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[11px] text-chrome-text/55">
        <div>
          <Eye className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
          No receipts in the last {windowHours}h.
        </div>
      </div>
    )
  }

  const { hero, hourly, topOperators, topQueries } = overview
  const errorRate = hero.receipts > 0 ? hero.errors / hero.receipts : 0

  return (
    <div className="space-y-2.5 p-2.5">
      {/* hero strip */}
      <section className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
        <div className="mb-2 flex items-baseline justify-between text-[10px] uppercase tracking-wider text-chrome-text/55">
          <span className="inline-flex items-center gap-1.5">
            <Eye className="h-3 w-3 text-rvbbit-accent" />
            last {windowHours}h
          </span>
          <span className="font-mono normal-case tracking-normal text-chrome-text/45">
            window starts {fmtAgo(overview.windowStart)}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <Readout value={fmtCount(hero.queries)} unit="queries" label="distinct query_id" accent />
          <Metric label="receipts" value={fmtCount(hero.receipts)} />
          <Metric
            label="total cost"
            value={hero.totalCostUsd > 0 ? `$${hero.totalCostUsd.toFixed(4)}` : "—"}
          />
          <Metric
            label="tokens"
            value={`${fmtCount(hero.totalTokensIn)}→${fmtCount(hero.totalTokensOut)}`}
          />
          <Metric label="avg latency" value={fmtMs(hero.avgLatencyMs)} />
          <Metric
            label="errors"
            value={hero.errors === 0 ? "0" : `${hero.errors} (${(errorRate * 100).toFixed(1)}%)`}
            tone={hero.errors > 0 ? "danger" : undefined}
          />
          <Metric label="operators" value={String(hero.operatorCount)} />
        </div>
      </section>

      {/* two stacked columns: left = volume-over-time + operators, right = cost + queries */}
      <div className="grid grid-cols-2 items-start gap-2.5">
        {/* left column */}
        <div className="space-y-2.5">
          <Panel
            icon={FlowArrow}
            title="Queries by hour"
            right={<span>{hourly.length}h buckets</span>}
          >
            <HourlyBars
              data={hourly}
              valueFn={(p) => p.queries}
              barColor="var(--rvbbit-accent)"
              errorOverlayFn={(p) => p.errors}
              unitLabel="queries"
            />
          </Panel>
          <Panel
            icon={Activity}
            title="Semantic calls by hour"
            right={
              <span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtCount(hero.receipts)}
                </span>{" "}
                calls
              </span>
            }
          >
            <HourlyBars
              data={hourly}
              valueFn={(p) => p.receipts}
              barColor="var(--chart-2)"
              errorOverlayFn={(p) => p.errors}
              unitLabel="calls"
            />
          </Panel>
          <Panel
            icon={Brain}
            title="Top operators"
            right={<span>by call volume</span>}
          >
            {topOperators.length === 0 ? (
              <EmptyHint label="no operator activity in window" />
            ) : (
              <HBars
                rows={topOperators.map<HBarRow>((o) => ({
                  label: `rvbbit.${o.operator}`,
                  value: o.calls,
                  valueLabel: fmtCount(o.calls),
                  sub: o.cost > 0 ? `$${o.cost.toFixed(4)}` : `p95 ${fmtMs(o.p95)}`,
                  color:
                    o.errors > 0
                      ? "var(--danger)"
                      : "var(--rvbbit-accent)",
                  title:
                    `${o.calls} call(s) · p95 ${fmtMs(o.p95)}` +
                    (o.errors > 0 ? ` · ${o.errors} err` : "") +
                    (o.cost > 0 ? ` · $${o.cost.toFixed(4)}` : ""),
                }))}
              />
            )}
          </Panel>
        </div>

        {/* right column */}
        <div className="space-y-2.5">
          <Panel
            icon={Sparkles}
            title="Cost by hour"
            right={
              <span>
                <span className="font-mono tabular-nums text-foreground">
                  ${hero.totalCostUsd.toFixed(4)}
                </span>{" "}
                total
              </span>
            }
          >
            <HourlyBars
              data={hourly}
              valueFn={(p) => p.cost}
              barColor="var(--chart-3)"
              unitLabel="USD"
              unitFn={(v) => (v > 0 ? `$${v.toFixed(4)}` : "$0")}
            />
          </Panel>
          <Panel
            icon={GitBranch}
            title="Recent queries"
            right={<span>newest first · click to inspect</span>}
          >
            {topQueries.length === 0 ? (
              <EmptyHint label="no query_id-attributed traffic" />
            ) : (
              <ul className="space-y-1">
                {topQueries.map((q) => (
                  <TopQueryRow key={q.queryId} q={q} onClick={() => onPickQuery(q.queryId)} />
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <p className="px-1 text-[10px] leading-snug text-chrome-text/40">
        <Activity className="mr-0.5 inline h-2.5 w-2.5" />
        all panels sourced from <span className="font-mono">rvbbit.receipts</span> in the
        last {windowHours}h. Click any top-query row to load its full cross-surface trace.
      </p>
    </div>
  )
}

// ── Hourly bar chart ────────────────────────────────────────────────

/**
 * Compact 24-bar (or N-bar) chart for the hourly time series. Custom
 * SVG instead of pulling in vega so it matches the desktop's other
 * small instruments (Sparkline, Histogram). Hovering a bar shows the
 * hour + value tooltip; an optional `errorOverlayFn` draws a danger
 * underline on bars that contain errors so the eye can spot bad hours.
 */
function HourlyBars({
  data,
  valueFn,
  barColor,
  unitLabel,
  unitFn,
  errorOverlayFn,
  height = 96,
}: {
  data: LensOverviewHourlyPoint[]
  valueFn: (p: LensOverviewHourlyPoint) => number
  barColor: string
  unitLabel: string
  unitFn?: (v: number) => string
  errorOverlayFn?: (p: LensOverviewHourlyPoint) => number
  height?: number
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const { values, maxVal, errs } = useMemo(() => {
    const vs = data.map(valueFn)
    const es = errorOverlayFn ? data.map(errorOverlayFn) : []
    const maxVal = vs.reduce((m, v) => (v > m ? v : m), 0)
    return { values: vs, maxVal, errs: es }
  }, [data, valueFn, errorOverlayFn])

  if (data.length === 0) {
    return <EmptyHint label="no data in window" />
  }

  const padL = 4
  const padR = 4
  const padT = 6
  const padB = 14
  const innerW = Math.max(1, w - padL - padR)
  const innerH = Math.max(1, height - padT - padB)
  const gap = 2
  const barW = data.length > 0 ? (innerW - gap * (data.length - 1)) / data.length : 0

  const fmtVal = (v: number): string =>
    unitFn ? unitFn(v) : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`

  // Label the first, midpoint, and last bars only so the strip stays
  // legible. Each label is the hour-of-day.
  const tickIdxs = data.length <= 1 ? [0] : [0, Math.floor(data.length / 2), data.length - 1]

  return (
    <div ref={ref} className="relative" style={{ height }}>
      {w > 0 ? (
        <svg width={w} height={height} role="img" onMouseLeave={() => setHover(null)}>
          {values.map((v, i) => {
            const x = padL + i * (barW + gap)
            const h = maxVal === 0 ? 0 : Math.max(1.5, (v / maxVal) * innerH)
            const y = padT + (innerH - h)
            const hasErr = errs[i] > 0
            return (
              <g
                key={i}
                onMouseEnter={() => setHover(i)}
                style={{ cursor: "pointer" }}
              >
                {/* hover hit-rect — covers full column height so thin bars are still grabbable */}
                <rect
                  x={x}
                  y={padT}
                  width={Math.max(barW, 3)}
                  height={innerH}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={y}
                  width={Math.max(barW, 1.5)}
                  height={h}
                  rx={1}
                  fill={barColor}
                  opacity={hover === i ? 1 : v === 0 ? 0.18 : 0.78}
                />
                {hasErr ? (
                  <rect
                    x={x}
                    y={padT + innerH - 1.5}
                    width={Math.max(barW, 1.5)}
                    height={1.5}
                    fill="var(--danger)"
                  />
                ) : null}
              </g>
            )
          })}
          {/* axis ticks */}
          {tickIdxs.map((i) => {
            const x = padL + i * (barW + gap) + barW / 2
            const label = data[i] ? fmtHour(data[i].hour) : ""
            return (
              <text
                key={`tick${i}`}
                x={x}
                y={height - 3}
                textAnchor="middle"
                fontSize={8}
                fill="var(--chrome-text)"
                opacity={0.6}
              >
                {label}
              </text>
            )
          })}
        </svg>
      ) : null}
      {hover != null && data[hover] ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-chrome-border bg-chrome-bg px-1.5 py-0.5 font-mono text-[9px] text-foreground shadow"
          style={{
            left: Math.min(
              Math.max(padL + hover * (barW + gap) + barW / 2, 36),
              Math.max(36, w - 36),
            ),
            top: padT + 2,
          }}
        >
          <div>{fmtHour(data[hover].hour, true)}</div>
          <div className="tabular-nums">
            {fmtVal(values[hover])} <span className="text-chrome-text/55">{unitLabel}</span>
          </div>
          {errs[hover] > 0 ? (
            <div className="text-danger">{errs[hover]} err</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function fmtHour(ms: number, withDate = false): string {
  if (!ms) return "—"
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, "0")
  if (!withDate) return `${hh}:00`
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${mo}/${day} ${hh}:00`
}

// ── Top query row ───────────────────────────────────────────────────

function TopQueryRow({
  q,
  onClick,
}: {
  q: import("@/lib/rvbbit/lens").LensOverviewTopQuery
  onClick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <li>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 rounded border bg-secondary-background/40 px-2 py-1 text-left transition",
          "hover:border-rvbbit-accent/40 hover:bg-secondary-background/70",
          q.errorCount > 0 ? "border-danger/30" : "border-chrome-border/40",
        )}
        title={q.queryId}
      >
        <span className="font-mono text-[10px] tabular-nums text-chrome-text/55">
          {q.queryId.slice(0, 8)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-[10px]">
            <span className="font-mono tabular-nums text-foreground">
              {q.cost > 0 ? `$${q.cost.toFixed(4)}` : "—"}
            </span>
            <span className="text-chrome-text/55">·</span>
            <span className="font-mono tabular-nums text-foreground">
              {fmtMs(q.totalLatencyMs)}
            </span>
            <span className="text-chrome-text/55">·</span>
            <span className="text-chrome-text/65">
              {q.receipts} receipt{q.receipts === 1 ? "" : "s"}
            </span>
            {q.errorCount > 0 ? (
              <span className="text-danger">
                <AlertTriangle className="inline h-2.5 w-2.5" /> {q.errorCount} err
              </span>
            ) : null}
            <span className="ml-auto text-chrome-text/45">{fmtAgo(q.lastAt)}</span>
          </div>
          <div className="mt-0.5 line-clamp-1 font-mono text-[10px] text-chrome-text/65">
            {q.operators.map((o) => `rvbbit.${o}`).join(", ")}
          </div>
        </div>
      </button>
    </li>
  )
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="grid h-16 place-items-center text-[10px] text-chrome-text/45">
      {label}
    </div>
  )
}
