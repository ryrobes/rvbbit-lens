"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  Bell,
  Boxes,
  Brain,
  LineChart,
  Calculator,
  Database,
  LayoutDashboard,
  DollarSign,
  Eye,
  FileCode2,
  FileCsv,
  FileText,
  FlowArrow,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Layers,
  Package,
  Palette as PaletteIcon,
  Plug,
  Plus,
  Rocket,
  Search,
  Sparkles,
  Settings2,
  Table2,
  TreeStructure,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "@/lib/icons"
import { PhosphorIconProvider } from "@/components/icon-provider"
import { DesktopIcon } from "./desktop-icon"
import { WorkspaceActiveContext } from "./workspace-active-context"
import { FolderWindow, type LauncherItem } from "./folder-window"
import { DesktopMenuBar } from "./desktop-menu-bar"
import { LineageOverlay } from "./lineage-overlay"
import { ContextMenu, type ContextMenuState } from "./context-menu"
import { DesktopParamsSurface } from "./desktop-params-surface"
import { DesktopWindow } from "./desktop-window"
import { FinderWindow } from "./finder-window"
import { DataGridWindow } from "./data-grid-window"
import { CsvImportWindow } from "./csv-import-window"
import { SemanticOpPalette } from "./semantic-op-palette"
import { SemanticBindPopover } from "./semantic-bind-popover"
import { RowsetOpPalette } from "./rowset-op-palette"
import { RowsetPromptPopover } from "./rowset-prompt-popover"
import { ConnectionsWindow } from "./connections-window"
import { ViewAppsWindow } from "./view-apps-window"
import { ViewAppBuilderWindow } from "./view-app-builder-window"
import { ViewAppWindow } from "./view-app-window"
import { ExtensionsWindow } from "./extensions-window"
import { SystemObjectsWindow } from "./system-objects-window"
import { RvbbitCacheWindow } from "./rvbbit-cache-window"
import { CacheWindow } from "./cache-window"
import { ArtifactWindow } from "./artifact-window"
import { QueryDocumentWindow } from "./query-document-window"
import { PaletteWindow } from "./palette-window"
import { PgMonitorWindow } from "./pg-monitor-window"
import { NotificationToasts } from "./notification-toasts"
import { NotificationCenterWindow } from "./notification-center-window"
import { OperatorsWindow } from "./operators-window"
import { CostsWindow } from "./costs-window"
import { SyncMirrorWindow } from "./sync-mirror-window"
import { DashboardsWindow } from "./dashboards-window"
import { DuckWindow } from "./duck-window"
import { OperatorFlowWindow } from "./operator-flow-window"
import { SpecialistsWindow } from "./specialists-window"
import { SpecialistDetailWindow } from "./specialist-detail-window"
import { RoutingWindow } from "./routing-window"
import { McpServersWindow } from "./mcp-servers-window"
import { McpServerDetailWindow } from "./mcp-server-detail-window"
import { QueryLensWindow } from "./query-lens-window"
import { KgBrowserWindow } from "./kg-browser-window"
import { KgEntityDetailWindow } from "./kg-entity-detail-window"
import { KgExtractionRunsWindow } from "./kg-extraction-runs-window"
import { KgMergeReviewWindow } from "./kg-merge-review-window"
import { KgExplorerWindow } from "./kg-explorer-window"
import { DataSearchWindow } from "./data-search-window"
import { ScryCanvas } from "./scry-canvas"
import { ScryResultsWindow } from "./scry-results-window"
import { fetchFieldFocusSql } from "@/lib/desktop/scry-field"
import type { ScryResultsPayload } from "@/lib/desktop/types"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import { DriftWindow } from "./drift-window"
import { ModelStudioWindow } from "./model-studio-window"
import { MetricCatalogWindow } from "./metric-catalog-window"
import { MetricCreatorWindow } from "./metric-creator-window"
import { MetricInspectorWindow } from "./metric-inspector-window"
import { MetricBoardWindow } from "./metric-board-window"
import { AlertsWindow } from "./alerts-window"
import { CapabilitiesWindow } from "./capabilities-window"
import { CapabilityDetailWindow } from "./capability-detail-window"
import { HfDeployWindow } from "./hf-deploy-window"
import { WarrenWindow } from "./warren-window"
import { WarrenJobDetailWindow } from "./warren-job-detail-window"
import {
  loadWatchedChannels,
  saveWatchedChannels,
  normalizeChannel,
  type NotifyConnectionStatus,
  type NotifyEvent,
} from "@/lib/desktop/notify-feed"
import {
  ALL_SLOT_IDS,
  clampViewport,
  DEFAULT_VIEWPORT,
  emptyWorkspaces,
  loadDesktopState,
  saveDesktopState,
  SCENE_SLOT,
  WORKSPACE_IDS,
} from "@/lib/desktop/state-store"
import { shadowDesktopState, shadowScenes } from "@/lib/desktop/server-sync"
import { usePresentMode } from "@/lib/desktop/present-mode"
import type { ConnectionRecord, SchemaSnapshot } from "@/lib/db/types"
import type {
  RvbbitCachePayload,
  CachePayload,
  CsvImportPayload,
  ArtifactPayload,
  DataPayload,
  DashboardsPayload,
  DataSearchPayload,
  DriftPayload,
  FolderPayload,
  ModelStudioPayload,
  DesktopBlockDragPayload,
  DesktopColumnDragPayload,
  DesktopColumnRef,
  DesktopParamOperator,
  RollupGrain,
  RollupOp,
  RollupSpec,
  DesktopParamValue,
  DesktopViewportState,
  DesktopWindowState,
  ParamTarget,
  ExtensionsPayload,
  FinderPayload,
  NotificationsPayload,
  CostsPayload,
  SyncMirrorPayload,
  DuckPayload,
  OperatorFlowPayload,
  OperatorsPayload,
  SpecialistsPayload,
  SpecialistDetailPayload,
  RoutingPayload,
  McpServersPayload,
  McpServerDetailPayload,
  QueryLensPayload,
  KgBrowserPayload,
  KgEntityDetailPayload,
  KgEntitySource,
  KgExplorerPayload,
  KgExtractionRunsPayload,
  KgMergeReviewPayload,
  KgSourceContext,
  CapabilitiesPayload,
  CapabilityDetailPayload,
  HfDeployPayload,
  WarrenPayload,
  WarrenJobDetailPayload,
  PalettePayload,
  PgMonitorPayload,
  QueryDocumentPayload,
  ReactiveBlockState,
  SemanticArg,
  SemanticOpMeta,
  SystemObjectsPayload,
  ViewAppBuilderPayload,
  ViewAppPayload,
  ViewAppsPayload,
  Scene,
  SceneConnectionFingerprint,
  SlotId,
  WorkspaceCanvas,
  WorkspaceId,
  MetricCatalogPayload,
  MetricCreatorPayload,
  MetricInspectorPayload,
  MetricBoardPayload,
  AlertsPayload,
} from "@/lib/desktop/types"

interface WorkspaceTransition {
  from: SlotId
  to: SlotId
  dir: "forward" | "backward"
}

/** Deep clone of a canvas — payloads are JSON-serializable by construction
 *  (the File-store keeps non-serializable blobs out of window payloads). */
function cloneCanvas(c: WorkspaceCanvas): WorkspaceCanvas {
  return JSON.parse(JSON.stringify(c)) as WorkspaceCanvas
}
import { randomUUID } from "@/lib/uuid"
import { putImportFile } from "@/lib/import/file-store"
import { listViewApps } from "@/lib/desktop/view-apps"
import {
  buildSceneBundle,
  contentHashOf,
  deleteScene,
  getScene,
  listScenes,
  renameScene,
  restoreSceneBundle,
  sceneNameExists,
  SCENES_CHANGED_EVENT,
  upsertScene,
} from "@/lib/desktop/scenes"
import { SceneList } from "./scene-tray"
import {
  applyRollupOp,
  buildDimensionRollup,
  buildRollupQuery,
  effectiveRollup,
  grainTruncExpr,
  previewSqlForTable,
  projectionSpecFromOp,
  quoteSqlIdent,
  rollupSpecColumns,
  rollupSpecFromColumns,
} from "@/lib/desktop/sql-builder"
import { invalidateSemanticOps, loadSemanticOps } from "@/lib/desktop/semantic-ops"
import { fetchKgEvidenceBySource, fetchPrimaryKeyColumn } from "@/lib/rvbbit/kg"
import { buildDesktopRuntimeGraph, paramKey, resolveParamTableTarget, sameParamValue, sourceSqlForPayload, uniqueBlockName } from "@/lib/desktop/reactive-sql"
import {
  hasColumnDragPayload,
  readColumnDragPayload,
} from "@/lib/desktop/column-drag"
import {
  hasBlockDragPayload,
  readBlockDragPayload,
} from "@/lib/desktop/block-drag"
import {
  hasParamDragPayload,
  readParamDragPayload,
} from "@/lib/desktop/param-drag"
import {
  canRenderImageUrl,
  clearDesktopWallpaper,
  isLikelyImageFile,
  loadDesktopWallpaperRecord,
  saveDesktopWallpaper,
  updateDesktopWallpaperPalette,
} from "@/lib/desktop/wallpaper-store"
import type { ImagePalette, ThemeMode } from "@/lib/desktop/palette"
import { vibrantExtractor } from "@/lib/desktop/palette-vibrant"
import { extractPaletteWithRvbbitVision } from "@/lib/desktop/palette-rvbbit-vision"
import {
  cloneSnapshot,
  snapshotSignature,
  UNDO_DEPTH,
  type DesktopSnapshot,
} from "@/lib/desktop/undo-stack"
import { deriveTheme } from "@/lib/desktop/theme-derive"
import { applyTokensToRoot } from "@/lib/desktop/theme-tokens"
import { cn } from "@/lib/utils"
import {
  applyFontPrefs,
  readFontPrefs,
  writeFontPrefs,
  DEFAULT_SANS,
  DEFAULT_MONO,
  DEFAULT_SCALE,
  type FontPrefs,
  type FontScale,
  type MonoFont,
  type SansFont,
} from "@/lib/desktop/fonts"

const DEFAULT_Z = 20
const MAX_WORLD = 20000
const MIN_WORLD = -20000

type SanitizedConnection = Omit<ConnectionRecord, "password"> & { hasPassword: boolean }

/** Present mode v1 — geometry for the fit-to-screen transform. */
type PresentFit = { x: number; y: number; scale: number }
const PRESENT_FIT_PAD = 48
const PRESENT_MENUBAR_H = 40

function sameFit(a: PresentFit | null, b: PresentFit | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.scale === b.scale
}

/**
 * Frame the active canvas inside the viewport for Present mode: a translate +
 * scale that centres the windows' bounding box, capped at 1× so a small
 * dashboard isn't blown up (and floored at 0.45× to match the editor's zoom
 * range). Returns null when there's nothing to frame. Kept out of the persisted
 * `viewport` so present framing never leaks into saved desktops or scenes.
 */
function computePresentFit(windows: DesktopWindowState[]): PresentFit | null {
  if (typeof window === "undefined") return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of windows) {
    if (w.minimized) continue
    minX = Math.min(minX, w.x)
    minY = Math.min(minY, w.y)
    maxX = Math.max(maxX, w.x + w.width)
    maxY = Math.max(maxY, w.y + w.height)
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null
  const bboxW = maxX - minX
  const bboxH = maxY - minY
  const availW = Math.max(1, window.innerWidth - PRESENT_FIT_PAD * 2)
  const availH = Math.max(1, window.innerHeight - PRESENT_MENUBAR_H - PRESENT_FIT_PAD * 2)
  const scale = Math.min(1, Math.max(0.45, Math.min(availW / bboxW, availH / bboxH)))
  const offsetX = PRESENT_FIT_PAD + Math.max(0, (availW - bboxW * scale) / 2)
  const offsetY = PRESENT_MENUBAR_H + PRESENT_FIT_PAD + Math.max(0, (availH - bboxH * scale) / 2)
  return { x: offsetX - minX * scale, y: offsetY - minY * scale, scale }
}

