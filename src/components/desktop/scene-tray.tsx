"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronRight, Download, Globe, Layers, Pencil, Plus, Save, Trash2, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchSharedScenes,
  forkScene,
  setSceneVisibility,
  type SharedScene,
} from "@/lib/desktop/scenes"
import { getHomeId } from "@/lib/desktop/server-sync"
import type { Scene } from "@/lib/desktop/types"

interface SceneActions {
  scenes: Scene[]
  currentSceneId: string | null
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  /** Case-insensitive uniqueness probe (so a rename can't collide). */
  nameExists: (name: string, exceptId?: string) => boolean
}

interface SceneTrayProps extends SceneActions {
  /** Name of the Scene currently open in the Scene slot (null = none). */
  sceneName: string | null
  /** The open Scene has unsaved edits. */
  dirty: boolean
  /** True when there's an open Scene whose body differs from disk (Save enabled). */
  canSave: boolean
  /** The active desktop has at least one window (Save As is meaningful). */
  hasContent: boolean
  onSave: () => void
  onSaveAs: (name: string) => void
}

// ── Menu-bar tray ─────────────────────────────────────────────────────

export function SceneTray({
  sceneName,
  dirty,
  canSave,
  hasContent,
  onSave,
  onSaveAs,
  ...actions
}: SceneTrayProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", h, true)
    return () => document.removeEventListener("mousedown", h, true)
  }, [open])

  const draftName = draft.trim()
  const draftCollides = draftName.length > 0 && actions.nameExists(draftName)
  const canSaveAs = hasContent && draftName.length > 0 && !draftCollides

  // Plain function — React Compiler memoizes it; a manual useCallback here
  // tripped preserve-manual-memoization (incomplete deps) and de-opted the file.
  const submitSaveAs = () => {
    if (!canSaveAs) return
    onSaveAs(draftName)
    setDraft("")
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        title={sceneName ? `Scene: ${sceneName}${dirty ? " (unsaved)" : ""}` : "Scenes — save / open a desktop"}
        className={cn(
          "flex h-5 items-center gap-1 rounded border border-chrome-border bg-secondary-background/60 px-1.5 text-[11px] transition-colors",
          open ? "bg-foreground/[0.08] text-foreground" : "text-chrome-text hover:text-foreground",
        )}
      >
        <Layers className="h-3 w-3 shrink-0" />
        <span className="max-w-[120px] truncate">{sceneName ?? "Scenes"}</span>
        {dirty ? <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-main" /> : null}
      </button>

      {open ? (
        <div className="absolute left-0 top-7 z-50 w-72 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg shadow-xl">
          {/* Save / Save As */}
          <div className="space-y-1.5 border-b border-chrome-border/60 p-2">
            {canSave ? (
              <button
                type="button"
                onClick={() => {
                  onSave()
                  setOpen(false)
                }}
                className="flex w-full items-center gap-1.5 rounded bg-main/15 px-2 py-1 text-[11px] font-medium text-main hover:bg-main/25"
              >
                <Save className="h-3 w-3" /> Save “{sceneName}”
              </button>
            ) : null}
            <div className="flex items-center gap-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitSaveAs()
                  if (e.key === "Escape") setDraft("")
                }}
                placeholder={hasContent ? "Save this desktop as…" : "Desktop is empty"}
                disabled={!hasContent}
                className="min-w-0 flex-1 rounded border border-chrome-border bg-background/70 px-1.5 py-1 text-[11px] text-foreground placeholder:text-chrome-text/40 focus:border-main/60 focus:outline-none disabled:opacity-40"
              />
              <button
                type="button"
                onClick={submitSaveAs}
                disabled={!canSaveAs}
                title="Save as a new Scene"
                className="inline-flex h-[26px] items-center gap-1 rounded bg-main/15 px-2 text-[11px] font-medium text-main hover:bg-main/25 disabled:opacity-30"
              >
                <Plus className="h-3 w-3" /> New
              </button>
            </div>
            {draftCollides ? (
              <p className="px-0.5 text-[10px] text-warning">A Scene named “{draftName}” already exists.</p>
            ) : null}
          </div>

          {/* Your saved desktops */}
          <SceneList {...actions} emptyHint="No saved Scenes yet." onAfterAction={() => setOpen(false)} />

          {/* Scenes other homes have shared — fork to grab a copy */}
          <SharedSceneLibrary />
        </div>
      ) : null}
    </div>
  )
}

// ── Scene Library — scenes other homes have shared ───────────────────

