"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Play,
  RefreshCw,
  Save,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  defaultNode,
  emptyOperator,
  fetchOperators,
  fetchReceiptById,
  fetchReceipts,
  fetchSpecialists,
  runOperator,
  saveOperator,
  signatureChanged,
  toStepTemplate,
  type NodeKind,
  type OpStep,
  type RvbbitOperator,
  type RvbbitSpecialist,
  type OperatorReceipt,
} from "@/lib/rvbbit/operators"
import {
  fetchAllToolsLite,
  fetchMcpGatewayStatus,
  fetchServers,
  MCP_GATEWAY_CATALOG_ID,
  type McpGatewayStatus,
  type McpServerOverview,
  type McpToolLite,
} from "@/lib/rvbbit/mcp"
import { mapTrace } from "@/lib/rvbbit/operator-graph"
import {
  clearOperatorLayout,
  fetchOperatorLayout,
  saveOperatorLayout,
  type NodePos,
  type OperatorLayout,
} from "@/lib/rvbbit/operator-layout"
import { OperatorGraph, type ConnectSource, type GraphMode } from "./operator-graph"
import { OperatorInspector } from "./operator-inspector"
import { OperatorReceiptTimeline } from "./operator-receipt-timeline"
import { OperatorHistoryShelf } from "./operator-history-shelf"
import type { OperatorFlowPayload } from "@/lib/desktop/types"

interface OperatorFlowWindowProps {
  payload: OperatorFlowPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenQueryLens: (queryId: string) => void
  /**
   * Phase 3 reverse cross-link: when this window is showing
   * `rvbbit.triples` (the extractor) it surfaces a header chip to jump
   * to the KG Extraction Runs dashboard.
   */
  onOpenKgExtractionRuns?: (graphId?: string | null, runId?: number | null) => void
  onOpenCapability?: (catalogId: string, initialTab?: "overview" | "generated-sql" | "probe" | "install" | "tests") => void
}

