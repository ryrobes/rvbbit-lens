import type { DesktopColumnDragPayload } from "./types"

const MIME = "application/x-rvbbit-lens-column"

export function writeColumnDragPayload(
  dt: DataTransfer,
  payload: DesktopColumnDragPayload,
): void {
  dt.setData(MIME, JSON.stringify(payload))
  dt.setData("text/plain", payload.columns.map((c) => c.name).join(", "))
  dt.effectAllowed = "copy"
}

export function hasColumnDragPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes(MIME)
}

export function readColumnDragPayload(dt: DataTransfer): DesktopColumnDragPayload | null {
  try {
    const raw = dt.getData(MIME)
    if (!raw) return null
    return JSON.parse(raw) as DesktopColumnDragPayload
  } catch {
    return null
  }
}
