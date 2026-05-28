import { useSyncExternalStore } from "react"
import type { DesktopColumnDragPayload, DesktopColumnRef } from "./types"

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

// ── Active column drag source ──────────────────────────────────────────
//
// During a column drag we publish a small identity record so other
// windows can check, at dragover time, whether they're a compatible
// drop target — DataTransfer.types lets us *detect* a column drag but
// not *read* its parent identity until drop, and we need that identity
// to decide which windows to glow.

export interface ActiveColumnDragSource {
  parentWindowId: string
  parentBlockName: string
  relationKey: string
  /** The columns being dragged — drives which drop tiles a target shows. */
  columns: DesktopColumnRef[]
}

let active: ActiveColumnDragSource | null = null
const listeners = new Set<() => void>()

export function setActiveColumnDragSource(source: ActiveColumnDragSource | null): void {
  active = source
  for (const l of listeners) l()
}

export function getActiveColumnDragSource(): ActiveColumnDragSource | null {
  return active
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): ActiveColumnDragSource | null {
  return active
}

function getServerSnapshot(): ActiveColumnDragSource | null {
  return null
}

export function useActiveColumnDragSource(): ActiveColumnDragSource | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
