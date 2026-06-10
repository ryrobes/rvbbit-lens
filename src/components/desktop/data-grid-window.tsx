"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
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
  Sparkles,
  Table2,
  TreeStructure,
} from "@/lib/icons"
import { format as formatSql } from "sql-formatter"
import { ChartView } from "./chart-view"
import { ControlView } from "./control-view"
import { ModelField } from "./operator-inspector"
import { ResultGrid } from "./result-grid"
import { SingleCellCallout } from "./single-cell-callout"
import { SqlEditor } from "./sql-editor"
import { fetchLlmModels, type LlmModel } from "@/lib/rvbbit/operators"
import { TimeTravelStrip } from "./time-travel-strip"
import { ExplainGraph, parseExplainResult, type ExplainRoot } from "./explain-graph"
import { Button } from "@/components/ui/button"
import type {
  DataPayload,
  DesktopColumnRef,
  DesktopParamOperator,
  DesktopParamValue,
  DesktopWindowState,
  ParamTarget,
  RollupGrain,
  RollupSpec,
} from "@/lib/desktop/types"
import { effectiveRollup } from "@/lib/desktop/sql-builder"
import { reconcileRollupLineage } from "@/lib/desktop/rollup-sql-parse"
import { rollupChartSpec } from "@/lib/desktop/rollup-chart"
import { classifyColumn } from "@/lib/desktop/chart-infer"
import { RollupShelf, type FilterKind } from "./rollup-shelf"
import type { QueryResult, SchemaSnapshot } from "@/lib/db/types"
import { buildSqlCompletionSchema } from "@/lib/desktop/sql-completion"
import type { BlockReferenceMap } from "@/lib/desktop/sql-block-refs"
import { cn } from "@/lib/utils"
import { rowsToCsv } from "@/lib/sql/format"
import {
  hasTopLevelThen,
  wrapFlow,
  expandFlowResult,
  isSynthQuery,
  inferJsonbColumns,
  columnsFromServerSchema,
  extractSynthIntent,
} from "@/lib/sql/then-rewrite"
import type { JsonbProjectionColumn } from "@/lib/desktop/types"
import {
  buildDesktopRuntimeGraph,
  paramKey,
  quoteSqlIdent,
  resolveParamPlacement,
  shortParamValue,
  slugifyBlockName,
  sourceSqlForPayload,
  stripTrailingSqlTerminator,
  uniqueBlockName,
} from "@/lib/desktop/reactive-sql"
import { setActiveBlockDragSource, writeBlockDragPayload } from "@/lib/desktop/block-drag"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { hasParamDragPayload, readParamDragPayload } from "@/lib/desktop/param-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"

interface DataGridWindowProps {
  window: DesktopWindowState
  payload: DataPayload
  activeConnectionId: string | null
  /** Whether the active connection has the pg_rvbbit extension —
   *  enables EXPLAIN (SEMANTIC) for the semantic cost projection. */
  hasRvbbit: boolean
  /** Active-connection schema snapshot — powers table/column autocomplete in
   *  the SQL editor. Null until loaded / when no connection is active. */
  schema: SchemaSnapshot | null
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
    multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
    cascade?: boolean
    dataTypeId?: number
    type?: string
  }) => void
  onSubscribeParam: (key: string, targetField?: string, target?: ParamTarget) => void
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

// The model "Ask" mode uses, persisted globally (one choice for all future
// Asks). Empty = let rvbbit.synth_sql use the synth operator's default model.
const ASK_MODEL_KEY = "rvbbit-lens:ask-model"
function loadAskModel(): string {
  try { return (typeof window !== "undefined" && window.localStorage.getItem(ASK_MODEL_KEY)) || "" } catch { return "" }
}
function saveAskModel(model: string): void {
  try { window.localStorage.setItem(ASK_MODEL_KEY, model) } catch { /* ignore */ }
}

