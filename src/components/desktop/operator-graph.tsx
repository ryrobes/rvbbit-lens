"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  Database,
  FileCode2,
  Filter,
  FlowArrow,
  Globe,
  RefreshCw,
  Shield,
  Sparkles,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import type {
  RvbbitOperator,
  OperatorReceipt,
  OpStep,
  NodeKind,
  SubCall,
  Validator,
} from "@/lib/rvbbit/operators"
import type { NodePos } from "@/lib/rvbbit/operator-layout"
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

// Limited zoom range — enough to breathe in a small window without losing
// the plot.
const MIN_ZOOM = 0.5
const MAX_ZOOM = 1.6

export type GraphMode = "build" | "run"

/** The upstream end of a drag-to-connect: a pipeline step, or an
 *  operator argument (input node). The downstream end is always a step. */
export type ConnectSource =
  | { t: "step"; index: number }
  | { t: "input"; name: string }

interface OperatorGraphProps {
  op: RvbbitOperator
  mode: GraphMode
  receipt?: OperatorReceipt | null
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
  /** Build mode → nodes can be dragged to reposition. */
  editable?: boolean
  /** Stored UI-only position overrides, keyed by node id. */
  positions?: Record<string, NodePos>
  /** Called on drag end with the node's new canvas position. */
  onMoveNode?: (id: string, pos: NodePos) => void
  /** Palette drop → add a step of `kind` at canvas `pos`. */
  onAddNode?: (kind: NodeKind, pos: NodePos) => void
  /** Palette drop of the "input" chip → add an operator argument. */
  onAddInput?: (pos: NodePos) => void
  /** Whether the palette offers the "input" chip (signature is editable). */
  allowAddInput?: boolean
  /** Drag-to-connect into a step from a step or an input argument. */
  onConnect?: (from: ConnectSource, toStepIndex: number) => void
  /** Click an edge to remove the wiring it represents. */
  onDisconnect?: (from: ConnectSource, toStepIndex: number) => void
  /** Connect a step → OUTPUT to make it the operator's result step. */
  onSetOutput?: (stepIndex: number) => void
  /** Remove a pipeline step (× on a selected step, or Delete key). */
  onDeleteStep?: (stepIndex: number) => void
  /** Remove an operator argument (× on a selected input node). */
  onDeleteInput?: (argIndex: number) => void
}

