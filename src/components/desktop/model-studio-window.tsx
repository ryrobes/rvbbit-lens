"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Brain, Play, Plus, RefreshCw } from "@/lib/icons"
import { fmtAgo, fmtCount } from "./instruments"
import { SqlEditor } from "./sql-editor"
import {
  fetchEvaluations,
  fetchModels,
  fetchPredictionReceipts,
  fetchPredictionStats,
  fetchRuns,
  ML_TASKS,
  predictRow,
  runEvaluate,
  trainModel,
  type FeatureSpec,
  type MlEvaluation,
  type MlModel,
  type MlRun,
  type PredictionReceipt,
  type PredictionStats,
} from "@/lib/rvbbit/model-studio"
import type { ModelStudioPayload } from "@/lib/desktop/types"

interface ModelStudioWindowProps {
  payload: ModelStudioPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
}

type SubTab = "overview" | "evaluate" | "predict" | "observe" | "train"

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-500",
  running: "bg-amber-500/15 text-amber-500",
  queued: "bg-amber-500/15 text-amber-500",
  failed: "bg-danger/15 text-danger",
  registered: "bg-foreground/[0.08] text-chrome-text/70",
  disabled: "bg-foreground/[0.08] text-chrome-text/60",
  dropped: "bg-foreground/[0.08] text-chrome-text/60",
}

function isClass(task: string) {
  return task === "classification" || task === "tabular_classification"
}

