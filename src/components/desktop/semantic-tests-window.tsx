"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  Activity,
  AlertTriangle,
  CaretRight,
  CheckCircle2,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  TerminalSquare,
} from "@/lib/icons"
import {
  fetchFailures,
  fetchOperatorTests,
  fetchSemanticTests,
  runBattery,
  type OperatorTestDetail,
  type OperatorTestSummary,
  type SemanticTestsState,
  type TestFailure,
  type TestRun,
} from "@/lib/rvbbit/semantic-tests"
import { cn } from "@/lib/utils"

/**
 * Semantic Tests — a directly manipulable view of operator honesty.
 *
 * The run trajectory, operator matrix, run summary, failure ledger, and test
 * definitions all share one selected run/operator. Hovering previews history;
 * clicking commits context. Every visualization is bounded by its panel rather
 * than growing with the number of runs or expanded rows.
 */

interface Props {
  activeConnectionId: string | null
  workspaceActive: boolean
}

type OperatorMode = "all" | "failing" | "unrun"

function passTone(ratio: number): string {
  if (ratio >= 1) return "var(--viz-positive, #4ade80)"
  if (ratio >= 0.9) return "var(--viz-warning, #fbbf24)"
  return "var(--viz-negative, #f87171)"
}

function passRatio(ok: number, total: number): number {
  return total > 0 ? ok / total : 0
}

