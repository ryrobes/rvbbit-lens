"use client"

import { randomUUID } from "@/lib/uuid"
import { shadowScenes } from "./server-sync"
import { getArtifact, upsertArtifact } from "./artifacts"
import { getViewApp, upsertViewApp } from "./view-apps"
import { SCENE_SCHEMA_VERSION } from "./types"
import type {
  ArtifactPayload,
  DesktopArtifact,
  DesktopViewportState,
  DesktopWindowState,
  Scene,
  SceneBundle,
  SceneConnectionFingerprint,
  SceneStoreV1,
  ViewApp,
  ViewAppPayload,
  WorkspaceCanvas,
} from "./types"

/**
 * Local-only Scene registry — saved desktops. Stored under one
 * localStorage key as a versioned object so the reader can branch on
 * `schemaVersion` (unlike the version-less view-apps blob). v1 lives in
 * the browser; the same four functions become a one-adapter swap to a
 * per-database `rvbbit_lens.scene` table later (the path operator_layout
 * already proves), no users system required.
 */

const STORAGE_KEY = "rvbbit-lens.scenes.v1"
export const SCENES_CHANGED_EVENT = "rvbbit-lens:scenes-changed"

function readStore(): Scene[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<SceneStoreV1>
    // Branch on schemaVersion — unknown/missing versions are ignored rather
    // than half-read (future migrations slot in here).
    if (!parsed || parsed.schemaVersion !== SCENE_SCHEMA_VERSION || !Array.isArray(parsed.scenes)) {
      return []
    }
    return parsed.scenes.filter(
      (s): s is Scene =>
        !!s && typeof s.id === "string" && typeof s.name === "string" && !!s.body,
    )
  } catch {
    return []
  }
}

function writeStore(scenes: Scene[]): void {
  if (typeof window === "undefined") return
  try {
    try {
      const store: SceneStoreV1 = { schemaVersion: SCENE_SCHEMA_VERSION, scenes }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    } catch {
      // Quota. Snapshots (real DOM captures) are the only heavy field — shed
      // them and retry so the save itself survives; mini-maps still render.
      scenes = scenes.map(({ snapshot: _drop, ...rest }) => rest)
      const store: SceneStoreV1 = { schemaVersion: SCENE_SCHEMA_VERSION, scenes }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    }
    // Same-tab listeners (the tray, the empty-slot gallery) refresh off this;
    // cross-tab refresh rides the native `storage` event on STORAGE_KEY.
    window.dispatchEvent(new Event(SCENES_CHANGED_EVENT))
    // Best-effort durable shadow to the server homebase (debounced, fail-safe).
    shadowScenes(scenes)
  } catch {
    // best-effort
  }
}

export function listScenes(): Scene[] {
  return readStore().sort((a, b) => a.name.localeCompare(b.name))
}

export function getScene(id: string): Scene | null {
  return readStore().find((s) => s.id === id) ?? null
}

/** Case-insensitive name uniqueness check (Scenes are a document picker). */
export function sceneNameExists(name: string, exceptId?: string): boolean {
  const n = name.trim().toLowerCase()
  if (!n) return false
  return readStore().some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === n)
}

/**
 * Stable hash of the frozen body for dirty-tracking. Hashes only meaningful
 * document content — window identity / position / size / minimized / payload,
 * plus params — and EXCLUDES transient view state: focusedWindowId, per-window
 * zIndex, and zSeed. focus() bumps all three on a mere click (raise-to-front),
 * which would otherwise flip the dirty bit with no real change. (WorkspaceCanvas
 * also has no timestamp, so the hash is stable across saves.)
 */
export function contentHashOf(body: WorkspaceCanvas): string {
  const stable = {
    windows: body.windows.map((w) => ({
      id: w.id,
      kind: w.kind,
      title: w.title,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      minimized: w.minimized,
      payload: w.payload,
    })),
    params: body.params,
  }
  const json = JSON.stringify(stable)
  let h = 5381
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36) + ":" + json.length.toString(36)
}

