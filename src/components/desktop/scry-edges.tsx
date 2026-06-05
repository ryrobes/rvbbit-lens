"use client"

import { nodeCenter, type ScryEdge, type ScryNode } from "@/lib/desktop/scry-scene"

/**
 * World-coord SVG edge layer — lives INSIDE the scry transform container so
 * beziers pan/zoom with the nodes. Only the fat invisible hit-path is
 * interactive; the visible stroke + predicate label (on select) are inert so
 * empty-canvas panning still works everywhere else.
 */
export function ScryEdgeLayer({
  edges,
  nodeById,
  selectedEdgeId,
  selectedNodeId,
  onSelectEdge,
}: {
  edges: ScryEdge[]
  nodeById: (id: string) => ScryNode | undefined
  selectedEdgeId: string | null
  /** when a node is selected, its incident edges + labels light up too */
  selectedNodeId: string | null
  onSelectEdge: (id: string | null) => void
}) {
  return (
    <svg className="absolute inset-0 overflow-visible" style={{ pointerEvents: "none" }} aria-hidden>
      <defs>
        <marker id="scry-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--chrome-border)" />
        </marker>
        <marker id="scry-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--terminal)" />
        </marker>
      </defs>
      {edges.map((e) => {
        const a = nodeById(e.from)
        const b = nodeById(e.to)
        if (!a || !b) return null // dangling endpoint (e.g. a hit node re-bloomed away)
        const p1 = nodeCenter(a)
        const p2 = nodeCenter(b)
        const sel = e.id === selectedEdgeId
        // "hot" = this edge is selected, OR it's incident to the selected node
        const hot = sel || (!!selectedNodeId && (e.from === selectedNodeId || e.to === selectedNodeId))
        const dx = (p2.x - p1.x) * 0.4
        const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`
        const mx = (p1.x + p2.x) / 2
        const my = (p1.y + p2.y) / 2
        return (
          <g key={e.id}>
            {/* fat invisible hit target */}
            <path
              d={d}
              stroke="transparent"
              strokeWidth={10}
              fill="none"
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onPointerDown={(ev) => {
                ev.stopPropagation()
                onSelectEdge(sel ? null : e.id)
              }}
            />
            <path
              d={d}
              fill="none"
              stroke={hot ? "var(--terminal)" : "var(--chrome-border)"}
              strokeWidth={hot ? 1.6 : 1}
              strokeOpacity={hot ? 0.95 : e.kind === "within" ? 0.32 : 0.5}
              // "within" = implicit structure among search results (dashed);
              // "neighbor" = explicitly spidered (solid). Hot edges go solid.
              strokeDasharray={e.kind === "within" && !hot ? "4 3" : undefined}
              markerEnd={`url(#${hot ? "scry-arrow-sel" : "scry-arrow"})`}
              style={{ pointerEvents: "none" }}
            />
            {hot ? (
              <text
                x={mx}
                y={my - 4}
                textAnchor="middle"
                className="font-mono"
                style={{
                  fontSize: 10,
                  fill: "var(--terminal)",
                  pointerEvents: "none",
                  paintOrder: "stroke",
                  stroke: "var(--block-bg)",
                  strokeWidth: 3,
                }}
              >
                {e.predicate}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
