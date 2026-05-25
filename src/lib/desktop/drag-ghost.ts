/**
 * Custom drag-image helpers. `setDragImage` is fussy in three ways:
 *
 *   1. The image element must be in the document and *rendered* — not
 *      `display: none`. Off-screen via `position: absolute; top: -10000px`
 *      works in every major browser.
 *   2. The browser snapshots synchronously inside dragstart, so the
 *      helper must run in the same tick — no async / await before
 *      `setDragImage`.
 *   3. Removing the source node too early loses the snapshot. A
 *      `setTimeout(.., 0)` cleanup is more reliable across browsers than
 *      `requestAnimationFrame`, which Chrome sometimes skips while a
 *      drag is in flight.
 */

export type DragGhostVariant = "column" | "block" | "param"

interface GhostInput {
  label: string
  sublabel?: string
  count?: number
  variant: DragGhostVariant
}

// Each variant picks a different accent token from :root. We resolve
// the var() refs to literal color strings at attach time rather than
// embedding `var(...)` in the ghost element's inline style — Chromium
// (and some other engines) take the drag-image snapshot through a
// rendering path that doesn't always carry CSS custom properties over
// from the host's cascade, so `var(--main)` can snapshot as `unset`
// and the ghost shows up empty/black even though getComputedStyle on
// the live element returns the right color. Reading the resolved
// value via getComputedStyle on :root and writing it as a literal
// keeps the snapshot intact across themes.
const VARIANT_ACCENT_VAR: Record<DragGhostVariant, string> = {
  column: "--main",
  block: "--main",
  param: "--rvbbit-accent",
}

function resolveRootVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v.length > 0 ? v : fallback
}

/**
 * Convert any CSS color (oklch, lab, hex, rgb, named, …) to a plain
 * `rgb(r, g, b)` string. Strategy: paint into a 1×1 canvas with the
 * input color and read the pixel back. Canvas's pixel buffer is sRGB
 * regardless of how it accepted the input, so this works uniformly
 * across modern color functions. Chromium's drag-image snapshot
 * rasterizer renders sRGB rgb() reliably; lab()/oklch() in inline
 * styles can paint as black in that rasterizer even when they paint
 * fine in the live document.
 */
let normCanvas: HTMLCanvasElement | null = null
let normCtx: CanvasRenderingContext2D | null = null

function toSrgb(color: string, fallback: string): string {
  if (typeof window === "undefined") return fallback
  try {
    if (!normCtx) {
      normCanvas = document.createElement("canvas")
      normCanvas.width = 1
      normCanvas.height = 1
      normCtx = normCanvas.getContext("2d", { willReadFrequently: true })
    }
    if (!normCtx) return fallback
    normCtx.clearRect(0, 0, 1, 1)
    normCtx.fillStyle = color
    normCtx.fillRect(0, 0, 1, 1)
    const pixel = normCtx.getImageData(0, 0, 1, 1).data
    if (pixel[3] === 0) return fallback // color failed to parse — alpha stays 0
    if (pixel[3] === 255) return `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`
    return `rgba(${pixel[0]}, ${pixel[1]}, ${pixel[2]}, ${(pixel[3] / 255).toFixed(3)})`
  } catch {
    return fallback
  }
}

function resolveRootColorVar(name: string, fallback: string): string {
  return toSrgb(resolveRootVar(name, fallback), fallback)
}

export function attachDragGhost(dt: DataTransfer, input: GhostInput): void {
  if (typeof document === "undefined") return
  // Colors get canvas-normalized to sRGB so the drag-image snapshot
  // rasterizer can paint them. Font family is a string list, not a
  // color, so it goes through the plain resolver.
  const accent = resolveRootColorVar(VARIANT_ACCENT_VAR[input.variant], "#2dd4cf")
  const blockBg = resolveRootColorVar("--block-bg", "#0d1820")
  const foreground = resolveRootColorVar("--foreground", "#e6f7f6")
  const fontSans = resolveRootVar(
    "--font-family-sans",
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  )

  const wrap = document.createElement("div")
  // Positioning notes:
  //
  // Current Chromium versions (~137+) skip painting (or clip out of)
  // far off-screen content during the drag-image snapshot rasterizer
  // pass — even though the live document paints it fine. Placing the
  // element at `top: -10000px` thus snapshots as empty. The reliable
  // workaround is to put it in the viewport at (0, 0) for the
  // synchronous setDragImage call, then move it off-screen on the
  // same tick. The browser captures the bitmap before yielding to
  // paint, so the user never sees the on-screen flash.
  //
  // Colors stay in plain sRGB rgb()/rgba() — oklch()/lab() paint
  // live but render inconsistently in the same snapshot rasterizer.
  wrap.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "z-index: -1",
    "pointer-events: none",
    "padding: 7px 14px",
    "border-radius: 999px",
    `background: ${blockBg}`,
    `color: ${foreground}`,
    `border: 1.5px solid ${accent}`,
    "box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)",
    `font-family: ${fontSans}`,
    "font-size: 12px",
    "font-weight: 500",
    "white-space: nowrap",
    "display: inline-block",
  ].join(";")

  const parts: string[] = []
  parts.push(`<span style="color:${accent};margin-right:6px;font-size:11px;">●</span>`)
  parts.push(`<span>${escapeHtml(input.label)}</span>`)
  if (input.sublabel) {
    parts.push(
      `<span style="opacity:0.6;margin-left:8px;font-size:11px;">${escapeHtml(input.sublabel)}</span>`,
    )
  }
  if (input.count && input.count > 1) {
    parts.push(
      `<span style="margin-left:8px;padding:1px 7px;background:color-mix(in oklch, ${accent} 25%, transparent);border-radius:999px;font-size:10px;color:${accent};">+${input.count - 1}</span>`,
    )
  }
  wrap.innerHTML = parts.join("")

  document.body.appendChild(wrap)
  // Force a synchronous layout so the browser has computed dimensions
  // before snapshotting the drag image.
  void wrap.getBoundingClientRect()
  // The cursor anchor: offset the image so the cursor lands just
  // inside the left edge, not on top of the label.
  dt.setDragImage(wrap, 14, 14)
  // Move off-screen NOW that the snapshot has been captured. The
  // ghost stays in the DOM until dragend/drop (the snapshot can be
  // re-requested on some platforms) but the user never sees a flash
  // — the browser's drag-image overlay replaces the cursor area
  // before the next frame paints.
  wrap.style.top = "-10000px"
  wrap.style.left = "-10000px"

  // Keep the ghost alive for the duration of the drag. Removing too
  // early (next-tick / RAF) drops it before some browsers finish
  // taking the snapshot, especially in Linux Chromium. dragend fires
  // when the drop completes (whether or not the drop succeeded), so
  // we listen once for it on the document and clean up there. The
  // setTimeout fallback handles the rare case where dragend doesn't
  // fire (e.g., the user releases outside any drop target on some
  // window managers).
  const cleanup = () => {
    wrap.remove()
    document.removeEventListener("dragend", cleanup, true)
    document.removeEventListener("drop", cleanup, true)
  }
  document.addEventListener("dragend", cleanup, true)
  document.addEventListener("drop", cleanup, true)
  setTimeout(cleanup, 5000)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
