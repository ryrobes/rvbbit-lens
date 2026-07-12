"use client"

import { useCallback, useMemo, useState, type MouseEvent } from "react"

import { usePolling } from "@/lib/desktop/use-polling"
import { AppWindow, CaretRight, Folder, LayoutDashboard, Plus, Table2 } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fetchDashboards, type DashboardRow } from "@/lib/rvbbit/dashboards"
import { ContextMenu, type ContextMenuState } from "./context-menu"
import { useWorkspaceActive } from "./workspace-active-context"

/**
 * Apps — the launcher-style browser over published live apps. Same catalog the
 * Dashboards window curates, different posture: folders per team/category,
 * icons per app, and every app opens STANDALONE (its own window on the canvas,
 * no gallery rail) so several can run side by side and cross-filter through
 * the desktop param bus.
 */
interface Props {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenApp: (slug: string, name?: string) => void
  onCreateShortcut?: (dashboard: DashboardRow) => void
}

const UNFILED = "—"

function StatusDot({ status }: { status: string }) {
  const live = status === "live"
  return (
    <span
      title={live ? "live data dependencies detected" : "stored or static"}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${live ? "bg-emerald-400" : "bg-amber-500/70"}`}
    />
  )
}

export function AppsWindow({ activeConnectionId, hasRvbbit, onOpenApp, onCreateShortcut }: Props) {
  const workspaceActive = useWorkspaceActive()
  const [rows, setRows] = useState<DashboardRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [view, setView] = useState<"icons" | "list">(() => {
    if (typeof window === "undefined") return "icons"
    return window.localStorage.getItem("rvbbit.apps.view") === "list" ? "list" : "icons"
  })
  const changeView = (v: "icons" | "list") => {
    setView(v)
    try {
      window.localStorage.setItem("rvbbit.apps.view", v)
    } catch {
      /* private mode etc. — view just won't persist */
    }
  }

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchDashboards(activeConnectionId)
    setError(r.error ?? null)
    setRows(r.dashboards)
  }, [activeConnectionId])

  usePolling(reload, 8000, {
    enabled: !!activeConnectionId && hasRvbbit && workspaceActive,
    resetKey: activeConnectionId,
  })

  const byTeam = useMemo(() => {
    const m = new Map<string, DashboardRow[]>()
    for (const d of rows) {
      const k = d.team?.trim() || UNFILED
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(d)
    }
    for (const list of m.values()) list.sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug))
    return m
  }, [rows])

  const teams = useMemo(
    () => [...byTeam.keys()].filter((t) => t !== UNFILED).sort((a, b) => a.localeCompare(b)),
    [byTeam],
  )
  const unfiled = byTeam.get(UNFILED) ?? []
  const inFolder = folder ? (byTeam.get(folder) ?? []) : []

  const openAppMenu = (event: MouseEvent, app: DashboardRow) => {
    if (!onCreateShortcut) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{
        id: "add-shortcut",
        label: "Add to Desktop",
        icon: Plus,
        onSelect: () => onCreateShortcut(app),
      }],
    })
  }

  const appTile = (d: DashboardRow) => (
    <button
      key={d.slug}
      onClick={() => onOpenApp(d.slug, d.name || d.slug)}
      onContextMenu={(event) => openAppMenu(event, d)}
      title={d.description ?? d.name}
      className="group flex w-28 flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center hover:bg-foreground/6"
    >
      <span className="relative grid h-12 w-12 place-items-center rounded-xl border border-rvbbit-accent/30 bg-rvbbit-accent/10 group-hover:border-rvbbit-accent/60">
        <AppWindow className="h-6 w-6 text-rvbbit-accent" />
        <span className="absolute right-1 top-1">
          <StatusDot status={d.status} />
        </span>
      </span>
      <span className="line-clamp-2 w-full text-[11px] leading-tight text-foreground/85">{d.name || d.slug}</span>
      <span className="font-mono text-[9px] text-chrome-text/40">v{d.latest_version}</span>
    </button>
  )

  // List view: flat rows (team as a column) — folders collapse into a filter.
  const appRow = (d: DashboardRow) => (
    <button
      key={d.slug}
      onClick={() => onOpenApp(d.slug, d.name || d.slug)}
      onContextMenu={(event) => openAppMenu(event, d)}
      title={d.description ?? d.name}
      className="grid w-full grid-cols-[14px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2.2fr)_52px] items-center gap-2 rounded px-2 py-1 text-left hover:bg-foreground/6"
    >
      <span className="flex items-center">
        <StatusDot status={d.status} />
      </span>
      <span className="truncate text-[11px] text-foreground/90">{d.name || d.slug}</span>
      <span className="truncate text-[10px] text-chrome-text/55">{d.team?.trim() || "—"}</span>
      <span className="truncate text-[10px] text-chrome-text/45">{d.description ?? ""}</span>
      <span className="text-right font-mono text-[9px] text-chrome-text/40">v{d.latest_version}</span>
    </button>
  )

  const listRows = useMemo(() => {
    const src = folder ? (byTeam.get(folder) ?? []) : rows
    return [...src].sort(
      (a, b) =>
        (a.team?.trim() || "￿").localeCompare(b.team?.trim() || "￿") ||
        (a.name || a.slug).localeCompare(b.name || b.slug),
    )
  }, [rows, byTeam, folder])

  const folderTile = (team: string, count: number) => (
    <button
      key={team}
      onClick={() => setFolder(team)}
      className="group flex w-28 flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center hover:bg-foreground/6"
    >
      <span className="grid h-12 w-12 place-items-center rounded-xl border border-chrome-border bg-secondary-background/50 group-hover:border-main/50">
        <Folder className="h-6 w-6 text-chrome-text/70" />
      </span>
      <span className="line-clamp-2 w-full text-[11px] leading-tight text-foreground/85">{team}</span>
      <span className="font-mono text-[9px] text-chrome-text/40">{count} app{count === 1 ? "" : "s"}</span>
    </button>
  )

  return (
    <div className="flex h-full flex-col bg-block-bg/45 text-foreground backdrop-blur-md group-data-[focused=false]/window:bg-block-bg/25">
      <header className="flex shrink-0 items-center gap-1.5 border-b border-chrome-border/70 bg-chrome-bg/40 px-3 py-2 text-[12px]">
        <button
          onClick={() => setFolder(null)}
          className={folder ? "text-chrome-text/60 hover:text-rvbbit-accent" : "font-medium text-foreground"}
        >
          Apps
        </button>
        {folder ? (
          <>
            <CaretRight className="h-3 w-3 text-chrome-text/40" />
            <span className="font-medium text-foreground">{folder}</span>
          </>
        ) : null}
        <span className="ml-auto text-[10px] text-chrome-text/45">
          {rows.length} published · open as windows
        </span>
        <span className="ml-2 flex items-center gap-px rounded border border-chrome-border/60">
          <button
            onClick={() => changeView("icons")}
            title="Icon view"
            className={cn(
              "rounded-l px-1.5 py-1",
              view === "icons" ? "bg-foreground/10 text-foreground" : "text-chrome-text/50 hover:text-foreground",
            )}
          >
            <LayoutDashboard className="h-3 w-3" />
          </button>
          <button
            onClick={() => changeView("list")}
            title="List view"
            className={cn(
              "rounded-r px-1.5 py-1",
              view === "list" ? "bg-foreground/10 text-foreground" : "text-chrome-text/50 hover:text-foreground",
            )}
          >
            <Table2 className="h-3 w-3" />
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="px-1 py-2 text-xs text-danger">{error}</div>
        ) : rows.length === 0 ? (
          <div className="px-1 py-2 text-xs text-chrome-text/45">
            No live apps yet. Build one from any MCP chat (<code>live_app_template</code> → <code>create_live_app</code>) and it appears here.
          </div>
        ) : view === "list" ? (
          <div className="flex flex-col gap-px">
            <div className="grid grid-cols-[14px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2.2fr)_52px] gap-2 px-2 pb-1 text-[9px] uppercase tracking-wider text-chrome-text/40">
              <span />
              <span>name</span>
              <span>team</span>
              <span>description</span>
              <span className="text-right">version</span>
            </div>
            {listRows.map(appRow)}
          </div>
        ) : (
          <div className="flex flex-wrap content-start items-start gap-1">
            {folder
              ? inFolder.map(appTile)
              : [...teams.map((t) => folderTile(t, byTeam.get(t)?.length ?? 0)), ...unfiled.map(appTile)]}
          </div>
        )}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