export function SemanticTestsWindow({ activeConnectionId, workspaceActive }: Props) {
  const [state, setState] = useState<SemanticTestsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [tag, setTag] = useState("")
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const [previewRun, setPreviewRun] = useState<number | null>(null)
  const [failures, setFailures] = useState<TestFailure[]>([])
  const [lastResult, setLastResult] = useState<string | null>(null)
  const [operatorQuery, setOperatorQuery] = useState("")
  const [operatorMode, setOperatorMode] = useState<OperatorMode>("all")
  const [selectedOperator, setSelectedOperator] = useState<string | null>(null)
  const [selectedTest, setSelectedTest] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, OperatorTestDetail[] | "loading">>({})
  const selectedOperatorRef = useRef<string | null>(null)

  const loadOperator = useCallback((operator: string) => {
    setSelectedOperator(operator)
    selectedOperatorRef.current = operator
    setSelectedTest(null)
    if (!activeConnectionId || details[operator] !== undefined) return
    setDetails((current) => ({ ...current, [operator]: "loading" }))
    void fetchOperatorTests(activeConnectionId, operator).then((tests) => {
      setDetails((current) => ({ ...current, [operator]: tests }))
    })
  }, [activeConnectionId, details])

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    try {
      const next = await fetchSemanticTests(activeConnectionId)
      setState(next)
      setSelectedRun((current) => {
        if (current != null && next.runs.some((run) => run.run_id === current)) return current
        return next.runs[0]?.run_id ?? null
      })

      const operator = selectedOperatorRef.current
      if (operator) {
        setDetails({ [operator]: "loading" })
        void fetchOperatorTests(activeConnectionId, operator).then((tests) => {
          setDetails({ [operator]: tests })
        })
      } else {
        setDetails({})
      }
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (!workspaceActive) return
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [workspaceActive, refresh])

  useEffect(() => {
    if (!activeConnectionId || selectedRun == null) return
    let cancelled = false
    void fetchFailures(activeConnectionId, selectedRun).then((next) => {
      if (!cancelled) setFailures(next)
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selectedRun])

  const onRun = useCallback(async () => {
    if (!activeConnectionId || running) return
    setRunning(true)
    setLastResult(null)
    const result = await runBattery(activeConnectionId, tag.trim())
    setRunning(false)
    if (result.ok) {
      setLastResult(`run #${result.run_id}: ${result.passed}/${result.tests} passed`)
      setSelectedRun(result.run_id ?? null)
      void refresh()
    } else {
      setLastResult(`battery failed: ${result.error}`)
    }
  }, [activeConnectionId, running, tag, refresh])

  if (!state) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-chrome-text/50">
        <div className="text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-brand-semantic-tests" />
          <div className="mt-2 font-mono text-[10px] uppercase tracking-wider">assembling test history</div>
        </div>
      </div>
    )
  }

  if (!state.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-doc-bg p-6 text-center">
        <Target className="h-7 w-7 text-chrome-text/40" />
        <div className="text-sm text-foreground">Semantic Tests not initialized</div>
        <div className="max-w-md text-[11px] leading-relaxed text-chrome-text/60">
          This warehouse has no <span className="font-mono">rvbbit.operator_test_runs</span> table yet.
          Operators can still run through <span className="font-mono">rvbbit.run_all_tests()</span>;
          the comparable drift history arrives with the Semantic Tests migration.
        </div>
        {state.error ? <div className="mt-2 max-w-lg font-mono text-[9px] text-danger/70">{state.error}</div> : null}
      </div>
    )
  }

  const chronologicalRuns = [...state.runs].reverse()
  const effectiveRunId = previewRun ?? selectedRun
  const effectiveRun = state.runs.find((run) => run.run_id === effectiveRunId) ?? state.runs[0] ?? null
  const committedRun = state.runs.find((run) => run.run_id === selectedRun) ?? null
  const matrixRuns = chronologicalRuns.slice(-12)
  const selectedDetails = selectedOperator ? details[selectedOperator] : undefined
  const previousRun = effectiveRun
    ? chronologicalRuns[chronologicalRuns.findIndex((run) => run.run_id === effectiveRun.run_id) - 1] ?? null
    : null

  const visibleOperators = filterOperators(
    state.operators,
    operatorQuery,
    operatorMode,
    effectiveRun?.run_id ?? null,
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-doc-bg text-foreground group-data-[focused=false]/window:bg-doc-bg/75">
      <header className="shrink-0 border-b border-chrome-border/60 bg-chrome-bg/30 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-brand-semantic-tests/40 bg-brand-semantic-tests/10">
            <Target className="h-4 w-4 text-brand-semantic-tests" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Semantic Tests</h2>
              <span className="font-mono text-[9px] uppercase tracking-wider text-chrome-text/45">honesty instrument</span>
            </div>
            <div className="font-mono text-[9px] text-chrome-text/55">
              {state.operators.length} operators · {state.operators.reduce((sum, operator) => sum + operator.n_tests, 0)} embedded tests · {state.runs.length} recent batteries
            </div>
          </div>

          <div className="ml-auto flex min-w-[260px] flex-1 flex-wrap items-center justify-end gap-1.5">
            <input
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="regime tag · model, prompt, or backend"
              className="h-7 min-w-[210px] max-w-[360px] flex-1 rounded-sm border border-chrome-border/60 bg-secondary-background/50 px-2 font-mono text-[10px] outline-none placeholder:text-chrome-text/35 focus:border-brand-semantic-tests/55"
            />
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={running}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-brand-semantic-tests/45 bg-brand-semantic-tests/8 px-2.5 text-[10px] text-brand-semantic-tests transition hover:bg-brand-semantic-tests/14 disabled:opacity-45"
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running ? "Running…" : "Run battery"}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-chrome-border/60 text-chrome-text transition hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-45"
              title="Refresh test history"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>
        </div>
        {lastResult ? (
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[9px] text-chrome-text/65">
            <CheckCircle2 className="h-3 w-3 text-brand-semantic-tests" />
            {lastResult}
          </div>
        ) : null}
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        <RunInstrument
          runs={chronologicalRuns}
          selectedRun={selectedRun}
          previewRun={previewRun}
          effectiveRun={effectiveRun}
          previousRun={previousRun}
          onPreview={setPreviewRun}
          onSelect={(runId) => {
            setSelectedRun(runId)
            setPreviewRun(null)
          }}
        />

        <div className="mt-3 grid min-h-[260px] flex-1 auto-rows-[minmax(260px,1fr)] grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] gap-3">
          <OperatorMatrix
            operators={visibleOperators}
            allCount={state.operators.length}
            runs={matrixRuns}
            selectedRun={selectedRun}
            previewRun={previewRun}
            selectedOperator={selectedOperator}
            query={operatorQuery}
            mode={operatorMode}
            onQuery={setOperatorQuery}
            onMode={setOperatorMode}
            onPreviewRun={setPreviewRun}
            onSelectRun={setSelectedRun}
            onSelectOperator={loadOperator}
          />

          <ContextInspector
            selectedRun={committedRun}
            failures={failures}
            selectedOperator={selectedOperator}
            details={selectedDetails}
            selectedTest={selectedTest}
            onSelectTest={setSelectedTest}
            onSelectOperator={loadOperator}
          />
        </div>
      </main>
    </div>
  )
}

