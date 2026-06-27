"use client"

import { randomUUID } from "@/lib/uuid"
import { shadowViews } from "./server-sync"
import type { DataPayload, ScryViewState, StatementViewKind, ViewApp } from "./types"

/**
 * Saved Views registry (saved SQL queries + Scry explorations, promoted to
 * desktop icons). localStorage stays the synchronous source of truth; every
 * write also shadow-syncs to the server homebase (durable + travels with the
 * "home id"), and `hydrateViews` restores from there on home adoption.
 */

const STORAGE_KEY = "rvbbit-lens.view-apps.v1"
const VIEWS_CHANGED_EVENT = "rvbbit-lens:apps-changed"

function readAll(): ViewApp[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is ViewApp => p && typeof p.id === "string")
  } catch {
    return []
  }
}

function writeAll(apps: ViewApp[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(apps))
    window.dispatchEvent(new Event(VIEWS_CHANGED_EVENT))
    shadowViews(apps) // durable backup to the server homebase (debounced, best-effort)
  } catch {
    // best-effort
  }
}

/** Replace the local store with a server-pulled set (on home adoption). Writes
 *  localStorage directly — never re-shadows, so a pull can't echo back. */
export function hydrateViews(views: unknown): void {
  if (typeof window === "undefined") return
  try {
    const arr = Array.isArray(views)
      ? views.filter((p): p is ViewApp => !!p && typeof (p as ViewApp).id === "string")
      : []
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
    window.dispatchEvent(new Event(VIEWS_CHANGED_EVENT))
  } catch {
    // best-effort
  }
}

export function listViewApps(): ViewApp[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name))
}

export function getViewApp(id: string): ViewApp | null {
  return readAll().find((a) => a.id === id) ?? null
}

export interface ViewAppInput {
  id?: string
  name: string
  description?: string
  kind?: "query" | "scry"
  sql?: string
  iconKey?: string
  iconColor?: string
  connectionId?: string | null
  chartSpec?: Record<string, unknown> | null
  statementViews?: Record<string, StatementViewKind>
  statementLayout?: DataPayload["statementLayout"]
  viewKind?: DataPayload["viewKind"]
  controlField?: string
  scry?: ScryViewState | null
}

export function upsertViewApp(input: ViewAppInput): ViewApp {
  const now = new Date().toISOString()
  const all = readAll()
  const existingIdx = input.id ? all.findIndex((a) => a.id === input.id) : -1
  const existing = existingIdx >= 0 ? all[existingIdx] : undefined
  const next: ViewApp = {
    id: input.id ?? existing?.id ?? randomUUID(),
    name: input.name.trim() || existing?.name || "Untitled",
    description: input.description ?? existing?.description,
    kind: input.kind ?? existing?.kind ?? "query",
    sql: input.sql ?? existing?.sql ?? "",
    iconKey: input.iconKey ?? existing?.iconKey ?? "play",
    iconColor: input.iconColor ?? existing?.iconColor ?? "oklch(76% 0.14 195)",
    connectionId: input.connectionId ?? existing?.connectionId ?? null,
    chartSpec: input.chartSpec ?? existing?.chartSpec ?? null,
    statementViews: input.statementViews ?? existing?.statementViews,
    statementLayout: input.statementLayout ?? existing?.statementLayout,
    viewKind: input.viewKind ?? existing?.viewKind,
    controlField: input.controlField ?? existing?.controlField,
    scry: input.scry ?? existing?.scry ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  if (existingIdx >= 0) all[existingIdx] = next
  else all.push(next)
  writeAll(all)
  return next
}

export function deleteViewApp(id: string): boolean {
  const all = readAll()
  const next = all.filter((a) => a.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  return true
}
