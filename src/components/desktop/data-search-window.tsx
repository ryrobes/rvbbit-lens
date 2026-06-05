"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CaretRight, Database, RefreshCw, Search, TreeStructure } from "@/lib/icons"
import { fmtAgo, fmtCount } from "./instruments"
import {
  crawlCatalog,
  fetchCatalogStatus,
  hitLabel,
  searchData,
  shortDoc,
  type CatalogKind,
  type CatalogStatus,
  type DataSearchHit,
} from "@/lib/rvbbit/data-search"
import type { DataSearchPayload } from "@/lib/desktop/types"

interface DataSearchWindowProps {
  payload: DataSearchPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  /** Open the underlying table in a Data window. */
  onOpenTable: (schema: string, name: string) => void
  /** Open a single field as a focused query (distribution / numeric summary). */
  onOpenField: (schema: string, rel: string, col: string) => void
  /** Open the db_catalog graph (optionally seeded at a node) in the KG Explorer. */
  onOpenCatalogGraph: (seedKind?: string | null, seedLabel?: string | null) => void
}

type KindFilter = "all" | "db_table" | "db_column"

const KIND_COLOR: Record<CatalogKind, string> = {
  db_table: "var(--brand-kg)",
  db_column: "color-mix(in oklch, var(--brand-kg) 55%, var(--brand-query-lens))",
}