function RunInstrument({
  runs,
  selectedRun,
  previewRun,
  effectiveRun,
  previousRun,
  onPreview,
  onSelect,
}: {
  runs: TestRun[]
  selectedRun: number | null
  previewRun: number | null
  effectiveRun: TestRun | null
  previousRun: TestRun | null
  onPreview: (runId: number | null) => void
  onSelect: (runId: number) => void
}) {
  const ratio = effectiveRun ? passRatio(effectiveRun.ok, effectiveRun.total) : 0
  const previousRatio = previousRun ? passRatio(previousRun.ok, previousRun.total) : null
  const delta = previousRatio == null ? null : ratio - previousRatio
  const failures = effectiveRun ? effectiveRun.total - effectiveRun.ok : 0
  const isPreview = previewRun != null && previewRun !== selectedRun

  return (
    <section className="shrink-0 overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/30">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(125px,1fr))] border-b border-chrome-border/45">
        <HeroMetric
          label={isPreview ? "previewing run" : "selected run"}
          value={effectiveRun ? `#${effectiveRun.run_id}` : "—"}
          detail={effectiveRun?.tag || "untagged regime"}
          tone="accent"
        />
        <HeroMetric
          label="pass rate"
          value={effectiveRun ? formatPercent(ratio) : "—"}
          detail={effectiveRun ? `${effectiveRun.ok} of ${effectiveRun.total}` : "no batteries yet"}
          tone={ratio >= 1 ? "success" : ratio >= 0.9 ? "warning" : "danger"}
        />
        <HeroMetric
          label="change"
          value={delta == null ? "—" : signedPercent(delta)}
          detail={previousRun ? `from run #${previousRun.run_id}` : "first visible run"}
          tone={delta == null || delta === 0 ? undefined : delta > 0 ? "success" : "danger"}
        />
        <HeroMetric
          label="failures"
          value={effectiveRun ? String(failures) : "—"}
          detail={effectiveRun ? `${effectiveRun.ops} operators exercised` : "select a run"}
          tone={failures > 0 ? "danger" : effectiveRun ? "success" : undefined}
        />
        <HeroMetric
          label="observed"
          value={effectiveRun ? formatRunTime(effectiveRun.ts) : "—"}
          detail={isPreview ? "release to return" : "hover the trajectory to preview"}
        />
      </div>

      <div className="relative h-32 min-w-0 px-3 pb-2 pt-3" onMouseLeave={() => onPreview(null)}>
        <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-1.5 text-[8px] uppercase tracking-[0.16em] text-chrome-text/45">
          <Activity className="h-3 w-3 text-brand-semantic-tests" />
          battery trajectory
        </div>
        <RunTrajectory
          runs={runs}
          selectedRun={selectedRun}
          previewRun={previewRun}
          onPreview={onPreview}
          onSelect={onSelect}
        />
      </div>
    </section>
  )
}

