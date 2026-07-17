"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronRight, Download, Globe, Layers, Link2, Pencil, Plus, Save, Trash2, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchSharedScenes,
  forkScene,
  setSceneVisibility,
  type SharedScene,
} from "@/lib/desktop/scenes"
import { getHomeId } from "@/lib/desktop/server-sync"
import { renderSceneThumbnail } from "@/lib/desktop/scene-thumbnail"
import { extractSceneFacets } from "@/lib/desktop/scene-facets"
import type { Scene } from "@/lib/desktop/types"

/** Stored thumbnail if present, else render one on the fly from the scene's
 *  own geometry (so scenes saved before thumbnails existed still show). */
function useSceneThumb(scene: Scene): string | null {
  return useMemo(
    () => scene.thumbnail ?? renderSceneThumbnail(scene.body),
    [scene.thumbnail, scene.id, scene.contentHash],
  )
}

function SceneThumb({ scene, className }: { scene: Scene; className?: string }) {
  const src = useSceneThumb(scene)
  if (!src) return <div className={cn("bg-foreground/[0.04]", className)} />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" aria-hidden className={cn("object-cover", className)} />
}

/** The photograph (real DOM capture) when the scene has one, with the derived
 *  object map inset in the corner; scenes without a snapshot get the map
 *  full-bleed, exactly as before. */
function SceneShot({ scene, className }: { scene: Scene; className?: string }) {
  const map = useSceneThumb(scene)
  const photo = scene.snapshot ?? null
  const main = photo ?? map
  if (!main) return <div className={cn("bg-foreground/[0.04]", className)} />
  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={main} alt="" aria-hidden className="h-full w-full object-cover" />
      {photo && map ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={map}
          alt=""
          aria-hidden
          className="absolute bottom-1 right-1 w-[30%] rounded-sm border border-chrome-border/80 bg-chrome-bg/90 shadow-md"
        />
      ) : null}
    </div>
  )
}

/** Copy a share link. Copying IS sharing: the scene is marked shared (the
 *  server only resolves shared ids), then the URL lands on the clipboard. */
function useCopySceneLink(scene: Scene): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (scene.visibility !== "shared") setSceneVisibility(scene.id, true)
    const url = `${window.location.origin}${window.location.pathname}?scene=${scene.id}`
    void navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  return { copied, copy }
}

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
  const [hovered, setHovered] = useState<Scene | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Open/close both reset the hover panel — done at the transition sites
  // rather than an effect (setState-in-effect cascades renders).
  const toggleOpen = () => {
    setHovered(null)
    setOpen((v) => !v)
  }
  const close = () => {
    setHovered(null)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
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
    close()
  }

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        onClick={toggleOpen}
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
        <div data-no-snapshot="" className="absolute left-0 top-7 z-50 w-72 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg shadow-xl">
          {/* Save / Save As */}
          <div className="space-y-1.5 border-b border-chrome-border/60 p-2">
            {canSave ? (
              <button
                type="button"
                onClick={() => {
                  onSave()
                  close()
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
          <SceneList
            {...actions}
            emptyHint="No saved Scenes yet."
            onAfterAction={close}
            onHoverScene={setHovered}
          />

          {/* Scenes other homes have shared — fork to grab a copy */}
          <SharedSceneLibrary />
        </div>
      ) : null}

      {/* Hover preview - a side panel, deliberately NOT a tooltip: it never
          steals the pointer and sits beside the dropdown. */}
      {open && hovered ? <SceneHoverPreview scene={hovered} /> : null}
    </div>
  )
}

