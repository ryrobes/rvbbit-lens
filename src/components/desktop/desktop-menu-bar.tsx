"use client"

import { useEffect, useRef, useState } from "react"
import { Activity, AlertTriangle, CaretRight, ChevronDown, Database, Layers, Plug, Plus } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { RvbbitLogo } from "./rvbbit-logo"
import { HomeIndicator } from "./home-indicator"
import { PresentToggle } from "./present-toggle"
import { SchedulerTray } from "./scheduler-tray"
import { SceneTray } from "./scene-tray"
import { APP_NAME, APP_VERSION } from "@/lib/version"
import {
  FONT_SCALE_LABELS,
  MONO_OPTIONS,
  SANS_OPTIONS,
  type FontScale,
  type MonoFont,
  type SansFont,
} from "@/lib/desktop/fonts"
import type { Scene, SlotId, WorkspaceId } from "@/lib/desktop/types"
import { SCENE_SLOT, WORKSPACE_IDS } from "@/lib/desktop/state-store"

interface ConnectionSummary {
  id: string
  label: string
  database: string
  hasRvbbit: boolean
}

interface DesktopMenuBarProps {
  connections: ConnectionSummary[]
  activeConnectionId: string | null
  onSelectConnection: (id: string) => void
  onOpenConnections: () => void
  onOpenFinder: () => void
  onOpenSqlScratch: () => void
  onRunSqlBlocksOnScreen: () => void
  canRunSqlBlocksOnScreen: boolean
  onOpenSystemObjects: () => void
  onOpenPgMonitor: () => void
  onOpenPostgresAdmin: () => void
  onOpenNotifications: () => void
  onOpenExtensions: () => void
  onOpenRvbbitCache: () => void
  onOpenCache: () => void
  onOpenOperators: () => void
  onOpenSpecialists: () => void
  onOpenSystemLearning: () => void
  onOpenRouting: () => void
  onOpenMcpServers: () => void
  onOpenCapabilities: () => void
  onOpenCosts: () => void
  onOpenDuck: () => void
  onOpenWarren: () => void
  onOpenQueryLens: () => void
  onOpenDataSearch: () => void
  onOpenDrift: () => void
  /** Open a SQL window with given content (deep-links from the scheduler tray).
   *  `database` targets a sibling db (cron links → the cron home db). */
  onOpenSql: (sql: string, title: string, database?: string) => void
  onOpenModelStudio: () => void
  onOpenCatalogGraph: () => void
  onOpenKgBrowser: () => void
  onOpenKgExtractionRuns: () => void
  onOpenKgMergeReview: () => void
  onOpenKgExplorer: () => void
  onOpenViewApps: () => void
  onPickWallpaper: () => void
  onClearWallpaper: () => void
  onOpenAppearance: () => void
  onOpenPalette: () => void
  onSetTheme: (mode: "dark" | "light") => void
  themeMode: "dark" | "light"
  onToggleLineage: () => void
  lineageVisible: boolean
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  sansFont: SansFont
  monoFont: MonoFont
  fontScale: FontScale
  onSetSansFont: (font: SansFont) => void
  onSetMonoFont: (font: MonoFont) => void
  onSetFontScale: (scale: FontScale) => void
  hasWallpaper: boolean
  hasRvbbit: boolean
  connectionOffline?: boolean
  busy?: boolean
  activeWorkspace: SlotId
  /** Ids of workspaces that currently hold at least one window. */
  workspaceOccupancy: Set<WorkspaceId>
  onSwitchWorkspace: (id: SlotId) => void
  // ── Scenes (saved desktops) ──
  sceneName: string | null
  sceneDirty: boolean
  sceneCanSave: boolean
  sceneHasContent: boolean
  sceneSlotOccupied: boolean
  scenes: Scene[]
  currentSceneId: string | null
  onSaveScene: () => void
  onSaveSceneAs: (name: string) => void
  onOpenScene: (id: string) => void
  onRenameScene: (id: string, name: string) => void
  onDeleteScene: (id: string) => void
  onSceneNameExists: (name: string, exceptId?: string) => boolean
}

// ── Entry / Submenu shape ───────────────────────────────────────────

