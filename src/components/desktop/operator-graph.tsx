"use client"

import { useMemo } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  Database,
  Filter,
  FlowArrow,
  Globe,
  RefreshCw,
  Shield,
  Sparkles,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import type {
  RvbbitOperator,
  OperatorReceipt,
  OpStep,
  SubCall,
  Validator,
} from "@/lib/rvbbit/operators"
import {
  buildOperatorGraph,
  mapTrace,
  type NodeRef,
  type OpNode,
} from "@/lib/rvbbit/operator-graph"

// ── Layout constants ────────────────────────────────────────────────

const NODE_W = 224
const NODE_H = 104
const COL_GAP = 64
const ROW_GAP = 48
const COL_SPAN = NODE_W + COL_GAP
const ROW_SPAN = NODE_H + ROW_GAP
const PAD_X = 34
const PAD_Y = 64

export type GraphMode = "build" | "run"

interface OperatorGraphProps {
  op: RvbbitOperator
  mode: GraphMode
  receipt?: OperatorReceipt | null
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
}

export function OperatorGraph({
  op,
  mode,
  receipt,
  selectedNodeId,
  onSelectNode,
}: OperatorGraphProps) {
  const graph = useMemo(() => buildOperatorGraph(op), [op])
  const trace = useMemo(
    () => (mode === "run" && receipt ? mapTrace(op, receipt) : null),
    [mode, op, receipt],
  )

  const nodeX = (col: number) => PAD_X + col * COL_SPAN
  const nodeY = (row: number) => PAD_Y + (row - graph.rowMin) * ROW_SPAN
  const width = PAD_X * 2 + graph.cols * COL_SPAN - COL_GAP
  const height = PAD_Y * 2 + (graph.rowMax - graph.rowMin + 1) * ROW_SPAN - ROW_GAP

  const center = (n: OpNode) => ({
    x: nodeX(n.col) + NODE_W / 2,
    y: nodeY(n.row) + NODE_H / 2,
  })
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  /**
   * Per-node trace status. In build mode, every node is `idle` (we
   * paint by kind only). In run mode without a receipt selected,
   * still `idle`. With a receipt: `not-traversed` if the trace has
   * no calls for the node, otherwise success/partial/failure based
   * on per-call errors.
   */
  const statusOf = (nodeId: string): TraceStatus => {
    if (mode !== "run" || !trace) return "idle"
    const calls = trace.get(nodeId)
    if (!calls || calls.length === 0) return "not-traversed"
    const errs = calls.filter((c) => c.error).length
    if (errs === 0) return "ok"
    if (errs === calls.length) return "failed"
    return "partial"
  }

  return (
    <div className="h-full w-full overflow-auto bg-doc-bg p-2">
      <div className="relative" style={{ width, height }}>
        {/* regions behind everything */}
        {graph.regions.map((r) => {
          const outerPad = r.kind === "retry" ? 14 : 6
          const rx = nodeX(r.col0) - outerPad
          const ry = nodeY(r.row0) - outerPad - 16
          const rw = (r.col1 - r.col0) * COL_SPAN + NODE_W + outerPad * 2
          const rh = (r.row1 - r.row0) * ROW_SPAN + NODE_H + outerPad * 2 + 16
          const isRetry = r.kind === "retry"
          const regionColor = isRetry ? "var(--chart-3)" : "var(--rvbbit-accent)"
          return (
            <div
              key={r.id}
              className="absolute rounded-lg border-2 border-dashed transition-colors"
              style={{
                left: rx,
                top: ry,
                width: rw,
                height: rh,
                borderColor: selectedNodeId === r.id ? "var(--main)" : regionColor,
                background: isRetry
                  ? "color-mix(in oklch, var(--chart-3) 7%, transparent)"
                  : "color-mix(in oklch, var(--rvbbit-accent) 7%, transparent)",
              }}
            >
              <button
                type="button"
                onClick={() => onSelectNode(selectedNodeId === r.id ? null : r.id)}
                className="absolute -top-[10px] left-3 inline-flex items-center gap-1 rounded px-1.5 py-px text-[9px] font-medium uppercase tracking-wide hover:brightness-125"
                style={{ background: "var(--doc-bg)", color: regionColor }}
              >
                {isRetry ? (
                  <>
                    <RefreshCw className="h-2.5 w-2.5" />
                    retry · loop
                  </>
                ) : (
                  <>
                    <FlowArrow className="h-2.5 w-2.5" />
                    takes · ensemble
                  </>
                )}
              </button>
            </div>
          )
        })}

        {/* edges */}
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          <defs>
            <marker
              id="op-arrow"
              viewBox="0 0 8 8"
              refX="6"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--chrome-border)" />
            </marker>
            <marker
              id="op-arrow-active"
              viewBox="0 0 8 8"
              refX="6"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="var(--rvbbit-accent)" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = byId.get(e.from)
            const b = byId.get(e.to)
            if (!a || !b) return null
            const downstreamStatus = statusOf(e.to)
            const upstreamStatus = statusOf(e.from)
            // An edge is "active" when both ends have trace evidence
            // (handles the input/output endpoint case too — input always
            // counts as traversed when any node has calls).
            const traversed =
              mode === "run" &&
              trace != null &&
              (e.from === "input" || upstreamStatus === "ok" || upstreamStatus === "partial" || upstreamStatus === "failed") &&
              (e.to === "output" ||
                downstreamStatus === "ok" ||
                downstreamStatus === "partial" ||
                downstreamStatus === "failed")
            const erroredHere =
              mode === "run" &&
              (downstreamStatus === "failed" || upstreamStatus === "failed")

            const stroke = erroredHere
              ? "var(--danger)"
              : traversed
                ? "var(--rvbbit-accent)"
                : mode === "run" && trace
                  ? "color-mix(in oklch, var(--chrome-border) 50%, transparent)"
                  : "var(--chrome-border)"
            const marker = traversed && !erroredHere ? "url(#op-arrow-active)" : "url(#op-arrow)"

            if (e.kind === "loop") {
              // arc up and over the retry region, right → left
              const sx = nodeX(a.col) + NODE_W / 2
              const sy = nodeY(a.row)
              const ex = nodeX(b.col) + NODE_W / 2
              const ey = nodeY(b.row)
              const top = Math.min(sy, ey) - 38
              return (
                <path
                  key={i}
                  d={`M ${sx} ${sy} C ${sx} ${top}, ${ex} ${top}, ${ex} ${ey}`}
                  fill="none"
                  stroke="var(--chart-3)"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                />
              )
            }
            const sx = nodeX(a.col) + NODE_W
            const sy = center(a).y
            const ex = nodeX(b.col)
            const ey = center(b).y
            const mx = (sx + ex) / 2
            return (
              <path
                key={i}
                d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`}
                fill="none"
                stroke={stroke}
                strokeWidth={traversed ? 2 : 1.5}
                markerEnd={marker}
              />
            )
          })}
        </svg>

        {/* nodes */}
        {graph.nodes.map((n) => (
          <NodeBox
            key={n.id}
            op={op}
            node={n}
            mode={mode}
            receipt={receipt ?? null}
            calls={trace?.get(n.id) ?? null}
            status={statusOf(n.id)}
            selected={selectedNodeId === n.id}
            onSelect={() => onSelectNode(selectedNodeId === n.id ? null : n.id)}
            style={{
              position: "absolute",
              left: nodeX(n.col),
              top: nodeY(n.row),
              width: NODE_W,
              height: NODE_H,
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ── Trace status ────────────────────────────────────────────────────

type TraceStatus = "idle" | "not-traversed" | "ok" | "partial" | "failed"

// ── Node box ────────────────────────────────────────────────────────

type NodeAccent =
  | "plain"
  | "rvbbit"
  | "gate"
  | "code"
  | "specialist"
  | "sql"
  | "mcp"
  | "terminal"

const ACCENT_COLOR: Record<NodeAccent, string> = {
  plain: "var(--chrome-border)",
  rvbbit: "var(--rvbbit-accent)",
  gate: "var(--chart-3)",
  code: "var(--chart-2)",
  specialist: "var(--chart-1)",
  sql: "var(--chart-4)",
  mcp: "var(--chart-5)",
  terminal: "var(--main)",
}

/**
 * Border color, drop-shadow tint, and corner-glyph for one of the five
 * trace states. In build mode (`idle`) we paint by node-kind accent
 * only; in run mode the status takes over so the eye reads "did this
 * node execute, and how did it go?" at a glance.
 */
function statusStyles(status: TraceStatus, accent: NodeAccent, selected: boolean): {
  borderColor: string
  shadow: string
  glyphColor: string | null
} {
  if (selected) {
    return {
      borderColor: "var(--main)",
      shadow: "0 0 0 1px var(--main), 0 4px 12px color-mix(in oklch, var(--main) 22%, transparent)",
      glyphColor: null,
    }
  }
  switch (status) {
    case "ok":
      return {
        borderColor: "color-mix(in oklch, var(--success) 60%, transparent)",
        shadow: "0 1px 6px color-mix(in oklch, var(--success) 12%, transparent)",
        glyphColor: "var(--success)",
      }
    case "partial":
      return {
        borderColor: "color-mix(in oklch, var(--warning) 60%, transparent)",
        shadow: "0 1px 6px color-mix(in oklch, var(--warning) 14%, transparent)",
        glyphColor: "var(--warning)",
      }
    case "failed":
      return {
        borderColor: "color-mix(in oklch, var(--danger) 70%, transparent)",
        shadow: "0 1px 8px color-mix(in oklch, var(--danger) 22%, transparent)",
        glyphColor: "var(--danger)",
      }
    case "not-traversed":
      return {
        borderColor: "color-mix(in oklch, var(--chrome-border) 60%, transparent)",
        shadow: "none",
        glyphColor: null,
      }
    case "idle":
    default:
      return {
        borderColor: ACCENT_COLOR[accent],
        shadow: "none",
        glyphColor: null,
      }
  }
}

function NodeBox({
  op,
  node,
  mode,
  receipt,
  calls,
  status,
  selected,
  onSelect,
  style,
}: {
  op: RvbbitOperator
  node: OpNode
  mode: GraphMode
  receipt: OperatorReceipt | null
  calls: SubCall[] | null
  status: TraceStatus
  selected: boolean
  onSelect: () => void
  style: React.CSSProperties
}) {
  const view = describeNode(op, node.ref, receipt, mode)
  const ran = mode === "run" && calls && calls.length > 0
  const tokIn = calls?.reduce((s, c) => s + (c.tokens_in ?? 0), 0) ?? 0
  const tokOut = calls?.reduce((s, c) => s + (c.tokens_out ?? 0), 0) ?? 0
  const latency = calls?.reduce((s, c) => s + (c.latency_ms ?? 0), 0) ?? 0

  const accentColor = ACCENT_COLOR[view.accent]
  const ss = statusStyles(status, view.accent, selected)
  // Run mode without trace evidence: noticeably dim. Terminal/gate
  // nodes (input/output/wards) are always meaningful, never dimmed.
  const dimmed =
    mode === "run" &&
    status === "not-traversed" &&
    view.accent !== "terminal" &&
    view.accent !== "gate"

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...style,
        borderColor: ss.borderColor,
        boxShadow: ss.shadow,
      }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-md border-2 bg-secondary-background text-left transition",
        "hover:ring-1 hover:ring-main/30",
        dimmed && "opacity-55",
      )}
    >
      {/* header band — kind accent tint with status glyph in the corner */}
      <div
        className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider"
        style={{
          background:
            view.accent === "plain"
              ? "color-mix(in oklch, var(--chrome-border) 22%, transparent)"
              : `color-mix(in oklch, ${accentColor} 14%, transparent)`,
          color: accentColor,
        }}
      >
        <view.Icon className="h-3 w-3 shrink-0" />
        <span className="truncate font-semibold">{view.kindLabel}</span>
        {view.badges.length > 0 ? (
          <span
            className="shrink-0 rounded bg-foreground/[0.08] px-1 text-[8px] normal-case tracking-normal text-chrome-text"
            title={view.badges.join(" · ")}
          >
            {view.badges[0]}
          </span>
        ) : null}
        {ran ? (
          <span
            className="ml-auto inline-flex items-center gap-1 font-mono normal-case tracking-normal"
            style={{ color: status === "failed" ? "var(--danger)" : "var(--foreground)" }}
          >
            {calls!.length > 1 ? (
              <span className="text-chrome-text/55">{calls!.length}×</span>
            ) : null}
            {fmtMs(latency)}
            <StatusGlyph status={status} color={ss.glyphColor ?? accentColor} />
          </span>
        ) : ss.glyphColor ? (
          <span className="ml-auto inline-flex items-center" style={{ color: ss.glyphColor }}>
            <StatusGlyph status={status} color={ss.glyphColor} />
          </span>
        ) : (
          <span className="ml-auto" />
        )}
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
        <div className="truncate text-[11px] font-semibold text-foreground">
          {view.title}
        </div>
        {view.subtitle ? (
          <div className="truncate font-mono text-[9px] text-chrome-text/65">
            {view.subtitle}
          </div>
        ) : null}
        {view.body ? (
          <div className="line-clamp-2 text-[10px] leading-snug text-chrome-text/85">
            {view.body}
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between text-[9px] tabular-nums">
          {ran && (tokIn > 0 || tokOut > 0) ? (
            <span className="text-chrome-text/70">
              {tokIn}→{tokOut} tok
            </span>
          ) : view.foot ? (
            <span className="truncate text-chrome-text/55">{view.foot}</span>
          ) : (
            <span />
          )}
          {ran && status === "failed" ? (
            <span className="text-danger">error</span>
          ) : null}
        </div>
      </div>
    </button>
  )
}

function StatusGlyph({ status, color }: { status: TraceStatus; color: string }) {
  if (status === "ok")
    return <CheckCircle2 className="h-3 w-3" style={{ color }} />
  if (status === "failed")
    return <AlertTriangle className="h-3 w-3" style={{ color }} />
  if (status === "partial")
    return <AlertTriangle className="h-3 w-3" style={{ color }} />
  return null
}

// ── Node description ────────────────────────────────────────────────

interface NodeView {
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  /** Header band label — what *kind* of node this is. */
  kindLabel: string
  /** Body title — the specific identity (model/specialist/fn/etc.). */
  title: string
  subtitle?: string
  body?: string
  foot?: string
  badges: string[]
  accent: NodeAccent
}

function describeNode(
  op: RvbbitOperator,
  ref: NodeRef,
  receipt: OperatorReceipt | null,
  mode: GraphMode,
): NodeView {
  switch (ref.t) {
    case "input": {
      const args = op.arg_names
        .map((a, i) => `${a}: ${op.arg_types[i] ?? "text"}`)
        .join(", ")
      const runBody =
        mode === "run" && receipt?.inputs
          ? op.arg_names
              .map((a) => `${a} = ${preview(String(receipt.inputs?.[a] ?? ""), 60)}`)
              .join("\n")
          : null
      return {
        Icon: FlowArrow,
        kindLabel: "input",
        title: `rvbbit.${op.name || "new"}`,
        subtitle: `(${args})`,
        body: runBody ?? undefined,
        badges: [op.shape],
        accent: "terminal",
      }
    }
    case "output": {
      return {
        Icon: FlowArrow,
        kindLabel: "output",
        title: `→ ${op.return_type}`,
        subtitle: `parser: ${op.parser}`,
        body:
          mode === "run" && receipt
            ? receipt.error
              ? `error: ${receipt.error}`
              : preview(receipt.output ?? "", 90)
            : undefined,
        badges: [],
        accent: "terminal",
      }
    }
    case "exec":
    case "take":
      return {
        Icon: Sparkles,
        kindLabel: "llm",
        title: shortModel(op.model),
        body: preview(op.user_prompt, 90),
        foot: `${op.max_tokens} tok${op.temperature != null ? ` · t ${op.temperature}` : ""}`,
        badges: ref.t === "take" ? [`take ${ref.index + 1}`] : [],
        accent: "rvbbit",
      }
    case "step":
    case "take-step":
      return describeStepNode(op.steps?.[ref.index], op.model)
    case "take-node":
      return describeStepNode(op.takes?.nodes?.[ref.index], op.model)
    case "ward": {
      const ward = op.wards?.[ref.phase]?.[ref.index]
      return {
        Icon: Shield,
        kindLabel: `${ref.phase}-ward`,
        title: ward?.mode === "advisory" ? "advisory check" : "blocking check",
        body: ward ? validatorText(ward.validator) : undefined,
        badges: [ward?.mode ?? "blocking"],
        accent: "gate",
      }
    }
    case "filter":
      return {
        Icon: Filter,
        kindLabel: "filter",
        title: "drop failing takes",
        body: op.takes?.filter ? validatorText(op.takes.filter) : undefined,
        badges: [],
        accent: "gate",
      }
    case "reduce": {
      const reduce = op.takes?.reduce ?? "vote"
      return {
        Icon: Filter,
        kindLabel: `reduce`,
        title: reduce,
        body:
          reduce === "evaluator"
            ? preview(
                op.takes?.evaluator?.instructions ?? "LLM judge picks the best take",
                80,
              )
            : reduce === "vote"
              ? "majority vote across the takes"
              : "first take that passed the filter",
        badges: reduce === "evaluator" ? ["llm"] : [],
        accent: "rvbbit",
      }
    }
  }
}

/** Describe a pipeline node (a step, or a heterogeneous take node). */
function describeStepNode(step: OpStep | undefined, fallbackModel: string): NodeView {
  if (!step)
    return {
      Icon: Sparkles,
      kindLabel: "node",
      title: "(missing)",
      badges: [],
      accent: "plain",
    }
  switch (step.kind) {
    case "code":
      return {
        Icon: Cpu,
        kindLabel: "code",
        title: step.fn ?? "?",
        subtitle: step.name,
        body: step.inputs ? Object.keys(step.inputs).join(", ") : undefined,
        badges: ["fn"],
        accent: "code",
      }
    case "specialist":
      return {
        Icon: Brain,
        kindLabel: "specialist",
        title: step.specialist || "(unset)",
        subtitle: step.name,
        body: step.inputs ? Object.keys(step.inputs).join(", ") : undefined,
        badges: [],
        accent: "specialist",
      }
    case "sql":
      return {
        Icon: Database,
        kindLabel: "sql",
        title: step.name,
        body: preview(step.sql ?? "", 92),
        foot: `${step.params?.length ?? 0} param${(step.params?.length ?? 0) === 1 ? "" : "s"}`,
        badges: [],
        accent: "sql",
      }
    case "mcp":
      return {
        Icon: Globe,
        kindLabel: "mcp",
        title: step.tool
          ? `${step.server || "?"}.${step.tool}`
          : step.server || "(unset)",
        subtitle: step.name,
        body: step.inputs ? Object.keys(step.inputs).join(", ") : undefined,
        badges: [],
        accent: "mcp",
      }
    default:
      return {
        Icon: Sparkles,
        kindLabel: "llm",
        title: shortModel(step.model ?? fallbackModel),
        subtitle: step.name,
        body: preview(step.user ?? "", 80),
        badges: [],
        accent: "rvbbit",
      }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

export function validatorText(v: Validator): string {
  if (typeof v === "string") return `fn: ${v}`
  if ("sql" in v) return v.sql
  return `fn: ${v.function}`
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf("/")
  return slash >= 0 ? model.slice(slash + 1) : model
}

function preview(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

/** Stable color used by external surfaces (e.g. the receipt timeline). */
export function accentForSubCallKind(kind: string): string {
  switch (kind) {
    case "llm":
      return "var(--rvbbit-accent)"
    case "specialist":
      return "var(--chart-1)"
    case "code":
      return "var(--chart-2)"
    case "sql":
      return "var(--chart-4)"
    case "mcp":
      return "var(--chart-5)"
    default:
      return "var(--chrome-border)"
  }
}

/** Map a sub_call back to the graph node id it belongs to. */
export function nodeIdForSubCall(
  op: RvbbitOperator,
  receipt: OperatorReceipt,
  callIndex: number,
): string | null {
  const trace = mapTrace(op, receipt)
  // Build reverse-index by walking the trace map in the same order as
  // sub_calls. This works because mapTrace preserves order per-node and
  // assigns "main" calls to take lanes round-robin.
  const seen = new Map<string, number>()
  for (let i = 0; i < (receipt.sub_calls?.length ?? 0); i++) {
    for (const [nodeId, calls] of trace.entries()) {
      const seenN = seen.get(nodeId) ?? 0
      if (seenN >= calls.length) continue
      // Match by sub_call identity — both arrays were filled in source order.
      const matchesCurrent = calls[seenN] === receipt.sub_calls?.[i]
      if (matchesCurrent) {
        if (i === callIndex) return nodeId
        seen.set(nodeId, seenN + 1)
        break
      }
    }
  }
  return null
}
