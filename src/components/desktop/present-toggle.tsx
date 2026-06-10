"use client"

import { useEffect, useSyncExternalStore } from "react"
import { Eye } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { isPresentMode, setPresentMode, subscribePresentMode } from "@/lib/desktop/present-mode"

/**
 * Menu-bar "Present" toggle (Phase 2.2b). Flips the per-tab read-only flag and
 * honours `?present=1` on load. When on, the desktop is a stable presentation
 * surface — layout fiddling doesn't persist (see saveDesktopState).
 */
export function PresentToggle() {
  const present = useSyncExternalStore(subscribePresentMode, isPresentMode, () => false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("present") === "1") {
      params.delete("present")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""))
      setPresentMode(true)
    }
  }, [])

  return (
    <button
      type="button"
      onClick={() => setPresentMode(!present)}
      aria-pressed={present}
      title={
        present
          ? "Present mode — desktop layout is read-only. Click to return to editing."
          : "Enter present mode — a read-only view for sharing or demos."
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
        present
          ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-rvbbit-accent"
          : "border-chrome-border/60 bg-chrome-bg/40 text-chrome-text/55 hover:border-rvbbit-accent/40 hover:text-foreground",
      )}
    >
      <Eye className="h-3 w-3" />
      Present
    </button>
  )
}