interface MenuEntryAction {
  kind?: "action"
  label: string
  onClick: () => void
  disabled?: boolean
  /** Optional right-aligned hint like "⌘Z" */
  shortcut?: string
  /** Optional check mark for radio-style menus. */
  selected?: boolean
}

interface MenuEntrySubmenu {
  kind: "submenu"
  label: string
  /** Optional right-aligned label, e.g. the currently-selected value. */
  value?: string
  items: MenuEntry[]
}

interface MenuEntrySeparator {
  kind: "separator"
}

type MenuEntry = MenuEntryAction | MenuEntrySubmenu | MenuEntrySeparator

export function DesktopMenuBar({
  connections,
  activeConnectionId,
  onSelectConnection,
  onOpenConnections,
  onOpenFinder,
  onOpenSqlScratch,
  onRunSqlBlocksOnScreen,
  canRunSqlBlocksOnScreen,
  onOpenSystemObjects,
  onOpenPgMonitor,
  onOpenPostgresAdmin,
  onOpenNotifications,
  onOpenExtensions,
  onOpenRvbbitCache,
  onOpenCache,
  onOpenOperators,
  onOpenSpecialists,
  onOpenSystemLearning,
  onOpenRouting,
  onOpenMcpServers,
  onOpenCapabilities,
  onOpenCosts,
  onOpenDuck,
  onOpenWarren,
  onOpenQueryLens,
  onOpenDataSearch,
  onOpenDrift,
  onOpenSql,
  onOpenModelStudio,
  onOpenCatalogGraph,
  onOpenKgBrowser,
  onOpenKgExtractionRuns,
  onOpenKgMergeReview,
  onOpenKgExplorer,
  onOpenViewApps,
  onPickWallpaper,
  onClearWallpaper,
  onOpenAppearance,
  onOpenPalette,
  onSetTheme,
  themeMode,
  onToggleLineage,
  lineageVisible,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  sansFont,
  monoFont,
  fontScale,
  onSetSansFont,
  onSetMonoFont,
  onSetFontScale,
  hasWallpaper,
  hasRvbbit,
  connectionOffline = false,
  busy,
  activeWorkspace,
  workspaceOccupancy,
  onSwitchWorkspace,
  sceneName,
  sceneDirty,
  sceneCanSave,
  sceneHasContent,
  sceneSlotOccupied,
  scenes,
  currentSceneId,
  onSaveScene,
  onSaveSceneAs,
  onOpenScene,
  onRenameScene,
  onDeleteScene,
  onSceneNameExists,
}: DesktopMenuBarProps) {
  const active = connections.find((c) => c.id === activeConnectionId) ?? null
  const [aboutOpen, setAboutOpen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)

  // Auto-dismiss the menu bar's own open <details> dropdowns when the user clicks
  // outside of them. Scoped to the menu bar (headerRef) — a document-wide query
  // would also snap shut <details> disclosure sections inside KG/capability
  // windows on any outside click.
  useEffect(() => {
    function close(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      const root = headerRef.current
      if (!target || !root) return
      // Click inside a menu-bar dropdown → leave it open.
      if (root.contains(target) && target.closest("details[open]")) return
      root.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"))
    }
    document.addEventListener("mousedown", close, true)
    return () => document.removeEventListener("mousedown", close, true)
  }, [])

  // ── File menu ────────────────────────────────────────────────────
  const fileItems: MenuEntry[] = [
    { label: "New SQL window", onClick: onOpenSqlScratch, shortcut: "⌘N" },
    {
      label: "Run SQL blocks on screen",
      onClick: onRunSqlBlocksOnScreen,
      disabled: !canRunSqlBlocksOnScreen,
    },
    { label: "Open Finder", onClick: onOpenFinder, shortcut: "⌘F" },
    { label: "View Apps", onClick: onOpenViewApps },
  ]

  // ── Edit menu ────────────────────────────────────────────────────
  const editItems: MenuEntry[] = [
    { label: "Undo", onClick: onUndo, disabled: !canUndo, shortcut: "⌘Z" },
    { label: "Redo", onClick: onRedo, disabled: !canRedo, shortcut: "⇧⌘Z" },
  ]

  // ── Database menu ────────────────────────────────────────────────
  const databaseItems: MenuEntry[] = [
    { label: "Connections...", onClick: onOpenConnections },
    { label: "Postgres Monitor", onClick: onOpenPgMonitor },
    { label: "Postgres Admin", onClick: onOpenPostgresAdmin },
    { label: "Notification Center", onClick: onOpenNotifications },
    { label: "System Objects", onClick: onOpenSystemObjects },
    { label: "Extensions", onClick: onOpenExtensions },
    ...(hasRvbbit
      ? [
          { label: "Receipts", onClick: onOpenRvbbitCache },
          { label: "Cache", onClick: onOpenCache },
          { label: "Costs", onClick: onOpenCosts },
          { label: "Operator Studio", onClick: onOpenOperators },
          { label: "Specialists", onClick: onOpenSpecialists },
          { label: "System Learning", onClick: onOpenSystemLearning },
          { label: "Adaptive Routing", onClick: onOpenRouting },
          { label: "MCP Servers", onClick: onOpenMcpServers },
          { label: "Capabilities", onClick: onOpenCapabilities },
          { label: "Warren", onClick: onOpenWarren },
          { label: "Duck Monitor", onClick: onOpenDuck },
          { label: "Query Lens", onClick: onOpenQueryLens },
          { label: "Data Search", onClick: onOpenDataSearch },
          { label: "Drift", onClick: onOpenDrift },
          { label: "Model Studio", onClick: onOpenModelStudio },
          { label: "Knowledge Graph", onClick: onOpenKgBrowser },
          { label: "KG · Extraction Runs", onClick: onOpenKgExtractionRuns },
          { label: "KG · Merge Review", onClick: onOpenKgMergeReview },
          { label: "KG · Graph Explorer", onClick: onOpenKgExplorer },
          { label: "Browse Database Graph", onClick: onOpenCatalogGraph },
        ]
      : []),
  ]

  // ── Desktop menu ─────────────────────────────────────────────────
  const desktopItems: MenuEntry[] = [
    { label: "Appearance...", onClick: onOpenAppearance },
    { label: "Set wallpaper...", onClick: onPickWallpaper },
    ...(hasWallpaper ? [{ kind: "action" as const, label: "Clear wallpaper", onClick: onClearWallpaper }] : []),
    { label: "Palette...", onClick: onOpenPalette },
    {
      label: themeMode === "dark" ? "Switch to light theme" : "Switch to dark theme",
      onClick: () => onSetTheme(themeMode === "dark" ? "light" : "dark"),
    },
    {
      label: lineageVisible ? "Hide dependency lines" : "Show dependency lines",
      onClick: onToggleLineage,
    },
    { kind: "separator" },
    {
      kind: "submenu",
      label: "Font",
      items: [
        {
          kind: "submenu",
          label: "Sans family",
          value: SANS_OPTIONS[sansFont].label,
          items: (Object.keys(SANS_OPTIONS) as SansFont[]).map((key) => ({
            label: SANS_OPTIONS[key].label,
            onClick: () => onSetSansFont(key),
            selected: key === sansFont,
          })),
        },
        {
          kind: "submenu",
          label: "Mono family",
          value: MONO_OPTIONS[monoFont].label,
          items: (Object.keys(MONO_OPTIONS) as MonoFont[]).map((key) => ({
            label: MONO_OPTIONS[key].label,
            onClick: () => onSetMonoFont(key),
            selected: key === monoFont,
          })),
        },
        {
          kind: "submenu",
          label: "Size",
          value: FONT_SCALE_LABELS[fontScale],
          items: (Object.keys(FONT_SCALE_LABELS) as FontScale[]).map((key) => ({
            label: FONT_SCALE_LABELS[key],
            onClick: () => onSetFontScale(key),
            selected: key === fontScale,
          })),
        },
      ],
    },
  ]

  return (
    <>
    <header
      ref={headerRef}
      className="pointer-events-auto fixed top-0 left-0 right-0 z-50 flex h-8 items-center justify-between border-b border-chrome-border bg-chrome-bg/90 px-3 text-[12px] text-chrome-text backdrop-blur"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <button
          type="button"
          onClick={() => setAboutOpen(true)}
          title={`About ${APP_NAME}`}
          aria-label={`About ${APP_NAME}`}
          className="-mx-1 flex items-center rounded px-1 py-1 text-foreground transition-colors hover:text-main focus:outline-none focus-visible:text-main"
        >
          <RvbbitLogo className="h-[15px] w-auto" />
        </button>
        <span className="text-chrome-text/60">·</span>
        <MenuPane label="File" items={fileItems} />
        <MenuPane label="Edit" items={editItems} />
        <MenuPane label="Database" items={databaseItems} />
        <MenuPane label="Desktop" items={desktopItems} />
        <span className="mx-0.5 h-3.5 w-px bg-chrome-border/60" />
        {/* Connection switcher + scenes live here as left-aligned dropdowns. */}
        <ConnectionPicker
          connections={connections}
          active={active}
          offline={connectionOffline}
          onSelect={onSelectConnection}
          onManage={onOpenConnections}
        />
        <SceneTray
          sceneName={sceneName}
          dirty={sceneDirty}
          canSave={sceneCanSave}
          hasContent={sceneHasContent}
          scenes={scenes}
          currentSceneId={currentSceneId}
          onSave={onSaveScene}
          onSaveAs={onSaveSceneAs}
          onOpen={onOpenScene}
          onRename={onRenameScene}
          onDelete={onDeleteScene}
          nameExists={onSceneNameExists}
        />
      </div>

      {/* Right cluster: desktop picker → present → scheduler → clock (far right). */}
      <div className="flex items-center gap-2.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {connectionOffline ? (
          <AlertTriangle className="h-3.5 w-3.5 text-danger" />
        ) : busy ? (
          <Activity className="h-3.5 w-3.5 animate-pulse text-main" />
        ) : null}
        <WorkspaceSwitcher
          activeWorkspace={activeWorkspace}
          occupancy={workspaceOccupancy}
          onSwitch={onSwitchWorkspace}
          sceneActive={activeWorkspace === SCENE_SLOT}
          sceneOccupied={sceneSlotOccupied}
          sceneDirty={sceneDirty}
        />
        <HomeIndicator />
        <PresentToggle />
        <SchedulerTray
          activeConnectionId={activeConnectionId}
          hasRvbbit={hasRvbbit}
          onOpenSql={onOpenSql}
          onOpenDrift={onOpenDrift}
        />
        <MenuBarClock />
      </div>
    </header>
    <AboutDialog
      open={aboutOpen}
      onClose={() => setAboutOpen(false)}
      hasRvbbit={hasRvbbit}
      connectionLabel={active ? active.label : null}
    />
    </>
  )
}

