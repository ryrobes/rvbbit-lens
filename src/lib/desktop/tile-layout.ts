/**
 * Tile mode — Exposé for the desktop. Computes an EPHEMERAL rect per
 * window that fills the viewport like a tiling WM would; the windows'
 * stored x/y/width/height are never touched (tile mode is a render-time
 * transform, so toggling off restores the real layout by construction).
 *
 * Packing: justified rows (the photo-gallery algorithm). Windows are
 * ordered spatially (top-left first, so tiles land near where their
 * window lived), chunked into rows, and each row is scaled so widths
 * are proportional to every window's real aspect ratio and exactly fill
 * the viewport width. Row heights then normalize as a group to fill the
 * height. Aspects survive (up to a uniform vertical squeeze), there are
 * no holes, and the result is O(n) and deterministic.
 */

export interface TileRect {
  x: number
  y: number
  width: number
  height: number
}

interface TileWindow {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export function computeTileLayout(
  windows: TileWindow[],
  viewport: { width: number; height: number; top: number; left?: number },
  gap = 10,
): Map<string, TileRect> {
  const out = new Map<string, TileRect>()
  if (windows.length === 0) return out

  const left = viewport.left ?? 0
  const W = Math.max(320, viewport.width - gap * 2)
  const H = Math.max(240, viewport.height - gap * 2)
  const x0 = left + gap
  const y0 = viewport.top + gap

  // Spatial order: reading order of where the windows actually are, so a
  // window's tile appears roughly where the eye already expects it. The
  // y-quantization keeps near-tied rows from flip-flopping on pixel noise.
  const ordered = [...windows].sort((a, b) => {
    const ay = Math.round(a.y / 120)
    const by = Math.round(b.y / 120)
    return ay !== by ? ay - by : a.x - b.x || a.id.localeCompare(b.id)
  })

  const aspect = (w: TileWindow) =>
    Math.min(3.5, Math.max(0.45, (w.width || 1) / (w.height || 1)))
  const totalAspect = ordered.reduce((s, w) => s + aspect(w), 0)
  const avgAspect = totalAspect / ordered.length

  // Row count that makes tiles come out near their own shape:
  // R = sqrt(A·N·H/W)  (derivation: N/R tiles per row at avg aspect A).
  const rows = Math.max(
    1,
    Math.min(ordered.length, Math.round(Math.sqrt((avgAspect * ordered.length * H) / W))),
  )

  // Greedy chunking: start a new row once it holds its fair share of the
  // total aspect. Guarantees every row is non-empty and order is kept.
  const perRow = totalAspect / rows
  const rowChunks: TileWindow[][] = []
  let current: TileWindow[] = []
  let currentAspect = 0
  for (const w of ordered) {
    const remainingRows = rows - rowChunks.length
    const remainingWindows = ordered.length - rowChunks.reduce((s, r) => s + r.length, 0) - current.length
    current.push(w)
    currentAspect += aspect(w)
    const mustClose = remainingWindows === remainingRows - 1 // leave 1 window per remaining row
    if ((currentAspect >= perRow * 0.92 || mustClose) && rowChunks.length < rows - 1) {
      rowChunks.push(current)
      current = []
      currentAspect = 0
    }
  }
  if (current.length) rowChunks.push(current)

  // Natural row heights (what each row would need to fill W at true
  // aspect), then a single vertical scale so the stack fills H exactly.
  const naturals = rowChunks.map((row) => {
    const sum = row.reduce((s, w) => s + aspect(w), 0)
    const innerW = W - gap * (row.length - 1)
    return { row, sum, h: innerW / sum }
  })
  const naturalTotal = naturals.reduce((s, r) => s + r.h, 0)
  const availH = H - gap * (rowChunks.length - 1)
  const vScale = availH / naturalTotal

  let y = y0
  for (const { row, sum, h } of naturals) {
    const rowH = Math.max(120, h * vScale)
    const innerW = W - gap * (row.length - 1)
    let x = x0
    for (const w of row) {
      const tileW = Math.max(160, (innerW * aspect(w)) / sum)
      out.set(w.id, { x, y, width: tileW, height: rowH })
      x += tileW + gap
    }
    y += rowH + gap
  }
  return out
}

/** The cycling order tile mode (and Tab-focus) uses: same spatial order
 *  the packer used, so Tab walks tiles left-to-right, top-to-bottom. */
export function tileCycleOrder(windows: TileWindow[]): string[] {
  return [...windows]
    .sort((a, b) => {
      const ay = Math.round(a.y / 120)
      const by = Math.round(b.y / 120)
      return ay !== by ? ay - by : a.x - b.x || a.id.localeCompare(b.id)
    })
    .map((w) => w.id)
}
