"use client"

/**
 * Scry spider — the node-expansion data layer (P2 "ghost breadcrumbs").
 *
 * Pure functions over a SpiderState that is owned SEPARATELY from the search-hit
 * "bloom" nodes (which re-layout on every cascade keystroke). Keeping expanded
 * nodes + edges in their own state makes them structurally immune to the
 * re-bloom: nothing that recomputes hits can ever touch this state.
 */

import type { CatalogKind, DataSearchHit } from "@/lib/rvbbit/data-search"
import type { KgNeighbor } from "@/lib/rvbbit/kg"
import { nodeBox, nodeCenter, nodeId, type ScryEdge, type ScryNode } from "./scry-scene"

export interface SpiderState {
  /** spider-only nodes, keyed by ScryNode id (no duplicates of hit nodes) */
  nodes: Map<string, ScryNode>
  /** edges keyed by `e:${edgeId}` — dedupe + self-loop guard live here */
  edges: Map<string, ScryEdge>
}

export const emptySpider = (): SpiderState => ({ nodes: new Map(), edges: new Map() })

/** Reconstruct a renderable hit from a raw kg_node endpoint (props ?? label split).
 *  `degree` (connectedness) and `frequency` (distinct source rows) flow through so
 *  spider nodes size/heat consistently with bloom hits. */
