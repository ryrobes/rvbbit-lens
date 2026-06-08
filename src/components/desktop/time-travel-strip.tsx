"use client"

/**
 * Window-level mount for the time-travel scrubber.
 *
 * Lifted out of the SQL editor wrapper so the scrubber appears once per
 * window (far right edge) rather than once per editor instance. The SQL
 * editor's text remains the source of truth — this strip parses out the
 * leading `-- rvbbit: as_of = '…'` comment, lets the user scrub, then
 * rewrites the same text via `setSql` + schedules a debounced re-run.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { TimeTravelScrubber } from "./time-travel-scrubber"
import {
  colorForSeriesIndex,
  detectRvbbitTables,
  fetchTimeline,
  parseAsOfComment,
  seriesKey,
  withAsOf,
  type RvbbitTableRef,
  type TimelineSeries,
  type TimelineTick,
} from "@/lib/rvbbit/time-travel"

interface Props {
  sql: string
  /** The COMPILED sql ({block} refs resolved). Detection + the displayed as-of
   *  run off this so a wrapped/downstream window still sees its temporal tables
   *  and inherited as-of. Falls back to `sql` (the raw draft) when absent. */
  detectSql?: string
  onChange: (next: string) => void
  onRun?: () => void
  connectionId: string | null
  hasRvbbit: boolean
}

export function TimeTravelStrip({
  sql,
  detectSql,
  onChange,
  onRun,
  connectionId,
  hasRvbbit,
}: Props) {
  // Detection runs off the COMPILED sql (`body` below). The readout prefers the
  // draft's OWN as-of so scrubbing moves the handle immediately, and falls back
  // to the compiled/inherited one (a downstream window shows what it runs at).
  // Editing (onAsOfChange below) stays on the raw draft `sql`.
  const source = detectSql ?? sql
  const { body, asOf: inheritedAsOf } = useMemo(() => parseAsOfComment(source), [source])
  const ownAsOf = useMemo(() => parseAsOfComment(sql).asOf, [sql])
  const asOf = ownAsOf ?? inheritedAsOf

  const [tables, setTables] = useState<RvbbitTableRef[] | null>(null)
  const lastDetectedBodyRef = useRef<string | null>(null)
  const detectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (lastDetectedBodyRef.current === body && tables !== null) return
    if (detectTimerRef.current) clearTimeout(detectTimerRef.current)
    let cancelled = false
    detectTimerRef.current = setTimeout(async () => {
      if (cancelled) return
      if (!connectionId || !hasRvbbit) {
        lastDetectedBodyRef.current = body
        setTables([])
        return
      }
      const res = await detectRvbbitTables(connectionId, body || source)
      if (cancelled) return
      lastDetectedBodyRef.current = body
      setTables(res)
    }, 400)
    return () => {
      cancelled = true
    }
  }, [connectionId, hasRvbbit, body, source, tables])

  // Per-table timeline cache, keyed by `schema.name` so flipping between
  // snapshots is instant for any table we've already loaded.
  const [tickCache, setTickCache] = useState<Record<string, TimelineTick[]>>({})

  useEffect(() => {
    if (!connectionId || !tables || tables.length === 0) return
    const missing = tables.filter((t) => tickCache[seriesKey(t)] === undefined)
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const results = await Promise.all(
        missing.map((t) => fetchTimeline(connectionId, t)),
      )
      if (cancelled) return
      setTickCache((prev) => {
        const next = { ...prev }
        for (let i = 0; i < missing.length; i++) {
          next[seriesKey(missing[i])] = results[i].ticks
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [connectionId, tables, tickCache])

  const series: TimelineSeries[] = useMemo(() => {
    if (!tables) return []
    const out: TimelineSeries[] = []
    let idx = 0
    for (const t of tables) {
      const ticks = tickCache[seriesKey(t)] ?? []
      if (ticks.length === 0) continue
      out.push({ table: t, color: colorForSeriesIndex(idx), ticks })
      idx += 1
    }
    return out
  }, [tables, tickCache])

  // Debounced re-run on scrub commit — drag fires many onChange calls and
  // only the last settled value should hit the database.
  const runDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onRunRef = useRef(onRun)
  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  const onAsOfChange = useCallback(
    (nextAsOf: string | null) => {
      const nextSql = withAsOf(sql, nextAsOf)
      if (nextSql !== sql) onChange(nextSql)
      if (runDebounceRef.current) clearTimeout(runDebounceRef.current)
      runDebounceRef.current = setTimeout(() => {
        onRunRef.current?.()
      }, 350)
    },
    [sql, onChange],
  )

  if (series.length === 0) return null

  return <TimeTravelScrubber series={series} asOf={asOf} onChange={onAsOfChange} />
}
