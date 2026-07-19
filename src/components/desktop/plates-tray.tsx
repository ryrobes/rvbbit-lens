"use client"

import { useEffect, useId, useRef, useState } from "react"
import { AppWindow, Layers, Maximize2, Plus } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { ContextMenu, type ContextMenuState } from "./context-menu"
import type { ShelfLayout } from "./plate-window"

/**
 * The Plates pull-down on the OS bar — the "these are real apps" conduit.
 * Lives NEXT TO Scenes so layouts and plates are reachable ABOVE whatever
 * windows currently cover the desktop (the shelf window gets buried under
 * the very arrangement you're trying to save; a bar dropdown can't be).
 *
 * Click a layout → wall mode. Click a plate → window. Right-click either →
 * add a desktop icon. The save-arrangement form lives here too, so the
 * capture gesture works while the arrangement owns the whole screen.
 */

interface TrayPlate {
  plate_id: string
  kit: string | null
  title: string
  description: string | null
  gated: boolean
  locked: boolean
}

interface TrayKitMeta {
  title: string | null
}

/**
 * Save-arrangement form, shared by the OS-bar tray and the shelf window.
 * The id field is a combobox over EXISTING layouts (pick one = Save As /
 * overwrite — geometry updates, slot flags/params/titles survive via the
 * shell's per-plate merge, and revisions keep the old version); free text
 * makes a new one. The kit field is a combobox over installed kits.
 */
export function SaveArrangementForm({
  layouts,
  kits,
  onSave,
  onDone,
}: {
  layouts: ShelfLayout[]
  kits: Record<string, { title: string | null }>
  onSave: (input: { layout_id: string; title: string; kit: string | null }) => Promise<{ ok: boolean; error?: string; count?: number }>
  onDone: (note: string, ok: boolean) => void
}) {
  const uid = useId()
  const [id, setId] = useState("")
  const [title, setTitle] = useState("")
  const [kit, setKit] = useState("")
  const existing = layouts.find((l) => l.layout_id === id.trim())
  const kitKeys = [...new Set([...Object.keys(kits), ...layouts.map((l) => l.kit ?? "")])].filter(Boolean).sort()

  return (
    <div className="space-y-1 px-1 py-0.5">
      <div className="flex gap-1">
        <input
          value={id}
          onChange={(e) => {
            const next = e.target.value
            setId(next)
            // Picking an existing layout = Save As over it: pull its
            // title/kit so the overwrite keeps identity unless edited.
            const hit = layouts.find((l) => l.layout_id === next.trim())
            if (hit) {
              setTitle(hit.title)
              setKit(hit.kit ?? "")
            }
          }}
          list={`${uid}-layouts`}
          placeholder="kit/home — pick existing to overwrite"
          spellCheck={false}
          className="w-0 flex-1 rounded border border-chrome-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-chrome-text/30"
        />
        <datalist id={`${uid}-layouts`}>
          {layouts.map((l) => (
            <option key={l.layout_id} value={l.layout_id}>{l.title}</option>
          ))}
        </datalist>
        <input
          value={kit}
          onChange={(e) => setKit(e.target.value)}
          list={`${uid}-kits`}
          placeholder="kit"
          spellCheck={false}
          className="w-20 rounded border border-chrome-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-chrome-text/30"
        />
        <datalist id={`${uid}-kits`}>
          {kitKeys.map((k) => (
            <option key={k} value={k}>{kits[k]?.title ?? k}</option>
          ))}
        </datalist>
      </div>
      <div className="flex gap-1">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-0 flex-1 rounded border border-chrome-border bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-chrome-text/30"
        />
        <button
          type="button"
          disabled={!id.trim()}
          onClick={() => {
            void onSave({
              layout_id: id.trim(),
              title: title.trim() || id.trim(),
              kit: kit.trim() || null,
            }).then((r) => {
              onDone(
                r.ok
                  ? `${existing ? "overwrote" : "saved"} ${id.trim()} (${r.count} panes)`
                  : (r.error ?? "save failed"),
                r.ok,
              )
              if (r.ok) {
                setId("")
                setTitle("")
                setKit("")
              }
            })
          }}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] disabled:opacity-40",
            existing ? "border-warning/50 text-warning" : "border-main/40 text-main",
          )}
        >
          {existing ? "overwrite" : "save"}
        </button>
      </div>
      {existing ? (
        <div className="px-0.5 text-[10px] text-chrome-text/45">
          replaces “{existing.title}” — geometry from these windows; slots/params kept; revisions hold the old version
        </div>
      ) : null}
    </div>
  )
}

