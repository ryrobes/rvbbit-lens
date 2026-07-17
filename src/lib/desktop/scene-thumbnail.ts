"use client"

/**
 * Scene thumbnails — rendered from the scene's own window geometry, NOT a DOM
 * screenshot.
 *
 * Why not a real screenshot: the desktop hosts cross-origin sandboxed iframes
 * (HTML-block apps), Vega canvases, and heavy backdrop-blur — exactly what
 * DOM-to-image can't capture. A schematic mini-map from the saved window
 * layout is reliable, tiny (~few KB webp), matches the aesthetic, and — the
 * part a screenshot can't do — works retroactively on every existing scene,
 * since it's derived from saved state rather than a captured moment.
 */

import type { WorkspaceCanvas, DesktopWindowState } from "./types"

// Warm-ink-friendly palette; a window kind maps to a stable color so the same
// kind reads the same across every thumbnail.
const PALETTE = [
  "#9df7d5", // mint
  "#48c9f0", // cyan
  "#9b7cf8", // violet
  "#ffb454", // amber
  "#ff6d7c", // coral
  "#7ee787", // green
  "#79c0ff", // blue
  "#d2a8ff", // lilac
  "#ffa657", // orange
  "#56d4bc", // teal
]

function colorForKind(kind: string): string {
  let h = 0
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export interface ThumbnailOptions {
  /** CSS pixel width of the output image (height derives from 16:10). */
  width?: number
  /** Background color; defaults to the theme --background, then a dark fallback. */
  background?: string
}

/**
 * Render a scene's window layout to a compact webp data URL. Returns null in
 * non-browser contexts or when there's nothing to draw.
 */
export function renderSceneThumbnail(
  body: WorkspaceCanvas,
  opts: ThumbnailOptions = {},
): string | null {
  if (typeof document === "undefined") return null
  const windows = body.windows ?? []

  const W = opts.width ?? 320
  const H = Math.round(W * 0.625) // 16:10
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  const canvas = document.createElement("canvas")
  canvas.width = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.scale(dpr, dpr)

  // Background — theme-aware with a dark fallback.
  let bg = opts.background
  if (!bg) {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--background").trim()
    bg = v || "#0e1318"
  }
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // Faint dot grid to echo the canvas.
  ctx.fillStyle = "rgba(157,247,213,0.05)"
  for (let gx = 0; gx < W; gx += 16) {
    for (let gy = 0; gy < H; gy += 16) {
      ctx.fillRect(gx, gy, 1, 1)
    }
  }

  const drawn = windows.filter((w) => !w.minimized)
  if (drawn.length === 0) {
    // Empty desktop — a single centered "blank" hint dot.
    ctx.fillStyle = "rgba(157,247,213,0.15)"
    ctx.beginPath()
    ctx.arc(W / 2, H / 2, 6, 0, Math.PI * 2)
    ctx.fill()
    return canvas.toDataURL("image/webp", 0.8)
  }

  // Fit the windows' bounding box into the frame with padding.
  const pad = 10
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of drawn) {
    minX = Math.min(minX, w.x)
    minY = Math.min(minY, w.y)
    maxX = Math.max(maxX, w.x + w.width)
    maxY = Math.max(maxY, w.y + w.height)
  }
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)
  // Center the scaled layout.
  const offX = (W - bw * scale) / 2 - minX * scale
  const offY = (H - bh * scale) / 2 - minY * scale

  // Draw bottom-to-top so stacking reads correctly.
  const ordered = [...drawn].sort((a, b) => a.zIndex - b.zIndex)
  for (const w of ordered) {
    const x = w.x * scale + offX
    const y = w.y * scale + offY
    const ww = Math.max(6, w.width * scale)
    const wh = Math.max(6, w.height * scale)
    const color = colorForKind(w.kind)

    // Card body + border.
    roundRect(ctx, x, y, ww, wh, 3)
    ctx.fillStyle = hexA(color, 0.14)
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = hexA(color, 0.55)
    ctx.stroke()

    // Title bar.
    const barH = Math.min(9, wh * 0.28)
    roundRect(ctx, x, y, ww, barH, 3)
    ctx.fillStyle = hexA(color, 0.85)
    ctx.fill()

    // Title text, only when there's room.
    if (ww > 42) {
      ctx.fillStyle = "rgba(233,238,233,0.9)"
      ctx.font = "600 7px ui-sans-serif, system-ui, sans-serif"
      ctx.textBaseline = "middle"
      const label = truncateToWidth(ctx, w.title || w.kind, ww - 8)
      ctx.fillStyle = hexA(color, 0.95)
      ctx.fillText(label, x + 4, y + barH + Math.min(9, (wh - barH) / 2))
    }
  }

  return canvas.toDataURL("image/webp", 0.8)
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let s = text
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1)
  return s + "…"
}
