"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CATALOG_GRAPH } from "@/lib/rvbbit/data-search"
import { fetchKgNeighborsById } from "@/lib/rvbbit/kg"
import { emptySpider, mergeNeighbors, type SpiderState } from "@/lib/desktop/scry-spider"
import { MAX_EDGES_PER_EXPAND, MAX_SPIDER_NODES, MAX_TOTAL_NODES } from "@/lib/desktop/scry-limits"
import type { ScryNode } from "@/lib/desktop/scry-scene"

const MAX_EDGES = MAX_EDGES_PER_EXPAND

export interface UseScrySpider {
  spider: SpiderState
  /** node ids with an expansion in flight */
  expanding: Set<string>
  /** node ids already expanded (idempotent re-expand becomes a no-op) */
  expanded: Set<string>
  /** node ids whose expansion was truncated at MAX_EDGES */
  truncated: Set<string>
  /** node ids whose expansion was refused because the graph is at the node cap */
  capped: Set<string>
  expand: (source: ScryNode) => void
  moveSpiderNode: (id: string, x: number, y: number) => void
  /** remove a spider node + its incident edges (and its expand-tracking state) */
  removeSpiderNode: (id: string) => void
}

export function useScrySpider(args: {
  connectionId: string | null
  open: boolean
  /** live read of the current hit-node ids, for cross-population dedupe */
  hitIds: () => Set<string>
  /** KG graph_id to spider neighbors in (catalog vs data layer) */
  graph?: string
}): UseScrySpider {
  const [spider, setSpider] = useState<SpiderState>(emptySpider)
  const spiderRef = useRef(spider)
  spiderRef.current = spider
  const [expanding, setExpanding] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [truncated, setTruncated] = useState<Set<string>>(new Set())
  const [capped, setCapped] = useState<Set<string>>(new Set())
  const inflight = useRef<Set<string>>(new Set())
  // Nodes removed this session. Persists through an in-flight expand's async
  // boundary (sessionRef only changes on open/close), so a fetch that lands
  // AFTER its source was removed is dropped instead of resurrecting the node.
  const removed = useRef<Set<string>>(new Set())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const hitIdsRef = useRef(args.hitIds)
  hitIdsRef.current = args.hitIds
  const connRef = useRef(args.connectionId)
  connRef.current = args.connectionId
  const graphRef = useRef(args.graph ?? CATALOG_GRAPH)
  graphRef.current = args.graph ?? CATALOG_GRAPH
  // Monotonic session id, bumped on every open/close transition. An expand
  // captures it at start and drops its result if the session changed — immune
  // to rapid close/reopen during an in-flight fetch (a plain "is open" boolean
  // is not, since it reads true again after a reopen).
  const sessionRef = useRef(0)

  // Reset the whole spider on EVERY open/close transition AND on a source/graph
  // switch — each session (and each layer) starts clean.
  useEffect(() => {
    sessionRef.current++
    setSpider(emptySpider())
    setExpanding(new Set())
    setExpanded(new Set())
    setTruncated(new Set())
    setCapped(new Set())
    inflight.current = new Set()
    removed.current = new Set()
  }, [args.open, args.graph])

  const expand = useCallback((source: ScryNode) => {
    const sid = source.id
    if (inflight.current.has(sid) || expandedRef.current.has(sid)) return
    if (removed.current.has(sid)) return // removed this session — don't re-spider it
    const conn = connRef.current
    if (!conn) return
    // Perf cap (surfaced, not silent): refuse to spider once the graph is at
    // capacity — the user clears headroom via node removal or scope, then retries.
    const spiderCount = spiderRef.current.nodes.size
    const total = spiderCount + hitIdsRef.current().size
    if (spiderCount >= MAX_SPIDER_NODES || total >= MAX_TOTAL_NODES) {
      setCapped((s) => new Set(s).add(sid))
      return
    }
    const mySession = sessionRef.current
    inflight.current.add(sid)
    setExpanding((s) => new Set(s).add(sid))
    void (async () => {
      let ok = false
      try {
        const neighbors = await fetchKgNeighborsById(conn, graphRef.current, source.hit.nodeId, MAX_EDGES)
        if (sessionRef.current !== mySession) return // closed/reopened mid-fetch — drop it
        if (removed.current.has(sid)) return // source was removed mid-fetch — don't resurrect it
        const { next, truncated: tr } = mergeNeighbors(
          spiderRef.current,
          source,
          neighbors,
          hitIdsRef.current(),
          MAX_EDGES,
          graphRef.current !== CATALOG_GRAPH,
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

  const removeSpiderNode = useCallback((id: string) => {
    // Mark removed + tear down any in-flight expand so a late fetch can't
    // resurrect the node via mergeNeighbors' source-promotion.
    removed.current.add(id)
    inflight.current.delete(id)
    setSpider((prev) => {
      const hasNode = prev.nodes.has(id)
      const hasEdge = [...prev.edges.values()].some((e) => e.from === id || e.to === id)
      if (!hasNode && !hasEdge) return prev // nothing to do (it's a pure bloom node)
      const nodes = new Map(prev.nodes)
      nodes.delete(id)
      const edges = new Map(prev.edges)
      for (const [k, e] of edges) if (e.from === id || e.to === id) edges.delete(k)
      return { nodes, edges }
    })
    const drop = (s: Set<string>) => {
      if (!s.has(id)) return s
      const n = new Set(s)
      n.delete(id)
      return n
    }
    setExpanded(drop)
    setExpanding(drop)
    setTruncated(drop)
    // Removal frees a node slot, so any "graph at capacity" badge may now be
    // stale. Clear them all — expand() re-checks live sizes and re-flags if the
    // cap is still hit (the badge is a pure marker, decoupled from the gate).
    setCapped((s) => (s.size === 0 ? s : new Set()))
  }, [])

  return { spider, expanding, expanded, truncated, capped, expand, moveSpiderNode, removeSpiderNode }
}
