"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ScryNode } from "@/lib/desktop/scry-scene"
import { fetchColumnPreview, fetchNodeMeta, fetchTablePreview, type NodeMeta, type PreviewData } from "@/lib/desktop/scry-preview"

export interface PreviewEntry {
  meta: NodeMeta | null
  preview: PreviewData | null
  loading: boolean
  error: string | null
}

export interface UseScryPreview {
  previewed: Set<string>
  cache: Map<string, PreviewEntry>
  togglePreview: (node: ScryNode) => void
}

export function useScryPreview(args: { connectionId: string | null; open: boolean }): UseScryPreview {
  const [previewed, setPreviewed] = useState<Set<string>>(new Set())
  const [cache, setCache] = useState<Map<string, PreviewEntry>>(new Map())
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const connRef = useRef(args.connectionId)
  connRef.current = args.connectionId
  const inflight = useRef<Set<string>>(new Set())
  // Session counter — same guard as useScrySpider: a fetch captures it and
  // drops its result if Scry closed/reopened mid-flight.
  const sessionRef = useRef(0)

  useEffect(() => {
    sessionRef.current++
    setPreviewed(new Set())
    setCache(new Map())
    inflight.current = new Set()
  }, [args.open])

  const fetchFor = useCallback((node: ScryNode) => {
    const id = node.id
    if (inflight.current.has(id)) return
    const conn = connRef.current
    if (!conn) return
    if (node.hit.kind === "db_column" && !node.hit.col) {
      // stamp a visible error rather than silently leaving no cache entry
      // (which would render an indefinite spinner)
      setCache((m) => new Map(m).set(id, { meta: null, preview: null, loading: false, error: "column name unavailable" }))
      return
    }
    const mySession = sessionRef.current
    inflight.current.add(id)
    setCache((m) => new Map(m).set(id, { meta: null, preview: null, loading: true, error: null }))
    void (async () => {
      try {
        const [meta, preview] = await Promise.all([
          fetchNodeMeta(conn, node.hit),
          node.hit.kind === "db_table"
            ? fetchTablePreview(conn, node.hit.schema, node.hit.rel)
            : fetchColumnPreview(conn, node.hit.schema, node.hit.rel, node.hit.col as string),
        ])
        if (sessionRef.current !== mySession) return
        setCache((m) => new Map(m).set(id, { meta, preview, loading: false, error: null }))
      } catch (e) {
        if (sessionRef.current !== mySession) return
        setCache((m) =>
          new Map(m).set(id, {
            meta: null,
            preview: null,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        if (sessionRef.current === mySession) inflight.current.delete(id)
      }
    })()
  }, [])

  const togglePreview = useCallback(
    (node: ScryNode) => {
      const id = node.id
      setPreviewed((s) => {
        const next = new Set(s)
        if (next.has(id)) {
          next.delete(id) // collapse — keep the cache for an instant re-open
        } else {
          next.add(id)
          // fetch on first open, or to RETRY a previously-failed entry
          const entry = cacheRef.current.get(id)
          if (!entry || entry.error) fetchFor(node)
        }
        return next
      })
    },
    [fetchFor],
  )

  return { previewed, cache, togglePreview }
}
