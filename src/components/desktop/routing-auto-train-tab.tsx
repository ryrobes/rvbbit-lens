"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Check, Clock, RefreshCw, Sparkles, Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount } from "./instruments"
import { EnginePill, ShapeChips } from "./routing-charts"
import { fetchOptimizeRuns, runOptimizeAuto, type OptimizeRun } from "@/lib/rvbbit/routing"

interface Props {
  activeConnectionId: string | null
}

/**
 * Auto-Train — observability for the auto-optimizer (rvbbit.route_optimize_auto).
 * Each nightly pass benchmarks the hottest shapes still on the base rules and pins the
 * ones where a non-base engine measurably wins. This surfaces the run history + a
 * manual "Run now" trigger. The schedule itself is managed in the Scheduler tray.
 */
export function RoutingAutoTrainTab({ activeConnectionId }: Props) {
  const [runs, setRuns] = useState<OptimizeRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null)
  const [topK, setTopK] = useState(10)
  const [maxSeconds, setMaxSeconds] = useState(120)
  const [openRun, setOpenRun] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchOptimizeRuns(activeConnectionId)
    setError(r.error)
    setRuns(r.rows)
    setLoaded(true)
    setOpenRun((prev) => prev ?? r.rows[0]?.runId ?? null)
  }, [activeConnectionId])

  useEffect(() => {
    void load()
  }, [load])

  const runNow = useCallback(async () => {
    if (!activeConnectionId || busy) return
    setBusy(true)
    setToast(null)
    const r = await runOptimizeAuto(activeConnectionId, topK, maxSeconds)
    setBusy(false)
    if (!r.ok || !r.result) {
      setToast({ ok: false, msg: r.error ?? "auto-optimize failed" })
    } else {
      const res = r.result
      setToast({
        ok: true,
        msg: `tested ${res.shapes_tested ?? 0} · pinned ${res.pinned ?? 0} · ${res.elapsed_sec ?? 0}s`,
      })
    }
    void load()
  }, [activeConnectionId, busy, topK, maxSeconds, load])

  const totalPinned = runs.reduce((s, r) => s + r.pinned, 0)
  const totalTested = runs.reduce((s, r) => s + r.shapesTested, 0)

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-[11px]">
      {/* run-now control bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-chrome-border bg-secondary-background px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="font-medium text-foreground">Auto-optimizer</span>
        <span className="text-chrome-text/50">benchmarks hot shapes on base rules, pins the wins</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-chrome-text/60">
            top-k
            <input
              type="number"
              min={1}
              max={100}
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Number(e.target.value) || 1))}
              className="h-5 w-12 rounded border border-chrome-border bg-doc-bg px-1 text-right tabular-nums text-foreground outline-none"
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-chrome-text/60">
            budget
            <input
              type="number"
              min={10}
              max={3600}
              value={maxSeconds}
              onChange={(e) => setMaxSeconds(Math.max(10, Number(e.target.value) || 10))}
              className="h-5 w-14 rounded border border-chrome-border bg-doc-bg px-1 text-right tabular-nums text-foreground outline-none"
            />
            s
          </label>
          <button
            type="button"
            onClick={runNow}
            disabled={busy || !activeConnectionId}
            className={cn(
              "flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors",
              busy
                ? "border-chrome-border text-chrome-text/40"
                : "border-rvbbit-accent/50 text-rvbbit-accent hover:bg-rvbbit-accent/10",
            )}
          >
            <Zap className={cn("h-3 w-3", busy && "animate-pulse")} />
            {busy ? "running…" : "Run now"}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-chrome-border p-1 text-chrome-text/60 hover:text-foreground"
            title="refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {toast ? (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded border px-2 py-1 text-[10px]",
            toast.ok
              ? "border-success/40 bg-success/10 text-success"
              : "border-danger/40 bg-danger/10 text-danger",
          )}
        >
          {toast.ok ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {toast.msg}
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">
          {error}
        </div>
      ) : null}

      {/* summary chips */}
      <div className="flex items-center gap-4 px-1 text-[10px] text-chrome-text/60">
        <span>
          <span className="font-mono tabular-nums text-foreground">{fmtCount(runs.length)}</span> runs
        </span>
        <span>
          <span className="font-mono tabular-nums text-foreground">{fmtCount(totalTested)}</span> tested
        </span>
        <span>
          <span className="font-mono tabular-nums text-rvbbit-accent">{fmtCount(totalPinned)}</span> pinned
        </span>
      </div>

      {/* run history */}
      <div className="rounded-md border border-chrome-border">
        <table className="w-full">
          <thead className="bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-1 pl-2 pr-2 text-left font-medium">when</th>
              <th className="py-1 pr-2 text-left font-medium">trigger</th>
              <th className="py-1 pr-2 text-right font-medium">tested</th>
              <th className="py-1 pr-2 text-right font-medium">pinned</th>
              <th className="py-1 pr-2 text-right font-medium">errors</th>
              <th className="py-1 pr-2 text-right font-medium">elapsed</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.runId}
                onClick={() => setOpenRun(openRun === r.runId ? null : r.runId)}
                className={cn(
                  "cursor-pointer border-t border-chrome-border/30 hover:bg-foreground/[0.03]",
                  openRun === r.runId && "bg-foreground/[0.04]",
                )}
              >
                <td className="py-1 pl-2 pr-2 text-chrome-text/70">
                  {r.finishedAt == null ? (
                    <span className="text-warning">running…</span>
                  ) : (
                    fmtAgo(r.startedAt)
                  )}
                </td>
                <td className="py-1 pr-2 text-chrome-text/60">{r.trigger}</td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/70">
                  {r.shapesTested}
                </td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums text-rvbbit-accent">
                  {r.pinned}
                </td>
                <td
                  className={cn(
                    "py-1 pr-2 text-right font-mono tabular-nums",
                    r.errors > 0 ? "text-danger" : "text-chrome-text/40",
                  )}
                >
                  {r.errors}
                </td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/60">
                  {r.elapsedSec == null ? "—" : `${r.elapsedSec}s`}
                </td>
              </tr>
            ))}
            {loaded && runs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-chrome-text/40">
                  <Clock className="mx-auto mb-1 h-4 w-4 opacity-50" />
                  No optimizer runs yet — schedule the nightly job or hit “Run now”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* selected-run per-shape detail */}
      {openRun != null
        ? (() => {
            const run = runs.find((r) => r.runId === openRun)
            if (!run || !run.detail || run.detail.length === 0) return null
            return (
              <div className="rounded-md border border-chrome-border">
                <div className="border-b border-chrome-border bg-secondary-background px-2 py-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
                  run #{run.runId} — per-shape outcome
                </div>
                <div className="max-h-[280px] overflow-auto">
                  <table className="w-full">
                    <tbody>
                      {run.detail.map((d, i) => (
                        <tr key={i} className="border-t border-chrome-border/30">
                          <td className="max-w-0 py-1 pl-2 pr-2">
                            <ShapeChips shape={d.shape_key} limit={6} />
                          </td>
                          <td className="py-1 pr-2">
                            {d.pinned ? (
                              <span className="flex items-center gap-1">
                                <EnginePill id={d.winner ?? ""} />
                                <span className="font-mono text-[9px] tabular-nums text-rvbbit-accent">
                                  +{(d.margin_pct ?? 0).toFixed(0)}%
                                </span>
                              </span>
                            ) : (
                              <span className="text-[9px] text-chrome-text/40">base kept</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()
        : null}
    </div>
  )
}