export function DesktopShell() {
  const [connections, setConnections] = useState<SanitizedConnection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  // Scalar semantic-operator catalog (rvbbit.operators) for the drag-drop
  // semantic tiles. Empty on non-rvbbit connections.
  const [semanticOps, setSemanticOps] = useState<SemanticOpMeta[]>([])
  // Multi-arg semantic op awaiting its literal args (the drop-site bind step).
  const [pendingBind, setPendingBind] = useState<{
    payload: DesktopColumnDragPayload
    op: SemanticOpMeta
    at: { x: number; y: number }
    targetWindowId?: string
  } | null>(null)
  // Rowset (pipeline) op awaiting its natural-language prompt — a block was
  // dropped on a rowset tile and we're collecting the instruction. When
  // `inPlace` is set, the stage chains onto that window's own block instead of
  // spawning a new derived block.
  const [pendingRowset, setPendingRowset] = useState<{
    payload: DesktopBlockDragPayload
    op: SemanticOpMeta
    at: { x: number; y: number }
    inPlace?: boolean
  } | null>(null)
  // ── Workspaces ────────────────────────────────────────────────────
  //
  // Five independent canvases, all kept mounted at once. The live
  // values `windows` / `zSeed` / `desktopParams` / `focusedWindowId`
  // are *derived* from the active workspace; the wrapper setters below
  // route any mutation back into workspaces[activeWorkspace]. Every
  // existing handler that calls setWindows(...) etc. keeps working
  // verbatim — only the two that nest setState (focus, openWindow)
  // were rewritten through mutateCanvas.
  const [workspaces, setWorkspaces] = useState<Record<SlotId, WorkspaceCanvas>>(
    () => emptyWorkspaces(),
  )
  const [activeWorkspace, setActiveWorkspace] = useState<SlotId>("1")
  const [wsTransition, setWsTransition] = useState<WorkspaceTransition | null>(null)
  // ── Scenes (saved desktops) ───────────────────────────────────────
  // currentSceneId binds the Scene slot to a saved Scene; `scenes` mirrors
  // the localStorage library (refreshed on the scenes-changed / storage
  // events). Both are global, not per-canvas.
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [runSignals, setRunSignals] = useState<Record<string, number>>({})
  const [viewport, setViewport] = useState<DesktopViewportState>(DEFAULT_VIEWPORT)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  // Present (read-only) mode v1: chrome-off windows (handled per-window) plus a
  // fit-to-screen framing applied to the active layer. `presentFit` is local —
  // never persisted — so it can't leak into saved desktops/scenes.
  const present = usePresentMode()
  const [presentFit, setPresentFit] = useState<PresentFit | null>(null)

  // ── LISTEN/NOTIFY feed ──────────────────────────────────────────────
  const [notifications, setNotifications] = useState<NotifyEvent[]>([])
  const [toasts, setToasts] = useState<NotifyEvent[]>([])
  const [watchedChannels, setWatchedChannels] = useState<string[]>(() => loadWatchedChannels())
  const [notifyStatus, setNotifyStatus] = useState<NotifyConnectionStatus>("idle")

  const activeCanvas = workspaces[activeWorkspace]
  const windows = activeCanvas.windows
  const zSeed = activeCanvas.zSeed
  const desktopParams = activeCanvas.params
  const focusedWindowId = activeCanvas.focusedWindowId

  // Present mode: recompute the fit-to-screen framing on enter, on window
  // resize, and when the active canvas's geometry changes (e.g. switching
  // workspace). Deferred to a rAF so it measures post-layout, and guarded so a
  // content-only re-render (filtering, data loads) doesn't churn the transform.
  useEffect(() => {
    if (!present) return
    const recompute = () => setPresentFit((prev) => {
      const next = computePresentFit(windows)
      return sameFit(prev, next) ? prev : next
    })
    const raf = requestAnimationFrame(recompute)
    window.addEventListener("resize", recompute)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", recompute)
    }
  }, [present, windows])

  // mutateCanvas must stay referentially *stable*. Many handlers
  // (move, resize, close, minimize, updatePayload…) are useCallback'd
  // with empty deps and close over setWindows → mutateCanvas. If
  // mutateCanvas were rebuilt on every activeWorkspace change, those
  // handlers would keep firing the very first one — permanently bound
  // to workspace 1 — so windows on 2–5 couldn't be moved or resized.
  // Reading the active id from a ref keeps the closure stable while
  // still routing each mutation to the currently-visible canvas.
  const activeWorkspaceRef = useRef(activeWorkspace)
  activeWorkspaceRef.current = activeWorkspace

  // Latest workspaces snapshot, for event handlers (NOTIFY dispatch)
  // that must see the current windows without being re-subscribed.
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces

  // Windows on *parked* slots that received a NOTIFY while off-screen and
  // owe a refresh — flushed when their desktop is next activated, so an
  // inactive desktop pays nothing for live channels but isn't stale on return.
  const pendingRunRef = useRef<Set<string>>(new Set())

  // Latest active connection, for async handlers (e.g. the pivot
  // distinct-value probe) that fire outside React's render flow.
  const activeConnectionIdRef = useRef(activeConnectionId)
  activeConnectionIdRef.current = activeConnectionId

  // Stable accessors for the live active canvas. Event-handler callbacks read
  // current windows/params through these instead of closing over `windows` /
  // `desktopParams` — closing over them makes the callback identity churn on
  // every canvas change (open/close/move/focus), which would cascade through
  // `baseCtx` and re-render every window (including parked ones) on each edit.
  const liveWindows = useCallback(() => workspacesRef.current[activeWorkspaceRef.current].windows, [])
  const liveParams = useCallback(() => workspacesRef.current[activeWorkspaceRef.current].params, [])

  const mutateCanvas = useCallback(
    (fn: (c: WorkspaceCanvas) => WorkspaceCanvas) => {
      setWorkspaces((prev) => {
        const ws = activeWorkspaceRef.current
        const cur = prev[ws]
        const next = fn(cur)
        if (next === cur) return prev
        return { ...prev, [ws]: next }
      })
    },
    [],
  )

  type Upd<T> = T | ((prev: T) => T)
  const apply = <T,>(u: Upd<T>, prev: T): T =>
    typeof u === "function" ? (u as (p: T) => T)(prev) : u

  const setWindows = useCallback(
    (u: Upd<DesktopWindowState[]>) =>
      mutateCanvas((c) => {
        const next = apply(u, c.windows)
        return next === c.windows ? c : { ...c, windows: next }
      }),
    [mutateCanvas],
  )
  const setZSeed = useCallback(
    (u: Upd<number>) => mutateCanvas((c) => ({ ...c, zSeed: apply(u, c.zSeed) })),
    [mutateCanvas],
  )
  const setDesktopParams = useCallback(
    (u: Upd<DesktopParamValue[]>) =>
      mutateCanvas((c) => {
        const next = apply(u, c.params)
        return next === c.params ? c : { ...c, params: next }
      }),
    [mutateCanvas],
  )
  const setFocusedWindowId = useCallback(
    (u: Upd<string | null>) =>
      mutateCanvas((c) => ({ ...c, focusedWindowId: apply(u, c.focusedWindowId) })),
    [mutateCanvas],
  )
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null)
  const [wallpaperError, setWallpaperError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // ⌘K / Ctrl-K toggles the Scry cascade search prompt (a top-layer overlay).
  const [scryOpen, setScryOpen] = useState(false)
  const scrySpawnCountRef = useRef(0)
  const stateLoadedRef = useRef(false)
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null)
  const wallpaperObjectUrlRef = useRef<string | null>(null)
  const themeCleanupRef = useRef<(() => void) | null>(null)
  const [activePalette, setActivePalette] = useState<ImagePalette | null>(null)
  const [paletteOverrides, setPaletteOverrides] = useState<Partial<ImagePalette> | null>(null)
  // SSR-safe: server always renders `false`; client hydrates from
  // localStorage in the post-mount effect below. Avoids a hydration
  // mismatch on the "Hide/Show dependency lines" menu label when the
  // user has previously enabled it.
  const [lineageVisible, setLineageVisible] = useState<boolean>(false)
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      if (window.localStorage.getItem("rvbbit-lens-lineage-visible") === "true") {
        setLineageVisible(true)
      }
    } catch { /* best-effort */ }
  }, [])

  const setLineage = useCallback((visible: boolean) => {
    setLineageVisible(visible)
    try { window.localStorage.setItem("rvbbit-lens-lineage-visible", String(visible)) } catch { /* best-effort */ }
  }, [])

  // ── Undo / Redo ───────────────────────────────────────────────────
  //
  // Snapshots capture (windows, params, zSeed). Recorded on a 400ms
  // debounce so a drag burst or rapid typing coalesces into one
  // undoable step. The baseline (first state after hydration) is
  // recorded but not pushed onto the undo stack — undo on a fresh
  // desktop is a no-op rather than blanking the canvas.
  const undoStackRef = useRef<DesktopSnapshot[]>([])
  const redoStackRef = useRef<DesktopSnapshot[]>([])
  const lastSnapshotSigRef = useRef<string | null>(null)
  const skipNextSnapshotRef = useRef(false)
  const [undoTick, setUndoTick] = useState(0)

  // Push the previous settled state onto the undo stack. Normally fired by the
  // 400ms debounce, but undo() also calls it synchronously so an undo issued
  // within that window still has the pre-change state to restore.
  const commitSnapshotNow = useCallback(() => {
    const current: DesktopSnapshot = { windows, params: desktopParams, zSeed }
    const sig = snapshotSignature(current)
    if (sig === lastSnapshotSigRef.current) return
    if (skipNextSnapshotRef.current) {
      skipNextSnapshotRef.current = false
      lastSnapshotSigRef.current = sig
      return
    }
    if (lastSnapshotSigRef.current !== null) {
      undoStackRef.current.push(JSON.parse(lastSnapshotSigRef.current) as DesktopSnapshot)
      if (undoStackRef.current.length > UNDO_DEPTH) undoStackRef.current.shift()
      redoStackRef.current = []
    }
    lastSnapshotSigRef.current = sig
    setUndoTick((t) => t + 1)
  }, [windows, desktopParams, zSeed])

  useEffect(() => {
    if (!stateLoadedRef.current) return
    const handle = setTimeout(commitSnapshotNow, 400)
    return () => clearTimeout(handle)
  }, [commitSnapshotNow])

  const applySnapshot = useCallback((snap: DesktopSnapshot) => {
    // Don't let the debounce push this restoration onto undoStack.
    skipNextSnapshotRef.current = true
    setWindows(snap.windows)
    setDesktopParams(snap.params)
    setZSeed(snap.zSeed)
  }, [])

  // After a restore, re-run any data window whose param subscriptions changed
  // (e.g. an undo that removes a just-dropped subscription) so a stale error
  // from the now-reverted SQL clears. Scoped so unrelated windows don't re-run.
  const rerunResubscribedWindows = useCallback(
    (before: DesktopWindowState[], after: DesktopWindowState[]) => {
      const subsSig = (w?: DesktopWindowState) =>
        w && w.kind === "data"
          ? JSON.stringify((w.payload as DataPayload | undefined)?.reactive?.paramSubscriptions ?? [])
          : ""
      const beforeById = new Map(before.map((w) => [w.id, w]))
      setRunSignals((s) => {
        let next: Record<string, number> | null = null
        for (const w of after) {
          if (w.kind !== "data" || subsSig(beforeById.get(w.id)) === subsSig(w)) continue
          next = next ?? { ...s }
          next[w.id] = (next[w.id] ?? 0) + 1
        }
        return next ?? s
      })
    },
    [],
  )

  const undo = useCallback(() => {
    commitSnapshotNow() // flush a pending debounced snapshot so an immediate undo isn't a no-op
    const past = undoStackRef.current
    if (past.length === 0) return
    const current: DesktopSnapshot = { windows, params: desktopParams, zSeed }
    redoStackRef.current.push(cloneSnapshot(current))
    const prev = past.pop()!
    applySnapshot(prev)
    rerunResubscribedWindows(current.windows, prev.windows)
    setUndoTick((t) => t + 1)
  }, [applySnapshot, commitSnapshotNow, rerunResubscribedWindows, desktopParams, windows, zSeed])

  const redo = useCallback(() => {
    const future = redoStackRef.current
    if (future.length === 0) return
    const current: DesktopSnapshot = { windows, params: desktopParams, zSeed }
    undoStackRef.current.push(cloneSnapshot(current))
    const next = future.pop()!
    applySnapshot(next)
    rerunResubscribedWindows(current.windows, next.windows)
    setUndoTick((t) => t + 1)
  }, [applySnapshot, rerunResubscribedWindows, desktopParams, windows, zSeed])

  const canUndo = undoStackRef.current.length > 0
  const canRedo = redoStackRef.current.length > 0
  void undoTick // dependency for menu enabled state recompute

  // ── Font preferences ──────────────────────────────────────────────
  // SSR-safe: server always renders the deterministic defaults; client
  // hydrates from localStorage post-mount. Same shape as lineageVisible
  // above — keeps menu labels (e.g. the "Sans family" submenu value
  // chip) consistent between server and first client paint.
  const [fontPrefs, setFontPrefsState] = useState<FontPrefs>(() => ({
    sans: DEFAULT_SANS,
    mono: DEFAULT_MONO,
    scale: DEFAULT_SCALE,
  }))
  const fontPrefsHydratedRef = useRef(false)
  useEffect(() => {
    if (!fontPrefsHydratedRef.current) {
      fontPrefsHydratedRef.current = true
      const stored = readFontPrefs()
      // Only update if storage actually differs from the SSR defaults
      // to avoid an extra render when nothing's been saved yet.
      if (stored.sans !== fontPrefs.sans || stored.mono !== fontPrefs.mono || stored.scale !== fontPrefs.scale) {
        setFontPrefsState(stored)
        return
      }
    }
    applyFontPrefs(fontPrefs)
    writeFontPrefs(fontPrefs)
  }, [fontPrefs])

  const setSansFont = useCallback((sans: SansFont) => setFontPrefsState((p) => ({ ...p, sans })), [])
  const setMonoFont = useCallback((mono: MonoFont) => setFontPrefsState((p) => ({ ...p, mono })), [])
  const setFontScale = useCallback((scale: FontScale) => setFontPrefsState((p) => ({ ...p, scale })), [])

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof document === "undefined") return "dark"
    return document.documentElement.dataset.theme === "light" ? "light" : "dark"
  })
  const viewAppCount = useViewAppCount()

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeMode(mode)
    if (typeof document !== "undefined") {
      const root = document.documentElement
      root.dataset.theme = mode
      root.style.colorScheme = mode
      root.classList.toggle("dark", mode === "dark")
      try { localStorage.setItem("rvbbit-lens-theme", mode) } catch { /* best-effort */ }
    }
  }, [])

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  )
  const hasRvbbit = !!schema?.hasRvbbit

  // ── Connection bootstrap ────────────────────────────────────────────

  const loadConnections = useCallback(async () => {
    const res = await fetch("/api/db/connections", { cache: "no-store" })
    if (!res.ok) return
    const body = (await res.json()) as { connections: SanitizedConnection[] }
    setConnections(body.connections)
    if (body.connections.length > 0) {
      setActiveConnectionId((current) => {
        if (current && body.connections.some((c) => c.id === current)) return current
        const def = body.connections.find((c) => c.isDefault) ?? body.connections[0]
        return def?.id ?? null
      })
    } else {
      setActiveConnectionId(null)
    }
  }, [])

  const loadSchema = useCallback(async (connectionId: string) => {
    setSchemaLoading(true)
    try {
      const res = await fetch(`/api/db/schema?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" })
      if (!res.ok) {
        setSchema(null)
        return
      }
      const snap = (await res.json()) as SchemaSnapshot
      setSchema(snap)
    } catch {
      setSchema(null)
    } finally {
      setSchemaLoading(false)
    }
  }, [])

  useEffect(() => { void loadConnections() }, [loadConnections])

  useEffect(() => {
    if (!activeConnectionId) {
      setSchema(null)
      return
    }
    void loadSchema(activeConnectionId)
  }, [activeConnectionId, loadSchema])

  // Load the semantic-operator catalog for the active connection (cached).
  useEffect(() => {
    if (!activeConnectionId) {
      setSemanticOps([])
      return
    }
    let cancelled = false
    loadSemanticOps(activeConnectionId).then((ops) => {
      if (cancelled) return
      if (ops.length === 0) {
        console.warn(
          "[rvbbit-lens] no scalar semantic operators for this connection — " +
            "rvbbit.operators is empty or this isn't a rvbbit database. Semantic drop tiles are hidden.",
        )
      }
      setSemanticOps(ops)
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  // Refresh the semantic-op catalog when operators change. Two triggers:
  //  (1) in-session operator/capability edits dispatch `operators-changed`;
  //  (2) the window regaining focus (throttled) — so operators added OUT OF
  //      BAND (psql, migrations, another tab) appear in the drop tiles without
  //      a manual reload. The catalog is loaded once at session start, so
  //      external adds would otherwise stay invisible until a hard reload.
  useEffect(() => {
    if (!activeConnectionId) return
    let lastRefresh = 0
    const refresh = () => {
      invalidateSemanticOps(activeConnectionId)
      loadSemanticOps(activeConnectionId).then(setSemanticOps)
    }
    const onChanged = () => refresh()
    const onFocus = () => {
      const now = Date.now()
      if (now - lastRefresh < 4000) return // throttle: at most once / 4s
      lastRefresh = now
      refresh()
    }
    window.addEventListener("rvbbit-lens:operators-changed", onChanged)
    window.addEventListener("focus", onFocus)
    return () => {
      window.removeEventListener("rvbbit-lens:operators-changed", onChanged)
      window.removeEventListener("focus", onFocus)
    }
  }, [activeConnectionId])

  // ── Local desktop persistence ───────────────────────────────────────

  useEffect(() => {
    if (stateLoadedRef.current) return
    stateLoadedRef.current = true
    const saved = loadDesktopState()
    if (saved) {
      setWorkspaces(saved.workspaces)
      setActiveWorkspace(saved.activeWorkspace)
      setViewport(clampViewport(saved.viewport ?? DEFAULT_VIEWPORT))
      if (saved.activeConnectionId) setActiveConnectionId(saved.activeConnectionId)
      setCurrentSceneId(saved.currentSceneId ?? null)
    }
    // Load wallpaper blob + palette from IndexedDB if present.
    void (async () => {
      try {
        const record = await loadDesktopWallpaperRecord()
        if (record) {
          setWallpaperObjectUrl(URL.createObjectURL(record.blob))
          if (record.palette) setActivePalette(record.palette)
          if (record.paletteOverrides) setPaletteOverrides(record.paletteOverrides)
        }
      } catch {
        // best-effort
      }
    })()
    // Release object URL on unmount.
    return () => {
      if (wallpaperObjectUrlRef.current) {
        URL.revokeObjectURL(wallpaperObjectUrlRef.current)
        wallpaperObjectUrlRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!stateLoadedRef.current) return
    saveDesktopState({ workspaces, activeWorkspace, viewport, activeConnectionId, currentSceneId })
  }, [workspaces, activeWorkspace, viewport, activeConnectionId, currentSceneId])

  // Phase 1 homebase: seed the durable server shadow once on mount, so existing
  // browser data — especially saved scenes, which otherwise only shadow on
  // mutation — is backed up immediately. Best-effort; no-ops if unreachable.
  useEffect(() => {
    shadowDesktopState(loadDesktopState())
    shadowScenes(listScenes())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Wallpaper ──────────────────────────────────────────────────────

  const setWallpaperObjectUrl = useCallback((url: string | null) => {
    if (wallpaperObjectUrlRef.current && wallpaperObjectUrlRef.current !== url) {
      URL.revokeObjectURL(wallpaperObjectUrlRef.current)
    }
    wallpaperObjectUrlRef.current = url
    setWallpaperUrl(url)
  }, [])

  const onPickWallpaper = useCallback(() => {
    wallpaperInputRef.current?.click()
  }, [])

  const onWallpaperFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!file) return
    if (!isLikelyImageFile(file)) {
      setWallpaperError("Choose an image file.")
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const ok = await canRenderImageUrl(objectUrl)
    if (!ok) {
      URL.revokeObjectURL(objectUrl)
      setWallpaperError("That image could not be rendered.")
      return
    }
    try {
      // Run vibrant on the freshly-loaded image. Done in parallel with
      // the IndexedDB write so the visible swap is snappy.
      const palette = await vibrantExtractor.extract(file).catch(() => null)
      await saveDesktopWallpaper(file, palette ?? undefined)
      setWallpaperObjectUrl(objectUrl)
      setActivePalette(palette)
      setPaletteOverrides(null) // fresh image → drop the previous overrides
      setWallpaperError(null)
    } catch (err) {
      URL.revokeObjectURL(objectUrl)
      setWallpaperError(err instanceof Error ? err.message : "Could not save wallpaper.")
    }
  }, [setWallpaperObjectUrl])

  const onClearWallpaper = useCallback(async () => {
    setWallpaperObjectUrl(null)
    setActivePalette(null)
    setPaletteOverrides(null)
    setWallpaperError(null)
    try { await clearDesktopWallpaper() } catch { /* ignore */ }
  }, [setWallpaperObjectUrl])

  // Apply the derived theme whenever the palette (or its overrides)
  // changes. Releasing the previous overlay restores any token values
  // we touched before, so dropping the wallpaper falls back to the
  // hand-tuned globals.css defaults cleanly.
  useEffect(() => {
    if (themeCleanupRef.current) {
      themeCleanupRef.current()
      themeCleanupRef.current = null
    }
    if (!activePalette) return
    const merged: ImagePalette = { ...activePalette, ...(paletteOverrides ?? {}) }
    const theme = deriveTheme(merged, themeMode)
    themeCleanupRef.current = applyTokensToRoot(theme.tokens)
    return () => {
      themeCleanupRef.current?.()
      themeCleanupRef.current = null
    }
  }, [activePalette, paletteOverrides, themeMode])

  // Persist any change to the palette overrides back to IndexedDB so a
  // reload restores the exact theme the user is looking at right now.
  useEffect(() => {
    if (!activePalette) return
    void updateDesktopWallpaperPalette(activePalette, paletteOverrides ?? undefined).catch(() => {})
  }, [activePalette, paletteOverrides])

  // ── Window manager ──────────────────────────────────────────────────

  // focus + openWindow touch windows AND zSeed AND focusedWindowId
  // together, so they go through mutateCanvas directly rather than
  // nesting the wrapper setters (nested setState updaters misbehave).
  const focus = useCallback((id: string) => {
    mutateCanvas((c) => {
      const target = c.windows.find((w) => w.id === id)
      if (!target) return { ...c, focusedWindowId: id }
      const maxZ = c.windows.reduce((m, w) => Math.max(m, w.zIndex), 0)
      if (target.zIndex === maxZ && !target.minimized) {
        return c.focusedWindowId === id ? c : { ...c, focusedWindowId: id }
      }
      const nextZ = maxZ + 1
      return {
        ...c,
        focusedWindowId: id,
        zSeed: Math.max(c.zSeed, nextZ),
        windows: c.windows.map((w) =>
          w.id === id ? { ...w, zIndex: nextZ, minimized: false } : w,
        ),
      }
    })
  }, [mutateCanvas])

  const blurAll = useCallback(() => setFocusedWindowId(null), [setFocusedWindowId])

  // ── Workspace switching ─────────────────────────────────────────────
  const wsTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const switchWorkspace = useCallback((target: SlotId) => {
    // Flush any NOTIFY-deferred refreshes owed to the slot we're entering, so
    // a desktop that went stale while parked catches up the instant it shows.
    if (activeWorkspaceRef.current !== target && pendingRunRef.current.size > 0) {
      const entering = new Set(workspacesRef.current[target].windows.map((w) => w.id))
      const toRun = [...pendingRunRef.current].filter((wid) => entering.has(wid))
      if (toRun.length > 0) {
        for (const wid of toRun) pendingRunRef.current.delete(wid)
        setRunSignals((s) => {
          const next = { ...s }
          for (const wid of toRun) next[wid] = (next[wid] ?? 0) + 1
          return next
        })
      }
    }
    setActiveWorkspace((current) => {
      if (current === target) return current
      // Direction by slot order (the Scene slot sorts after 5) so the slide
      // animation runs the right way even when the Scene slot is involved.
      const dir: WorkspaceTransition["dir"] =
        ALL_SLOT_IDS.indexOf(target) > ALL_SLOT_IDS.indexOf(current) ? "forward" : "backward"
      setWsTransition({ from: current, to: target, dir })
      // Undo history is per *moment*, not per workspace — switching is a
      // clean break, so reset the stacks and let the next snapshot
      // re-baseline against the target canvas.
      undoStackRef.current = []
      redoStackRef.current = []
      lastSnapshotSigRef.current = null
      if (wsTransitionTimerRef.current) clearTimeout(wsTransitionTimerRef.current)
      wsTransitionTimerRef.current = setTimeout(() => {
        setWsTransition((t) => (t && t.to === target ? null : t))
      }, 300)
      return target
    })
  }, [])

  useEffect(() => () => {
    if (wsTransitionTimerRef.current) clearTimeout(wsTransitionTimerRef.current)
  }, [])

  const workspaceOccupancy = useMemo(() => {
    const set = new Set<WorkspaceId>()
    for (const id of WORKSPACE_IDS) {
      if (workspaces[id].windows.length > 0) set.add(id)
    }
    return set
  }, [workspaces])

  // ── Scene slot ─────────────────────────────────────────────────────
  // The Scene slot is the only canvas with document identity. currentScene
  // resolves it from the library; sceneDirty compares the live slot canvas
  // hash against the saved Scene's (body has no timestamp, so it's stable).
  const sceneSlotCanvas = workspaces[SCENE_SLOT]
  const sceneSlotOccupied = sceneSlotCanvas.windows.length > 0
  const currentScene = useMemo(
    () => (currentSceneId ? (scenes.find((s) => s.id === currentSceneId) ?? null) : null),
    [scenes, currentSceneId],
  )
  const sceneDirty = useMemo(
    () => currentScene != null && contentHashOf(sceneSlotCanvas) !== currentScene.contentHash,
    [currentScene, sceneSlotCanvas],
  )

  // Mirror the localStorage Scene library; refresh on same-tab writes and
  // cross-tab storage events.
  useEffect(() => {
    const refresh = () => setScenes(listScenes())
    refresh()
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "rvbbit-lens.scenes.v1") refresh()
    }
    window.addEventListener(SCENES_CHANGED_EVENT, refresh)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(SCENES_CHANGED_EVENT, refresh)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const sceneConnectionFingerprint = useCallback((): SceneConnectionFingerprint => {
    const c = connections.find((x) => x.id === activeConnectionId)
    return {
      connectionId: activeConnectionId,
      label: c?.label,
      host: c?.host,
      port: c?.port,
      database: c?.database,
      user: c?.user,
    }
  }, [connections, activeConnectionId])

  // Save As — freeze the ACTIVE canvas as a NEW Scene, then auto-switch into
  // the Scene slot so "what I saved is now the open document" lands at once.
  // (When the active canvas is a numbered slot, the cloned copy keeps the
  // same window ids as the still-live source — benign: focus is per-canvas,
  // only the global runSignals map can cross-fire a re-run on both.)
  const saveDesktopAsScene = useCallback(
    (name: string) => {
      const body = cloneCanvas(workspaces[activeWorkspace])
      const scene = upsertScene({
        name,
        body,
        viewport,
        connection: sceneConnectionFingerprint(),
        bundle: buildSceneBundle(body.windows),
      })
      setWorkspaces((prev) => ({ ...prev, [SCENE_SLOT]: cloneCanvas(body) }))
      setCurrentSceneId(scene.id)
      switchWorkspace(SCENE_SLOT)
    },
    [workspaces, activeWorkspace, viewport, sceneConnectionFingerprint, switchWorkspace],
  )

  // Save — overwrite the open Scene with the live Scene-slot canvas.
  const saveCurrentScene = useCallback(() => {
    if (!currentSceneId) return
    const existing = getScene(currentSceneId)
    // Deleted out from under us (e.g. another tab) — don't resurrect it.
    if (!existing) return
    const body = cloneCanvas(workspaces[SCENE_SLOT])
    upsertScene({
      id: currentSceneId,
      name: existing.name,
      body,
      viewport,
      connection: sceneConnectionFingerprint(),
      bundle: buildSceneBundle(body.windows),
    })
  }, [currentSceneId, workspaces, viewport, sceneConnectionFingerprint])

  // Open — restore a Scene into the Scene slot and switch to it.
  const openScene = useCallback(
    (id: string) => {
      const scene = getScene(id)
      if (!scene) return
      // Don't silently drop unsaved edits to a different open Scene.
      if (
        currentSceneId &&
        currentSceneId !== id &&
        contentHashOf(workspaces[SCENE_SLOT]) !== (getScene(currentSceneId)?.contentHash ?? "")
      ) {
        if (!window.confirm("The open Scene has unsaved changes that will be replaced. Continue?")) {
          return
        }
      }
      restoreSceneBundle(scene.bundle)
      setWorkspaces((prev) => ({ ...prev, [SCENE_SLOT]: cloneCanvas(scene.body) }))
      if (scene.viewport) setViewport(clampViewport(scene.viewport))
      // Rebind the connection ONLY on an exact id still present in the registry
      // — never guess from the fingerprint (a localhost collision could bind
      // the wrong DB). Otherwise leave the active connection untouched.
      const connId = scene.connection?.connectionId
      if (connId && connections.some((c) => c.id === connId)) setActiveConnectionId(connId)
      setCurrentSceneId(id)
      switchWorkspace(SCENE_SLOT)
    },
    [currentSceneId, workspaces, connections, switchWorkspace],
  )

  const renameSceneById = useCallback((id: string, name: string) => {
    renameScene(id, name)
  }, [])

  const deleteSceneById = useCallback(
    (id: string) => {
      deleteScene(id)
      // Keep the slot's windows but drop document identity → becomes "unsaved".
      if (id === currentSceneId) setCurrentSceneId(null)
    },
    [currentSceneId],
  )

  // ── LISTEN/NOTIFY: channel set + SSE feed ───────────────────────────
  //
  // The set of channels the server listens on is the union of every
  // data window's notifyChannel (across all five workspaces) and the
  // user's "watched" channels. channelKey is the stable string the SSE
  // effect keys off — when it changes, the EventSource reconnects.
  const windowChannels = useMemo(() => {
    const set = new Set<string>()
    for (const id of ALL_SLOT_IDS) {
      for (const w of workspaces[id].windows) {
        if (w.kind !== "data") continue
        const ch = (w.payload as DataPayload | undefined)?.notifyChannel
        if (ch) set.add(ch)
      }
    }
    return [...set].sort()
  }, [workspaces])

  const channelUnion = useMemo(
    () => [...new Set([...windowChannels, ...watchedChannels])].sort(),
    [windowChannels, watchedChannels],
  )
  const channelKey = channelUnion.join(",")

  useEffect(() => {
    saveWatchedChannels(watchedChannels)
  }, [watchedChannels])

  const handleNotify = useCallback(
    (data: { channel: string; payload?: string; at?: string }) => {
      // Re-run every data window subscribed to this channel, in any
      // workspace — the point of a subscription is to stay live.
      const ws = workspacesRef.current
      const activeSlot = activeWorkspaceRef.current
      const idsToRefresh: string[] = []
      for (const id of ALL_SLOT_IDS) {
        for (const w of ws[id].windows) {
          if (w.kind !== "data") continue
          if ((w.payload as DataPayload | undefined)?.notifyChannel === data.channel) {
            // The active slot re-runs immediately; a parked slot defers the
            // refresh until it's next shown, so off-screen desktops never run
            // hidden queries but still catch up on activation.
            if (id === activeSlot) idsToRefresh.push(w.id)
            else pendingRunRef.current.add(w.id)
          }
        }
      }
      if (idsToRefresh.length > 0) {
        setRunSignals((s) => {
          const next = { ...s }
          for (const wid of idsToRefresh) next[wid] = (next[wid] ?? 0) + 1
          return next
        })
      }
      const event: NotifyEvent = {
        id: randomUUID(),
        channel: data.channel,
        payload: data.payload ?? "",
        at: data.at ?? new Date().toISOString(),
        refreshedCount: idsToRefresh.length,
      }
      setNotifications((prev) => [event, ...prev].slice(0, 200))
      setToasts((prev) => [event, ...prev].slice(0, 4))
    },
    [],
  )

  useEffect(() => {
    if (!activeConnectionId || channelUnion.length === 0) {
      setNotifyStatus("idle")
      return
    }
    setNotifyStatus("connecting")
    const qs = new URLSearchParams({ connectionId: activeConnectionId, channels: channelKey })
    const es = new EventSource(`/api/db/listen?${qs.toString()}`)
    es.addEventListener("ready", () => setNotifyStatus("open"))
    es.addEventListener("fail", () => setNotifyStatus("error"))
    es.addEventListener("notify", (ev) => {
      try {
        handleNotify(JSON.parse((ev as MessageEvent).data))
      } catch {
        // Ignore malformed event frames.
      }
    })
    es.onerror = () => setNotifyStatus("error")
    return () => es.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, channelKey])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addWatchedChannel = useCallback((channel: string) => {
    const ch = normalizeChannel(channel)
    if (!ch) return
    setWatchedChannels((prev) => (prev.includes(ch) ? prev : [...prev, ch]))
  }, [])

  const removeWatchedChannel = useCallback((channel: string) => {
    setWatchedChannels((prev) => prev.filter((c) => c !== channel))
  }, [])

  const clearNotifications = useCallback(() => setNotifications([]), [])

  const close = useCallback((id: string) => {
    setWindows((ws) => ws.filter((w) => w.id !== id))
  }, [])

  const minimize = useCallback((id: string) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, minimized: true } : w)))
  }, [])

  const move = useCallback((id: string, x: number, y: number) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, x: clampWorld(x), y: clampWorld(y) } : w)))
  }, [])

  const resize = useCallback((id: string, width: number, height: number) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, width, height } : w)))
  }, [])

  const openWindow = useCallback((win: Omit<DesktopWindowState, "zIndex" | "minimized">) => {
    mutateCanvas((c) => {
      // Idempotent under React strict-mode double-invocation: if a window
      // with this id already exists (e.g. caller pre-generated a UUID),
      // leave the canvas unchanged rather than duplicating it.
      if (c.windows.some((w) => w.id === win.id)) return c
      const nextZ = c.windows.reduce((m, w) => Math.max(m, w.zIndex), 0) + 1
      return {
        ...c,
        zSeed: Math.max(c.zSeed, nextZ),
        windows: [...c.windows, { ...win, zIndex: nextZ, minimized: false }],
        focusedWindowId: win.id,
      }
    })
  }, [mutateCanvas])

  const updatePayload = useCallback((id: string, mutator: (payload: unknown) => unknown) => {
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, payload: mutator(w.payload) as DesktopWindowState["payload"] } : w)))
  }, [])

  // ── Params + reactive engine ───────────────────────────────────────

  const clearParamSubscriptions = useCallback((key: string) => {
    setWindows((prev) =>
      prev.map((w) => {
        if (w.kind !== "data") return w
        const payload = w.payload as DataPayload | undefined
        const subs = payload?.reactive?.paramSubscriptions?.filter((s) => s.key !== key)
        if (!payload?.reactive || subs?.length === payload.reactive.paramSubscriptions?.length) return w
        return {
          ...w,
          payload: {
            ...payload,
            reactive: {
              ...payload.reactive,
              paramSubscriptions: subs,
              version: (payload.reactive.version ?? 1) + 1,
            },
          } satisfies DataPayload,
        }
      }),
    )
  }, [])

  const removeParam = useCallback((key: string) => {
    setDesktopParams((prev) => prev.filter((p) => p.key !== key))
    clearParamSubscriptions(key)
  }, [clearParamSubscriptions])

  const emitParam = useCallback((input: {
    sourceWindowId: string
    sourceBlockName: string
    sourceTitle: string
    field: string
    value: unknown
    operator?: DesktopParamOperator
    multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
    cascade?: boolean
    dataTypeId?: number
    type?: string
  }) => {
    const key = paramKey(input.sourceBlockName, input.field)
    const operator = input.operator ?? "eq"
    setDesktopParams((prev) => {
      const existing = prev.find((p) => p.key === key)
      // Clicking the same value with eq toggles the filter off.
      if (operator === "eq" && existing && existing.operator !== "in" && sameParamValue(existing.value, input.value)) {
        return prev.filter((p) => p.key !== key)
      }
      // gte/lte threshold (slider / datepicker): a null value clears it; a real
      // value replaces the single scalar threshold.
      if ((operator === "gte" || operator === "lte") && (input.value === null || input.value === undefined)) {
        return prev.filter((p) => p.key !== key)
      }
      let value = input.value
      if (operator === "in") {
        // One param per (block, field): a new emit replaces the existing one.
        // The flavor guard only controls VALUE carry-over — a flavor switch
        // (pick↔cascade) starts a fresh value set instead of absorbing the other
        // mode's accumulated values. (Switching flavor still replaces the prior
        // param; we keep one param per column by design.)
        const sameFlavor = (existing?.cascade !== false) === (input.cascade ?? true)
        const cur =
          existing?.operator === "in" && Array.isArray(existing.value) && sameFlavor
            ? existing.value
            : []
        const action = input.multiValueAction ?? "toggle"
        const present = cur.some((v) => sameParamValue(v, input.value))
        const next = action === "add"
          ? present ? cur : [...cur, input.value]
          : action === "remove"
            ? cur.filter((v) => !sameParamValue(v, input.value))
          : action === "replace"
            // mirror a whole value set (chart selection): value IS the array.
            ? Array.isArray(input.value) ? input.value : input.value == null ? [] : [input.value]
          : action === "set"
            // single-select replace: exactly one value (null → IS NULL). Clear
            // is a separate "remove" of the selected value (empties → deleted).
            ? [input.value]
            : present ? cur.filter((v) => !sameParamValue(v, input.value)) : [...cur, input.value]
        if (next.length === 0) return prev.filter((p) => p.key !== key)
        value = next
      }
      const np: DesktopParamValue = {
        key,
        sourceWindowId: input.sourceWindowId,
        sourceBlockName: input.sourceBlockName,
        sourceTitle: input.sourceTitle,
        field: input.field,
        operator,
        cascade: input.cascade ?? true,
        value,
        dataTypeId: input.dataTypeId,
        type: input.type,
        updatedAt: new Date().toISOString(),
      }
      return [np, ...prev.filter((p) => p.key !== key)]
    })
  }, [])

  const subscribeParam = useCallback((targetWindowId: string, key: string, targetField?: string, target?: ParamTarget) => {
    const param = liveParams().find((p) => p.key === key)
    if (!param) return
    setWindows((prev) =>
      prev.map((w) => {
        if (w.id !== targetWindowId || w.kind !== "data") return w
        const payload = w.payload as DataPayload | undefined
        if (!payload) return w
        const reactive: ReactiveBlockState = payload.reactive ?? {
          blockName: uniqueBlockName(payload.title || w.title, prev, w.id),
          sourceSql: sourceSqlForPayload(payload),
          paramSubscriptions: [],
          version: 1,
        }
        const subs = reactive.paramSubscriptions ?? []
        const tf = targetField ?? param.field
        // The drop site (data-grid-window) resolves placement with full context
        // (output columns + {ref} upstreams), so prefer the target it passes.
        // Fall back to the single-table heuristic for any other caller.
        const resolved = target ?? resolveParamTableTarget(sourceSqlForPayload(payload), tf, schema)
        const next = { key, targetField: tf, target: resolved }
        return {
          ...w,
          payload: {
            ...payload,
            reactive: {
              ...reactive,
              paramSubscriptions: [next, ...subs.filter((s) => s.key !== key)],
              version: (reactive.version ?? 1) + 1,
            },
          } satisfies DataPayload,
        }
      }),
    )
    setRunSignals((s) => ({ ...s, [targetWindowId]: (s[targetWindowId] ?? 0) + 1 }))
  }, [liveParams, schema])

  // ── Helpers to open specific window kinds ───────────────────────────

  const openFinder = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "finder")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "finder",
      title: "Finder",
      x: 40, y: 40, width: 360, height: 560,
      payload: { kind: "finder" } satisfies FinderPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openConnections = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "connections")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "connections",
      title: "Connections",
      x: 200, y: 90, width: 560, height: 480,
      payload: { kind: "connections" },
    })
  }, [focus, openWindow, liveWindows])

  const openSqlScratch = useCallback(() => {
    if (!activeConnectionId) {
      openConnections()
      return
    }
    openWindow({
      id: randomUUID(),
      kind: "data",
      title: "Untitled SQL",
      x: 80 + Math.random() * 60,
      y: 80 + Math.random() * 60,
      width: 760,
      height: 480,
      payload: {
        kind: "data",
        title: "Untitled SQL",
        sql: "-- Write SQL and press Cmd+Enter\nSELECT 1;",
        origin: "query",
        view: { activeTab: "sql", sqlRailOpen: true, sqlRailWidthPx: 360 },
      } satisfies DataPayload,
    })
  }, [activeConnectionId, openConnections, openWindow])

  const openTableFromFinder = useCallback((schemaName: string, tableName: string) => {
    if (!activeConnectionId) return
    openWindow({
      id: randomUUID(),
      kind: "data",
      title: `${schemaName}.${tableName}`,
      x: 120 + Math.random() * 80,
      y: 100 + Math.random() * 80,
      width: 800,
      height: 520,
      payload: {
        kind: "data",
        title: `${schemaName}.${tableName}`,
        sql: previewSqlForTable(schemaName, tableName),
        origin: "table",
        table: { schema: schemaName, name: tableName },
        view: { activeTab: "rows", sqlRailOpen: false, sqlRailWidthPx: 360 },
      } satisfies DataPayload,
    })
  }, [activeConnectionId, openWindow])

  // Open a single FIELD as a focused query: value distribution (categorical) or
  // a numeric summary (sum/avg/min/max). Async — detects the column type first.
  const openField = useCallback(
    async (schema: string, rel: string, col: string) => {
      if (!activeConnectionId) return
      const sql = await fetchFieldFocusSql(activeConnectionId, schema, rel, col)
      openWindow({
        id: randomUUID(),
        kind: "data",
        title: `${schema}.${rel}.${col}`,
        x: 130 + Math.random() * 80,
        y: 100 + Math.random() * 80,
        width: 720,
        height: 520,
        payload: {
          kind: "data",
          title: `${schema}.${rel}.${col}`,
          sql,
          origin: "query",
          view: { activeTab: "rows", sqlRailOpen: true, sqlRailWidthPx: 360 },
        } satisfies DataPayload,
      })
    },
    [activeConnectionId, openWindow],
  )

  // P4 graduation: open a data window per distinct table from a batch (Scry's
  // "send to desktop" set), cascade-placed and deduped against already-open
  // table windows so nothing double-opens.
  const graduateTables = useCallback(
    (tables: { schema: string; rel: string }[]) => {
      if (!activeConnectionId) return
      let n = 0
      for (const t of tables) {
        const already = liveWindows().some(
          (w) =>
            w.kind === "data" &&
            (w.payload as DataPayload | undefined)?.table?.schema === t.schema &&
            (w.payload as DataPayload | undefined)?.table?.name === t.rel,
        )
        if (already) continue
        openWindow({
          id: randomUUID(),
          kind: "data",
          title: `${t.schema}.${t.rel}`,
          x: 140 + (n % 12) * 30,
          y: 110 + (n % 12) * 30,
          width: 800,
          height: 520,
          payload: {
            kind: "data",
            title: `${t.schema}.${t.rel}`,
            sql: previewSqlForTable(t.schema, t.rel),
            origin: "table",
            table: { schema: t.schema, name: t.rel },
            view: { activeTab: "rows", sqlRailOpen: false, sqlRailWidthPx: 360 },
          } satisfies DataPayload,
        })
        n++
      }
    },
    [activeConnectionId, openWindow, liveWindows],
  )

  const openViewApps = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "view-apps")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "view-apps",
      title: "View Apps",
      x: 240, y: 120, width: 720, height: 480,
      payload: { kind: "view-apps" } satisfies ViewAppsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openViewApp = useCallback((appId: string) => {
    openWindow({
      id: randomUUID(),
      kind: "view-app",
      title: "View App",
      x: 180 + Math.random() * 60,
      y: 130 + Math.random() * 60,
      width: 760,
      height: 520,
      payload: { kind: "view-app", appId } satisfies ViewAppPayload,
    })
  }, [openWindow])

  const openViewAppBuilder = useCallback((seed?: ViewAppBuilderPayload) => {
    openWindow({
      id: randomUUID(),
      kind: "view-app-builder",
      title: "New View App",
      x: 220 + Math.random() * 50,
      y: 140 + Math.random() * 50,
      width: 640,
      height: 480,
      payload: { kind: "view-app-builder", ...seed },
    })
  }, [openWindow])

  const openSystemObjects = useCallback((initial?: SystemObjectsPayload["initialCategory"]) => {
    openWindow({
      id: randomUUID(),
      kind: "system-objects",
      title: "System Objects",
      x: 160, y: 80, width: 880, height: 580,
      payload: { kind: "system-objects", initialCategory: initial } satisfies SystemObjectsPayload,
    })
  }, [openWindow])

  const openExtensions = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "extensions")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "extensions",
      title: "Extensions",
      x: 180, y: 100, width: 600, height: 440,
      payload: { kind: "extensions" } satisfies ExtensionsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openRvbbitCache = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "rvbbit-cache")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "rvbbit-cache",
      title: "Receipts",
      x: 200, y: 110, width: 760, height: 500,
      payload: { kind: "rvbbit-cache", initialView: "receipts" } satisfies RvbbitCachePayload,
    })
  }, [focus, openWindow, liveWindows])

  const openCache = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "cache")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "cache",
      title: "Cache",
      x: 230, y: 130, width: 780, height: 520,
      payload: { kind: "cache", initialView: "synth" } satisfies CachePayload,
    })
  }, [focus, openWindow, liveWindows])

  const openSqlWith = useCallback(
    (sql: string, title: string) => {
      if (!activeConnectionId) {
        openConnections()
        return
      }
      openWindow({
        id: randomUUID(),
        kind: "data",
        title,
        x: 120 + Math.random() * 60,
        y: 90 + Math.random() * 60,
        width: 760,
        height: 460,
        payload: {
          kind: "data",
          title,
          sql,
          origin: "query",
          view: { activeTab: "rows", sqlRailOpen: true, sqlRailWidthPx: 360 },
        } satisfies DataPayload,
      })
    },
    [activeConnectionId, openConnections, openWindow],
  )

  const openSqlScratchAtPos = useCallback(
    (x: number, y: number) => {
      if (!activeConnectionId) {
        openConnections()
        return
      }
      openWindow({
        id: randomUUID(),
        kind: "data",
        title: "Untitled SQL",
        x,
        y,
        width: 760,
        height: 480,
        payload: {
          kind: "data",
          title: "Untitled SQL",
          sql: "-- Write SQL and press Cmd+Enter\nSELECT 1;",
          origin: "query",
          view: { activeTab: "sql", sqlRailOpen: true, sqlRailWidthPx: 360 },
        } satisfies DataPayload,
      })
    },
    [activeConnectionId, openConnections, openWindow],
  )

  const openPgMonitor = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "pg-monitor")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "pg-monitor",
      title: "Postgres Monitor",
      x: 120, y: 80, width: 940, height: 720,
      payload: { kind: "pg-monitor" } satisfies PgMonitorPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openOperators = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "operators")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "operators",
      title: "Operators",
      x: 160, y: 90, width: 460, height: 540,
      payload: { kind: "operators" } satisfies OperatorsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openOperatorFlow = useCallback(
    (operatorName: string | null, receiptId?: string | null) => {
      if (operatorName) {
        const existing = liveWindows().find(
          (w) =>
            w.kind === "operator-flow" &&
            (w.payload as OperatorFlowPayload | undefined)?.operatorName === operatorName,
        )
        if (existing) {
          // Deep-link case: update its payload so the receipt selector lands
          // on the requested run (focus alone wouldn't change which receipt
          // is shown).
          if (receiptId) {
            updatePayload(existing.id, (p) => ({
              ...(p as OperatorFlowPayload),
              receiptId,
            }))
          }
          return focus(existing.id)
        }
      }
      openWindow({
        id: randomUUID(),
        kind: "operator-flow",
        title: operatorName ? `Operator · ${operatorName}` : "New Operator",
        x: 150 + Math.random() * 80,
        y: 70 + Math.random() * 60,
        width: 1080,
        height: 640,
        payload: {
          kind: "operator-flow",
          operatorName,
          receiptId: receiptId ?? null,
        } satisfies OperatorFlowPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openSpecialists = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "specialists")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "specialists",
      title: "Specialists",
      x: 150, y: 84, width: 768, height: 680,
      payload: { kind: "specialists" } satisfies SpecialistsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openRouting = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "routing")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "routing",
      title: "Adaptive Routing",
      x: 120, y: 70, width: 1100, height: 740,
      payload: { kind: "routing" } satisfies RoutingPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openMcpServers = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "mcp-servers")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "mcp-servers",
      title: "MCP Servers",
      x: 150, y: 84, width: 820, height: 680,
      payload: { kind: "mcp-servers" } satisfies McpServersPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openCosts = useCallback((initialFilter?: CostsPayload["initialFilter"]) => {
    const existing = liveWindows().find((w) => w.kind === "costs")
    if (existing) {
      if (initialFilter) {
        updatePayload(existing.id, (p) => ({
          ...(p as CostsPayload),
          initialFilter,
        }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "costs",
      title: "Costs",
      x: 120, y: 64, width: 1040, height: 720,
      payload: {
        kind: "costs",
        initialFilter,
      } satisfies CostsPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openSyncMirror = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "sync-mirror")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "sync-mirror",
      title: "Temporal Mirror",
      x: 128, y: 68, width: 920, height: 640,
      payload: { kind: "sync-mirror" } satisfies SyncMirrorPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openDashboards = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "dashboards")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "dashboards",
      title: "Dashboards",
      x: 140, y: 76, width: 1060, height: 680,
      payload: { kind: "dashboards" } satisfies DashboardsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openDuck = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "duck")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "duck",
      title: "Duck Monitor",
      x: 132, y: 70, width: 1000, height: 700,
      payload: { kind: "duck" } satisfies DuckPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openCapabilities = useCallback((tagFilter?: string | null) => {
    const existing = liveWindows().find((w) => w.kind === "capabilities")
    if (existing) {
      if (tagFilter) {
        updatePayload(existing.id, (p) => ({
          ...(p as CapabilitiesPayload),
          tagFilter,
        }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "capabilities",
      title: "Capabilities",
      x: 140, y: 76, width: 980, height: 700,
      payload: {
        kind: "capabilities",
        tagFilter: tagFilter ?? null,
      } satisfies CapabilitiesPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openHfDeploy = useCallback(
    (modelId?: string | null) => {
      const existing = liveWindows().find((w) => w.kind === "hf-deploy")
      if (existing) {
        if (modelId) {
          updatePayload(existing.id, (p) => ({
            ...(p as HfDeployPayload),
            modelId,
          }))
        }
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "hf-deploy",
        title: "Deploy · Hugging Face",
        x: 160 + Math.random() * 40,
        y: 88 + Math.random() * 40,
        width: 1080,
        height: 720,
        payload: { kind: "hf-deploy", modelId: modelId ?? null } satisfies HfDeployPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openCapabilityDetail = useCallback(
    (catalogId: string, initialTab?: CapabilityDetailPayload["initialTab"]) => {
      const existing = liveWindows().find(
        (w) =>
          w.kind === "capability-detail" &&
          (w.payload as CapabilityDetailPayload | undefined)?.catalogId === catalogId,
      )
      if (existing) {
        if (initialTab) {
          updatePayload(existing.id, (p) => ({
            ...(p as CapabilityDetailPayload),
            initialTab,
          }))
        }
        return focus(existing.id)
      }
      const lastSegment = catalogId.split("/").pop() ?? catalogId
      openWindow({
        id: randomUUID(),
        kind: "capability-detail",
        title: `Capability · ${lastSegment.replace(/\.ya?ml$/, "")}`,
        x: 170 + Math.random() * 40,
        y: 90 + Math.random() * 40,
        width: 1040,
        height: 700,
        payload: {
          kind: "capability-detail",
          catalogId,
          initialTab,
        } satisfies CapabilityDetailPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openWarren = useCallback(
    (initialTab?: WarrenPayload["initialTab"]) => {
      const existing = liveWindows().find((w) => w.kind === "warren")
      if (existing) {
        if (initialTab) {
          updatePayload(existing.id, (p) => ({
            ...(p as WarrenPayload),
            initialTab,
          }))
        }
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "warren",
        title: "Warren",
        x: 140, y: 78, width: 1080, height: 720,
        payload: { kind: "warren", initialTab } satisfies WarrenPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openWarrenJob = useCallback(
    (jobId: string, jobName?: string | null) => {
      const existing = liveWindows().find(
        (w) =>
          w.kind === "warren-job-detail" &&
          (w.payload as WarrenJobDetailPayload | undefined)?.jobId === jobId,
      )
      if (existing) return focus(existing.id)
      const titleId = jobId.slice(0, 8)
      openWindow({
        id: randomUUID(),
        kind: "warren-job-detail",
        title: `Warren · ${jobName ?? titleId}`,
        x: 180 + Math.random() * 40,
        y: 100 + Math.random() * 40,
        width: 900,
        height: 660,
        payload: {
          kind: "warren-job-detail",
          jobId,
          jobName: jobName ?? null,
        } satisfies WarrenJobDetailPayload,
      })
    },
    [focus, openWindow, liveWindows],
  )

  const openQueryLens = useCallback((queryId?: string | null) => {
    const existing = liveWindows().find((w) => w.kind === "query-lens")
    if (existing) {
      if (queryId) {
        updatePayload(existing.id, (p) => ({ ...(p as QueryLensPayload), queryId }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "query-lens",
      title: "Query Lens",
      x: 120, y: 70, width: 1120, height: 720,
      payload: { kind: "query-lens", queryId: queryId ?? null } satisfies QueryLensPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openKgBrowser = useCallback((graphId?: string | null) => {
    const existing = liveWindows().find((w) => w.kind === "kg-browser")
    if (existing) {
      if (graphId) {
        updatePayload(existing.id, (p) => ({ ...(p as KgBrowserPayload), graphId }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "kg-browser",
      title: "Knowledge Graph",
      x: 130, y: 80, width: 1080, height: 700,
      payload: { kind: "kg-browser", graphId: graphId ?? null } satisfies KgBrowserPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openKgEntity = useCallback(
    (
      entityKind: string,
      entityLabel: string,
      graphId: string,
      source?: KgEntitySource,
      nodeId?: number | null,
    ) => {
      // Match an existing window for the same (nodeId) or (graphId, kind, label).
      const existing = liveWindows().find((w) => {
        if (w.kind !== "kg-entity-detail") return false
        const p = w.payload as KgEntityDetailPayload | undefined
        if (!p) return false
        if (nodeId != null && p.nodeId === nodeId) return true
        return (
          p.graphId === graphId &&
          p.entityKind === entityKind &&
          p.entityLabel === entityLabel
        )
      })
      if (existing) {
        // Update payload so a re-open with new info (nodeId resolved, fresher
        // breadcrumb) heals any stale state in the existing window.
        updatePayload(existing.id, (p) => {
          const prev = p as KgEntityDetailPayload
          return {
            ...prev,
            nodeId: nodeId ?? prev.nodeId ?? null,
            entityKind: entityKind || prev.entityKind,
            entityLabel: entityLabel || prev.entityLabel,
            graphId,
            source: source ?? prev.source,
          }
        })
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "kg-entity-detail",
        title: `KG · ${entityLabel || entityKind}`,
        x: 160 + Math.random() * 60,
        y: 90 + Math.random() * 50,
        width: 960, height: 660,
        payload: {
          kind: "kg-entity-detail",
          nodeId: nodeId ?? null,
          entityKind,
          entityLabel,
          graphId,
          source,
        } satisfies KgEntityDetailPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openKgExplorer = useCallback(
    (
      graphId?: string,
      seedKind?: string | null,
      seedLabel?: string | null,
    ) => {
      const existing = liveWindows().find((w) => w.kind === "kg-explorer")
      if (existing) {
        updatePayload(existing.id, (p) => ({
          ...(p as KgExplorerPayload),
          graphId: graphId ?? (p as KgExplorerPayload).graphId,
          seedKind: seedKind ?? (p as KgExplorerPayload).seedKind ?? null,
          seedLabel: seedLabel ?? (p as KgExplorerPayload).seedLabel ?? null,
        }))
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "kg-explorer",
        title: seedLabel ? `Explorer · ${seedLabel}` : "Graph Explorer",
        x: 140, y: 80, width: 1200, height: 760,
        payload: {
          kind: "kg-explorer",
          graphId,
          seedKind: seedKind ?? null,
          seedLabel: seedLabel ?? null,
          depth: 2,
          direction: "both",
          maxEdges: 80,
        } satisfies KgExplorerPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openDataSearch = useCallback(
    (initialQuery?: string) => {
      const existing = liveWindows().find((w) => w.kind === "data-search")
      if (existing) {
        if (initialQuery != null) {
          updatePayload(existing.id, (p) => ({
            ...(p as DataSearchPayload),
            initialQuery,
          }))
        }
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "data-search",
        title: "Data Search",
        x: 160, y: 90, width: 720, height: 640,
        payload: { kind: "data-search", initialQuery } satisfies DataSearchPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  // Spawn a FRESH results window per search — no dedupe — so searches accrete
  // instead of replacing each other. Cascade-offset placement keeps them from
  // stacking exactly on top of one another.
  const spawnScryResults = useCallback(
    (chain: { query: string }[], hits: DataSearchHit[]) => {
      const n = scrySpawnCountRef.current++
      const title = chain.map((c) => c.query).join("  ⤷  ") || "Scry"
      openWindow({
        id: randomUUID(),
        kind: "scry-results",
        title: title.length > 52 ? `${title.slice(0, 50)}…` : title,
        x: 200 + (n % 6) * 30,
        y: 120 + (n % 6) * 30,
        width: 460,
        height: 540,
        payload: { kind: "scry-results", chain, hits, connectionId: activeConnectionId } satisfies ScryResultsPayload,
      })
      setScryOpen(false)
    },
    [openWindow, activeConnectionId],
  )

  const openDrift = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "drift")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "drift",
      title: "Drift",
      x: 180, y: 100, width: 760, height: 660,
      payload: { kind: "drift" } satisfies DriftPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openModelStudio = useCallback((modelName?: string) => {
    const existing = liveWindows().find((w) => w.kind === "model-studio")
    if (existing) {
      if (modelName != null) {
        updatePayload(existing.id, (p) => ({ ...(p as ModelStudioPayload), modelName }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "model-studio",
      title: "Model Studio",
      x: 150, y: 80, width: 980, height: 680,
      payload: { kind: "model-studio", modelName } satisfies ModelStudioPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openMetricCatalog = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "metric-catalog")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "metric-catalog",
      title: "Metric Catalog",
      x: 140, y: 76, width: 860, height: 560,
      payload: { kind: "metric-catalog" } satisfies MetricCatalogPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openMetricCreator = useCallback((metricName?: string) => {
    const existing = liveWindows().find((w) => w.kind === "metric-creator")
    if (existing) {
      if (metricName != null) {
        updatePayload(existing.id, (p) => ({ ...(p as MetricCreatorPayload), metricName }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "metric-creator",
      title: "Metric Creator",
      x: 160, y: 84, width: 940, height: 660,
      payload: { kind: "metric-creator", metricName: metricName ?? null } satisfies MetricCreatorPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openMetricInspector = useCallback((metricName?: string) => {
    const existing = liveWindows().find((w) => w.kind === "metric-inspector")
    if (existing) {
      if (metricName != null) {
        updatePayload(existing.id, (p) => ({ ...(p as MetricInspectorPayload), metricName }))
      }
      return focus(existing.id)
    }
    openWindow({
      id: randomUUID(),
      kind: "metric-inspector",
      title: "Metric Inspector",
      x: 180, y: 92, width: 1000, height: 700,
      payload: { kind: "metric-inspector", metricName: metricName ?? null } satisfies MetricInspectorPayload,
    })
  }, [focus, openWindow, liveWindows, updatePayload])

  const openMetricBoard = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "metric-board")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "metric-board",
      title: "KPI Board",
      x: 160, y: 84, width: 1040, height: 660,
      payload: { kind: "metric-board" } satisfies MetricBoardPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openAlerts = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "alerts")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "alerts",
      title: "Alerts",
      x: 150, y: 78, width: 1080, height: 680,
      payload: { kind: "alerts" } satisfies AlertsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openKgExtractionRuns = useCallback(
    (graphId?: string | null, runId?: number | null) => {
      const existing = liveWindows().find((w) => w.kind === "kg-extraction-runs")
      if (existing) {
        if (graphId != null || runId != null) {
          updatePayload(existing.id, (p) => ({
            ...(p as KgExtractionRunsPayload),
            graphId: graphId ?? (p as KgExtractionRunsPayload).graphId ?? null,
            runId: runId ?? (p as KgExtractionRunsPayload).runId ?? null,
          }))
        }
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "kg-extraction-runs",
        title: "KG · Extraction Runs",
        x: 150, y: 95, width: 1080, height: 700,
        payload: {
          kind: "kg-extraction-runs",
          graphId: graphId ?? null,
          runId: runId ?? null,
        } satisfies KgExtractionRunsPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  const openKgMergeReview = useCallback(
    (graphId?: string | null, nodeKindFilter?: string) => {
      const existing = liveWindows().find((w) => w.kind === "kg-merge-review")
      if (existing) {
        updatePayload(existing.id, (p) => ({
          ...(p as KgMergeReviewPayload),
          graphId: graphId ?? (p as KgMergeReviewPayload).graphId ?? null,
          nodeKindFilter:
            nodeKindFilter ?? (p as KgMergeReviewPayload).nodeKindFilter,
        }))
        return focus(existing.id)
      }
      openWindow({
        id: randomUUID(),
        kind: "kg-merge-review",
        title: "KG · Merge Review",
        x: 170, y: 100, width: 1000, height: 660,
        payload: {
          kind: "kg-merge-review",
          graphId: graphId ?? null,
          nodeKindFilter,
        } satisfies KgMergeReviewPayload,
      })
    },
    [focus, openWindow, liveWindows, updatePayload],
  )

  /**
   * Open the source row referenced by a kg_evidence row. Phase 2's
   * forward bridge — "where did this fact come from?" in one click.
   * Looks up the table's PK column, then opens a Data window filtered
   * to that row. The `sourceContext` is preserved on the payload so
   * the new window's header can round-trip back to the KG.
   */
  const openSourceRow = useCallback(
    async (ctx: KgSourceContext) => {
      if (!activeConnectionId) return
      const { schema, name } = parseRegclassText(ctx.sourceTable)
      const pkCol = await fetchPrimaryKeyColumn(activeConnectionId, ctx.sourceTable)
      const tableRef = schema
        ? `${quoteSqlIdent(schema)}.${quoteSqlIdent(name)}`
        : quoteSqlIdent(name)
      const sql = pkCol
        ? `SELECT *\nFROM ${tableRef}\nWHERE ${quoteSqlIdent(pkCol)} = ${sqlLit(ctx.sourcePk)};`
        : `SELECT *\nFROM ${tableRef}\nLIMIT 200;`
      const title = pkCol ? `${name}#${ctx.sourcePk}` : name

      // Refocus an existing data window for the same source row.
      const existing = liveWindows().find(
        (w) =>
          w.kind === "data" &&
          (w.payload as DataPayload | undefined)?.sourceContext?.sourceTable === ctx.sourceTable &&
          (w.payload as DataPayload | undefined)?.sourceContext?.sourcePk === ctx.sourcePk,
      )
      if (existing) return focus(existing.id)

      openWindow({
        id: randomUUID(),
        kind: "data",
        title,
        x: 180 + Math.random() * 60,
        y: 110 + Math.random() * 60,
        width: 820,
        height: 520,
        payload: {
          kind: "data",
          title,
          sql,
          origin: "derived",
          table: schema ? { schema, name } : undefined,
          view: { activeTab: "rows", sqlRailOpen: false, sqlRailWidthPx: 360 },
          sourceContext: ctx,
        } satisfies DataPayload,
      })
    },
    [activeConnectionId, focus, openWindow, liveWindows],
  )

  /**
   * Reverse provenance bridge — given a (source_table, source_pk),
   * find the KG node(s) that have evidence tying back. Opens the
   * single matching entity directly; falls back to the Browser when
   * there are zero or many matches.
   */
  const openKgForSource = useCallback(
    async (ctx: KgSourceContext) => {
      if (!activeConnectionId) return
      const r = await fetchKgEvidenceBySource(
        activeConnectionId,
        ctx.sourceTable,
        ctx.sourcePk,
      )
      if (r.nodes.length === 1) {
        const n = r.nodes[0]
        openKgEntity(
          n.kind,
          n.label,
          n.graphId,
          { kind: "browser", graphId: n.graphId, label: `KG · ${ctx.sourceTable}#${ctx.sourcePk}` },
          n.nodeId,
        )
        return
      }
      // For 0 or many — drop into the browser. (Phase 2.5 will add a
      // proper filtered evidence view; for now the user sees the graph
      // they belong to and can search.)
      const graphId = r.nodes[0]?.graphId
      openKgBrowser(graphId)
    },
    [activeConnectionId, openKgEntity, openKgBrowser],
  )

  const openMcpServerDetail = useCallback((serverName: string) => {
    const existing = liveWindows().find(
      (w) =>
        w.kind === "mcp-server-detail" &&
        (w.payload as McpServerDetailPayload | undefined)?.serverName === serverName,
    )
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "mcp-server-detail",
      title: `MCP · ${serverName}`,
      x: 140 + Math.random() * 70,
      y: 80 + Math.random() * 50,
      width: 1020, height: 700,
      payload: { kind: "mcp-server-detail", serverName } satisfies McpServerDetailPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openSpecialistDetail = useCallback((specialistName: string) => {
    const existing = liveWindows().find(
      (w) =>
        w.kind === "specialist-detail" &&
        (w.payload as SpecialistDetailPayload | undefined)?.specialistName === specialistName,
    )
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "specialist-detail",
      title: `Specialist · ${specialistName}`,
      x: 130 + Math.random() * 80,
      y: 70 + Math.random() * 50,
      width: 1000,
      height: 668,
      payload: { kind: "specialist-detail", specialistName } satisfies SpecialistDetailPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openNotifications = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "notifications")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "notifications",
      title: "Notification Center",
      x: 220, y: 120, width: 560, height: 520,
      payload: { kind: "notifications" } satisfies NotificationsPayload,
    })
  }, [focus, openWindow, liveWindows])

  const openPalette = useCallback(() => {
    const existing = liveWindows().find((w) => w.kind === "palette")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "palette",
      title: "Palette",
      x: 180, y: 130, width: 620, height: 480,
      payload: { kind: "palette" } satisfies PalettePayload,
    })
  }, [focus, openWindow, liveWindows])

  const onReExtractPalette = useCallback(async () => {
    if (!wallpaperUrl) return
    try {
      const palette = await vibrantExtractor.extract(wallpaperUrl)
      setActivePalette(palette)
      // Don't drop overrides — the user expects re-extract to update
      // un-locked slots only. The shared deriveTheme step merges them
      // when applying.
    } catch (err) {
      setWallpaperError(err instanceof Error ? err.message : "Re-extract failed.")
    }
  }, [wallpaperUrl])

  const onReExtractWithRvbbit = useCallback(async () => {
    if (!activeConnectionId) {
      setWallpaperError("Open a connection first to use AI palette curation.")
      return
    }
    if (!wallpaperUrl) return
    try {
      // Re-fetch the blob from IDB (the object URL has it but blob() is
      // simpler than reverse-engineering the URL).
      const record = await loadDesktopWallpaperRecord()
      if (!record) {
        setWallpaperError("No wallpaper found.")
        return
      }
      const palette = await extractPaletteWithRvbbitVision(activeConnectionId, record.blob)
      setActivePalette(palette)
    } catch (err) {
      setWallpaperError(err instanceof Error ? err.message : "AI re-curate failed.")
    }
  }, [activeConnectionId, wallpaperUrl])

  const openArtifact = useCallback((artifactId: string) => {
    openWindow({
      id: randomUUID(),
      kind: "artifact",
      title: "Chart",
      x: 200 + Math.random() * 50,
      y: 120 + Math.random() * 50,
      width: 720,
      height: 520,
      payload: { kind: "artifact", artifactId } satisfies ArtifactPayload,
    })
  }, [openWindow])

  const openQueryDocument = useCallback((payload: QueryDocumentPayload) => {
    openWindow({
      id: randomUUID(),
      kind: "query-document",
      title: payload.query.title || "Query",
      x: 240 + Math.random() * 50,
      y: 140 + Math.random() * 50,
      width: 720,
      height: 480,
      payload,
    })
  }, [openWindow])

  // Open arbitrary SQL as a live, auto-running data window (editor + ResultGrid).
  // `origin: "derived"` makes the grid run on open — used by the KPI board drill
  // to materialize the exact reproducible query behind a historical cell.
  const openSqlData = useCallback((sql: string, title: string) => {
    openWindow({
      id: randomUUID(),
      kind: "data",
      title,
      x: 200 + Math.random() * 60,
      y: 120 + Math.random() * 60,
      width: 760,
      height: 520,
      payload: {
        kind: "data",
        title,
        sql,
        origin: "derived",
        view: { activeTab: "rows", sqlRailOpen: true, sqlRailWidthPx: 360 },
      } satisfies DataPayload,
    })
  }, [openWindow])

  // ── Canvas drag-drop ───────────────────────────────────────────────

  const screenToWorld = useCallback((screen: { x: number; y: number }) => ({
    x: (screen.x - viewport.x) / viewport.scale,
    y: (screen.y - viewport.y) / viewport.scale,
  }), [viewport.x, viewport.y, viewport.scale])

  // ── CSV file drop → importer ──────────────────────────────────────
  // Native OS file drops are distinct from the internal column/block
  // HTML5 drags (which carry custom MIME types); we branch on the "Files"
  // type so the two never collide. `fileDragDepth` is the canonical
  // enter/leave counter that keeps the drop overlay stable while the
  // cursor moves across child elements.
  const [fileDragActive, setFileDragActive] = useState(false)
  const [dropNotice, setDropNotice] = useState<string | null>(null)
  const fileDragDepth = useRef(0)

  useEffect(() => {
    if (!dropNotice) return
    const t = setTimeout(() => setDropNotice(null), 4000)
    return () => clearTimeout(t)
  }, [dropNotice])

  const openCsvImport = useCallback(
    (file: File, pos?: { x: number; y: number }) => {
      const id = randomUUID()
      putImportFile(id, file)
      const n = liveWindows().filter((w) => w.kind === "csv-import").length
      const defaultSchema = schema?.schemas?.includes("public")
        ? "public"
        : schema?.schemas?.[0]
      openWindow({
        id,
        kind: "csv-import",
        title: file.name.length > 40 ? `${file.name.slice(0, 38)}…` : file.name,
        x: pos ? pos.x : 180 + (n % 6) * 28,
        y: pos ? pos.y : 110 + (n % 6) * 28,
        width: 720,
        height: 560,
        payload: {
          kind: "csv-import",
          fileName: file.name,
          fileSize: file.size,
          lastModified: file.lastModified,
          defaultSchema,
        } satisfies CsvImportPayload,
      })
    },
    [openWindow, schema, liveWindows],
  )

  const handleFilesDropped = useCallback(
    (fileList: FileList, pos: { x: number; y: number }) => {
      const files = Array.from(fileList).filter(isCsvLikeFile)
      if (files.length === 0) {
        setDropNotice("Drop a .csv, .tsv, or .txt file to import it.")
        return
      }
      files.forEach((file, i) => {
        openCsvImport(file, { x: pos.x + i * 28, y: pos.y + i * 28 })
      })
    },
    [openCsvImport],
  )

  const openColumnAggregate = useCallback((payload: DesktopColumnDragPayload, at: { x: number; y: number }) => {
    const rollup = rollupSpecFromColumns(payload.columns)
    const { sql, title } = buildRollupQuery(rollup, {
      parentBlockName: payload.parentBlockName,
      parentTitle: payload.parentTitle,
    })
    openWindow({
      id: randomUUID(),
      kind: "data",
      title,
      x: clampWorld(at.x),
      y: clampWorld(at.y),
      width: 720,
      height: 480,
      payload: {
        kind: "data",
        title,
        sql,
        origin: "derived",
        view: { activeTab: "rows", sqlRailOpen: false, sqlRailWidthPx: 360 },
        lineage: {
          kind: "column-aggregate",
          parentWindowId: payload.parentWindowId,
          parentTitle: payload.parentTitle,
          parentSql: payload.parentSql,
          relationKey: payload.relationKey,
          parentBlockName: payload.parentBlockName,
          columns: rollupSpecColumns(rollup),
          rollup,
        },
      } satisfies DataPayload,
    })
  }, [openWindow])

  // Drop a scalar semantic op on a column → spawn a row-level projection block
  // `SELECT col, rvbbit.<op>(col::text) AS … FROM {source} LIMIT 200`, placed
  // beside the source window. The window opens on the Explain tab and does NOT
  // auto-run (the projection is a per-row LLM op) — the live EXPLAIN (SEMANTIC)
  // shows the cost estimate; the user runs it explicitly to materialize.
  const spawnSemanticProjection = useCallback(
    (payload: DesktopColumnDragPayload, op: SemanticOpMeta, args?: SemanticArg[]) => {
      const column = payload.columns[0]
      if (!column) return
      const spec = projectionSpecFromOp(column, op.name, op.returnType, args)
      const { sql, title } = buildRollupQuery(spec, {
        parentBlockName: payload.parentBlockName,
        parentTitle: payload.parentTitle,
      })
      const src = liveWindows().find((w) => w.id === payload.parentWindowId)
      const x = clampWorld(src ? src.x + src.width + 24 : 220)
      const y = clampWorld(src ? src.y : 140)
      openWindow({
        id: randomUUID(),
        kind: "data",
        title,
        x,
        y,
        width: 560,
        height: 420,
        payload: {
          kind: "data",
          title,
          sql,
          origin: "derived",
          view: { activeTab: "explain", sqlRailOpen: false, sqlRailWidthPx: 360 },
          lineage: {
            kind: "column-aggregate",
            parentWindowId: payload.parentWindowId,
            parentTitle: payload.parentTitle,
            parentSql: payload.parentSql,
            relationKey: payload.relationKey,
            parentBlockName: payload.parentBlockName,
            columns: [column],
            rollup: spec,
          },
        } satisfies DataPayload,
      })
    },
    [openWindow, liveWindows],
  )

  // Drop a DIMENSION op on a text column → spawn a frequency table: fan the
  // column out through the op and GROUP BY the label. Origin "query" so it does
  // NOT auto-run (per-row LLM) — opens on the SQL tab for the user to run.
  const spawnDimensionRollup = useCallback(
    (payload: DesktopColumnDragPayload, op: SemanticOpMeta, _at: { x: number; y: number }) => {
      const column = payload.columns[0]
      if (!column) return
      const { sql, title } = buildDimensionRollup(op.name, column, {
        parentBlockName: payload.parentBlockName,
        parentTitle: payload.parentTitle,
      })
      const src = liveWindows().find((w) => w.id === payload.parentWindowId)
      const x = clampWorld(src ? src.x + src.width + 24 : 240)
      const y = clampWorld(src ? src.y + 56 : 180)
      openWindow({
        id: randomUUID(),
        kind: "data",
        title,
        x,
        y,
        width: 460,
        height: 480,
        payload: {
          kind: "data",
          title,
          sql,
          origin: "query", // not "derived" → mount effect won't auto-run it
          // Open on Explain for a projected calls/cost preview (plan-only, no
          // LLM) — parity with scalar drops; the real query never auto-runs.
          view: { activeTab: "explain", sqlRailOpen: false, sqlRailWidthPx: 360 },
          lineage: {
            kind: "block-ref",
            parentWindowId: payload.parentWindowId,
            parentTitle: payload.parentTitle,
            parentSql: "",
            relationKey: payload.parentBlockName,
          },
        } satisfies DataPayload,
      })
    },
    [openWindow, liveWindows],
  )

  // Pivot a dragged dimension across columns. Needs the dimension's
  // distinct values (a query round-trip), so this is async: probe the
  // values via a synthetic block that references the parent, then fold a
  // `pivot` term into the spec and rebuild. The `payload.sql` change is
  // what re-runs the window (same mechanism as the sync merge).
  const pivotColumnInWindow = useCallback(async (
    targetWindowId: string,
    payload: DesktopColumnDragPayload,
    measureIds?: string[],
    grain?: RollupGrain,
  ) => {
    const PIVOT_VALUE_CAP = 24
    const connectionId = activeConnectionIdRef.current
    if (!connectionId) return
    const canvas = workspacesRef.current[activeWorkspaceRef.current]
    const wins = canvas?.windows ?? []
    const params = canvas?.params ?? []

    const target = wins.find((w) => w.id === targetWindowId)
    if (!target || target.kind !== "data") return
    const lin = (target.payload as DataPayload | undefined)?.lineage
    if (!lin || lin.kind !== "column-aggregate") return
    if (lin.parentWindowId !== payload.parentWindowId) return
    if (lin.relationKey !== payload.relationKey) return

    const pivotCol = payload.columns[0]
    if (!pivotCol) return
    const parentBlockName = lin.parentBlockName ?? payload.parentBlockName

    // Compile a DISTINCT probe by injecting a throwaway block that
    // references the parent; the graph expands `{parentBlockName}` to the
    // parent's compiled (cascaded) SQL.
    const probeId = `__pivot_probe_${targetWindowId}`
    const col = quoteSqlIdent(pivotCol.name)
    const valueExpr = grain ? grainTruncExpr(col, grain) : col
    const probeSql = [
      `SELECT DISTINCT ${valueExpr} AS pivot_value`,
      `FROM {${parentBlockName}}`,
      `WHERE ${col} IS NOT NULL`,
      `ORDER BY 1`,
      `LIMIT ${PIVOT_VALUE_CAP + 1}`,
    ].join("\n")
    const synthetic: DesktopWindowState = {
      id: probeId,
      kind: "data",
      title: "pivot probe",
      x: 0, y: 0, width: 1, height: 1, zIndex: 0, minimized: true,
      payload: {
        kind: "data",
        title: "pivot probe",
        sql: probeSql,
        reactive: {
          blockName: uniqueBlockName("pivot_probe", wins),
          sourceSql: probeSql,
          paramSubscriptions: [],
          version: 1,
        },
      } satisfies DataPayload,
    }
    const graph = buildDesktopRuntimeGraph([...wins, synthetic], params)
    const compiled = graph.blocks.get(probeId)?.compiledSql ?? probeSql

    let values: (string | number | null)[] = []
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, sql: compiled, rowLimit: PIVOT_VALUE_CAP + 1, readOnly: true }),
      })
      const body = (await res.json()) as { ok?: boolean; rows?: Record<string, unknown>[] }
      if (!body.ok || !Array.isArray(body.rows)) return
      values = body.rows.map((r) => (r.pivot_value ?? null) as string | number | null)
    } catch {
      return
    }
    const truncated = values.length > PIVOT_VALUE_CAP
    values = values.slice(0, PIVOT_VALUE_CAP)
    if (values.length === 0) return

    setWindows((ws) => ws.map((w) => {
      if (w.id !== targetWindowId || w.kind !== "data") return w
      const p = w.payload as DataPayload | undefined
      const linNow = p?.lineage
      if (!p || !linNow || linNow.kind !== "column-aggregate") return w

      const baseSpec = effectiveRollup(linNow)
      if (!baseSpec) return w
      const nextSpec: RollupSpec = {
        ...baseSpec,
        // The pivot column moves out of the rows (GROUP BY) into headers.
        groupBy: baseSpec.groupBy.filter((d) => d.column.name.toLowerCase() !== pivotCol.name.toLowerCase()),
        pivot: { column: pivotCol, grain, values, measureIds, truncated },
      }
      const blockName = linNow.parentBlockName ?? payload.parentBlockName
      const { sql, title } = buildRollupQuery(nextSpec, { parentBlockName: blockName, parentTitle: linNow.parentTitle })
      const nextReactive = p.reactive
        ? { ...p.reactive, sourceSql: sql, version: (p.reactive.version ?? 1) + 1 }
        : undefined
      return {
        ...w,
        title,
        payload: {
          ...p,
          title,
          sql,
          view: p.view ? { ...p.view, sqlDraft: undefined } : p.view,
          lineage: { ...linNow, parentBlockName: blockName, columns: rollupSpecColumns(nextSpec), rollup: nextSpec },
          reactive: nextReactive,
        } satisfies DataPayload,
      }
    }))
  }, [])

  // Drop a column onto an existing column-aggregate window via a chosen
  // operation tile: fold it into the rollup spec, regenerate SQL/title.
  // The target window's `payload.sql` change is what re-runs the query —
  // its data-grid-window has an effect that adopts external SQL updates
  // and triggers a fresh run, so we don't need to bump the run signal
  // here (doing both would race two runSql() calls).
  const mergeColumnIntoWindow = useCallback((targetWindowId: string, payload: DesktopColumnDragPayload, op: RollupOp) => {
    // Pivot needs the dragged dimension's distinct values, which requires
    // a query round-trip — handled on a separate async path.
    if (op.kind === "pivot") {
      void pivotColumnInWindow(targetWindowId, payload, op.measureIds, op.grain)
      return
    }
    setWindows((ws) => ws.map((w) => {
      if (w.id !== targetWindowId || w.kind !== "data") return w
      const p = w.payload as DataPayload | undefined
      const lin = p?.lineage
      if (!p || !lin || lin.kind !== "column-aggregate") return w
      // Re-verify compatibility at drop time (the overlay should have
      // gated this, but defense-in-depth).
      if (lin.parentWindowId !== payload.parentWindowId) return w
      if (lin.relationKey !== payload.relationKey) return w

      // The rollup spec is the source of truth (legacy windows derive one
      // from their flat columns); a detached/custom-SQL window yields null.
      const baseSpec = effectiveRollup(lin)
      if (!baseSpec) return w

      // A scalar semantic op is a row-level projection — a different grain than
      // a GROUP BY. Dropping one MUTATES this block into a projection over its
      // source (keeping any prior semantic columns, dropping aggregation), and
      // flips it to the Explain tab so the per-row LLM cost shows without
      // auto-running. Vanilla ops fold into the spec as before.
      const semantic = op.kind === "semantic-op"
      const startSpec: RollupSpec = semantic
        ? { groupBy: [], measures: [], projections: baseSpec.projections }
        : baseSpec
      const { spec: nextSpec, changed } = applyRollupOp(startSpec, payload.columns, op)
      if (!changed) return w

      // Prefer the lineage's parentBlockName; fall back to the drag
      // payload (covers older windows that pre-date the field).
      const parentBlockName = lin.parentBlockName ?? payload.parentBlockName
      const { sql, title } = buildRollupQuery(nextSpec, {
        parentBlockName,
        parentTitle: lin.parentTitle,
      })

      const nextReactive = p.reactive
        ? {
            ...p.reactive,
            sourceSql: sql,
            version: (p.reactive.version ?? 1) + 1,
          }
        : undefined
      return {
        ...w,
        title,
        payload: {
          ...p,
          title,
          sql,
          // Clear any user SQL edits in the editor draft so the rail
          // doesn't show stale text after a merge; semantic ops also open the
          // Explain tab (the data-grid effect re-confirms this on the sql change).
          view: {
            ...(p.view ?? {}),
            sqlDraft: undefined,
            ...(semantic ? { activeTab: "explain" as const } : {}),
          },
          lineage: { ...lin, parentBlockName, columns: rollupSpecColumns(nextSpec), rollup: nextSpec },
          reactive: nextReactive,
        } satisfies DataPayload,
      }
    }))
  }, [pivotColumnInWindow])

  // A semantic op was dropped on a column. 1-arg ops apply immediately; ops
  // with extra (text) args open the drop-site bind popover first. A drop on a
  // target window mutates that block in place; a drop with no target (the
  // palette) spawns a new projection block.
  const applySemanticDrop = useCallback(
    (payload: DesktopColumnDragPayload, op: SemanticOpMeta, args: SemanticArg[] | undefined, targetWindowId?: string) => {
      if (targetWindowId) {
        mergeColumnIntoWindow(targetWindowId, payload, { kind: "semantic-op", operator: op, args })
      } else {
        spawnSemanticProjection(payload, op, args)
      }
    },
    [mergeColumnIntoWindow, spawnSemanticProjection],
  )

  const requestSemanticDrop = useCallback(
    (payload: DesktopColumnDragPayload, op: SemanticOpMeta, at: { x: number; y: number }, targetWindowId?: string) => {
      // Dimension ops fan out → always spawn a frequency table (never an
      // in-place projection merge), and they're single-arg so no bind step.
      if (op.shape === "dimension") {
        spawnDimensionRollup(payload, op, at)
        return
      }
      if (op.argNames.length > 1) {
        setPendingBind({ payload, op, at, targetWindowId })
      } else {
        applySemanticDrop(payload, op, undefined, targetWindowId)
      }
    },
    [applySemanticDrop, spawnDimensionRollup],
  )

  const completeSemanticBind = useCallback(
    (args: SemanticArg[]) => {
      if (!pendingBind) return
      applySemanticDrop(pendingBind.payload, pendingBind.op, args, pendingBind.targetWindowId)
      setPendingBind(null)
    },
    [pendingBind, applySemanticDrop],
  )

  // Spawn a new pipelined block from a rowset-op drop: SELECT * FROM {block}
  // then op('<prompt>'). Non-destructive (a derived block), and NOT auto-run —
  // it opens on the SQL tab so the user reviews/runs it (rowset stages make LLM
  // calls). The data grid's run path detects the top-level THEN and wraps it as
  // rvbbit.flow($$…$$).
  const spawnRowsetStage = useCallback(
    (payload: DesktopBlockDragPayload, op: SemanticOpMeta, prompt: string, at: { x: number; y: number }) => {
      const safe = prompt.replace(/'/g, "''") // single-quote escape for the SQL literal
      const title = `${payload.title} → ${op.name}`
      const sql = `SELECT *\nFROM {${payload.blockName}}\nthen ${op.name}('${safe}')`
      openWindow({
        id: randomUUID(),
        kind: "data",
        title,
        x: clampWorld(at.x),
        y: clampWorld(at.y),
        width: 760,
        height: 520,
        payload: {
          kind: "data",
          title,
          sql,
          origin: "derived",
          // Explain-first: preview the pipeline's calls/cost before running it.
          view: { activeTab: "explain", sqlRailOpen: false, sqlRailWidthPx: 380 },
          lineage: {
            kind: "block-ref",
            parentWindowId: payload.windowId,
            parentTitle: payload.title,
            parentSql: "",
            relationKey: payload.blockName,
          },
        } satisfies DataPayload,
      })
    },
    [openWindow],
  )

  // Chain a `then op('<prompt>')` stage onto a window's OWN block, in place —
  // appending even if the block already ends in a THEN. Switches to the SQL tab
  // and does NOT auto-run (the data grid skips auto-run for pipelines).
  const chainRowsetInPlace = useCallback(
    (windowId: string, op: SemanticOpMeta, prompt: string) => {
      const safe = prompt.replace(/'/g, "''")
      setWindows((ws) => ws.map((win) => {
        if (win.id !== windowId || win.kind !== "data") return win
        const p = win.payload as DataPayload
        const base = (p.sql ?? "").trim().replace(/;\s*$/, "")
        if (!base) return win
        const sql = `${base}\nthen ${op.name}('${safe}')`
        return {
          ...win,
          payload: {
            ...p,
            sql,
            view: { ...(p.view ?? {}), activeTab: "explain", sqlRailOpen: false, sqlDraft: undefined },
          } satisfies DataPayload,
        }
      }))
    },
    [setWindows],
  )

  const requestRowsetStage = useCallback(
    (payload: DesktopBlockDragPayload, op: SemanticOpMeta, at: { x: number; y: number }, inPlace?: boolean) => {
      setPendingRowset({ payload, op, at, inPlace })
    },
    [],
  )

  const completeRowsetStage = useCallback(
    (prompt: string) => {
      if (!pendingRowset) return
      if (pendingRowset.inPlace) {
        chainRowsetInPlace(pendingRowset.payload.windowId, pendingRowset.op, prompt)
      } else {
        spawnRowsetStage(pendingRowset.payload, pendingRowset.op, prompt, pendingRowset.at)
      }
      setPendingRowset(null)
    },
    [pendingRowset, spawnRowsetStage, chainRowsetInPlace],
  )

  // Apply a pure transform to a column-aggregate window's rollup spec
  // (rollup-shelf edits: remove a pill, cycle an aggregate, clear pivot).
  // Shares the merge handler's rebuild path so SQL/title/chrome stay in
  // sync and the window re-runs off the `payload.sql` change.
  const editRollupSpec = useCallback((targetWindowId: string, transform: (s: RollupSpec) => RollupSpec) => {
    setWindows((ws) => ws.map((w) => {
      if (w.id !== targetWindowId || w.kind !== "data") return w
      const p = w.payload as DataPayload | undefined
      const lin = p?.lineage
      if (!p || !lin || lin.kind !== "column-aggregate") return w
      const baseSpec = effectiveRollup(lin)
      if (!baseSpec) return w
      const nextSpec = transform(baseSpec)
      const parentBlockName = lin.parentBlockName ?? ""
      if (!parentBlockName) return w
      const { sql, title } = buildRollupQuery(nextSpec, { parentBlockName, parentTitle: lin.parentTitle })
      const nextReactive = p.reactive
        ? { ...p.reactive, sourceSql: sql, version: (p.reactive.version ?? 1) + 1 }
        : undefined
      return {
        ...w,
        title,
        payload: {
          ...p,
          title,
          sql,
          view: p.view ? { ...p.view, sqlDraft: undefined } : p.view,
          lineage: { ...lin, parentBlockName, columns: rollupSpecColumns(nextSpec), rollup: nextSpec },
          reactive: nextReactive,
        } satisfies DataPayload,
      }
    }))
  }, [])

  // Re-pivot an existing pivot with a new temporal grain — re-probes the
  // distinct values via the same async path, reusing the stored pivot
  // column and measure scope.
  const repivotWindow = useCallback((targetWindowId: string, grain: RollupGrain) => {
    const canvas = workspacesRef.current[activeWorkspaceRef.current]
    const target = canvas?.windows.find((w) => w.id === targetWindowId)
    if (!target || target.kind !== "data") return
    const lin = (target.payload as DataPayload | undefined)?.lineage
    if (!lin || lin.kind !== "column-aggregate") return
    const piv = effectiveRollup(lin)?.pivot
    if (!piv) return
    const synthPayload: DesktopColumnDragPayload = {
      kind: "rvbbit-lens.desktop.column",
      parentWindowId: lin.parentWindowId,
      parentBlockName: lin.parentBlockName ?? "",
      parentTitle: lin.parentTitle,
      parentSql: lin.parentSql,
      relationKey: lin.relationKey,
      columns: [piv.column],
    }
    void pivotColumnInWindow(targetWindowId, synthPayload, piv.measureIds, grain)
  }, [pivotColumnInWindow])

  // Probe the distinct values of a source column (for the WHERE filter
  // multi-select), ordered by frequency, optionally narrowed by a search
  // substring. Same parent-probe mechanism as the pivot resolver.
  const probeColumnValues = useCallback(async (
    targetWindowId: string,
    column: DesktopColumnRef,
    search?: string,
  ): Promise<{ values: (string | number | null)[]; truncated: boolean }> => {
    const empty = { values: [] as (string | number | null)[], truncated: false }
    const connectionId = activeConnectionIdRef.current
    if (!connectionId) return empty
    const canvas = workspacesRef.current[activeWorkspaceRef.current]
    const wins = canvas?.windows ?? []
    const params = canvas?.params ?? []
    const target = wins.find((w) => w.id === targetWindowId)
    if (!target || target.kind !== "data") return empty
    const lin = (target.payload as DataPayload | undefined)?.lineage
    if (!lin || lin.kind !== "column-aggregate") return empty
    const parentBlockName = lin.parentBlockName
    if (!parentBlockName) return empty

    const CAP = 200
    const col = quoteSqlIdent(column.name)
    const where = [`${col} IS NOT NULL`]
    const term = (search ?? "").trim()
    if (term) {
      // Escape LIKE wildcards then the SQL literal; `%term%` contains-match.
      const esc = term.replace(/([\\%_])/g, "\\$1").replace(/'/g, "''")
      where.push(`${col}::text ILIKE '%${esc}%'`)
    }
    const probeId = `__val_probe_${targetWindowId}`
    const probeSql = [
      `SELECT ${col} AS v, count(1) AS c`,
      `FROM {${parentBlockName}}`,
      `WHERE ${where.join(" AND ")}`,
      `GROUP BY ${col}`,
      `ORDER BY c DESC`,
      `LIMIT ${CAP + 1}`,
    ].join("\n")
    const synthetic: DesktopWindowState = {
      id: probeId,
      kind: "data",
      title: "value probe",
      x: 0, y: 0, width: 1, height: 1, zIndex: 0, minimized: true,
      payload: {
        kind: "data",
        title: "value probe",
        sql: probeSql,
        reactive: {
          blockName: uniqueBlockName("val_probe", wins),
          sourceSql: probeSql,
          paramSubscriptions: [],
          version: 1,
        },
      } satisfies DataPayload,
    }
    const graph = buildDesktopRuntimeGraph([...wins, synthetic], params)
    const compiled = graph.blocks.get(probeId)?.compiledSql ?? probeSql
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, sql: compiled, rowLimit: CAP + 1, readOnly: true }),
      })
      const body = (await res.json()) as { ok?: boolean; rows?: Record<string, unknown>[] }
      if (!body.ok || !Array.isArray(body.rows)) return empty
      const all = body.rows.map((r) => (r.v ?? null) as string | number | null)
      return { values: all.slice(0, CAP), truncated: all.length > CAP }
    } catch {
      return empty
    }
  }, [])

  const openBlockReference = useCallback((payload: DesktopBlockDragPayload, at: { x: number; y: number }) => {
    const title = `${payload.title} → ref`
    const sql = `SELECT *\nFROM {${payload.blockName}}\nLIMIT 200;`
    openWindow({
      id: randomUUID(),
      kind: "data",
      title,
      x: clampWorld(at.x),
      y: clampWorld(at.y),
      width: 720,
      height: 480,
      payload: {
        kind: "data",
        title,
        sql,
        origin: "derived",
        view: { activeTab: "sql", sqlRailOpen: true, sqlRailWidthPx: 360 },
        lineage: {
          kind: "block-ref",
          parentWindowId: payload.windowId,
          parentTitle: payload.title,
          parentSql: "",
          relationKey: payload.blockName,
        },
      } satisfies DataPayload,
    })
  }, [openWindow])

  const handleCanvasDragEnter = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!hasFileDragPayload(e.dataTransfer)) return
    fileDragDepth.current += 1
    setFileDragActive(true)
  }, [])

  const handleCanvasDragLeave = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!hasFileDragPayload(e.dataTransfer)) return
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1)
    if (fileDragDepth.current === 0) setFileDragActive(false)
  }, [])

  const handleCanvasDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    // Native file drag → accept (the importer). Checked first so it can't be
    // shadowed by the internal-payload veto below.
    if (hasFileDragPayload(e.dataTransfer)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
      return
    }
    if (!hasColumnDragPayload(e.dataTransfer) && !hasBlockDragPayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }, [])

  const handleCanvasDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    const pos = screenToWorld({ x: e.clientX, y: e.clientY })
    if (hasFileDragPayload(e.dataTransfer)) {
      e.preventDefault()
      fileDragDepth.current = 0
      setFileDragActive(false)
      handleFilesDropped(e.dataTransfer.files, pos)
      return
    }
    const col = readColumnDragPayload(e.dataTransfer)
    if (col) {
      e.preventDefault()
      openColumnAggregate(col, pos)
      return
    }
    const blk = readBlockDragPayload(e.dataTransfer)
    if (blk) {
      e.preventDefault()
      openBlockReference(blk, pos)
    }
  }, [openBlockReference, openColumnAggregate, screenToWorld, handleFilesDropped])

  // ── Keyboard shortcuts ─────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey
      const isEditable = (() => {
        const t = e.target as HTMLElement | null
        if (!t) return false
        if (t.isContentEditable) return true
        const tag = t.tagName
        return tag === "INPUT" || tag === "TEXTAREA"
      })()

      // Undo / Redo. We skip when an editable target has focus so the
      // editor (CodeMirror, native inputs) handles its own per-character
      // history.
      if (cmd && !isEditable) {
        if ((e.key === "z" || e.key === "Z") && !e.shiftKey) {
          e.preventDefault()
          undo()
          return
        }
        if (((e.key === "z" || e.key === "Z") && e.shiftKey) || e.key === "y") {
          e.preventDefault()
          redo()
          return
        }
      }

      // ⌘K / Ctrl-K toggles Scry (the cascade search canvas). Intentionally
      // fires even inside inputs so it can also close Scry from the HUD field.
      if (cmd && e.key === "k") {
        e.preventDefault()
        setScryOpen((o) => !o)
        return
      }
      if (cmd && e.key === "n") {
        e.preventDefault()
        openSqlScratch()
        return
      }
      if (cmd && e.key === "f") {
        // Don't override browser find inside inputs; only when nothing is focused.
        if (isEditable) return
        e.preventDefault()
        openFinder()
        return
      }

      // Alt+1..5 — jump to a scratch workspace; Alt+6 — the Scene slot.
      // Alt+digit rarely collides with browser chrome (unlike Ctrl/Cmd+digit
      // which switches tabs), which is why Scene save is menu-only, not Cmd+S.
      if (e.altKey && !cmd && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        switchWorkspace(e.key === "6" ? SCENE_SLOT : (e.key as WorkspaceId))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [openFinder, openSqlScratch, undo, redo, switchWorkspace])

  // ── Render ──────────────────────────────────────────────────────────

  const onSchemaChanged = useCallback(() => {
    if (activeConnectionId) void loadSchema(activeConnectionId)
  }, [activeConnectionId, loadSchema])

  // Clicks on truly-empty desktop area (no window, no icon, no menu) clear
  // the focused window. We detect this by checking whether the mousedown
  // target was the desktop root itself — every descendant either catches
  // its own clicks (windows, icons, buttons) or sits inside a
  // pointer-events-none wrapper, so untouched clicks fall through to the
  // root.
  const handleDesktopMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) blurAll()
  }, [blurAll])

  const handleDesktopContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Right-clicks inside a window keep the native menu (copy/paste in editors);
      // window-part context menus are future work, keyed off the same data attr.
      if ((e.target as HTMLElement).closest("[data-rvbbit-window]")) return
      e.preventDefault()
      const world = screenToWorld({ x: e.clientX, y: e.clientY })
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            id: "new-sql",
            label: "New SQL Block",
            icon: FileCode2,
            onSelect: () => openSqlScratchAtPos(world.x, world.y),
          },
          {
            id: "finder",
            label: "Open Finder",
            icon: FolderOpen,
            onSelect: openFinder,
          },
          {
            id: "scry",
            label: "Open Scry",
            icon: Eye,
            onSelect: () => setScryOpen(true),
          },
          {
            id: "wallpaper",
            label: "Change Wallpaper…",
            icon: PaletteIcon,
            separatorBefore: true,
            onSelect: onPickWallpaper,
          },
          {
            id: "lineage",
            label: lineageVisible ? "Hide Dependency Lines" : "Show Dependency Lines",
            icon: GitBranch,
            checked: lineageVisible,
            onSelect: () => setLineage(!lineageVisible),
          },
        ],
      })
    },
    [screenToWorld, openSqlScratchAtPos, openFinder, onPickWallpaper, lineageVisible, setLineage],
  )

  // Open a folder window for a launcher group.
  const openFolder = useCallback((folderId: string) => {
    const folder = FOLDERS.find((f) => f.id === folderId)
    openWindow({
      id: randomUUID(),
      kind: "folder",
      title: folder?.label ?? "Folder",
      x: clampWorld(200),
      y: clampWorld(130),
      width: 460,
      height: 420,
      payload: { kind: "folder", folderId } satisfies FolderPayload,
    })
  }, [openWindow])

  // Flat launcher registry — the data behind BOTH the desktop icons and the
  // folder windows. `folder` routes an item into a folder window (undefined =
  // lives on the desktop); `rvbbit` gates it to rvbbit connections.
  const launchers: LauncherItem[] = useMemo(() => [
    { id: "finder", label: "Finder", icon: FolderOpen, color: "var(--brand-finder)", activate: openFinder },
    { id: "sql-scratch", label: "SQL Scratch", icon: FileCode2, color: "var(--brand-sql-scratch)", activate: openSqlScratch },
    { id: "view-apps", label: "View Apps", icon: Boxes, color: "var(--brand-view-apps)", sublabel: viewAppCount ? `${viewAppCount} saved` : undefined, activate: openViewApps },
    { id: "connections", label: "Connections", icon: Plug, color: "var(--brand-connections)", activate: openConnections },
    { id: "data-search", label: "Data Search", icon: Search, color: "var(--brand-kg)", description: "Semantic search across data", activate: () => openDataSearch(), rvbbit: true },
    // System
    { id: "system-objects", label: "System Objects", icon: Layers, color: "var(--brand-system-objects)", description: "Tables, indexes, roles, activity", activate: () => openSystemObjects("tables"), folder: "system" },
    { id: "extensions", label: "Extensions", icon: Settings2, color: "var(--brand-extensions)", description: "Installed Postgres extensions", activate: openExtensions, folder: "system" },
    { id: "monitor", label: "Monitor", icon: Activity, color: "var(--brand-pg-monitor)", description: "Live server activity & stats", activate: openPgMonitor, folder: "system" },
    { id: "cache", label: "Cache", icon: Database, color: "var(--brand-cache)", description: "Compiler & operator result caches", activate: openCache, folder: "system", rvbbit: true },
    { id: "receipts", label: "Receipts", icon: FileText, color: "var(--brand-rvbbit-cache)", sublabel: schema?.rvbbitVersion ?? undefined, description: "Per-call LLM receipts & audit", activate: openRvbbitCache, folder: "system", rvbbit: true },
    { id: "costs", label: "Costs", icon: DollarSign, color: "var(--brand-costs)", description: "LLM/sidecar spend breakdown", activate: () => openCosts(), folder: "system", rvbbit: true },
    { id: "sync-mirror", label: "Temporal Mirror", icon: Database, color: "var(--brand-cache)", description: "Sync Postgres sources into time-travel tables", activate: openSyncMirror, folder: "system", rvbbit: true },
    // Semantic
    { id: "operators", label: "Operators", icon: FlowArrow, color: "var(--brand-operators)", description: "Semantic SQL operators", activate: openOperators, folder: "semantic", rvbbit: true },
    { id: "specialists", label: "Specialists", icon: Brain, color: "var(--brand-specialists)", description: "Fine-tuned task models", activate: openSpecialists, folder: "semantic", rvbbit: true },
    { id: "routing", label: "Routing", icon: GitBranch, color: "var(--brand-routing)", description: "Model/backend routing rules", activate: openRouting, folder: "semantic", rvbbit: true },
    { id: "mcp", label: "MCP", icon: Globe, color: "var(--brand-mcp)", description: "MCP servers & tools", activate: openMcpServers, folder: "semantic", rvbbit: true },
    { id: "capabilities", label: "Capabilities", icon: Package, color: "var(--brand-capability)", description: "Installable model capabilities", activate: () => openCapabilities(), folder: "semantic", rvbbit: true },
    { id: "hf-deploy", label: "Hugging Face", icon: Sparkles, color: "var(--brand-capability)", description: "Deploy any Hugging Face model by id", activate: () => openHfDeploy(), folder: "semantic", rvbbit: true },
    { id: "warren", label: "Warren", icon: Rocket, color: "var(--brand-warren)", description: "Sidecar model runtimes & jobs", activate: () => openWarren(), folder: "semantic", rvbbit: true },
    { id: "model-studio", label: "Model Studio", icon: Brain, color: "var(--brand-specialists)", description: "Inspect & try models", activate: () => openModelStudio(), folder: "semantic", rvbbit: true },
    { id: "duck", label: "Duck", icon: Boxes, color: "var(--brand-duck)", description: "Sidecar broker telemetry", activate: openDuck, folder: "semantic", rvbbit: true },
    // Metrics
    { id: "metric-catalog", label: "Metric Catalog", icon: Table2, color: "oklch(78% 0.13 95)", description: "Browse all metrics", activate: () => openMetricCatalog(), folder: "metrics", rvbbit: true },
    { id: "metric-creator", label: "Metric Creator", icon: Calculator, color: "oklch(78% 0.13 95)", description: "Author & version metrics", activate: () => openMetricCreator(), folder: "metrics", rvbbit: true },
    { id: "metric-inspector", label: "Metric Inspector", icon: LineChart, color: "oklch(78% 0.13 95)", description: "Run metrics across def-time & data-time", activate: () => openMetricInspector(), folder: "metrics", rvbbit: true },
    { id: "metric-board", label: "KPI Board", icon: Table2, color: "oklch(78% 0.13 95)", description: "Matrix of metric values & KPI verdicts over time", activate: () => openMetricBoard(), folder: "metrics", rvbbit: true },
    { id: "dashboards", label: "Dashboards", icon: LayoutDashboard, color: "oklch(78% 0.13 95)", description: "Claude-built dashboards — live, inspectable, shareable", activate: () => openDashboards(), folder: "metrics", rvbbit: true },
    { id: "alerts", label: "Alerts", icon: Bell, color: "oklch(68% 0.19 25)", description: "Observable alert rules — thresholds, episodes & firing", activate: () => openAlerts(), rvbbit: true },
    // Knowledge
    { id: "kg", label: "Knowledge Graph", icon: TreeStructure, color: "var(--brand-kg)", description: "Browse the extracted graph", activate: () => openKgBrowser(), folder: "knowledge", rvbbit: true },
    { id: "kg-explorer", label: "Graph Explorer", icon: TreeStructure, color: "var(--brand-kg)", description: "Walk entities & relations", activate: () => openKgExplorer(), folder: "knowledge", rvbbit: true },
    { id: "query-lens", label: "Query Lens", icon: Eye, color: "var(--brand-query-lens)", description: "Trace a query's execution", activate: () => openQueryLens(), folder: "knowledge", rvbbit: true },
    { id: "drift", label: "Drift", icon: LineChart, color: "var(--brand-kg)", description: "Compare extraction runs", activate: () => openDrift(), folder: "knowledge", rvbbit: true },
  ], [
    viewAppCount, schema,
    openFinder, openSqlScratch, openViewApps, openConnections, openDataSearch,
    openSystemObjects, openExtensions, openPgMonitor, openCache, openRvbbitCache,
    openCosts, openSyncMirror, openOperators, openSpecialists, openRouting,
    openMcpServers, openCapabilities, openHfDeploy, openWarren, openModelStudio,
    openDuck, openMetricCatalog, openMetricCreator, openMetricInspector, openMetricBoard, openDashboards, openAlerts,
    openKgBrowser, openKgExplorer, openQueryLens, openDrift,
  ])

  // Shared, per-window-invariant slice of WindowContext, memoized so the
  // per-window <WindowFrame> memo boundary can bail. Only its referenced
  // shell values (connection, schema, palette, notifications, …) change it;
  // none of those fire during a drag or a focus click.
  const baseCtx = useMemo<BaseWindowContext>(
    () => ({
      activeConnectionId,
      hasRvbbit,
      launchers,
      schema,
      schemaLoading,
      busy,
      setBusy,
      openTableFromFinder,
      openField,
      openViewAppBuilder,
      openViewApp,
      openArtifact,
      openQueryDocument,
      openSqlData,
      openExtensions,
      openRvbbitCache,
      openCache,
      openConnections,
      reloadSchema: () => activeConnectionId && void loadSchema(activeConnectionId),
      reloadConnections: loadConnections,
      updatePayload,
      emitParam,
      subscribeParam,
      editRollupSpec,
      repivotWindow,
      probeColumnValues,
      palette: activePalette,
      paletteOverrides,
      hasWallpaper: !!wallpaperUrl,
      onReExtractPalette,
      onReExtractWithRvbbit,
      onChangePaletteOverrides: setPaletteOverrides,
      notifications,
      watchedChannels,
      windowChannels: windowChannels.filter((c) => !watchedChannels.includes(c)),
      notifyStatus,
      onAddWatched: addWatchedChannel,
      onRemoveWatched: removeWatchedChannel,
      onClearNotifications: clearNotifications,
      openOperatorFlow,
      openSpecialistDetail,
      openMcpServerDetail,
      openRouting,
      openQueryLens,
      openKgBrowser,
      openKgEntity,
      openSourceRow,
      openKgForSource,
      openKgExtractionRuns,
      openKgMergeReview,
      openKgExplorer,
      openDataSearch,
      openDrift,
      openModelStudio,
      openMetricCatalog,
      openMetricCreator,
      openMetricInspector,
      openCosts,
      openDuck,
      openCapabilities,
      openCapabilityDetail,
      openHfDeploy,
      openWarren,
      openWarrenJob,
    }),
    [
      activeConnectionId, hasRvbbit, launchers, schema, schemaLoading, busy, setBusy,
      openTableFromFinder, openField, openViewAppBuilder, openViewApp, openArtifact,
      openQueryDocument, openSqlData, openExtensions, openRvbbitCache, openCache, openConnections,
      loadSchema, loadConnections, updatePayload, emitParam, subscribeParam,
      editRollupSpec, repivotWindow, probeColumnValues, activePalette, paletteOverrides,
      wallpaperUrl, onReExtractPalette, onReExtractWithRvbbit, setPaletteOverrides,
      notifications, watchedChannels, windowChannels, notifyStatus, addWatchedChannel,
      removeWatchedChannel, clearNotifications, openOperatorFlow, openSpecialistDetail,
      openMcpServerDetail, openRouting, openQueryLens, openKgBrowser, openKgEntity,
      openSourceRow, openKgForSource, openKgExtractionRuns, openKgMergeReview, openKgExplorer,
      openDataSearch, openDrift, openModelStudio, openMetricCatalog, openMetricCreator,
      openMetricInspector, openCosts, openDuck, openCapabilities, openCapabilityDetail,
      openHfDeploy, openWarren, openWarrenJob,
    ],
  )

  return (
    <PhosphorIconProvider>
    <div
      className="rvbbit-lens-desktop relative h-screen w-screen overflow-hidden bg-background text-foreground"
      onDragEnter={handleCanvasDragEnter}
      onDragLeave={handleCanvasDragLeave}
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onMouseDown={handleDesktopMouseDown}
      onContextMenu={handleDesktopContextMenu}
    >
      {wallpaperUrl ? (
        <div
          className="pointer-events-none fixed inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `linear-gradient(135deg, var(--wallpaper-overlay-from), var(--wallpaper-overlay-to)), url(${wallpaperUrl})`,
          }}
        />
      ) : null}
      <ScryCanvas
        open={scryOpen}
        onClose={() => setScryOpen(false)}
        connectionId={activeConnectionId}
        onSpawnResults={spawnScryResults}
        onOpenTable={openTableFromFinder}
        onOpenField={openField}
        onGraduate={graduateTables}
      />
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(var(--chrome-border) 1px, transparent 1px), linear-gradient(90deg, var(--chrome-border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />
      {!wallpaperUrl ? (
        <div
          className="pointer-events-none fixed inset-0"
          style={{
            background:
              "radial-gradient(ellipse 48% 34% at 18% 16%, var(--ambient-1), transparent 62%), radial-gradient(ellipse 42% 28% at 78% 20%, var(--ambient-2), transparent 64%), radial-gradient(ellipse 50% 38% at 58% 88%, var(--ambient-3), transparent 62%)",
          }}
        />
      ) : null}

      <input
        ref={wallpaperInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onWallpaperFileChange}
      />

      <DesktopMenuBar
        connections={connections.map((c) => ({
          id: c.id,
          label: c.label,
          database: c.database,
          hasRvbbit: c.id === activeConnectionId ? hasRvbbit : false,
        }))}
        activeConnectionId={activeConnectionId}
        onSelectConnection={setActiveConnectionId}
        onOpenConnections={openConnections}
        onOpenFinder={openFinder}
        onOpenSqlScratch={openSqlScratch}
        onOpenSystemObjects={() => openSystemObjects("tables")}
        onOpenPgMonitor={openPgMonitor}
        onOpenNotifications={openNotifications}
        onOpenExtensions={openExtensions}
        onOpenRvbbitCache={openRvbbitCache}
        onOpenCache={openCache}
        onOpenOperators={openOperators}
        onOpenSpecialists={openSpecialists}
        onOpenRouting={openRouting}
        onOpenMcpServers={openMcpServers}
        onOpenCapabilities={() => openCapabilities()}
        onOpenCosts={() => openCosts()}
        onOpenDuck={openDuck}
        onOpenWarren={() => openWarren()}
        onOpenQueryLens={() => openQueryLens()}
        onOpenDataSearch={() => openDataSearch()}
        onOpenDrift={() => openDrift()}
        onOpenSql={openSqlWith}
        onOpenModelStudio={() => openModelStudio()}
        onOpenCatalogGraph={() => openKgExplorer("db_catalog")}
        onOpenKgBrowser={() => openKgBrowser()}
        onOpenKgExtractionRuns={() => openKgExtractionRuns()}
        onOpenKgMergeReview={() => openKgMergeReview()}
        onOpenKgExplorer={() => openKgExplorer()}
        onOpenViewApps={openViewApps}
        onPickWallpaper={onPickWallpaper}
        onClearWallpaper={onClearWallpaper}
        onOpenPalette={openPalette}
        onSetTheme={setTheme}
        themeMode={themeMode}
        onToggleLineage={() => setLineage(!lineageVisible)}
        lineageVisible={lineageVisible}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        sansFont={fontPrefs.sans}
        monoFont={fontPrefs.mono}
        fontScale={fontPrefs.scale}
        onSetSansFont={setSansFont}
        onSetMonoFont={setMonoFont}
        onSetFontScale={setFontScale}
        hasWallpaper={!!wallpaperUrl}
        hasRvbbit={hasRvbbit}
        busy={busy || schemaLoading}
        activeWorkspace={activeWorkspace}
        workspaceOccupancy={workspaceOccupancy}
        onSwitchWorkspace={switchWorkspace}
        sceneName={currentScene?.name ?? null}
        sceneDirty={sceneDirty}
        sceneCanSave={currentSceneId != null && sceneDirty}
        sceneHasContent={workspaces[activeWorkspace].windows.length > 0}
        sceneSlotOccupied={sceneSlotOccupied}
        scenes={scenes}
        currentSceneId={currentSceneId}
        onSaveScene={saveCurrentScene}
        onSaveSceneAs={saveDesktopAsScene}
        onOpenScene={openScene}
        onRenameScene={renameSceneById}
        onDeleteScene={deleteSceneById}
        onSceneNameExists={sceneNameExists}
      />

      <DesktopParamsSurface params={desktopParams} onClear={removeParam} />

      {lineageVisible && !wsTransition ? (
        <LineageOverlay windows={windows} params={desktopParams} />
      ) : null}

      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />

      {wallpaperError ? (
        <div className="pointer-events-auto fixed left-1/2 top-12 z-40 -translate-x-1/2 rounded-base border border-danger/60 bg-danger/15 px-3 py-1 text-[11px] text-danger">
          {wallpaperError}
        </div>
      ) : null}

      {dropNotice ? (
        <div className="pointer-events-auto fixed left-1/2 top-12 z-40 -translate-x-1/2 rounded-base border border-warning/60 bg-warning/15 px-3 py-1 text-[11px] text-warning">
          {dropNotice}
        </div>
      ) : null}

      {/* Semantic-op drop palette — appears while dragging a text column. */}
      <SemanticOpPalette semanticOps={semanticOps} onDropOp={requestSemanticDrop} />
      {pendingBind ? (
        <SemanticBindPopover
          op={pendingBind.op}
          columnName={pendingBind.payload.columns[0]?.name ?? "column"}
          availableColumns={pendingBind.payload.sourceColumns ?? pendingBind.payload.columns}
          at={pendingBind.at}
          onSubmit={completeSemanticBind}
          onCancel={() => setPendingBind(null)}
        />
      ) : null}

      {/* Rowset-op pipeline palette — appears while dragging a result block. */}
      <RowsetOpPalette semanticOps={semanticOps} onDropOp={requestRowsetStage} />
      {pendingRowset ? (
        <RowsetPromptPopover
          op={pendingRowset.op}
          blockTitle={pendingRowset.payload.title}
          at={pendingRowset.at}
          onSubmit={completeRowsetStage}
          onCancel={() => setPendingRowset(null)}
        />
      ) : null}

      {/* CSV file-drop overlay — only while a native file is dragged over the
          desktop. pointer-events-none so it never interferes with the drop. */}
      {fileDragActive ? (
        <div className="pointer-events-none fixed inset-0 z-[55] grid place-items-center bg-background/40 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-rvbbit-accent/70 bg-chrome-bg/80 px-10 py-8 text-center shadow-2xl">
            <FileCsv className="h-10 w-10 text-rvbbit-accent" weight="duotone" />
            <div className="text-[13px] font-medium text-foreground">Drop to import CSV</div>
            <div className="text-[11px] text-chrome-text/60">.csv · .tsv · .txt</div>
          </div>
        </div>
      ) : null}

      {/* Desktop icons — classic desktop arrangement: a left-aligned vertical
          column that wraps into further columns growing RIGHTWARD (flex-col +
          wrap, auto width anchored to the left edge). */}
      <div className="pointer-events-none absolute top-12 bottom-3 left-2 z-0 flex flex-col flex-wrap content-start gap-1">
        <div className="pointer-events-auto contents">
          {/* Desktop-level launchers + folder icons, built from the
              launcher registry. Folders only appear if they have a
              visible item for this connection. */}
          {/* `launchers`' activate handlers reach the live canvas via liveWindows()
              (a ref read) — deferred to click time, never read during render — so
              the react-hooks/refs flag here is a false positive. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          {launchers
            .filter((l) => !l.folder && (!l.rvbbit || hasRvbbit))
            .map((l) => (
              <DesktopIcon key={l.id} label={l.label} sublabel={l.sublabel} icon={l.icon} iconColor={l.color} onActivate={l.activate} />
            ))}
          {/* eslint-disable-next-line react-hooks/refs */}
          {FOLDERS.filter((f) => launchers.some((l) => l.folder === f.id && (!l.rvbbit || hasRvbbit))).map((f) => (
            <DesktopIcon key={`folder:${f.id}`} label={f.label} icon={Folder} iconColor={f.color} onActivate={() => openFolder(f.id)} />
          ))}
        </div>
      </div>

      {/* Workspace layers — all canvases (five scratch + the Scene slot)
          stay mounted at once so switching preserves window state and the
          slide animation has real windows to move. Inactive layers are
          display:none; the active one (and, mid-switch, the entering +
          exiting pair) animate via CSS keyframes. */}
      {ALL_SLOT_IDS.map((wsId) => {
        const canvas = workspaces[wsId]
        const isActive = wsId === activeWorkspace
        const layerClass = wsTransition
          ? wsId === wsTransition.from
            ? wsTransition.dir === "forward" ? "av-ws-exit-fwd" : "av-ws-exit-back"
            : wsId === wsTransition.to
              ? wsTransition.dir === "forward" ? "av-ws-enter-fwd" : "av-ws-enter-back"
              : "av-ws-parked"
          : isActive ? "av-ws-active" : "av-ws-parked"
        return (
          <WorkspaceActiveContext.Provider key={wsId} value={isActive}>
          <div
            className={cn(
              "av-ws-layer pointer-events-none absolute inset-0 z-10 pt-8",
              layerClass,
            )}
            aria-hidden={!isActive}
          >
            {/* Present mode v1 frames the active canvas: a translate+scale on
                this inner wrapper (origin top-left) fits the windows' bounding
                box to the screen. In edit mode the wrapper is a pass-through
                (no transform) so positioning is byte-identical to before. */}
            <div
              className="absolute inset-0"
              style={
                present && isActive && presentFit
                  ? {
                      transform: `translate(${presentFit.x}px, ${presentFit.y}px) scale(${presentFit.scale})`,
                      transformOrigin: "0 0",
                    }
                  : undefined
              }
            >
            {canvas.windows.map((w) => {
              return (
                <WindowFrame
                  key={w.id}
                  window={w}
                  baseCtx={baseCtx}
                  slotWindows={canvas.windows}
                  slotParams={canvas.params}
                  runSignal={runSignals[w.id] ?? 0}
                  workspaceActive={isActive}
                  focused={isActive && w.id === canvas.focusedWindowId}
                  viewportScale={viewport.scale}
                  onFocus={focus}
                  onClose={close}
                  onMinimize={minimize}
                  onMove={move}
                  onResize={resize}
                  mergeColumnIntoWindow={mergeColumnIntoWindow}
                  requestRowsetStage={requestRowsetStage}
                  requestSemanticDrop={requestSemanticDrop}
                  semanticOps={semanticOps}
                />
              )
            })}
            </div>
            {/* Empty Scene slot = the Scene gallery: pick one to load, or
                save the current desktop from the Scenes menu. */}
            {wsId === SCENE_SLOT && canvas.windows.length === 0 ? (
              <div className="pointer-events-auto absolute left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-chrome-border bg-chrome-background/85 p-2 shadow-2xl backdrop-blur">
                <div className="flex items-center gap-1.5 px-1 pb-1.5 pt-0.5 text-[11px] font-medium text-chrome-text/70">
                  <Layers className="h-3.5 w-3.5" /> Scenes — saved desktops
                </div>
                <SceneList
                  scenes={scenes}
                  currentSceneId={currentSceneId}
                  onOpen={openScene}
                  onRename={renameSceneById}
                  onDelete={deleteSceneById}
                  nameExists={sceneNameExists}
                  emptyHint="No saved Scenes yet. Use the Scenes menu in the top bar to save the current desktop."
                />
              </div>
            ) : null}
          </div>
          </WorkspaceActiveContext.Provider>
        )
      })}

      {/* Transition input-blocker — swallows clicks for the ~300ms slide
          so the user can't interact with windows mid-animation. */}
      {wsTransition ? <div className="fixed inset-0 z-[45]" /> : null}

      {/* Incoming NOTIFY toasts */}
      <NotificationToasts toasts={toasts} onDismiss={dismissToast} />

      {/* Empty-state overlay when no connection */}
      {connections.length === 0 ? (
        <EmptyStateOverlay onAddConnection={openConnections} />
      ) : null}

      {/* Minimized window dock */}
      {windows.some((w) => w.minimized) ? (
        <div className="pointer-events-auto fixed bottom-3 left-1/2 z-40 -translate-x-1/2 transform">
          <div className="flex items-center gap-1.5 rounded-md border border-chrome-border bg-chrome-bg/90 p-1 shadow-xl backdrop-blur">
            {windows.filter((w) => w.minimized).map((w) => {
              const Icon = iconForKind(w.kind)
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => focus(w.id)}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
                  title={w.title}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="max-w-[160px] truncate">{w.title}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
    </PhosphorIconProvider>
  )
}

function EmptyStateOverlay({ onAddConnection }: { onAddConnection: () => void }) {
  return (
    <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
      <div className="max-w-md rounded-md border-2 border-border bg-secondary-background p-6 text-center shadow-shadow">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-md border border-rvbbit-accent/40 bg-rvbbit-bg/60">
          <Database className="h-7 w-7 text-rvbbit-accent" />
        </div>
        <h2 className="mb-1 text-lg font-semibold">Welcome to rvbbit-lens</h2>
        <p className="mb-4 text-sm text-chrome-text">
          A local SQL desktop for Postgres. Add a connection to your local database — we&apos;ll
          opportunistically light up the rvbbit semantic surface if we find the extension.
        </p>
        <button
          type="button"
          onClick={onAddConnection}
          className="inline-flex items-center gap-2 rounded-base border-2 border-border bg-main px-4 py-2 text-sm text-main-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none"
        >
          <Plus className="h-4 w-4" />
          Add Postgres connection
        </button>
      </div>
    </div>
  )
}

interface WindowContext {
  activeConnectionId: string | null
  hasRvbbit: boolean
  /** The launcher registry — folder windows filter it by their folderId. */
  launchers: LauncherItem[]
  schema: SchemaSnapshot | null
  schemaLoading: boolean
  busy: boolean
  setBusy: (b: boolean) => void
  openTableFromFinder: (schema: string, name: string) => void
  openField: (schema: string, rel: string, col: string) => void
  openViewAppBuilder: (seed?: ViewAppBuilderPayload) => void
  openViewApp: (appId: string) => void
  openArtifact: (artifactId: string) => void
  openQueryDocument: (payload: QueryDocumentPayload) => void
  openSqlData: (sql: string, title: string) => void
  openExtensions: () => void
  openRvbbitCache: () => void
  openCache: () => void
  openConnections: () => void
  openOperatorFlow: (operatorName: string | null, receiptId?: string | null) => void
  openSpecialistDetail: (specialistName: string) => void
  openMcpServerDetail: (serverName: string) => void
  openRouting: () => void
  openQueryLens: (queryId?: string | null) => void
  openKgBrowser: (graphId?: string | null) => void
  openKgEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  openSourceRow: (ctx: KgSourceContext) => void
  openKgForSource: (ctx: KgSourceContext) => void
  openKgExtractionRuns: (graphId?: string | null, runId?: number | null) => void
  openKgMergeReview: (graphId?: string | null, nodeKindFilter?: string) => void
  openKgExplorer: (
    graphId?: string,
    seedKind?: string | null,
    seedLabel?: string | null,
  ) => void
  openDataSearch: (initialQuery?: string) => void
  openDrift: () => void
  openModelStudio: (modelName?: string) => void
  openMetricCatalog: () => void
  openMetricCreator: (metricName?: string) => void
  openMetricInspector: (metricName?: string) => void
  openCosts: (initialFilter?: CostsPayload["initialFilter"]) => void
  openDuck: () => void
  openCapabilities: (tagFilter?: string | null) => void
  openCapabilityDetail: (
    catalogId: string,
    initialTab?: CapabilityDetailPayload["initialTab"],
  ) => void
  openHfDeploy: (modelId?: string | null) => void
  openWarren: (initialTab?: WarrenPayload["initialTab"]) => void
  openWarrenJob: (jobId: string, jobName?: string | null) => void
  reloadSchema: () => void
  reloadConnections: () => Promise<void>
  updatePayload: (id: string, mutator: (payload: unknown) => unknown) => void
  windows: DesktopWindowState[]
  params: DesktopParamValue[]
  runSignal: number
  emitParam: (input: {
    sourceWindowId: string
    sourceBlockName: string
    sourceTitle: string
    field: string
    value: unknown
    operator?: DesktopParamOperator
    multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
    cascade?: boolean
    dataTypeId?: number
    type?: string
  }) => void
  subscribeParam: (targetWindowId: string, key: string, targetField?: string, target?: ParamTarget) => void
  editRollupSpec: (targetWindowId: string, transform: (s: RollupSpec) => RollupSpec) => void
  repivotWindow: (targetWindowId: string, grain: RollupGrain) => void
  probeColumnValues: (targetWindowId: string, column: DesktopColumnRef, search?: string) => Promise<{ values: (string | number | null)[]; truncated: boolean }>
  palette: ImagePalette | null
  paletteOverrides: Partial<ImagePalette> | null
  hasWallpaper: boolean
  onReExtractPalette: () => void
  onReExtractWithRvbbit: () => Promise<void>
  onChangePaletteOverrides: (next: Partial<ImagePalette> | null) => void
  /** False when this window lives in a parked (inactive) workspace —
   *  lets live-polling windows like the monitor stand down. */
  workspaceActive: boolean
  // LISTEN/NOTIFY surface for the Notification Center window.
  notifications: NotifyEvent[]
  watchedChannels: string[]
  windowChannels: string[]
  notifyStatus: NotifyConnectionStatus
  onAddWatched: (channel: string) => void
  onRemoveWatched: (channel: string) => void
  onClearNotifications: () => void
}

/** Everything in a window's context that is shared across all windows and
 *  doesn't vary per-window/per-slot. Memoized once at the shell so it has a
 *  stable identity, which lets the per-window memo boundary below bail out. */
type BaseWindowContext = Omit<WindowContext, "windows" | "params" | "runSignal" | "workspaceActive">

/**
 * Memoized per-window boundary. Re-renders only when THIS window's state, its
 * slot's window/param arrays, its run signal, focus, or the shared `baseCtx`
 * change. Because a mutation to the active slot leaves the other 5 slots'
 * canvases referentially untouched (`{ ...prev, [active]: next }`), every
 * off-screen window's props are unchanged and it bails out of re-render — so
 * interacting with the active desktop no longer re-renders windows parked on
 * other desktops.
 */
const WindowFrame = memo(function WindowFrame({
  window: w,
  baseCtx,
  slotWindows,
  slotParams,
  runSignal,
  workspaceActive,
  focused,
  viewportScale,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  mergeColumnIntoWindow,
  requestRowsetStage,
  requestSemanticDrop,
  semanticOps,
}: {
  window: DesktopWindowState
  baseCtx: BaseWindowContext
  slotWindows: DesktopWindowState[]
  slotParams: DesktopParamValue[]
  runSignal: number
  workspaceActive: boolean
  focused: boolean
  viewportScale: number
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMinimize: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  mergeColumnIntoWindow: (targetWindowId: string, payload: DesktopColumnDragPayload, op: RollupOp) => void
  requestRowsetStage: (payload: DesktopBlockDragPayload, op: SemanticOpMeta, at: { x: number; y: number }, inPlace?: boolean) => void
  requestSemanticDrop: (payload: DesktopColumnDragPayload, op: SemanticOpMeta, at: { x: number; y: number }, targetWindowId?: string) => void
  semanticOps: SemanticOpMeta[]
}) {
  const ctx = useMemo<WindowContext>(
    () => ({ ...baseCtx, windows: slotWindows, params: slotParams, runSignal, workspaceActive }),
    [baseCtx, slotWindows, slotParams, runSignal, workspaceActive],
  )
  // Column-aggregate windows are drop targets for additional columns from
  // their *exact* parent (same parent window + same source relation).
  // Anything else falls through to the canvas drop, which spawns a fresh block.
  const columnDropAcceptsFrom = useMemo(() => {
    if (w.kind !== "data") return null
    const lin = (w.payload as DataPayload | undefined)?.lineage
    if (!lin || lin.kind !== "column-aggregate") return null
    const spec = effectiveRollup(lin)
    if (!spec) return null
    return { parentWindowId: lin.parentWindowId, relationKey: lin.relationKey, measures: spec.measures }
  }, [w])
  const onColumnMerge = useCallback(
    (payload: DesktopColumnDragPayload, op: RollupOp) => mergeColumnIntoWindow(w.id, payload, op),
    [mergeColumnIntoWindow, w.id],
  )
  const onRowsetChain = useCallback(
    (payload: DesktopBlockDragPayload, op: SemanticOpMeta, at: { x: number; y: number }) =>
      requestRowsetStage(payload, op, at, true),
    [requestRowsetStage],
  )
  return (
    <DesktopWindow
      window={w}
      icon={iconForKind(w.kind)}
      focused={focused}
      onFocus={onFocus}
      onClose={onClose}
      onMinimize={onMinimize}
      onMove={onMove}
      onResize={onResize}
      viewportScale={viewportScale}
      columnDropAcceptsFrom={columnDropAcceptsFrom}
      onColumnMerge={onColumnMerge}
      semanticOps={semanticOps}
      onSemanticDrop={requestSemanticDrop}
      onRowsetChain={onRowsetChain}
    >
      {renderWindowContent(w, ctx)}
    </DesktopWindow>
  )
})

function renderWindowContent(
  w: DesktopWindowState,
  ctx: WindowContext,
): React.ReactNode {
  switch (w.kind) {
    case "finder":
      return (
        <FinderWindow
          schema={ctx.schema}
          loading={ctx.schemaLoading}
          onOpenTable={ctx.openTableFromFinder}
          onReload={ctx.reloadSchema}
          onOpenConnections={ctx.openConnections}
          activeConnectionId={ctx.activeConnectionId}
        />
      )
    case "data":
      return (
        <DataGridWindow
          window={w}
          payload={w.payload as DataPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          schema={ctx.schema}
          allWindows={ctx.windows}
          params={ctx.params}
          runSignal={ctx.runSignal}
          onChangePayload={(mut) => ctx.updatePayload(w.id, (p) => mut(p as DataPayload))}
          onSaveAsViewApp={(sql) => ctx.openViewAppBuilder({ initialSql: sql })}
          onEmitParam={ctx.emitParam}
          onSubscribeParam={(key, field, target) => ctx.subscribeParam(w.id, key, field, target)}
          onEditRollup={(transform) => ctx.editRollupSpec(w.id, transform)}
          onRepivot={(grain) => ctx.repivotWindow(w.id, grain)}
          onProbeValues={(column, search) => ctx.probeColumnValues(w.id, column, search)}
          onOpenKgForSource={ctx.openKgForSource}
        />
      )
    case "connections":
      return <ConnectionsWindow onChanged={ctx.reloadConnections} />
    case "view-apps":
      return (
        <ViewAppsWindow
          onOpen={ctx.openViewApp}
          onCreate={() => ctx.openViewAppBuilder()}
          onEdit={(id) => ctx.openViewAppBuilder({ appId: id })}
        />
      )
    case "view-app-builder":
      return (
        <ViewAppBuilderWindow
          payload={w.payload as ViewAppBuilderPayload}
          activeConnectionId={ctx.activeConnectionId}
          onClose={() => { /* parent closes via window chrome */ }}
        />
      )
    case "view-app":
      return (
        <ViewAppWindow
          payload={w.payload as ViewAppPayload}
          activeConnectionId={ctx.activeConnectionId}
        />
      )
    case "extensions":
      return <ExtensionsWindow activeConnectionId={ctx.activeConnectionId} onOpenRvbbitCache={ctx.openRvbbitCache} />
    case "system-objects":
      return <SystemObjectsWindow payload={w.payload as SystemObjectsPayload} activeConnectionId={ctx.activeConnectionId} />
    case "rvbbit-cache":
      return (
        <RvbbitCacheWindow
          payload={w.payload as RvbbitCachePayload}
          activeConnectionId={ctx.activeConnectionId}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenTable={ctx.openTableFromFinder}
        />
      )
    case "cache":
      return (
        <CacheWindow
          payload={w.payload as CachePayload}
          activeConnectionId={ctx.activeConnectionId}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
        />
      )
    case "csv-import":
      return (
        <CsvImportWindow
          windowId={w.id}
          payload={w.payload as CsvImportPayload}
          activeConnectionId={ctx.activeConnectionId}
          schema={ctx.schema}
          onReloadSchema={ctx.reloadSchema}
          onOpenTable={ctx.openTableFromFinder}
        />
      )
    case "artifact":
      return <ArtifactWindow payload={w.payload as ArtifactPayload} activeConnectionId={ctx.activeConnectionId} />
    case "query-document":
      return <QueryDocumentWindow payload={w.payload as QueryDocumentPayload} />
    case "pg-monitor":
      return (
        <PgMonitorWindow
          activeConnectionId={ctx.activeConnectionId}
          workspaceActive={ctx.workspaceActive}
        />
      )
    case "operators":
      return (
        <OperatorsWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenOperator={ctx.openOperatorFlow}
        />
      )
    case "operator-flow":
      return (
        <OperatorFlowWindow
          payload={w.payload as OperatorFlowPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenKgExtractionRuns={ctx.openKgExtractionRuns}
          onOpenCapability={ctx.openCapabilityDetail}
        />
      )
    case "specialists":
      return (
        <SpecialistsWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenSpecialist={ctx.openSpecialistDetail}
        />
      )
    case "specialist-detail":
      return (
        <SpecialistDetailWindow
          payload={w.payload as SpecialistDetailPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenCapability={ctx.openCapabilityDetail}
          onOpenWarrenJob={ctx.openWarrenJob}
        />
      )
    case "routing":
      return (
        <RoutingWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
        />
      )
    case "mcp-servers":
      return (
        <McpServersWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenServer={ctx.openMcpServerDetail}
          onOpenCapability={ctx.openCapabilityDetail}
        />
      )
    case "mcp-server-detail":
      return (
        <McpServerDetailWindow
          payload={w.payload as McpServerDetailPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenCapability={ctx.openCapabilityDetail}
        />
      )
    case "query-lens":
      return (
        <QueryLensWindow
          payload={w.payload as QueryLensPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenOperator={(name, receiptId) =>
            ctx.openOperatorFlow(name, receiptId)
          }
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenMcpServer={ctx.openMcpServerDetail}
          onOpenRouting={ctx.openRouting}
          onOpenKgEntity={ctx.openKgEntity}
          onOpenSourceRow={ctx.openSourceRow}
        />
      )
    case "kg-browser":
      return (
        <KgBrowserWindow
          payload={w.payload as KgBrowserPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenEntity={ctx.openKgEntity}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenExtractionRuns={ctx.openKgExtractionRuns}
          onOpenMergeReview={ctx.openKgMergeReview}
        />
      )
    case "kg-entity-detail":
      return (
        <KgEntityDetailWindow
          payload={w.payload as KgEntityDetailPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenEntity={ctx.openKgEntity}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenKgBrowser={ctx.openKgBrowser}
          onOpenSourceRow={ctx.openSourceRow}
          onOpenKgExplorer={ctx.openKgExplorer}
        />
      )
    case "kg-extraction-runs":
      return (
        <KgExtractionRunsWindow
          payload={w.payload as KgExtractionRunsPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenOperator={ctx.openOperatorFlow}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenSourceRow={ctx.openSourceRow}
        />
      )
    case "kg-merge-review":
      return (
        <KgMergeReviewWindow
          payload={w.payload as KgMergeReviewPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenEntity={ctx.openKgEntity}
        />
      )
    case "kg-explorer":
      return (
        <KgExplorerWindow
          payload={w.payload as KgExplorerPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenEntity={ctx.openKgEntity}
          onOpenQueryLens={ctx.openQueryLens}
          onOpenSourceRow={ctx.openSourceRow}
          onChangePayload={(mut) =>
            ctx.updatePayload(w.id, (p) => mut(p as KgExplorerPayload))
          }
        />
      )
    case "data-search":
      return (
        <DataSearchWindow
          payload={w.payload as DataSearchPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenTable={ctx.openTableFromFinder}
          onOpenField={ctx.openField}
          onOpenCatalogGraph={(seedKind, seedLabel) =>
            ctx.openKgExplorer("db_catalog", seedKind, seedLabel)
          }
        />
      )
    case "scry-results":
      return (
        <ScryResultsWindow
          payload={w.payload as ScryResultsPayload}
          onOpenTable={ctx.openTableFromFinder}
        />
      )
    case "drift":
      return (
        <DriftWindow
          payload={w.payload as DriftPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenTable={ctx.openTableFromFinder}
        />
      )
    case "model-studio":
      return (
        <ModelStudioWindow
          payload={w.payload as ModelStudioPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
        />
      )
    case "metric-catalog":
      return (
        <MetricCatalogWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenInspector={ctx.openMetricInspector}
          onOpenCreator={ctx.openMetricCreator}
        />
      )
    case "metric-creator":
      return (
        <MetricCreatorWindow
          payload={w.payload as MetricCreatorPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenInspector={ctx.openMetricInspector}
        />
      )
    case "metric-inspector":
      return (
        <MetricInspectorWindow
          payload={w.payload as MetricInspectorPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenCreator={ctx.openMetricCreator}
        />
      )
    case "metric-board":
      return (
        <MetricBoardWindow
          payload={w.payload as MetricBoardPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          windowId={w.id}
          onOpenInspector={ctx.openMetricInspector}
          onOpenSqlData={ctx.openSqlData}
          onEmitParam={ctx.emitParam}
          onChangePayload={(mut) => ctx.updatePayload(w.id, (p) => mut(p as MetricBoardPayload))}
        />
      )
    case "alerts":
      return (
        <AlertsWindow
          payload={w.payload as AlertsPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onChangePayload={(mut) => ctx.updatePayload(w.id, (p) => mut(p as AlertsPayload))}
          onOpenSqlData={ctx.openSqlData}
        />
      )
    case "folder": {
      const folderId = (w.payload as FolderPayload).folderId
      const items = ctx.launchers.filter((l) => l.folder === folderId && (!l.rvbbit || ctx.hasRvbbit))
      return <FolderWindow folderId={folderId} items={items} />
    }
    case "capabilities":
      return (
        <CapabilitiesWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          initialTag={(w.payload as CapabilitiesPayload | undefined)?.tagFilter ?? null}
          onOpenCapability={(id) => ctx.openCapabilityDetail(id)}
          onOpenWarren={() => ctx.openWarren()}
          onOpenHfDeploy={() => ctx.openHfDeploy()}
        />
      )
    case "hf-deploy":
      return (
        <HfDeployWindow
          payload={w.payload as HfDeployPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenWarrenJob={ctx.openWarrenJob}
        />
      )
    case "capability-detail":
      return (
        <CapabilityDetailWindow
          payload={w.payload as CapabilityDetailPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
          onOpenWarrenJob={ctx.openWarrenJob}
        />
      )
    case "warren":
      return (
        <WarrenWindow
          payload={w.payload as WarrenPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenJob={ctx.openWarrenJob}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
        />
      )
    case "warren-job-detail":
      return (
        <WarrenJobDetailWindow
          payload={w.payload as WarrenJobDetailPayload}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenSpecialist={ctx.openSpecialistDetail}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
        />
      )
    case "costs":
      return (
        <CostsWindow
          window={w}
          payload={w.payload as CostsPayload}
          activeConnectionId={ctx.activeConnectionId}
          onOpenQueryLens={(queryId) => ctx.openQueryLens(queryId)}
          onOpenOperator={(name) => ctx.openOperatorFlow(name)}
          onChangePayload={(mut) =>
            ctx.updatePayload(w.id, (p) => mut(p as CostsPayload))
          }
        />
      )
    case "sync-mirror":
      // Key on the connection so a switch remounts (clears stale jobs/overview +
      // discards any in-flight overview fetch for the previous connection).
      return <SyncMirrorWindow key={ctx.activeConnectionId ?? "none"} activeConnectionId={ctx.activeConnectionId} />
    case "dashboards":
      return (
        <DashboardsWindow
          key={ctx.activeConnectionId ?? "none"}
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          onOpenSqlData={ctx.openSqlData}
        />
      )
    case "duck":
      return (
        <DuckWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          workspaceActive={ctx.workspaceActive}
        />
      )
    case "notifications":
      return (
        <NotificationCenterWindow
          notifications={ctx.notifications}
          watchedChannels={ctx.watchedChannels}
          windowChannels={ctx.windowChannels}
          status={ctx.notifyStatus}
          activeConnectionId={ctx.activeConnectionId}
          onAddWatched={ctx.onAddWatched}
          onRemoveWatched={ctx.onRemoveWatched}
          onClear={ctx.onClearNotifications}
        />
      )
    case "palette":
      return (
        <PaletteWindow
          palette={ctx.palette}
          overrides={ctx.paletteOverrides}
          hasWallpaper={ctx.hasWallpaper}
          activeConnectionId={ctx.activeConnectionId}
          onReExtract={ctx.onReExtractPalette}
          onReExtractWithRvbbit={ctx.onReExtractWithRvbbit}
          onChangeOverrides={ctx.onChangePaletteOverrides}
        />
      )
    default:
      return <div className="p-4 text-sm text-chrome-text">Unknown window kind: {w.kind}</div>
  }
}

/** A native OS file drag carries the synthetic "Files" type — distinct from
 *  our internal column/block custom-MIME drags, so the two never collide. */
function hasFileDragPayload(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes("Files")
}

/** Accept by extension first (MIME types for CSV are wildly inconsistent
 *  across OSes), then fall back to the common text MIME tags. */
function isCsvLikeFile(f: File): boolean {
  if (/\.(csv|tsv|tab|txt)$/i.test(f.name)) return true
  const t = f.type
  return (
    t === "text/csv" ||
    t === "text/tab-separated-values" ||
    t === "application/csv" ||
    t === "text/plain"
  )
}

// Desktop launcher folders (file-explorer groups). Each is a folder icon on
// the desktop that opens a folder window of its `launchers` items.
const FOLDERS: { id: string; label: string; color: string }[] = [
  { id: "system", label: "System", color: "var(--brand-system-objects)" },
  { id: "semantic", label: "Semantic", color: "var(--brand-operators)" },
  { id: "knowledge", label: "Knowledge", color: "var(--brand-kg)" },
  { id: "metrics", label: "Metrics", color: "oklch(78% 0.13 95)" },
]

function iconForKind(kind: DesktopWindowState["kind"]) {
  switch (kind) {
    case "finder": return FolderOpen
    case "folder": return Folder
    case "data": return Table2
    case "csv-import": return FileCsv
    case "connections": return Plug
    case "view-apps":
    case "view-app":
    case "view-app-builder":
      return Boxes
    case "extensions": return Settings2
    case "system-objects": return Layers
    case "rvbbit-cache": return FileText
    case "cache": return Database
    case "artifact": return Wand2
    case "query-document": return FileCode2
    case "palette": return PaletteIcon
    case "pg-monitor": return Activity
    case "notifications": return Bell
    case "operators":
    case "operator-flow":
      return FlowArrow
    case "specialists":
    case "specialist-detail":
      return Brain
    case "routing": return GitBranch
    case "mcp-servers":
    case "mcp-server-detail":
      return Globe
    case "query-lens": return Eye
    case "kg-browser":
    case "kg-entity-detail":
    case "kg-merge-review":
    case "kg-explorer":
      return TreeStructure
    case "kg-extraction-runs":
      return FlowArrow
    case "data-search":
      return Search
    case "drift":
      return LineChart
    case "model-studio":
      return Brain
    case "metric-catalog":
      return Table2
    case "metric-creator":
      return Calculator
    case "metric-inspector":
      return LineChart
    case "metric-board":
      return Table2
    case "capabilities":
    case "capability-detail":
      return Package
    case "hf-deploy":
      return Sparkles
    case "warren":
    case "warren-job-detail":
      return Rocket
    case "costs": return DollarSign
    case "sync-mirror": return Database
    case "dashboards": return LayoutDashboard
    case "duck": return Boxes
    default: return Table2
  }
}

function useViewAppCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    setCount(listViewApps().length)
    const onStorage = () => setCount(listViewApps().length)
    window.addEventListener("storage", onStorage)
    window.addEventListener("rvbbit-lens:apps-changed", onStorage as EventListener)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("rvbbit-lens:apps-changed", onStorage as EventListener)
    }
  }, [])
  return count
}

function clampWorld(v: number) {
  if (!Number.isFinite(v)) return 0
  return Math.min(MAX_WORLD, Math.max(MIN_WORLD, v))
}

/** Escape a value for use as a SQL string literal. */
function sqlLit(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * Parse the text form of a regclass value into its schema + name parts.
 * Handles `schema.name`, `"schema"."name"`, `"name"`, and bare `name`.
 * For composite qualifiers we conservatively split on the first dot;
 * Postgres regclass::text never emits dots inside an unquoted identifier.
 */
function parseRegclassText(s: string): { schema: string | null; name: string } {
  const stripQuotes = (p: string) =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p
  // If the first char is a quote, find the matching close before splitting.
  if (s.startsWith('"')) {
    const close = s.indexOf('"', 1)
    if (close >= 0 && s[close + 1] === ".") {
      return { schema: s.slice(1, close).replace(/""/g, '"'), name: stripQuotes(s.slice(close + 2)) }
    }
    return { schema: null, name: s.slice(1, -1).replace(/""/g, '"') }
  }
  const dot = s.indexOf(".")
  if (dot < 0) return { schema: null, name: s }
  return { schema: s.slice(0, dot), name: stripQuotes(s.slice(dot + 1)) }
}
