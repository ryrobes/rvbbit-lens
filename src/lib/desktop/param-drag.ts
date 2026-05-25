import type { DesktopParamDragPayload } from "./types"

const MIME = "application/x-rvbbit-lens-param"

export function writeParamDragPayload(dt: DataTransfer, payload: DesktopParamDragPayload): void {
  dt.effectAllowed = "copy"
  dt.setData(MIME, JSON.stringify(payload))
  dt.setData("text/plain", `param.${payload.key}`)
}

export function hasParamDragPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes(MIME)
}

export function readParamDragPayload(dt: DataTransfer): DesktopParamDragPayload | null {
  try {
    const raw = dt.getData(MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DesktopParamDragPayload>
    if (parsed.kind !== "rvbbit-lens.desktop.param" || !parsed.key) return null
    return parsed as DesktopParamDragPayload
  } catch {
    return null
  }
}
