import { useSyncExternalStore } from "react"
import type { DesktopBlockDragPayload } from "./types"

const MIME = "application/x-rvbbit-lens-block"

export function writeBlockDragPayload(dt: DataTransfer, payload: DesktopBlockDragPayload): void {
  dt.effectAllowed = "copy"
  dt.setData(MIME, JSON.stringify(payload))
  dt.setData("text/plain", `block.${payload.blockName}`)
}

export function hasBlockDragPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes(MIME)
}

export function readBlockDragPayload(dt: DataTransfer): DesktopBlockDragPayload | null {
  try {
    const raw = dt.getData(MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DesktopBlockDragPayload>
    if (parsed.kind !== "rvbbit-lens.desktop.block" || !parsed.windowId || !parsed.blockName || !parsed.title) {
      return null
    }
    return parsed as DesktopBlockDragPayload
  } catch {
    return null
  }
}

/* ──────────────────────── active block-drag store ────────────────────────
 * Mirrors the column-drag store: a tiny external store so floating surfaces
 * (the rowset-op palette) can react to "a block is being dragged" without
 * prop-drilling, the same way the semantic palette reacts to column drags. */

export interface ActiveBlockDragSource {
  windowId: string
  blockName: string
  title: string
}

let active: ActiveBlockDragSource | null = null
const listeners = new Set<() => void>()

function clearActiveBlockDragSource(): void {
  setActiveBlockDragSource(null)
}

export function setActiveBlockDragSource(source: ActiveBlockDragSource | null): void {
  active = source
  if (typeof window !== "undefined") {
    // Remove first so we never double-register.
    window.removeEventListener("dragend", clearActiveBlockDragSource, true)
    if (source) {
      // Safety net: clear the active source even if the chip's own onDragEnd is
      // missed (Esc-cancel quirks, source re-render). Without this a stale
      // source keeps the on-block overlay mounted, which covers the chip and
      // aborts the next drag — leaving chips undraggable until a refresh.
      // `dragend` fires at the END of every drag (after any drop, and on
      // Esc-cancel), so it never races a tile's own drop handler. Capture phase
      // so a stopPropagation on an inner handler can't hide it.
      window.addEventListener("dragend", clearActiveBlockDragSource, true)
    }
  }
  for (const l of listeners) l()
}

export function getActiveBlockDragSource(): ActiveBlockDragSource | null {
  return active
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): ActiveBlockDragSource | null {
  return active
}

function getServerSnapshot(): ActiveBlockDragSource | null {
  return null
}

export function useActiveBlockDragSource(): ActiveBlockDragSource | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
