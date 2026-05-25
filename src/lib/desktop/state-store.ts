"use client"

import type {
  DesktopParamValue,
  DesktopSavedState,
  DesktopViewportState,
  DesktopWindowState,
  WorkspaceCanvas,
  WorkspaceId,
} from "./types"

/**
 * Permissive shape for whatever JSON.parse hands back — covers both the
 * v2 (`workspaces`) and v1 (`windows`) layouts. An intersection of the
 * two strict saved-state types collapses to `never` (their `version`
 * fields, `1` and `2`, can't both hold), so this loose record is what
 * loadDesktopState narrows from.
 */
interface ParsedDesktopState {
  version?: number
  workspaces?: Partial<Record<WorkspaceId, Partial<WorkspaceCanvas>>>
  windows?: DesktopWindowState[]
  zSeed?: number
  params?: DesktopParamValue[]
  activeWorkspace?: string
  viewport?: DesktopViewportState
  activeConnectionId?: string | null
  updatedAt?: string
}

/**
 * Desktop persistence. v2 stores five independent workspace canvases
 * plus which one is active. v1 (a single flat canvas) is migrated into
 * workspace "1" on load so an existing desktop survives the upgrade.
 */

const STORAGE_KEY = "rvbbit-lens.desktop.state.v1" // key name unchanged; payload carries `version`
const VERSION = 2 as const
export const DEFAULT_Z = 20

export const WORKSPACE_IDS: WorkspaceId[] = ["1", "2", "3", "4", "5"]

export const DEFAULT_VIEWPORT: DesktopViewportState = { x: 0, y: 0, scale: 1 }

export function emptyCanvas(): WorkspaceCanvas {
  return { windows: [], zSeed: DEFAULT_Z, params: [], focusedWindowId: null }
}

export function emptyWorkspaces(): Record<WorkspaceId, WorkspaceCanvas> {
  return {
    "1": emptyCanvas(),
    "2": emptyCanvas(),
    "3": emptyCanvas(),
    "4": emptyCanvas(),
    "5": emptyCanvas(),
  }
}

export function loadDesktopState(): DesktopSavedState | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ParsedDesktopState

    if (parsed.version === VERSION && parsed.workspaces) {
      // v2 — fill any missing workspace slot defensively.
      const workspaces = emptyWorkspaces()
      for (const id of WORKSPACE_IDS) {
        const c = parsed.workspaces[id]
        if (c && Array.isArray(c.windows)) {
          workspaces[id] = {
            windows: c.windows,
            zSeed: typeof c.zSeed === "number" ? c.zSeed : DEFAULT_Z,
            params: Array.isArray(c.params) ? c.params : [],
            focusedWindowId: c.focusedWindowId ?? null,
          }
        }
      }
      const active = WORKSPACE_IDS.includes(parsed.activeWorkspace as WorkspaceId)
        ? (parsed.activeWorkspace as WorkspaceId)
        : "1"
      return {
        version: VERSION,
        activeWorkspace: active,
        workspaces,
        viewport: parsed.viewport ?? DEFAULT_VIEWPORT,
        activeConnectionId: parsed.activeConnectionId ?? null,
        updatedAt: parsed.updatedAt,
      }
    }

    if (parsed.version === 1 && Array.isArray(parsed.windows)) {
      // v1 → v2 migration: the old single canvas becomes workspace "1".
      const workspaces = emptyWorkspaces()
      workspaces["1"] = {
        windows: parsed.windows,
        zSeed: typeof parsed.zSeed === "number" ? parsed.zSeed : DEFAULT_Z,
        params: Array.isArray(parsed.params) ? parsed.params : [],
        focusedWindowId: null,
      }
      return {
        version: VERSION,
        activeWorkspace: "1",
        workspaces,
        viewport: parsed.viewport ?? DEFAULT_VIEWPORT,
        activeConnectionId: parsed.activeConnectionId ?? null,
        updatedAt: parsed.updatedAt,
      }
    }

    return null
  } catch {
    return null
  }
}

export function saveDesktopState(state: {
  workspaces: Record<WorkspaceId, WorkspaceCanvas>
  activeWorkspace: WorkspaceId
  viewport: DesktopViewportState
  activeConnectionId: string | null
}): void {
  if (typeof window === "undefined") return
  try {
    const body: DesktopSavedState = {
      version: VERSION,
      activeWorkspace: state.activeWorkspace,
      workspaces: state.workspaces,
      viewport: state.viewport,
      activeConnectionId: state.activeConnectionId,
      updatedAt: new Date().toISOString(),
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(body))
  } catch {
    // localStorage is best-effort.
  }
}

export function clampViewport(viewport: DesktopViewportState): DesktopViewportState {
  return {
    x: Number.isFinite(viewport.x) ? viewport.x : 0,
    y: Number.isFinite(viewport.y) ? viewport.y : 0,
    scale: Math.min(1.6, Math.max(0.45, Number.isFinite(viewport.scale) ? viewport.scale : 1)),
  }
}
