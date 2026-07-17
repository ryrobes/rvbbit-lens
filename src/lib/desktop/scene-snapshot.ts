"use client"

/**
 * Real-pixels scene snapshot — a DOM capture of the desktop at save time,
 * stored beside the geometry mini-map (`scene-thumbnail.ts`), never instead
 * of it. The mini-map is derived and always works; this is the photograph,
 * and photographs can fail: cross-origin iframes render blank, a tainted
 * canvas throws, fonts may not inline. Every failure path here returns null
 * and the save proceeds without a snapshot.
 */

import { domToCanvas } from "modern-screenshot"

/** Marks the element captures start from (the desktop shell root). */
export const SNAPSHOT_ROOT_ATTR = "data-scene-capture-root"
/** Put this on transient chrome (menus, popovers, overlays) to keep it out
 *  of the shot even when it is still mounted at capture time. */
export const NO_SNAPSHOT_ATTR = "data-no-snapshot"

const TARGET_WIDTH = 880
const CAPTURE_TIMEOUT_MS = 15000

// The capture cost is per-node computed-style copying (~350 properties each).
// Restricting to the properties this UI actually leans on cuts capture time
// by an order of magnitude; anything omitted falls back to the default in the
// clone, which a thumbnail can absorb.
const STYLE_PROPERTIES = [
  "display", "position", "top", "right", "bottom", "left", "z-index",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "box-sizing", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink",
  "flex-basis", "align-items", "align-content", "align-self",
  "justify-content", "justify-items", "row-gap", "column-gap",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "order",
  "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "background-clip",
  "border-top-width", "border-top-style", "border-top-color",
  "border-right-width", "border-right-style", "border-right-color",
  "border-bottom-width", "border-bottom-style", "border-bottom-color",
  "border-left-width", "border-left-style", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "box-shadow", "text-shadow", "opacity", "filter", "backdrop-filter",
  "transform", "transform-origin", "visibility",
  "overflow-x", "overflow-y", "object-fit", "object-position",
  "color", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-align", "text-decoration-line",
  "text-transform", "text-overflow", "white-space", "word-break",
  "vertical-align", "list-style-type", "table-layout", "border-collapse",
]
// localStorage holds every scene under ONE key and the homebase shadow PUTs
// the full set — keep individual snapshots small enough that neither groans.
const MAX_BYTES = 360_000

function encodeUnderCap(canvas: HTMLCanvasElement): string | null {
  for (const quality of [0.7, 0.5]) {
    const url = canvas.toDataURL("image/webp", quality)
    if (url.length <= MAX_BYTES) return url
  }
  return null
}

/** Capture the live desktop as a webp data URL, or null if anything at all
 *  goes wrong. Callers should have let the triggering menu close first
 *  (a couple of animation frames); anything tagged NO_SNAPSHOT_ATTR is
 *  filtered out regardless. */
export async function captureSceneSnapshot(): Promise<string | null> {
  if (typeof document === "undefined") return null
  const root = document.querySelector<HTMLElement>(`[${SNAPSHOT_ROOT_ATTR}]`)
  if (!root || root.clientWidth === 0) return null
  try {
    const canvas = await Promise.race([
      domToCanvas(root, {
        scale: Math.min(1, TARGET_WIDTH / root.clientWidth),
        includeStyleProperties: STYLE_PROPERTIES,
        filter: (el) =>
          !(el instanceof Element && el.hasAttribute(NO_SNAPSHOT_ATTR)),
      }),
      new Promise<null>((resolve) =>
        window.setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS),
      ),
    ])
    if (!canvas) return null
    return encodeUnderCap(canvas)
  } catch (err) {
    // Best-effort, but observable — a silent null here cost a debug session.
    console.debug("[scene-snapshot] capture failed:", err)
    return null
  }
}

// Debug handle: lets a console (or a driving browser) run a capture directly.
if (typeof window !== "undefined") {
  ;(window as unknown as Record<string, unknown>).__captureSceneSnapshot =
    captureSceneSnapshot
}

/** Wait for the click that triggered a save to finish closing its menu
 *  before photographing the desktop. */
export function afterMenusSettle(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}
