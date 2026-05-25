"use client"

/**
 * Client-side model for the Postgres LISTEN/NOTIFY feed. A `NotifyEvent`
 * is one received NOTIFY; the desktop keeps a rolling history of them
 * and shows recent ones as toasts. "Watched" channels are ones the user
 * subscribes to purely for notifications (no window attached) — they
 * persist in localStorage so they survive a reload.
 */

export interface NotifyEvent {
  id: string
  channel: string
  payload: string
  /** ISO timestamp when the browser received it */
  at: string
  /** how many data windows re-ran their query because of this event */
  refreshedCount?: number
}

/** State of the SSE link to /api/db/listen. */
export type NotifyConnectionStatus = "idle" | "connecting" | "open" | "error"

const WATCHED_KEY = "rvbbit-lens.notify.watched"

export function loadWatchedChannels(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(WATCHED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : []
  } catch {
    return []
  }
}

export function saveWatchedChannels(channels: string[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(WATCHED_KEY, JSON.stringify(channels))
  } catch {
    // localStorage is best-effort.
  }
}

/** Normalize a user-typed channel name — trim, drop empties. */
export function normalizeChannel(raw: string): string {
  return raw.trim()
}
