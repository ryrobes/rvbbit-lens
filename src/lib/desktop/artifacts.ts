"use client"

import { randomUUID } from "@/lib/uuid"
import type { DesktopArtifact } from "./types"

const STORAGE_KEY = "rvbbit-lens.artifacts.v1"

function readAll(): DesktopArtifact[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is DesktopArtifact => p && typeof p.id === "string")
  } catch {
    return []
  }
}

function writeAll(artifacts: DesktopArtifact[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(artifacts))
  } catch {
    // best-effort
  }
}

export function listArtifacts(): DesktopArtifact[] {
  return readAll().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getArtifact(id: string): DesktopArtifact | null {
  return readAll().find((a) => a.id === id) ?? null
}

export interface ArtifactInput {
  id?: string
  title: string
  kind: DesktopArtifact["kind"]
  sourceSql?: string
  specJson?: Record<string, unknown> | null
  specText?: string | null
  connectionId?: string | null
}

export function upsertArtifact(input: ArtifactInput): DesktopArtifact {
  const now = new Date().toISOString()
  const all = readAll()
  const existingIdx = input.id ? all.findIndex((a) => a.id === input.id) : -1
  const existing = existingIdx >= 0 ? all[existingIdx] : undefined
  const next: DesktopArtifact = {
    id: input.id ?? existing?.id ?? randomUUID(),
    title: input.title || existing?.title || "Untitled",
    kind: input.kind,
    sourceSql: input.sourceSql ?? existing?.sourceSql,
    specJson: input.specJson ?? existing?.specJson ?? null,
    specText: input.specText ?? existing?.specText ?? null,
    connectionId: input.connectionId ?? existing?.connectionId ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  if (existingIdx >= 0) all[existingIdx] = next
  else all.push(next)
  writeAll(all)
  return next
}

export function deleteArtifact(id: string): boolean {
  const all = readAll()
  const next = all.filter((a) => a.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  return true
}
