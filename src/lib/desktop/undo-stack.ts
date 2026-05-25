"use client"

import type { DesktopParamValue, DesktopWindowState } from "./types"

/**
 * Snapshot shape — the minimum state we restore on undo. SQL drafts
 * inside data windows live in `payload.view.sqlDraft` so they roll
 * back too; CodeMirror's own undo handles per-character edits when
 * the editor is focused.
 */
export interface DesktopSnapshot {
  windows: DesktopWindowState[]
  params: DesktopParamValue[]
  zSeed: number
}

export const UNDO_DEPTH = 80

/**
 * Cheap, JSON-string-based equality. The snapshot is small (~few KB
 * for a busy desktop) so this is faster than walking the trees.
 */
export function snapshotSignature(snap: DesktopSnapshot): string {
  return JSON.stringify(snap)
}

export function cloneSnapshot(snap: DesktopSnapshot): DesktopSnapshot {
  return JSON.parse(snapshotSignature(snap)) as DesktopSnapshot
}
