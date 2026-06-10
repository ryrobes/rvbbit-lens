"use client"

import { randomUUID } from "@/lib/uuid"

/**
 * Client shadow-sync (Phase 1). localStorage stays the synchronous source of
 * truth; this debounce-flushes a copy to the server SQLite store so state is
 * durable and shareable later. Entirely best-effort: every call swallows
 * errors, so an unreachable/absent homebase degrades to today's
 * browser-only behaviour with zero UX impact.
 *
 * Keyed by a per-browser "home id" for now (durability first); soft identity
 * and cross-home sharing arrive in Phase 2.
 */

const HOME_KEY = "rvbbit-lens.home-id"

/** Stable per-browser home id (the Phase-2 identity layer will let you name/adopt it). */
export function lensHomeId(): string {
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

const DEBOUNCE_MS = 1500
let profileTimer: number | null = null
let scenesTimer: number | null = null

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
    flush("/api/lens/profile", { home: lensHomeId(), state })
  }, DEBOUNCE_MS)
}

/** Mirror the full scene store to the server (debounced). */
export function shadowScenes(scenes: unknown[]): void {
  if (typeof window === "undefined") return
  if (scenesTimer != null) window.clearTimeout(scenesTimer)
  scenesTimer = window.setTimeout(() => {
    flush("/api/lens/scenes", { home: lensHomeId(), scenes })
  }, DEBOUNCE_MS)
}