function reconstructHit(id: number, kind: string, label: string, props: unknown, dataLayer = false, degree = 0, frequency = 0): DataSearchHit {
  const p = (props ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
  const doc = str(p.search_doc) ?? str(p.doc) ?? ""
  // Data layer: kg labels are free-text entities — unqualified and frequently
  // containing periods ("around 9 p.m. when it got dark"). Splitting on "." would
  // shred them into "schema/rel/col" garbage, so keep the whole label as the entity.
  if (dataLayer) {
    // Use the endpoint's REAL kg kind (typically 'entity') so the reconstructed id
    // `${kind}:${nodeId}` matches the bloom hit's id — otherwise a spidered neighbor
    // that is also a search hit dedupes wrong and renders twice with a floating edge.
    const k = (kind as CatalogKind) || "db_column"
    return { nodeId: id, kind: k, schema: "data", rel: label || "?", col: null, score: null, doc: doc || label, degree, frequency }
  }
  const parts = String(label ?? "").split(".")
  if (kind === "db_table") {
    return {
      nodeId: id,
      kind: "db_table",
      schema: str(p.schema) ?? parts[0] ?? "?",
      rel: str(p.table) ?? str(p.rel) ?? parts[1] ?? parts[0] ?? label,
      col: null,
      score: null,
      doc,
      degree,
      frequency,
    }
  }
  // anything non-table renders with the column glyph (safe fallback)
  const k: CatalogKind = "db_column"
  return {
    nodeId: id,
    kind: k,
    schema: str(p.schema) ?? parts[0] ?? "?",
    rel: str(p.table) ?? str(p.rel) ?? parts[1] ?? "?",
    col: str(p.name) ?? str(p.col) ?? parts[2] ?? label,
    score: null,
    doc,
    degree,
    frequency,
  }
}

/** The endpoint of a neighbor edge that is NOT the source we expanded. */
function farEndpoint(n: KgNeighbor, srcNodeId: number) {
  return n.fromNodeId === srcNodeId
    ? { id: n.toNodeId, kind: n.toKind, label: n.toLabel, props: n.toProps, degree: n.toDegree ?? 0, frequency: n.toFrequency ?? 0 }
    : { id: n.fromNodeId, kind: n.fromKind, label: n.fromLabel, props: n.fromProps, degree: n.fromDegree ?? 0, frequency: n.fromFrequency ?? 0 }
}

/** Radial fan around a source, packed into WIDTH-AWARE rings: each node consumes
 *  arc proportional to its box width, so variable-size data cards (hubs are wider)
 *  don't collide and the placement matches the size we actually render. */
export function placeNeighbors(source: ScryNode, boxes: { w: number; h: number }[]): { x: number; y: number }[] {
  const c = nodeCenter(source)
  const out: { x: number; y: number }[] = []
  const R0 = 240
  const STEP = 200
  const GAP = 44
  let placed = 0
  let ring = 0
  while (placed < boxes.length) {
    const radius = R0 + ring * STEP
    const circ = 2 * Math.PI * radius
    // greedily fit nodes whose (w+GAP) arc-lengths sum ≤ circumference; ≥1 per ring
    let used = 0
    let count = 0
    for (let i = placed; i < boxes.length; i++) {
      if (count > 0 && used + boxes[i].w + GAP > circ) break
      used += boxes[i].w + GAP
      count++
    }
    count = Math.max(1, count)
    const denom = used || 1
    let acc = 0
    for (let j = 0; j < count; j++) {
      const { w, h } = boxes[placed + j]
      const aCenter = ((acc + (w + GAP) / 2) / denom) * Math.PI * 2 - Math.PI / 2
      acc += w + GAP
      const a = aCenter + (ring % 2) * ((Math.PI / count) * 0.5)
      out.push({
        x: c.x + Math.cos(a) * radius - w / 2,
        y: c.y + Math.sin(a) * radius - h / 2,
      })
    }
    placed += count
    ring++
  }
  return out
}

/**
 * Merge a source node's KG neighbors into the spider state. Returns a NEW
 * SpiderState (never mutates prev). Dedupes new nodes against the current hit
 * ids AND existing spider nodes; dedupes edges by edge_id; skips self-loops.
 * Promotes the source into spider.nodes so its edges survive a hit re-bloom.
 */
export function mergeNeighbors(
  prev: SpiderState,
  source: ScryNode,
  neighbors: KgNeighbor[],
  hitIds: Set<string>,
  maxEdges: number,
  dataLayer = false,
): { next: SpiderState; truncated: boolean } {
  const truncated = neighbors.length > maxEdges
  const sliced = neighbors.slice(0, maxEdges)
  const nodes = new Map(prev.nodes)
  const edges = new Map(prev.edges)

  // promote the source so an edge endpoint survives even if its hit node is
  // later dropped by a re-bloom (render still prefers the live hit node).
  if (!nodes.has(source.id)) nodes.set(source.id, { ...source })

  // first pass: collect genuinely-new far endpoints (dedupe within batch too)
  const fresh: { id: string; hit: DataSearchHit }[] = []
  const seen = new Set<string>()
  for (const n of sliced) {
    const far = farEndpoint(n, source.hit.nodeId)
    if (far.id === source.hit.nodeId) continue // self-loop
    const hit = reconstructHit(far.id, far.kind, far.label, far.props, dataLayer, far.degree, far.frequency)
    const id = nodeId(hit)
    if (hitIds.has(id) || nodes.has(id) || seen.has(id)) continue
    seen.add(id)
    fresh.push({ id, hit })
  }
  const boxes = fresh.map((f) => nodeBox(f.hit, dataLayer))
  const positions = placeNeighbors(source, boxes)
  fresh.forEach((f, i) => {
    nodes.set(f.id, {
      id: f.id,
      hit: f.hit,
      x: positions[i].x,
      y: positions[i].y,
      w: boxes[i].w,
      h: boxes[i].h,
      pinned: false,
    })
  })

  // second pass: edges (normalized subject->object, deduped by edge_id)
  for (const n of sliced) {
    const far = farEndpoint(n, source.hit.nodeId)
    if (far.id === source.hit.nodeId) continue
    const farId = nodeId(reconstructHit(far.id, far.kind, far.label, far.props, dataLayer, far.degree, far.frequency))
    const key = `e:${n.edgeId}`
    if (edges.has(key)) continue
    const [from, to] = n.direction === "out" ? [source.id, farId] : [farId, source.id]
    if (from === to) continue
    edges.set(key, { id: key, from, to, kind: "neighbor", predicate: n.predicate })
  }

  return { next: { nodes, edges }, truncated }
}