export function OperatorGraph({
  op,
  mode,
  receipt,
  selectedNodeId,
  onSelectNode,
  editable = false,
  positions,
  onMoveNode,
  onAddNode,
  onAddInput,
  allowAddInput = false,
  onConnect,
  onDisconnect,
  onSetOutput,
  onDeleteStep,
  onDeleteInput,
}: OperatorGraphProps) {
  const graph = useMemo(() => buildOperatorGraph(op), [op])
  const trace = useMemo(
    () => (mode === "run" && receipt ? mapTrace(op, receipt) : null),
    [mode, op, receipt],
  )

  const canvasRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const dragRef = useRef<{
    id: string
    offX: number
    offY: number
    sx: number
    sy: number
    x: number
    y: number
    moved: boolean
  } | null>(null)

  // Pan/zoom viewport. The canvas is translated+scaled; node positions stay
  // in untransformed canvas coords (pointerToCanvas converts back).
  const viewportRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  const [panning, setPanning] = useState(false)

  // Auto-layout grid position (the deterministic default).
  const gridX = (col: number) => PAD_X + col * COL_SPAN
  const gridY = (row: number) => PAD_Y + (row - graph.rowMin) * ROW_SPAN
  // Resolved position = live drag → stored override → grid default.
  const posOf = useCallback(
    (n: OpNode): NodePos => {
      if (drag && drag.id === n.id) return { x: drag.x, y: drag.y }
      return positions?.[n.id] ?? { x: gridX(n.col), y: gridY(n.row) }
    },
    // gridX/gridY depend only on graph.rowMin which is stable per graph
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag, positions, graph],
  )

  const posById = new Map(graph.nodes.map((n) => [n.id, posOf(n)]))

  // Canvas spans the auto-layout default and any dragged-out nodes.
  let maxX = PAD_X * 2 + graph.cols * COL_SPAN - COL_GAP
  let maxY = PAD_Y * 2 + (graph.rowMax - graph.rowMin + 1) * ROW_SPAN - ROW_GAP
  for (const p of posById.values()) {
    maxX = Math.max(maxX, p.x + NODE_W + PAD_X)
    maxY = Math.max(maxY, p.y + NODE_H + PAD_Y)
  }
  const width = maxX
  const height = maxY

  // Pointer → canvas-local coords, undoing the current pan + zoom.
  const pointerToCanvas = useCallback((clientX: number, clientY: number): NodePos => {
    const el = viewportRef.current
    if (!el) return { x: clientX, y: clientY }
    const r = el.getBoundingClientRect()
    const { zoom, panX, panY } = viewRef.current
    return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom }
  }, [])

  const beginDrag = useCallback(
    (nodeId: string, base: NodePos, e: React.PointerEvent) => {
      if (!editable) return
      e.preventDefault()
      const p = pointerToCanvas(e.clientX, e.clientY)
      dragRef.current = {
        id: nodeId,
        offX: p.x - base.x,
        offY: p.y - base.y,
        sx: e.clientX,
        sy: e.clientY,
        x: base.x,
        y: base.y,
        moved: false,
      }
      setDrag({ id: nodeId, x: base.x, y: base.y })

      const onMove = (ev: PointerEvent) => {
        const info = dragRef.current
        if (!info) return
        const c = pointerToCanvas(ev.clientX, ev.clientY)
        info.x = Math.max(0, Math.round(c.x - info.offX))
        info.y = Math.max(0, Math.round(c.y - info.offY))
        if (!info.moved && Math.hypot(ev.clientX - info.sx, ev.clientY - info.sy) > 4) {
          info.moved = true
        }
        setDrag({ id: info.id, x: info.x, y: info.y })
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        const info = dragRef.current
        dragRef.current = null
        setDrag(null)
        if (!info) return
        if (info.moved) onMoveNode?.(info.id, { x: info.x, y: info.y })
        else onSelectNode(selectedNodeId === info.id ? null : info.id)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [editable, pointerToCanvas, onMoveNode, onSelectNode, selectedNodeId],
  )

  // ── drag-to-connect ────────────────────────────────────────────────
  // Pipeline steps only — connecting writes a {{ steps.X.output }} ref
  // into the target step's inputs (the edge then renders from that ref).
  const [connect, setConnect] = useState<{
    fromId: string
    x: number
    y: number
    over: string | null
  } | null>(null)
  // Source can be a step or an input arg; target must be a step.
  const connectSourceOf = (id: string): ConnectSource | null => {
    const n = graph.nodes.find((x) => x.id === id)
    if (!n) return null
    if (n.ref.t === "step") return { t: "step", index: n.ref.index }
    if (n.ref.t === "input") return { t: "input", name: op.arg_names[n.ref.index] ?? "" }
    return null
  }
  const targetStepOf = (id: string): number | null => {
    const n = graph.nodes.find((x) => x.id === id)
    return n && n.ref.t === "step" ? n.ref.index : null
  }
  const connectableSource = (id: string): boolean => {
    const n = graph.nodes.find((x) => x.id === id)
    return !!n && (n.ref.t === "step" || n.ref.t === "input")
  }
  // Among all nodes under the point, pick the one whose centre is nearest —
  // robust when freshly dropped nodes overlap (first-in-order would lose).
  const nodeIdAt = (pt: NodePos): string | null => {
    let best: string | null = null
    let bestD = Infinity
    for (const n of graph.nodes) {
      const p = posById.get(n.id)
      if (!p) continue
      if (pt.x >= p.x && pt.x <= p.x + NODE_W && pt.y >= p.y && pt.y <= p.y + NODE_H) {
        const dx = pt.x - (p.x + NODE_W / 2)
        const dy = pt.y - (p.y + NODE_H / 2)
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = n.id
        }
      }
    }
    return best
  }
  const beginConnect = useCallback(
    (fromId: string, e: React.PointerEvent) => {
      if (!editable || !onConnect) return
      e.preventDefault()
      e.stopPropagation()
      const src = connectSourceOf(fromId)
      // Whether a node can receive THIS source (highlighted while hovering).
      const isValidTarget = (id: string | null): boolean => {
        if (!id || id === fromId || !src) return false
        if (id === "output") return src.t === "step"
        const to = targetStepOf(id)
        return to != null && !(src.t === "step" && src.index === to)
      }
      const p = pointerToCanvas(e.clientX, e.clientY)
      setConnect({ fromId, x: p.x, y: p.y, over: null })
      const onMove = (ev: PointerEvent) => {
        const c = pointerToCanvas(ev.clientX, ev.clientY)
        const t = nodeIdAt(c)
        setConnect((cur) => (cur ? { ...cur, x: c.x, y: c.y, over: isValidTarget(t) ? t : null } : cur))
      }
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        const c = pointerToCanvas(ev.clientX, ev.clientY)
        const targetId = nodeIdAt(c)
        setConnect(null)
        if (!targetId || targetId === fromId) return
        const from = connectSourceOf(fromId)
        if (!from) return
        // step → OUTPUT makes that step the operator's result.
        if (targetId === "output") {
          if (from.t === "step") onSetOutput?.(from.index)
          return
        }
        const to = targetStepOf(targetId)
        if (to == null) return
        if (from.t === "step" && from.index === to) return
        onConnect(from, to)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    // connectSourceOf / nodeIdAt close over graph + posById (stable per render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editable, onConnect, onSetOutput, pointerToCanvas, graph],
  )

  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return
      const raw = e.dataTransfer.getData("application/x-op-node-kind")
      if (!raw) return
      e.preventDefault()
      const c = pointerToCanvas(e.clientX, e.clientY)
      const pos = {
        x: Math.max(0, Math.round(c.x - NODE_W / 2)),
        y: Math.max(0, Math.round(c.y - NODE_H / 2)),
      }
      if (raw === "input") onAddInput?.(pos)
      else onAddNode?.(raw as NodeKind, pos)
    },
    [editable, onAddNode, onAddInput, pointerToCanvas],
  )

  // ── pan / zoom ─────────────────────────────────────────────────────
  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  // Drag the empty canvas to pan (nodes/handles/edges handle their own
  // pointerdown, so only background starts a pan).
  const onPanStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      if (e.target !== viewportRef.current && e.target !== canvasRef.current) return
      e.preventDefault()
      const sx = e.clientX
      const sy = e.clientY
      const base = viewRef.current
      let moved = false
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) {
          moved = true
          setPanning(true)
        }
        setView((v) => ({ ...v, panX: base.panX + (ev.clientX - sx), panY: base.panY + (ev.clientY - sy) }))
      }
      const onUp = () => {
        setPanning(false)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        // A click (no drag) on the empty canvas deselects → main panel.
        if (!moved) onSelectNode(null)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [onSelectNode],
  )

  // Wheel to zoom around the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const cx = e.clientX - r.left
      const cy = e.clientY - r.top
      setView((v) => {
        const z = clampZoom(v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
        const k = z / v.zoom
        return { zoom: z, panX: cx - k * (cx - v.panX), panY: cy - k * (cy - v.panY) }
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Zoom buttons pivot on the viewport centre.
  const zoomBy = (factor: number) => {
    const el = viewportRef.current
    const r = el?.getBoundingClientRect()
    const cx = (r?.width ?? 0) / 2
    const cy = (r?.height ?? 0) / 2
    setView((v) => {
      const z = clampZoom(v.zoom * factor)
      const k = z / v.zoom
      return { zoom: z, panX: cx - k * (cx - v.panX), panY: cy - k * (cy - v.panY) }
    })
  }
  const resetView = () => setView({ zoom: 1, panX: 0, panY: 0 })

  // Delete / Backspace removes the selected pipeline step.
  const selectedStepIndex = (() => {
    if (!selectedNodeId) return null
    const n = graph.nodes.find((x) => x.id === selectedNodeId)
    return n && n.ref.t === "step" ? n.ref.index : null
  })()
  useEffect(() => {
    if (!editable || !onDeleteStep || selectedStepIndex == null) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
      if (typing) return
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        onDeleteStep(selectedStepIndex)
        onSelectNode(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editable, onDeleteStep, selectedStepIndex, onSelectNode])

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
    <div
      ref={viewportRef}
      // Dark stage for contrast; glass-tints (window backdrop shows) when the
      // window isn't focused, like the rest of the window's surfaces.
      className="relative h-full w-full overflow-hidden bg-[#0b0c0f] group-data-[focused=false]/window:bg-[#0b0c0f]/70"
      onPointerDown={onPanStart}
      onDragOver={editable && onAddNode ? (e) => e.preventDefault() : undefined}
      onDrop={editable && onAddNode ? onCanvasDrop : undefined}
      style={{ cursor: panning ? "grabbing" : "grab" }}
    >
      <div
        ref={canvasRef}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width,
          height,
          transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
        }}
      >
        {/* regions behind everything — bbox of their contained nodes so
            they keep enclosing the nodes after a drag. */}
        {graph.regions.map((r) => {
          const inside = graph.nodes.filter(
            (n) => n.col >= r.col0 && n.col <= r.col1 && n.row >= r.row0 && n.row <= r.row1,
          )
          const ps = inside.map((n) => posById.get(n.id)).filter((p): p is NodePos => !!p)
          if (ps.length === 0) return null
          const minX = Math.min(...ps.map((p) => p.x))
          const minY = Math.min(...ps.map((p) => p.y))
          const maxXr = Math.max(...ps.map((p) => p.x + NODE_W))
          const maxYr = Math.max(...ps.map((p) => p.y + NODE_H))
          const outerPad = r.kind === "retry" ? 14 : 6
          const rx = minX - outerPad
          const ry = minY - outerPad - 16
          const rw = maxXr - minX + outerPad * 2
          const rh = maxYr - minY + outerPad * 2 + 16
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
            const a = posById.get(e.from)
            const b = posById.get(e.to)
            if (!a || !b) return null
            const downstreamStatus = statusOf(e.to)
            const upstreamStatus = statusOf(e.from)
            // An edge is "active" when both ends have trace evidence
            // (handles the input/output endpoint case too — input always
            // counts as traversed when any node has calls).
            const traversed =
              mode === "run" &&
              trace != null &&
              (e.from.startsWith("input-") || upstreamStatus === "ok" || upstreamStatus === "partial" || upstreamStatus === "failed") &&
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
              const sx = a.x + NODE_W / 2
              const sy = a.y
              const ex = b.x + NODE_W / 2
              const ey = b.y
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
            const sx = a.x + NODE_W
            const sy = a.y + NODE_H / 2
            const ex = b.x
            const ey = b.y + NODE_H / 2
            const mx = (sx + ex) / 2
            const d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`
            const deletable =
              editable &&
              !!onDisconnect &&
              connectableSource(e.from) &&
              targetStepOf(e.to) != null
            const path = (
              <path
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={traversed ? 2 : 1.5}
                markerEnd={marker}
              />
            )
            if (!deletable) return <g key={i}>{path}</g>
            return (
              <g key={i} className="group/edge">
                {path}
                {/* fat invisible hit-area; click severs the wiring */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ pointerEvents: "stroke", cursor: "pointer" }}
                  onClick={() => {
                    const src = connectSourceOf(e.from)
                    const to = targetStepOf(e.to)
                    if (src && to != null) onDisconnect?.(src, to)
                  }}
                  className="group-hover/edge:stroke-danger/25"
                >
                  <title>Click to disconnect</title>
                </path>
              </g>
            )
          })}
          {/* in-progress connect drag */}
          {connect
            ? (() => {
                const a = posById.get(connect.fromId)
                if (!a) return null
                const sx = a.x + NODE_W
                const sy = a.y + NODE_H / 2
                const mx = (sx + connect.x) / 2
                return (
                  <path
                    d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${connect.y}, ${connect.x} ${connect.y}`}
                    fill="none"
                    stroke="var(--main)"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                )
              })()
            : null}
        </svg>

        {/* nodes */}
        {graph.nodes.map((n) => {
          const p = posById.get(n.id) ?? { x: 0, y: 0 }
          return (
            <NodeBox
              key={n.id}
              op={op}
              node={n}
              mode={mode}
              receipt={receipt ?? null}
              calls={trace?.get(n.id) ?? null}
              status={statusOf(n.id)}
              selected={selectedNodeId === n.id}
              editable={editable}
              dragging={drag?.id === n.id}
              dropTarget={connect?.over === n.id}
              onSelect={() => onSelectNode(selectedNodeId === n.id ? null : n.id)}
              onPointerDownNode={(e) => beginDrag(n.id, p, e)}
              style={{
                position: "absolute",
                left: p.x,
                top: p.y,
                width: NODE_W,
                height: NODE_H,
              }}
            />
          )
        })}

        {/* output handles — drag from a step or input arg to wire it into a step */}
        {editable && onConnect
          ? graph.nodes
              .filter((n) => connectableSource(n.id))
              .map((n) => {
                const p = posById.get(n.id)
                if (!p) return null
                return (
                  <button
                    key={`handle-${n.id}`}
                    type="button"
                    title="Drag to connect this output into another node"
                    onPointerDown={(e) => beginConnect(n.id, e)}
                    className="group/handle absolute grid place-items-center border-0 bg-transparent"
                    style={{
                      left: p.x + NODE_W - 14,
                      top: p.y + NODE_H / 2 - 14,
                      width: 28,
                      height: 28,
                      zIndex: 25,
                      cursor: "crosshair",
                      touchAction: "none",
                    }}
                  >
                    <span className="h-3.5 w-3.5 rounded-full border-2 border-main bg-secondary-background shadow transition-all group-hover/handle:scale-125 group-hover/handle:bg-main" />
                  </button>
                )
              })
          : null}

        {/* delete affordance on the selected step / input node */}
        {editable && selectedNodeId
          ? (() => {
              const n = graph.nodes.find((x) => x.id === selectedNodeId)
              if (!n) return null
              const isStep = n.ref.t === "step"
              const isInput = n.ref.t === "input"
              if (!isStep && !isInput) return null
              if (isStep && !onDeleteStep) return null
              if (isInput && !onDeleteInput) return null
              const p = posById.get(n.id)
              if (!p) return null
              const idx = n.ref.t === "step" || n.ref.t === "input" ? n.ref.index : -1
              return (
                <button
                  type="button"
                  title={isStep ? "Delete step" : "Remove input"}
                  onClick={() => (isStep ? onDeleteStep?.(idx) : onDeleteInput?.(idx))}
                  className="absolute grid place-items-center rounded-full border border-danger bg-secondary-background text-danger transition-colors hover:bg-danger hover:text-chrome-bg"
                  style={{
                    left: p.x + NODE_W - 9,
                    top: p.y - 9,
                    width: 18,
                    height: 18,
                    zIndex: 26,
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )
            })()
          : null}
      </div>
      {editable && (onAddNode || (onAddInput && allowAddInput)) ? (
        <NodePalette showInput={!!onAddInput && allowAddInput} />
      ) : null}
      <ZoomControls
        zoom={view.zoom}
        onIn={() => zoomBy(1.2)}
        onOut={() => zoomBy(1 / 1.2)}
        onReset={resetView}
      />
    </div>
  )
}

