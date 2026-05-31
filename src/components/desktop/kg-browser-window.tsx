"use client"

import { useCallback, useEffect, useState } from "react"
import { Brain, Eye, FlowArrow, RefreshCw, Search, TreeStructure } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount, Metric, Panel } from "./instruments"
import {
  fetchGraphs,
  fetchGraphShape,
  fetchRecentMerges,
  fetchRecentRuns,
  searchKgNodes,
  type KgGraphSummary,
  type KgNodeSearchHit,
  type KgRecentMerge,
  type KgRecentRun,
  type KgShape,
} from "@/lib/rvbbit/kg"
import type { KgBrowserPayload, KgEntitySource } from "@/lib/desktop/types"

interface KgBrowserWindowProps {
  payload: KgBrowserPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenEntity: (
    kind: string,
    label: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  onOpenQueryLens: (queryId: string) => void
  onOpenExtractionRuns: (graphId?: string | null, runId?: number | null) => void
  onOpenMergeReview: (graphId?: string | null) => void
}

export function KgBrowserWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenEntity,
  onOpenQueryLens,
  onOpenExtractionRuns,
  onOpenMergeReview,
}: KgBrowserWindowProps) {
  const [graphs, setGraphs] = useState<KgGraphSummary[]>([])
  const [activeGraph, setActiveGraph] = useState<string | null>(payload.graphId ?? null)
  const [shape, setShape] = useState<KgShape | null>(null)
  const [runs, setRuns] = useState<KgRecentRun[]>([])
  const [merges, setMerges] = useState<KgRecentMerge[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [kindFilter, setKindFilter] = useState<string | null>(null)

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      const r = await fetchGraphs(activeConnectionId)
      if (cancelled) return
      setGraphs(r.rows)
      setError(r.error ?? null)
      setUpdatedAt(Date.now())
      if (!activeGraph && r.rows.length > 0) setActiveGraph(r.rows[0].graphId)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, activeGraph])

  useEffect(() => {
    if (!activeConnectionId || !activeGraph) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const [s, rRuns, rMerges] = await Promise.all([
        fetchGraphShape(activeConnectionId, activeGraph),
        fetchRecentRuns(activeConnectionId, activeGraph, 10),
        fetchRecentMerges(activeConnectionId, activeGraph, 10),
      ])
      if (cancelled) return
      setShape(s.shape)
      setRuns(rRuns)
      setMerges(rMerges)
      setError(s.error ?? null)
      setLoading(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, activeGraph])

  // Pull-to-refresh helper (used by header refresh button).
  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchGraphs(activeConnectionId)
    setGraphs(r.rows)
    setError(r.error ?? null)
    setUpdatedAt(Date.now())
    if (activeGraph) {
      setLoading(true)
      const [s, rRuns, rMerges] = await Promise.all([
        fetchGraphShape(activeConnectionId, activeGraph),
        fetchRecentRuns(activeConnectionId, activeGraph, 10),
        fetchRecentMerges(activeConnectionId, activeGraph, 10),
      ])
      setShape(s.shape)
      setRuns(rRuns)
      setMerges(rMerges)
      setLoading(false)
    }
  }, [activeConnectionId, activeGraph])

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-chrome-text">
        The active connection has no <code>pg_rvbbit</code> extension installed.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-foreground">
      <KgBrowserHeader
        activeGraph={activeGraph}
        graphs={graphs}
        updatedAt={updatedAt}
        loading={loading}
        onPickGraph={setActiveGraph}
        onRefresh={() => {
          void refresh()
        }}
      />

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <GraphRail
          graphs={graphs}
          activeGraph={activeGraph}
          onPick={setActiveGraph}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {activeGraph ? (
            <EntitySearchBar
              connectionId={activeConnectionId}
              graphId={activeGraph}
              kinds={shape?.kinds ?? []}
              kindFilter={kindFilter}
              onKindFilterChange={setKindFilter}
              onPick={(hit) =>
                onOpenEntity(
                  hit.kind,
                  hit.label,
                  hit.graphId,
                  {
                    kind: "browser",
                    graphId: hit.graphId,
                    label: `KG Browser · ${hit.graphId}`,
                  },
                  hit.nodeId,
                )
              }
            />
          ) : null}

          <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-auto p-2">
            <Panel icon={TreeStructure} title="Kinds">
              {!shape || shape.kinds.length === 0 ? (
                <EmptyHint text="No node kinds in this graph yet." />
              ) : (
                <KindList kinds={shape.kinds} onPick={(k) => setKindFilter(k)} />
              )}
            </Panel>

            <Panel icon={TreeStructure} title="Predicates">
              {!shape || shape.predicates.length === 0 ? (
                <EmptyHint text="No edges in this graph yet." />
              ) : (
                <PredicateList preds={shape.predicates} />
              )}
            </Panel>

            <Panel
              icon={FlowArrow}
              title="Recent extraction runs"
              className="col-span-2"
              right={
                <span className="flex items-center gap-2 text-[10px] tabular-nums">
                  <button
                    type="button"
                    onClick={() => onOpenExtractionRuns(activeGraph)}
                    className="rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                    style={{ color: "var(--brand-kg)" }}
                  >
                    open dashboard →
                  </button>
                  <span>{runs.length} shown</span>
                </span>
              }
            >
              {runs.length === 0 ? (
                <EmptyHint text="No extraction runs for this graph yet." />
              ) : (
                <RunsList
                  runs={runs}
                  onOpenLens={onOpenQueryLens}
                  onOpenRun={(runId) => onOpenExtractionRuns(activeGraph, runId)}
                />
              )}
            </Panel>

            <Panel
              icon={Brain}
              title="Recent merges"
              className="col-span-2"
              right={
                <span className="flex items-center gap-2 text-[10px] tabular-nums">
                  <button
                    type="button"
                    onClick={() => onOpenMergeReview(activeGraph)}
                    className="rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                    style={{ color: "var(--brand-kg)" }}
                  >
                    open queue →
                  </button>
                  <span>{merges.length} shown</span>
                </span>
              }
            >
              {merges.length === 0 ? (
                <EmptyHint text="No merge audit rows for this graph yet." />
              ) : (
                <MergesList merges={merges} onOpenLens={onOpenQueryLens} />
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────

function KgBrowserHeader({
  activeGraph,
  graphs,
  updatedAt,
  loading,
  onPickGraph,
  onRefresh,
}: {
  activeGraph: string | null
  graphs: KgGraphSummary[]
  updatedAt: number
  loading: boolean
  onPickGraph: (g: string) => void
  onRefresh: () => void
}) {
  return (
    <header className="flex items-center gap-2 border-b border-chrome-border/60 bg-secondary-background/40 px-3 py-2">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-chrome-text">
        <TreeStructure
          className="h-3.5 w-3.5"
          style={{ color: "var(--brand-kg)" }}
        />
        Knowledge Graph
      </span>
      <GraphChip activeGraph={activeGraph} graphs={graphs} onPick={onPickGraph} />
      <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/60">
        {loading ? "loading…" : updatedAt ? `updated ${fmtAgo(updatedAt)}` : "—"}
        <button
          type="button"
          onClick={onRefresh}
          className="rounded p-1 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </span>
    </header>
  )
}

function GraphChip({
  activeGraph,
  graphs,
  onPick,
}: {
  activeGraph: string | null
  graphs: KgGraphSummary[]
  onPick: (g: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums text-foreground hover:border-chrome-border"
        title="Change active graph"
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--brand-kg)" }}
        />
        <span>graph:</span>
        <span className="font-mono">{activeGraph ?? "—"}</span>
      </button>
      {open ? (
        <div
          className="absolute left-0 top-7 z-20 min-w-[220px] rounded-md border border-chrome-border bg-chrome-bg shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {graphs.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-chrome-text">No graphs yet</div>
          ) : (
            graphs.map((g) => (
              <button
                key={g.graphId}
                type="button"
                onClick={() => {
                  onPick(g.graphId)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] hover:bg-foreground/[0.06]",
                  g.graphId === activeGraph ? "text-foreground" : "text-chrome-text",
                )}
              >
                <span className="font-mono">{g.graphId}</span>
                <span className="tabular-nums text-chrome-text/60">
                  {fmtCount(g.nodes)}n · {fmtCount(g.edges)}e
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── Left rail ───────────────────────────────────────────────────────

function GraphRail({
  graphs,
  activeGraph,
  onPick,
}: {
  graphs: KgGraphSummary[]
  activeGraph: string | null
  onPick: (g: string) => void
}) {
  return (
    <div className="flex w-[220px] min-w-[220px] flex-col border-r border-chrome-border/60 bg-secondary-background/30">
      <div className="border-b border-chrome-border/60 px-3 py-2 text-[10px] uppercase tracking-wider text-chrome-text">
        Graphs
      </div>
      <div className="flex-1 overflow-auto">
        {graphs.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-chrome-text">No graphs</div>
        ) : (
          graphs.map((g) => {
            const isActive = g.graphId === activeGraph
            return (
              <button
                key={g.graphId}
                type="button"
                onClick={() => onPick(g.graphId)}
                className={cn(
                  "block w-full border-b border-chrome-border/40 px-3 py-2 text-left text-[11px] hover:bg-foreground/[0.04]",
                  isActive ? "bg-foreground/[0.06] text-foreground" : "text-chrome-text",
                )}
                style={
                  isActive
                    ? { boxShadow: "inset 3px 0 0 var(--brand-kg)" }
                    : undefined
                }
              >
                <div className="font-mono">{g.graphId}</div>
                <div className="mt-1 flex items-center gap-3 text-[10px] tabular-nums text-chrome-text/60">
                  <span>{fmtCount(g.nodes)}n</span>
                  <span>{fmtCount(g.edges)}e</span>
                  <span>{fmtCount(g.evidenceRows)}ev</span>
                </div>
                {g.lastActivity ? (
                  <div className="mt-1 text-[10px] text-chrome-text/50">
                    last {fmtAgo(g.lastActivity)}
                  </div>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Entity search bar ───────────────────────────────────────────────

function EntitySearchBar({
  connectionId,
  graphId,
  kinds,
  kindFilter,
  onKindFilterChange,
  onPick,
}: {
  connectionId: string | null
  graphId: string
  kinds: { kind: string }[]
  kindFilter: string | null
  onKindFilterChange: (k: string | null) => void
  onPick: (hit: KgNodeSearchHit) => void
}) {
  const [q, setQ] = useState("")
  const kind = kindFilter
  const setKind = onKindFilterChange
  const [results, setResults] = useState<KgNodeSearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)

  // debounce
  useEffect(() => {
    if (!connectionId) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      if (q.trim().length === 0 && !kind) {
        setResults([])
        return
      }
      setSearching(true)
      const rows = await searchKgNodes(connectionId, graphId, kind, q, 30)
      if (!cancelled) {
        setResults(rows)
        setSearching(false)
        setOpen(true)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, kind, connectionId, graphId])

  return (
    <div className="relative border-b border-chrome-border/60 bg-secondary-background/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <Search className="h-3.5 w-3.5 text-chrome-text/60" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search nodes by label…"
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-chrome-text/40 focus:outline-none"
        />
        <select
          value={kind ?? ""}
          onChange={(e) => setKind(e.target.value || null)}
          className="rounded border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] text-chrome-text"
        >
          <option value="">all kinds</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.kind}
            </option>
          ))}
        </select>
        {searching ? (
          <span className="text-[10px] text-chrome-text/50">…</span>
        ) : null}
      </div>
      {open && results.length > 0 ? (
        <div
          className="absolute left-3 right-3 top-10 z-20 max-h-[280px] overflow-auto rounded-md border border-chrome-border bg-chrome-bg shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {results.map((r) => (
            <button
              key={r.nodeId}
              type="button"
              onClick={() => {
                onPick(r)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-3 border-b border-chrome-border/40 px-3 py-1.5 text-left text-[11px] hover:bg-foreground/[0.06]"
            >
              <span className="flex items-center gap-2 truncate">
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] tracking-wider"
                  style={{
                    background: "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
                    color: "var(--brand-kg)",
                  }}
                >
                  {r.kind}
                </span>
                <span className="truncate text-foreground">{r.label}</span>
              </span>
              <span className="tabular-nums text-chrome-text/55">
                {r.confidence != null ? r.confidence.toFixed(2) : "—"}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── Shape panels ────────────────────────────────────────────────────

function KindList({
  kinds,
  onPick,
}: {
  kinds: { kind: string; count: number }[]
  onPick: (kind: string) => void
}) {
  const max = Math.max(1, ...kinds.map((k) => k.count))
  return (
    <ul className="space-y-1">
      {kinds.map((k) => (
        <li key={k.kind}>
          <button
            type="button"
            onClick={() => onPick(k.kind)}
            className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-foreground/[0.05]"
            title={`Filter search to ${k.kind}`}
          >
            <span className="w-32 truncate font-mono text-[11px] text-foreground">{k.kind}</span>
            <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${(k.count / max) * 100}%`,
                  background: "var(--brand-kg)",
                  opacity: 0.7,
                }}
              />
            </span>
            <span className="w-12 text-right font-mono text-[11px] tabular-nums text-chrome-text/70">
              {fmtCount(k.count)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function PredicateList({
  preds,
}: {
  preds: { predicate: string; count: number; avgConfidence: number | null }[]
}) {
  const max = Math.max(1, ...preds.map((p) => p.count))
  return (
    <ul className="space-y-1">
      {preds.map((p) => (
        <li key={p.predicate} className="flex items-center gap-2">
          <span className="w-32 truncate font-mono text-[11px] text-foreground">{p.predicate}</span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width: `${(p.count / max) * 100}%`,
                background: "var(--rvbbit-accent)",
                opacity: 0.6,
              }}
            />
          </span>
          <span className="w-12 text-right font-mono text-[11px] tabular-nums text-chrome-text/70">
            {fmtCount(p.count)}
          </span>
          <span className="w-12 text-right font-mono text-[10px] tabular-nums text-chrome-text/50">
            {p.avgConfidence != null ? p.avgConfidence.toFixed(2) : "—"}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Activity rows ───────────────────────────────────────────────────

function RunsList({
  runs,
  onOpenLens,
  onOpenRun,
}: {
  runs: KgRecentRun[]
  onOpenLens: (queryId: string) => void
  onOpenRun: (runId: number) => void
}) {
  return (
    <ul className="space-y-1">
      {runs.map((r) => (
        <li
          key={r.runId}
          className="flex items-center gap-3 rounded border border-chrome-border/40 bg-background px-2 py-1 text-[11px]"
        >
          <StatusPill status={r.status} />
          <button
            type="button"
            onClick={() => onOpenRun(r.runId)}
            className="font-mono text-foreground hover:text-rvbbit-accent"
            title="Open run detail"
          >
            run #{r.runId}
          </button>
          {r.sourceTable ? (
            <span className="truncate font-mono text-chrome-text/70">
              {r.sourceTable}
              {r.sourceColumn ? `:${r.sourceColumn}` : ""}
            </span>
          ) : null}
          {r.focus ? (
            <span className="truncate italic text-chrome-text/60">focus={r.focus}</span>
          ) : null}
          <Metric label="rows" value={fmtCount(r.rowsSeen)} />
          <Metric label="triples" value={fmtCount(r.triplesInserted)} />
          {r.errors > 0 ? (
            <Metric label="errors" value={fmtCount(r.errors)} tone="danger" />
          ) : null}
          <span className="ml-auto flex items-center gap-2 tabular-nums text-chrome-text/50">
            {r.createdAt ? fmtAgo(r.createdAt) : "—"}
            {r.queryId ? (
              <button
                type="button"
                onClick={() => onOpenLens(r.queryId!)}
                className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                style={{ color: "var(--brand-query-lens)" }}
                title="Open in Query Lens"
              >
                <Eye className="h-3 w-3" />
                lens
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

function MergesList({
  merges,
  onOpenLens,
}: {
  merges: KgRecentMerge[]
  onOpenLens: (queryId: string) => void
}) {
  return (
    <ul className="space-y-1">
      {merges.map((m) => (
        <li
          key={m.mergeId}
          className="flex items-center gap-3 rounded border border-chrome-border/40 bg-background px-2 py-1 text-[11px]"
        >
          <span className="font-mono text-foreground">merge #{m.mergeId}</span>
          <span className="truncate text-chrome-text/70">
            loser: <span className="font-mono">{m.loserLabel ?? "—"}</span>
          </span>
          <span className="truncate text-chrome-text/70">
            winner: <span className="font-mono">node {m.winnerNodeId}</span>
          </span>
          <span className="ml-auto flex items-center gap-2 tabular-nums text-chrome-text/50">
            {m.createdAt ? fmtAgo(m.createdAt) : "—"}
            {m.queryId ? (
              <button
                type="button"
                onClick={() => onOpenLens(m.queryId!)}
                className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                style={{ color: "var(--brand-query-lens)" }}
                title="Open in Query Lens"
              >
                <Eye className="h-3 w-3" />
                lens
              </button>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  const tone =
    s === "ok" || s === "complete" || s === "completed" || s === "success"
      ? { bg: "color-mix(in oklch, var(--success) 18%, transparent)", fg: "var(--success)" }
      : s === "running" || s === "started"
        ? { bg: "color-mix(in oklch, var(--info) 18%, transparent)", fg: "var(--info)" }
        : s === "error" || s === "failed"
          ? { bg: "color-mix(in oklch, var(--danger) 18%, transparent)", fg: "var(--danger)" }
          : { bg: "var(--foreground)", fg: "var(--background)" }
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {status || "—"}
    </span>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="py-2 text-center text-[11px] italic text-chrome-text/50">{text}</div>
}
