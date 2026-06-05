/**
 * Scry P5 auto-layout — a compact Fruchterman–Reingold relaxation over node
 * CENTERS. No deps. Pinned nodes are FIXED anchors: they exert repulsion +
 * attraction on others but never move themselves, so a user's dragged layout is
 * respected. Returns NEW top-left positions for the UNPINNED nodes only.
 *
 * O(n²) per iteration; bounded by the P5 node cap (≤300), it runs in a few ms.
 */
import { SCRY_NODE_W, type ScryEdge, type ScryNode } from "./scry-scene"

export function relaxLayout(
  nodes: ScryNode[],
  edges: ScryEdge[],
  opts: { iters?: number } = {},
): Map<string, { x: number; y: number }> {
  const iters = opts.iters ?? 140
  const result = new Map<string, { x: number; y: number }>()
  if (nodes.length < 2) return result

  const K = SCRY_NODE_W + 44 // ideal edge length ≈ the radial ring spacing
  const pos = nodes.map((n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2, pinned: n.pinned }))
  const idx = new Map(nodes.map((n, i) => [n.id, i] as const))

  let temp = K * 1.4
  const cool = temp / (iters + 1)

  for (let it = 0; it < iters; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }))

    // repulsion: every pair pushes apart, ∝ K²/dist
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) {
          // coincident — nudge deterministically (by index) so they separate
          dx = (i - j) * 0.7 + 0.3
          dy = 0.3
          dist = Math.hypot(dx, dy)
        }
        const force = (K * K) / dist
        const ux = dx / dist
        const uy = dy / dist
        disp[i].x += ux * force
        disp[i].y += uy * force
        disp[j].x -= ux * force
        disp[j].y -= uy * force
      }
    }

    // attraction: edge endpoints pull together, ∝ dist²/K
    for (const e of edges) {
      const ia = idx.get(e.from)
      const ib = idx.get(e.to)
      if (ia == null || ib == null || ia === ib) continue
      let dx = pos[ia].x - pos[ib].x
      let dy = pos[ia].y - pos[ib].y
      let dist = Math.hypot(dx, dy)
      if (dist < 0.01) dist = 0.01
      const force = (dist * dist) / K
      const ux = dx / dist
      const uy = dy / dist
      disp[ia].x -= ux * force
      disp[ia].y -= uy * force
      disp[ib].x += ux * force
      disp[ib].y += uy * force
    }

    // apply, clamped to the cooling temperature; pinned nodes never move
    let maxMove = 0
    for (let i = 0; i < pos.length; i++) {
      if (pos[i].pinned) continue
      const d = disp[i]
      const len = Math.hypot(d.x, d.y) || 1
      const mv = Math.min(len, temp)
      pos[i].x += (d.x / len) * mv
      pos[i].y += (d.y / len) * mv
      if (mv > maxMove) maxMove = mv
    }

    temp = Math.max(0, temp - cool)
    if (maxMove < 0.5) break // settled
  }

  // centers → top-left, unpinned nodes only
  for (const n of nodes) {
    if (n.pinned) continue
    const i = idx.get(n.id)
    if (i == null) continue
    result.set(n.id, { x: pos[i].x - n.w / 2, y: pos[i].y - n.h / 2 })
  }
  return result
}