export function ModelStudioWindow({ payload, activeConnectionId, hasRvbbit }: ModelStudioWindowProps) {
  const [models, setModels] = useState<MlModel[]>([])
  const [installed, setInstalled] = useState(true)
  const [selected, setSelected] = useState<string | null>(payload.modelName ?? null)
  const [tab, setTab] = useState<SubTab>("overview")
  const [mode, setMode] = useState<"model" | "new">("model")
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const { models, installed } = await fetchModels(activeConnectionId)
    setModels(models)
    setInstalled(installed)
    setSelected((prev) => prev ?? models[0]?.name ?? null)
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { models, installed } = await fetchModels(activeConnectionId)
      if (cancelled) return
      setModels(models)
      setInstalled(installed)
      setSelected((prev) => prev ?? models[0]?.name ?? null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [activeConnectionId])

  const model = useMemo(() => models.find((m) => m.name === selected) ?? null, [models, selected])

  if (!activeConnectionId) return <Centered>Connect to a database to manage models.</Centered>
  if (!hasRvbbit) return <Centered>Model Studio needs the <span className="font-mono">rvbbit</span> extension.</Centered>

  return (
    <div className="flex h-full text-foreground">
      {/* Left rail: models */}
      <div className="flex w-56 shrink-0 flex-col border-r border-chrome-border/60 bg-chrome-bg/30">
        <div className="flex items-center justify-between border-b border-chrome-border/50 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium">
            <Brain className="h-3.5 w-3.5" style={{ color: "var(--brand-specialists)" }} /> Models
          </div>
          <button type="button" onClick={reload} title="Reload" className="text-chrome-text/50 hover:text-foreground">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => { setMode("new"); }}
          className={`flex items-center gap-1.5 border-b border-chrome-border/40 px-2 py-1.5 text-left text-[11px] ${
            mode === "new" ? "bg-foreground/[0.06] text-foreground" : "text-chrome-text/70 hover:bg-foreground/[0.04]"
          }`}
        >
          <Plus className="h-3 w-3" /> New model from SQL
        </button>
        <div className="min-h-0 flex-1 overflow-auto">
          {!installed ? (
            <p className="p-3 text-[10px] text-chrome-text/50">ml_models not found — load the ML catalog.</p>
          ) : models.length === 0 ? (
            <p className="p-3 text-[10px] text-chrome-text/50">{loading ? "loading…" : "No models yet. Create one →"}</p>
          ) : (
            models.map((m) => (
              <button
                key={m.name}
                type="button"
                onClick={() => { setSelected(m.name); setMode("model"); }}
                className={`flex w-full flex-col gap-0.5 border-b border-chrome-border/30 px-2 py-1.5 text-left ${
                  mode === "model" && selected === m.name ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11px] text-foreground">{m.name}</span>
                  <span className={`ml-auto shrink-0 rounded-full px-1.5 py-0 text-[8px] uppercase ${STATUS_TONE[m.status] ?? "bg-foreground/[0.07] text-chrome-text/60"}`}>
                    {m.status}
                  </span>
                </div>
                <span className="text-[9px] text-chrome-text/45">{m.task}{m.trainedAt ? ` · ${fmtAgo(m.trainedAt)}` : ""}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right pane */}
      <div className="min-w-0 flex-1">
        {mode === "new" ? (
          <TrainPane connectionId={activeConnectionId} seed={null} onQueued={reload} />
        ) : !model ? (
          <Centered>Select a model, or create one from SQL.</Centered>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-chrome-border/60 px-2 py-1">
              {(["overview", "evaluate", "predict", "observe", "train"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded-base px-2 py-0.5 text-[11px] capitalize ${
                    tab === t ? "bg-foreground/[0.10] text-foreground" : "text-chrome-text/60 hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === "overview" ? <OverviewTab model={model} connectionId={activeConnectionId} />
                : tab === "evaluate" ? <EvaluateTab model={model} connectionId={activeConnectionId} />
                : tab === "predict" ? <PredictTab model={model} connectionId={activeConnectionId} />
                : tab === "observe" ? <ObserveTab model={model} connectionId={activeConnectionId} />
                : <TrainPane connectionId={activeConnectionId} seed={model} onQueued={reload} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────

function OverviewTab({ model, connectionId }: { model: MlModel; connectionId: string }) {
  const [runs, setRuns] = useState<MlRun[]>([])
  useEffect(() => {
    let c = false
    ;(async () => { const r = await fetchRuns(connectionId, model.name); if (!c) setRuns(r) })()
    return () => { c = true }
  }, [connectionId, model.name])

  return (
    <div className="space-y-3">
      <Scorecard model={model} />
      {model.description ? <p className="text-[11px] text-chrome-text/70">{model.description}</p> : null}

      <Section title="Features">
        <div className="flex flex-wrap gap-1">
          {model.featureSchema.map((f) => (
            <span key={f.name} className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/80">
              {f.name}<span className="text-chrome-text/40"> {f.type}</span>
            </span>
          ))}
          {model.featureSchema.length === 0 ? <span className="text-[10px] text-chrome-text/40">none recorded</span> : null}
        </div>
        <div className="mt-1 text-[10px] text-chrome-text/55">
          predict op: <span className="font-mono text-chrome-text/80">rvbbit.{model.operatorName ?? "—"}(row)</span>
          {model.targetColumn ? <> · target: <span className="font-mono">{model.targetColumn}</span></> : null}
        </div>
      </Section>

      {model.sourceSql ? (
        <Section title="Training query (source_sql)">
          <pre className="max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[10px] text-chrome-text/80">{model.sourceSql}</pre>
        </Section>
      ) : null}

      <Section title={`Training runs (${runs.length})`}>
        <div className="space-y-1">
          {runs.length === 0 ? <span className="text-[10px] text-chrome-text/40">no runs</span> : runs.map((r) => (
            <div key={r.runId} className="flex items-center gap-2 text-[10px]">
              <span className={`rounded-full px-1.5 py-0.5 ${STATUS_TONE[r.status] ?? "bg-foreground/[0.07] text-chrome-text/60"}`}>{r.status}</span>
              <span className="text-chrome-text/50">{fmtAgo(r.createdAt ?? 0)}</span>
              {r.startedAt && r.finishedAt ? <span className="text-chrome-text/40">{Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000))}s</span> : null}
              {r.worker ? <span className="font-mono text-chrome-text/40">{r.worker}</span> : null}
              {r.error ? <span className="truncate text-danger">{r.error}</span> : null}
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

function Scorecard({ model }: { model: MlModel }) {
  const m = model.metrics
  const keys = isClass(model.task)
    ? ["accuracy", "balanced_accuracy", "f1_macro"]
    : ["r2", "rmse", "mae"]
  const tiles = keys.filter((k) => m[k] != null)
  return (
    <div className="flex flex-wrap gap-2">
      {tiles.length === 0 ? <span className="text-[10px] text-chrome-text/40">no training metrics recorded</span> : tiles.map((k) => (
        <div key={k} className="rounded-base border border-chrome-border/50 bg-chrome-bg/40 px-2.5 py-1">
          <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">{k}</div>
          <div className="font-mono text-[14px] text-foreground">{fmtNum(m[k])}</div>
        </div>
      ))}
      {m.estimator ? <div className="rounded-base border border-chrome-border/50 bg-chrome-bg/40 px-2.5 py-1">
        <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">estimator</div>
        <div className="font-mono text-[12px] text-foreground">{String(m.estimator)}</div>
      </div> : null}
      {m.train_rows != null ? <div className="rounded-base border border-chrome-border/50 bg-chrome-bg/40 px-2.5 py-1">
        <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">train / test</div>
        <div className="font-mono text-[12px] text-foreground">{fmtCount(Number(m.train_rows))} / {fmtCount(Number(m.test_rows ?? 0))}</div>
      </div> : null}
    </div>
  )
}

// ── Evaluate ─────────────────────────────────────────────────────────

function EvaluateTab({ model, connectionId }: { model: MlModel; connectionId: string }) {
  const [evalSql, setEvalSql] = useState(model.sourceSql ?? `SELECT * FROM your_holdout_table`)
  const [history, setHistory] = useState<MlEvaluation[]>([])
  const [active, setActive] = useState<MlEvaluation | null>(null)
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastSql, setLastSql] = useState<string | null>(null)

  const load = useCallback(async () => {
    const h = await fetchEvaluations(connectionId, model.name)
    setHistory(h)
    setActive((prev) => prev ?? h[0] ?? null)
  }, [connectionId, model.name])

  useEffect(() => { let c = false; (async () => { const h = await fetchEvaluations(connectionId, model.name); if (!c) { setHistory(h); setActive(h[0] ?? null) } })(); return () => { c = true } }, [connectionId, model.name])

  const run = useCallback(async () => {
    setRunning(true); setErr(null)
    const { evaluation, error, sql } = await runEvaluate(connectionId, model.name, evalSql, model.targetColumn, null)
    setLastSql(sql)
    if (error) setErr(error)
    else if (evaluation) { setActive(evaluation); await load() }
    setRunning(false)
  }, [connectionId, model.name, evalSql, model.targetColumn, load])

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-chrome-text/70">
        Run <span className="font-mono">{model.operatorName}</span> over a labeled query and compare to{" "}
        <span className="font-mono">{model.targetColumn ?? "(target)"}</span>.
      </div>
      <div className="overflow-hidden rounded-base border border-chrome-border/60">
        <div className="h-32"><SqlEditor value={evalSql} onChange={setEvalSql} onRun={run} /></div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={run} disabled={running}
          className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2.5 py-1 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-50">
          <Play className="h-3 w-3" /> {running ? "Evaluating…" : "Evaluate"}
        </button>
        {lastSql ? <CopySql sql={lastSql} /> : null}
      </div>
      {err ? <p className="text-[11px] text-danger">{err}</p> : null}
      {active ? <EvalResult evaluation={active} task={model.task} /> : null}

      {history.length > 1 ? (
        <Section title="Evaluation history">
          <div className="space-y-1">
            {history.map((e) => (
              <button key={e.evalId} type="button" onClick={() => setActive(e)}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[10px] ${active?.evalId === e.evalId ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]"}`}>
                <span className={`rounded-full px-1.5 py-0.5 ${STATUS_TONE[e.status === "ok" ? "active" : "failed"] ?? ""}`}>{e.status}</span>
                <span className="text-chrome-text/50">{fmtAgo(e.createdAt ?? 0)}</span>
                <span className="text-chrome-text/70">{fmtCount(e.nRows ?? 0)} rows</span>
                <span className="ml-auto font-mono text-chrome-text/60">{evalHeadline(e, model.task)}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

function EvalResult({ evaluation, task }: { evaluation: MlEvaluation; task: string }) {
  const m = evaluation.metrics
  if (evaluation.status === "failed") return <p className="text-[11px] text-danger">{evaluation.error}</p>
  if (isClass(task)) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <BigMetric label="accuracy" value={fmtNum(m.accuracy)} />
          <span className="text-[10px] text-chrome-text/50">{fmtCount(evaluation.nRows ?? 0)} rows · holdout vs this query</span>
        </div>
        <ConfusionMatrix labels={(m.labels as string[]) ?? []} cells={(m.confusion as Array<{ actual: string; predicted: string; n: number }>) ?? []} />
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <BigMetric label="R²" value={fmtNum(m.r2)} />
        <BigMetric label="RMSE" value={fmtNum(m.rmse)} />
        <BigMetric label="MAE" value={fmtNum(m.mae)} />
        <span className="text-[10px] text-chrome-text/50">{fmtCount(evaluation.nRows ?? 0)} rows</span>
      </div>
      <ResidualScatter sample={(m.residual_sample as Array<{ actual: number; pred: number }>) ?? []} />
    </div>
  )
}

function ConfusionMatrix({ labels, cells }: { labels: string[]; cells: Array<{ actual: string; predicted: string; n: number }> }) {
  if (labels.length === 0) return <p className="text-[10px] text-chrome-text/40">no predictions</p>
  const key = (a: string, p: string) => `${a} ${p}`
  const map = new Map(cells.map((c) => [key(c.actual, c.predicted), c.n]))
  const max = Math.max(1, ...cells.map((c) => c.n))
  return (
    <div className="inline-block">
      <div className="mb-0.5 text-[9px] text-chrome-text/45">rows = actual · cols = predicted</div>
      <div className="grid" style={{ gridTemplateColumns: `auto repeat(${labels.length}, 30px)` }}>
        <div />
        {labels.map((p) => <div key={`h${p}`} className="px-1 text-center font-mono text-[9px] text-chrome-text/55">{p}</div>)}
        {labels.map((a) => (
          <FragmentRow key={`r${a}`} a={a} labels={labels} map={map} max={max} keyFn={key} />
        ))}
      </div>
    </div>
  )
}

function FragmentRow({ a, labels, map, max, keyFn }: { a: string; labels: string[]; map: Map<string, number>; max: number; keyFn: (a: string, p: string) => string }) {
  return (
    <>
      <div className="pr-1 text-right font-mono text-[9px] leading-[26px] text-chrome-text/55">{a}</div>
      {labels.map((p) => {
        const n = map.get(keyFn(a, p)) ?? 0
        const diag = a === p
        const intensity = n / max
        const bg = diag
          ? `color-mix(in oklch, var(--brand-kg) ${Math.round(20 + intensity * 60)}%, transparent)`
          : n > 0 ? `color-mix(in oklch, var(--danger) ${Math.round(15 + intensity * 55)}%, transparent)` : "transparent"
        return (
          <div key={p} className="m-0.5 grid h-[26px] place-items-center rounded font-mono text-[10px] text-foreground" style={{ background: bg, border: "1px solid var(--chrome-border)" }}>
            {n > 0 ? n : ""}
          </div>
        )
      })}
    </>
  )
}

function ResidualScatter({ sample }: { sample: Array<{ actual: number; pred: number }> }) {
  if (sample.length === 0) return <p className="text-[10px] text-chrome-text/40">no residuals</p>
  const xs = sample.map((s) => Number(s.actual)), ys = sample.map((s) => Number(s.pred))
  const lo = Math.min(...xs, ...ys), hi = Math.max(...xs, ...ys)
  const span = hi - lo || 1
  const W = 220, H = 160, pad = 6
  const sx = (v: number) => pad + ((v - lo) / span) * (W - 2 * pad)
  const sy = (v: number) => H - pad - ((v - lo) / span) * (H - 2 * pad)
  return (
    <svg width={W} height={H} className="rounded-base border border-chrome-border/50 bg-background/40">
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke="var(--chrome-border)" strokeDasharray="3 3" />
      {sample.map((s, i) => (
        <circle key={i} cx={sx(Number(s.actual))} cy={sy(Number(s.pred))} r={2.5} fill="var(--brand-kg)" fillOpacity={0.7} />
      ))}
      <text x={pad} y={H - 1} className="fill-current text-[8px] text-chrome-text/40">actual →</text>
      <text x={pad} y={9} className="fill-current text-[8px] text-chrome-text/40">pred ↑</text>
    </svg>
  )
}

// ── Predict ──────────────────────────────────────────────────────────

function PredictTab({ model, connectionId }: { model: MlModel; connectionId: string }) {
  const [row, setRow] = useState<Record<string, string>>({})
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastSql, setLastSql] = useState<string | null>(null)

  const numeric = (t: string) => /int|float|numeric|double|real|decimal/i.test(t)

  const run = useCallback(async () => {
    if (!model.operatorName) { setErr("model has no predict operator"); return }
    setBusy(true); setErr(null); setResult(null)
    const built: Record<string, unknown> = {}
    for (const f of model.featureSchema) {
      const raw = row[f.name]
      if (raw == null || raw === "") continue
      built[f.name] = numeric(f.type) ? Number(raw) : raw
    }
    const { prediction, error, sql } = await predictRow(connectionId, model.operatorName, built)
    setLastSql(sql)
    if (error) setErr(error)
    else if (prediction == null) setErr("Operator returned NULL — the serving backend rejected this row (often missing/invalid features). Fill all features and check the sidecar is healthy.")
    else setResult(prediction)
    setBusy(false)
  }, [connectionId, model.operatorName, model.featureSchema, row])

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-chrome-text/70">Try a single row through <span className="font-mono">{model.operatorName}</span>.</div>
      <div className="grid grid-cols-2 gap-2">
        {model.featureSchema.map((f) => (
          <label key={f.name} className="flex flex-col gap-0.5">
            <span className="font-mono text-[9px] text-chrome-text/55">{f.name} <span className="text-chrome-text/35">{f.type}</span></span>
            <input
              type={numeric(f.type) ? "number" : "text"}
              value={row[f.name] ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, [f.name]: e.target.value }))}
              className="rounded-base border border-chrome-border/60 bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none"
            />
          </label>
        ))}
        {model.featureSchema.length === 0 ? <span className="text-[10px] text-chrome-text/40">no feature schema recorded</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={run} disabled={busy}
          className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2.5 py-1 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-50">
          <Play className="h-3 w-3" /> {busy ? "Predicting…" : "Predict"}
        </button>
        {lastSql ? <CopySql sql={lastSql} /> : null}
      </div>
      {err ? <p className="text-[11px] text-danger">{err}</p> : null}
      {result != null ? <PredictionView prediction={result} task={model.task} /> : null}
    </div>
  )
}