// ── About dialog ───────────────────────────────────────────────────
// An "About This Mac"-style panel: the logo, the app name + version,
// a one-line description, and a small meta block. Closes on Escape or
// a click outside the panel. The Help button is a deliberate stub for
// a future help surface.

function AboutDialog({
  open,
  onClose,
  hasRvbbit,
  connectionLabel,
}: {
  open: boolean
  onClose: () => void
  hasRvbbit: boolean
  connectionLabel: string | null
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[130] grid place-items-center bg-overlay backdrop-blur-sm"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`About ${APP_NAME}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[340px] rounded-xl border border-chrome-border bg-block-bg/95 p-7 text-center shadow-2xl backdrop-blur"
      >
        <RvbbitLogo className="mx-auto h-11 w-auto text-foreground" />
        <h2 className="mt-4 text-[15px] font-semibold tracking-tight text-foreground">{APP_NAME}</h2>
        <p className="mt-0.5 text-[11px] text-chrome-text">Version {APP_VERSION}</p>
        <p className="mx-auto mt-3 max-w-[260px] text-[11px] leading-relaxed text-chrome-text/80">
          A PostgreSQL desktop for the rvbbit analytical extension.
        </p>

        <div className="mx-auto mt-4 space-y-1.5 border-t border-chrome-border/60 pt-3 text-left text-[11px]">
          <AboutRow label="Connection" value={connectionLabel ?? "—"} />
          <AboutRow label="Extension" value={hasRvbbit ? "pg_rvbbit active" : "not detected"} />
        </div>

        <p className="mt-4 text-[10px] text-chrome-text/50">© 2026 rvbbit</p>

        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            disabled
            title="Coming soon"
            className="cursor-default rounded border border-chrome-border/50 px-3 py-1 text-[11px] text-chrome-text/35"
          >
            Help
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-chrome-border bg-secondary-background px-3 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/[0.06]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-chrome-text/60">{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  )
}

// ── Top-level dropdown ─────────────────────────────────────────────

function MenuPane({ label, items }: { label: string; items: MenuEntry[] }) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none rounded px-2 py-0.5 text-chrome-text hover:bg-foreground/[0.05] hover:text-foreground">
        {label}
      </summary>
      <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-chrome-border bg-chrome-bg p-1 shadow-xl">
        <MenuEntryList items={items} closeAncestor={(el) => {
          const root = el.closest("details")
          if (root) (root as HTMLDetailsElement).open = false
        }} />
      </div>
    </details>
  )
}

