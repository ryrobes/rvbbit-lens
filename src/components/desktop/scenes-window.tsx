"use client"

/**
 * Scenes window — the first-class gallery. The empty Scene-slot popover is the
 * ambient version; this is the launcher you can open from anywhere: search by
 * name / table / window kind / connection (facets are derived from each
 * scene's own saved windows — nothing declared), click a facet chip to pivot
 * the filter, click a card to load the scene into the Scene slot.
 */

import { useMemo, useState } from "react"
import { Layers, Search, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { SceneList } from "./scene-tray"
import { sceneMatchesQuery } from "@/lib/desktop/scene-facets"
import type { Scene } from "@/lib/desktop/types"

export function ScenesWindow({
  scenes,
  currentSceneId,
  onOpen,
  onRename,
  onDelete,
  nameExists,
}: {
  scenes: Scene[]
  currentSceneId: string | null
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  nameExists: (name: string, exceptId?: string) => boolean
}) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(
    () => scenes.filter((s) => sceneMatchesQuery(s, query)),
    [scenes, query],
  )

  return (
    <div className="flex h-full flex-col bg-chrome-bg/20 text-[12px]">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Layers className="h-3.5 w-3.5 text-main" />
        <span className="font-medium text-foreground">Scenes</span>
        <div className="relative ml-2 max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search name, table, window, connection…"
            className="w-full rounded-md border border-chrome-border/60 bg-background/50 py-1 pl-7 pr-6 text-[11.5px] outline-none placeholder:text-chrome-text/35 focus:border-main/50"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-chrome-text/40 hover:text-chrome-text"
              title="Clear"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <div className="flex-1" />
        <span className={cn("text-[10px] text-chrome-text/45", query && "text-main/70")}>
          {filtered.length} of {scenes.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <SceneList
          scenes={filtered}
          currentSceneId={currentSceneId}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
          nameExists={nameExists}
          variant="grid"
          onFacetClick={setQuery}
          emptyHint={
            query
              ? `No scenes match “${query}”.`
              : "No saved Scenes yet. Use the Scenes menu in the top bar to save the current desktop."
          }
        />
      </div>
    </div>
  )
}
