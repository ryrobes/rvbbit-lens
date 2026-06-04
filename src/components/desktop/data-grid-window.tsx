"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Boxes,
  Clock,
  Download,
  FileCode2,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RotateCcw,
  Sigma,
  Table2,
  TreeStructure,
} from "@/lib/icons"
import { format as formatSql } from "sql-formatter"
import { ChartView } from "./chart-view"
import { ResultGrid } from "./result-grid"
import { SingleCellCallout } from "./single-cell-callout"
import { SqlEditor } from "./sql-editor"
import { TimeTravelStrip } from "./time-travel-strip"
import { ExplainGraph, parseExplainResult, type ExplainRoot } from "./explain-graph"
import { Button } from "@/components/ui/button"
import type {
  DataPayload,
  DesktopColumnRef,
  DesktopParamOperator,
  DesktopParamValue,
  DesktopWindowState,
  RollupGrain,
  RollupSpec,
} from "@/lib/desktop/types"
import { effectiveRollup } from "@/lib/desktop/sql-builder"
import { reconcileRollupLineage } from "@/lib/desktop/rollup-sql-parse"
import { rollupChartSpec } from "@/lib/desktop/rollup-chart"
import { classifyColumn } from "@/lib/desktop/chart-infer"
import { RollupShelf, type FilterKind } from "./rollup-shelf"
import type { QueryResult } from "@/lib/db/types"
import { cn } from "@/lib/utils"
import { rowsToCsv } from "@/lib/sql/format"
import { hasTopLevelThen, wrapFlow, expandFlowResult } from "@/lib/sql/then-rewrite"
import {
  buildDesktopRuntimeGraph,
  paramKey,
  shortParamValue,
  slugifyBlockName,
  sourceSqlForPayload,
  uniqueBlockName,
} from "@/lib/desktop/reactive-sql"
import { writeBlockDragPayload } from "@/lib/desktop/block-drag"
import { hasParamDragPayload, readParamDragPayload } from "@/lib/desktop/param-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"

interface DataGridWindowProps {
  window: DesktopWindowState
  payload: DataPayload
  activeConnectionId: string | null
  /** Whether the active connection has the pg_rvbbit extension —
   *  enables EXPLAIN (SEMANTIC) for the semantic cost projection. */
  hasRvbbit: boolean
  allWindows: DesktopWindowState[]
  params: DesktopParamValue[]
  runSignal: number
  onChangePayload: (mutate: (payload: DataPayload) => DataPayload) => void
  onSaveAsViewApp: (sql: string, title?: string) => void
  onEmitParam: (input: {
    sourceWindowId: string
    sourceBlockName: string
    sourceTitle: string
    field: string
    value: unknown
    operator?: DesktopParamOperator
    dataTypeId?: number
    type?: string
  }) => void
  onSubscribeParam: (key: string, targetField?: string) => void
  /**
   * Apply a pure transform to this window's rollup spec (shelf edits).
   * Rebuilds SQL/title at the host so the window chrome stays in sync.
   */
  onEditRollup?: (transform: (s: RollupSpec) => RollupSpec) => void
  /** Re-pivot with a new temporal grain (re-probes distinct values). */
  onRepivot?: (grain: RollupGrain) => void
  /** Probe distinct source values for a column (WHERE filter multi-select). */
  onProbeValues?: (column: DesktopColumnRef, search?: string) => Promise<{ values: (string | number | null)[]; truncated: boolean }>
  /**
   * Round-trip back into the KG when this Data window was opened from a
   * KG evidence row (i.e. payload.sourceContext is set). Phase 2's
   * reverse bridge.
   */
  onOpenKgForSource?: (ctx: import("@/lib/desktop/types").KgSourceContext) => void
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; sql: string; startedAt: number }
  | { kind: "done"; result: QueryResult }
  | { kind: "error"; error: string; code?: string; detail?: string; hint?: string }

type ExplainState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; plan: ExplainRoot; analyzed: boolean }
  | { kind: "error"; message: string }

type FlowStepRow = {
  step_idx: number
  stage: string
  spec: string | null
  generated_sql: string | null
  n_rows: number
  rows: Record<string, unknown>[]
}

const FLOW_STEPS_SQL =
  "SELECT step_idx, stage, spec, generated_sql, n_rows, rows FROM rvbbit.flow_steps " +
  "WHERE run_id = (SELECT run_id FROM rvbbit.flow_steps ORDER BY created_at DESC LIMIT 1) " +
  "ORDER BY step_idx"

