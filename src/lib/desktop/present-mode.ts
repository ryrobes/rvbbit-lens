"use client"

/**
 * Present (read-only) mode — Phase 2.2b. A per-tab flag that makes the desktop
 * a stable presentation surface: layout fiddling no longer persists (or
 * shadows), so a shared/presented desktop stays as saved. The *rendering* side
 * (less chrome) is a deferred visual pass — this is just the behaviour contract.
 *
 * Per-tab (sessionStorage) on purpose: one tab can present a scene read-only
 * while another edits. Set on load via `?present=1`, or the menu-bar toggle.
 */

const KEY = "rvbbit-lens.present"
export const PRESENT_CHANGED_EVENT = "rvbbit-lens:present-changed"

export function isPresentMode(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.sessionStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function setPresentMode(on: boolean): void {
  if (typeof window === "undefined") return
  try {
    if (on) window.sessionStorage.setItem(KEY, "1")
    else window.sessionStorage.removeItem(KEY)
    window.dispatchEvent(new Event(PRESENT_CHANGED_EVENT))
  } catch {
    /* best-effort */
  }
}

/** Subscribe helper for useSyncExternalStore. */
export function subscribePresentMode(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(PRESENT_CHANGED_EVENT, cb)
  return () => window.removeEventListener(PRESENT_CHANGED_EVENT, cb)
}