// ── Recursive entry list (handles separators + submenus) ───────────

function MenuEntryList({
  items,
  closeAncestor,
}: {
  items: MenuEntry[]
  closeAncestor: (el: HTMLElement) => void
}) {
  return (
    <>
      {items.map((item, i) => {
        if ((item as MenuEntrySeparator).kind === "separator") {
          return <div key={`sep-${i}`} className="my-1 border-t border-chrome-border/60" />
        }
        if ((item as MenuEntrySubmenu).kind === "submenu") {
          const sub = item as MenuEntrySubmenu
          return (
            <SubmenuEntry key={sub.label} entry={sub} closeAncestor={closeAncestor} />
          )
        }
        const a = item as MenuEntryAction
        return (
          <button
            key={a.label}
            type="button"
            disabled={a.disabled}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[12px] text-chrome-text",
              a.disabled
                ? "cursor-not-allowed opacity-40"
                : "hover:bg-foreground/[0.06] hover:text-foreground",
            )}
            onClick={(e) => {
              if (a.disabled) return
              a.onClick()
              closeAncestor(e.currentTarget)
            }}
          >
            <span className="flex items-center gap-2 truncate">
              {a.selected ? <span className="text-main">✓</span> : <span className="w-2" />}
              <span className="truncate">{a.label}</span>
            </span>
            {a.shortcut ? (
              <span className="text-[10px] text-chrome-text/70">{a.shortcut}</span>
            ) : null}
          </button>
        )
      })}
    </>
  )
}

