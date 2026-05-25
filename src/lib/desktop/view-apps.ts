"use client"

import { randomUUID } from "@/lib/uuid"
import type { ViewApp } from "./types"

/**
 * Local-only view-apps registry (saved SQL queries promoted to desktop
 * icons). Stored under one localStorage key as a JSON array.
 *
 * v1 puts these in the browser; v2 will let us mirror them into a
 * per-database `rvbbit_lens` schema so they travel with the database
 * rather than the browser profile.
 */

const STORAGE_KEY = "rvbbit-lens.view-apps.v1"

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
  sql: string
  iconKey?: string
  iconColor?: string
  connectionId?: string | null
  chartSpec?: Record<string, unknown> | null
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
    sql: input.sql,
    iconKey: input.iconKey ?? existing?.iconKey ?? "play",
    iconColor: input.iconColor ?? existing?.iconColor ?? "oklch(76% 0.14 195)",
    connectionId: input.connectionId ?? existing?.connectionId ?? null,
    chartSpec: input.chartSpec ?? existing?.chartSpec ?? null,
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
