"use client"

import { useMemo, useState } from "react"
import { BookOpen, Cpu, Sigma, Target, TrendingUp } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fmtCount,
  fmtMs,
  HBars,
  Histogram,
  Metric,
  Panel,
  percentile,
  Readout,
  ScatterPlot,
  type HBarRow,
  type PlotSeries,
} from "./instruments"
import { EnginePill, EngineRace, ShapeChips } from "./routing-charts"
import {
  ENGINES,
  routeSpeedup,
  type ProfileData,
  type ProfileEntry,
} from "@/lib/rvbbit/routing"

type SortKey = "confidence" | "observations" | "speedup"

export function RoutingProfileTab({ data }: { data: ProfileData | null }) {
  if (!data) {
    return (
      <div className="grid h-40 place-items-center text-[11px] text-chrome-text/55">
        Loading trained profile…
      </div>
    )
  }
  if (!data.profile) {
    return (
      <div className="grid h-40 place-items-center text-center text-[11px] text-chrome-text/55">
        <div>
          <BookOpen className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
          No trained routing profile on this database.
          <br />
          The router falls back to hard rules until <span className="font-mono">route_train</span>{" "}
          builds one.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2.5 p-2.5">
      <ProfileMetaPanel data={data} />
      <div className="grid grid-cols-2 gap-2.5">
        <ChoiceComposition entries={data.entries} />
        <ConfidencePanel entries={data.entries} />
      </div>
      <CostVsSizePanel data={data} />
      <DecisionTablePanel entries={data.entries} />
      <div className="grid grid-cols-2 gap-2.5">
        <CoveragePanel data={data} />
        <ObservationsPanel data={data} />
      </div>
    </div>
  )
}

// ── Profile meta ────────────────────────────────────────────────────

function ProfileMetaPanel({ data }: { data: ProfileData }) {
  const p = data.profile!
  const generated = p.generatedAt
    ? new Date(p.generatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "—"
  return (
    <Panel
      icon={BookOpen}
      title="Trained profile"
      right={
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
            p.active ? "bg-success/15 text-success" : "bg-foreground/[0.06] text-chrome-text",
          )}
        >
          {p.active ? "active" : "inactive"}
        </span>
      }
    >
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <Readout value={p.name} label={`${p.suite ?? "profile"} · ${p.version ?? "v?"}`} accent />
        <Metric label="entries" value={fmtCount(p.entryCount ?? data.entries.length)} />
        <Metric label="observations" value={fmtCount(p.observationCount ?? 0)} />
        <Metric label="profile points" value={fmtCount(p.pointCount ?? data.points.length)} />
        <Metric
          label="min observations"
          value={p.minObservations != null ? String(p.minObservations) : "—"}
        />
        <Metric
          label="min gain"
          value={p.minGainPct != null ? `${p.minGainPct}%` : "—"}
        />
        <Metric label="generated" value={generated} />
      </div>
    </Panel>
  )
}

// ── Choice composition ──────────────────────────────────────────────

function ChoiceComposition({ entries }: { entries: ProfileEntry[] }) {
  const rows = useMemo<HBarRow[]>(() => {
    const total = Math.max(1, entries.length)
    return ENGINES.map((e) => {
      const mine = entries.filter((en) => en.choice === e.id)
      const conf =
        mine.length > 0 ? mine.reduce((s, m) => s + m.confidence, 0) / mine.length : 0
      return {
        label: e.label,
        value: mine.length,
        valueLabel: fmtCount(mine.length),
        sub: `${Math.round((mine.length / total) * 100)}%`,
        color: e.color,
        title: `${e.label}: ${mine.length} shapes · ${(conf * 100).toFixed(0)}% avg confidence`,
        muted: mine.length === 0,
      }
    }).sort((a, b) => b.value - a.value)
  }, [entries])

  return (
    <Panel icon={Cpu} title="What the profile decides" right={<span>{entries.length} shapes</span>}>
      <p className="mb-2 text-[10px] leading-snug text-chrome-text/55">
        For each query shape the profile names one winning engine. The mix below is the trained
        verdict across every catalogued shape.
      </p>
      <HBars rows={rows} />
    </Panel>
  )
}

// ── Confidence distribution ─────────────────────────────────────────