function SubmenuEntry({
  entry,
  closeAncestor,
}: {
  entry: MenuEntrySubmenu
  closeAncestor: (el: HTMLElement) => void
}) {
  // Explicit hover state per entry. The earlier CSS approach used a
  // named `group/sub` shared across nesting levels — Tailwind's
  // group-hover matches *any* same-named ancestor, so hovering the
  // parent "Font" row opened all three child popovers at once. A
  // local useState keyed to this exact wrapper has no such collision.
  const [open, setOpen] = useState(false)
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px]",
          open ? "bg-foreground/[0.06] text-foreground" : "text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        <span className="flex items-center gap-2 truncate">
          <span className="w-2" />
          <span className="truncate">{entry.label}</span>
        </span>
        <span className="flex items-center gap-1">
          {entry.value ? (
            <span className="max-w-[100px] truncate text-[10px] text-chrome-text/70">{entry.value}</span>
          ) : null}
          <CaretRight className="h-3 w-3 opacity-60" />
        </span>
      </button>
      {/* Side popover. left-full sits it flush to the right edge; the
          -4px margin overlaps slightly so the cursor never crosses a
          dead gap between row and popover. */}
      {open ? (
        <div className="absolute left-full top-0 z-50 ml-[-4px] w-52 rounded-md border border-chrome-border bg-chrome-bg p-1 shadow-xl">
          <MenuEntryList items={entry.items} closeAncestor={closeAncestor} />
        </div>
      ) : null}
    </div>
  )
}

// ── Menu-bar clock (local time, no seconds) ────────────────────────

function MenuBarClock() {
  // null until mounted so SSR and client agree (no hydration mismatch); ticking is
  // done in timer callbacks (not synchronously in the effect body).
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    const tick = () => setNow(new Date())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 20_000) // no seconds shown — a coarse tick is plenty
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [])
  if (!now) return null
  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true })
  return (
    <span className="hidden items-center gap-1.5 tabular-nums sm:inline-flex" title={now.toString()}>
      <span className="text-chrome-text/55">{date}</span>
      <span className="text-foreground">{time}</span>
    </span>
  )
}

// ── Workspace switcher (5 desktops) ────────────────────────────────