export function PlatesTray({
  activeConnectionId,
  onOpenPlate,
  onOpenWall,
  onStampLayout,
  onSaveArrangement,
  onAddPlateShortcut,
  onAddLayoutShortcut,
  onOpenShelf,
}: {
  activeConnectionId: string | null
  onOpenPlate: (plateId: string, title?: string) => void
  onOpenWall: (layoutId: string) => void
  onStampLayout: (layout: ShelfLayout) => void
  onSaveArrangement: (input: { layout_id: string; title: string; kit: string | null }) => Promise<{ ok: boolean; error?: string; count?: number }>
  onAddPlateShortcut: (plateId: string, title: string) => void
  onAddLayoutShortcut: (layoutId: string, title: string) => void
  /** The full shelf window (kit installs, gates) — this tray is quick access. */
  onOpenShelf: () => void
}) {
  const [open, setOpen] = useState(false)
  const [plates, setPlates] = useState<TrayPlate[]>([])
  const [layouts, setLayouts] = useState<ShelfLayout[]>([])
  const [kits, setKits] = useState<Record<string, TrayKitMeta>>({})
  const [note, setNote] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [ctx, setCtx] = useState<ContextMenuState | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !activeConnectionId) return
    let cancelled = false
    void fetch("/api/plate/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: activeConnectionId }),
    })
      .then((r) => r.json())
      .then((body: { ok: boolean; plates?: TrayPlate[]; layouts?: ShelfLayout[]; kits?: Record<string, TrayKitMeta> }) => {
        if (cancelled || !body.ok) return
        setPlates(body.plates ?? [])
        setLayouts(body.layouts ?? [])
        setKits(body.kits ?? {})
      })
      .catch(() => {})
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", h, true)
    return () => {
      cancelled = true
      document.removeEventListener("mousedown", h, true)
    }
  }, [open, activeConnectionId])

  // Kit groups, layouts first — front doors before rooms.
  const keys = [...new Set([...layouts.map((l) => l.kit ?? ""), ...plates.map((p) => p.kit ?? "")])].sort(
    (a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)),
  )

  const rightClick = (e: React.MouseEvent, items: ContextMenuState["items"]) => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, items })
  }

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title="Plates — layouts & surfaces shipped with the database"
        className={cn(
          "flex h-5 items-center gap-1 rounded border border-chrome-border bg-secondary-background/60 px-1.5 text-[11px] transition-colors",
          open ? "bg-foreground/[0.08] text-foreground" : "text-chrome-text hover:text-foreground",
        )}
      >
        <Layers className="h-3 w-3 shrink-0" />
        <span>Plates</span>
      </button>

      {open ? (
        <div data-no-snapshot="" className="absolute left-0 top-7 z-50 max-h-[70vh] w-80 overflow-y-auto rounded-md border border-chrome-border bg-chrome-bg shadow-xl">
          <div className="p-1.5">
            {keys.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-chrome-text/50">no plates installed yet</div>
            ) : null}
            {keys.map((key) => {
              const kitLayouts = layouts.filter((l) => (l.kit ?? "") === key)
              const kitPlates = plates.filter((p) => (p.kit ?? "") === key)
              return (
                <div key={key || "·"} className="mb-1.5">
                  <div className="px-2 pb-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-main/70">
                    {key ? (kits[key]?.title ?? key) : "standalone"}
                  </div>
                  {kitLayouts.map((l) => (
                    <button
                      key={l.layout_id}
                      type="button"
                      onClick={() => {
                        onOpenWall(l.layout_id)
                        setOpen(false)
                      }}
                      onContextMenu={(e) =>
                        rightClick(e, [
                          { id: "wall", label: "Open full-screen", icon: Maximize2, onSelect: () => { onOpenWall(l.layout_id); setOpen(false) } },
                          { id: "stamp", label: "Stamp as windows", icon: AppWindow, onSelect: () => { onStampLayout(l); setOpen(false) } },
                          { id: "icon", label: "Add icon to Desktop", icon: AppWindow, onSelect: () => { onAddLayoutShortcut(l.layout_id, l.title); setNote(`${l.title} → desktop`) } },
                        ])
                      }
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px] hover:bg-foreground/[0.06]"
                      title={`${l.description ?? l.layout_id} — click: full-screen · right-click: more`}
                    >
                      <Maximize2 className="h-3 w-3 shrink-0 text-main/80" />
                      <span className="min-w-0 flex-1 truncate text-foreground">{l.title}</span>
                      <span className="shrink-0 text-[9px] text-chrome-text/40">{l.panes.length}p</span>
                    </button>
                  ))}
                  {kitPlates.map((p) => (
                    <button
                      key={p.plate_id}
                      type="button"
                      disabled={p.gated || p.locked}
                      onClick={() => {
                        onOpenPlate(p.plate_id, p.title)
                        setOpen(false)
                      }}
                      onContextMenu={(e) =>
                        rightClick(e, [
                          { id: "open", label: "Open", icon: Layers, onSelect: () => { onOpenPlate(p.plate_id, p.title); setOpen(false) } },
                          { id: "icon", label: "Add icon to Desktop", icon: AppWindow, onSelect: () => { onAddPlateShortcut(p.plate_id, p.title); setNote(`${p.title} → desktop`) } },
                        ])
                      }
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11.5px] hover:bg-foreground/[0.06] disabled:opacity-40"
                      title={`${p.description ?? p.plate_id} — right-click: add to desktop`}
                    >
                      <Layers className="h-3 w-3 shrink-0 text-chrome-text/50" />
                      <span className="min-w-0 flex-1 truncate text-chrome-text/90">{p.title}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="border-t border-chrome-border/60 p-1.5">
            {saveOpen ? (
              <SaveArrangementForm
                layouts={layouts}
                kits={kits}
                onSave={onSaveArrangement}
                onDone={(msg, ok) => {
                  setNote(msg)
                  if (ok) {
                    setSaveOpen(false)
                    setLayouts([]) // refetch on next open
                  }
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setSaveOpen(true)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
                title="The plate windows on this workspace become the panes — arrange first, then save"
              >
                <Plus className="h-3 w-3" /> Save arrangement as layout…
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onOpenShelf()
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <Layers className="h-3 w-3" /> Browse all / install kits…
            </button>
            {note ? <div className="truncate px-2 pt-0.5 text-[10px] text-main/80">{note}</div> : null}
          </div>
        </div>
      ) : null}
      <ContextMenu state={ctx} onClose={() => setCtx(null)} />
    </div>
  )
}
