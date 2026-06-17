"use client"

import { useCallback, useEffect, useState } from "react"
import { Database, Eye, Search, TreeStructure, X } from "@/lib/icons"
import { fmtAgo, fmtCount } from "./instruments"
import { colorForVizKind, VIZ_CHIP_FG } from "@/lib/desktop/viz-colors"
import { KnowledgeGraphCanvas, type KgExplorerLayout } from "./kg-sigma-canvas"
import {
  evidenceProvenanceLabel,
  fetchGraphs,
  fetchKgContextGraph,
  fetchKgEvidenceForEdge,
  fetchKgGraphOverview,
  searchKgNodes,
  shortEvidenceText,
  type KgEvidenceRow,
  type KgGraph,
  type KgGraphEdge,
  type KgGraphNode,
  type KgGraphSummary,
  type KgNodeSearchHit,
} from "@/lib/rvbbit/kg"
import type {
  KgEntitySource,
  KgExplorerPayload,
  KgSourceContext,
} from "@/lib/desktop/types"

interface KgExplorerWindowProps {
  payload: KgExplorerPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  onOpenQueryLens: (queryId: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
  onChangePayload: (mut: (p: KgExplorerPayload) => KgExplorerPayload) => void
}

/** One step in the explorer's drill-down trail. */
interface SeedCrumb {
  kind: string
  label: string
}

/** Layout options when no seed is set (overview mode). */
type OverviewLayout = KgExplorerLayout

export function KgExplorerWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenEntity,
  onOpenQueryLens,
  onOpenSourceRow,
  onChangePayload,
}: KgExplorerWindowProps) {
  const [graphId, setGraphId] = useState<string>(payload.graphId ?? "")
  const [graphs, setGraphs] = useState<KgGraphSummary[]>([])
  const [seedKind, setSeedKind] = useState<string | null>(payload.seedKind ?? null)
  const [seedLabel, setSeedLabel] = useState<string | null>(payload.seedLabel ?? null)
  const [depth, setDepth] = useState<number>(payload.depth ?? 2)
  const [direction, setDirection] = useState<"out" | "in" | "both">(
    (payload.direction as "out" | "in" | "both") ?? "both",
  )
  const [maxEdges, setMaxEdges] = useState<number>(payload.maxEdges ?? 80)
  const [overviewLayout, setOverviewLayout] = useState<OverviewLayout>("circular")
  const [graph, setGraph] = useState<KgGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)

  // Breadcrumb trail of seeds the user has drilled through. Empty when
  // we're in the zoomed-out overview. The last entry is always the
  // active seed (and must match seedKind/seedLabel).
  const [trail, setTrail] = useState<SeedCrumb[]>(() =>
    payload.seedKind && payload.seedLabel
      ? [{ kind: payload.seedKind, label: payload.seedLabel }]
      : [],
  )

  // Hover + selection (selection => evidence drawer is open).
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<number | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null)
  const [edgeEvidence, setEdgeEvidence] = useState<KgEvidenceRow[]>([])
  const [edgeEvidenceLoading, setEdgeEvidenceLoading] = useState(false)

  // Load the list of available graphs on mount + auto-default to the most
  // active one when the window was opened without a graphId. Without this
  // the Explorer would silently sit on the literal string "default" which
  // typically has zero nodes — every seed search returns nothing and the
  // window stays stuck on its empty state.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      const r = await fetchGraphs(activeConnectionId)
      if (cancelled) return
      setGraphs(r.rows)
      if (!graphId && r.rows.length > 0) {
        setGraphId(r.rows[0].graphId)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, graphId])

  // Sync to payload when seed/graph changes (so back-navigation works).
  useEffect(() => {
    onChangePayload((p) => ({
      ...p,
      graphId,
      seedKind,
      seedLabel,
      depth,
      direction,
      maxEdges,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId, seedKind, seedLabel, depth, direction, maxEdges])

  // Load topology — seeded constellation when a seed is picked, otherwise
  // the "zoomed out" overview of the whole graph (top-N most-connected
  // nodes + edges between them).
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || !graphId) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const r = seedKind && seedLabel
        ? await fetchKgContextGraph(
            activeConnectionId,
            graphId,
            seedKind,
            seedLabel,
            depth,
            direction,
            maxEdges,
          )
        : await fetchKgGraphOverview(activeConnectionId, graphId, maxEdges)
      if (cancelled) return
      setGraph(r.graph)
      setError(r.error ?? null)
      setUpdatedAt(Date.now())
      setLoading(false)
      setSelectedEdgeId(null)
      setEdgeEvidence([])
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, graphId, seedKind, seedLabel, depth, direction, maxEdges])

  // Load edge evidence when an edge is selected.
  useEffect(() => {
    if (!activeConnectionId || selectedEdgeId == null) return
    let cancelled = false
    const run = async () => {
      setEdgeEvidenceLoading(true)
      const rows = await fetchKgEvidenceForEdge(activeConnectionId, graphId, selectedEdgeId)
      if (!cancelled) {
        setEdgeEvidence(rows)
        setEdgeEvidenceLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, graphId, selectedEdgeId])

  /**
   * Set the active seed. `mode` controls how the trail evolves:
   * - `"drill"` — clicked from inside the canvas (overview or constellation).
   *   Appends to the current trail.
   * - `"jump"` — picked from the seed search field. Resets the trail to a
   *   single fresh entry, because search is a teleport, not a step.
   * - `"truncate-to"` — clicked an earlier breadcrumb. Truncates the trail
   *   to end at this entry (handled by `goToTrailIndex` instead).
   */
  const setSeed = useCallback(
    (kind: string, label: string, mode: "drill" | "jump" = "drill") => {
      setSeedKind(kind)
      setSeedLabel(label)
      setTrail((prev) => {
        const next: SeedCrumb = { kind, label }
        if (mode === "jump") return [next]
        // Drill: avoid duplicating the current head (e.g. clicking the same
        // node twice shouldn't grow the trail).
        if (prev.length > 0 && prev[prev.length - 1].kind === kind && prev[prev.length - 1].label === label) {
          return prev
        }
        return [...prev, next]
      })
    },
    [],
  )

  const goToTrailIndex = useCallback((i: number) => {
    // i === -1 means "Overview" — clear seed entirely.
    if (i < 0) {
      setSeedKind(null)
      setSeedLabel(null)
      setTrail([])
      return
    }
    setTrail((prev) => {
      const next = prev.slice(0, i + 1)
      const head = next[next.length - 1]
      setSeedKind(head?.kind ?? null)
      setSeedLabel(head?.label ?? null)
      return next
    })
  }, [])

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-chrome-text">
        The active connection has no <code>pg_rvbbit</code> extension installed.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-foreground">
      <ExplorerHeader
        graphId={graphId}
        graphs={graphs}
        onChangeGraphId={(g) => {
          setGraphId(g)
          // Switching graphs invalidates the current seed + trail.
          setSeedKind(null)
          setSeedLabel(null)
          setTrail([])
          setGraph(null)
        }}
        depth={depth}
        onChangeDepth={setDepth}
        direction={direction}
        onChangeDirection={setDirection}
        maxEdges={maxEdges}
        onChangeMaxEdges={setMaxEdges}
        trail={trail}
        loading={loading}
        updatedAt={updatedAt}
        nodes={graph?.nodes.length ?? 0}
        edges={graph?.edges.length ?? 0}
        overviewLayout={overviewLayout}
        onChangeOverviewLayout={setOverviewLayout}
        inOverview={!seedKind || !seedLabel}
        onPickSeed={(k, l) => setSeed(k, l, "jump")}
        onGoToTrailIndex={goToTrailIndex}
        connectionId={activeConnectionId}
      />

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 bg-doc-bg/40">
          {graph && graph.nodes.length > 0 ? (
            <KnowledgeGraphCanvas
              graph={graph}
              mode={seedKind && seedLabel ? "constellation" : overviewLayout}
              hoveredNodeId={hoveredNodeId}
              hoveredEdgeId={hoveredEdgeId}
              selectedEdgeId={selectedEdgeId}
              onHoverNode={setHoveredNodeId}
              onHoverEdge={setHoveredEdgeId}
              onClickNode={(n) => {
                if (n.isSeed) return
                setSeed(n.kind, n.label)
              }}
              onClickEdge={(e) => setSelectedEdgeId(e.edgeId)}
              onOpenNodeDetail={(n) =>
                onOpenEntity(
                  n.kind,
                  n.label,
                  graphId,
                  {
                    kind: "browser",
                    graphId,
                    label: `Explorer · ${seedLabel ?? graphId}`,
                  },
                  n.nodeId,
                )
              }
            />
          ) : (
            <SeedEmptyState
              connectionId={activeConnectionId}
              graphId={graphId}
              hasGraphs={graphs.length > 0}
              loading={loading}
              onPickSeed={setSeed}
            />
          )}
        </div>

        {selectedEdgeId != null && graph ? (
          <EdgeEvidenceDrawer
            edge={graph.edges.find((e) => e.edgeId === selectedEdgeId)!}
            nodes={graph.nodes}
            evidence={edgeEvidence}
            loading={edgeEvidenceLoading}
            onClose={() => setSelectedEdgeId(null)}
            onOpenQueryLens={onOpenQueryLens}
            onOpenSourceRow={onOpenSourceRow}
            onOpenNode={(n) =>
              onOpenEntity(
                n.kind,
                n.label,
                graphId,
                { kind: "browser", graphId, label: `Explorer · ${seedLabel}` },
                n.nodeId,
              )
            }
          />
        ) : null}
      </div>
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────

function ExplorerHeader({
  graphId,
  graphs,
  onChangeGraphId,
  depth,
  onChangeDepth,
  direction,
  onChangeDirection,
  maxEdges,
  onChangeMaxEdges,
  trail,
  loading,
  updatedAt,
  nodes,
  edges,
  overviewLayout,
  onChangeOverviewLayout,
  inOverview,
  onPickSeed,
  onGoToTrailIndex,
  connectionId,
}: {
  graphId: string
  graphs: KgGraphSummary[]
  onChangeGraphId: (g: string) => void
  depth: number
  onChangeDepth: (d: number) => void
  direction: "out" | "in" | "both"
  onChangeDirection: (d: "out" | "in" | "both") => void
  maxEdges: number
  onChangeMaxEdges: (n: number) => void
  trail: SeedCrumb[]
  loading: boolean
  updatedAt: number
  nodes: number
  edges: number
  overviewLayout: OverviewLayout
  onChangeOverviewLayout: (l: OverviewLayout) => void
  inOverview: boolean
  onPickSeed: (kind: string, label: string) => void
  onGoToTrailIndex: (i: number) => void
  connectionId: string | null
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-chrome-border/60 bg-secondary-background/40 px-3 py-2">
      <TreeStructure className="h-3.5 w-3.5" style={{ color: "var(--brand-kg)" }} />
      <span className="text-[11px] uppercase tracking-wider text-chrome-text">
        Graph Explorer
      </span>

      <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--brand-kg)" }}
        />
        <span>graph:</span>
        {graphs.length > 0 ? (
          <select
            value={graphId}
            onChange={(e) => onChangeGraphId(e.target.value)}
            className="bg-transparent font-mono text-[11px] text-foreground focus:outline-none"
          >
            {!graphId ? <option value="">—</option> : null}
            {graphs.map((g) => (
              <option key={g.graphId} value={g.graphId}>
                {g.graphId} ({g.nodes}n)
              </option>
            ))}
          </select>
        ) : (
          <input
            value={graphId}
            onChange={(e) => onChangeGraphId(e.target.value)}
            placeholder="no graphs"
            className="w-28 bg-transparent font-mono text-[11px] text-foreground placeholder:text-chrome-text/40 focus:outline-none"
          />
        )}
      </div>

      <SeedPicker connectionId={connectionId} graphId={graphId} onPickSeed={onPickSeed} />

      <Breadcrumbs trail={trail} onGoTo={onGoToTrailIndex} />

      {!inOverview ? (
        <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
          <span>depth:</span>
          <input
            type="range"
            min={1}
            max={3}
            step={1}
            value={depth}
            onChange={(e) => onChangeDepth(parseInt(e.target.value, 10))}
            className="w-16"
          />
          <span className="font-mono">{depth}</span>
        </div>
      ) : null}

      {!inOverview ? (
        <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
          <span>dir:</span>
          <select
            value={direction}
            onChange={(e) => onChangeDirection(e.target.value as "out" | "in" | "both")}
            className="bg-transparent text-[11px] focus:outline-none"
          >
            <option value="both">both</option>
            <option value="out">out</option>
            <option value="in">in</option>
          </select>
        </div>
      ) : (
        <LayoutPicker
          value={overviewLayout}
          onChange={onChangeOverviewLayout}
        />
      )}

      <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
        <span>max:</span>
        <input
          type="range"
          min={20}
          max={500}
          step={20}
          value={maxEdges}
          onChange={(e) => onChangeMaxEdges(parseInt(e.target.value, 10))}
          className="w-20"
        />
        <span className="font-mono">{maxEdges}</span>
      </div>

      <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/60">
        <span>{fmtCount(nodes)}n · {fmtCount(edges)}e</span>
        {loading ? "loading…" : updatedAt ? `updated ${fmtAgo(updatedAt)}` : "—"}
      </span>
    </header>
  )
}

function LayoutPicker({
  value,
  onChange,
}: {
  value: OverviewLayout
  onChange: (v: OverviewLayout) => void
}) {
  const opts: Array<{ id: OverviewLayout; label: string; hint: string }> = [
    { id: "circular", label: "radial", hint: "ordered ring for reading cross-kind chords" },
    { id: "clusters", label: "clusters", hint: "group by kind, see the implicit schema" },
    {
      id: "force",
      label: "atlas",
      hint: "ForceAtlas2 layout on the WebGL graph surface",
    },
  ]
  return (
    <div className="flex items-center gap-0 overflow-hidden rounded-full border border-chrome-border/60 bg-background text-[11px]">
      <span className="px-2 py-0.5 text-chrome-text/70">layout:</span>
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          title={o.hint}
          className={
            value === o.id
              ? "bg-rvbbit-bg/60 px-2 py-0.5 font-mono text-foreground"
              : "px-2 py-0.5 font-mono text-chrome-text hover:bg-foreground/[0.04] hover:text-foreground"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Breadcrumbs({
  trail,
  onGoTo,
}: {
  trail: SeedCrumb[]
  onGoTo: (i: number) => void
}) {
  return (
    <nav
      className="flex min-w-0 max-w-[480px] items-center gap-1 overflow-hidden text-[10px]"
      aria-label="Explorer trail"
    >
      <button
        type="button"
        onClick={() => onGoTo(-1)}
        disabled={trail.length === 0}
        className="shrink-0 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-chrome-text hover:border-chrome-border hover:text-foreground disabled:cursor-default disabled:opacity-60"
        title={trail.length === 0 ? "Overview (current)" : "Return to overview"}
      >
        Overview
      </button>
      {trail.map((c, i) => {
        const isLast = i === trail.length - 1
        return (
          <span key={`${i}-${c.kind}-${c.label}`} className="flex min-w-0 shrink-0 items-center gap-1">
            <span className="text-chrome-text/40">›</span>
            <button
              type="button"
              onClick={() => onGoTo(i)}
              className={
                isLast
                  ? "flex shrink-0 items-center gap-1.5 rounded-full border border-rvbbit-accent/40 bg-rvbbit-bg/40 px-2 py-0.5"
                  : "flex shrink-0 items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 hover:border-chrome-border"
              }
              title={
                isLast
                  ? "Current seed — click Overview to clear"
                  : `Truncate trail to ${c.label}`
              }
            >
              <span
                className="rounded-full px-1 py-0 text-[9px] uppercase tracking-wider"
                style={{ background: kindColor(c.kind), color: VIZ_CHIP_FG }}
              >
                {c.kind}
              </span>
              <span className="truncate font-mono text-foreground">{c.label}</span>
            </button>
          </span>
        )
      })}
    </nav>
  )
}

function SeedPicker({
  connectionId,
  graphId,
  onPickSeed,
}: {
  connectionId: string | null
  graphId: string
  onPickSeed: (kind: string, label: string) => void
}) {
  const [q, setQ] = useState("")
  const [results, setResults] = useState<KgNodeSearchHit[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!connectionId) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      if (!q.trim()) {
        setResults([])
        setOpen(false)
        return
      }
      const rows = await searchKgNodes(connectionId, graphId, null, q, 12)
      if (!cancelled) {
        setResults(rows)
        setOpen(true)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, connectionId, graphId])
  return (
    <div className="relative">
      <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px]">
        <Search className="h-3 w-3 text-chrome-text/60" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="seed: label…"
          className="w-40 bg-transparent text-[11px] text-foreground placeholder:text-chrome-text/40 focus:outline-none"
        />
      </div>
      {open && q.trim() && results.length === 0 ? (
        <div
          className="absolute left-0 top-7 z-30 w-[280px] rounded-md border border-chrome-border bg-chrome-bg px-3 py-2 text-[11px] italic text-chrome-text/55 shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          No nodes matching <span className="font-mono not-italic">&ldquo;{q}&rdquo;</span> in graph <span className="font-mono not-italic">{graphId || "—"}</span>.
        </div>
      ) : null}
      {open && results.length > 0 ? (
        <div
          className="absolute left-0 top-7 z-30 max-h-[260px] w-[280px] overflow-auto rounded-md border border-chrome-border bg-chrome-bg shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {results.map((r) => (
            <button
              key={r.nodeId}
              type="button"
              onClick={() => {
                onPickSeed(r.kind, r.label)
                setQ("")
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 border-b border-chrome-border/40 px-2 py-1.5 text-left text-[11px] hover:bg-foreground/[0.06]"
            >
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                style={{ background: kindColor(r.kind), color: VIZ_CHIP_FG }}
              >
                {r.kind}
              </span>
              <span className="truncate font-mono text-foreground">{r.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SeedEmptyState({
  connectionId,
  graphId,
  hasGraphs,
  loading,
}: {
  connectionId: string | null
  graphId: string
  hasGraphs: boolean
  loading: boolean
  onPickSeed: (kind: string, label: string) => void
}) {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-[11px] text-chrome-text/60">
      <div className="max-w-md space-y-3">
        <TreeStructure
          className="mx-auto h-8 w-8 text-chrome-text/30"
          style={{ color: "color-mix(in oklch, var(--brand-kg) 60%, transparent)" }}
        />
        {loading ? (
          <p>loading overview…</p>
        ) : !hasGraphs ? (
          <p>
            No KG graphs in this database yet. Run{" "}
            <span className="font-mono">rvbbit.kg_assert_node(...)</span> or{" "}
            <span className="font-mono">rvbbit.kg_ingest_table(...)</span> to
            create one.
          </p>
        ) : !graphId ? (
          <p>Pick a graph from the chip in the header to get started.</p>
        ) : (
          <p>This graph is empty — no nodes to render.</p>
        )}
        <p className="text-chrome-text/40">
          Graph: <span className="font-mono">{graphId || "—"}</span>
          {connectionId ? "" : " · (no connection)"}
        </p>
      </div>
    </div>
  )
}

// ── Edge evidence drawer ────────────────────────────────────────────

function EdgeEvidenceDrawer({
  edge,
  nodes,
  evidence,
  loading,
  onClose,
  onOpenQueryLens,
  onOpenSourceRow,
  onOpenNode,
}: {
  edge: KgGraphEdge
  nodes: KgGraphNode[]
  evidence: KgEvidenceRow[]
  loading: boolean
  onClose: () => void
  onOpenQueryLens: (queryId: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
  onOpenNode: (n: KgGraphNode) => void
}) {
  const from = nodes.find((n) => n.nodeId === edge.fromNodeId)
  const to = nodes.find((n) => n.nodeId === edge.toNodeId)
  return (
    <aside className="flex w-[360px] min-w-[360px] flex-col border-l border-chrome-border/60 bg-secondary-background/30">
      <header className="flex items-center gap-2 border-b border-chrome-border/60 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text">
          Edge · {edge.edgeId}
        </span>
        <span className="ml-auto">
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </header>
      <div className="border-b border-chrome-border/40 bg-background/50 px-3 py-2 text-[11px]">
        <div className="flex flex-col gap-1.5">
          {from ? (
            <button
              type="button"
              onClick={() => onOpenNode(from)}
              className="flex items-center gap-2 text-left hover:text-foreground"
              title="Open subject detail"
            >
              <span
                className="rounded-full px-1.5 py-0 text-[9px] uppercase tracking-wider"
                style={{ background: kindColor(from.kind), color: VIZ_CHIP_FG }}
              >
                {from.kind}
              </span>
              <span className="truncate font-mono text-foreground">{from.label}</span>
            </button>
          ) : null}
          <div className="flex items-center gap-2 pl-2">
            <span className="text-chrome-text/55">—[</span>
            <span
              className="rounded-full px-1.5 py-0 text-[9px] uppercase tracking-wider"
              style={{
                background: "color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)",
                color: "var(--rvbbit-accent)",
              }}
            >
              {edge.predicate}
            </span>
            <span className="text-chrome-text/55">]→</span>
            <span className="ml-auto text-[10px] tabular-nums text-chrome-text/55">
              score {edge.score.toFixed(2)}
            </span>
          </div>
          {to ? (
            <button
              type="button"
              onClick={() => onOpenNode(to)}
              className="flex items-center gap-2 text-left hover:text-foreground"
              title="Open object detail"
            >
              <span
                className="rounded-full px-1.5 py-0 text-[9px] uppercase tracking-wider"
                style={{ background: kindColor(to.kind), color: VIZ_CHIP_FG }}
              >
                {to.kind}
              </span>
              <span className="truncate font-mono text-foreground">{to.label}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-chrome-text">
          <span>Evidence · {evidence.length}</span>
          {loading ? <span className="italic">loading…</span> : null}
        </div>
        {evidence.length === 0 && !loading ? (
          <div className="py-4 text-center text-[11px] italic text-chrome-text/55">
            No evidence rows for this edge — it may be user-asserted.
          </div>
        ) : (
          <ul className="space-y-1">
            {evidence.map((e) => (
              <li
                key={e.evidenceId}
                className="rounded border border-chrome-border/40 bg-background px-2 py-1.5 text-[11px]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-chrome-text/70">ev #{e.evidenceId}</span>
                  <span className="truncate font-mono text-chrome-text/70">
                    {evidenceProvenanceLabel(e)}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 tabular-nums text-chrome-text/55">
                    <span>conf {e.confidence?.toFixed(2) ?? "—"}</span>
                  </span>
                </div>
                {e.evidenceText ? (
                  <div className="mt-1 rounded bg-foreground/[0.04] px-2 py-1 font-mono text-[10px] text-foreground/85">
                    {shortEvidenceText(e.evidenceText, 220)}
                  </div>
                ) : null}
                <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                  {e.sourceTable && e.sourcePk ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenSourceRow({
                          sourceTable: e.sourceTable!,
                          sourcePk: e.sourcePk!,
                          sourceColumn: e.sourceColumn,
                        })
                      }
                      className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 hover:border-chrome-border hover:bg-foreground/[0.06]"
                      style={{ color: "var(--brand-finder)" }}
                    >
                      <Database className="h-3 w-3" />
                      row
                    </button>
                  ) : null}
                  {e.queryId ? (
                    <button
                      type="button"
                      onClick={() => onOpenQueryLens(e.queryId!)}
                      className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 hover:border-chrome-border hover:bg-foreground/[0.06]"
                      style={{ color: "var(--brand-query-lens)" }}
                    >
                      <Eye className="h-3 w-3" />
                      lens
                    </button>
                  ) : null}
                  {e.createdAt ? (
                    <span className="ml-auto tabular-nums text-chrome-text/55">
                      {fmtAgo(e.createdAt)}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

// ── Color ───────────────────────────────────────────────────────────

/** Stable color per kind — hash to a theme-derived palette slot. */
function kindColor(kind: string): string {
  return colorForVizKind(kind)
}
