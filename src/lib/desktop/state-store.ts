"use client"

import type {
  DesktopParamValue,
  DesktopSavedState,
  DesktopViewportState,
  DesktopWindowState,
  SceneSlotId,
  SlotId,
  WorkspaceCanvas,
  WorkspaceId,
} from "./types"
import { shadowDesktopState } from "./server-sync"

/**
 * Permissive shape for whatever JSON.parse hands back — covers both the
 * v2 (`workspaces`) and v1 (`windows`) layouts. An intersection of the
 * two strict saved-state types collapses to `never` (their `version`
 * fields, `1` and `2`, can't both hold), so this loose record is what
 * loadDesktopState narrows from.
 */
interface ParsedDesktopState {
  version?: number
  workspaces?: Partial<Record<SlotId, Partial<WorkspaceCanvas>>>
  windows?: DesktopWindowState[]
  zSeed?: number
  params?: DesktopParamValue[]
  activeWorkspace?: string
  viewport?: DesktopViewportState
  activeConnectionId?: string | null
  currentSceneId?: string | null
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

/** The five numbered scratch desktops (the workspace switcher + Alt+1..5). */
export const WORKSPACE_IDS: WorkspaceId[] = ["1", "2", "3", "4", "5"]

/** The dedicated slot that holds a loaded Scene (a saved desktop). */
export const SCENE_SLOT: SceneSlotId = "scene"

/** Every canvas slot, including the Scene slot — for iteration / persistence. */
export const ALL_SLOT_IDS: SlotId[] = [...WORKSPACE_IDS, SCENE_SLOT]

export const DEFAULT_VIEWPORT: DesktopViewportState = { x: 0, y: 0, scale: 1 }

export function emptyCanvas(): WorkspaceCanvas {
  return { windows: [], zSeed: DEFAULT_Z, params: [], focusedWindowId: null }
}

export function emptyWorkspaces(): Record<SlotId, WorkspaceCanvas> {
  return {
    "1": emptyCanvas(),
    "2": emptyCanvas(),
    "3": emptyCanvas(),
    "4": emptyCanvas(),
    "5": emptyCanvas(),
    scene: emptyCanvas(),
  }
}

export function loadDesktopState(): DesktopSavedState | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ParsedDesktopState

    if (parsed.version === VERSION && parsed.workspaces) {
      // v2 — fill any missing slot defensively. Older v2 blobs predate the
      // Scene slot, so emptyWorkspaces() seeds an empty one for them.
      const workspaces = emptyWorkspaces()
      for (const id of ALL_SLOT_IDS) {
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
      const active = ALL_SLOT_IDS.includes(parsed.activeWorkspace as SlotId)
        ? (parsed.activeWorkspace as SlotId)
        : "1"
      return {
        version: VERSION,
        activeWorkspace: active,
        workspaces,
        viewport: parsed.viewport ?? DEFAULT_VIEWPORT,
        activeConnectionId: parsed.activeConnectionId ?? null,
        currentSceneId: parsed.currentSceneId ?? null,
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
        currentSceneId: null,
        updatedAt: parsed.updatedAt,
      }
    }

    return null
  } catch {
    return null
  }
}

export function saveDesktopState(state: {
  workspaces: Record<SlotId, WorkspaceCanvas>
  activeWorkspace: SlotId
  viewport: DesktopViewportState
  activeConnectionId: string | null
  currentSceneId: string | null
}): void {
  if (typeof window === "undefined") return
  try {
    const body: DesktopSavedState = {
      version: VERSION,
      activeWorkspace: state.activeWorkspace,
      workspaces: state.workspaces,
      viewport: state.viewport,
      activeConnectionId: state.activeConnectionId,
      currentSceneId: state.currentSceneId,
      updatedAt: new Date().toISOString(),
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(body))
    // Best-effort durable shadow to the server homebase (debounced, fail-safe).
    shadowDesktopState(body)
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