function ConfidencePanel({ entries }: { entries: ProfileEntry[] }) {
  const conf = useMemo(
    () => entries.map((e) => e.confidence).sort((a, b) => a - b),
    [entries],
  )
  const median = percentile(conf, 0.5)
  const strong = entries.filter((e) => e.confidence >= 0.5).length
  return (
    <Panel icon={Target} title="Decision confidence">
      <div className="flex items-end gap-4">
        <Readout value={`${(median * 100).toFixed(0)}%`} label="median confidence" />
        <Metric label="≥50% confident" value={`${strong} / ${entries.length}`} />
      </div>
      <div className="mt-2 pt-2">
        <Histogram
          values={conf}
          bins={20}
          height={56}
          domainMax={1}
          barColor="var(--rvbbit-accent)"
          markers={[{ value: median, color: "var(--foreground)" }]}
        />
      </div>
      <p className="mt-1 text-[10px] leading-snug text-chrome-text/55">
        Confidence scales with how decisively one engine beat the field and how many observations
        backed it — a low spread means the profile is still trained on thin evidence.
      </p>
    </Panel>
  )
}

// ── Engine cost vs table size ───────────────────────────────────────

function CostVsSizePanel({ data }: { data: ProfileData }) {
  const { series, insight } = useMemo(() => {
    const pts = data.points
    // one series per engine, in ENGINES order
    const series: PlotSeries[] = ENGINES.map((e) => ({
      label: e.label,
      color: e.color,
      points: pts
        .map((p) => ({ p, ms: p.engineTimes[e.id] }))
        .filter((x): x is { p: typeof pts[number]; ms: number } => x.ms != null && x.ms > 0)
        .map(({ p, ms }) => ({
          x: p.tableRows,
          y: ms,
          label: `${e.label} · ${fmtMs(ms)} @ ${fmtCount(p.tableRows)} rows`,
        })),
    }))
    // native vs the fastest non-native (any vector/hive/rowstore) on tables > 1M
    const nonNative = ENGINES.filter((e) => e.id !== "rvbbit_native")
    const ratios = pts
      .filter((p) => {
        const n = p.engineTimes.rvbbit_native
        return p.tableRows >= 1_000_000 && n != null && n > 0
      })
      .map((p) => {
        const n = p.engineTimes.rvbbit_native as number
        const best = Math.min(
          ...nonNative
            .map((e) => p.engineTimes[e.id])
            .filter((v): v is number => v != null && v > 0),
        )
        return Number.isFinite(best) && best > 0 ? n / best : NaN
      })
      .filter((r) => Number.isFinite(r))
      .sort((a, b) => a - b)
    const insight = ratios.length > 0 ? percentile(ratios, 0.5) : null
    return { series, insight }
  }, [data.points])

  return (
    <Panel
      icon={TrendingUp}
      title="Engine cost vs table size"
      right={<span>{data.points.length} trained points · log–log</span>}
    >
      <ScatterPlot series={series} height={224} xLog yLog xUnit=" rows" yUnit="ms" />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-[10px]">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="text-chrome-text/80">{s.label}</span>
            <span className="text-chrome-text/40">{s.points.length}</span>
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-chrome-text/55">
        Each dot is one trained shape-family timing.{" "}
        {insight != null ? (
          <>
            On tables past 1M rows the PostgreSQL native engine runs a median{" "}
            <span className="font-mono text-foreground">{insight.toFixed(0)}×</span> slower than the
            fastest non-native engine — the gap the router exists to close.
          </>
        ) : (
          "Native execution climbs steeply with table size while the vector and hive engines stay flat."
        )}
      </p>
    </Panel>
  )
}

// ── Decision table ──────────────────────────────────────────────────

