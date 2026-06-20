"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Command, CommandInput, CommandList, CommandItem, CommandGroup } from "cmdk"
import { Search } from "@/lib/icons"
import { cn } from "@/lib/utils"

// A Cmd+P fuzzy launcher over the desktop's command surface — tables, saved
// views, every window/tool, and a few verbs. Items come from the shell so the
// palette just renders + fuzzy-filters them (cmdk) and runs the chosen one.

export interface PaletteItem {
  id: string
  label: string
  /** Right-aligned dim text (schema name, "⌘N", "Saved view"…). */
  hint?: string
  /** Extra fuzzy-search terms beyond label/hint. */
  keywords?: string[]
  icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  /** CSS color for the icon (launcher accent). */
  color?: string
  run: () => void
}

export interface PaletteGroup {
  heading: string
  items: PaletteItem[]
  /** Cap the number of RENDERED items (after filtering) — for unbounded groups
   *  like Tables, so a huge catalog doesn't mount thousands of DOM nodes. */
  limit?: number
}

/** Case-insensitive fuzzy match: substring OR in-order subsequence. */
function matchesQuery(item: PaletteItem, q: string): boolean {
  if (!q) return true
  const hay = `${item.label} ${item.hint ?? ""} ${(item.keywords ?? []).join(" ")}`.toLowerCase()
  if (hay.includes(q)) return true
  let i = 0
  for (let j = 0; j < hay.length && i < q.length; j++) if (hay[j] === q[i]) i++
  return i === q.length
}

export function CommandPalette({
  open,
  onClose,
  buildGroups,
}: {
  open: boolean
  onClose: () => void
  /** Built lazily here (during this component's render, not the shell's) so the
   *  shell never reads its ref-derived launcher/workspace values during render. */
  buildGroups: () => PaletteGroup[]
}) {
  // Search resets every open because the shell mounts this only while open
  // (`{paletteOpen ? <CommandPalette/> : null}`), so this state is fresh each time.
  const [search, setSearch] = useState("")

  // Esc closes (cmdk doesn't trap it outside its Dialog wrapper).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, onClose])

  // Restore focus to whatever was focused before the palette opened (the input
  // we steal focus into is body-portaled; on unmount focus would fall to <body>).
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    return () => prev?.focus?.()
  }, [open])

  // buildGroups is stable across this palette's own re-renders (search typing
  // doesn't re-render the shell), so this caches across keystrokes.
  const groups = useMemo(() => buildGroups(), [buildGroups])

  if (!open || typeof document === "undefined") return null

  const run = (item: PaletteItem) => {
    // Close first so the action opens onto a clean desktop (and focus lands right).
    onClose()
    item.run()
  }

  // Own the filtering (shouldFilter={false} below) so EVERY item is searchable
  // and we can cap only the rendered count of unbounded groups (Tables). cmdk's
  // built-in filter would otherwise require all items mounted to be searchable.
  const q = search.trim().toLowerCase()
  const nonEmpty = groups
    .map((g) => {
      const filtered = g.items.filter((it) => matchesQuery(it, q))
      return { heading: g.heading, items: g.limit ? filtered.slice(0, g.limit) : filtered }
    })
    .filter((g) => g.items.length > 0)
  const totalShown = nonEmpty.reduce((n, g) => n + g.items.length, 0)

  return createPortal(
    // Portal to <body> so `position: fixed` resolves to the viewport, not a
    // window's backdrop-filter containing block (same reason as ContextMenu).
    <div className="fixed inset-0 z-[10000] flex items-start justify-center" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div
        className="relative mt-[12vh] w-[600px] max-w-[92vw] overflow-hidden rounded-xl border border-chrome-border/70 bg-chrome-bg/95 shadow-2xl backdrop-blur-[10px]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" loop shouldFilter={false} className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-chrome-border/60 px-3">
            <Search className="h-4 w-4 shrink-0 text-chrome-text/50" />
            <CommandInput
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Search tables, views, actions…"
              className="h-11 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-chrome-text/40"
            />
          </div>
          <CommandList className="max-h-[52vh] overflow-y-auto overflow-x-hidden p-1.5 [scrollbar-width:thin]">
            {totalShown === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-chrome-text/50">No matches.</div>
            ) : null}
            {nonEmpty.map((g) => (
              <CommandGroup
                key={g.heading}
                heading={g.heading}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-chrome-text/45"
              >
                {g.items.map((it) => (
                  <CommandItem
                    key={it.id}
                    value={it.id}
                    keywords={[it.label, ...(it.hint ? [it.hint] : []), ...(it.keywords ?? [])]}
                    onSelect={() => run(it)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] text-chrome-text",
                      "aria-selected:bg-rvbbit-accent/15 aria-selected:text-foreground",
                    )}
                  >
                    {it.icon ? (
                      <it.icon className="h-4 w-4 shrink-0" style={it.color ? { color: it.color } : undefined} />
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint ? (
                      <span className="shrink-0 truncate pl-2 text-[11px] text-chrome-text/45">{it.hint}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="flex items-center gap-3 border-t border-chrome-border/60 px-3 py-1.5 text-[10px] text-chrome-text/40">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </Command>
      </div>
    </div>,
    document.body,
  )
}
