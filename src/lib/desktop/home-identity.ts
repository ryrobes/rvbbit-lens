"use client"

import { setHomeId, shadowDesktopState, shadowScenes, shadowViews } from "./server-sync"
import { hydrateDesktopState, loadDesktopState } from "./state-store"
import { hydrateScenes, listScenes } from "./scenes"
import { hydrateViews, listViewApps } from "./view-apps"
import type { Scene } from "./types"

/**
 * Soft identity (Phase 2). A "home" is a per-user workspace, addressed by a
 * slug — no auth, capability-URL style (knowing the name is the grant). Built on
 * the shadow store (server-sync): because every home is durably shadowed,
 * switching homes is LOSSLESS — your current home stays saved on the server, so
 * you can always switch back.
 *
 * Two transitions:
 *  - adopt  — the target home already has data → pull it into localStorage and
 *             reload (overwrites the current desktop, which is safely shadowed).
 *  - claim  — the target home is empty → switch to it and seed it from the
 *             current local work (a "Save As home"); no reload, nothing replaced.
 */

export { getHomeId, setHomeId, recentHomes } from "./server-sync"

/** Normalize a typed home name into a URL/id-safe slug. */
export function slugifyHome(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 64) || "home"
  )
}

export interface HomeSummary {
  id: string
  scenes: number
  updatedAt: string
}

/** Named homes on this server (for discovery — a fresh browser can pick one). */
export async function fetchHomes(): Promise<HomeSummary[]> {
  try {
    const r = (await fetch("/api/lens/homes").then((x) => x.json())) as { homes?: HomeSummary[] }
    return Array.isArray(r?.homes) ? r.homes : []
  } catch {
    return []
  }
}

/** Does this home already hold a desktop on the server? (decides adopt vs claim) */
export async function peekHome(slug: string): Promise<{ hasData: boolean }> {
  try {
    const r = (await fetch(`/api/lens/profile?home=${encodeURIComponent(slug)}`).then((x) =>
      x.json(),
    )) as { profile?: { state?: unknown } | null }
    return { hasData: !!r?.profile?.state }
  } catch {
    return { hasData: false }
  }
}

/**
 * Adopt an existing home: pull its desktop + scenes into localStorage, then
 * reload so the shell re-initialises from them. Assumes the caller confirmed
 * (it replaces the current desktop — which stays shadowed under the old home).
 */
export async function adoptHome(slug: string): Promise<void> {
  slug = slugifyHome(slug)
  const [p, s, v] = await Promise.all([
    fetch(`/api/lens/profile?home=${encodeURIComponent(slug)}`)
      .then((x) => x.json())
      .catch(() => null),
    fetch(`/api/lens/scenes?home=${encodeURIComponent(slug)}`)
      .then((x) => x.json())
      .catch(() => null),
    fetch(`/api/lens/views?home=${encodeURIComponent(slug)}`)
      .then((x) => x.json())
      .catch(() => null),
  ])
  const profile = (p as { profile?: { state?: unknown } | null } | null)?.profile ?? null
  const scenes = ((s as { scenes?: unknown } | null)?.scenes ?? []) as Scene[]
  const views = (v as { views?: unknown } | null)?.views ?? []
  hydrateDesktopState(profile?.state ?? null)
  hydrateScenes(Array.isArray(scenes) ? scenes : [])
  hydrateViews(views)
  setHomeId(slug)
  if (typeof window !== "undefined") window.location.reload()
}

/**
 * Claim an empty home: switch to it and seed it from the current local work.
 * No reload — local state is unchanged, it just starts shadowing to the new id.
 */
export function claimHome(slug: string): void {
  slug = slugifyHome(slug)
  setHomeId(slug)
  shadowDesktopState(loadDesktopState())
  shadowScenes(listScenes())
  shadowViews(listViewApps())
}
