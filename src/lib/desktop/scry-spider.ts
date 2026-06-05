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
import { nodeCenter, nodeId, SCRY_NODE_H, SCRY_NODE_W, type ScryEdge, type ScryNode } from "./scry-scene"

export interface SpiderState {
  /** spider-only nodes, keyed by ScryNode id (no duplicates of hit nodes) */
  nodes: Map<string, ScryNode>
  /** edges keyed by `e:${edgeId}` — dedupe + self-loop guard live here */
  edges: Map<string, ScryEdge>
}

export const emptySpider = (): SpiderState => ({ nodes: new Map(), edges: new Map() })

/** Reconstruct a renderable hit from a raw kg_node endpoint (props ?? label split). */
function reconstructHit(id: number, kind: string, label: string, props: unknown): DataSearchHit {
  const p = (props ?? {}) as Record<string, unknown>
  const parts = String(label ?? "").split(".")
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
  const doc = str(p.search_doc) ?? str(p.doc) ?? ""
  if (kind === "db_table") {
    return {
      nodeId: id,
      kind: "db_table",
      schema: str(p.schema) ?? parts[0] ?? "?",
      rel: str(p.table) ?? str(p.rel) ?? parts[1] ?? parts[0] ?? label,
      col: null,
      score: null,
      doc,
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
  }
}

/** The endpoint of a neighbor edge that is NOT the source we expanded. */
function farEndpoint(n: KgNeighbor, srcNodeId: number) {
  return n.fromNodeId === srcNodeId
    ? { id: n.toNodeId, kind: n.toKind, label: n.toLabel, props: n.toProps }
    : { id: n.fromNodeId, kind: n.fromKind, label: n.fromLabel, props: n.fromProps }
}

/** Radial fan of `count` slots around a source node, packed into rings. */
export function placeNeighbors(source: ScryNode, count: number): { x: number; y: number }[] {
  const c = nodeCenter(source)
  const out: { x: number; y: number }[] = []
  const R0 = 240
  const STEP = 200
  const GAP = 44
  let placed = 0
  let ring = 0
  while (placed < count) {
    const radius = R0 + ring * STEP
    const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (SCRY_NODE_W + GAP)))
    const n = Math.min(capacity, count - placed)
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 - Math.PI / 2 + (ring % 2) * (Math.PI / n)
      out.push({
        x: c.x + Math.cos(a) * radius - SCRY_NODE_W / 2,
        y: c.y + Math.sin(a) * radius - SCRY_NODE_H / 2,
      })
    }
    placed += n
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
    const hit = reconstructHit(far.id, far.kind, far.label, far.props)
    const id = nodeId(hit)
    if (hitIds.has(id) || nodes.has(id) || seen.has(id)) continue
    seen.add(id)
    fresh.push({ id, hit })
  }
  const positions = placeNeighbors(source, fresh.length)
  fresh.forEach((f, i) => {
    nodes.set(f.id, {
      id: f.id,
      hit: f.hit,
      x: positions[i].x,
      y: positions[i].y,
      w: SCRY_NODE_W,
      h: SCRY_NODE_H,
      pinned: false,
    })
  })

  // second pass: edges (normalized subject->object, deduped by edge_id)
  for (const n of sliced) {
    const far = farEndpoint(n, source.hit.nodeId)
    if (far.id === source.hit.nodeId) continue
    const farId = nodeId(reconstructHit(far.id, far.kind, far.label, far.props))
    const key = `e:${n.edgeId}`
    if (edges.has(key)) continue
    const [from, to] = n.direction === "out" ? [source.id, farId] : [farId, source.id]
    if (from === to) continue
    edges.set(key, { id: key, from, to, kind: "neighbor", predicate: n.predicate })
  }

  return { next: { nodes, edges }, truncated }
}