/**
 * Collect copies of the side-store records the captured windows reference
 * by id, so a restored view-app / artifact window resolves even if the
 * live record was since deleted (or we're on another machine/profile).
 */
export function buildSceneBundle(windows: DesktopWindowState[]): SceneBundle | undefined {
  const appIds = new Set<string>()
  const artIds = new Set<string>()
  for (const w of windows) {
    if (w.kind === "view-app") {
      const id = (w.payload as ViewAppPayload | undefined)?.appId
      if (id) appIds.add(id)
    } else if (w.kind === "artifact") {
      const id = (w.payload as ArtifactPayload | undefined)?.artifactId
      if (id) artIds.add(id)
    }
  }
  const viewApps = [...appIds].map(getViewApp).filter((a): a is ViewApp => !!a)
  const artifacts = [...artIds].map(getArtifact).filter((a): a is DesktopArtifact => !!a)
  if (viewApps.length === 0 && artifacts.length === 0) return undefined
  const bundle: SceneBundle = {}
  if (viewApps.length) bundle.viewApps = viewApps
  if (artifacts.length) bundle.artifacts = artifacts
  return bundle
}

/**
 * Re-materialize bundled side-records — but only the ones MISSING locally,
 * so a live edit to an existing record is never clobbered by an old Scene.
 */
export function restoreSceneBundle(bundle?: SceneBundle): void {
  if (!bundle) return
  for (const a of bundle.viewApps ?? []) {
    if (getViewApp(a.id)) continue
    upsertViewApp({
      id: a.id,
      name: a.name,
      description: a.description,
      sql: a.sql,
      iconKey: a.iconKey,
      iconColor: a.iconColor,
      connectionId: a.connectionId,
      chartSpec: a.chartSpec,
      statementViews: a.statementViews,
      statementLayout: a.statementLayout,
      viewKind: a.viewKind,
      controlField: a.controlField,
      htmlBlock: a.htmlBlock,
    })
  }
  for (const a of bundle.artifacts ?? []) {
    if (getArtifact(a.id)) continue
    upsertArtifact({
      id: a.id,
      title: a.title,
      kind: a.kind,
      sourceSql: a.sourceSql,
      specJson: a.specJson,
      specText: a.specText,
      connectionId: a.connectionId,
    })
  }
}

export interface SceneInput {
  id?: string
  name: string
  description?: string
  body: WorkspaceCanvas
  viewport?: DesktopViewportState
  connection?: SceneConnectionFingerprint
  bundle?: SceneBundle
  visibility?: "private" | "shared"
  thumbnail?: string
  snapshot?: string
}

export function upsertScene(input: SceneInput): Scene {
  const now = new Date().toISOString()
  const all = readStore()
  const idx = input.id ? all.findIndex((s) => s.id === input.id) : -1
  const existing = idx >= 0 ? all[idx] : undefined
  const next: Scene = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    id: input.id ?? existing?.id ?? randomUUID(),
    name: input.name.trim() || existing?.name || "Untitled scene",
    description: input.description ?? existing?.description,
    body: input.body,
    viewport: input.viewport ?? existing?.viewport,
    connection: input.connection ?? existing?.connection,
    // Distinguish "bundle key omitted" (partial update → keep existing) from
    // "bundle explicitly undefined" (canvas emptied → clear it). A plain `??`
    // would resurrect a stale bundle and re-materialize since-deleted records.
    bundle: "bundle" in input ? input.bundle : existing?.bundle,
    contentHash: contentHashOf(input.body),
    windowCount: input.body.windows.length,
    thumbnail: input.thumbnail ?? existing?.thumbnail,
    snapshot: input.snapshot ?? existing?.snapshot,
    visibility: input.visibility ?? existing?.visibility ?? "private",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  if (idx >= 0) all[idx] = next
  else all.push(next)
  writeStore(all)
  return next
}