export function DataSearchWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenTable,
  onOpenField,
  onOpenCatalogGraph,
}: DataSearchWindowProps) {
  const [q, setQ] = useState(payload.initialQuery ?? "")
  const [kindFilter, setKindFilter] = useState<KindFilter>("all")
  const [hits, setHits] = useState<DataSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<CatalogStatus | null>(null)
  const [crawling, setCrawling] = useState(false)
  const [crawlMsg, setCrawlMsg] = useState<string | null>(null)
  const seq = useRef(0)

  const refreshStatus = useCallback(async () => {
    if (!activeConnectionId) return
    setStatus(await fetchCatalogStatus(activeConnectionId))
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    ;(async () => {
      const s = await fetchCatalogStatus(activeConnectionId)
      if (!cancelled) setStatus(s)
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  // Debounced search — mirrors the KG explorer's SeedPicker. All state
  // updates happen inside the timeout callback (not the effect body) so the
  // search stays cheap and lint-clean.
  useEffect(() => {
    if (!activeConnectionId) return
    const mine = ++seq.current
    const t = setTimeout(async () => {
      const query = q.trim()
      if (!query) {
        setHits([])
        setSearching(false)
        setError(null)
        return
      }
      setSearching(true)
      const kinds: CatalogKind[] | null = kindFilter === "all" ? null : [kindFilter]
      const { hits, error } = await searchData(activeConnectionId, query, 30, kinds)
      if (mine !== seq.current) return // a newer search superseded this one
      setHits(hits)
      setError(error ?? null)
      setSearching(false)
    }, 180)
    return () => clearTimeout(t)
  }, [q, kindFilter, activeConnectionId])

  const runCrawl = useCallback(async () => {
    if (!activeConnectionId || crawling) return
    setCrawling(true)
    setCrawlMsg(null)
    const { result, error } = await crawlCatalog(activeConnectionId, {})
    if (error) {
      setCrawlMsg(`Crawl failed: ${error}`)
    } else if (result) {
      setCrawlMsg(
        `Crawled ${fmtCount(result.tables)} tables · ${fmtCount(result.columns)} columns · ${fmtCount(result.docsEmbedded)} embedded`,
      )
    }
    await refreshStatus()
    setCrawling(false)
    // re-run the active search against the refreshed catalog
    if (q.trim() && activeConnectionId) {
      const kinds: CatalogKind[] | null = kindFilter === "all" ? null : [kindFilter]
      const r = await searchData(activeConnectionId, q.trim(), 30, kinds)
      setHits(r.hits)
    }
  }, [activeConnectionId, crawling, refreshStatus, q, kindFilter])

  // ── Gates ──────────────────────────────────────────────────────────
  if (!activeConnectionId) {
    return <Centered>Connect to a database to search its catalog.</Centered>
  }
  if (!hasRvbbit) {
    return (
      <Centered>
        Data Search needs the <span className="font-mono">rvbbit</span> extension on this connection.
      </Centered>
    )
  }

  const installed = status?.installed ?? true
  const empty = installed && (status?.docs ?? 0) === 0

  return (
    <div className="flex h-full flex-col text-foreground">
      {/* Header: status + controls */}
      <div className="shrink-0 border-b border-chrome-border/60 bg-chrome-bg/40 px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <Database className="h-4 w-4" style={{ color: "var(--brand-kg)" }} />
            Data Search
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenCatalogGraph()}
              className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2 py-0.5 text-[10px] text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
              title="Open the db_catalog graph in the Graph Explorer"
            >
              <TreeStructure className="h-3 w-3" /> Browse graph
            </button>
            <button
              type="button"
              onClick={runCrawl}
              disabled={crawling}
              className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2 py-0.5 text-[10px] text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
              title="Re-fingerprint the database and rebuild the catalog"
            >
              <RefreshCw className={`h-3 w-3 ${crawling ? "animate-spin" : ""}`} />
              {crawling ? "Crawling…" : status?.docs ? "Refresh" : "Crawl"}
            </button>
          </div>
        </div>

        <div className="relative">
          <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2.5 py-1 text-[12px]">
            <Search className="h-3.5 w-3.5 text-chrome-text/60" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="describe the data… e.g. customer email, order status, signup date"
              className="w-full bg-transparent text-[12px] text-foreground placeholder:text-chrome-text/40 focus:outline-none"
            />
            {searching ? <span className="text-[10px] text-chrome-text/50">…</span> : null}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {(["all", "db_table", "db_column"] as const).map((kf) => (
              <button
                key={kf}
                type="button"
                onClick={() => setKindFilter(kf)}
                className={`rounded-full px-2 py-0.5 text-[10px] ${
                  kindFilter === kf
                    ? "bg-foreground/[0.10] text-foreground"
                    : "text-chrome-text/60 hover:text-foreground"
                }`}
              >
                {kf === "all" ? "All" : kf === "db_table" ? "Tables" : "Columns"}
              </button>
            ))}
          </div>
          <div className="text-[10px] text-chrome-text/50">
            {status?.installed
              ? `${fmtCount(status.tables)} tables · ${fmtCount(status.columns)} columns · ${fmtCount(status.embedded)}/${fmtCount(status.docs)} embedded · ${fmtAgo(status.lastRunAt ?? 0)}`
              : "catalog not installed"}
          </div>
        </div>
        {crawlMsg ? <div className="mt-1.5 text-[10px] text-chrome-text/60">{crawlMsg}</div> : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!installed ? (
          <Centered>
            The catalog functions aren&rsquo;t installed on this database. Load{" "}
            <span className="font-mono">crates/pg_rvbbit/sql/catalog_kg.sql</span>, then click{" "}
            <span className="font-medium">Crawl</span>.
          </Centered>
        ) : empty && !q.trim() ? (
          <Centered>
            No catalog yet. Click <span className="font-medium">Crawl</span> to fingerprint this
            database — then search tables and columns by meaning.
          </Centered>
        ) : error ? (
          <Centered>
            <span className="text-danger">{error}</span>
          </Centered>
        ) : !q.trim() ? (
          <Centered>
            Type a phrase to search {fmtCount(status?.docs ?? 0)} fingerprints by meaning. Hits rank
            by semantic similarity, not keywords.
          </Centered>
        ) : hits.length === 0 && !searching ? (
          <Centered>
            No matches for <span className="font-mono">&ldquo;{q.trim()}&rdquo;</span>.
          </Centered>
        ) : (
          <ul className="divide-y divide-chrome-border/30">
            {hits.map((h) => (
              <HitRow
                key={`${h.kind}:${h.nodeId}`}
                hit={h}
                onOpenTable={onOpenTable}
                onOpenField={onOpenField}
                onOpenGraph={onOpenCatalogGraph}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function HitRow({
  hit,
  onOpenTable,
  onOpenField,
  onOpenGraph,
}: {
  hit: DataSearchHit
  onOpenTable: (schema: string, name: string) => void
  onOpenField: (schema: string, rel: string, col: string) => void
  onOpenGraph: (seedKind?: string | null, seedLabel?: string | null) => void
}) {
  const isTable = hit.kind === "db_table"
  const pct = hit.score == null ? null : Math.max(0, Math.min(100, Math.round(hit.score * 100)))
  return (
    <li className="group px-3 py-2 hover:bg-foreground/[0.04]">
      <div className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
          style={{ background: KIND_COLOR[hit.kind], color: "#0009" }}
        >
          {isTable ? "table" : "col"}
        </span>
        <button
          type="button"
          onClick={() =>
            isTable || !hit.col ? onOpenTable(hit.schema, hit.rel) : onOpenField(hit.schema, hit.rel, hit.col)
          }
          className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-foreground hover:underline"
          title={
            isTable || !hit.col
              ? `Open ${hit.schema}.${hit.rel}`
              : `Open field ${hit.schema}.${hit.rel}.${hit.col}`
          }
        >
          <span className="text-chrome-text/55">{hit.schema}.</span>
          {isTable ? (
            <span>{hit.rel}</span>
          ) : (
            <>
              <span className="text-chrome-text/55">{hit.rel}.</span>
              <span>{hit.col}</span>
            </>
          )}
        </button>
        {pct != null ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-chrome-text/45">
            {pct}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => onOpenGraph(hit.kind, hitLabel(hit))}
          className="shrink-0 rounded-base p-1 text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/[0.08] hover:text-foreground group-hover:opacity-100"
          title="Open in catalog graph"
        >
          <CaretRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {pct != null ? (
        <div className="mt-1 ml-[34px] h-0.5 w-[min(220px,60%)] overflow-hidden rounded-full bg-foreground/[0.06]">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--brand-kg)" }} />
        </div>
      ) : null}
      <p className="mt-1 ml-[34px] line-clamp-2 text-[11px] leading-snug text-chrome-text/65">
        {shortDoc(hit.doc, 220)}
      </p>
    </li>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-[11px] leading-relaxed text-chrome-text/60">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  )
}