function ZoomControls({
  zoom,
  onIn,
  onOut,
  onReset,
}: {
  zoom: number
  onIn: () => void
  onOut: () => void
  onReset: () => void
}) {
  const btn =
    "grid h-6 w-6 place-items-center rounded text-chrome-text/75 hover:bg-foreground/[0.08] hover:text-foreground"
  return (
    <div
      className="absolute bottom-3 right-3 z-30 flex items-center gap-0.5 rounded-md border border-chrome-border bg-chrome-bg/90 p-0.5 shadow-lg backdrop-blur"
      // Don't let clicks here start a pan.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={onOut} title="Zoom out" className={btn}>
        −
      </button>
      <button
        type="button"
        onClick={onReset}
        title="Reset zoom & position"
        className="min-w-[3ch] rounded px-1 text-center font-mono text-[10px] tabular-nums text-chrome-text/75 hover:bg-foreground/[0.08] hover:text-foreground"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" onClick={onIn} title="Zoom in" className={btn}>
        +
      </button>
    </div>
  )
}

// ── Palette — drag a step kind onto the canvas to add it ─────────────

const PALETTE_KINDS: { kind: NodeKind; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { kind: "llm", label: "llm", Icon: Sparkles },
  { kind: "specialist", label: "specialist", Icon: Brain },
  { kind: "python", label: "python", Icon: FileCode2 },
  { kind: "code", label: "code", Icon: Cpu },
  { kind: "sql", label: "sql", Icon: Database },
  { kind: "mcp", label: "mcp", Icon: Globe },
]

