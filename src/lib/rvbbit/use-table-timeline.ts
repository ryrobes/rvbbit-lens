"use client"

import { useEffect, useState } from "react"
import { fetchTimeline, type RvbbitTableRef, type TimelineTick } from "./time-travel"

// Module-level cache, keyed by connection + table. Lives for the page lifetime
// so re-expanding a row is instant; the at-rest stats already refresh on schema
// reload, so a short-lived stale timeline on hover is fine.
const cache = new Map<string, TimelineTick[]>()

/**
 * Lazily fetch a table's time-travel timeline — only when `enabled` (the caller
 * passes `expanded && isRvbbit`), cached per table. Heap/unexpanded rows never
 * hit the DB.
 */
export function useTableTimeline(connectionId: string | null, table: RvbbitTableRef, enabled: boolean) {
  const key = connectionId ? `${connectionId}::${table.schema}.${table.name}` : ""
  const [ticks, setTicks] = useState<TimelineTick[]>(() => cache.get(key) ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !connectionId) return
    const cached = cache.get(key)
    if (cached) {
      setTicks(cached)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchTimeline(connectionId, table)
      .then((res) => {
        if (cancelled) return
        if (res.error) {
          setError(res.error)
          return // don't cache an error — let a re-expand retry
        }
        cache.set(key, res.ticks)
        setTicks(res.ticks)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, connectionId, key, table.schema, table.name])

  return { ticks, loading, error }
}