function PredictionView({ prediction, task }: { prediction: unknown; task: string }) {
  const p = (prediction && typeof prediction === "object" ? prediction : {}) as Record<string, unknown>
  const scores = Array.isArray(p.scores) ? (p.scores as Array<{ label?: string; score?: number }>) : []
  const headline = isClass(task) ? String(p.label ?? p.prediction ?? "—") : fmtNum(p.value ?? p.prediction ?? p.score)
  return (
    <div className="rounded-base border border-chrome-border/60 bg-chrome-bg/40 p-2.5">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">prediction</div>
      <div className="font-mono text-[20px] text-foreground">{headline}</div>
      {scores.length > 0 ? (
        <div className="mt-1.5 space-y-0.5">
          {scores.slice(0, 8).map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="w-16 truncate font-mono text-[9px] text-chrome-text/60">{s.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${Math.round((Number(s.score) || 0) * 100)}%`, background: "var(--brand-kg)" }} />
              </div>
              <span className="w-8 text-right font-mono text-[9px] text-chrome-text/45">{(Number(s.score) || 0).toFixed(2)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-background/50 p-1.5 font-mono text-[9px] text-chrome-text/60">{JSON.stringify(prediction, null, 2)}</pre>
    </div>
  )
}

// ── Observe ──────────────────────────────────────────────────────────

function ObserveTab({ model, connectionId }: { model: MlModel; connectionId: string }) {
  const [stats, setStats] = useState<PredictionStats | null>(null)
  const [receipts, setReceipts] = useState<PredictionReceipt[]>([])
  const op = model.operatorName
  useEffect(() => {
    if (!op) return
    let c = false
    ;(async () => {
      const [s, r] = await Promise.all([fetchPredictionStats(connectionId, op), fetchPredictionReceipts(connectionId, op, 25)])
      if (!c) { setStats(s); setReceipts(r) }
    })()
    return () => { c = true }
  }, [connectionId, op])

  if (!op) return <Centered>no predict operator</Centered>
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <BigMetric label="predictions" value={fmtCount(stats?.nInvocations ?? 0)} />
        <BigMetric label="avg latency" value={stats && stats.nInvocations ? `${Math.round(stats.totalLatencyMs / stats.nInvocations)}ms` : "—"} />
        <BigMetric label="last" value={stats?.lastAt ? fmtAgo(stats.lastAt) : "—"} />
      </div>
      <Section title={`Recent predictions (${receipts.length})`}>
        <div className="space-y-1">
          {receipts.length === 0 ? <span className="text-[10px] text-chrome-text/40">no predictions logged yet</span> : receipts.map((r) => (
            <div key={r.receiptId} className="flex items-center gap-2 rounded bg-foreground/[0.02] px-1.5 py-1 text-[10px]">
              <span className="text-chrome-text/45">{fmtAgo(r.invocationAt ?? 0)}</span>
              {r.latencyMs != null ? <span className="font-mono text-chrome-text/40">{r.latencyMs}ms</span> : null}
              <span className="ml-auto max-w-[55%] truncate font-mono text-chrome-text/75">
                {r.error ? <span className="text-danger">{r.error}</span> : shortJson(r.parsed ?? r.output)}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ── Train ────────────────────────────────────────────────────────────

function TrainPane({ connectionId, seed, onQueued }: { connectionId: string; seed: MlModel | null; onQueued: () => void }) {
  const [name, setName] = useState(seed?.name ?? "")
  const [task, setTask] = useState(seed?.task || "classification")
  const [target, setTarget] = useState(seed?.targetColumn ?? "")
  const [sourceSql, setSourceSql] = useState(seed?.sourceSql ?? "SELECT * FROM your_training_table")
  const [features, setFeatures] = useState(JSON.stringify(seed?.featureSchema ?? [], null, 0))
  const [opts, setOpts] = useState(JSON.stringify(seed?.trainingOpts ?? { estimator: "random_forest", test_size: 0.25 }, null, 0))
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const queue = useCallback(async () => {
    setBusy(true); setErr(null); setMsg(null)
    let featureSchema: FeatureSpec[] = []
    let trainingOpts: Record<string, unknown> = {}
    try { featureSchema = JSON.parse(features || "[]") } catch { setErr("feature_schema is not valid JSON"); setBusy(false); return }
    try { trainingOpts = JSON.parse(opts || "{}") } catch { setErr("training_opts is not valid JSON"); setBusy(false); return }
    const { runId, error } = await trainModel(connectionId, { modelName: name, sourceSql, targetColumn: target, task, featureSchema, trainingOpts })
    if (error) setErr(error)
    else { setMsg(`Queued run ${runId?.slice(0, 8)} — a rvbbit-trainer worker must claim it to train.`); onQueued() }
    setBusy(false)
  }, [connectionId, name, sourceSql, target, task, features, opts, onQueued])

  return (
    <div className="space-y-2 p-3">
      <div className="text-[12px] font-medium">{seed ? `Retrain ${seed.name}` : "New model from SQL"}</div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="model_name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="my_model" /></Field>
        <Field label="task">
          <select value={task} onChange={(e) => setTask(e.target.value)} className={inputCls}>
            {ML_TASKS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="target_column"><input value={target} onChange={(e) => setTarget(e.target.value)} className={inputCls} placeholder="label" /></Field>
      </div>
      <Field label="source_sql (features + target column)">
        <div className="h-28 overflow-hidden rounded-base border border-chrome-border/60"><SqlEditor value={sourceSql} onChange={setSourceSql} onRun={queue} /></div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="feature_schema (jsonb)"><textarea value={features} onChange={(e) => setFeatures(e.target.value)} rows={2} className={`${inputCls} font-mono`} placeholder='[{"name":"x","type":"float8"}]' /></Field>
        <Field label="training_opts (jsonb)"><textarea value={opts} onChange={(e) => setOpts(e.target.value)} rows={2} className={`${inputCls} font-mono`} /></Field>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={queue} disabled={busy || !name || !target}
          className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2.5 py-1 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-50">
          <Play className="h-3 w-3" /> {busy ? "Queueing…" : "Queue training"}
        </button>
        <CopySql sql={trainModelSqlPreview({ name, sourceSql, target, task, features, opts })} />
      </div>
      {err ? <p className="text-[11px] text-danger">{err}</p> : null}
      {msg ? <p className="text-[11px] text-chrome-text/70">{msg}</p> : null}
      <p className="text-[10px] text-chrome-text/45">Note: training enqueues a run; a <span className="font-mono">rvbbit-trainer</span> worker must be running to fit + register the model.</p>
    </div>
  )
}

function trainModelSqlPreview(f: { name: string; sourceSql: string; target: string; task: string; features: string; opts: string }): string {
  return `SELECT rvbbit.train_model(\n  model_name => '${f.name}',\n  source_sql => $sql$${f.sourceSql}$sql$,\n  target_column => '${f.target}',\n  task => '${f.task}',\n  feature_schema => '${f.features}'::jsonb,\n  training_opts => '${f.opts}'::jsonb\n);`
}

// ── shared bits ──────────────────────────────────────────────────────

const inputCls = "w-full rounded-base border border-chrome-border/60 bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-0.5"><span className="text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</span>{children}</label>
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-chrome-text/45">{title}</div>{children}</div>
}
function BigMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-base border border-chrome-border/50 bg-chrome-bg/40 px-2.5 py-1">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</div>
      <div className="font-mono text-[16px] text-foreground">{value}</div>
    </div>
  )
}
function CopySql({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1200) }}
      className="rounded-base border border-chrome-border/50 px-2 py-1 text-[10px] text-chrome-text/60 hover:bg-foreground/[0.06] hover:text-foreground" title={sql}>
      {copied ? "copied" : "copy SQL"}
    </button>
  )
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-8 text-center text-[11px] leading-relaxed text-chrome-text/60"><div className="max-w-md space-y-2">{children}</div></div>
}

function fmtNum(v: unknown): string {
  if (v == null) return "—"
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)
}
function shortJson(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s && s.length > 80 ? s.slice(0, 79) + "…" : (s ?? "—")
}
function evalHeadline(e: MlEvaluation, task: string): string {
  const m = e.metrics
  return isClass(task) ? `acc ${fmtNum(m.accuracy)}` : `r² ${fmtNum(m.r2)} · rmse ${fmtNum(m.rmse)}`
}