function SharedSceneLibrary() {
  const [shared, setShared] = useState<SharedScene[]>([])
  const [loading, setLoading] = useState(true)
  const [forked, setForked] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void fetchSharedScenes(getHomeId()).then((s) => {
      if (cancelled) return
      setShared(s)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || shared.length === 0) return null

  return (
    <div className="border-t border-chrome-border/60">
      <div className="flex items-center gap-1 px-2.5 pb-1 pt-2 text-[9px] uppercase tracking-wider text-chrome-text/45">
        <Globe className="h-3 w-3" /> Shared by other homes
      </div>
      <div className="max-h-[30vh] overflow-auto pb-1">
        {shared.map(({ owner, scene }) => (
          <div
            key={scene.id}
            className="group mx-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] hover:bg-foreground/[0.06]"
          >
            <Globe className="h-3 w-3 shrink-0 text-rvbbit-accent/70" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground">{scene.name}</div>
              <div className="truncate text-[9px] text-chrome-text/45">
                {owner} · {scene.windowCount} {scene.windowCount === 1 ? "window" : "windows"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                forkScene(scene)
                setForked((f) => new Set(f).add(scene.id))
              }}
              disabled={forked.has(scene.id)}
              title="Copy this scene into your home"
              className="inline-flex shrink-0 items-center gap-1 rounded border border-chrome-border px-1.5 py-0.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-45"
            >
              <Download className="h-3 w-3" /> {forked.has(scene.id) ? "Forked" : "Fork"}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Shared list (tray dropdown + empty Scene-slot gallery) ────────────

export function SceneList({
  scenes,
  currentSceneId,
  onOpen,
  onRename,
  onDelete,
  nameExists,
  emptyHint = "No saved Scenes yet.",
  onAfterAction,
}: SceneActions & { emptyHint?: string; onAfterAction?: () => void }) {
  const sorted = useMemo(() => [...scenes].sort((a, b) => a.name.localeCompare(b.name)), [scenes])

  if (sorted.length === 0) {
    return <div className="px-3 py-4 text-center text-[11px] text-chrome-text/50">{emptyHint}</div>
  }

  return (
    <div className="max-h-[50vh] overflow-auto py-1">
      {sorted.map((s) => (
        <SceneRow
          key={s.id}
          scene={s}
          isCurrent={s.id === currentSceneId}
          onOpen={() => {
            onOpen(s.id)
            onAfterAction?.()
          }}
          onRename={(name) => onRename(s.id, name)}
          onDelete={() => onDelete(s.id)}
          nameExists={(name) => nameExists(name, s.id)}
        />
      ))}
    </div>
  )
}

function SceneRow({
  scene,
  isCurrent,
  onOpen,
  onRename,
  onDelete,
  nameExists,
}: {
  scene: Scene
  isCurrent: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  nameExists: (name: string) => boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(scene.name)
  const [confirmDel, setConfirmDel] = useState(false)

  const trimmed = name.trim()
  const renameCollides = trimmed.length > 0 && trimmed !== scene.name && nameExists(trimmed)
  const canCommit = trimmed.length > 0 && !renameCollides

  const commitRename = () => {
    if (!canCommit) return
    if (trimmed !== scene.name) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <div
      className={cn(
        "group mx-1 flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]",
        isCurrent ? "bg-main/10" : "hover:bg-foreground/[0.06]",
      )}
    >
      {renaming ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename()
            if (e.key === "Escape") {
              setName(scene.name)
              setRenaming(false)
            }
          }}
          onBlur={commitRename}
          className={cn(
            "min-w-0 flex-1 rounded border bg-background/70 px-1 py-0.5 text-foreground focus:outline-none",
            renameCollides ? "border-warning/70" : "border-main/60",
          )}
        />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          title={`Open “${scene.name}” into the Scene slot`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0", isCurrent ? "text-main" : "text-chrome-text/40")} />
          <span className="truncate text-foreground">{scene.name}</span>
          <span className="shrink-0 text-[10px] text-chrome-text/40">
            {scene.windowCount} {scene.windowCount === 1 ? "window" : "windows"}
          </span>
          {isCurrent ? <span className="shrink-0 text-[10px] text-main">open</span> : null}
        </button>
      )}

      {!renaming ? (
        <button
          type="button"
          onClick={() => setSceneVisibility(scene.id, scene.visibility !== "shared")}
          title={
            scene.visibility === "shared"
              ? "Shared — visible in other homes' Scene Library. Click to make private."
              : "Private. Click to share with other homes."
          }
          className={cn(
            "shrink-0 rounded p-0.5 transition-colors",
            scene.visibility === "shared"
              ? "text-rvbbit-accent hover:bg-rvbbit-accent/15"
              : "text-chrome-text/35 opacity-0 hover:bg-foreground/10 hover:text-chrome-text group-hover:opacity-100",
          )}
        >
          <Globe className="h-3 w-3" />
        </button>
      ) : null}

      {confirmDel ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <span className="text-[10px] text-warning">Delete?</span>
          <button type="button" onClick={onDelete} title="Confirm delete" className="rounded p-0.5 text-danger hover:bg-danger/15">
            <Check className="h-3 w-3" />
          </button>
          <button type="button" onClick={() => setConfirmDel(false)} title="Cancel" className="rounded p-0.5 text-chrome-text/60 hover:bg-foreground/10">
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {!renaming ? (
            <button
              type="button"
              onClick={() => {
                setName(scene.name)
                setRenaming(true)
              }}
              title="Rename"
              className="rounded p-0.5 text-chrome-text/60 hover:bg-foreground/10 hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirmDel(true)}
            title="Delete"
            className="rounded p-0.5 text-chrome-text/60 hover:bg-danger/15 hover:text-danger"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}
