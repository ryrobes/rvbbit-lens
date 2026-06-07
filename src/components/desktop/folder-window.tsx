"use client"

import { useState } from "react"
import { Boxes, Table2, type LucideIcon } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { DesktopIcon } from "./desktop-icon"

/**
 * A desktop launcher (or, later, a saved query / arranged item). `activate`
 * runs the same handler the desktop icon would. `folder` (undefined = lives on
 * the desktop) and `rvbbit` (gated when the connection isn't a rvbbit DB) let
 * the shell build one registry and split it across the desktop + folders.
 */
export interface LauncherItem {
  id: string
  label: string
  icon: LucideIcon
  color: string
  sublabel?: string
  description?: string
  activate: () => void
  folder?: string
  rvbbit?: boolean
}

type FolderView = "icon" | "list"

// Per-folder Icon/List preference, persisted in localStorage (one small map
// keyed by folderId) so the choice sticks across sessions.
const VIEW_STORAGE_KEY = "rvbbit-lens:folder-views"

function loadFolderView(folderId: string): FolderView {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(VIEW_STORAGE_KEY) : null
    const map = raw ? (JSON.parse(raw) as Record<string, FolderView>) : {}
    return map[folderId] === "list" ? "list" : "icon"
  } catch {
    return "icon"
  }
}

function saveFolderView(folderId: string, view: FolderView): void {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, FolderView>) : {}
    map[folderId] = view
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota / disabled storage */
  }
}

/**
 * File-explorer-style folder window: shows its items in an Icon view or a List
 * view (toggle in the toolbar, persisted per folder). Reused for grouped
 * launchers now and saved queries / arranged artifacts later.
 */
export function FolderWindow({ folderId, items }: { folderId: string; items: LauncherItem[] }) {
  const [view, setViewState] = useState<FolderView>(() => loadFolderView(folderId))
  const setView = (v: FolderView) => {
    setViewState(v)
    saveFolderView(folderId, v)
  }
  return (
    <div className="flex h-full flex-col bg-doc-bg group-data-[focused=false]/window:bg-doc-bg/70">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-2">
        <span className="text-[11px] text-chrome-text/65">
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <ViewButton active={view === "icon"} onClick={() => setView("icon")} icon={Boxes} title="Icon view" />
          <ViewButton active={view === "list"} onClick={() => setView("list")} icon={Table2} title="List view" />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {items.length === 0 ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/50">Empty</div>
        ) : view === "icon" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-1">
            {items.map((it) => (
              <DesktopIcon
                key={it.id}
                label={it.label}
                sublabel={it.sublabel}
                icon={it.icon}
                iconColor={it.color}
                onActivate={it.activate}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {items.map((it) => {
              const Icon = it.icon
              const secondary = it.description ?? it.sublabel
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={it.activate}
                  onDoubleClick={it.activate}
                  className="flex items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06] focus:bg-foreground/[0.08] focus:outline-none"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded border border-icon-tile-border bg-icon-tile-bg">
                    <Icon className="h-4 w-4" style={{ color: it.color }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">{it.label}</span>
                    {secondary ? (
                      <span className="block truncate text-[10px] text-chrome-text/60">{secondary}</span>
                    ) : null}
                  </span>
                  {it.description && it.sublabel ? (
                    <span className="shrink-0 font-mono text-[10px] text-chrome-text/45">{it.sublabel}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ViewButton({
  active,
  onClick,
  icon: Icon,
  title,
}: {
  active: boolean
  onClick: () => void
  icon: LucideIcon
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "grid h-6 w-6 place-items-center rounded transition-colors",
        active ? "bg-foreground/[0.12] text-foreground" : "text-chrome-text hover:bg-foreground/[0.06]",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}
