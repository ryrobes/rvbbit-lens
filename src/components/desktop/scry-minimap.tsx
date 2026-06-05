"use client"

import { useMemo } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { nodeCenter, type ScryEdge, type ScryNode, type ScryViewport } from "@/lib/desktop/scry-scene"
import { worldBounds } from "@/lib/desktop/scry-graph"

const INNER_W = 188
const INNER_H = 124
const PAD = 8

/**
 * Fixed, non-zoomable overview inset (bottom-left). Renders every node as a dot
 * in world→inset space, draws the live viewport rectangle (inverse transform of
 * the screen), and pans on click/drag. Dots-only past 60 nodes so it stays O(n).
 */
export function ScryMinimap({
  nodes,
  edges,
  scopeSet,
  selectedId,
  viewport,
  onJump,
}: {
  nodes: ScryNode[]
  edges: ScryEdge[]
  scopeSet: Set<string> | null
  selectedId: string | null
  viewport: ScryViewport
  onJump: (worldX: number, worldY: number) => void
}) {
  const box = useMemo(() => worldBounds(nodes), [nodes])

  const layout = useMemo(() => {
    if (!box) return null
    const bw = Math.max(1, box.maxX - box.minX)
    const bh = Math.max(1, box.maxY - box.minY)
    const scale = Math.min(INNER_W / bw, INNER_H / bh)
    const offX = (INNER_W - bw * scale) / 2
    const offY = (INNER_H - bh * scale) / 2
    const mini = (wx: number, wy: number) => ({ x: (wx - box.minX) * scale + offX, y: (wy - box.minY) * scale + offY })
    const toWorld = (mx: number, my: number) => ({ x: (mx - offX) / scale + box.minX, y: (my - offY) / scale + box.minY })
    return { scale, mini, toWorld }
  }, [box])

  // Live visible-world rectangle = inverse transform of the screen corners.
  const rect = useMemo(() => {
    if (!layout) return null
    const w = typeof window !== "undefined" ? window.innerWidth : 1280
    const h = typeof window !== "undefined" ? window.innerHeight : 720
    const tl = layout.mini((0 - viewport.x) / viewport.scale, (0 - viewport.y) / viewport.scale)
    const br = layout.mini((w - viewport.x) / viewport.scale, (h - viewport.y) / viewport.scale)
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
  }, [layout, viewport])

  const onJumpAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!layout) return
    const r = e.currentTarget.getBoundingClientRect()
    // strip the inner <g translate(PAD,PAD)> so coords are in mini-space, the
    // exact space toWorld() inverts (dots are placed by mini() then shifted +PAD)
    const mx = e.clientX - r.left - PAD
    const my = e.clientY - r.top - PAD
    const w = layout.toWorld(mx, my)
    onJump(w.x, w.y)
  }

  const showEdges = nodes.length < 60

  return (
    <div
      className="pointer-events-auto fixed bottom-3 left-3 z-[121] rounded-lg border border-chrome-border/60 bg-chrome-bg/70 p-1.5 shadow-2xl backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 px-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-terminal/70">map</div>
      <svg
        width={INNER_W + PAD * 2}
        height={INNER_H + PAD * 2}
        className="cursor-pointer touch-none select-none"
        onPointerDown={(e) => {
          e.stopPropagation()
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
          onJumpAt(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) onJumpAt(e)
        }}
      >
        <g transform={`translate(${PAD},${PAD})`}>
          <rect x={-PAD / 2} y={-PAD / 2} width={INNER_W + PAD} height={INNER_H + PAD} fill="transparent" />
          {layout && showEdges
            ? edges.map((e) => {
                const a = nodes.find((n) => n.id === e.from)
                const b = nodes.find((n) => n.id === e.to)
                if (!a || !b) return null
                const ca = nodeCenter(a)
                const cb = nodeCenter(b)
                const pa = layout.mini(ca.x, ca.y)
                const pb = layout.mini(cb.x, cb.y)
                return (
                  <line
                    key={e.id}
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke="var(--chrome-border)"
                    strokeWidth={0.5}
                    strokeOpacity={0.4}
                  />
                )
              })
            : null}
          {layout
            ? nodes.map((n) => {
                const c = nodeCenter(n)
                const p = layout.mini(c.x, c.y)
                const sel = n.id === selectedId
                const dim = scopeSet ? !scopeSet.has(n.id) : false
                return (
                  <circle
                    key={n.id}
                    cx={p.x}
                    cy={p.y}
                    r={sel ? 2.6 : 1.8}
                    fill={sel ? "var(--terminal)" : "var(--rvbbit-accent)"}
                    fillOpacity={dim ? 0.2 : sel ? 1 : 0.7}
                  />
                )
              })
            : null}
          {rect ? (
            <rect
              x={rect.x}
              y={rect.y}
              width={Math.max(2, rect.w)}
              height={Math.max(2, rect.h)}
              fill="var(--terminal)"
              fillOpacity={0.06}
              stroke="var(--terminal)"
              strokeOpacity={0.7}
              strokeWidth={1}
              style={{ pointerEvents: "none" }}
            />
          ) : null}
        </g>
      </svg>
    </div>
  )
}
