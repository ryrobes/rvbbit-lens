"use client"

import { useCallback, useEffect, useState } from "react"
import { Boxes, Pencil, Play, Plus, Trash2 } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import type { ViewApp } from "@/lib/desktop/types"
import { deleteViewApp, listViewApps } from "@/lib/desktop/view-apps"
import { iconFor } from "@/lib/desktop/icon-glyphs"
import { cn } from "@/lib/utils"

interface ViewAppsWindowProps {
  onOpen: (id: string) => void
  onCreate: () => void
  onEdit: (id: string) => void
}

export function ViewAppsWindow({ onOpen, onCreate, onEdit }: ViewAppsWindowProps) {
  const [apps, setApps] = useState<ViewApp[]>([])

  const refresh = useCallback(() => setApps(listViewApps()), [])
  useEffect(() => { refresh() }, [refresh])

  // Re-load when any window updates the local store.
  useEffect(() => {
    const handler = () => refresh()
    window.addEventListener("rvbbit-lens:apps-changed", handler as EventListener)
    return () => window.removeEventListener("rvbbit-lens:apps-changed", handler as EventListener)
  }, [refresh])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-chrome-text">
          <Boxes className="h-3.5 w-3.5" />
          Saved views · {apps.length}
        </div>
        <Button size="sm" onClick={onCreate}>
          <Plus className="h-3 w-3" />
          New
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {apps.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-xs text-chrome-text/80">
            <div className="max-w-sm">
              <Boxes className="mx-auto mb-2 h-8 w-8 text-rvbbit-accent" />
              <div className="mb-1 text-sm text-foreground">No saved views yet.</div>
              <p>
                Save any SQL window as a view with a custom icon. Saved views remember the
                query, the connection, and an optional chart — toggle rows ⇄ chart when you open one.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
            {apps.map((app) => {
              const Icon = iconFor(app.iconKey)
              return (
                <div
                  key={app.id}
                  className="group flex flex-col items-center rounded-md border border-chrome-border/60 bg-secondary-background p-2 text-center transition-colors hover:border-main/50"
                >
                  <button
                    type="button"
                    onDoubleClick={() => onOpen(app.id)}
                    onClick={() => onOpen(app.id)}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <span className="grid h-12 w-12 place-items-center rounded-md border border-icon-tile-border bg-icon-tile-bg">
                      <Icon className="h-6 w-6" style={{ color: app.iconColor }} />
                    </span>
                    <span className="line-clamp-2 text-[11px] font-medium text-foreground">
                      {app.name}
                    </span>
                  </button>
                  <div className={cn(
                    "mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100",
                  )}>
                    <button
                      type="button"
                      className="grid h-5 w-5 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground"
                      title="Run"
                      onClick={() => onOpen(app.id)}
                    >
                      <Play className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="grid h-5 w-5 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground"
                      title="Edit"
                      onClick={() => onEdit(app.id)}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="grid h-5 w-5 place-items-center rounded text-chrome-text hover:bg-danger/20 hover:text-danger"
                      title="Delete"
                      onClick={() => {
                        if (confirm(`Delete "${app.name}"?`)) {
                          deleteViewApp(app.id)
                          refresh()
                          window.dispatchEvent(new Event("rvbbit-lens:apps-changed"))
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
