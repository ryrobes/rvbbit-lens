"use client"

import { Fragment, useCallback, useEffect, useRef, useState } from "react"

import { CaretRight, CheckCircle2, Loader2, Play, RefreshCw, Target } from "@/lib/icons"
import {
  fetchFailures,
  fetchOperatorTests,
  fetchSemanticTests,
  runBattery,
  type OperatorTestDetail,
  type SemanticTestsState,
  type TestFailure,
  type TestRun,
} from "@/lib/rvbbit/semantic-tests"
import { cn } from "@/lib/utils"

/**
 * Semantic Tests — the honesty machine for operators. Every operator can
 * carry embedded test cases; this window runs the battery and renders the
 * drift timeline (rvbbit.operator_test_runs). Each run is stamped with a
 * backend_tag naming the model/version regime that answered, so a pass-rate
 * drop attributes to exactly one change. Same battery, different bindings =
 * apples-to-apples across local vs managed inference.
 */

interface Props {
  activeConnectionId: string | null
  workspaceActive: boolean
}

function passTone(ratio: number): string {
  if (ratio >= 1) return "var(--viz-positive, #4ade80)"
  if (ratio >= 0.9) return "var(--viz-warning, #fbbf24)"
  return "var(--viz-negative, #f87171)"
}

function TrendBars({ trend }: { trend: { run: number; ok: number; total: number }[] }) {
  if (!trend.length) return <span className="font-mono text-[10px] text-chrome-text/40">—</span>
  return (
    <div className="flex h-4 items-end gap-[2px]" title={trend.map((t) => `run ${t.run}: ${t.ok}/${t.total}`).join("\n")}>
      {trend.map((t) => {
        const ratio = t.total > 0 ? t.ok / t.total : 0
        return (
          <div
            key={t.run}
            className="w-[7px] rounded-sm"
            style={{
              height: `${Math.max(18, ratio * 100)}%`,
              background: passTone(ratio),
              opacity: 0.45 + 0.55 * ratio,
            }}
          />
        )
      })}
    </div>
  )
}

