"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { Check } from "@/lib/icons"

// A generic, surface-agnostic right-click menu. The desktop opens it with the
// desktop item set; later, window parts can open the SAME component with their own
// context-sensitive items (just build a different ContextMenuItem[]). Styled to
// match the drag-in drop modal so the desktop feels cohesive.

export interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  /** Show a check on the right (for toggles like "Show Dependency Lines"). */
  checked?: boolean
  /** Render a divider above this item. */
  separatorBefore?: boolean
}

export interface ContextMenuState {
  /** Anchor in screen (client) pixels — where the user right-clicked. */
  x: number
  y: number
  items: ContextMenuItem[]
}

const EST_WIDTH = 220

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown, true)
    document.addEventListener("keydown", onKey, true)
    window.addEventListener("blur", onClose)
    window.addEventListener("resize", onClose)
    return () => {
      document.removeEventListener("mousedown", onDown, true)
      document.removeEventListener("keydown", onKey, true)
      window.removeEventListener("blur", onClose)
      window.removeEventListener("resize", onClose)
    }
  }, [state, onClose])

  if (!state) return null

  // Keep the menu on-screen (rough estimate — items are ~30px, separators ~9px).
  const estHeight =
    state.items.reduce((s, it) => s + (it.separatorBefore ? 39 : 30), 0) + 8
  const left = Math.max(8, Math.min(state.x, window.innerWidth - EST_WIDTH - 8))
  const top = Math.max(8, Math.min(state.y, window.innerHeight - estHeight - 8))

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[100] min-w-[200px] origin-top-left animate-in fade-in-0 zoom-in-95 rounded-lg border border-chrome-border/60 bg-chrome-bg/90 p-1 text-[12px] text-chrome-text shadow-2xl backdrop-blur-[6px] duration-100"
      style={{ left, top }}
    >
      {state.items.map((it) => (
        <div key={it.id}>
          {it.separatorBefore ? <div className="my-1 h-px bg-chrome-border/50" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onSelect?.()
              onClose()
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-40",
              it.danger
                ? "hover:bg-danger/10 hover:text-danger"
                : "hover:bg-rvbbit-accent/15 hover:text-foreground",
            )}
          >
            {it.icon ? (
              <it.icon className="h-3.5 w-3.5 shrink-0 text-chrome-text/70" />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <span className="flex-1 truncate">{it.label}</span>
            {it.checked ? <Check className="h-3.5 w-3.5 shrink-0 text-rvbbit-accent" /> : null}
          </button>
        </div>
      ))}
    </div>
  )
}