function RunTrajectory({
  runs,
  selectedRun,
  previewRun,
  onPreview,
  onSelect,
}: {
  runs: TestRun[]
  selectedRun: number | null
  previewRun: number | null
  onPreview: (runId: number | null) => void
  onSelect: (runId: number) => void
}) {
  if (runs.length === 0) {
    return <div className="grid h-full place-items-center font-mono text-[10px] text-chrome-text/40">run a battery to establish a trajectory</div>
  }

  const width = 600
  const height = 92
  const padX = 12
  const padTop = 10
  const padBottom = 18
  const innerHeight = height - padTop - padBottom
  const xFor = (index: number) => runs.length === 1
    ? width / 2
    : padX + (index / (runs.length - 1)) * (width - padX * 2)
  const yFor = (run: TestRun) => padTop + (1 - passRatio(run.ok, run.total)) * innerHeight
  const points = runs.map((run, index) => ({ run, x: xFor(index), y: yFor(run) }))
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
  const area = `${line} L ${points.at(-1)!.x} ${height - padBottom} L ${points[0].x} ${height - padBottom} Z`
  const activeId = previewRun ?? selectedRun

  return (
    <svg
      className="h-full w-full overflow-hidden"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Pass rate across recent semantic test batteries"
    >
      {[0.75, 0.9, 1].map((mark) => {
        const y = padTop + (1 - mark) * innerHeight
        return (
          <g key={mark}>
            <line x1={padX} x2={width - padX} y1={y} y2={y} stroke="var(--chrome-border)" strokeOpacity={mark === 1 ? 0.5 : 0.22} strokeDasharray={mark === 1 ? undefined : "3 4"} />
            <text x={width - 2} y={y + 2} textAnchor="end" fill="var(--chrome-text)" fillOpacity={0.38} fontSize={6}>{Math.round(mark * 100)}%</text>
          </g>
        )
      })}
      <path d={area} fill="var(--brand-semantic-tests)" fillOpacity={0.09} />
      <path d={line} fill="none" stroke="var(--brand-semantic-tests)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />

      {points.map((point, index) => {
        const bandWidth = (width - padX * 2) / Math.max(1, runs.length - 1)
        const left = index === 0 ? 0 : point.x - bandWidth / 2
        const right = index === runs.length - 1 ? width : point.x + bandWidth / 2
        const ratio = passRatio(point.run.ok, point.run.total)
        const active = point.run.run_id === activeId
        return (
          <g key={point.run.run_id}>
            {active ? <line x1={point.x} x2={point.x} y1={padTop - 3} y2={height - padBottom + 3} stroke={passTone(ratio)} strokeOpacity={0.45} strokeWidth={1} vectorEffect="non-scaling-stroke" /> : null}
            <circle cx={point.x} cy={point.y} r={active ? 4 : 2.8} fill={passTone(ratio)} stroke="var(--block-bg)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <rect
              x={left}
              y={0}
              width={right - left}
              height={height}
              fill="transparent"
              className="cursor-crosshair"
              onMouseEnter={() => onPreview(point.run.run_id)}
              onClick={() => onSelect(point.run.run_id)}
            >
              <title>{`run #${point.run.run_id} · ${point.run.ok}/${point.run.total} · ${point.run.tag || "untagged"}`}</title>
            </rect>
          </g>
        )
      })}
      <text x={padX} y={height - 3} fill="var(--chrome-text)" fillOpacity={0.42} fontSize={6}>#{runs[0].run_id}</text>
      <text x={width - padX} y={height - 3} textAnchor="end" fill="var(--chrome-text)" fillOpacity={0.42} fontSize={6}>#{runs.at(-1)!.run_id}</text>
    </svg>
  )
}

function HeroMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone?: "accent" | "success" | "warning" | "danger"
}) {
  return (
    <div className="min-w-0 border-b border-r border-chrome-border/35 px-3 py-2 last:border-r-0">
      <div className="text-[8px] uppercase tracking-[0.15em] text-chrome-text/42">{label}</div>
      <div className={cn(
        "mt-0.5 truncate font-mono text-lg leading-tight text-foreground",
        tone === "accent" && "text-brand-semantic-tests",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger",
      )} title={value}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[9px] text-chrome-text/45" title={detail}>{detail}</div>
    </div>
  )
}

