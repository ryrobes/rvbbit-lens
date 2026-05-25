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
