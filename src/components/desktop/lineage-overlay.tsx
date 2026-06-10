"use client"

import { useMemo } from "react"
import type {
  DesktopParamValue,
  DesktopWindowState,
} from "@/lib/desktop/types"
import {
  buildDesktopRuntimeGraph,
  type DesktopRuntimeGraph,
} from "@/lib/desktop/reactive-sql"

interface LineageOverlayProps {
  windows: DesktopWindowState[]
  params: DesktopParamValue[]
}

type LinkKind = "block-ref" | "param-sub"

interface Link {
  kind: LinkKind
  fromId: string
  toId: string
}

/**
 * Draws subtle SVG curves between SQL windows that reference each
 * other — either via `{X}` block substitutions or shared params.
 *
 * The overlay sits *behind* the window stack at z-5: focused windows
 * cover the line where it passes underneath, which feels natural
 * (windows are objects sitting on a canvas; the wires run beneath
 * the surface). Glass-mode unfocused windows show the line through.
 *
 * Two link types, visually distinguished:
 *
 *   - Block reference (`{X}` substitution) → dashed teal (rvbbit-accent)
 *     curve with an arrowhead on the downstream end. Data lineage.
 *   - Param subscription → a finer `--main` curve with an animated dot
 *     flow toward the subscriber (matches the param UI — shelf chips +
 *     pick highlights are all `--main`). Shows "this control affects that".
 *
 * Both use a quadratic Bezier with a perpendicular control-point
 * bend so parallel links between the same pair of windows don't
 * stack on top of each other.
 */
export function LineageOverlay({ windows, params }: LineageOverlayProps) {
  const graph: DesktopRuntimeGraph = useMemo(
    () => buildDesktopRuntimeGraph(windows, params),
    [windows, params],
  )

  const links = useMemo<Link[]>(() => computeLinks(graph, params), [graph, params])

  if (links.length === 0) return null

  const dataWindows = windows.filter((w) => w.kind === "data" && !w.minimized)
  const byId = new Map(dataWindows.map((w) => [w.id, w]))

  const segments = links
    .map((link) => {
      const from = byId.get(link.fromId)
      const to = byId.get(link.toId)
      if (!from || !to) return null
      const a = windowCenter(from)
      const b = windowCenter(to)
      return { ...link, from: a, to: b }
    })
    .filter((s): s is { kind: LinkKind; fromId: string; toId: string; from: { x: number; y: number }; to: { x: number; y: number } } => !!s)

  if (segments.length === 0) return null

  // Compute the SVG viewport — track the bounding box of all segments
  // so we don't paint outside. World coords align 1:1 with window
  // positions (no zoom/pan supported yet); the SVG fills the desktop
  // and stays in document coordinates.
  return (
    <svg
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 5 }}
      width="100%"
      height="100%"
    >
      <defs>
        <marker
          id="rvbbit-lineage-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--rvbbit-accent)" />
        </marker>
        <marker
          id="rvbbit-param-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L10,5 L0,10 Z" fill="var(--main)" />
        </marker>
      </defs>
      {segments.map((s, i) => {
        // Quadratic Bezier with a perpendicular bow so parallel arrows
        // don't lie on top of each other.
        const mx = (s.from.x + s.to.x) / 2
        const my = (s.from.y + s.to.y) / 2
        const dx = s.to.x - s.from.x
        const dy = s.to.y - s.from.y
        const len = Math.max(1, Math.hypot(dx, dy))
        const bow = Math.min(60, len * 0.18)
        // Perpendicular unit vector; flip a few based on hash so links
        // between the same pair don't all bend the same way.
        const sign = ((s.fromId + s.toId).charCodeAt(0) + i) % 2 === 0 ? 1 : -1
        const cx = mx + (-dy / len) * bow * sign
        const cy = my + (dx / len) * bow * sign
        const d = `M ${s.from.x} ${s.from.y} Q ${cx} ${cy} ${s.to.x} ${s.to.y}`
        const isParam = s.kind === "param-sub"
        return (
          <path
            key={`${s.fromId}->${s.toId}:${s.kind}:${i}`}
            d={d}
            fill="none"
            stroke={isParam ? "var(--main)" : "var(--rvbbit-accent)"}
            strokeOpacity={isParam ? 0.7 : 0.75}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={isParam ? "2 5" : "6 4"}
            markerEnd={isParam ? "url(#rvbbit-param-arrow)" : "url(#rvbbit-lineage-arrow)"}
          >
            {isParam ? (
              // animated dot-flow from the param source toward the subscriber.
              <animate
                attributeName="stroke-dashoffset"
                values="0;-7"
                dur="0.7s"
                repeatCount="indefinite"
              />
            ) : null}
          </path>
        )
      })}
    </svg>
  )
}

function computeLinks(graph: DesktopRuntimeGraph, params: DesktopParamValue[]): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()

  for (const block of graph.blocks.values()) {
    for (const upstreamId of block.upstreamWindowIds) {
      const key = `b:${upstreamId}>${block.windowId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: "block-ref", fromId: upstreamId, toId: block.windowId })
    }
    for (const sub of block.subscriptions) {
      const param = params.find((p) => p.key.toLowerCase() === sub.key.toLowerCase())
      if (!param) continue
      // Self-subs (a window subscribing to a param it emitted) shouldn't
      // draw a line — there's no upstream to point at.
      if (param.sourceWindowId === block.windowId) continue
      const key = `p:${param.sourceWindowId}>${block.windowId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: "param-sub", fromId: param.sourceWindowId, toId: block.windowId })
    }
  }
  return out
}

function windowCenter(w: DesktopWindowState): { x: number; y: number } {
  return { x: w.x + w.width / 2, y: w.y + w.height / 2 }
}