export function DataGridWindow({
  window: w,
  payload,
  activeConnectionId,
  hasRvbbit,
  schema,
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
  // Present mode = "content-only": no tab strip, SQL rail, header toolbar,
  // rollup shelf, view-kind switcher, or time-travel rail — just the saved
  // view's data, full-bleed. Editor-only tabs (sql/explain/steps) fall back to
  // the table so a viewer never lands on a code editor.
  const present = usePresentMode()
  // Schema-aware SQL completion (tables + columns w/ type hints, + rvbbit
  // function snippets), rebuilt only when the connection's schema changes.
  const sqlCompletion = useMemo(() => buildSqlCompletionSchema(schema), [schema])
  const completionSources = useMemo(
    () => (sqlCompletion?.functionSource ? [sqlCompletion.functionSource] : undefined),
    [sqlCompletion],
  )
  // A semantic-projection window (spec has rvbbit scalar-op projections) is a
  // per-row LLM op — it never auto-runs; it opens on Explain so the live
  // EXPLAIN (SEMANTIC) shows the cost estimate before the user materializes it.
  const isSemanticProjection = ((payload.lineage ? effectiveRollup(payload.lineage) : null)?.projections?.length ?? 0) > 0
  const [draftSql, setDraftSql] = useState<string>(view.sqlDraft ?? payload.sql ?? "")
  // Editor input mode + the plain-English question (Ask mode). In "ask" mode the
  // editor edits `askDraft`; Run calls rvbbit.synth_sql to generate SQL, drops it
  // into `draftSql`, flips back to "sql", and runs it. `draftSql` therefore always
  // holds real SQL; `askDraft` always holds the question.
  const [queryMode, setQueryMode] = useState<"sql" | "ask">(view.queryMode ?? "sql")
  const [askDraft, setAskDraft] = useState<string>(view.askDraft ?? "")
  // Model for Ask generation — persisted globally; "" = synth's default model.
  const [askModel, setAskModelState] = useState<string>(() => loadAskModel())
  const setAskModel = (m: string) => { setAskModelState(m); saveAskModel(m) }
  const [llmModels, setLlmModels] = useState<LlmModel[]>([])
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
  // Live progress for a running query (polled from a separate connection).
  const [progress, setProgress] = useState<QueryProgress | null>(null)
  const workspaceActive = useWorkspaceActive()
  const [explainState, setExplainState] = useState<ExplainState>({ kind: "idle" })
  const [explainBusy, setExplainBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<NonNullable<DataPayload["view"]>["activeTab"]>(view.activeTab ?? (isSemanticProjection ? "explain" : payload.origin === "table" ? "rows" : "sql"))
  const [sqlRailOpen, setSqlRailOpen] = useState<boolean>(view.sqlRailOpen ?? (payload.origin !== "table"))
  const [paramDropHot, setParamDropHot] = useState(false)
  // Transient note shown when a param drop is refused (field this block can't
  // produce). Auto-dismisses; the timer is cleared on re-set / unmount.
  const [paramNotice, setParamNotice] = useState<string | null>(null)
  const paramNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Map of every block's `{name}` → its title + SQL, powering the editor's
  // cross-block reference highlighting + hover cards. Memoized on reference
  // *content* so moving/resizing windows doesn't reconfigure the editor —
  // refSignature deliberately omits window position.
  const refSignature = allWindows
    .filter((win) => win.kind === "data")
    .map((win) => {
      const p = win.payload as DataPayload | undefined
      const name = p?.reactive?.blockName || slugifyBlockName(p?.title || win.title || win.id)
      return `${name}${p?.title ?? ""}${p ? sourceSqlForPayload(p) : ""}`
    })
    .join("")
  const blockReferences = useMemo<BlockReferenceMap>(() => {
    const map: BlockReferenceMap = new Map()
    for (const win of allWindows) {
      if (win.kind !== "data") continue
      const p = win.payload as DataPayload | undefined
      if (!p) continue
      const name = p.reactive?.blockName || slugifyBlockName(p.title || win.title || win.id)
      if (name) map.set(name.toLowerCase(), { title: p.title || win.title || name, sql: sourceSqlForPayload(p) })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refSignature])

  // This block's own active params — drives the in-grid highlight of the live
  // filter / pick value(s).
  const blockParams = useMemo(
    () => params.filter((p) => p.sourceBlockName.toLowerCase() === blockName.toLowerCase()),
    [params, blockName],
  )

  // The "View" tab renders a Vega chart (default) or an interactive control.
  const viewKind = payload.viewKind ?? "chart"
  const setViewKind = (k: NonNullable<DataPayload["viewKind"]>) =>
    onChangePayload((p) => ({ ...p, viewKind: k }))

  // Probe the column's true min/max over the block's full relation (datepicker /
  // slider bounds) by wrapping the block's compiled SQL; null for pipeline/synth
  // blocks (can't wrap) so the control falls back to the loaded result.
  const probeBounds = useCallback(
    async (field: string): Promise<{ min: unknown; max: unknown } | null> => {
      if (!activeConnectionId) return null
      const graph = buildDesktopRuntimeGraph(allWindows, params)
      const compiled = graph.blocks.get(w.id)?.compiledSql
      if (!compiled || hasTopLevelThen(compiled) || isSynthQuery(compiled)) return null
      const c = quoteSqlIdent(field)
      const sql = `SELECT min(${c}) AS lo, max(${c}) AS hi\nFROM (\n${stripTrailingSqlTerminator(compiled)}\n) __bounds`
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // pipeline/synth are guarded out above, so this is always a plain
          // SELECT — run it under the read-only transaction guard.
          body: JSON.stringify({ connectionId: activeConnectionId, sql, rowLimit: 1, readOnly: true }),
        })
        const body = (await res.json()) as { ok?: boolean; rows?: Record<string, unknown>[] }
        const row = body.ok && Array.isArray(body.rows) ? body.rows[0] : undefined
        if (!row || (row.lo == null && row.hi == null)) return null
        return { min: row.lo ?? null, max: row.hi ?? null }
      } catch {
        return null
      }
    },
    [activeConnectionId, allWindows, params, w.id],
  )

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
        view: { ...(p.view ?? {}), sqlDraft: draftSql, sqlRailOpen, activeTab, queryMode, askDraft },
      }))
    }, 250)
    return () => clearTimeout(handle)
  }, [draftSql, sqlRailOpen, activeTab, queryMode, askDraft])

  // Lazily load the LLM model list the first time Ask mode is opened (drives the
  // model picker under the editor). Cheap; kept in state for the window's life.
  useEffect(() => {
    if (queryMode !== "ask" || !activeConnectionId || llmModels.length > 0) return
    let cancelled = false
    fetchLlmModels(activeConnectionId).then((r) => { if (!cancelled) setLlmModels(r.models) })
    return () => { cancelled = true }
  }, [queryMode, activeConnectionId, llmModels.length])

  // First mount: auto-run for windows that already have a real SQL body
  // (table previews, drag-out aggregations, block-ref spawns). Skip the
  // hand-typed "SELECT 1" scratch start.
  useEffect(() => {
    if (runState.kind !== "idle" || !activeConnectionId) return
    // Semantic projections are per-row LLM ops — never auto-materialize; the
    // Explain tab estimates cost and the user runs explicitly.
    if (isSemanticProjection) return
    // Pipeline cascades (… then op('…')) run rowset LLM stages — don't fire
    // them on spawn; the user reviews the SQL and runs explicitly.
    if (hasTopLevelThen(payload.sql)) return
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
    // rvbbit.synth(…) is a text-to-SQL source returning one jsonb column per row;
    // expand those into real grid columns like a pipeline (but it isn't wrapped and
    // has no Steps tab).
    const isSynth = !isPipeline && isSynthQuery(compiled)
    if (isPipeline) {
      setFlowSteps(null)
      setFlowStepsError(null)
      setActiveStep(0)
    }
    setProgress(null)
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
        // For a rvbbit.synth() block, ask the compiler for the AUTHORITATIVE column
        // schema (synth_schema — exact Postgres types, captured at compile time) so
        // the grid types and the projection casts are precise instead of guessed from
        // sampled rows. Falls back to inference if it can't be fetched.
        let synthCols: JsonbProjectionColumn[] | undefined
        if (isSynth) {
          const intent = extractSynthIntent(compiled)
          if (intent) {
            try {
              const sres = await fetch("/api/db/query", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  connectionId: activeConnectionId,
                  sql: `SELECT column_name, data_type FROM rvbbit.synth_schema('${intent.replace(/'/g, "''")}')`,
                  rowLimit: 500,
                  readOnly: false,
                }),
              })
              const sbody = (await sres.json()) as {
                ok: boolean
                rows?: { column_name: string; data_type: string }[]
              }
              if (runNonceRef.current !== myNonce) return
              if (sbody.ok && sbody.rows && sbody.rows.length > 0) {
                synthCols = columnsFromServerSchema(sbody.rows)
              }
            } catch {
              /* fall back to inference */
            }
          }
        }
        // flow() / synth() return a single jsonb column per row; expand into columns
        // (using the authoritative synth schema when we have it).
        const finalResult = isPipeline || isSynth ? expandFlowResult(body, synthCols) : body
        // Record the column shape so the reactive graph can wrap *references* to this
        // block in a typed projection (drag-out rollups / block.<name> refs see real
        // columns, not jsonb). Synth-only: a bare-`then` pipeline's compiledSql is not
        // valid SQL as a subquery, so projecting over it would be unparseable. Prefer
        // the authoritative schema; fall back to inference. Cleared for ordinary
        // queries.
        const jsonbProjection =
          isSynth && finalResult !== body
            ? synthCols ?? inferJsonbColumns(finalResult.rows as Record<string, unknown>[])
            : undefined
        setIsPipelineRun(isPipeline)
        setRunState({ kind: "done", result: finalResult })
        // Record the compiled SQL that just succeeded, so the auto-rerun
        // effect treats *this* as the baseline (not the unfiltered first
        // render).
        prevCompiledRef.current = compiled
        onChangePayload((p) => ({
          ...p,
          sql: trimmedSource,
          jsonbProjection,
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

  // Ask mode: generate SQL from the plain-English question via rvbbit.synth_sql
  // (grounded text-to-SQL → a validated, read-only SELECT), drop it into the
  // editor, flip back to SQL mode, and run it. One-shot, no chat.
  const runAsk = useCallback(async (question: string) => {
    if (!activeConnectionId) return
    const q = question.trim()
    if (!q) return
    const myNonce = ++runNonceRef.current
    setProgress(null)
    setRunState({ kind: "running", sql: "rvbbit.synth_sql(…)", startedAt: Date.now() })
    try {
      // Pass the chosen model via opts (invoke_with_cache honors opts.model and
      // keys the cache by it); empty opts = synth's default model.
      const opts = askModel ? JSON.stringify({ model: askModel }) : "{}"
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          // synth_sql writes its cache on a miss → must NOT be read-only.
          sql: `SELECT rvbbit.synth_sql('${q.replace(/'/g, "''")}', 'synth', '${opts.replace(/'/g, "''")}') AS sql`,
          rowLimit: 1,
          readOnly: false,
        }),
      })
      const body = (await res.json()) as
        | (QueryResult & { ok: true })
        | { ok: false; error: string; code?: string; detail?: string; hint?: string }
      // A newer action started while synth was in flight — drop this result.
      if (runNonceRef.current !== myNonce) return
      if (body.ok === false) {
        setRunState({ kind: "error", error: body.error, code: body.code, detail: body.detail, hint: body.hint })
        return
      }
      const firstCol = body.columns[0]?.name
      const generated = ((firstCol ? body.rows[0]?.[firstCol] : null) as string | null) ?? ""
      if (!generated.trim()) {
        setRunState({ kind: "error", error: "Ask: no SQL was generated — try rephrasing the question." })
        return
      }
      // synth_sql returns one long line — pretty-print it (whitespace/keyword
      // case only, semantically identical) so the editor is readable. Fall back
      // to the raw SQL if the formatter can't parse it.
      let pretty = generated
      try { pretty = formatSql(generated, { language: "postgresql", keywordCase: "upper" }) } catch { /* keep raw */ }
      // Hand off to runSql (it owns the next nonce); load + flip to SQL mode.
      setDraftSql(pretty)
      setQueryMode("sql")
      void runSql(pretty)
    } catch (e) {
      if (runNonceRef.current !== myNonce) return
      setRunState({ kind: "error", error: e instanceof Error ? e.message : String(e) })
    }
  }, [activeConnectionId, askModel, runSql])

  const onRun = useCallback(() => {
    if (queryMode === "ask") void runAsk(askDraft)
    else void runSql(draftSql || payload.sql)
  }, [queryMode, askDraft, draftSql, payload.sql, runAsk, runSql])

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
    // In Ask mode the editor shows the question (askDraft), not draftSql, and a
    // synth-generated SQL change shouldn't silently re-run — just advance the
    // baseline so this doesn't re-fire when the user flips back to SQL.
    if (queryMode === "ask") { lastSyncedSqlRef.current = payload.sql ?? ""; return }
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
    // Semantic projections never auto-materialize (per-row LLM cost) — show the
    // updated plan/cost on Explain instead of running.
    if (isSemanticProjection) {
      setActiveTab("explain")
      return
    }
    // A newly-chained pipeline stage (… then op('…')) shouldn't fire its LLM
    // stages on edit — flip to Explain for a plan-only calls/cost preview; the
    // user reviews and runs it explicitly.
    if (payload.sql && hasTopLevelThen(payload.sql)) {
      setActiveTab("explain")
      return
    }
    if (payload.sql) void runSql(payload.sql)
  }, [payload.sql, compiledSql, runSql, isSemanticProjection, queryMode])

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
    // In Ask mode draftSql is empty (the editor holds the question), so this
    // would re-run stale payload.sql — skip it.
    if (runSignal === 0 || isSemanticProjection || queryMode === "ask") return
    void runSql(draftSql || payload.sql)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal])

  // Re-run whenever the *compiled* SQL changes — i.e. a referenced {X}
  // upstream's SQL changed, a `param.X.Y` substitution flipped, or a self
  // subscription resolved. Skips the initial mount (prev=null) and only
  // fires after at least one run has already recorded the baseline.
  useEffect(() => {
    if (prevCompiledRef.current === null || isSemanticProjection) return
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
    const title = payload.title || w.title || blockName
    writeBlockDragPayload(e.dataTransfer, {
      kind: "rvbbit-lens.desktop.block",
      windowId: w.id,
      blockName,
      title,
    })
    attachDragGhost(e.dataTransfer, {
      variant: "block",
      label: `{${blockName}}`,
      sublabel: "block ref",
    })
    // Publish the active block drag so the rowset-op palette can surface.
    setActiveBlockDragSource({ windowId: w.id, blockName, title })
  }

  function handleParamDragOver(e: React.DragEvent<HTMLElement>) {
    if (!hasParamDragPayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setParamDropHot(true)
  }

  function handleParamDragLeave() { setParamDropHot(false) }

  function showParamNotice(msg: string) {
    setParamNotice(msg)
    if (paramNoticeTimer.current) clearTimeout(paramNoticeTimer.current)
    paramNoticeTimer.current = setTimeout(() => setParamNotice(null), 4500)
  }

  // Resolve a {ref} block name → its source SQL, so param-placement can follow a
  // chart's `FROM {core}` up to the column set of `core` (all blocks rooted on
  // the same table).
  function resolveBlockSource(name: string): string | null {
    const target = name.toLowerCase()
    for (const win of allWindows) {
      if (win.kind !== "data") continue
      const pl = win.payload as DataPayload | undefined
      if (!pl) continue
      const bn = (pl.reactive?.blockName || slugifyBlockName(pl.title || win.title || win.id)).toLowerCase()
      if (bn === target) return sourceSqlForPayload(pl)
    }
    return null
  }

  function handleParamDrop(e: React.DragEvent<HTMLElement>) {
    setParamDropHot(false)
    const drag = readParamDragPayload(e.dataTransfer)
    if (!drag) return
    e.preventDefault()
    const param = params.find((p) => p.key === drag.key)
    if (!param) return
    // Where can this field be applied? "from-item" pushes into the (possibly
    // {ref}-inlined) FROM-item; "query" wraps the output; "none" = the field
    // exists in neither → refuse instead of emitting `WHERE <missing> = …`.
    const placement = resolveParamPlacement(sourceSqlForPayload(payload), param.field, schema, {
      ownColumns: result?.columns?.map((c) => c.name) ?? null,
      blockSource: resolveBlockSource,
    })
    if (placement === "none") {
      showParamNotice(`Can't filter by “${param.field}” here — it isn't in this block's output or its upstream data.`)
      return
    }
    const target: ParamTarget = placement === "from-item" ? { kind: "from-item" } : { kind: "query" }
    onSubscribeParam(drag.key, param.field, target)
  }
  useEffect(() => () => { if (paramNoticeTimer.current) clearTimeout(paramNoticeTimer.current) }, [])

  const onReset = useCallback(() => {
    if (queryMode === "ask") setAskDraft(view.askDraft ?? "")
    else setDraftSql(payload.sql || "")
  }, [queryMode, payload.sql, view.askDraft])

  const onFormat = useCallback(() => {
    try {
      const next = formatSql(draftSql, { language: "postgresql", keywordCase: "upper" })
      setDraftSql(next)
    } catch { /* tolerate parse errors silently */ }
  }, [draftSql])

  const result = runState.kind === "done" ? runState.result : null
  const error = runState.kind === "error" ? runState : null
  const isRunning = runState.kind === "running"

  // Live progress while a query runs — polled from a SEPARATE connection so we
  // can see it (the main connection is blocked). pg_stat_activity gives
  // elapsed/state/wait; rvbbit.receipt_queue_depth() gives in-flight semantic
  // calls. Replaces a blind "Running query...".
  useEffect(() => {
    // progress is reset at run-start and only rendered while running, so we
    // don't clear it here (avoids a synchronous setState in the effect).
    if (!isRunning || !activeConnectionId || !workspaceActive) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await fetch("/api/db/query-progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: activeConnectionId }),
        })
        const j = (await res.json()) as (QueryProgress & { ok?: boolean }) | null
        if (!cancelled && j?.ok) {
          setProgress({
            elapsedMs: j.elapsedMs ?? null,
            wait: j.wait ?? null,
            state: j.state ?? null,
            operators: Array.isArray(j.operators) ? j.operators : [],
          })
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) timer = setTimeout(poll, 700)
    }
    timer = setTimeout(poll, 400) // small delay so the query registers in pg_stat_activity
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isRunning, activeConnectionId, workspaceActive])

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

  // The view the body renders. In present mode the editor-only tabs collapse to
  // the table so a presented tile always shows data, never a code surface.
  const bodyTab =
    present && (activeTab === "sql" || activeTab === "explain" || activeTab === "steps")
      ? "rows"
      : activeTab

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
      {paramNotice ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-2">
          <div className="pointer-events-auto max-w-[92%] rounded-md border border-danger/40 bg-chrome-bg/95 px-3 py-1.5 text-[11px] text-danger shadow-lg">
            {paramNotice}
          </div>
        </div>
      ) : null}
      {sqlRailOpen && !present ? (
        <aside
          className="flex flex-col border-r border-chrome-border bg-doc-bg/80"
          style={{ width: view.sqlRailWidthPx ?? 380, minWidth: 280, maxWidth: 700 }}
        >
          <Toolbar
            isRunning={isRunning}
            onRun={onRun}
            onFormat={onFormat}
            onReset={onReset}
            queryMode={queryMode}
            onToggleMode={() => setQueryMode((m) => (m === "ask" ? "sql" : "ask"))}
            askable={hasRvbbit}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {queryMode === "ask" ? (
              <SqlEditor value={askDraft} onChange={setAskDraft} onRun={onRun} language="plain" />
            ) : (
              <SqlEditor
                value={draftSql}
                onChange={setDraftSql}
                onRun={onRun}
                schema={sqlCompletion?.namespace}
                defaultSchema={sqlCompletion?.defaultSchema}
                completionSources={completionSources}
                blockReferences={blockReferences}
              />
            )}
          </div>
          {queryMode === "ask" ? (
            <div className="shrink-0 border-t border-chrome-border bg-chrome-bg/30 px-2 py-1.5">
              <ModelField value={askModel} models={llmModels} onChange={setAskModel} />
            </div>
          ) : null}
          <RunStatus runState={runState} progress={progress} />
        </aside>
      ) : null}

      <section className="flex flex-1 flex-col overflow-hidden">
        {present ? null : (
        <div className="flex h-9 shrink-0 items-center border-b border-chrome-border bg-chrome-bg/30 pl-1 pr-2">
          {/* Left group scrolls horizontally when narrow rather than wrapping —
              keeps the rail a fixed height and every tab reachable. */}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => setSqlRailOpen((o) => !o)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
              title={sqlRailOpen ? "Hide SQL editor" : "Show SQL editor"}
            >
              {sqlRailOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            </button>
            {/* Run lives in the SQL panel's toolbar when it's open; surface it
                here when the panel is collapsed so it's always one click away. */}
            {!sqlRailOpen ? (
              <button
                type="button"
                onClick={onRun}
                disabled={isRunning}
                className="grid h-7 w-7 shrink-0 place-items-center rounded text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
                title="Run (⌘↩)"
              >
                {isRunning ? <Clock className="h-3.5 w-3.5 animate-pulse" /> : <Play className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            <Tab label="Rows" icon={Table2} active={activeTab === "rows"} onClick={() => setActiveTab("rows")} />
            <Tab label="Profile" icon={Sigma} active={activeTab === "profile"} onClick={() => setActiveTab("profile")} />
            <Tab label="View" icon={BarChart3} active={activeTab === "chart"} onClick={() => setActiveTab("chart")} />
            <Tab label="SQL" icon={FileCode2} active={activeTab === "sql"} onClick={() => setActiveTab("sql")} />
            <Tab label="Explain" icon={TreeStructure} active={activeTab === "explain"} onClick={() => setActiveTab("explain")} />
            {isPipelineRun ? (
              <Tab label="Steps" icon={GitBranch} active={activeTab === "steps"} onClick={() => setActiveTab("steps")} />
            ) : null}

            <button
              type="button"
              draggable
              onDragStart={handleBlockDragStart}
              onDragEnd={() => setActiveBlockDragSource(null)}
              onClick={onRenameBlock}
              title={`Block name — drag onto a rowset tile to pipeline (filter/group/pivot/top/analyze/enrich), onto the canvas to spawn SELECT * FROM {${blockName}}, or click to rename. Reference this block from any other window's SQL as {${blockName}}.`}
              className="ml-1 inline-flex shrink-0 cursor-grab items-center gap-1 whitespace-nowrap rounded border border-main/30 bg-main/10 px-1.5 py-0.5 text-[10px] text-main hover:border-main/60 active:cursor-grabbing"
            >
              <GitBranch className="h-3 w-3" />
              {`{${blockName}}`}
            </button>

            <div className="shrink-0">
              <NotifyChannelControl
                channel={payload.notifyChannel}
                onChange={(ch) =>
                  onChangePayload((p) => ({ ...p, notifyChannel: ch }))
                }
              />
            </div>

            {subscriptions.length > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-rvbbit-accent/30 bg-rvbbit-bg/40 px-1.5 py-0.5 text-[10px] text-rvbbit-accent" title={subscriptions.map((s) => s.key).join(", ")}>
                {subscriptions.length} filter{subscriptions.length === 1 ? "" : "s"}
              </span>
            ) : null}

            {payload.sourceContext && onOpenKgForSource ? (
              <button
                type="button"
                onClick={() => onOpenKgForSource(payload.sourceContext!)}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                style={{ color: "var(--brand-kg)" }}
                title={`Open the KG node(s) tied to ${payload.sourceContext.sourceTable}#${payload.sourceContext.sourcePk}`}
              >
                <TreeStructure className="h-3 w-3" />
                <span>open in KG</span>
              </button>
            ) : null}
          </div>

          {/* Right cluster is pinned + never wraps, so the row/ms readout can't
              push the rail to multiple lines. */}
          {result ? (
            <div className="flex shrink-0 items-center gap-1 pl-2">
              <span className="whitespace-nowrap text-[11px] tabular-nums text-chrome-text">
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
            </div>
          ) : null}
        </div>
        )}

        {rollupSpec && onEditRollup && !present ? (
          <RollupShelf
            spec={rollupSpec}
            onEdit={onEditRollup}
            onRepivot={onRepivot}
            onProbeValues={onProbeValues}
            columnKind={columnKind}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {bodyTab === "rows" && result ? (
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
                activeParams={blockParams}
                onEmitCellParam={(field, value, dataTypeId, operator, cascade) => {
                  onEmitParam({
                    sourceWindowId: w.id,
                    sourceBlockName: blockName,
                    sourceTitle: payload.title || w.title || blockName,
                    field,
                    value,
                    operator: operator ?? "eq",
                    cascade,
                    dataTypeId,
                  })
                }}
              />
            )
          ) : null}
          {bodyTab === "rows" && !result ? (
            <EmptyResult error={error} running={isRunning} progress={progress} onRun={onRun} />
          ) : null}
          {bodyTab === "profile" && result ? <ProfileView result={result} /> : null}
          {bodyTab === "profile" && !result ? <EmptyResult error={error} running={isRunning} progress={progress} onRun={onRun} /> : null}
          {bodyTab === "chart" && result ? (
            <div className="flex h-full flex-col">
              {present ? null : <ViewKindBar kind={viewKind} onChange={setViewKind} />}
              <div className="min-h-0 flex-1">
                {viewKind === "chart" ? (
                  <ChartView
                    result={result}
                    userSpec={payload.chartSpec ?? null}
                    onChangeUserSpec={(spec) => onChangePayload((p) => ({ ...p, chartSpec: spec }))}
                    seedSpec={chartSeedSpec}
                    activeParams={blockParams}
                    onEmitParam={(field, value, dataTypeId) => {
                      // The chart mirrors its full point selection: `value` is the
                      // ARRAY of selected values. "replace" sets the param to
                      // exactly that set (empty clears it), cascade:false so it
                      // never self-filters — drag the chip onto a target.
                      onEmitParam({
                        sourceWindowId: w.id,
                        sourceBlockName: blockName,
                        sourceTitle: payload.title || w.title || blockName,
                        field,
                        value,
                        operator: "in",
                        multiValueAction: "replace",
                        cascade: false,
                        dataTypeId,
                      })
                    }}
                  />
                ) : (
                  <ControlView
                    result={result}
                    field={payload.controlField ?? null}
                    kind={viewKind}
                    activeParams={blockParams}
                    onChangeField={(f) => onChangePayload((p) => ({ ...p, controlField: f }))}
                    onProbeBounds={probeBounds}
                    onEmit={(field, value, dataTypeId, spec) =>
                      onEmitParam({
                        sourceWindowId: w.id,
                        sourceBlockName: blockName,
                        sourceTitle: payload.title || w.title || blockName,
                        field,
                        value,
                        operator: spec.operator,
                        multiValueAction: spec.action,
                        cascade: false,
                        dataTypeId,
                      })
                    }
                  />
                )}
              </div>
            </div>
          ) : null}
          {bodyTab === "chart" && !result ? (
            <EmptyResult error={error} running={isRunning} progress={progress} onRun={onRun} />
          ) : null}
          {bodyTab === "sql" ? (
            <div className="h-full bg-doc-bg group-data-[focused=false]/window:bg-doc-bg/70">
              <SqlEditor
                value={draftSql}
                onChange={setDraftSql}
                onRun={onRun}
                schema={sqlCompletion?.namespace}
                defaultSchema={sqlCompletion?.defaultSchema}
                completionSources={completionSources}
                blockReferences={blockReferences}
              />
            </div>
          ) : null}
          {bodyTab === "explain" ? (
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
          {bodyTab === "steps" ? (
            <FlowStepsView
              steps={flowSteps}
              error={flowStepsError}
              activeStep={activeStep}
              onSelectStep={setActiveStep}
            />
          ) : null}
        </div>
      </section>
      {present ? null : (
        <TimeTravelStrip
          sql={draftSql}
          detectSql={compiledSql}
          onChange={setDraftSql}
          onRun={onRun}
          connectionId={activeConnectionId}
          hasRvbbit={hasRvbbit}
        />
      )}
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
  queryMode,
  onToggleMode,
  askable,
}: {
  isRunning: boolean
  onRun: () => void
  onFormat: () => void
  onReset: () => void
  queryMode: "sql" | "ask"
  onToggleMode: () => void
  /** Whether the Ask (NL→SQL) toggle is offered — only on rvbbit connections. */
  askable: boolean
}) {
  const ask = queryMode === "ask"
  return (
    <div className="flex items-center gap-1 border-b border-chrome-border bg-chrome-bg/40 px-1.5 py-1">
      {/* SQL | Ask query-type toggle (rvbbit only). */}
      {askable ? (
        <div className="mr-0.5 inline-flex overflow-hidden rounded border border-chrome-border/70">
          <button
            type="button"
            onClick={() => { if (ask) onToggleMode() }}
            aria-pressed={!ask}
            className={cn("px-1.5 py-0.5 text-[10px] transition-colors", !ask ? "bg-foreground/[0.12] text-foreground" : "text-chrome-text/55 hover:bg-foreground/[0.06]")}
          >
            SQL
          </button>
          <button
            type="button"
            onClick={() => { if (!ask) onToggleMode() }}
            aria-pressed={ask}
            title="Ask in plain English — generates SQL with rvbbit.synth_sql"
            className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors", ask ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/55 hover:bg-foreground/[0.06]")}
          >
            <Sparkles className="h-2.5 w-2.5" />
            Ask
          </button>
        </div>
      ) : null}
      <Button size="sm" onClick={onRun} disabled={isRunning} title={ask ? "Generate SQL from your question (⌘↩)" : "Run (⌘↩)"}>
        {ask ? <Sparkles className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        {ask ? "Ask" : "Run"}
      </Button>
      {!ask ? (
        <Button size="sm" variant="neutral" onClick={onFormat} title="Format">
          Aa
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onReset} title={ask ? "Reset question" : "Reset to saved"}>
        <RotateCcw className="h-3 w-3" />
      </Button>
      {ask ? (
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-chrome-text/55"
          title="Generates SQL via one grounded LLM call (rvbbit.synth_sql) over your schema; cached after the first run."
        >
          <Sparkles className="h-2.5 w-2.5" style={{ color: "var(--rvbbit-accent)" }} />
          ≈1 LLM call · cached after first
        </span>
      ) : (
        <span className="ml-auto text-[10px] text-chrome-text/60">⌘↩ to run</span>
      )}
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
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-[11px]",
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

/** Segmented switcher for the "View" tab: render the result as a chart or as an
 *  interactive control (dropdown / multiselect) that publishes a pick param. */
function ViewKindBar({
  kind,
  onChange,
}: {
  kind: NonNullable<DataPayload["viewKind"]>
  onChange: (k: NonNullable<DataPayload["viewKind"]>) => void
}) {
  const items: { id: NonNullable<DataPayload["viewKind"]>; label: string }[] = [
    { id: "chart", label: "Chart" },
    { id: "dropdown", label: "Dropdown" },
    { id: "multiselect", label: "Multi-select" },
    { id: "datepicker", label: "Date" },
    { id: "slider", label: "Slider" },
  ]
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1">
      <span className="mr-1 text-[9px] uppercase tracking-wider text-chrome-text/50">view</span>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={cn(
            "rounded px-2 py-0.5 text-[10px] transition-colors",
            kind === it.id
              ? "bg-main/20 text-foreground"
              : "text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

interface OpCount {
  operator: string
  calls: number
}

interface QueryProgress {
  elapsedMs: number | null
  wait: string | null
  state: string | null
  operators: OpCount[]
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US")
}

/** One-line live description of a running query for the status bar. */
function progressLabel(p: QueryProgress | null): string {
  if (!p) return "Running…"
  const bits: string[] = ["Running"]
  if (p.elapsedMs != null) bits.push(fmtDur(p.elapsedMs))
  const ops = p.operators ?? []
  if (ops.length > 0) {
    bits.push(ops.slice(0, 3).map((o) => `${o.operator} ${fmtNum(o.calls)}`).join(", "))
  }
  if (p.wait) bits.push(`waiting: ${p.wait}`)
  else if (p.state && p.state !== "active") bits.push(p.state)
  return bits.join(" · ")
}

/** Small live bar viz of per-operator semantic-call counts during a query. */
function OpCountsViz({ operators }: { operators: OpCount[] }) {
  if (!operators || operators.length === 0) return null
  const max = Math.max(...operators.map((o) => o.calls), 1)
  return (
    <div className="mx-auto mt-3 w-56 space-y-1.5 text-left">
      <div className="text-[10px] uppercase tracking-wide text-chrome-text/50">semantic calls</div>
      {operators.slice(0, 6).map((o) => (
        <div key={o.operator} className="flex items-center gap-2">
          <span className="w-20 shrink-0 truncate font-mono text-[10px] text-chrome-text/80" title={o.operator}>
            {o.operator}
          </span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-sm bg-chrome-border/40">
            <span
              className="absolute inset-y-0 left-0 rounded-sm bg-chart-1/80"
              style={{ width: `${Math.max(4, (o.calls / max) * 100)}%` }}
            />
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-chrome-text/80">
            {fmtNum(o.calls)}
          </span>
        </div>
      ))}
    </div>
  )
}

function RunStatus({ runState, progress }: { runState: RunState; progress: QueryProgress | null }) {
  if (runState.kind === "idle") return null
  return (
    <div className="border-t border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
      {runState.kind === "running" ? (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" />
          {progressLabel(progress)}
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
  progress,
  onRun,
}: {
  error: { error: string; code?: string; detail?: string; hint?: string } | null
  running: boolean
  progress?: QueryProgress | null
  onRun: () => void
}) {
  if (running) {
    return (
      <div className="grid h-full place-items-center text-xs text-chrome-text">
        <div className="text-center">
          <Clock className="mx-auto mb-2 h-5 w-5 animate-pulse" />
          <div>
            Running query
            {progress?.elapsedMs != null ? <span className="tabular-nums"> · {fmtDur(progress.elapsedMs)}</span> : "…"}
          </div>
          {progress?.wait ? (
            <div className="mt-1 text-[10px] text-chrome-text/60">waiting on {progress.wait}</div>
          ) : null}
          {progress?.operators ? <OpCountsViz operators={progress.operators} /> : null}
        </div>
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