export function DataGridWindow({
  window: w,
  payload,
  activeConnectionId,
  hasRvbbit,
  allWindows,
  params,
  runSignal,
  onChangePayload,
  onSaveAsViewApp,
  onEmitParam,
  onSubscribeParam,
  onEditRollup,
  onRepivot,
  onProbeValues,
  onOpenKgForSource,
}: DataGridWindowProps) {
  const view = payload.view ?? {}
  const [draftSql, setDraftSql] = useState<string>(view.sqlDraft ?? payload.sql ?? "")
  // Tracks the last `payload.sql` we've reconciled with the local draft.
  // The sync-and-rerun effect lives further down so it can call runSql.
  const lastSyncedSqlRef = useRef<string>(payload.sql ?? "")
  // Run nonce — every runSql call grabs a fresh number. When two runs
  // overlap (e.g. user drops two columns into a rollup before the first
  // network round-trip returns), only the latest call's resolution is
  // allowed to write payload.sql back; older resolutions would otherwise
  // revert the most recent merge.
  const runNonceRef = useRef(0)
  // Baseline for the rerun-on-compiled-SQL effect. Lives up here (rather
  // than next to that effect) so the external-SQL sync effect can pin it.
  const prevCompiledRef = useRef<string | null>(null)
  const [runState, setRunState] = useState<RunState>({ kind: "idle" })
  const [explainState, setExplainState] = useState<ExplainState>({ kind: "idle" })
  const [explainBusy, setExplainBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<NonNullable<DataPayload["view"]>["activeTab"]>(view.activeTab ?? (payload.origin === "table" ? "rows" : "sql"))
  const [sqlRailOpen, setSqlRailOpen] = useState<boolean>(view.sqlRailOpen ?? (payload.origin !== "table"))
  const [paramDropHot, setParamDropHot] = useState(false)
  // Pipeline-cascade run state: when the last run was a `… then op(…)` pipeline,
  // the Steps inspector reads rvbbit.flow_steps to show each stage's rowset.
  const [isPipelineRun, setIsPipelineRun] = useState(false)
  const [flowSteps, setFlowSteps] = useState<FlowStepRow[] | null>(null)
  const [activeStep, setActiveStep] = useState(0)
  const [flowStepsError, setFlowStepsError] = useState<string | null>(null)

  const blockName = useMemo(() => {
    if (payload.reactive?.blockName) return payload.reactive.blockName
    return uniqueBlockName(payload.title || w.title || w.id, allWindows, w.id)
  }, [allWindows, payload.reactive?.blockName, payload.title, w.id, w.title])

  // First time this window opens, persist its unique block name into
  // the payload so subsequent renders see the same name and other
  // windows can resolve block.<name> references against it.
  useEffect(() => {
    if (payload.reactive?.blockName) return
    onChangePayload((p) => ({
      ...p,
      reactive: {
        blockName,
        sourceSql: sourceSqlForPayload(p),
        paramSubscriptions: p.reactive?.paramSubscriptions ?? [],
        version: 1,
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Compile this window's SQL through the runtime graph so block.X and
  // param.X.Y references rewrite, and subscriptions become WHERE clauses.
  const compiledSql = useMemo(() => {
    const graph = buildDesktopRuntimeGraph(allWindows, params)
    const block = graph.blocks.get(w.id)
    return block?.compiledSql ?? payload.sql
  }, [allWindows, params, payload.sql, w.id])

  const subscriptions = payload.reactive?.paramSubscriptions ?? []

  // Sync local draft → payload (debounced). We keep onChangePayload in a
  // ref so its identity doesn't re-fire this effect on every parent
  // render — the parent inlines a fresh arrow per render, and without
  // the ref this becomes a render loop that churns setWindows every
  // 250ms (and starves the global undo-snapshot debounce).
  const onChangePayloadRef = useRef(onChangePayload)
  useEffect(() => { onChangePayloadRef.current = onChangePayload }, [onChangePayload])
  useEffect(() => {
    const handle = setTimeout(() => {
      onChangePayloadRef.current((p) => ({
        ...p,
        view: { ...(p.view ?? {}), sqlDraft: draftSql, sqlRailOpen, activeTab },
      }))
    }, 250)
    return () => clearTimeout(handle)
  }, [draftSql, sqlRailOpen, activeTab])

  // First mount: auto-run for windows that already have a real SQL body
  // (table previews, drag-out aggregations, block-ref spawns). Skip the
  // hand-typed "SELECT 1" scratch start.
  useEffect(() => {
    if (runState.kind !== "idle" || !activeConnectionId) return
    const isAutoRunOrigin = payload.origin === "table" || payload.origin === "derived"
    if (!isAutoRunOrigin) return
    void runSql(payload.sql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runSql = useCallback(async (sourceSql: string) => {
    if (!activeConnectionId) return
    const trimmedSource = sourceSql.trim()
    if (!trimmedSource) return
    const myNonce = ++runNonceRef.current
    // Compile *this draft* against the runtime graph by patching the
    // window's source SQL into the graph build. The simpler path: build
    // the graph against the live windows array, swap the active window's
    // source for the draft, and pull the compiled SQL.
    const graph = buildDesktopRuntimeGraph(
      allWindows.map((win) =>
        win.id === w.id && win.kind === "data"
          ? {
              ...win,
              payload: {
                ...(win.payload as DataPayload),
                reactive: {
                  ...((win.payload as DataPayload).reactive ?? { blockName, paramSubscriptions: subscriptions, version: 1 }),
                  sourceSql: trimmedSource,
                  blockName,
                },
              } satisfies DataPayload,
            }
          : win,
      ),
      params,
    )
    const compiled = graph.blocks.get(w.id)?.compiledSql ?? trimmedSource
    // Pipeline cascade sugar: a bare `select … then op(…)` is wrapped as
    // rvbbit.flow($$…$$) so the THENs never hit the PG parser. Detection mirrors
    // the engine splitter (CASE…THEN / strings / comments are left untouched).
    const isPipeline = hasTopLevelThen(compiled)
    const toRun = isPipeline ? wrapFlow(compiled) : compiled
    if (isPipeline) {
      setFlowSteps(null)
      setFlowStepsError(null)
      setActiveStep(0)
    }
    setRunState({ kind: "running", sql: compiled, startedAt: Date.now() })
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          sql: toRun,
          rowLimit: 5000,
          readOnly: false,
        }),
      })
      const body = (await res.json()) as
        | (QueryResult & { ok: true })
        | { ok: false; error: string; code?: string; detail?: string; hint?: string }
      // A newer run started while this fetch was in flight — drop the
      // result so it doesn't overwrite state owned by the later run.
      if (runNonceRef.current !== myNonce) return
      if (body.ok === false) {
        setRunState({ kind: "error", error: body.error, code: body.code, detail: body.detail, hint: body.hint })
        setIsPipelineRun(false)
      } else {
        // flow() returns a single jsonb column per row; expand it into columns.
        const finalResult = isPipeline ? expandFlowResult(body) : body
        setIsPipelineRun(isPipeline)
        setRunState({ kind: "done", result: finalResult })
        // Record the compiled SQL that just succeeded, so the auto-rerun
        // effect treats *this* as the baseline (not the unfiltered first
        // render).
        prevCompiledRef.current = compiled
        onChangePayload((p) => ({
          ...p,
          sql: trimmedSource,
          // Keep the rollup shelf in sync with hand-edited SQL: re-parse the
          // run SQL back into a spec where we can, else detach the shelf.
          lineage: p.lineage ? reconcileRollupLineage(p.lineage, trimmedSource) : p.lineage,
          reactive: {
            blockName,
            sourceSql: trimmedSource,
            paramSubscriptions: subscriptions,
            version: (p.reactive?.version ?? 1) + 1,
          },
        }))
        if (activeTab === "sql") setActiveTab("rows")
      }
    } catch (e) {
      if (runNonceRef.current !== myNonce) return
      setRunState({ kind: "error", error: e instanceof Error ? e.message : String(e) })
    }
  }, [activeConnectionId, activeTab, allWindows, blockName, onChangePayload, params, subscriptions, w.id])

  const onRun = useCallback(() => { void runSql(draftSql || payload.sql) }, [draftSql, payload.sql, runSql])

  // Lazily load per-step rowsets for the Steps inspector when that tab opens.
  useEffect(() => {
    if (activeTab !== "steps" || !isPipelineRun || flowSteps !== null || !activeConnectionId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: activeConnectionId,
            sql: FLOW_STEPS_SQL,
            rowLimit: 500,
            readOnly: true,
          }),
        })
        const body = (await res.json()) as
          | { ok: true; rows: FlowStepRow[] }
          | { ok: false; error: string }
        if (cancelled) return
        if (body.ok === false) {
          setFlowStepsError(body.error)
          setFlowSteps([])
        } else {
          setFlowSteps(body.rows ?? [])
          setFlowStepsError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setFlowStepsError(e instanceof Error ? e.message : String(e))
          setFlowSteps([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeTab, isPipelineRun, flowSteps, activeConnectionId])

  // When `payload.sql` changes from outside this window — e.g. another
  // window merged a dragged column into this rollup's lineage — adopt
  // it as the draft (only if the user hasn't drifted from the last
  // synced value) and re-run, so the grid reflects the new aggregate
  // immediately without a manual Run.
  useEffect(() => {
    if (lastSyncedSqlRef.current === payload.sql) return
    const prev = lastSyncedSqlRef.current
    lastSyncedSqlRef.current = payload.sql ?? ""
    setDraftSql((cur) => (cur === prev ? (payload.sql ?? "") : cur))
    // Claim the current compiled SQL as the baseline *before* re-running.
    // `compiledSql` is derived from `payload.sql`, so the rerun-on-compiled
    // effect below also wakes on this change — but `draftSql` is still the
    // stale pre-merge value in this commit, so letting it fire would run the
    // OLD query and (winning the run nonce) clobber payload.sql right back.
    // Pinning the baseline here makes that effect a no-op for this change.
    prevCompiledRef.current = compiledSql
    if (payload.sql) void runSql(payload.sql)
  }, [payload.sql, compiledSql, runSql])

  // ── EXPLAIN ───────────────────────────────────────────────────────
  // Plan-only EXPLAIN (FORMAT JSON) never executes the query, so it is
  // safe to run on any statement. ANALYZE *does* execute it — the tab
  // gates that button to SELECTs.

  // Compile a source SQL string through the reactive graph exactly the
  // way runSql does, so EXPLAIN plans the SQL that would actually run —
  // including the current (possibly un-run) draft.
  const compileSource = useCallback(
    (sourceSql: string): string => {
      const trimmed = sourceSql.trim()
      if (!trimmed) return ""
      const graph = buildDesktopRuntimeGraph(
        allWindows.map((win) =>
          win.id === w.id && win.kind === "data"
            ? {
                ...win,
                payload: {
                  ...(win.payload as DataPayload),
                  reactive: {
                    ...((win.payload as DataPayload).reactive ?? {
                      blockName,
                      paramSubscriptions: subscriptions,
                      version: 1,
                    }),
                    sourceSql: trimmed,
                    blockName,
                  },
                } satisfies DataPayload,
              }
            : win,
        ),
        params,
      )
      return graph.blocks.get(w.id)?.compiledSql ?? trimmed
    },
    [allWindows, blockName, params, subscriptions, w.id],
  )

  // `silent` keeps the current graph on screen while re-planning (used
  // by the live-as-you-type pass) instead of flashing a spinner, and
  // swallows the syntax errors that are normal while a query is still
  // being typed — the last good plan stays visible.
  const runExplain = useCallback(
    async (analyze: boolean, silent = false) => {
      if (!activeConnectionId) return
      const sql = compileSource(draftSql || payload.sql)
      if (!sql) {
        if (!silent) setExplainState({ kind: "error", message: "No SQL to explain yet." })
        return
      }
      // With pg_rvbbit, EXPLAIN (SEMANTIC) is a strict superset — it
      // returns the regular plan *and* the Semantic Execution Graph
      // (the projected external/LLM cost). ESTIMATE mode makes no
      // external calls, so it stays safe for live re-planning.
      const prefix = hasRvbbit
        ? `EXPLAIN (SEMANTIC${analyze ? ", ANALYZE, BUFFERS" : ""}, FORMAT JSON)\n`
        : `EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON)\n`
      if (silent) setExplainBusy(true)
      else setExplainState({ kind: "loading" })
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: activeConnectionId,
            sql: prefix + sql,
            rowLimit: 1,
          }),
        })
        const body = (await res.json()) as
          | (QueryResult & { ok: true })
          | { ok: false; error: string }
        if (body.ok === false) {
          // Mid-typing errors: keep the last good plan if we have one.
          setExplainState((prev) =>
            silent && prev.kind === "done" ? prev : { kind: "error", message: body.error },
          )
          return
        }
        const plan = parseExplainResult(body.rows)
        if (!plan) {
          setExplainState((prev) =>
            silent && prev.kind === "done"
              ? prev
              : { kind: "error", message: "Could not parse the EXPLAIN output." },
          )
          return
        }
        setExplainState({ kind: "done", plan, analyzed: analyze })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setExplainState((prev) =>
          silent && prev.kind === "done" ? prev : { kind: "error", message },
        )
      } finally {
        if (silent) setExplainBusy(false)
      }
    },
    [activeConnectionId, compileSource, draftSql, payload.sql, hasRvbbit],
  )

  // Run ANALYZE for real — but a semantic query's ANALYZE makes actual
  // (billable) LLM calls, so confirm against the projected cost first.
  const onAnalyze = useCallback(() => {
    if (explainState.kind === "done") {
      const sum = explainState.plan["Semantic Execution Graph"]?.["External Call Summary"]
      const cost = sum?.["Total Cost USD"] ?? 0
      const calls =
        (sum?.["LLM Calls"] ?? 0) +
        (sum?.["Sidecar Calls"] ?? 0) +
        (sum?.["Code Calls"] ?? 0)
      if (calls > 0) {
        const ok = window.confirm(
          `Run ANALYZE executes this query for real — about ${calls} external semantic ` +
            `call(s), ~$${cost.toFixed(4)} projected (cold-cache upper bound).\n\nContinue?`,
        )
        if (!ok) return
      }
    }
    void runExplain(true)
  }, [explainState, runExplain])

  // Live EXPLAIN: while the tab is open, re-plan shortly after the SQL
  // settles. Plan-only EXPLAIN never executes the query, so this is
  // cheap and safe to run on every pause in typing. The first plan on
  // open is immediate + non-silent; later ones are debounced + silent.
  const explainOpenedRef = useRef(false)
  useEffect(() => {
    if (activeTab !== "explain") {
      explainOpenedRef.current = false
      return
    }
    const justOpened = !explainOpenedRef.current
    explainOpenedRef.current = true
    const handle = setTimeout(
      () => void runExplain(false, !justOpened),
      justOpened ? 0 : 650,
    )
    return () => clearTimeout(handle)
  }, [activeTab, draftSql, compiledSql, runExplain])

  // Re-run when an upstream cascading filter changes (runSignal bumps).
  useEffect(() => {
    if (runSignal === 0) return
    void runSql(draftSql || payload.sql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal])

  // Re-run whenever the *compiled* SQL changes — i.e. a referenced {X}
  // upstream's SQL changed, a `param.X.Y` substitution flipped, or a self
  // subscription resolved. Skips the initial mount (prev=null) and only
  // fires after at least one run has already recorded the baseline.
  useEffect(() => {
    if (prevCompiledRef.current === null) return
    if (prevCompiledRef.current === compiledSql) return
    prevCompiledRef.current = compiledSql
    void runSql(draftSql || payload.sql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledSql])

  function onRenameBlock() {
    const next = prompt("Block name (used by other windows to reference this result):", blockName)
    if (!next) return
    const sanitized = slugifyBlockName(next)
    if (!sanitized) return
    const unique = uniqueBlockName(sanitized, allWindows, w.id)
    onChangePayload((p) => ({
      ...p,
      reactive: {
        blockName: unique,
        sourceSql: p.reactive?.sourceSql ?? sourceSqlForPayload(p),
        paramSubscriptions: p.reactive?.paramSubscriptions ?? [],
        version: (p.reactive?.version ?? 1) + 1,
      },
    }))
  }

  function handleBlockDragStart(e: React.DragEvent<HTMLButtonElement>) {
    writeBlockDragPayload(e.dataTransfer, {
      kind: "rvbbit-lens.desktop.block",
      windowId: w.id,
      blockName,
      title: payload.title || w.title || blockName,
    })
    attachDragGhost(e.dataTransfer, {
      variant: "block",
      label: `{${blockName}}`,
      sublabel: "block ref",
    })
  }

  function handleParamDragOver(e: React.DragEvent<HTMLElement>) {
    if (!hasParamDragPayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setParamDropHot(true)
  }

  function handleParamDragLeave() { setParamDropHot(false) }

  function handleParamDrop(e: React.DragEvent<HTMLElement>) {
    setParamDropHot(false)
    const payload = readParamDragPayload(e.dataTransfer)
    if (!payload) return
    e.preventDefault()
    const param = params.find((p) => p.key === payload.key)
    if (!param) return
    onSubscribeParam(payload.key, param.field)
  }
  const onReset = useCallback(() => { setDraftSql(payload.sql || "") }, [payload.sql])

  const onFormat = useCallback(() => {
    try {
      const next = formatSql(draftSql, { language: "postgresql", keywordCase: "upper" })
      setDraftSql(next)
    } catch { /* tolerate parse errors silently */ }
  }, [draftSql])

  const result = runState.kind === "done" ? runState.result : null
  const error = runState.kind === "error" ? runState : null
  const isRunning = runState.kind === "running"

  // The editable rollup spec the shelf shows — null when this isn't a
  // column-aggregate window, or when the SQL was hand-edited into a shape
  // we can't model (detached: rollup === null).
  const rollupSpec = useMemo<RollupSpec | null>(() => {
    const lin = payload.lineage
    return lin ? effectiveRollup(lin) : null
  }, [payload.lineage])

  // Seed the Chart tab from the rollup spec (knows dims vs measures, and
  // which dim is temporal) instead of guessing from result column types.
  const chartSeedSpec = useMemo(
    () => (rollupSpec ? rollupChartSpec(rollupSpec) : null),
    [rollupSpec],
  )

  // Which filter UI a column gets (text multi-select / numeric / date
  // range), derived from the result column types when available.
  const columnKind = useMemo(() => {
    const map = new Map<string, FilterKind>()
    for (const c of result?.columns ?? []) {
      const role = classifyColumn(c)
      map.set(c.name, role === "numeric" ? "numeric" : role === "temporal" ? "date" : "text")
    }
    return (name: string): FilterKind => map.get(name) ?? "text"
  }, [result])

  // Provide the column drag source so result-grid header cells can
  // serialize themselves into a column-drag DataTransfer payload.
  const columnDragSource = useMemo(() => {
    if (!result) return null
    const cols: DesktopColumnRef[] = result.columns.map((c) => ({
      name: c.name,
      type: c.dataTypeName,
      dataTypeId: c.dataTypeId,
      role: isNumericTypeId(c.dataTypeId) ? "metric" as const : "dimension" as const,
    }))
    return {
      parentWindowId: w.id,
      parentBlockName: blockName,
      parentTitle: payload.title || w.title,
      parentSql: payload.sql,
      relationKey: relationKeyFor(payload),
      columns: cols,
    }
  }, [blockName, payload, result, w.id, w.title])

  return (
    <div
      className={cn("relative flex h-full")}
      onDragOver={handleParamDragOver}
      onDragLeave={handleParamDragLeave}
      onDrop={handleParamDrop}
    >
      {paramDropHot ? (
        <div className="pointer-events-none absolute inset-0 z-30 m-2 grid place-items-center rounded-md border-2 border-dashed border-main/70 bg-main/10 text-[12px] font-medium text-main">
          Drop to subscribe this window to the param
        </div>
      ) : null}
      {sqlRailOpen ? (
        <aside
          className="flex flex-col border-r border-chrome-border bg-doc-bg/80"
          style={{ width: view.sqlRailWidthPx ?? 380, minWidth: 280, maxWidth: 700 }}
        >
          <Toolbar isRunning={isRunning} onRun={onRun} onFormat={onFormat} onReset={onReset} />
          <div className="flex-1 overflow-hidden">
            <SqlEditor value={draftSql} onChange={setDraftSql} onRun={onRun} />
          </div>
          <RunStatus runState={runState} />
        </aside>
      ) : null}

      <section className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-1 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1">
          <button
            type="button"
            onClick={() => setSqlRailOpen((o) => !o)}
            className="grid h-7 w-7 place-items-center rounded text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
            title={sqlRailOpen ? "Hide SQL editor" : "Show SQL editor"}
          >
            {sqlRailOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
          </button>
          <Tab label="Rows" icon={Table2} active={activeTab === "rows"} onClick={() => setActiveTab("rows")} />
          <Tab label="Profile" icon={Sigma} active={activeTab === "profile"} onClick={() => setActiveTab("profile")} />
          <Tab label="Chart" icon={BarChart3} active={activeTab === "chart"} onClick={() => setActiveTab("chart")} />
          <Tab label="SQL" icon={FileCode2} active={activeTab === "sql"} onClick={() => setActiveTab("sql")} />
          <Tab label="Explain" icon={TreeStructure} active={activeTab === "explain"} onClick={() => setActiveTab("explain")} />
          {isPipelineRun ? (
            <Tab label="Steps" icon={GitBranch} active={activeTab === "steps"} onClick={() => setActiveTab("steps")} />
          ) : null}

          <button
            type="button"
            draggable
            onDragStart={handleBlockDragStart}
            onClick={onRenameBlock}
            title={`Block name — drag onto canvas to spawn SELECT * FROM {${blockName}}, click to rename. Reference this block from any other window's SQL as {${blockName}}.`}
            className="ml-2 inline-flex cursor-grab items-center gap-1 rounded border border-main/30 bg-main/10 px-1.5 py-0.5 text-[10px] text-main hover:border-main/60 active:cursor-grabbing"
          >
            <GitBranch className="h-3 w-3" />
            {`{${blockName}}`}
          </button>

          <NotifyChannelControl
            channel={payload.notifyChannel}
            onChange={(ch) =>
              onChangePayload((p) => ({ ...p, notifyChannel: ch }))
            }
          />

          {subscriptions.length > 0 ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-rvbbit-accent/30 bg-rvbbit-bg/40 px-1.5 py-0.5 text-[10px] text-rvbbit-accent" title={subscriptions.map((s) => s.key).join(", ")}>
              {subscriptions.length} filter{subscriptions.length === 1 ? "" : "s"}
            </span>
          ) : null}

          {payload.sourceContext && onOpenKgForSource ? (
            <button
              type="button"
              onClick={() => onOpenKgForSource(payload.sourceContext!)}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
              style={{ color: "var(--brand-kg)" }}
              title={`Open the KG node(s) tied to ${payload.sourceContext.sourceTable}#${payload.sourceContext.sourcePk}`}
            >
              <TreeStructure className="h-3 w-3" />
              <span>open in KG</span>
            </button>
          ) : null}

          <div className="flex-1" />

          {result ? (
            <>
              <span className="text-[11px] text-chrome-text">
                {result.rowCount} rows · {result.durationMs}ms{result.truncated ? " · truncated" : ""}
              </span>
              <Button size="sm" variant="ghost" onClick={() => exportCsv(result, w.title)} title="Export CSV">
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSaveAsViewApp(payload.sql || draftSql, payload.title)}
                title="Save as View App"
              >
                <Boxes className="h-3.5 w-3.5" />
                <span className="text-xs">Save app</span>
              </Button>
            </>
          ) : null}
        </div>

        {rollupSpec && onEditRollup ? (
          <RollupShelf
            spec={rollupSpec}
            onEdit={onEditRollup}
            onRepivot={onRepivot}
            onProbeValues={onProbeValues}
            columnKind={columnKind}
          />
        ) : null}

        <div className="flex-1 overflow-hidden">
          {activeTab === "rows" && result ? (
            result.rows.length === 1 && result.columns.length === 1 ? (
              <SingleCellCallout
                column={result.columns[0]}
                value={result.rows[0]?.[result.columns[0].name]}
              />
            ) : (
              <ResultGrid
                columns={result.columns}
                rows={result.rows}
                columnDragSource={columnDragSource}
                onEmitCellParam={(field, value, dataTypeId, operator) => {
                  onEmitParam({
                    sourceWindowId: w.id,
                    sourceBlockName: blockName,
                    sourceTitle: payload.title || w.title || blockName,
                    field,
                    value,
                    operator: operator ?? "eq",
                    dataTypeId,
                  })
                }}
              />
            )
          ) : null}
          {activeTab === "rows" && !result ? (
            <EmptyResult error={error} running={isRunning} onRun={onRun} />
          ) : null}
          {activeTab === "profile" && result ? <ProfileView result={result} /> : null}
          {activeTab === "profile" && !result ? <EmptyResult error={error} running={isRunning} onRun={onRun} /> : null}
          {activeTab === "chart" && result ? (
            <ChartView
              result={result}
              userSpec={payload.chartSpec ?? null}
              onChangeUserSpec={(spec) => onChangePayload((p) => ({ ...p, chartSpec: spec }))}
              seedSpec={chartSeedSpec}
              onEmitParam={(field, value, dataTypeId) => {
                onEmitParam({
                  sourceWindowId: w.id,
                  sourceBlockName: blockName,
                  sourceTitle: payload.title || w.title || blockName,
                  field,
                  value,
                  operator: "eq",
                  dataTypeId,
                })
              }}
            />
          ) : null}
          {activeTab === "chart" && !result ? (
            <EmptyResult error={error} running={isRunning} onRun={onRun} />
          ) : null}
          {activeTab === "sql" ? (
            <div className="h-full bg-doc-bg group-data-[focused=false]/window:bg-doc-bg/70">
              <SqlEditor value={draftSql} onChange={setDraftSql} onRun={onRun} />
            </div>
          ) : null}
          {activeTab === "explain" ? (
            <ExplainTab
              state={explainState}
              busy={explainBusy}
              canAnalyze={
                explainState.kind === "done" &&
                explainState.plan.Plan["Node Type"] !== "ModifyTable"
              }
              onRefresh={() => void runExplain(false)}
              onAnalyze={onAnalyze}
            />
          ) : null}
          {activeTab === "steps" ? (
            <FlowStepsView
              steps={flowSteps}
              error={flowStepsError}
              activeStep={activeStep}
              onSelectStep={setActiveStep}
            />
          ) : null}
        </div>
      </section>
      <TimeTravelStrip
        sql={draftSql}
        onChange={setDraftSql}
        onRun={onRun}
        connectionId={activeConnectionId}
        hasRvbbit={hasRvbbit}
      />
    </div>
  )
}

function FlowStepsView({
  steps,
  error,
  activeStep,
  onSelectStep,
}: {
  steps: FlowStepRow[] | null
  error: string | null
  activeStep: number
  onSelectStep: (i: number) => void
}) {
  if (error) {
    return <div className="p-4 text-xs text-danger">Could not load pipeline steps: {error}</div>
  }
  if (steps === null) {
    return <div className="p-4 text-xs text-chrome-text/55">Loading pipeline steps…</div>
  }
  if (steps.length === 0) {
    return (
      <div className="p-4 text-xs text-chrome-text/55">
        No pipeline steps recorded for the last run.
      </div>
    )
  }
  const idx = Math.min(activeStep, steps.length - 1)
  const step = steps[idx]
  const rows = Array.isArray(step.rows) ? step.rows : []
  const cols: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r && typeof r === "object") {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k)
          cols.push(k)
        }
      }
    }
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-chrome-border p-2">
        {steps.map((s, i) => (
          <button
            key={s.step_idx}
            type="button"
            onClick={() => onSelectStep(i)}
            title={s.spec ?? s.stage}
            className={`rounded px-2 py-1 text-xs ${
              i === idx
                ? "bg-main/15 text-rvbbit-accent"
                : "text-chrome-text/55 hover:text-chrome-text"
            }`}
          >
            <span className="font-mono">{s.step_idx}</span> · {s.stage} ·{" "}
            <span className="font-mono">{s.n_rows}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {step.spec ? (
          <div className="mb-2 break-all font-mono text-[11px] text-chrome-text/55">{step.spec}</div>
        ) : null}
        {step.generated_sql ? (
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap rounded border border-chrome-border bg-doc-bg px-2 py-1 font-mono text-[11px] text-rvbbit-accent">
            {step.generated_sql}
          </pre>
        ) : null}
        {step.n_rows > rows.length ? (
          <div className="mb-1 text-[11px] text-chrome-text/55">
            showing first {rows.length} of {step.n_rows} rows
          </div>
        ) : null}
        {cols.length === 0 ? (
          <div className="text-xs text-chrome-text/55">(no rows)</div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="sticky top-0 border-b border-chrome-border bg-doc-bg px-2 py-1 text-left font-medium text-chrome-text"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, ri) => (
                <tr key={ri} className="border-b border-chrome-border/40">
                  {cols.map((c) => {
                    const v = (r as Record<string, unknown>)[c]
                    return (
                      <td key={c} className="px-2 py-1 align-top font-mono text-chrome-text">
                        {v === null || v === undefined
                          ? ""
                          : typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Toolbar({
  isRunning,
  onRun,
  onFormat,
  onReset,
}: {
  isRunning: boolean
  onRun: () => void
  onFormat: () => void
  onReset: () => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-chrome-border bg-chrome-bg/40 px-1.5 py-1">
      <Button size="sm" onClick={onRun} disabled={isRunning} title="Run (⌘↩)">
        <Play className="h-3 w-3" />
        Run
      </Button>
      <Button size="sm" variant="neutral" onClick={onFormat} title="Format">
        Aa
      </Button>
      <Button size="sm" variant="ghost" onClick={onReset} title="Reset to saved">
        <RotateCcw className="h-3 w-3" />
      </Button>
      <span className="ml-auto text-[10px] text-chrome-text/60">⌘↩ to run</span>
    </div>
  )
}

function NotifyChannelControl({
  channel,
  onChange,
}: {
  channel: string | null | undefined
  onChange: (channel: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(channel ?? "")
  const ref = useRef<HTMLDivElement>(null)
  const active = !!channel

  useEffect(() => {
    setDraft(channel ?? "")
  }, [channel])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          active
            ? `Re-runs when a NOTIFY arrives on "${channel}" — click to change`
            : "Subscribe to a Postgres NOTIFY channel"
        }
        className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
          active
            ? "border-main/50 bg-main/15 text-main"
            : "border-transparent text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        <Bell className="h-3 w-3" weight={active ? "fill" : "regular"} />
        {active ? <span className="font-mono">{channel}</span> : null}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-chrome-border bg-chrome-bg p-2 shadow-xl">
          <div className="mb-1.5 text-[10px] leading-snug text-chrome-text/70">
            Re-run this window whenever a Postgres <span className="font-mono">NOTIFY</span> lands
            on a channel.
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onChange(draft.trim() || null)
              setOpen(false)
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false)
              }}
              placeholder="channel name"
              className="h-7 flex-1 rounded border border-chrome-border bg-doc-bg px-2 font-mono text-[11px] text-foreground outline-none focus:border-main/60"
            />
            <button
              type="submit"
              className="h-7 rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground hover:bg-foreground/[0.06]"
            >
              Set
            </button>
          </form>
          {active ? (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="mt-1.5 text-[10px] text-danger hover:underline"
            >
              Unsubscribe from {channel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Tab({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]",
        active
          ? "border-main/40 bg-main/15 text-foreground"
          : "border-transparent text-chrome-text hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  )
}

function RunStatus({ runState }: { runState: RunState }) {
  if (runState.kind === "idle") return null
  return (
    <div className="border-t border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
      {runState.kind === "running" ? (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" />
          Running...
        </span>
      ) : null}
      {runState.kind === "done" ? (
        <span>
          {runState.result.command ?? "OK"} · {runState.result.rowCount} rows · {runState.result.durationMs}ms
        </span>
      ) : null}
      {runState.kind === "error" ? (
        <span className="text-danger">{runState.error}</span>
      ) : null}
    </div>
  )
}

function EmptyResult({
  error,
  running,
  onRun,
}: {
  error: { error: string; code?: string; detail?: string; hint?: string } | null
  running: boolean
  onRun: () => void
}) {
  if (running) {
    return (
      <div className="grid h-full place-items-center text-xs text-chrome-text">
        <Clock className="mb-2 h-5 w-5 animate-pulse" />
        Running query...
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-start gap-2 overflow-auto p-4 text-xs">
        <div className="inline-flex items-center gap-1.5 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error.code ? <span className="font-mono">{error.code}</span> : null}
          <span>{error.error}</span>
        </div>
        {error.detail ? <div className="text-chrome-text">{error.detail}</div> : null}
        {error.hint ? <div className="text-rvbbit-accent">Hint: {error.hint}</div> : null}
        <Button size="sm" variant="neutral" onClick={onRun}>Run again</Button>
      </div>
    )
  }
  return (
    <div className="grid h-full place-items-center text-xs text-chrome-text">
      Press Run to execute the query.
    </div>
  )
}

function ProfileView({ result }: { result: QueryResult }) {
  const profile = useMemo(() => buildProfile(result), [result])
  return (
    <div className="h-full overflow-auto p-3">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-chrome-bg/95 text-chrome-text">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">Column</th>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium text-right">Nulls</th>
            <th className="px-2 py-1 font-medium text-right">Distinct</th>
            <th className="px-2 py-1 font-medium">Min</th>
            <th className="px-2 py-1 font-medium">Max</th>
          </tr>
        </thead>
        <tbody>
          {profile.map((p) => (
            <tr key={p.column} className="border-t border-chrome-border/40">
              <td className="px-2 py-1 text-foreground">{p.column}</td>
              <td className="px-2 py-1 text-chrome-text">{p.type}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.nulls}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.distinct}</td>
              <td className="px-2 py-1 text-chrome-text">{p.min}</td>
              <td className="px-2 py-1 text-chrome-text">{p.max}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function buildProfile(result: QueryResult): Array<{
  column: string
  type: string
  nulls: number
  distinct: number
  min: string
  max: string
}> {
  return result.columns.map((c) => {
    let nulls = 0
    const distinct = new Set<string>()
    let min: unknown = undefined
    let max: unknown = undefined
    for (const r of result.rows) {
      const v = r[c.name]
      if (v == null) { nulls += 1; continue }
      const k = typeof v === "object" ? JSON.stringify(v) : String(v)
      if (distinct.size < 1000) distinct.add(k)
      if (typeof v === "number" || v instanceof Date) {
        if (min === undefined || (v as number | Date) < (min as number | Date)) min = v
        if (max === undefined || (v as number | Date) > (max as number | Date)) max = v
      } else if (typeof v === "string") {
        if (min === undefined || (typeof min === "string" && v < (min as string))) min = v
        if (max === undefined || (typeof min === "string" && v > (max as string))) max = v
      }
    }
    return {
      column: c.name,
      type: c.dataTypeName ?? String(c.dataTypeId),
      nulls,
      distinct: distinct.size,
      min: min === undefined ? "" : String(min),
      max: max === undefined ? "" : String(max),
    }
  })
}

function ExplainTab({
  state,
  busy,
  canAnalyze,
  onRefresh,
  onAnalyze,
}: {
  state: ExplainState
  busy: boolean
  canAnalyze: boolean
  onRefresh: () => void
  onAnalyze: () => void
}) {
  const loading = state.kind === "loading"
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1">
        <Button size="sm" variant="neutral" onClick={onRefresh} disabled={loading}>
          <RotateCcw className="h-3 w-3" />
          Re-explain
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onAnalyze}
          disabled={!canAnalyze || loading}
          title={
            canAnalyze
              ? "Runs the query for real row counts and timings"
              : "ANALYZE executes the statement — enabled only for SELECT"
          }
        >
          <Play className="h-3 w-3" />
          Run ANALYZE
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-chrome-text/55">
          {busy ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-main" />
              re-planning as you type…
            </>
          ) : (
            "live plan · safe · ANALYZE executes the query"
          )}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="grid h-full place-items-center text-xs text-chrome-text">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3 animate-pulse" />
              Planning…
            </span>
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full flex-col items-start gap-2 p-4 text-xs">
            <div className="inline-flex items-start gap-1.5 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{state.message}</span>
            </div>
            <Button size="sm" variant="neutral" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : state.kind === "done" ? (
          <ExplainGraph plan={state.plan} analyzed={state.analyzed} />
        ) : (
          <div className="grid h-full place-items-center text-xs text-chrome-text">
            Open this tab to plan the query.
          </div>
        )}
      </div>
    </div>
  )
}

function exportCsv(result: QueryResult, title: string) {
  const csv = rowsToCsv(result.columns, result.rows)
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${slugify(title || "result")}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function isNumericTypeId(oid: number): boolean {
  // 20=int8, 21=int2, 23=int4, 700=float4, 701=float8, 1700=numeric, 790=money
  return oid === 20 || oid === 21 || oid === 23 || oid === 700 || oid === 701 || oid === 1700 || oid === 790
}

function relationKeyFor(p: DataPayload): string {
  if (p.table) return `${p.table.schema}.${p.table.name}`
  if (p.origin === "derived" || p.origin === "query") return `query:${stableHash(p.sql)}`
  return `unknown:${stableHash(p.sql ?? "")}`
}

function stableHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36).slice(0, 8)
}
