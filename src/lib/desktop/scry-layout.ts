/**
 * Scry auto-layout — a compact force relaxation over node CENTERS. No deps.
 * Pinned nodes are FIXED anchors: they exert forces on others but never move
 * themselves, so a user's dragged layout is respected. Returns NEW top-left
 * positions for the UNPINNED nodes only.
 *
 * Forces: pairwise repulsion, edge attraction, a GRAVITY pull toward the graph
 * center (bounds the cloud + rescues disconnected/orphan nodes that pure
 * repulsion would fling to infinity), and size-aware COLLISION so cards never
 * overlap. With `radial`, gravity targets a per-node RING whose radius shrinks
 * with importance (degree) — hubs settle inward, leaf details fan to the rim,
 * giving an emergent hierarchy alongside the associative edges.
 *
 * O(n²) per iteration; bounded by the node cap (≤300), it runs in a few ms.
 */
import { dataImportance, SCRY_NODE_W, type ScryEdge, type ScryNode } from "./scry-scene"

export function relaxLayout(
  nodes: ScryNode[],
  edges: ScryEdge[],
  opts: { iters?: number; radial?: boolean } = {},
): Map<string, { x: number; y: number }> {
  const iters = opts.iters ?? 170
  const radial = opts.radial ?? false
  const result = new Map<string, { x: number; y: number }>()
  if (nodes.length < 2) return result

  const K = SCRY_NODE_W + 44 // ideal edge length ≈ the radial ring spacing
  const GAP = 18 // min gap between card edges for the collision pass
  const pos = nodes.map((n) => ({
    x: n.x + n.w / 2,
    y: n.y + n.h / 2,
    w: n.w,
    h: n.h,
    pinned: n.pinned,
    imp: radial ? dataImportance(n.hit.frequency ?? 0) : 0,
  }))
  const idx = new Map(nodes.map((n, i) => [n.id, i] as const))

  // center = centroid (anchor for gravity / the radial rings)
  let cx = 0
  let cy = 0
  for (const p of pos) {
    cx += p.x
    cy += p.y
  }
  cx /= pos.length
  cy /= pos.length

  // per-node target ring radius: hubs (imp→1) pull to the core, leaves to the rim
  const R_CORE = K * 0.35
  const R_SPAN = K * 2.4
  const targetR = pos.map((p) => R_CORE + (1 - p.imp) * R_SPAN)
  const GRAVITY = radial ? 0.11 : 0.05

  let temp = K * 1.4
  const cool = temp / (iters + 1)

  for (let it = 0; it < iters; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }))

    // repulsion: every pair pushes apart, ∝ K²/dist (cutoff beyond 3.5K so distant
    // clusters don't inflate the whole graph — gravity does the global bounding)
    const cutoff = K * 3.5
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) {
          dx = (i - j) * 0.7 + 0.3
          dy = 0.3
          dist = Math.hypot(dx, dy)
        }
        if (dist > cutoff) continue
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
      const dx = pos[ia].x - pos[ib].x
      const dy = pos[ia].y - pos[ib].y
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

    // gravity: pull toward the center (plain), or toward the per-node target RING
    // (radial). Bounds the cloud and rescues orphans (which feel no edge pull).
    for (let i = 0; i < pos.length; i++) {
      const dx = pos[i].x - cx
      const dy = pos[i].y - cy
      if (radial) {
        // direction from centroid to node; if a node sits exactly on the centroid,
        // pick a deterministic ray (by index) so it still gets pushed to its ring
        // instead of stalling with a zero-length unit vector.
        let ux = dx
        let uy = dy
        let d = Math.hypot(ux, uy)
        if (d < 0.01) {
          ux = i % 2 === 0 ? 1 : -1
          uy = 0.5
          d = Math.hypot(ux, uy)
        }
        const err = targetR[i] - Math.hypot(dx, dy) // >0 → too far in (push out); <0 → pull in
        disp[i].x += (ux / d) * err * GRAVITY
        disp[i].y += (uy / d) * err * GRAVITY
      } else {
        disp[i].x -= dx * GRAVITY
        disp[i].y -= dy * GRAVITY
      }
    }

    // collision: size-aware separation so card boxes never overlap. Resolve along
    // the axis of least penetration. Pinned nodes can't move, so the movable partner
    // absorbs the FULL correction (a half-push would leave it overlapping a fixed box).
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        if (pos[i].pinned && pos[j].pinned) continue
        const dx = pos[i].x - pos[j].x
        const dy = pos[i].y - pos[j].y
        const minX = (pos[i].w + pos[j].w) / 2 + GAP
        const minY = (pos[i].h + pos[j].h) / 2 + GAP
        const ox = minX - Math.abs(dx)
        const oy = minY - Math.abs(dy)
        if (ox > 0 && oy > 0) {
          const wi = pos[i].pinned ? 0 : pos[j].pinned ? 1 : 0.5
          const wj = pos[j].pinned ? 0 : pos[i].pinned ? 1 : 0.5
          if (ox < oy) {
            const s = dx < 0 ? -1 : 1
            disp[i].x += ox * wi * s
            disp[j].x -= ox * wj * s
          } else {
            const s = dy < 0 ? -1 : 1
            disp[i].y += oy * wi * s
            disp[j].y -= oy * wj * s
          }
        }
      }
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

  // Final collision resolution: a few UNCLAMPED passes that directly separate any
  // residual overlaps (the cooled main loop can leave a little penetration, esp.
  // against pinned anchors). Movable node absorbs the full correction.
  for (let pass = 0; pass < 48; pass++) {
    let resolved = true
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        if (pos[i].pinned && pos[j].pinned) continue
        const dx = pos[i].x - pos[j].x
        const dy = pos[i].y - pos[j].y
        const minX = (pos[i].w + pos[j].w) / 2 + GAP
        const minY = (pos[i].h + pos[j].h) / 2 + GAP
        const ox = minX - Math.abs(dx)
        const oy = minY - Math.abs(dy)
        if (ox > 0 && oy > 0) {
          resolved = false
          const wi = pos[i].pinned ? 0 : pos[j].pinned ? 1 : 0.5
          const wj = pos[j].pinned ? 0 : pos[i].pinned ? 1 : 0.5
          if (ox < oy) {
            const s = dx < 0 ? -1 : 1
            pos[i].x += ox * wi * s
            pos[j].x -= ox * wj * s
          } else {
            const s = dy < 0 ? -1 : 1
            pos[i].y += oy * wi * s
            pos[j].y -= oy * wj * s
          }
        }
      }
    }
    if (resolved) break
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