export function OperatorFlowWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenQueryLens,
  onOpenKgExtractionRuns,
  onOpenCapability,
}: OperatorFlowWindowProps) {
  const startedNew = payload.operatorName === null
  const [op, setOp] = useState<RvbbitOperator | null>(null)
  // The last persisted snapshot — used to detect signature changes so a
  // save can rebuild the wrapper function when args/return/shape change.
  const [baseline, setBaseline] = useState<RvbbitOperator | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [persisted, setPersisted] = useState(!startedNew)
  const [dirty, setDirty] = useState(false)
  // Lens deep-links carry an optional receipt to land on; honour it on
  // first mount + whenever the caller pushes a new one via updatePayload.
  const [mode, setMode] = useState<GraphMode>(payload.receiptId ? "run" : "build")
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [specialists, setSpecialists] = useState<RvbbitSpecialist[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerOverview[]>([])
  const [mcpTools, setMcpTools] = useState<McpToolLite[]>([])
  const [mcpGateway, setMcpGateway] = useState<McpGatewayStatus | null>(null)
  const [receipts, setReceipts] = useState<OperatorReceipt[]>([])
  const [receiptId, setReceiptId] = useState<string | null>(payload.receiptId ?? null)
  const [tryInputs, setTryInputs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [layout, setLayout] = useState<OperatorLayout>({})

  // Load the operator (or start a blank one).
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      if (startedNew) {
        setOp(emptyOperator())
        return
      }
      if (!activeConnectionId || !payload.operatorName) return
      const res = await fetchOperators(activeConnectionId)
      if (cancelled) return
      const found = res.operators.find((o) => o.name === payload.operatorName)
      if (found) {
        setOp(found)
        setBaseline(found)
      } else setLoadError(res.error ?? `Operator "${payload.operatorName}" not found.`)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, payload.operatorName, startedNew])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const conn = activeConnectionId
    const run = async () => {
      const [sp, srv, tools, gateway] = await Promise.all([
        fetchSpecialists(conn),
        fetchServers(conn),
        fetchAllToolsLite(conn),
        fetchMcpGatewayStatus(conn),
      ])
      if (cancelled) return
      setSpecialists(sp.specialists)
      setMcpServers(srv.rows)
      setMcpTools(tools.rows)
      setMcpGateway(gateway)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit])

  const loadReceipts = useCallback(async () => {
    if (!activeConnectionId || !op || !persisted) return
    const res = await fetchReceipts(activeConnectionId, op.name)
    setReceipts(res.receipts)
    setReceiptId((cur) => cur ?? res.receipts[0]?.receipt_id ?? null)
  }, [activeConnectionId, op, persisted])

  useEffect(() => {
    if (mode !== "run") return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await loadReceipts()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [mode, loadReceipts])

  // Caller pushed a new deep-link target (e.g. clicking another receipt
  // in Query Lens while this window is already open). Fetch it by id so
  // even an old run (outside the recent page) is available to replay.
  useEffect(() => {
    if (!payload.receiptId || !activeConnectionId) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      setReceiptId(payload.receiptId!)
      setMode("run")
      const { receipt: r } = await fetchReceiptById(activeConnectionId, payload.receiptId!)
      if (cancelled || !r) return
      setReceipts((prev) =>
        prev.some((x) => x.receipt_id === r.receipt_id) ? prev : [r, ...prev],
      )
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [payload.receiptId, activeConnectionId])

  // A row picked from the history shelf — merge it in (it may be older
  // than the recent page) and replay it read-only in run mode.
  const onSelectReceipt = useCallback((r: OperatorReceipt) => {
    setReceipts((prev) =>
      prev.some((x) => x.receipt_id === r.receipt_id) ? prev : [r, ...prev],
    )
    setReceiptId(r.receipt_id)
    setMode("run")
  }, [])

  useEffect(() => {
    if (!op || tryInputs.length === op.arg_names.length) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setTryInputs(op.arg_names.map(() => ""))
    })
    return () => {
      cancelled = true
    }
  }, [op, tryInputs.length])

  const onChangeOp = useCallback((next: RvbbitOperator) => {
    setOp(next)
    setDirty(true)
  }, [])

  const onSave = useCallback(async () => {
    if (!activeConnectionId || !op || !op.name) return
    setSaving(true)
    setSaveError(null)
    // New operator, or a changed signature → (re)build the wrapper.
    const create = !persisted || !baseline || signatureChanged(baseline, op)
    const res = await saveOperator(activeConnectionId, op, { create })
    setSaving(false)
    if (res.error) {
      setSaveError(res.error)
      return
    }
    setPersisted(true)
    setBaseline(op)
    setDirty(false)
    window.dispatchEvent(new Event("rvbbit-lens:operators-changed"))
  }, [activeConnectionId, op, persisted, baseline])

  const onTryRun = useCallback(async () => {
    if (!activeConnectionId || !op) return
    setRunning(true)
    setRunError(null)
    const res = await runOperator(activeConnectionId, op, tryInputs)
    if (res.error) {
      setRunError(res.error)
      setRunning(false)
      return
    }
    // Re-fetch receipts and jump to the newest one.
    const fresh = await fetchReceipts(activeConnectionId, op.name)
    setReceipts(fresh.receipts)
    setReceiptId(fresh.receipts[0]?.receipt_id ?? null)
    setHistoryRefresh((n) => n + 1)
    setRunning(false)
  }, [activeConnectionId, op, tryInputs])

  // Canvas node positions (UI-only, lens-side table). Loaded once the
  // operator is persisted; unsaved drafts drag locally without persisting.
  const opName = op?.name ?? ""
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!activeConnectionId || !opName || !persisted) {
        if (!cancelled) setLayout({})
        return
      }
      const res = await fetchOperatorLayout(activeConnectionId, opName)
      if (!cancelled) setLayout(res.layout)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, opName, persisted])

  const onMoveNode = useCallback(
    (id: string, pos: NodePos) => {
      setLayout((prev) => {
        const next = { ...prev, [id]: pos }
        if (activeConnectionId && opName && persisted) {
          void saveOperatorLayout(activeConnectionId, opName, next)
        }
        return next
      })
    },
    [activeConnectionId, opName, persisted],
  )

  const onTidy = useCallback(() => {
    setLayout({})
    if (activeConnectionId && opName && persisted) {
      void clearOperatorLayout(activeConnectionId, opName)
    }
  }, [activeConnectionId, opName, persisted])

  const persistLayout = useCallback(
    (next: OperatorLayout) => {
      if (activeConnectionId && opName && persisted) {
        void saveOperatorLayout(activeConnectionId, opName, next)
      }
    },
    [activeConnectionId, opName, persisted],
  )

  // Palette drop → append a step of `kind`, pinned at the drop position.
  // Converting a single-LLM operator carries its model/prompt into the
  // first llm step so the existing behaviour isn't silently dropped.
  const onAddNode = useCallback(
    (kind: NodeKind, pos: NodePos) => {
      if (!op) return
      const steps = op.steps ?? []
      // A fresh node lands disconnected so the canvas doesn't auto-wire.
      const disconnected = (s: ReturnType<typeof defaultNode>) => {
        let node = { ...s, ...(s.inputs ? { inputs: {} } : {}) }
        if (node.kind === "llm") node = { ...node, user: "" }
        return node
      }
      const nameAfter = (existing: string[]) => {
        const taken = new Set(existing)
        let n = existing.length + 1
        let name = `node${n}`
        while (taken.has(name)) name = `node${++n}`
        return name
      }

      let nextSteps
      let droppedIndex
      if (steps.length === 0) {
        // Editing an existing single-LLM operator: materialize its intrinsic
        // LLM as a real step-0 (converting {{ arg }} → {{ inputs.arg }}), then
        // add the dropped node beside it instead of replacing it.
        const seed = {
          name: "node1",
          kind: "llm" as const,
          model: op.model,
          system: toStepTemplate(op.system_prompt, op.arg_names),
          user: toStepTemplate(op.user_prompt, op.arg_names),
        }
        const dropped = disconnected(defaultNode(kind, nameAfter(["node1"])))
        nextSteps = [seed, dropped]
        droppedIndex = 1
      } else {
        nextSteps = [...steps, disconnected(defaultNode(kind, nameAfter(steps.map((s) => s.name))))]
        droppedIndex = nextSteps.length - 1
      }
      onChangeOp({ ...op, steps: nextSteps })
      const id = `step-${droppedIndex}`
      setLayout((prev) => {
        const next = { ...prev, [id]: pos }
        persistLayout(next)
        return next
      })
    },
    [op, onChangeOp, persistLayout],
  )

  // Palette "input" drop → add an operator argument. Editing an existing
  // operator's signature rebuilds its wrapper on the next save.
  const onAddInput = useCallback(
    (pos: NodePos) => {
      if (!op) return
      const taken = new Set(op.arg_names)
      let n = op.arg_names.length + 1
      let name = `arg${n}`
      while (taken.has(name)) name = `arg${++n}`
      const idx = op.arg_names.length
      onChangeOp({
        ...op,
        arg_names: [...op.arg_names, name],
        arg_types: [...op.arg_types, "text"],
      })
      setLayout((prev) => {
        const next = { ...prev, [`input-${idx}`]: pos }
        persistLayout(next)
        return next
      })
    },
    [op, onChangeOp, persistLayout],
  )

  // Drag-to-connect → wire any upstream step output (or operator arg) into
  // a step as a template ref. Where the ref lands depends on how the target
  // kind consumes data: llm reads its prompt, sql reads params, the rest
  // read their inputs map. The edge then renders from that ref.
  const onConnect = useCallback(
    (from: ConnectSource, toIdx: number) => {
      if (!op?.steps) return
      const target = op.steps[toIdx]
      if (!target) return
      let key: string
      let ref: string
      if (from.t === "step") {
        const source = op.steps[from.index]
        if (!source) return
        key = source.name
        ref = `{{ steps.${source.name}.output }}`
      } else {
        if (!from.name) return
        key = from.name
        ref = `{{ inputs.${from.name} }}`
      }
      const next: OpStep = { ...target }
      if (target.kind === "llm") {
        const cur = next.user ?? ""
        if (cur.includes(ref)) return
        next.user = cur ? `${cur}\n${ref}` : ref
      } else if (target.kind === "sql") {
        const params = next.params ?? []
        if (params.includes(ref)) return
        next.params = [...params, ref]
      } else {
        if (next.inputs?.[key] === ref) return
        next.inputs = { ...(next.inputs ?? {}), [key]: ref }
      }
      const nextSteps: OpStep[] = op.steps.map((s, i) => (i === toIdx ? next : s))
      onChangeOp({ ...op, steps: nextSteps })
    },
    [op, onChangeOp],
  )

  // Click an edge → remove the wiring. Strips the {{ ... }} reference
  // wherever it lives — inputs map, system/user prompt, or params — so any
  // connection is severable in edit mode (correctness is checked on save).
  const onDisconnect = useCallback(
    (from: ConnectSource, toIdx: number) => {
      if (!op?.steps) return
      const target = op.steps[toIdx]
      if (!target) return
      const name =
        from.t === "step" ? op.steps[from.index]?.name ?? "" : from.name
      if (!name) return
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const re =
        from.t === "step"
          ? new RegExp(`\\{\\{\\s*steps\\.${esc}(\\.[A-Za-z0-9_]+)?\\s*\\}\\}`, "g")
          : new RegExp(`\\{\\{\\s*inputs\\.${esc}\\s*\\}\\}`, "g")
      const next: OpStep = { ...target }
      if (next.system) next.system = next.system.replace(re, "")
      if (next.user) next.user = next.user.replace(re, "")
      if (next.params) next.params = next.params.map((p) => p.replace(re, ""))
      if (next.inputs) {
        const entries = Object.entries(next.inputs)
          .map(([k, v]) => [k, v.replace(re, "")] as const)
          .filter(([, v]) => v.trim().length > 0)
        next.inputs = Object.fromEntries(entries)
      }
      const nextSteps = op.steps.map((s, i) => (i === toIdx ? next : s))
      onChangeOp({ ...op, steps: nextSteps })
    },
    [op, onChangeOp],
  )

  // Connect a step → OUTPUT to make it the operator's result. The output
  // is the pipeline's last step, so this reorders that step to the end.
  const onSetOutput = useCallback(
    (idx: number) => {
      if (!op?.steps) return
      const len = op.steps.length
      if (idx < 0 || idx >= len || idx === len - 1) return
      const steps = op.steps.slice()
      const [moved] = steps.splice(idx, 1)
      steps.push(moved)
      onChangeOp({ ...op, steps })
      setLayout((prev) => {
        const remap = (i: number) => (i === idx ? len - 1 : i > idx ? i - 1 : i)
        const next: OperatorLayout = {}
        for (const [id, p] of Object.entries(prev)) {
          const m = /^step-(\d+)$/.exec(id)
          if (!m) {
            next[id] = p
            continue
          }
          next[`step-${remap(Number(m[1]))}`] = p
        }
        persistLayout(next)
        return next
      })
    },
    [op, onChangeOp, persistLayout],
  )

  // Remove an operator argument; remap input-N positions like steps.
  const onDeleteInput = useCallback(
    (idx: number) => {
      if (!op) return
      onChangeOp({
        ...op,
        arg_names: op.arg_names.filter((_, i) => i !== idx),
        arg_types: op.arg_types.filter((_, i) => i !== idx),
      })
      setLayout((prev) => {
        const next: OperatorLayout = {}
        for (const [id, p] of Object.entries(prev)) {
          const m = /^input-(\d+)$/.exec(id)
          if (!m) {
            next[id] = p
            continue
          }
          const i = Number(m[1])
          if (i === idx) continue
          next[`input-${i > idx ? i - 1 : i}`] = p
        }
        persistLayout(next)
        return next
      })
    },
    [op, onChangeOp, persistLayout],
  )

  // Delete a step from the canvas, remapping stored positions so later
  // steps keep their boxes (step ids are positional).
  const onDeleteStep = useCallback(
    (idx: number) => {
      if (!op?.steps) return
      const nextSteps = op.steps.filter((_, i) => i !== idx)
      onChangeOp({ ...op, steps: nextSteps.length > 0 ? nextSteps : null })
      setLayout((prev) => {
        const next: OperatorLayout = {}
        for (const [id, p] of Object.entries(prev)) {
          const m = /^step-(\d+)$/.exec(id)
          if (!m) {
            next[id] = p
            continue
          }
          const i = Number(m[1])
          if (i === idx) continue
          next[`step-${i > idx ? i - 1 : i}`] = p
        }
        persistLayout(next)
        return next
      })
    },
    [op, onChangeOp, persistLayout],
  )

  const receipt = useMemo(
    () => receipts.find((r) => r.receipt_id === receiptId) ?? null,
    [receipts, receiptId],
  )

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        This connection has no <span className="font-mono">&nbsp;pg_rvbbit&nbsp;</span> extension.
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-danger">
        {loadError}
      </div>
    )
  }
  if (!op) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" /> Loading operator…
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-2 py-1">
        <div className="flex rounded border border-chrome-border">
          {(["build", "run"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "px-2.5 py-0.5 text-[11px] capitalize",
                mode === m
                  ? "bg-main/20 text-foreground"
                  : "text-chrome-text/70 hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="font-mono text-[12px] text-foreground">
          rvbbit.{op.name || "new_operator"}
        </span>
        {op.name === "triples" && onOpenKgExtractionRuns ? (
          <button
            type="button"
            onClick={() => onOpenKgExtractionRuns(null, null)}
            title="Open the KG extraction-runs dashboard"
            className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground"
            style={{ color: "var(--brand-kg)" }}
          >
            extraction runs →
          </button>
        ) : null}
        {mcpGateway && !mcpGateway.ready ? (
          <button
            type="button"
            onClick={() =>
              onOpenCapability?.(mcpGateway.catalogId ?? MCP_GATEWAY_CATALOG_ID, "install")
            }
            title={mcpGateway.error ?? "Install MCP Gateway runtime"}
            className="inline-flex h-6 items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 text-[10px] text-warning hover:bg-warning/15"
          >
            <AlertTriangle className="h-3 w-3" />
            MCP gateway
          </button>
        ) : null}

        {/* In run mode, surface receipt-level metrics inline so the
            shape of the most-recent run is readable without expanding
            the right rail. */}
        {mode === "run" && receipt ? (
          <ReceiptMetricsStrip receipt={receipt} />
        ) : null}

        <div className="flex-1" />
        {mode === "build" ? (
          <>
            {Object.keys(layout).length > 0 ? (
              <button
                type="button"
                onClick={onTidy}
                title="Reset node positions to the automatic layout"
                className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground"
              >
                Tidy
              </button>
            ) : null}
            {dirty ? <span className="text-[10px] text-chart-3">● unsaved</span> : null}
            {saveError ? (
              <span className="max-w-[240px] truncate text-[10px] text-danger" title={saveError}>
                {saveError}
              </span>
            ) : null}
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={saving || !op.name || (!dirty && persisted)}
              title={!op.name ? "Name the operator first" : "Save operator"}
            >
              <Save className="h-3 w-3" />
              {saving ? "Saving…" : persisted ? "Save" : "Create"}
            </Button>
          </>
        ) : (
          <>
            <select
              value={receiptId ?? ""}
              onChange={(e) => setReceiptId(e.target.value || null)}
              className="h-6 max-w-[260px] rounded border border-chrome-border bg-secondary-background px-1 text-[11px] text-foreground"
            >
              {receipts.length === 0 ? <option value="">no receipts yet</option> : null}
              {receipts.map((r) => (
                <option key={r.receipt_id} value={r.receipt_id}>
                  {fmtTime(r.invocation_at)} ·{" "}
                  {r.error ? "error" : truncate(r.output ?? "", 40)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadReceipts()}
              title="Reload receipts"
              className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            {receipt?.query_id ? (
              <button
                type="button"
                onClick={() => onOpenQueryLens(receipt.query_id!)}
                title="Open this query_id in Query Lens"
                className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground"
              >
                <Eye className="h-3 w-3" />
                Lens
              </button>
            ) : null}
          </>
        )}
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <OperatorGraph
              op={op}
              mode={mode}
              receipt={mode === "run" ? receipt : null}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              editable={mode === "build"}
              positions={layout}
              onMoveNode={onMoveNode}
              onAddNode={onAddNode}
              onAddInput={onAddInput}
              allowAddInput
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onSetOutput={onSetOutput}
              onDeleteStep={onDeleteStep}
              onDeleteInput={onDeleteInput}
            />
          </div>
          {mode === "run" && receipt ? (
            <div className="border-t border-chrome-border">
              <OperatorReceiptTimeline
                op={op}
                receipt={receipt}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>
          ) : null}
          <OperatorHistoryShelf
            connectionId={activeConnectionId}
            operatorName={op.name}
            enabled={persisted}
            activeReceiptId={mode === "run" ? receiptId : null}
            refreshSignal={historyRefresh}
            onSelect={onSelectReceipt}
          />
        </div>
        <aside className="w-[320px] shrink-0 border-l border-chrome-border">
          {mode === "build" ? (
            <OperatorInspector
              op={op}
              isNew={!persisted}
              selectedNodeId={selectedNodeId}
              specialists={specialists}
              mcpServers={mcpServers}
              mcpTools={mcpTools}
              mcpGatewayReady={mcpGateway?.ready === true}
              onOpenMcpGateway={() =>
                onOpenCapability?.(mcpGateway?.catalogId ?? MCP_GATEWAY_CATALOG_ID, "install")
              }
              onChange={onChangeOp}
            />
          ) : (
            <RunPanel
              op={op}
              receipt={receipt}
              selectedNodeId={selectedNodeId}
              tryInputs={tryInputs}
              onChangeTryInput={(i, v) =>
                setTryInputs((prev) => prev.map((x, j) => (j === i ? v : x)))
              }
              running={running}
              runError={runError}
              onRun={() => void onTryRun()}
              canRun={!!activeConnectionId && persisted}
            />
          )}
        </aside>
      </div>
    </div>
  )
}

// ── Receipt metrics strip (header) ──────────────────────────────────

function ReceiptMetricsStrip({ receipt }: { receipt: OperatorReceipt }) {
  const errs = (receipt.sub_calls ?? []).filter((c) => c.error).length
  const calls = receipt.sub_calls?.length ?? 0
  const hasError = !!receipt.error || errs > 0
  return (
    <div className="flex items-center gap-2.5 border-l border-chrome-border/60 pl-2.5 text-[10px]">
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-1.5 py-px uppercase tracking-wider ring-1",
          hasError
            ? "bg-danger/15 text-danger ring-danger/40"
            : "bg-success/15 text-success ring-success/30",
        )}
      >
        {hasError ? <X className="h-2.5 w-2.5" /> : <CheckCircle2 className="h-2.5 w-2.5" />}
        {hasError ? "error" : "ok"}
      </span>
      <span>
        <span className="font-mono tabular-nums text-foreground">
          {fmtMsShort(receipt.latency_ms)}
        </span>{" "}
        <span className="text-chrome-text/55">total</span>
      </span>
      <span>
        <span className="font-mono tabular-nums text-foreground">
          {receipt.n_tokens_in}
        </span>
        <span className="text-chrome-text/45">→</span>
        <span className="font-mono tabular-nums text-foreground">{receipt.n_tokens_out}</span>{" "}
        <span className="text-chrome-text/55">tok</span>
      </span>
      <span>
        <span className="font-mono tabular-nums text-foreground">{calls}</span>{" "}
        <span className="text-chrome-text/55">call{calls === 1 ? "" : "s"}</span>
      </span>
      {errs > 0 && !hasError ? (
        <span className="text-warning">
          <span className="font-mono tabular-nums">{errs}</span> failing
        </span>
      ) : null}
      {receipt.cost_usd != null ? (
        <span>
          <span className="font-mono tabular-nums text-foreground">
            ${receipt.cost_usd.toFixed(4)}
          </span>
        </span>
      ) : null}
    </div>
  )
}

function fmtMsShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Run panel ───────────────────────────────────────────────────────

function RunPanel({
  op,
  receipt,
  selectedNodeId,
  tryInputs,
  onChangeTryInput,
  running,
  runError,
  onRun,
  canRun,
}: {
  op: RvbbitOperator
  receipt: OperatorReceipt | null
  selectedNodeId: string | null
  tryInputs: string[]
  onChangeTryInput: (i: number, v: string) => void
  running: boolean
  runError: string | null
  onRun: () => void
  canRun: boolean
}) {
  const trace = useMemo(
    () => (receipt ? mapTrace(op, receipt) : null),
    [op, receipt],
  )
  const selectedCalls = selectedNodeId ? trace?.get(selectedNodeId) ?? null : null

  return (
    <div className="flex h-full flex-col overflow-auto bg-chrome-bg/40 text-[12px] text-chrome-text">
      {/* try it */}
      <div className="border-b border-chrome-border px-3 py-2">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-chrome-text/55">
          Try it — runs the operator for real
        </div>
        {op.arg_names.map((arg, i) => (
          <label key={arg} className="mb-1.5 block">
            <span className="mb-0.5 block text-[10px] text-chrome-text/60">{arg}</span>
            <textarea
              value={tryInputs[i] ?? ""}
              onChange={(e) => onChangeTryInput(i, e.target.value)}
              rows={2}
              className="w-full rounded border border-chrome-border bg-doc-bg px-2 py-1 text-[11px] text-foreground outline-none focus:border-main/60"
            />
          </label>
        ))}
        <Button size="sm" onClick={onRun} disabled={running || !canRun}>
          <Play className="h-3 w-3" />
          {running ? "Running…" : "Run operator"}
        </Button>
        {!canRun ? (
          <p className="mt-1 text-[10px] text-chrome-text/55">Save the operator before running.</p>
        ) : null}
        {runError ? (
          <p className="mt-1 inline-flex items-start gap-1 text-[10px] text-danger">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            {runError}
          </p>
        ) : null}
      </div>

      {/* receipt summary */}
      {receipt ? (
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-chrome-text/55">
            Receipt
          </div>
          <dl className="space-y-1 text-[11px]">
            <KV k="output" v={receipt.error ? `error: ${receipt.error}` : receipt.output ?? "—"} />
            <KV
              k="tokens"
              v={`${receipt.n_tokens_in} in / ${receipt.n_tokens_out} out`}
            />
            <KV k="latency" v={`${receipt.latency_ms} ms`} />
            <KV
              k="calls"
              v={`${receipt.sub_calls?.length ?? 0} model call(s)`}
            />
            {receipt.cost_usd != null ? <KV k="cost" v={`$${receipt.cost_usd}`} /> : null}
          </dl>

          {selectedCalls && selectedCalls.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-chrome-text/55">
                Selected node · {selectedCalls.length} call(s)
              </div>
              {selectedCalls.map((c, i) => (
                <div
                  key={i}
                  className="mb-1 rounded border border-chrome-border/60 bg-secondary-background px-2 py-1 text-[10px]"
                >
                  <div className="flex justify-between">
                    <span className="text-foreground">{c.kind}</span>
                    <span className="tabular-nums text-chrome-text/70">{c.latency_ms ?? 0} ms</span>
                  </div>
                  {c.model ? (
                    <div className="font-mono text-[9px] text-chrome-text/60">{c.model}</div>
                  ) : null}
                  <div className="tabular-nums text-chrome-text/70">
                    {c.tokens_in ?? 0}→{c.tokens_out ?? 0} tok
                  </div>
                  {c.error ? <div className="text-danger">{c.error}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-chrome-text/45">
              Click a node to inspect its calls.
            </p>
          )}
        </div>
      ) : (
        <div className="px-3 py-3 text-[11px] text-chrome-text/55">
          No run selected. Use “Try it”, or pick a past receipt above.
        </div>
      )}
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-chrome-text/55">{k}</dt>
      <dd className="break-words text-foreground">{v}</dd>
    </div>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString()
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