function NodePalette({ showInput }: { showInput: boolean }) {
  return (
    <div className="absolute left-3 top-3 z-30 flex flex-col gap-1 rounded-md border border-chrome-border bg-chrome-bg/90 p-1.5 shadow-lg backdrop-blur">
      <div className="px-1 pb-0.5 text-[8px] uppercase tracking-wider text-chrome-text/45">
        drag to add
      </div>
      {showInput ? (
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-op-node-kind", "input")
            e.dataTransfer.effectAllowed = "copy"
          }}
          className="flex cursor-grab items-center gap-1.5 rounded border border-chrome-border/60 bg-secondary-background px-1.5 py-1 text-[10px] hover:border-main/50 hover:text-foreground active:cursor-grabbing"
          style={{ color: "var(--main)" }}
        >
          <FlowArrow className="h-3 w-3" />
          <span className="text-chrome-text/85">input</span>
        </div>
      ) : null}
      {PALETTE_KINDS.map(({ kind, label, Icon }) => (
        <div
          key={kind}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-op-node-kind", kind)
            e.dataTransfer.effectAllowed = "copy"
          }}
          className="flex cursor-grab items-center gap-1.5 rounded border border-chrome-border/60 bg-secondary-background px-1.5 py-1 text-[10px] text-chrome-text/85 hover:border-main/50 hover:text-foreground active:cursor-grabbing"
          style={{ color: accentForSubCallKind(kind) }}
        >
          <Icon className="h-3 w-3" />
          <span className="text-chrome-text/85">{label}</span>
        </div>
      ))}
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
  | "python"
  | "sql"
  | "mcp"
  | "terminal"

