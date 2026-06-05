"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CATALOG_GRAPH } from "@/lib/rvbbit/data-search"
import { fetchKgNeighborsById } from "@/lib/rvbbit/kg"
import { emptySpider, mergeNeighbors, type SpiderState } from "@/lib/desktop/scry-spider"
import type { ScryNode } from "@/lib/desktop/scry-scene"

const MAX_EDGES = 60

export interface UseScrySpider {
  spider: SpiderState
  /** node ids with an expansion in flight */
  expanding: Set<string>
  /** node ids already expanded (idempotent re-expand becomes a no-op) */
  expanded: Set<string>
  /** node ids whose expansion was truncated at MAX_EDGES */
  truncated: Set<string>
  expand: (source: ScryNode) => void
  moveSpiderNode: (id: string, x: number, y: number) => void
}

export function useScrySpider(args: {
  connectionId: string | null
  open: boolean
  /** live read of the current hit-node ids, for cross-population dedupe */
  hitIds: () => Set<string>
}): UseScrySpider {
  const [spider, setSpider] = useState<SpiderState>(emptySpider)
  const spiderRef = useRef(spider)
  spiderRef.current = spider
  const [expanding, setExpanding] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [truncated, setTruncated] = useState<Set<string>>(new Set())
  const inflight = useRef<Set<string>>(new Set())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const hitIdsRef = useRef(args.hitIds)
  hitIdsRef.current = args.hitIds
  const connRef = useRef(args.connectionId)
  connRef.current = args.connectionId
  // Monotonic session id, bumped on every open/close transition. An expand
  // captures it at start and drops its result if the session changed — immune
  // to rapid close/reopen during an in-flight fetch (a plain "is open" boolean
  // is not, since it reads true again after a reopen).
  const sessionRef = useRef(0)

  // Reset the whole spider on EVERY open/close transition — each Scry session
  // starts clean.
  useEffect(() => {
    sessionRef.current++
    setSpider(emptySpider())
    setExpanding(new Set())
    setExpanded(new Set())
    setTruncated(new Set())
    inflight.current = new Set()
  }, [args.open])

  const expand = useCallback((source: ScryNode) => {
    const sid = source.id
    if (inflight.current.has(sid) || expandedRef.current.has(sid)) return
    const conn = connRef.current
    if (!conn) return
    const mySession = sessionRef.current
    inflight.current.add(sid)
    setExpanding((s) => new Set(s).add(sid))
    void (async () => {
      let ok = false
      try {
        const neighbors = await fetchKgNeighborsById(conn, CATALOG_GRAPH, source.hit.nodeId, MAX_EDGES)
        if (sessionRef.current !== mySession) return // closed/reopened mid-fetch — drop it
        const { next, truncated: tr } = mergeNeighbors(
          spiderRef.current,
          source,
          neighbors,
          hitIdsRef.current(),
          MAX_EDGES,
        )
        setSpider(next)
        if (tr) setTruncated((s) => new Set(s).add(sid))
        ok = true
      } catch {
        // fetch failed — leave the node retryable (do NOT mark it expanded)
      } finally {
        if (sessionRef.current === mySession) {
          inflight.current.delete(sid)
          setExpanding((s) => {
            const n = new Set(s)
            n.delete(sid)
            return n
          })
          if (ok) setExpanded((s) => new Set(s).add(sid))
        }
      }
    })()
  }, [])

  const moveSpiderNode = useCallback((id: string, x: number, y: number) => {
    setSpider((prev) => {
      const n = prev.nodes.get(id)
      if (!n) return prev
      const nodes = new Map(prev.nodes)
      nodes.set(id, { ...n, x, y, pinned: true })
      return { nodes, edges: prev.edges }
    })
  }, [])

  return { spider, expanding, expanded, truncated, expand, moveSpiderNode }
}
