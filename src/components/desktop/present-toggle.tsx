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
        "grid h-6 w-6 place-items-center rounded transition-colors",
        present
          ? "bg-rvbbit-accent/15 text-rvbbit-accent"
          : "text-chrome-text/55 hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Eye className="h-3.5 w-3.5" />
    </button>
  )
}
