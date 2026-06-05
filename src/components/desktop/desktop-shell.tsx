"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  Bell,
  Boxes,
  Brain,
  LineChart,
  Database,
  DollarSign,
  Eye,
  FileCode2,
  FileText,
  FlowArrow,
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
  Settings2,
  Table2,
  TreeStructure,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "@/lib/icons"
import { PhosphorIconProvider } from "@/components/icon-provider"
import { DesktopIcon } from "./desktop-icon"
import { DesktopMenuBar } from "./desktop-menu-bar"
import { LineageOverlay } from "./lineage-overlay"
import { DesktopParamsSurface } from "./desktop-params-surface"
import { DesktopWindow } from "./desktop-window"
import { FinderWindow } from "./finder-window"
import { DataGridWindow } from "./data-grid-window"
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
import { CapabilitiesWindow } from "./capabilities-window"
import { CapabilityDetailWindow } from "./capability-detail-window"
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
  clampViewport,
  DEFAULT_VIEWPORT,
  emptyWorkspaces,
  loadDesktopState,
  saveDesktopState,
  WORKSPACE_IDS,
} from "@/lib/desktop/state-store"
import type { ConnectionRecord, SchemaSnapshot } from "@/lib/db/types"
import type {
  RvbbitCachePayload,
  CachePayload,
  ArtifactPayload,
  DataPayload,
  DataSearchPayload,
  DriftPayload,
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
  ExtensionsPayload,
  FinderPayload,
  NotificationsPayload,
  CostsPayload,
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
  WarrenPayload,
  WarrenJobDetailPayload,
  PalettePayload,
  PgMonitorPayload,
  QueryDocumentPayload,
  ReactiveBlockState,
  SystemObjectsPayload,
  ViewAppBuilderPayload,
  ViewAppPayload,
  ViewAppsPayload,
  WorkspaceCanvas,
  WorkspaceId,
} from "@/lib/desktop/types"

interface WorkspaceTransition {
  from: WorkspaceId
  to: WorkspaceId
  dir: "forward" | "backward"
}
import { randomUUID } from "@/lib/uuid"
import { listViewApps } from "@/lib/desktop/view-apps"
import {
  applyRollupOp,
  buildRollupQuery,
  effectiveRollup,
  grainTruncExpr,
  previewSqlForTable,
  quoteSqlIdent,
  rollupSpecColumns,
  rollupSpecFromColumns,
} from "@/lib/desktop/sql-builder"
import { fetchKgEvidenceBySource, fetchPrimaryKeyColumn } from "@/lib/rvbbit/kg"
import { buildDesktopRuntimeGraph, paramKey, sameParamValue, sourceSqlForPayload, uniqueBlockName } from "@/lib/desktop/reactive-sql"
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

