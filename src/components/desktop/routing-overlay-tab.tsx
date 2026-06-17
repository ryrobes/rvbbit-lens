"use client"

import { useCallback, useEffect, useState } from "react"
import { CaretRight, Layers, RefreshCw, TrendingUp } from "@/lib/icons"
import { fmtAgo, fmtCount, fmtMs } from "./instruments"
import { EnginePill, ShapeChips } from "./routing-charts"
import {
  fetchOptimizationCandidates,
  fetchOverlayPins,
  type OptimizeCandidate,
  type OverlayPin,
} from "@/lib/rvbbit/routing"

interface Props {
  activeConnectionId: string | null
}

/**
 * Overlay — the learned routing layer (rvbbit.route_overlay). A flat set of tested
 * shape→engine pins layered on top of the deterministic base rules: each one is a shape
 * where a benchmark found a non-base engine measurably faster. Below the pins, the
 * candidate shapes still on the base rules, ranked by how much benchmarking them could pay.
 */
export function RoutingOverlayTab({ activeConnectionId }: Props) {
  const [pins, setPins] = useState<OverlayPin[]>([])
  const [candidates, setCandidates] = useState<OptimizeCandidate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (!activeConnectionId) return
    const [p, c] = await Promise.all([
      fetchOverlayPins(activeConnectionId),
      fetchOptimizationCandidates(activeConnectionId),
    ])
    setError(p.error ?? c.error ?? null)
    setPins(p.rows)
    setCandidates(c.rows)
    setLoaded(true)
  }, [activeConnectionId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-3 text-[11px]">
      <div className="flex items-center gap-2">
        <Layers className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="font-medium text-foreground">Routing overlay</span>
        <span className="text-chrome-text/50">
          tested shape→engine pins layered on the base rules
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded border border-chrome-border p-1 text-chrome-text/60 hover:text-foreground"
          title="refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {error ? (
        <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">
          {error}
        </div>
      ) : null}

      {/* pins */}
      <div className="flex max-h-[45%] min-h-0 flex-col rounded-md border border-chrome-border">
        <div className="flex shrink-0 items-center justify-between border-b border-chrome-border bg-secondary-background px-2 py-1">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            active pins
          </span>
          <span className="font-mono text-[9px] tabular-nums text-chrome-text/50">
            {fmtCount(pins.length)}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 z-[1] bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
              <tr>
                <th className="py-1 pl-2 pr-2 text-left font-medium">shape</th>
                <th className="py-1 pr-2 text-left font-medium">base → pinned</th>
                <th className="py-1 pr-2 text-right font-medium">margin</th>
                <th className="py-1 pr-2 text-left font-medium">source</th>
                <th className="py-1 pr-2 text-right font-medium">tested</th>
              </tr>
            </thead>
            <tbody>
              {pins.map((p, i) => (
                <tr key={i} className="border-t border-chrome-border/30 align-middle">
                  <td className="max-w-0 py-1 pl-2 pr-2">
                    <ShapeChips shape={p.shapeFamily} limit={6} />
                  </td>
                  <td className="py-1 pr-2">
                    <span className="flex items-center gap-1">
                      <span className="opacity-50">
                        <EnginePill id={p.baseEngine} />
                      </span>
                      <CaretRight className="h-3 w-3 text-chrome-text/40" />
                      <EnginePill id={p.engine} />
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-rvbbit-accent">
                    {p.marginPct > 0 ? `+${p.marginPct.toFixed(0)}%` : "—"}
                  </td>
                  <td className="py-1 pr-2 text-[9px] text-chrome-text/50">{p.source}</td>
                  <td className="py-1 pr-2 text-right text-[10px] text-chrome-text/60">
                    {p.testedAt ? fmtAgo(p.testedAt) : "—"}
                  </td>
                </tr>
              ))}
              {loaded && pins.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-chrome-text/40">
                    No pins yet — base rules handle everything. Optimize a query (Explain tab) or
                    let the auto-trainer run to add some.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* candidates */}
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-chrome-border">
        <div className="flex shrink-0 items-center justify-between border-b border-chrome-border bg-secondary-background px-2 py-1">
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
            <TrendingUp className="h-3 w-3" />
            optimization candidates — hot shapes still on base rules
          </span>
          <span className="font-mono text-[9px] tabular-nums text-chrome-text/50">
            {fmtCount(candidates.length)}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 z-[1] bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
              <tr>
                <th className="py-1 pl-2 pr-2 text-left font-medium">shape</th>
                <th className="py-1 pr-2 text-left font-medium">routes to</th>
                <th className="py-1 pr-2 text-right font-medium">runs/day</th>
                <th className="py-1 pr-2 text-right font-medium">avg</th>
                <th className="py-1 pr-2 text-right font-medium">potential</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr key={i} className="border-t border-chrome-border/30">
                  <td className="max-w-0 py-1 pl-2 pr-2">
                    <ShapeChips shape={c.shapeFamily} limit={6} />
                  </td>
                  <td className="py-1 pr-2">
                    {c.engine ? (
                      <EnginePill id={c.engine} />
                    ) : (
                      <span className="text-chrome-text/30">—</span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/70">
                    {fmtCount(c.executions)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/60">
                    {fmtMs(c.avgMs)}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-warning">
                    {fmtMs(c.potentialMs)}
                  </td>
                </tr>
              ))}
              {loaded && candidates.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-chrome-text/40">
                    No hot un-pinned shapes in the last day.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