function OperatorMatrix({
  operators,
  allCount,
  runs,
  selectedRun,
  previewRun,
  selectedOperator,
  query,
  mode,
  onQuery,
  onMode,
  onPreviewRun,
  onSelectRun,
  onSelectOperator,
}: {
  operators: OperatorTestSummary[]
  allCount: number
  runs: TestRun[]
  selectedRun: number | null
  previewRun: number | null
  selectedOperator: string | null
  query: string
  mode: OperatorMode
  onQuery: (query: string) => void
  onMode: (mode: OperatorMode) => void
  onPreviewRun: (runId: number | null) => void
  onSelectRun: (runId: number) => void
  onSelectOperator: (operator: string) => void
}) {
  const effectiveRun = previewRun ?? selectedRun
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/28">
      <div className="shrink-0 border-b border-chrome-border/45 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-medium">
              <Sparkles className="h-3 w-3 text-brand-semantic-tests" />
              Operator evidence matrix
            </div>
            <div className="text-[8px] text-chrome-text/40">rows are operators · columns are batteries</div>
          </div>
          <label className="relative ml-auto min-w-[170px] max-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/35" />
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Find an operator"
              className="h-7 w-full rounded-sm border border-chrome-border/55 bg-secondary-background/45 pl-7 pr-2 font-mono text-[9px] outline-none placeholder:text-chrome-text/35 focus:border-brand-semantic-tests/55"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {(["all", "failing", "unrun"] as OperatorMode[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onMode(option)}
              className={cn(
                "rounded-sm px-2 py-0.5 text-[8px] uppercase tracking-wider text-chrome-text/50 transition hover:bg-foreground/[0.05]",
                mode === option && "bg-brand-semantic-tests/12 text-brand-semantic-tests",
              )}
            >
              {option}
            </button>
          ))}
          <span className="ml-auto font-mono text-[8px] text-chrome-text/40">{operators.length}/{allCount} shown</span>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-[minmax(145px,1fr)_38px_minmax(150px,220px)_54px] items-center gap-2 border-b border-chrome-border/45 bg-block-bg/80 px-2 py-1 text-[7px] uppercase tracking-wider text-chrome-text/38">
        <span>operator</span>
        <span className="text-right">tests</span>
        <div className="flex min-w-0 justify-between px-0.5">
          <span>older</span><span>recent runs</span><span>newer</span>
        </div>
        <span className="text-right">at run</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onPreviewRun(null)}>
        {operators.length === 0 ? (
          <div className="grid h-40 place-items-center px-4 text-center font-mono text-[9px] text-chrome-text/40">
            no operators match this lens
          </div>
        ) : operators.map((operator) => {
          const selectedCell = operator.trend.find((cell) => cell.run === effectiveRun) ?? null
          const selectedRatio = selectedCell ? passRatio(selectedCell.ok, selectedCell.total) : null
          return (
            <div
              key={operator.operator}
              className={cn(
                "grid min-h-8 grid-cols-[minmax(145px,1fr)_38px_minmax(150px,220px)_54px] items-center gap-2 border-b border-chrome-border/25 px-2 transition-colors",
                selectedOperator === operator.operator ? "bg-brand-semantic-tests/9" : "hover:bg-foreground/[0.025]",
              )}
            >
              <button
                type="button"
                onClick={() => onSelectOperator(operator.operator)}
                className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
                title={`Inspect ${operator.operator}`}
              >
                <CaretRight className={cn("h-2.5 w-2.5 shrink-0 text-chrome-text/25 transition", selectedOperator === operator.operator && "translate-x-0.5 text-brand-semantic-tests")} />
                <span className="truncate font-mono text-[9px] text-foreground/80 group-hover:text-foreground">{operator.operator}</span>
              </button>
              <span className="text-right font-mono text-[8px] text-chrome-text/42">{operator.n_tests}</span>
              <div className="flex min-w-0 gap-[2px]">
                {runs.map((run) => {
                  const cell = operator.trend.find((entry) => entry.run === run.run_id) ?? null
                  const ratio = cell ? passRatio(cell.ok, cell.total) : null
                  const active = run.run_id === effectiveRun
                  return (
                    <button
                      key={run.run_id}
                      type="button"
                      onMouseEnter={() => onPreviewRun(run.run_id)}
                      onFocus={() => onPreviewRun(run.run_id)}
                      onBlur={() => onPreviewRun(null)}
                      onClick={() => {
                        onSelectRun(run.run_id)
                        onSelectOperator(operator.operator)
                      }}
                      title={cell ? `${operator.operator} · run #${run.run_id}: ${cell.ok}/${cell.total}` : `${operator.operator} · not exercised in run #${run.run_id}`}
                      className={cn(
                        "h-4 min-w-0 flex-1 rounded-[2px] outline-none transition-transform hover:-translate-y-px focus:-translate-y-px",
                        ratio == null && "bg-chrome-border/18",
                        active && "ring-1 ring-inset ring-foreground/70",
                      )}
                      style={ratio == null ? undefined : {
                        background: passTone(ratio),
                        opacity: 0.42 + ratio * 0.58,
                      }}
                    />
                  )
                })}
              </div>
              <span
                className="text-right font-mono text-[9px]"
                style={{ color: selectedRatio == null ? "var(--chrome-text)" : passTone(selectedRatio) }}
              >
                {selectedCell ? `${selectedCell.ok}/${selectedCell.total}` : "—"}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ContextInspector({
  selectedRun,
  failures,
  selectedOperator,
  details,
  selectedTest,
  onSelectTest,
  onSelectOperator,
}: {
  selectedRun: TestRun | null
  failures: TestFailure[]
  selectedOperator: string | null
  details: OperatorTestDetail[] | "loading" | undefined
  selectedTest: string | null
  onSelectTest: (test: string | null) => void
  onSelectOperator: (operator: string) => void
}) {
  const selectedDefinition = details && details !== "loading" && selectedTest
    ? details.find((test) => test.test_name === selectedTest) ?? null
    : null
  const operatorFailures = selectedOperator
    ? failures.filter((failure) => failure.operator === selectedOperator)
    : failures

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/28">
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border/45 px-3 py-2">
        <div className="grid h-7 w-7 place-items-center rounded-sm border border-brand-semantic-tests/35 bg-brand-semantic-tests/8">
          <Eye className="h-3.5 w-3.5 text-brand-semantic-tests" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[10px] font-medium">{selectedOperator ?? "Run evidence"}</div>
          <div className="truncate font-mono text-[8px] text-chrome-text/42">
            {selectedRun ? `run #${selectedRun.run_id} · ${selectedRun.tag || "untagged"}` : "select a battery or operator"}
          </div>
        </div>
        {selectedRun ? (
          <span className="ml-auto shrink-0 font-mono text-[9px]" style={{ color: passTone(passRatio(selectedRun.ok, selectedRun.total)) }}>
            {selectedRun.ok}/{selectedRun.total}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {selectedOperator ? (
          <div>
            <SectionLabel icon={TerminalSquare} label="embedded tests" right={details && details !== "loading" ? `${details.length}` : undefined} />
            {details === "loading" || details === undefined ? (
              <div className="flex items-center gap-1.5 rounded border border-chrome-border/35 px-2 py-3 font-mono text-[9px] text-chrome-text/40">
                <Loader2 className="h-3 w-3 animate-spin" /> reading test definitions…
              </div>
            ) : details.length === 0 ? (
              <div className="rounded border border-dashed border-chrome-border/45 px-2 py-3 text-center font-mono text-[9px] text-chrome-text/40">no embedded tests</div>
            ) : (
              <div className="space-y-1">
                {details.map((test) => {
                  const open = selectedTest === test.test_name
                  return (
                    <button
                      key={test.test_name}
                      type="button"
                      onClick={() => onSelectTest(open ? null : test.test_name)}
                      className={cn(
                        "w-full overflow-hidden rounded-sm border text-left transition",
                        open ? "border-brand-semantic-tests/45 bg-brand-semantic-tests/6" : "border-chrome-border/35 hover:border-chrome-border/60",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: test.passed == null ? "var(--chrome-border)" : passTone(test.passed ? 1 : 0) }} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-foreground/80">{test.test_name}</span>
                        <span className="shrink-0 font-mono text-[8px] text-chrome-text/40">{test.passed == null ? "unrun" : test.passed ? "pass" : "fail"}</span>
                        <CaretRight className={cn("h-2.5 w-2.5 shrink-0 text-chrome-text/35 transition-transform", open && "rotate-90")} />
                      </div>
                      {open ? (
                        <div className="border-t border-chrome-border/30 px-2 py-2">
                          {test.description ? <p className="mb-2 text-[9px] leading-relaxed text-chrome-text/60">{test.description}</p> : null}
                          <div className="grid grid-cols-2 gap-2">
                            <EvidenceValue label="expect" value={test.expect} />
                            <EvidenceValue label="actual" value={test.passed == null ? "never run" : test.actual || "∅"} tone={test.passed === false ? "danger" : undefined} />
                          </div>
                          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-background/55 p-2 font-mono text-[8px] leading-relaxed text-chrome-text/65">{test.sql || "-- no SQL recorded"}</pre>
                        </div>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="mb-3 rounded-sm border border-dashed border-brand-semantic-tests/30 bg-brand-semantic-tests/5 px-3 py-3 text-[9px] leading-relaxed text-chrome-text/55">
            Click an operator or matrix cell to bring its test definitions into this rail. Click a trajectory point to lock a historical run.
          </div>
        )}

        <div className={cn(selectedOperator && "mt-3")}>
          <SectionLabel
            icon={operatorFailures.length > 0 ? AlertTriangle : CheckCircle2}
            label={selectedOperator ? "failures for this operator" : "run failures"}
            right={selectedRun ? `#${selectedRun.run_id}` : undefined}
          />
          {!selectedRun ? (
            <div className="font-mono text-[9px] text-chrome-text/40">select a run</div>
          ) : operatorFailures.length === 0 ? (
            <div className="flex items-center gap-2 rounded-sm border border-success/25 bg-success/5 px-2.5 py-3 text-[9px] text-success/80">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {selectedOperator ? "this operator is green in the selected run" : "all tests are green in the selected run"}
            </div>
          ) : (
            <div className="space-y-1">
              {operatorFailures.map((failure, index) => (
                <button
                  key={`${failure.operator}:${failure.test_name ?? index}`}
                  type="button"
                  onClick={() => onSelectOperator(failure.operator)}
                  className="w-full rounded-sm border border-danger/25 bg-danger/[0.035] px-2 py-1.5 text-left transition hover:border-danger/45"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-danger/70" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-foreground/80">{failure.operator}</span>
                    <span className="truncate font-mono text-[8px] text-chrome-text/45">{failure.test_name ?? "unnamed"}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <EvidenceValue label="got" value={failure.actual || "∅"} tone="danger" />
                    <EvidenceValue label="expected" value={failure.expected || "?"} />
                  </div>
                  {failure.error ? <div className="mt-1 line-clamp-2 whitespace-pre-wrap font-mono text-[8px] text-danger/65">{failure.error}</div> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedDefinition ? (
        <div className="shrink-0 border-t border-chrome-border/35 px-3 py-1.5 font-mono text-[8px] text-chrome-text/40">
          latest logged result · run {selectedDefinition.last_run ?? "—"}
        </div>
      ) : null}
    </section>
  )
}

function SectionLabel({
  icon: Icon,
  label,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  right?: string
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[8px] uppercase tracking-[0.14em] text-chrome-text/45">
      <Icon className="h-3 w-3 text-brand-semantic-tests" />
      <span>{label}</span>
      {right ? <span className="ml-auto font-mono text-chrome-text/35">{right}</span> : null}
    </div>
  )
}

function EvidenceValue({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <div className="text-[7px] uppercase tracking-wider text-chrome-text/35">{label}</div>
      <div className={cn("truncate font-mono text-[8px] text-chrome-text/65", tone === "danger" && "text-danger/80")} title={value}>{value}</div>
    </div>
  )
}

function filterOperators(
  operators: OperatorTestSummary[],
  query: string,
  mode: OperatorMode,
  runId: number | null,
): OperatorTestSummary[] {
  const needle = query.trim().toLowerCase()
  return operators.filter((operator) => {
    if (needle && !operator.operator.toLowerCase().includes(needle)) return false
    if (mode === "all") return true
    const cell = runId == null ? null : operator.trend.find((entry) => entry.run === runId) ?? null
    if (mode === "unrun") return cell == null
    return cell != null && cell.ok < cell.total
  })
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`
}

function signedPercent(value: number): string {
  const percent = value * 100
  if (Math.abs(percent) < 0.05) return "0.0pt"
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}pt`
}

function formatRunTime(value: string): string {
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) return value ? value.slice(5, 16).replace("T", " ") : "—"
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