function DecisionTablePanel({ entries }: { entries: ProfileEntry[] }) {
  const [sort, setSort] = useState<SortKey>("confidence")

  const sorted = useMemo(() => {
    const copy = [...entries]
    copy.sort((a, b) => {
      if (sort === "observations") return b.observations - a.observations
      if (sort === "speedup") {
        return (routeSpeedup(b.reason) ?? 0) - (routeSpeedup(a.reason) ?? 0)
      }
      return b.confidence - a.confidence
    })
    return copy
  }, [entries, sort])

  return (
    <Panel
      icon={Sigma}
      title="Decision table"
      right={
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="h-5 rounded border border-chrome-border bg-secondary-background px-1 text-[10px] text-foreground outline-none"
        >
          <option value="confidence">by confidence</option>
          <option value="observations">by evidence</option>
          <option value="speedup">by speedup</option>
        </select>
      }
    >
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 z-[1] bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-1 pr-2 text-left font-medium">query shape</th>
              <th className="py-1 pr-2 text-left font-medium">routes to</th>
              <th className="py-1 pr-2 text-left font-medium">confidence</th>
              <th className="py-1 pr-2 text-right font-medium">evidence</th>
              <th className="py-1 text-left font-medium">candidate race</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => {
              const speedup = routeSpeedup(e.reason)
              return (
                <tr key={i} className="border-t border-chrome-border/30 align-middle">
                  <td className="max-w-0 py-1 pr-2">
                    <ShapeChips shape={e.shapeKey} limit={6} />
                  </td>
                  <td className="py-1 pr-2">
                    <EnginePill id={e.choice} />
                  </td>
                  <td className="py-1 pr-2">
                    <div className="flex w-28 items-center gap-1.5">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                        <div
                          className="h-full rounded-full bg-rvbbit-accent"
                          style={{ width: `${Math.max(2, e.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="w-7 shrink-0 text-right font-mono text-[9px] tabular-nums text-chrome-text/70">
                        {(e.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="py-1 pr-2 text-right font-mono text-[10px] tabular-nums text-chrome-text/70">
                    {e.observations}
                    {speedup != null ? (
                      <span className="text-chrome-text/40"> · {speedup.toFixed(2)}×</span>
                    ) : null}
                  </td>
                  <td className="py-1" title={e.reason}>
                    <EngineRace times={e.engineTimes} choice={e.choice} height={26} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ── Coverage ────────────────────────────────────────────────────────

function CoveragePanel({ data }: { data: ProfileData }) {
  const ss = data.shapeSummary
  const needs = ss.filter((s) => s.needsExploration).length
  const avgGain =
    ss.length > 0
      ? ss.reduce((s, x) => s + (x.observedGain ?? 0), 0) / ss.length
      : 0
  const topGain = useMemo(
    () =>
      [...ss]
        .filter((s) => s.observedGain != null)
        .sort((a, b) => (b.observedGain ?? 0) - (a.observedGain ?? 0))
        .slice(0, 6),
    [ss],
  )
  return (
    <Panel icon={Target} title="Training coverage">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <Readout value={fmtCount(ss.length)} label="shape families" />
        <Metric
          label="need exploration"
          value={`${needs}`}
          tone={needs > 0 ? "warning" : undefined}
        />
        <Metric label="avg observed gain" value={`${(avgGain * 100).toFixed(0)}%`} />
      </div>
      <div className="mt-2 border-t border-chrome-border/40 pt-1.5">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
          biggest measured wins
        </div>
        {topGain.length === 0 ? (
          <p className="text-[10px] text-chrome-text/45">No benchmarked families yet.</p>
        ) : (
          <div className="space-y-1">
            {topGain.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ShapeChips shape={s.shapeFamily} limit={4} />
                </div>
                <EnginePill id={s.bestCandidate} />
                <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-success">
                  {((s.observedGain ?? 0) * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

// ── Observations ────────────────────────────────────────────────────

function ObservationsPanel({ data }: { data: ProfileData }) {
  const bySource = useMemo<HBarRow[]>(() => {
    const m = new Map<string, number>()
    for (const o of data.observations) m.set(o.source, (m.get(o.source) ?? 0) + o.count)
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([source, n]) => ({
        label: source,
        value: n,
        valueLabel: fmtCount(n),
        color: "var(--rvbbit-accent)",
        title: `${source}: ${n} observations`,
      }))
  }, [data.observations])
  const total = data.observations.reduce((s, o) => s + o.count, 0)

  return (
    <Panel icon={Cpu} title="Training observations" right={<span>{fmtCount(total)} timings</span>}>
      <p className="mb-2 text-[10px] leading-snug text-chrome-text/55">
        Forced candidate timings that <span className="font-mono">route_train</span> compares to
        pick each shape&apos;s winner — grouped by where the measurement came from.
      </p>
      {bySource.length === 0 ? (
        <p className="text-[11px] text-chrome-text/55">No observations recorded.</p>
      ) : (
        <HBars rows={bySource} />
      )}
    </Panel>
  )
}