function WorkspaceSwitcher({
  activeWorkspace,
  occupancy,
  onSwitch,
  sceneActive,
  sceneOccupied,
  sceneDirty,
}: {
  activeWorkspace: SlotId
  occupancy: Set<WorkspaceId>
  onSwitch: (id: SlotId) => void
  sceneActive: boolean
  sceneOccupied: boolean
  sceneDirty: boolean
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded border border-chrome-border bg-secondary-background/60 p-0.5"
      title="Workspaces — Alt+1…5 · Scene slot Alt+6"
    >
      {WORKSPACE_IDS.map((id) => {
        const isActive = id === activeWorkspace
        const occupied = occupancy.has(id)
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSwitch(id)}
            aria-pressed={isActive}
            title={`Workspace ${id}${occupied ? "" : " (empty)"}`}
            className={cn(
              "relative h-5 w-5 rounded text-[11px] font-medium tabular-nums transition-colors",
              isActive
                ? "bg-main text-main-foreground"
                : occupied
                  ? "text-foreground hover:bg-foreground/[0.08]"
                  : "text-chrome-text/45 hover:bg-foreground/[0.06] hover:text-chrome-text",
            )}
          >
            {id}
            {occupied && !isActive ? (
              <span className="absolute bottom-0.5 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-main" />
            ) : null}
          </button>
        )
      })}
      {/* Scene slot — the loadable "document" desktop, peer of 1–5. */}
      <span className="mx-px h-3 w-px bg-chrome-border" />
      <button
        type="button"
        onClick={() => onSwitch(SCENE_SLOT)}
        aria-pressed={sceneActive}
        title={`Scene slot — Alt+6${sceneOccupied ? "" : " (empty)"}`}
        className={cn(
          "relative flex h-5 w-5 items-center justify-center rounded transition-colors",
          sceneActive
            ? "bg-main text-main-foreground"
            : sceneOccupied
              ? "text-foreground hover:bg-foreground/[0.08]"
              : "text-chrome-text/45 hover:bg-foreground/[0.06] hover:text-chrome-text",
        )}
      >
        <Layers className="h-3 w-3" />
        {sceneDirty && !sceneActive ? (
          <span className="absolute bottom-0.5 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-main" />
        ) : null}
      </button>
    </div>
  )
}

function ConnectionPicker({
  connections,
  active,
  offline,
  onSelect,
  onManage,
}: {
  connections: ConnectionSummary[]
  active: ConnectionSummary | null
  offline: boolean
  onSelect: (id: string) => void
  onManage: () => void
}) {
  return (
    <details className="group relative">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded border bg-secondary-background px-2 py-0.5 text-foreground hover:bg-foreground/[0.06]",
          offline ? "border-danger/60 text-danger" : "border-chrome-border",
        )}
        title={offline ? "Active database is unreachable" : undefined}
      >
        {offline ? (
          <AlertTriangle className="h-3.5 w-3.5 text-danger" />
        ) : (
          <Plug className="h-3.5 w-3.5 text-main" />
        )}
        <span className="max-w-[200px] truncate">
          {offline && active ? `${active.label} · offline` : active ? `${active.label} · ${active.database}` : "No connection"}
        </span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </summary>
      <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-chrome-border bg-chrome-bg p-1 shadow-xl">
        {connections.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-chrome-text/70">No saved connections.</div>
        ) : null}
        {connections.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cn(
              "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-foreground/[0.06]",
              c.id === active?.id ? "text-foreground bg-foreground/[0.04]" : "text-chrome-text",
            )}
            onClick={() => onSelect(c.id)}
          >
            <span className="flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5" />
              <span className="truncate">{c.label}</span>
              <span className="text-chrome-text/60">·</span>
              <span className="truncate text-chrome-text/80">{c.database}</span>
            </span>
            {c.hasRvbbit ? (
              <span className="rounded-full bg-rvbbit-accent/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-rvbbit-accent">
                ae
              </span>
            ) : null}
          </button>
        ))}
        <div className="my-1 border-t border-chrome-border" />
        <button
          type="button"
          onClick={onManage}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12px] text-main hover:bg-foreground/[0.06]"
        >
          <Plus className="h-3.5 w-3.5" />
          Manage connections...
        </button>
      </div>
    </details>
  )
}
