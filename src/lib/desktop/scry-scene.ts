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

// ── Data-layer node sizing ────────────────────────────────────────────────
// Data nodes are entities whose VALUE is the text + how central they are. So the
// box fits its CONTENT (width grows with label length up to a cap; height wraps to
// a clamped line count) and is then scaled by an IMPORTANCE multiplier from degree,
// so hubs read bigger (and, in the node renderer, hotter) than leaf details.
const DATA_MIN_W = 150
const DATA_MAX_W = 244
const DATA_LINE_H = 16
const DATA_MAX_LINES = 4
const DATA_CHROME_H = 34 // body padding + footer row (glyph · freq · score)
const DATA_CHAR_W = 6.7 // ~mono 11px advance, for the line-count estimate
const DATA_FREQ_REF = 5 // frequency (distinct source rows) at which importance saturates;
//                         most entities recur in ~1 report, the top in 5–11, so a low ref
//                         spreads the common low-frequency range across the heat/size ramp.

/** Normalized importance in [0,1] from a node's FREQUENCY (how many source rows it
 *  recurs across). sqrt ramp — the distribution is long-tailed, so linear looks flat. */
export function dataImportance(frequency: number): number {
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, frequency)) / Math.sqrt(DATA_FREQ_REF)))
}

/** Box dimensions for a data entity node: content shape × frequency-importance scale. */
export function dataNodeSize(text: string, frequency: number): { w: number; h: number } {
  const len = (text ?? "").length
  const contentW = Math.round(Math.max(DATA_MIN_W, Math.min(DATA_MAX_W, DATA_MIN_W + (len - 12) * 2.1)))
  // 42px = non-text chrome before the label (border 4 + px-2 16 + KindBadge 16 + gap 6);
  // underestimating it overcounts chars/line → too few lines → silent height clip.
  const cpl = Math.max(8, Math.floor((contentW - 42) / DATA_CHAR_W))
  const lines = Math.max(1, Math.min(DATA_MAX_LINES, Math.ceil(len / cpl)))
  const contentH = DATA_CHROME_H + lines * DATA_LINE_H
  const scale = 0.92 + 0.5 * dataImportance(frequency) // 0.92 (rare) → 1.42 (frequent)
  return { w: Math.round(contentW * scale), h: Math.round(contentH * scale) }
}

/** Max lines of label text a data node shows before ellipsis (matches dataNodeSize). */
export const DATA_NODE_MAX_LINES = DATA_MAX_LINES

/** Per-node box for either layer (structure = fixed; data = content×importance). */
export function nodeBox(hit: DataSearchHit, dataLayer: boolean): { w: number; h: number } {
  return dataLayer ? dataNodeSize(hit.rel, hit.frequency) : { w: SCRY_NODE_W, h: SCRY_NODE_H }
}

/** Push apart any overlapping boxes (mutates x/y in place) along the least-penetration
 *  axis — a cheap deterministic pass that guarantees the variable-size data bloom has
 *  no overlapping cards even where the radial packing's geometry leaves a little. */
function resolveOverlaps(boxes: ScryNode[], gap = 18, passes = 18): void {
  for (let pass = 0; pass < passes; pass++) {
    let clean = true
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const dx = a.x + a.w / 2 - (b.x + b.w / 2)
        const dy = a.y + a.h / 2 - (b.y + b.h / 2)
        const ox = (a.w + b.w) / 2 + gap - Math.abs(dx)
        const oy = (a.h + b.h) / 2 + gap - Math.abs(dy)
        if (ox > 0 && oy > 0) {
          clean = false
          if (ox < oy) {
            const s = (dx < 0 ? -1 : 1) * (ox / 2)
            a.x += s
            b.x -= s
          } else {
            const s = (dy < 0 ? -1 : 1) * (oy / 2)
            a.y += s
            b.y -= s
          }
        }
      }
    }
    if (clean) break
  }
}

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
  dataLayer = false,
): ScryScene {
  const pinned = new Map(prev.filter((n) => n.pinned).map((n) => [n.id, n] as const))
  const nodes: ScryNode[] = []
  const RING0 = 260
  const RING_STEP = dataLayer ? 188 : 200
  const GAP = 44

  const free = hits.filter((h) => !pinned.has(nodeId(h)))

  if (!dataLayer) {
    // ── STRUCTURE layer: original fixed-size concentric-ring bloom (unchanged) ──
    let placed = 0
    let ring = 0
    while (placed < free.length) {
      const radius = RING0 + ring * RING_STEP
      const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (SCRY_NODE_W + GAP)))
      const count = Math.min(capacity, free.length - placed)
      for (let j = 0; j < count; j++) {
        const hit = free[placed + j]
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
    const presentS = new Set(hits.map(nodeId))
    for (const [id, n] of pinned) if (presentS.has(id)) nodes.push(n)
    return { origin, nodes, edges: [] }
  }

  // ── DATA layer: importance-weighted ring placement + content-sized cards ──
  // Sort inward by a BLEND of frequency-importance and relevance, so the most
  // recurring entities pull toward the center BUT a highly-relevant one-off hit isn't
  // categorically banished to the rim. W_HUB tunes the balance.
  const W_HUB = 0.62
  const rank = (h: DataSearchHit) => W_HUB * dataImportance(h.frequency) + (1 - W_HUB) * (h.score ?? 0)
  const sorted = [...free].sort((a, b) => rank(b) - rank(a))

  let placed = 0
  let ring = 0
  while (placed < sorted.length) {
    const radius = RING0 + ring * RING_STEP
    const circ = 2 * Math.PI * radius
    // width-aware ring fill: nodes consume arc proportional to their box width, so
    // variable-size data cards don't collide. Always place at least one.
    let used = 0
    let count = 0
    for (let i = placed; i < sorted.length; i++) {
      const w = nodeBox(sorted[i], dataLayer).w
      if (count > 0 && used + w + GAP > circ) break
      used += w + GAP
      count++
    }
    count = Math.max(1, count)
    const denom = used || 1
    let acc = 0
    for (let j = 0; j < count; j++) {
      const hit = sorted[placed + j]
      const { w, h } = nodeBox(hit, dataLayer)
      // angle ∝ cumulative arc share (width-weighted); stagger alternate rings
      const aCenter = ((acc + (w + GAP) / 2) / denom) * Math.PI * 2 - Math.PI / 2
      acc += w + GAP
      const a = aCenter + (ring % 2) * ((Math.PI / count) * 0.5)
      nodes.push({
        id: nodeId(hit),
        hit,
        w,
        h,
        pinned: false,
        x: origin.x + Math.cos(a) * radius - w / 2,
        y: origin.y + Math.sin(a) * radius - h / 2,
      })
    }
    placed += count
    ring++
  }

  // guarantee the variable-size bloom has no overlapping cards
  resolveOverlaps(nodes)

  // re-add pinned nodes that are still part of the current hit set
  const present = new Set(hits.map(nodeId))
  for (const [id, n] of pinned) if (present.has(id)) nodes.push(n)

  return { origin, nodes, edges: [] }
}