const ACCENT_COLOR: Record<NodeAccent, string> = {
  plain: "var(--chrome-border)",
  rvbbit: "var(--rvbbit-accent)",
  gate: "var(--chart-3)",
  code: "var(--chart-2)",
  specialist: "var(--chart-1)",
  // Python/executor nodes share the capability/runtime brand hue, tying
  // them visually to the runtime-sidecar capability that serves them.
  python: "var(--brand-capability)",
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
  editable,
  dragging,
  dropTarget,
  onSelect,
  onPointerDownNode,
  style,
}: {
  op: RvbbitOperator
  node: OpNode
  mode: GraphMode
  receipt: OperatorReceipt | null
  calls: SubCall[] | null
  status: TraceStatus
  selected: boolean
  editable: boolean
  dragging: boolean
  dropTarget: boolean
  onSelect: () => void
  onPointerDownNode: (e: React.PointerEvent) => void
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
      onClick={editable ? undefined : onSelect}
      onPointerDown={editable ? onPointerDownNode : undefined}
      style={{
        ...style,
        borderColor: ss.borderColor,
        boxShadow: ss.shadow,
        touchAction: editable ? "none" : undefined,
        zIndex: dragging ? 20 : undefined,
        outline: dropTarget ? "2px solid var(--main)" : undefined,
        outlineOffset: dropTarget ? "2px" : undefined,
      }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-md border-2 bg-secondary-background text-left transition",
        "hover:ring-1 hover:ring-main/30",
        editable ? (dragging ? "cursor-grabbing" : "cursor-grab") : "",
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
      const argName = op.arg_names[ref.index] ?? `arg${ref.index + 1}`
      const argType = op.arg_types[ref.index] ?? "text"
      const runVal =
        mode === "run" && receipt?.inputs
          ? preview(String(receipt.inputs?.[argName] ?? ""), 70)
          : null
      return {
        Icon: FlowArrow,
        kindLabel: "input",
        title: argName,
        subtitle: argType,
        body: runVal ?? undefined,
        // The first input carries the operator's shape badge as a hint.
        badges: ref.index === 0 ? [op.shape] : [],
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
      return describeStepNode(op.steps?.[ref.index], op.model)
    case "take-step": {
      // Homogeneous takes fan the whole pipeline into N independent lanes;
      // tag each node with its take so the repetition reads as "N full runs".
      const view = describeStepNode(op.steps?.[ref.index], op.model)
      return { ...view, badges: [`take ${ref.take + 1}`, ...view.badges] }
    }
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
    case "python":
      return {
        Icon: FileCode2,
        kindLabel: "python",
        title: step.handler || "(unset)",
        subtitle: step.env ? `env: ${step.env}` : step.name,
        body: step.inputs ? Object.keys(step.inputs).join(", ") : undefined,
        badges: step.timeout_ms ? [`${step.timeout_ms}ms`] : [],
        accent: "python",
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
    case "python":
      return "var(--brand-capability)"
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
