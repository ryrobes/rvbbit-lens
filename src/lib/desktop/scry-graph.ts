/**
 * Pure graph geometry/traversal helpers for Scry P5 — no React, unit-testable
 * like scry-scene.ts. Consumed by fit-to-view, the mini-map, and scope-within.
 */
import type { ScryEdge, ScryNode } from "./scry-scene"

export interface WorldBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Axis-aligned world box covering every node's FULL card extent (not just top-left). */
export function worldBounds(nodes: ScryNode[]): WorldBounds | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x + n.w > maxX) maxX = n.x + n.w
    if (n.y + n.h > maxY) maxY = n.y + n.h
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Connected component containing `rootId`, traversed UNDIRECTED (Scry edges are
 * directional from/to, but a neighborhood spans both directions). An isolated
 * node returns just `{rootId}`.
 */
export function connectedComponent(rootId: string, edges: ScryEdge[]): Set<string> {
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const l = adj.get(a)
    if (l) l.push(b)
    else adj.set(a, [b])
  }
  for (const e of edges) {
    link(e.from, e.to)
    link(e.to, e.from)
  }
  const seen = new Set<string>([rootId])
  const queue: string[] = [rootId]
  while (queue.length) {
    const cur = queue.shift() as string
    for (const nb of adj.get(cur) ?? []) {
      if (!seen.has(nb)) {
        seen.add(nb)
        queue.push(nb)
      }
    }
  }
  return seen
}