function SceneHoverPreview({ scene }: { scene: Scene }) {
  const facets = extractSceneFacets(scene)
  return (
    <div data-no-snapshot="" className="pointer-events-none absolute left-[18.75rem] top-7 z-50 w-64 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg shadow-xl">
      <SceneShot scene={scene} className="aspect-[16/10] w-full" />
      <div className="space-y-1 p-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[11.5px] font-medium text-foreground">{scene.name}</span>
          <span className="shrink-0 text-[9px] text-chrome-text/45">{fmtAge(scene.updatedAt)}</span>
        </div>
        <div className="text-[10px] text-chrome-text/55">
          {scene.windowCount} {scene.windowCount === 1 ? "window" : "windows"}
          {facets.connectionLabel ? ` \u00b7 ${facets.connectionLabel}` : null}
          {scene.visibility === "shared" ? " \u00b7 shared" : null}
        </div>
        {facets.tables.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {facets.tables.slice(0, 6).map((t) => (
              <span key={t} className="max-w-[10rem] truncate rounded-sm border border-chrome-border/60 bg-foreground/[0.04] px-1 py-px text-[8.5px] text-chrome-text/60">
                {t.split(".").pop()}
              </span>
            ))}
            {facets.tables.length > 6 ? (
              <span className="px-0.5 text-[8.5px] text-chrome-text/35">+{facets.tables.length - 6}</span>
            ) : null}
          </div>
        ) : null}
      </div>
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
  variant = "list",
  onFacetClick,
  onHoverScene,
}: SceneActions & {
  emptyHint?: string
  onAfterAction?: () => void
  variant?: "list" | "grid"
  /** Gallery-search integration: clicking a facet chip filters by it. */
  onFacetClick?: (facet: string) => void
  /** List-variant hover reporting — powers the tray's side preview panel. */
  onHoverScene?: (scene: Scene | null) => void
}) {
  // Most-recently-updated first — a gallery you scan, not an alphabetized index.
  const sorted = useMemo(
    () =>
      [...scenes].sort(
        (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name),
      ),
    [scenes],
  )

  if (sorted.length === 0) {
    return <div className="px-3 py-4 text-center text-[11px] text-chrome-text/50">{emptyHint}</div>
  }

  if (variant === "grid") {
    return (
      <div className="grid grid-cols-2 gap-2 p-1 md:grid-cols-3">
        {sorted.map((s) => (
          <SceneCard
            key={s.id}
            scene={s}
            onFacetClick={onFacetClick}
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

  return (
    <div className="max-h-[50vh] overflow-auto py-1">
      {sorted.map((s) => (
        <SceneRow
          key={s.id}
          scene={s}
          onHoverScene={onHoverScene}
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

function fmtAge(iso?: string): string {
  if (!iso) return ""
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`
}

function SceneCard({
  scene,
  isCurrent,
  onOpen,
  onRename,
  onDelete,
  nameExists,
  onFacetClick,
}: {
  scene: Scene
  isCurrent: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  nameExists: (name: string) => boolean
  onFacetClick?: (facet: string) => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const facets = useMemo(() => extractSceneFacets(scene), [scene.id, scene.contentHash])
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border transition-colors",
        isCurrent ? "border-main/70 ring-1 ring-main/40" : "border-chrome-border/70 hover:border-main/40",
      )}
    >
      <button type="button" onClick={onOpen} className="block w-full text-left" title={`Open “${scene.name}”`}>
        <SceneShot scene={scene} className="aspect-[16/10] w-full" />
        <div className="flex items-baseline justify-between gap-1 px-2 py-1">
          <span className="truncate text-[11px] font-medium text-foreground">{scene.name}</span>
          {isCurrent ? <span className="shrink-0 text-[9px] uppercase tracking-wide text-main">open</span> : null}
        </div>
        <div className="flex items-center justify-between gap-1 px-2 pb-1 text-[9px] text-chrome-text/45">
          <span>
            {scene.windowCount} {scene.windowCount === 1 ? "window" : "windows"}
            {facets.connectionLabel ? <span className="text-chrome-text/35"> · {facets.connectionLabel}</span> : null}
          </span>
          <span>{fmtAge(scene.updatedAt)}</span>
        </div>
      </button>
      {facets.tables.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {facets.tables.slice(0, 3).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onFacetClick?.(t)}
              title={onFacetClick ? `Filter scenes touching ${t}` : t}
              className={cn(
                "max-w-[9rem] truncate rounded-sm border border-chrome-border/60 bg-foreground/[0.04] px-1 py-px text-[8.5px] text-chrome-text/60",
                onFacetClick && "hover:border-main/50 hover:text-main",
              )}
            >
              {t.split(".").pop()}
            </button>
          ))}
          {facets.tables.length > 3 ? (
            <span className="px-0.5 text-[8.5px] text-chrome-text/35">+{facets.tables.length - 3}</span>
          ) : null}
        </div>
      ) : null}

      {/* hover actions */}
      <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyLinkButton scene={scene} className="rounded bg-background/70 p-1 backdrop-blur" />
        <button
          type="button"
          onClick={() => setSceneVisibility(scene.id, scene.visibility !== "shared")}
          title={scene.visibility === "shared" ? "Shared — click to make private" : "Private — click to share"}
          className={cn(
            "rounded p-1 backdrop-blur",
            scene.visibility === "shared"
              ? "bg-background/70 text-rvbbit-accent"
              : "bg-background/70 text-chrome-text/60 hover:text-chrome-text",
          )}
        >
          <Globe className="h-3 w-3" />
        </button>
        {confirmDel ? (
          <>
            <button type="button" onClick={onDelete} title="Confirm delete" className="rounded bg-background/70 p-1 text-danger backdrop-blur">
              <Check className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => setConfirmDel(false)} title="Cancel" className="rounded bg-background/70 p-1 text-chrome-text/60 backdrop-blur">
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmDel(true)} title="Delete" className="rounded bg-background/70 p-1 text-chrome-text/60 backdrop-blur hover:text-danger">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

function CopyLinkButton({ scene, className }: { scene: Scene; className?: string }) {
  const { copied, copy } = useCopySceneLink(scene)
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Link copied — the scene is now shared" : "Copy share link (marks the scene shared)"}
      className={cn(
        className,
        copied ? "text-success" : "text-chrome-text/60 hover:text-main",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
    </button>
  )
}

function SceneRow({
  scene,
  isCurrent,
  onOpen,
  onRename,
  onDelete,
  nameExists,
  onHoverScene,
}: {
  scene: Scene
  isCurrent: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  nameExists: (name: string) => boolean
  onHoverScene?: (scene: Scene | null) => void
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
      onMouseEnter={() => onHoverScene?.(scene)}
      onMouseLeave={() => onHoverScene?.(null)}
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
          <SceneThumb
            scene={scene}
            className={cn(
              "h-6 w-10 shrink-0 rounded-sm border",
              isCurrent ? "border-main/50" : "border-chrome-border/60",
            )}
          />
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
          <CopyLinkButton scene={scene} className="rounded p-0.5" />
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
