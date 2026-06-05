/**
 * Scry canvas scene model — the ephemeral spatial layer's pure data + math.
 *
 * Mirrors the desktop viewport (DesktopViewportState) as a DISTINCT nominal
 * type so the two pan/zoom systems can never be cross-wired. No React here —
 * this is unit-testable geometry the canvas/hooks consume.
 */

import type { DataSearchHit } from "@/lib/rvbbit/data-search"

export interface ScryViewport {
  /** screen-px offset of the world origin */
  x: number
  y: number
  /** 1 = 100% */
  scale: number
}

export const SCRY_MIN_SCALE = 0.45
export const SCRY_MAX_SCALE = 1.6
export const DEFAULT_SCRY_VIEWPORT: ScryViewport = { x: 0, y: 0, scale: 1 }

/** Infinity-safe + scale-clamped (mirrors the desktop clampViewport). */
export function clampScryViewport(v: ScryViewport): ScryViewport {
  return {
    x: Number.isFinite(v.x) ? v.x : 0,
    y: Number.isFinite(v.y) ? v.y : 0,
    scale: Math.min(SCRY_MAX_SCALE, Math.max(SCRY_MIN_SCALE, Number.isFinite(v.scale) ? v.scale : 1)),
  }
}

export const SCRY_NODE_W = 196
export const SCRY_NODE_H = 64

export interface ScryNode {
  /** stable id `${hit.kind}:${hit.nodeId}` (carries the KG node id for the P2 spider) */
  id: string
  hit: DataSearchHit
  /** world coords (top-left); mutable once the user drags */
  x: number
  y: number
  w: number
  h: number
  /** true once dragged — layout won't reflow it on a live re-search */
  pinned: boolean
}

export interface ScryEdge {
  /** stable dedupe key — `e:${kg_edges.edge_id}` */
  id: string
  /** ScryNode id of the subject (arrow tail) */
  from: string
  /** ScryNode id of the object (arrow head) */
  to: string
  kind: "within" | "neighbor"
  /** edge predicate, e.g. "has_column", "references" */
  predicate: string
}

/** Center of a node in world coords (edge endpoints attach here). */
export function nodeCenter(n: ScryNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
}

export interface ScryScene {
  origin: { x: number; y: number }
  nodes: ScryNode[]
  edges: ScryEdge[]
}

export function nodeId(hit: DataSearchHit): string {
  return `${hit.kind}:${hit.nodeId}`
}

/**
 * Radial "bloom" of hits around an origin, packed into concentric rings so the
 * wide cards don't overlap. Nodes the user has dragged (`pinned`, matched by id
 * from `prev`) keep their saved position so a live re-search doesn't yank them.
 */
export function layoutScene(
  hits: DataSearchHit[],
  origin: { x: number; y: number },
  prev: ScryNode[],
): ScryScene {
  const pinned = new Map(prev.filter((n) => n.pinned).map((n) => [n.id, n] as const))
  const nodes: ScryNode[] = []
  const RING0 = 260
  const RING_STEP = 200
  const GAP = 44

  const free = hits.filter((h) => !pinned.has(nodeId(h)))
  let placed = 0
  let ring = 0
  while (placed < free.length) {
    const radius = RING0 + ring * RING_STEP
    const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (SCRY_NODE_W + GAP)))
    const count = Math.min(capacity, free.length - placed)
    for (let j = 0; j < count; j++) {
      const hit = free[placed + j]
      // start at top, go clockwise; stagger alternate rings so cards interleave
      const a = (j / count) * Math.PI * 2 - Math.PI / 2 + (ring % 2) * (Math.PI / count)
      nodes.push({
        id: nodeId(hit),
        hit,
        w: SCRY_NODE_W,
        h: SCRY_NODE_H,
        pinned: false,
        x: origin.x + Math.cos(a) * radius - SCRY_NODE_W / 2,
        y: origin.y + Math.sin(a) * radius - SCRY_NODE_H / 2,
      })
    }
    placed += count
    ring++
  }

  // re-add pinned nodes that are still part of the current hit set
  const present = new Set(hits.map(nodeId))
  for (const [id, n] of pinned) if (present.has(id)) nodes.push(n)

  return { origin, nodes, edges: [] }
}
