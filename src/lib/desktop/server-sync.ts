"use client"

import { randomUUID } from "@/lib/uuid"

/**
 * Client shadow-sync. localStorage stays the synchronous source of truth; this
 * debounce-flushes a copy to the server SQLite store so state is durable and
 * shareable. Entirely best-effort: every call swallows errors, so an
 * unreachable/absent homebase degrades to browser-only behaviour with zero UX
 * impact.
 *
 * Keyed by a "home id" (Phase 2 soft identity — see home-identity.ts). The id
 * starts as a per-browser UUID and is renamed/adopted via setHomeId; shadows
 * always target whatever getHomeId() currently returns.
 */

const HOME_KEY = "rvbbit-lens.home-id"
const RECENT_KEY = "rvbbit-lens.home-recent"

/** The current home id (creates a per-browser UUID on first use). */
export function getHomeId(): string {
  if (typeof window === "undefined") return "server"
  try {
    let id = window.localStorage.getItem(HOME_KEY)
    if (!id) {
      id = randomUUID()
      window.localStorage.setItem(HOME_KEY, id)
    }
    return id
  } catch {
    return "default"
  }
}

/** Point this browser at a home id (and remember it in the recents list). */
export function setHomeId(slug: string): void {
  if (typeof window === "undefined" || !slug) return
  try {
    window.localStorage.setItem(HOME_KEY, slug)
    const recent = [slug, ...recentHomes().filter((h) => h !== slug)].slice(0, 8)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    /* best-effort */
  }
}

/** Recently-visited home ids (most-recent first), for the Home switcher. */
export function recentHomes(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

const DEBOUNCE_MS = 1500
let profileTimer: number | null = null
let scenesTimer: number | null = null
let viewsTimer: number | null = null

function flush(path: string, payload: Record<string, unknown>): void {
  void fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {
    // homebase offline / not configured → stay browser-only, silently.
  })
}

/** Mirror the desktop-state blob to the server (debounced). */
export function shadowDesktopState(state: unknown): void {
  if (typeof window === "undefined") return
  if (profileTimer != null) window.clearTimeout(profileTimer)
  profileTimer = window.setTimeout(() => {
    flush("/api/lens/profile", { home: getHomeId(), state })
  }, DEBOUNCE_MS)
}

/** Mirror the full scene store to the server (debounced). */
export function shadowScenes(scenes: unknown[]): void {
  if (typeof window === "undefined") return
  if (scenesTimer != null) window.clearTimeout(scenesTimer)
  scenesTimer = window.setTimeout(() => {
    flush("/api/lens/scenes", { home: getHomeId(), scenes })
  }, DEBOUNCE_MS)
}

/** Mirror the full Saved Views store to the server (debounced). */
export function shadowViews(views: unknown[]): void {
  if (typeof window === "undefined") return
  if (viewsTimer != null) window.clearTimeout(viewsTimer)
  viewsTimer = window.setTimeout(() => {
    flush("/api/lens/views", { home: getHomeId(), views })
  }, DEBOUNCE_MS)
}