export function renameScene(id: string, name: string): Scene | null {
  const all = readStore()
  const idx = all.findIndex((s) => s.id === id)
  if (idx < 0) return null
  const next: Scene = {
    ...all[idx],
    name: name.trim() || all[idx].name,
    updatedAt: new Date().toISOString(),
  }
  all[idx] = next
  writeStore(all)
  return next
}

export function deleteScene(id: string): boolean {
  const all = readStore()
  const next = all.filter((s) => s.id !== id)
  if (next.length === all.length) return false
  writeStore(next)
  return true
}

/**
 * Overwrite the local scene store from server-pulled scenes (a home switch).
 * Raw write + change event so the trays refresh; does NOT re-shadow (the data
 * just came from the server). The caller reloads after.
 */
export function hydrateScenes(scenes: Scene[]): void {
  if (typeof window === "undefined") return
  try {
    const store: SceneStoreV1 = { schemaVersion: SCENE_SCHEMA_VERSION, scenes }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    window.dispatchEvent(new Event(SCENES_CHANGED_EVENT))
  } catch {
    // best-effort
  }
}

// ── sharing (Scene Library) ──────────────────────────────────────────

/** Flip one of your scenes between private and shared (carried to the shadow). */
export function setSceneVisibility(id: string, shared: boolean): Scene | null {
  const scene = getScene(id)
  if (!scene) return null
  return upsertScene({
    id: scene.id,
    name: scene.name,
    description: scene.description,
    body: scene.body,
    viewport: scene.viewport,
    connection: scene.connection,
    bundle: scene.bundle,
    visibility: shared ? "shared" : "private",
  })
}

/** Copy a (typically shared, from another home) scene into your own home.
 *  The body arrived over the wire — normalize the shapes every consumer
 *  assumes (arrays are arrays) instead of trusting the sender. */
export function forkScene(remote: Scene): Scene {
  const name = sceneNameExists(remote.name) ? `${remote.name} (copy)` : remote.name
  const body: WorkspaceCanvas = {
    windows: Array.isArray(remote.body?.windows) ? remote.body.windows : [],
    zSeed: typeof remote.body?.zSeed === "number" ? remote.body.zSeed : 1,
    params: Array.isArray(remote.body?.params) ? remote.body.params : [],
    focusedWindowId: remote.body?.focusedWindowId ?? null,
  }
  return upsertScene({
    // no id → a fresh scene owned by this home
    name,
    description: remote.description,
    body,
    viewport: remote.viewport,
    connection: remote.connection,
    bundle: remote.bundle,
    thumbnail: remote.thumbnail,
    snapshot: remote.snapshot,
    visibility: "private",
  })
}

/** Fetch one shared scene by id (the share-link path). Null on miss/private. */
export async function fetchSharedSceneById(id: string): Promise<Scene | null> {
  try {
    const r = (await fetch(`/api/lens/scene?id=${encodeURIComponent(id)}`).then((x) =>
      x.ok ? x.json() : null,
    )) as { ok?: boolean; scene?: Scene } | null
    return r?.ok && r.scene ? r.scene : null
  } catch {
    return null
  }
}

export interface SharedScene {
  owner: string
  scene: Scene
}

/** Scenes other homes have shared (the Scene Library). Best-effort → []. */
export async function fetchSharedScenes(home: string): Promise<SharedScene[]> {
  try {
    const r = (await fetch(`/api/lens/library?home=${encodeURIComponent(home)}`).then((x) =>
      x.json(),
    )) as { shared?: Array<{ owner?: unknown; scene?: unknown }> }
    const rows = Array.isArray(r?.shared) ? r.shared : []
    return rows
      .map((x) => ({ owner: String(x?.owner ?? ""), scene: x?.scene as Scene }))
      .filter((x): x is SharedScene => !!x.scene && typeof x.scene === "object" && !!x.scene.id)
  } catch {
    return []
  }
}
