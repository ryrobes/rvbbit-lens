"use client"

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { FlowArrow, Sparkles } from "@/lib/icons"
import type { SemanticOpMeta } from "@/lib/desktop/types"
import type { RvbbitOperator } from "@/lib/rvbbit/operators"
import { buildOperatorGraph, type OpNode } from "@/lib/rvbbit/operator-graph"

const CARD_W = 430
const NODE_W = 78
const NODE_H = 36
const COL_GAP = 42
const ROW_GAP = 24
const PAD = 18

interface SemanticOperatorTooltipProps {
  op: SemanticOpMeta
  title?: string
  signature?: string
  note?: string
  accent?: string
  panelRect: DOMRect | null
  tileRect: DOMRect | null
}

export function SemanticOperatorTooltip({
  op,
  title,
  signature,
  note,
  accent = "var(--viz-op-pipeline)",
  panelRect,
  tileRect,
}: SemanticOperatorTooltipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({ left: 0, top: 0, ready: false })
  const [shown, setShown] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cw = el.offsetWidth || CARD_W
    const ch = el.offsetHeight
    const m = 8
    const gap = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const anchor = panelRect ?? tileRect
    let left = (anchor ? anchor.right : vw / 2) + gap
    if (left + cw > vw - m) {
      left = (anchor ? anchor.left : vw / 2) - cw - gap
      if (left < m) left = Math.max(m, vw - cw - m)
    }
    let top = tileRect ? tileRect.top : anchor ? anchor.top : vh / 2
    top = Math.min(Math.max(m, top), vh - ch - m)
    setPos({ left, top, ready: true })
  }, [panelRect, tileRect, op])

  useEffect(() => {
    if (!pos.ready) return
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [pos.ready])

  if (typeof document === "undefined") return null
  const args = op.argNames.map((name, i) => ({ name, type: op.argTypes[i] ?? "text" }))

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: "fixed", left: pos.left, top: pos.top, width: CARD_W, opacity: shown ? 1 : 0 }}
      className="pointer-events-none z-[76] max-h-[86vh] overflow-y-auto rounded-lg border border-chrome-border bg-chrome-bg/96 p-3 text-chrome-text shadow-2xl backdrop-blur-md motion-safe:transition-opacity motion-safe:duration-100"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 shrink-0" style={{ color: accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-foreground">{title ?? titleCase(op.name)}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-chrome-text/55">
            rvbbit.{op.name}
            <span className="text-chrome-text/35"> · {op.shape}</span>
            <span className="text-chrome-text/35"> · returns {op.returnType}</span>
          </div>
        </div>
      </div>

      <MiniOperatorGraph op={op} accent={accent} />

      {op.description ? (
        <p className="mt-2 text-[11px] leading-snug text-chrome-text/80">{op.description}</p>
      ) : null}

      <div className="mt-2">
        <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">inputs</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {args.length > 0 ? args.map((a, i) => (
            <span
              key={`${a.name}:${i}`}
              className="inline-flex items-center gap-1 rounded border border-chrome-border/60 bg-foreground/[0.035] px-1.5 py-0.5 text-[10px]"
            >
              <span className="font-mono text-foreground/85">{a.name}</span>
              <span className="font-mono text-chrome-text/40">{a.type}</span>
            </span>
          )) : (
            <span className="text-[10px] text-chrome-text/45">no explicit args</span>
          )}
        </div>
      </div>

      {signature ? (
        <div className="mt-2 break-all rounded border border-chrome-border/50 bg-foreground/[0.03] px-2 py-1.5 font-mono text-[10px] text-chrome-text/70">
          {signature}
        </div>
      ) : null}

      {note ? (
        <div className="mt-2 border-t border-chrome-border/40 pt-2 text-[9px] leading-snug text-chrome-text/50">
          {note}
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

function MiniOperatorGraph({ op, accent }: { op: SemanticOpMeta; accent: string }) {
  const markerBase = useId().replace(/:/g, "")
  const fullOp = useMemo(() => toRvbbitOperator(op), [op])
  const graph = useMemo(() => buildOperatorGraph(fullOp), [fullOp])
  const pos = (n: OpNode) => ({
    x: PAD + n.col * (NODE_W + COL_GAP),
    y: PAD + (n.row - graph.rowMin) * (NODE_H + ROW_GAP),
  })
  const posById = new Map(graph.nodes.map((n) => [n.id, pos(n)]))
  const width = PAD * 2 + graph.cols * (NODE_W + COL_GAP) - COL_GAP
  const rows = graph.rowMax - graph.rowMin + 1
  const height = PAD * 2 + rows * (NODE_H + ROW_GAP) - ROW_GAP
  const edgeId = `${markerBase}-semantic-op-arrow`

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-chrome-border/60 bg-[#0b0c0f]">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block h-[190px] w-full"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <marker id={edgeId} viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="5.5" markerHeight="5.5" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="color-mix(in oklch, var(--chrome-border) 86%, transparent)" />
          </marker>
        </defs>
        {graph.regions.map((r) => {
          const regionNodes = graph.nodes.filter((n) => n.col >= r.col0 && n.col <= r.col1 && n.row >= r.row0 && n.row <= r.row1)
          const ps = regionNodes.map((n) => posById.get(n.id)).filter((p): p is { x: number; y: number } => !!p)
          if (ps.length === 0) return null
          const minX = Math.min(...ps.map((p) => p.x))
          const minY = Math.min(...ps.map((p) => p.y))
          const maxX = Math.max(...ps.map((p) => p.x + NODE_W))
          const maxY = Math.max(...ps.map((p) => p.y + NODE_H))
          const color = r.kind === "retry" ? "var(--viz-op-gate)" : "var(--viz-op-llm)"
          return (
            <rect
              key={r.id}
              x={minX - 7}
              y={minY - 10}
              width={maxX - minX + 14}
              height={maxY - minY + 20}
              rx={10}
              fill={`color-mix(in oklch, ${color} 8%, transparent)`}
              stroke={color}
              strokeWidth={1.2}
              strokeDasharray="5 4"
              opacity={0.95}
            />
          )
        })}
        {graph.edges.map((e, i) => {
          const a = posById.get(e.from)
          const b = posById.get(e.to)
          if (!a || !b) return null
          if (e.kind === "loop") {
            const sx = a.x + NODE_W / 2
            const sy = a.y - 2
            const ex = b.x + NODE_W / 2
            const ey = b.y - 2
            const top = Math.min(sy, ey) - 22
            return (
              <path
                key={`edge:${i}`}
                d={`M ${sx} ${sy} C ${sx} ${top}, ${ex} ${top}, ${ex} ${ey}`}
                fill="none"
                stroke="var(--viz-op-gate)"
                strokeWidth={1.2}
                strokeDasharray="4 3"
              />
            )
          }
          const sx = a.x + NODE_W
          const sy = a.y + NODE_H / 2
          const ex = b.x
          const ey = b.y + NODE_H / 2
          const mx = (sx + ex) / 2
          return (
            <path
              key={`edge:${i}`}
              d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`}
              fill="none"
              stroke="color-mix(in oklch, var(--chrome-border) 86%, transparent)"
              strokeWidth={1.3}
              markerEnd={`url(#${edgeId})`}
            />
          )
        })}
        {graph.nodes.map((n) => {
          const p = posById.get(n.id) ?? { x: 0, y: 0 }
          const color = colorForNode(n, accent)
          return (
            <g key={n.id}>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={7}
                fill="color-mix(in oklch, var(--secondary-background) 92%, black)"
                stroke={color}
                strokeWidth={1.5}
              />
              <text x={p.x + 8} y={p.y + 14} fill={color} fontSize="8" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                {nodeKindLabel(n)}
              </text>
              <text x={p.x + 8} y={p.y + 27} fill="var(--foreground)" fontSize="9.5" fontFamily="ui-sans-serif, system-ui, sans-serif">
                {nodeTitle(fullOp, n)}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="flex items-center justify-between border-t border-chrome-border/40 px-2 py-1 text-[9px] text-chrome-text/45">
        <span className="inline-flex items-center gap-1">
          <FlowArrow className="h-2.5 w-2.5" style={{ color: accent }} />
          workflow preview
        </span>
        <span>{graph.nodes.length} nodes</span>
      </div>
    </div>
  )
}

function toRvbbitOperator(op: SemanticOpMeta): RvbbitOperator {
  return {
    name: op.name,
    shape: op.shape,
    arg_names: op.argNames,
    arg_types: op.argTypes,
    return_type: op.returnType,
    model: op.model ?? "",
    system_prompt: op.systemPrompt ?? "",
    user_prompt: op.userPrompt ?? "",
    parser: op.parser ?? "strip",
    max_tokens: op.maxTokens ?? 256,
    temperature: op.temperature ?? null,
    steps: op.steps ?? null,
    retry: op.retry ?? null,
    wards: op.wards ?? null,
    takes: op.takes ?? null,
    description: op.description ?? null,
    tests: null,
    infix_symbol: null,
  }
}

function nodeKindLabel(n: OpNode): string {
  if (n.ref.t === "input") return "input"
  if (n.ref.t === "output") return "output"
  if (n.ref.t === "ward") return `${n.ref.phase}-ward`
  if (n.ref.t === "filter") return "filter"
  if (n.ref.t === "reduce") return "reduce"
  return n.kind
}

function nodeTitle(op: RvbbitOperator, n: OpNode): string {
  switch (n.ref.t) {
    case "input":
      return short(op.arg_names[n.ref.index] ?? `arg${n.ref.index + 1}`, 12)
    case "output":
      return short(op.return_type, 12)
    case "step":
      return short(op.steps?.[n.ref.index]?.name ?? n.kind, 12)
    case "take-step":
      return short(op.steps?.[n.ref.index]?.name ?? n.kind, 12)
    case "take-node":
      return short(op.takes?.nodes?.[n.ref.index]?.name ?? n.kind, 12)
    case "take":
      return `take ${n.ref.index + 1}`
    case "ward":
      return n.ref.phase === "pre" ? "pre check" : "post check"
    case "filter":
      return "filter"
    case "reduce":
      return short(op.takes?.reduce ?? "reduce", 12)
    default:
      return short(n.kind, 12)
  }
}

function colorForNode(n: OpNode, accent: string): string {
  switch (n.kind) {
    case "input":
    case "output":
      return "var(--viz-op-terminal)"
    case "ward":
    case "reduce":
      return "var(--viz-op-gate)"
    case "llm":
      return accent
    case "specialist":
      return "var(--viz-op-specialist)"
    case "python":
      return "var(--viz-op-runtime)"
    case "code":
      return "var(--viz-op-code)"
    case "sql":
      return "var(--viz-op-sql)"
    case "mcp":
      return "var(--viz-op-mcp)"
    default:
      return "var(--chrome-border)"
  }
}

function titleCase(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}
