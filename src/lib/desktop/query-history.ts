"use client"

/**
 * Query history — a rolling list of executed SQL, per browser (localStorage).
 * Distinct from Saved Views (queries you chose to keep): this is "what did I
 * run recently", for re-running past work. Newest first, deduped against the
 * immediately-previous entry, capped.
 */

const STORAGE_KEY = "rvbbit-lens.query-history.v1"
const MAX_ENTRIES = 200

export interface QueryHistoryEntry {
  sql: string
  connectionId: string | null
  at: number
  /** True if the run errored (so the UI can dim/flag it). */
  errored?: boolean
}

function readAll(): QueryHistoryEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QueryHistoryEntry[]).filter((e) => e && typeof e.sql === "string") : []
  } catch {
    return []
  }
}

function writeAll(entries: QueryHistoryEntry[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    /* best effort */
  }
}

/** Record an executed query. No-op for blank SQL; collapses a repeat of the
 *  most-recent entry (re-running the same query just refreshes its timestamp). */
export function pushQueryHistory(sql: string, connectionId: string | null, errored = false): void {
  const trimmed = sql.trim()
  if (!trimmed) return
  const all = readAll()
  const prev = all[0]
  if (prev && prev.sql.trim() === trimmed && prev.connectionId === connectionId) {
    all[0] = { ...prev, at: Date.now(), errored }
  } else {
    all.unshift({ sql: trimmed, connectionId, at: Date.now(), errored })
  }
  writeAll(all)
}

/** Recent queries, newest first. `connectionId` filters to that connection. */
export function listQueryHistory(connectionId?: string | null, limit = MAX_ENTRIES): QueryHistoryEntry[] {
  let all = readAll()
  if (connectionId !== undefined) all = all.filter((e) => e.connectionId === connectionId)
  return all.slice(0, limit)
}

export function clearQueryHistory(): void {
  writeAll([])
}