export function DesktopShell() {
  const [connections, setConnections] = useState<SanitizedConnection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  // ── Workspaces ────────────────────────────────────────────────────
  //
  // Five independent canvases, all kept mounted at once. The live
  // values `windows` / `zSeed` / `desktopParams` / `focusedWindowId`
  // are *derived* from the active workspace; the wrapper setters below
  // route any mutation back into workspaces[activeWorkspace]. Every
  // existing handler that calls setWindows(...) etc. keeps working
  // verbatim — only the two that nest setState (focus, openWindow)
  // were rewritten through mutateCanvas.
  const [workspaces, setWorkspaces] = useState<Record<WorkspaceId, WorkspaceCanvas>>(
    () => emptyWorkspaces(),
  )
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("1")
  const [wsTransition, setWsTransition] = useState<WorkspaceTransition | null>(null)
  const [runSignals, setRunSignals] = useState<Record<string, number>>({})
  const [viewport, setViewport] = useState<DesktopViewportState>(DEFAULT_VIEWPORT)

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

  // Latest active connection, for async handlers (e.g. the pivot
  // distinct-value probe) that fire outside React's render flow.
  const activeConnectionIdRef = useRef(activeConnectionId)
  activeConnectionIdRef.current = activeConnectionId

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

  useEffect(() => {
    if (!stateLoadedRef.current) return
    const handle = setTimeout(() => {
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
    }, 400)
    return () => clearTimeout(handle)
  }, [windows, desktopParams, zSeed])

  const applySnapshot = useCallback((snap: DesktopSnapshot) => {
    // Don't let the debounce push this restoration onto undoStack.
    skipNextSnapshotRef.current = true
    setWindows(snap.windows)
    setDesktopParams(snap.params)
    setZSeed(snap.zSeed)
  }, [])

  const undo = useCallback(() => {
    const past = undoStackRef.current
    if (past.length === 0) return
    const current: DesktopSnapshot = { windows, params: desktopParams, zSeed }
    redoStackRef.current.push(cloneSnapshot(current))
    const prev = past.pop()!
    applySnapshot(prev)
    setUndoTick((t) => t + 1)
  }, [applySnapshot, desktopParams, windows, zSeed])

  const redo = useCallback(() => {
    const future = redoStackRef.current
    if (future.length === 0) return
    const current: DesktopSnapshot = { windows, params: desktopParams, zSeed }
    undoStackRef.current.push(cloneSnapshot(current))
    const next = future.pop()!
    applySnapshot(next)
    setUndoTick((t) => t + 1)
  }, [applySnapshot, desktopParams, windows, zSeed])

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
    saveDesktopState({ workspaces, activeWorkspace, viewport, activeConnectionId })
  }, [workspaces, activeWorkspace, viewport, activeConnectionId])

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
  const switchWorkspace = useCallback((target: WorkspaceId) => {
    setActiveWorkspace((current) => {
      if (current === target) return current
      const dir: WorkspaceTransition["dir"] =
        Number(target) > Number(current) ? "forward" : "backward"
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

  // ── LISTEN/NOTIFY: channel set + SSE feed ───────────────────────────
  //
  // The set of channels the server listens on is the union of every
  // data window's notifyChannel (across all five workspaces) and the
  // user's "watched" channels. channelKey is the stable string the SSE
  // effect keys off — when it changes, the EventSource reconnects.
  const windowChannels = useMemo(() => {
    const set = new Set<string>()
    for (const id of WORKSPACE_IDS) {
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
      const idsToRefresh: string[] = []
      for (const id of WORKSPACE_IDS) {
        for (const w of ws[id].windows) {
          if (w.kind !== "data") continue
          if ((w.payload as DataPayload | undefined)?.notifyChannel === data.channel) {
            idsToRefresh.push(w.id)
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
    multiValueAction?: "add" | "remove" | "toggle"
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
      let value = input.value
      if (operator === "in") {
        const cur = existing?.operator === "in" && Array.isArray(existing.value) ? existing.value : []
        const action = input.multiValueAction ?? "toggle"
        const present = cur.some((v) => sameParamValue(v, input.value))
        const next = action === "add"
          ? present ? cur : [...cur, input.value]
          : action === "remove"
            ? cur.filter((v) => !sameParamValue(v, input.value))
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
        value,
        dataTypeId: input.dataTypeId,
        type: input.type,
        updatedAt: new Date().toISOString(),
      }
      return [np, ...prev.filter((p) => p.key !== key)]
    })
  }, [])

  const subscribeParam = useCallback((targetWindowId: string, key: string, targetField?: string) => {
    const param = desktopParams.find((p) => p.key === key)
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
        const next = { key, targetField: targetField ?? param.field }
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
  }, [desktopParams])

  // ── Helpers to open specific window kinds ───────────────────────────

  const openFinder = useCallback(() => {
    const existing = windows.find((w) => w.kind === "finder")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "finder",
      title: "Finder",
      x: 40, y: 40, width: 360, height: 560,
      payload: { kind: "finder" } satisfies FinderPayload,
    })
  }, [focus, openWindow, windows])

  const openConnections = useCallback(() => {
    const existing = windows.find((w) => w.kind === "connections")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "connections",
      title: "Connections",
      x: 200, y: 90, width: 560, height: 480,
      payload: { kind: "connections" },
    })
  }, [focus, openWindow, windows])

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
        const already = windows.some(
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
    [activeConnectionId, openWindow, windows],
  )

  const openViewApps = useCallback(() => {
    const existing = windows.find((w) => w.kind === "view-apps")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "view-apps",
      title: "View Apps",
      x: 240, y: 120, width: 720, height: 480,
      payload: { kind: "view-apps" } satisfies ViewAppsPayload,
    })
  }, [focus, openWindow, windows])

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
    const existing = windows.find((w) => w.kind === "extensions")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "extensions",
      title: "Extensions",
      x: 180, y: 100, width: 600, height: 440,
      payload: { kind: "extensions" } satisfies ExtensionsPayload,
    })
  }, [focus, openWindow, windows])

  const openRvbbitCache = useCallback(() => {
    const existing = windows.find((w) => w.kind === "rvbbit-cache")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "rvbbit-cache",
      title: "Receipts",
      x: 200, y: 110, width: 760, height: 500,
      payload: { kind: "rvbbit-cache", initialView: "receipts" } satisfies RvbbitCachePayload,
    })
  }, [focus, openWindow, windows])

  const openCache = useCallback(() => {
    const existing = windows.find((w) => w.kind === "cache")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "cache",
      title: "Cache",
      x: 230, y: 130, width: 780, height: 520,
      payload: { kind: "cache", initialView: "synth" } satisfies CachePayload,
    })
  }, [focus, openWindow, windows])

  const openPgMonitor = useCallback(() => {
    const existing = windows.find((w) => w.kind === "pg-monitor")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "pg-monitor",
      title: "Postgres Monitor",
      x: 120, y: 80, width: 940, height: 720,
      payload: { kind: "pg-monitor" } satisfies PgMonitorPayload,
    })
  }, [focus, openWindow, windows])

  const openOperators = useCallback(() => {
    const existing = windows.find((w) => w.kind === "operators")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "operators",
      title: "Operators",
      x: 160, y: 90, width: 460, height: 540,
      payload: { kind: "operators" } satisfies OperatorsPayload,
    })
  }, [focus, openWindow, windows])

  const openOperatorFlow = useCallback(
    (operatorName: string | null, receiptId?: string | null) => {
      if (operatorName) {
        const existing = windows.find(
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
    [focus, openWindow, windows, updatePayload],
  )

  const openSpecialists = useCallback(() => {
    const existing = windows.find((w) => w.kind === "specialists")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "specialists",
      title: "Specialists",
      x: 150, y: 84, width: 768, height: 680,
      payload: { kind: "specialists" } satisfies SpecialistsPayload,
    })
  }, [focus, openWindow, windows])

  const openRouting = useCallback(() => {
    const existing = windows.find((w) => w.kind === "routing")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "routing",
      title: "Adaptive Routing",
      x: 120, y: 70, width: 1100, height: 740,
      payload: { kind: "routing" } satisfies RoutingPayload,
    })
  }, [focus, openWindow, windows])

  const openMcpServers = useCallback(() => {
    const existing = windows.find((w) => w.kind === "mcp-servers")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "mcp-servers",
      title: "MCP Servers",
      x: 150, y: 84, width: 820, height: 680,
      payload: { kind: "mcp-servers" } satisfies McpServersPayload,
    })
  }, [focus, openWindow, windows])

  const openCosts = useCallback((initialFilter?: CostsPayload["initialFilter"]) => {
    const existing = windows.find((w) => w.kind === "costs")
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
  }, [focus, openWindow, windows, updatePayload])

  const openDuck = useCallback(() => {
    const existing = windows.find((w) => w.kind === "duck")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "duck",
      title: "Duck Monitor",
      x: 132, y: 70, width: 1000, height: 700,
      payload: { kind: "duck" } satisfies DuckPayload,
    })
  }, [focus, openWindow, windows])

  const openCapabilities = useCallback((tagFilter?: string | null) => {
    const existing = windows.find((w) => w.kind === "capabilities")
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
  }, [focus, openWindow, windows, updatePayload])

  const openCapabilityDetail = useCallback(
    (catalogId: string, initialTab?: CapabilityDetailPayload["initialTab"]) => {
      const existing = windows.find(
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
    [focus, openWindow, windows, updatePayload],
  )

  const openWarren = useCallback(
    (initialTab?: WarrenPayload["initialTab"]) => {
      const existing = windows.find((w) => w.kind === "warren")
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
    [focus, openWindow, windows, updatePayload],
  )

  const openWarrenJob = useCallback(
    (jobId: string, jobName?: string | null) => {
      const existing = windows.find(
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
    [focus, openWindow, windows],
  )

  const openQueryLens = useCallback((queryId?: string | null) => {
    const existing = windows.find((w) => w.kind === "query-lens")
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
  }, [focus, openWindow, windows, updatePayload])

  const openKgBrowser = useCallback((graphId?: string | null) => {
    const existing = windows.find((w) => w.kind === "kg-browser")
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
  }, [focus, openWindow, windows, updatePayload])

  const openKgEntity = useCallback(
    (
      entityKind: string,
      entityLabel: string,
      graphId: string,
      source?: KgEntitySource,
      nodeId?: number | null,
    ) => {
      // Match an existing window for the same (nodeId) or (graphId, kind, label).
      const existing = windows.find((w) => {
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
    [focus, openWindow, windows, updatePayload],
  )

  const openKgExplorer = useCallback(
    (
      graphId?: string,
      seedKind?: string | null,
      seedLabel?: string | null,
    ) => {
      const existing = windows.find((w) => w.kind === "kg-explorer")
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
    [focus, openWindow, windows, updatePayload],
  )

  const openDataSearch = useCallback(
    (initialQuery?: string) => {
      const existing = windows.find((w) => w.kind === "data-search")
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
    [focus, openWindow, windows, updatePayload],
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
    const existing = windows.find((w) => w.kind === "drift")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "drift",
      title: "Drift",
      x: 180, y: 100, width: 760, height: 660,
      payload: { kind: "drift" } satisfies DriftPayload,
    })
  }, [focus, openWindow, windows])

  const openModelStudio = useCallback((modelName?: string) => {
    const existing = windows.find((w) => w.kind === "model-studio")
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
  }, [focus, openWindow, windows, updatePayload])

  const openKgExtractionRuns = useCallback(
    (graphId?: string | null, runId?: number | null) => {
      const existing = windows.find((w) => w.kind === "kg-extraction-runs")
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
    [focus, openWindow, windows, updatePayload],
  )

  const openKgMergeReview = useCallback(
    (graphId?: string | null, nodeKindFilter?: string) => {
      const existing = windows.find((w) => w.kind === "kg-merge-review")
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
    [focus, openWindow, windows, updatePayload],
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
      const existing = windows.find(
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
    [activeConnectionId, focus, openWindow, windows],
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
    const existing = windows.find(
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
  }, [focus, openWindow, windows])

  const openSpecialistDetail = useCallback((specialistName: string) => {
    const existing = windows.find(
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
  }, [focus, openWindow, windows])

  const openNotifications = useCallback(() => {
    const existing = windows.find((w) => w.kind === "notifications")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "notifications",
      title: "Notification Center",
      x: 220, y: 120, width: 560, height: 520,
      payload: { kind: "notifications" } satisfies NotificationsPayload,
    })
  }, [focus, openWindow, windows])

  const openPalette = useCallback(() => {
    const existing = windows.find((w) => w.kind === "palette")
    if (existing) return focus(existing.id)
    openWindow({
      id: randomUUID(),
      kind: "palette",
      title: "Palette",
      x: 180, y: 130, width: 620, height: 480,
      payload: { kind: "palette" } satisfies PalettePayload,
    })
  }, [focus, openWindow, windows])

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

  // ── Canvas drag-drop ───────────────────────────────────────────────

  const screenToWorld = useCallback((screen: { x: number; y: number }) => ({
    x: (screen.x - viewport.x) / viewport.scale,
    y: (screen.y - viewport.y) / viewport.scale,
  }), [viewport.x, viewport.y, viewport.scale])

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
      const { spec: nextSpec, changed } = applyRollupOp(baseSpec, payload.columns, op)
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
          // doesn't show stale text after a merge.
          view: p.view ? { ...p.view, sqlDraft: undefined } : p.view,
          lineage: { ...lin, parentBlockName, columns: rollupSpecColumns(nextSpec), rollup: nextSpec },
          reactive: nextReactive,
        } satisfies DataPayload,
      }
    }))
  }, [pivotColumnInWindow])

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

  const handleCanvasDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    if (!hasColumnDragPayload(e.dataTransfer) && !hasBlockDragPayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }, [])

  const handleCanvasDrop = useCallback((e: React.DragEvent<HTMLElement>) => {
    const pos = screenToWorld({ x: e.clientX, y: e.clientY })
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
  }, [openBlockReference, openColumnAggregate, screenToWorld])

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

      // Alt+1..5 — jump to a workspace. Alt+digit rarely collides with
      // browser chrome (unlike Ctrl/Cmd+digit which switches tabs).
      if (e.altKey && !cmd && /^[1-5]$/.test(e.key)) {
        e.preventDefault()
        switchWorkspace(e.key as WorkspaceId)
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

  return (
    <PhosphorIconProvider>
    <div
      className="rvbbit-lens-desktop relative h-screen w-screen overflow-hidden bg-background text-foreground"
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onMouseDown={handleDesktopMouseDown}
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
      />

      <DesktopParamsSurface params={desktopParams} onClear={removeParam} />

      {lineageVisible && !wsTransition ? (
        <LineageOverlay windows={windows} params={desktopParams} />
      ) : null}

      {wallpaperError ? (
        <div className="pointer-events-auto fixed left-1/2 top-12 z-40 -translate-x-1/2 rounded-base border border-danger/60 bg-danger/15 px-3 py-1 text-[11px] text-danger">
          {wallpaperError}
        </div>
      ) : null}

      {/* Desktop icon grid (fixed shortcuts) */}
      <div className="pointer-events-none absolute inset-x-0 top-10 z-0 grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3 px-6 pt-2">
        <div className="pointer-events-auto contents">
          <DesktopIcon label="Finder" icon={FolderOpen} onActivate={openFinder} iconColor="var(--brand-finder)" />
          <DesktopIcon label="SQL Scratch" icon={FileCode2} onActivate={openSqlScratch} iconColor="var(--brand-sql-scratch)" />
          <DesktopIcon label="View Apps" icon={Boxes} sublabel={viewAppCount ? `${viewAppCount} saved` : undefined} onActivate={openViewApps} iconColor="var(--brand-view-apps)" />
          <DesktopIcon label="System Objects" icon={Layers} onActivate={() => openSystemObjects("tables")} iconColor="var(--brand-system-objects)" />
          <DesktopIcon label="Extensions" icon={Settings2} onActivate={openExtensions} iconColor="var(--brand-extensions)" />
          <DesktopIcon label="Connections" icon={Plug} onActivate={openConnections} iconColor="var(--brand-connections)" />
          <DesktopIcon label="Monitor" icon={Activity} onActivate={openPgMonitor} iconColor="var(--brand-pg-monitor)" />
          {hasRvbbit ? (
            <DesktopIcon label="Receipts" icon={FileText} sublabel={schema?.rvbbitVersion ?? undefined} onActivate={openRvbbitCache} iconColor="var(--brand-rvbbit-cache)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Cache" icon={Database} onActivate={openCache} iconColor="var(--brand-cache)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Operators" icon={FlowArrow} onActivate={openOperators} iconColor="var(--brand-operators)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Specialists" icon={Brain} onActivate={openSpecialists} iconColor="var(--brand-specialists)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Routing" icon={GitBranch} onActivate={openRouting} iconColor="var(--brand-routing)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="MCP" icon={Globe} onActivate={openMcpServers} iconColor="var(--brand-mcp)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Capabilities" icon={Package} onActivate={() => openCapabilities()} iconColor="var(--brand-capability)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Warren" icon={Rocket} onActivate={() => openWarren()} iconColor="var(--brand-warren)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Costs" icon={DollarSign} onActivate={() => openCosts()} iconColor="var(--brand-costs)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Duck" icon={Boxes} onActivate={openDuck} iconColor="var(--brand-duck)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Query Lens" icon={Eye} onActivate={() => openQueryLens()} iconColor="var(--brand-query-lens)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Data Search" icon={Search} onActivate={() => openDataSearch()} iconColor="var(--brand-kg)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Drift" icon={LineChart} onActivate={() => openDrift()} iconColor="var(--brand-kg)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Model Studio" icon={Brain} onActivate={() => openModelStudio()} iconColor="var(--brand-specialists)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Knowledge Graph" icon={TreeStructure} onActivate={() => openKgBrowser()} iconColor="var(--brand-kg)" />
          ) : null}
          {hasRvbbit ? (
            <DesktopIcon label="Graph Explorer" icon={TreeStructure} onActivate={() => openKgExplorer()} iconColor="var(--brand-kg)" />
          ) : null}
        </div>
      </div>

      {/* Workspace layers — all five canvases stay mounted at once so
          switching preserves window state and the slide animation has
          real windows to move. Inactive layers are display:none; the
          active one (and, mid-switch, the entering + exiting pair)
          animate via CSS keyframes. */}
      {WORKSPACE_IDS.map((wsId) => {
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
          <div
            key={wsId}
            className={cn(
              "av-ws-layer pointer-events-none absolute inset-0 z-10 pt-8",
              layerClass,
            )}
            aria-hidden={!isActive}
          >
            {canvas.windows.map((w) => {
              // Column-aggregate windows are drop targets for additional
              // columns from their *exact* parent (same parent window +
              // same source relation). Anything else falls through to
              // the canvas drop, which spawns a fresh block.
              const columnDropAcceptsFrom = (() => {
                if (w.kind !== "data") return null
                const lin = (w.payload as DataPayload | undefined)?.lineage
                if (!lin || lin.kind !== "column-aggregate") return null
                // A detached (custom-SQL) window returns null → not a drop
                // target, so dropping a column spawns a fresh block instead.
                const spec = effectiveRollup(lin)
                if (!spec) return null
                return {
                  parentWindowId: lin.parentWindowId,
                  relationKey: lin.relationKey,
                  measures: spec.measures,
                }
              })()
              return (
              <DesktopWindow
                key={w.id}
                window={w}
                icon={iconForKind(w.kind)}
                focused={isActive && w.id === canvas.focusedWindowId}
                onFocus={focus}
                onClose={close}
                onMinimize={minimize}
                onMove={move}
                onResize={resize}
                viewportScale={viewport.scale}
                columnDropAcceptsFrom={columnDropAcceptsFrom}
                onColumnMerge={(payload, op) => mergeColumnIntoWindow(w.id, payload, op)}
              >
                {renderWindowContent(w, {
                  activeConnectionId,
                  hasRvbbit,
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
                  openExtensions,
                  openRvbbitCache,
                  openCache,
                  openConnections,
                  reloadSchema: () => activeConnectionId && void loadSchema(activeConnectionId),
                  reloadConnections: loadConnections,
                  updatePayload,
                  windows: canvas.windows,
                  params: canvas.params,
                  runSignal: runSignals[w.id] ?? 0,
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
                  workspaceActive: isActive,
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
                  openCosts,
                  openDuck,
                  openCapabilities,
                  openCapabilityDetail,
                  openWarren,
                  openWarrenJob,
                })}
              </DesktopWindow>
              )
            })}
          </div>
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
  openCosts: (initialFilter?: CostsPayload["initialFilter"]) => void
  openDuck: () => void
  openCapabilities: (tagFilter?: string | null) => void
  openCapabilityDetail: (
    catalogId: string,
    initialTab?: CapabilityDetailPayload["initialTab"],
  ) => void
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
    dataTypeId?: number
    type?: string
  }) => void
  subscribeParam: (targetWindowId: string, key: string, targetField?: string) => void
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
          allWindows={ctx.windows}
          params={ctx.params}
          runSignal={ctx.runSignal}
          onChangePayload={(mut) => ctx.updatePayload(w.id, (p) => mut(p as DataPayload))}
          onSaveAsViewApp={(sql) => ctx.openViewAppBuilder({ initialSql: sql })}
          onEmitParam={ctx.emitParam}
          onSubscribeParam={(key, field) => ctx.subscribeParam(w.id, key, field)}
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
    case "capabilities":
      return (
        <CapabilitiesWindow
          activeConnectionId={ctx.activeConnectionId}
          hasRvbbit={ctx.hasRvbbit}
          initialTag={(w.payload as CapabilitiesPayload | undefined)?.tagFilter ?? null}
          onOpenCapability={(id) => ctx.openCapabilityDetail(id)}
          onOpenWarren={() => ctx.openWarren()}
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

function iconForKind(kind: DesktopWindowState["kind"]) {
  switch (kind) {
    case "finder": return FolderOpen
    case "data": return Table2
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
    case "capabilities":
    case "capability-detail":
      return Package
    case "warren":
    case "warren-job-detail":
      return Rocket
    case "costs": return DollarSign
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