export function SemanticTestsWindow({ activeConnectionId, workspaceActive }: Props) {
  const [state, setState] = useState<SemanticTestsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [tag, setTag] = useState("")
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [failures, setFailures] = useState<TestFailure[]>([])
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<Record<string, OperatorTestDetail[] | "loading">>({})
  // Mirror of `expanded` readable from refresh() without making it a dep
  // (a dep would change refresh's identity on every expand and re-fire the
  // mount effect → full refetch per row toggle).
  const expandedRef = useRef<Set<string>>(new Set())

  const toggleOperator = useCallback(
    (op: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(op)) {
          next.delete(op)
        } else {
          next.add(op)
        }
        expandedRef.current = next
        return next
      })
      if (activeConnectionId && details[op] === undefined) {
        setDetails((d) => ({ ...d, [op]: "loading" }))
        void fetchOperatorTests(activeConnectionId, op).then((tests) =>
          setDetails((d) => ({ ...d, [op]: tests })),
        )
      }
    },
    [activeConnectionId, details],
  )

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    const s = await fetchSemanticTests(activeConnectionId)
    setState(s)
    setLoading(false)
    // Latest-result columns in the expanded rows go stale after a run:
    // refetch for rows that are OPEN (else they'd sit at "loading" forever),
    // drop the rest so they reload lazily on next expand.
    const open = [...expandedRef.current]
    setDetails(() => {
      const next: Record<string, OperatorTestDetail[] | "loading"> = {}
      for (const op of open) next[op] = "loading"
      return next
    })
    for (const op of open) {
      void fetchOperatorTests(activeConnectionId, op).then((tests) =>
        setDetails((d) => ({ ...d, [op]: tests })),
      )
    }
    if (s.runs.length > 0) {
      const rid = s.runs[0].run_id
      setSelectedRun((prev) => prev ?? rid)
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (workspaceActive) void refresh()
  }, [workspaceActive, refresh])

  useEffect(() => {
    if (!activeConnectionId || selectedRun == null) return
    void fetchFailures(activeConnectionId, selectedRun).then(setFailures)
  }, [activeConnectionId, selectedRun])

  const onRun = useCallback(async () => {
    if (!activeConnectionId || running) return
    setRunning(true)
    setLastResult(null)
    const r = await runBattery(activeConnectionId, tag.trim())
    setRunning(false)
    if (r.ok) {
      setLastResult(`run #${r.run_id}: ${r.passed}/${r.tests} passed`)
      setSelectedRun(r.run_id ?? null)
      void refresh()
    } else {
      setLastResult(`battery failed: ${r.error}`)
    }
  }, [activeConnectionId, running, tag, refresh])

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-chrome-text/50">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }
  if (!state.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Target className="h-6 w-6 text-chrome-text/40" />
        <div className="text-sm text-foreground">Semantic Tests not initialized</div>
        <div className="max-w-md text-[11px] text-chrome-text/60">
          This warehouse has no <span className="font-mono">rvbbit.operator_test_runs</span> table
          yet. Operators with embedded tests can still run via{" "}
          <span className="font-mono">rvbbit.run_all_tests()</span>; the logged battery + drift
          timeline arrives with the Semantic Tests migration.
        </div>
      </div>
    )
  }

  const selected = state.runs.find((r) => r.run_id === selectedRun) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* header */}
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 text-chrome-text/70" />
        <div className="text-[12px] font-medium text-foreground">Semantic Tests</div>
        <div className="font-mono text-[10px] text-chrome-text/50">
          {state.operators.length} operators ·{" "}
          {state.operators.reduce((a, o) => a + o.n_tests, 0)} tests
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="regime tag (e.g. sentiment=modernbert)"
            className="w-64 rounded-md border border-chrome-border/60 bg-chrome-bg/30 px-2 py-1 font-mono text-[10px] text-foreground placeholder:text-chrome-text/35 focus:outline-none"
          />
          <button
            onClick={() => void onRun()}
            disabled={running}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-chrome-border/60 px-2.5 py-1 text-[11px]",
              running ? "opacity-50" : "hover:bg-chrome-bg/50",
            )}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? "Running battery…" : "Run battery"}
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded-md border border-chrome-border/60 p-1.5 hover:bg-chrome-bg/50"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>
      {lastResult && (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-chrome-text/60">
          <CheckCircle2 className="h-3 w-3" /> {lastResult}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] gap-2">
        {/* operators */}
        <div className="min-w-0 overflow-auto rounded-md border border-chrome-border/60 bg-chrome-bg/30 p-2">
          <div className="mb-1.5 text-[11px] font-medium text-foreground">
            Operators · pass-rate across recent runs
          </div>
          <table className="w-full text-left">
            <tbody>
              {state.operators.map((o) => {
                const last = o.trend[o.trend.length - 1]
                const ratio = last && last.total > 0 ? last.ok / last.total : null
                const isOpen = expanded.has(o.operator)
                const detail = details[o.operator]
                return (
                  <Fragment key={o.operator}>
                    <tr
                      className="cursor-pointer border-t border-chrome-border/30 hover:bg-chrome-bg/40"
                      onClick={() => toggleOperator(o.operator)}
                    >
                      <td className="py-1 pr-2 font-mono text-[11px] text-foreground">
                        <span className="flex items-center gap-1">
                          <CaretRight
                            className={cn(
                              "h-2.5 w-2.5 shrink-0 text-chrome-text/40 transition-transform",
                              isOpen && "rotate-90",
                            )}
                          />
                          {o.operator}
                        </span>
                      </td>
                      <td className="py-1 pr-2 font-mono text-[10px] text-chrome-text/50">
                        {o.n_tests} tests
                      </td>
                      <td className="py-1 pr-2">
                        <TrendBars trend={o.trend} />
                      </td>
                      <td className="py-1 text-right font-mono text-[11px]" style={{ color: ratio == null ? undefined : passTone(ratio) }}>
                        {last ? `${last.ok}/${last.total}` : "never run"}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-t border-chrome-border/20">
                        <td colSpan={4} className="py-1 pl-4 pr-1">
                          {detail === "loading" || detail === undefined ? (
                            <div className="flex items-center gap-1.5 py-1 font-mono text-[10px] text-chrome-text/45">
                              <Loader2 className="h-2.5 w-2.5 animate-spin" /> loading tests…
                            </div>
                          ) : detail.length === 0 ? (
                            <div className="py-1 font-mono text-[10px] text-chrome-text/45">no embedded tests</div>
                          ) : (
                            <div className="space-y-px pb-1">
                              {detail.map((t) => (
                                <div
                                  key={t.test_name}
                                  title={`${t.sql}\n\nexpect: ${t.expect}${t.description ? `\n${t.description}` : ""}`}
                                  className="grid cursor-help grid-cols-[8px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2 rounded px-1 py-0.5 hover:bg-chrome-bg/50"
                                >
                                  <span
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{
                                      background:
                                        t.passed == null
                                          ? "var(--chrome-border, #444)"
                                          : passTone(t.passed ? 1 : 0),
                                    }}
                                  />
                                  <span className="truncate font-mono text-[10px] text-chrome-text/80">
                                    {t.test_name}
                                  </span>
                                  <span className="truncate font-mono text-[9px] text-chrome-text/50">
                                    {t.expect}
                                  </span>
                                  <span
                                    className={cn(
                                      "truncate text-right font-mono text-[9px]",
                                      t.passed === false ? "text-danger/80" : "text-chrome-text/45",
                                    )}
                                  >
                                    {t.passed == null ? "never run" : (t.actual ?? "∅")}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* runs + failures */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-chrome-border/60 bg-chrome-bg/30 p-2">
            <div className="mb-1.5 text-[11px] font-medium text-foreground">Runs</div>
            {state.runs.map((r: TestRun) => {
              const ratio = r.total > 0 ? r.ok / r.total : 0
              return (
                <button
                  key={r.run_id}
                  onClick={() => setSelectedRun(r.run_id)}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-chrome-bg/50",
                    selectedRun === r.run_id && "bg-chrome-bg/60",
                  )}
                >
                  <span className="font-mono text-[10px] text-chrome-text/50">#{r.run_id}</span>
                  <span className="font-mono text-[11px]" style={{ color: passTone(ratio) }}>
                    {r.ok}/{r.total}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-chrome-text/60">
                    {r.tag || "(untagged)"}
                  </span>
                  <span className="font-mono text-[9px] text-chrome-text/40">
                    {r.ts.slice(5, 16).replace("T", " ")}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-chrome-border/60 bg-chrome-bg/30 p-2">
            <div className="mb-1.5 text-[11px] font-medium text-foreground">
              Failures {selected ? `· run #${selected.run_id}` : ""}
            </div>
            {failures.length === 0 ? (
              <div className="font-mono text-[10px] text-chrome-text/50">
                {selected ? "all green" : "select a run"}
              </div>
            ) : (
              failures.map((f, i) => (
                <div key={i} className="mb-1.5 rounded border border-chrome-border/40 p-1.5">
                  <div className="font-mono text-[11px] text-foreground">
                    {f.operator}
                    <span className="text-chrome-text/50"> / {f.test_name}</span>
                  </div>
                  <div className="font-mono text-[10px] text-chrome-text/70">
                    got <span className="text-danger/80">{f.actual || "∅"}</span> · expected{" "}
                    {f.expected || "?"}
                  </div>
                  {f.error && (
                    <div className="whitespace-pre-wrap font-mono text-[9px] text-danger/70">
                      {f.error}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
