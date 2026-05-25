"use client"

import { useCallback, useEffect, useState } from "react"
import { Database, Eye, RefreshCw, TreeStructure } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount, Metric, Panel } from "./instruments"
import {
  evidenceProvenanceLabel,
  fetchKgEntity,
  fetchKgEvidenceForNode,
  fetchKgNeighbors,
  fetchKgPaths,
  fetchKgRagContext,
  resolveKgNodeId,
  searchKgNodes,
  shortEvidenceText,
  type KgEntityDetail,
  type KgEvidenceRow,
  type KgNeighbor,
  type KgNodeSearchHit,
  type KgPath,
  type KgRagContextRow,
} from "@/lib/rvbbit/kg"
import type {
  KgEntityDetailPayload,
  KgEntitySource,
  KgSourceContext,
} from "@/lib/desktop/types"

interface KgEntityDetailWindowProps {
  payload: KgEntityDetailPayload
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
  onOpenKgBrowser: (graphId?: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
  onOpenKgExplorer: (graphId?: string, seedKind?: string | null, seedLabel?: string | null) => void
}

type Tab = "neighbors" | "aliases" | "evidence" | "rag" | "path"

/** The breadcrumb source a new entity would record when navigated from `e`. */
function entitySource(e: KgEntityDetail): KgEntitySource {
  return {
    kind: "kg-entity",
    label: `KG · ${e.label}`,
    graphId: e.graphId,
    entityKind: e.kind,
    entityLabel: e.label,
    nodeId: e.nodeId,
  }
}

export function KgEntityDetailWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenEntity,
  onOpenQueryLens,
  onOpenKgBrowser,
  onOpenSourceRow,
  onOpenKgExplorer,
}: KgEntityDetailWindowProps) {
  const [nodeId, setNodeId] = useState<number | null>(payload.nodeId ?? null)
  const [entity, setEntity] = useState<KgEntityDetail | null>(null)
  const [tab, setTab] = useState<Tab>("neighbors")
  const [neighbors, setNeighbors] = useState<KgNeighbor[]>([])
  const [evidence, setEvidence] = useState<KgEvidenceRow[]>([])
  const [rag, setRag] = useState<KgRagContextRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Resolve (kind, label) → nodeId when no nodeId was passed in.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    const run = async () => {
      if (payload.nodeId != null) {
        if (!cancelled) setNodeId(payload.nodeId)
        return
      }
      if (!payload.entityKind || !payload.entityLabel || !payload.graphId) return
      const id = await resolveKgNodeId(
        activeConnectionId,
        payload.graphId,
        payload.entityKind,
        payload.entityLabel,
      )
      if (cancelled) return
      setNodeId(id)
      if (id == null) {
        setError(
          `No node found for kind=${payload.entityKind} label=${payload.entityLabel} in graph ${payload.graphId}`,
        )
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, payload.nodeId, payload.entityKind, payload.entityLabel, payload.graphId])

  // Load entity + the active tab's data when nodeId resolves or tab changes.
  useEffect(() => {
    if (!activeConnectionId || nodeId == null) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      const r = await fetchKgEntity(activeConnectionId, nodeId)
      if (cancelled) return
      setEntity(r.entity)
      setError(r.error ?? null)
      if (r.entity) {
        const { graphId, kind, label } = r.entity
        if (tab === "neighbors") {
          const n = await fetchKgNeighbors(activeConnectionId, graphId, kind, label, 1, "both")
          if (!cancelled) setNeighbors(n)
        } else if (tab === "evidence") {
          const ev = await fetchKgEvidenceForNode(activeConnectionId, graphId, nodeId)
          if (!cancelled) setEvidence(ev)
        } else if (tab === "rag") {
          const rows = await fetchKgRagContext(activeConnectionId, graphId, kind, label, 2, 50)
          if (!cancelled) setRag(rows)
        }
      }
      if (!cancelled) setLoading(false)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, nodeId, tab])

  // Manual refresh handler — bumps a counter that re-triggers the load effect
  // by changing tab momentarily (cheap) — or callers can switch tabs.
  const reload = useCallback(async () => {
    if (!activeConnectionId || nodeId == null) return
    const r = await fetchKgEntity(activeConnectionId, nodeId)
    setEntity(r.entity)
    setError(r.error ?? null)
  }, [activeConnectionId, nodeId])

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-chrome-text">
        The active connection has no <code>pg_rvbbit</code> extension installed.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <EntityHeader
        entity={entity}
        loading={loading}
        source={payload.source ?? null}
        onRefresh={() => void reload()}
        onOpenBrowser={() => onOpenKgBrowser(entity?.graphId)}
        onOpenExplorer={() =>
          entity && onOpenKgExplorer(entity.graphId, entity.kind, entity.label)
        }
        onOpenSource={(s) => {
          // Re-trigger the original opener so the chip "← from X" returns to X.
          if (s.kind === "lens") onOpenQueryLens(s.queryId)
          else if (s.kind === "browser") onOpenKgBrowser(s.graphId)
          else if (s.kind === "kg-entity") {
            onOpenEntity(s.entityKind, s.entityLabel, s.graphId, undefined, s.nodeId)
          }
        }}
      />

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      {!entity ? (
        <div className="flex flex-1 items-center justify-center text-[11px] text-chrome-text">
          {loading ? "loading entity…" : "no entity"}
        </div>
      ) : (
        <>
          <TabBar tab={tab} onChange={setTab} entity={entity} />
          <div className="flex-1 overflow-auto p-3">
            {tab === "neighbors" ? (
              <NeighborsPanel
                neighbors={neighbors}
                graphId={entity.graphId}
                onOpenEntity={onOpenEntity}
                sourceFromHere={entitySource(entity)}
              />
            ) : tab === "aliases" ? (
              <AliasesPanel entity={entity} />
            ) : tab === "evidence" ? (
              <EvidencePanel
                evidence={evidence}
                onOpenLens={onOpenQueryLens}
                onOpenSourceRow={onOpenSourceRow}
              />
            ) : tab === "rag" ? (
              <RagPanel
                rows={rag}
                graphId={entity.graphId}
                onOpenEntity={onOpenEntity}
                sourceFromHere={entitySource(entity)}
              />
            ) : (
              <PathPanel
                seedEntity={entity}
                activeConnectionId={activeConnectionId}
                onOpenEntity={onOpenEntity}
                sourceFromHere={entitySource(entity)}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────

function EntityHeader({
  entity,
  loading,
  source,
  onRefresh,
  onOpenBrowser,
  onOpenExplorer,
  onOpenSource,
}: {
  entity: KgEntityDetail | null
  loading: boolean
  source: KgEntitySource | null
  onRefresh: () => void
  onOpenBrowser: () => void
  onOpenExplorer: () => void
  onOpenSource: (s: KgEntitySource) => void
}) {
  return (
    <header className="flex items-center gap-2 border-b border-chrome-border/60 bg-secondary-background/40 px-3 py-2">
      <TreeStructure
        className="h-3.5 w-3.5"
        style={{ color: "var(--brand-kg)" }}
      />
      {entity ? (
        <>
          <KindBadge kind={entity.kind} />
          <span className="truncate text-[13px] font-medium text-foreground">
            {entity.label}
          </span>
          <button
            type="button"
            onClick={onOpenBrowser}
            className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] tabular-nums text-chrome-text hover:border-chrome-border hover:text-foreground"
            title="Open KG Browser on this graph"
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--brand-kg)" }}
            />
            <span>graph:</span>
            <span className="font-mono">{entity.graphId}</span>
          </button>
          {entity.confidence != null ? (
            <span className="rounded border border-chrome-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-chrome-text/80">
              conf {entity.confidence.toFixed(2)}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onOpenExplorer}
            className="ml-1 flex items-center gap-1 rounded border border-chrome-border/60 bg-background px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
            style={{ color: "var(--brand-kg)" }}
            title="Open Graph Explorer seeded on this node"
          >
            <TreeStructure className="h-3 w-3" />
            explore
          </button>
        </>
      ) : (
        <span className="text-[11px] text-chrome-text/60">resolving entity…</span>
      )}
      {source ? <Breadcrumb source={source} onClick={() => onOpenSource(source)} /> : null}
      <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/60">
        {loading ? "loading…" : entity?.updatedAt ? `updated ${fmtAgo(entity.updatedAt)}` : "—"}
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

function Breadcrumb({ source, onClick }: { source: KgEntitySource; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-1 flex items-center gap-1 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] text-chrome-text/80 hover:border-chrome-border hover:text-foreground"
      title="Return to source"
    >
      <span>← from</span>
      <span className="font-mono">{source.label}</span>
    </button>
  )
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        background: "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
        color: "var(--brand-kg)",
      }}
    >
      {kind}
    </span>
  )
}

// ── Tabs ────────────────────────────────────────────────────────────

function TabBar({
  tab,
  onChange,
  entity,
}: {
  tab: Tab
  onChange: (t: Tab) => void
  entity: KgEntityDetail
}) {
  const items: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "neighbors", label: "Neighbors" },
    { id: "aliases", label: "Aliases", count: entity.aliases.length },
    { id: "evidence", label: "Evidence", count: entity.evidenceCount },
    { id: "rag", label: "RAG Preview" },
    { id: "path", label: "Path" },
  ]
  return (
    <div className="flex items-center gap-0 border-b border-chrome-border/60 bg-secondary-background/20 px-2">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={cn(
            "border-b-2 px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors",
            tab === it.id
              ? "border-current text-foreground"
              : "border-transparent text-chrome-text hover:text-foreground",
          )}
          style={tab === it.id ? { borderBottomColor: "var(--brand-kg)" } : undefined}
        >
          {it.label}
          {it.count != null ? (
            <span className="ml-1.5 font-mono tabular-nums text-chrome-text/60">
              {fmtCount(it.count)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

// ── Neighbors ───────────────────────────────────────────────────────

function NeighborsPanel({
  neighbors,
  graphId,
  onOpenEntity,
  sourceFromHere,
}: {
  neighbors: KgNeighbor[]
  graphId: string
  onOpenEntity: (
    kind: string,
    label: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  sourceFromHere: KgEntitySource
}) {
  if (neighbors.length === 0) {
    return <Empty text="No neighbors within depth 1." />
  }
  return (
    <ul className="space-y-1">
      {neighbors.map((n) => (
        <li
          key={n.edgeId}
          className="flex items-center gap-2 rounded border border-chrome-border/40 bg-background px-2 py-1.5 text-[11px]"
        >
          <span className="text-chrome-text/55">
            {n.direction === "out" ? "→" : "←"}
          </span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
            style={{
              background: "color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)",
              color: "var(--rvbbit-accent)",
            }}
          >
            {n.predicate}
          </span>
          <button
            type="button"
            onClick={() =>
              onOpenEntity(n.toKind, n.toLabel, graphId, sourceFromHere, n.toNodeId)
            }
            className="flex items-center gap-2 truncate text-left hover:text-foreground"
            title="Open neighbor"
          >
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{
                background: "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
                color: "var(--brand-kg)",
              }}
            >
              {n.toKind}
            </span>
            <span className="truncate font-mono text-foreground">{n.toLabel}</span>
          </button>
          <span className="ml-auto flex items-center gap-2 tabular-nums text-chrome-text/55">
            depth {n.depth}
            {n.edgeConfidence != null ? <span>conf {n.edgeConfidence.toFixed(2)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Aliases ─────────────────────────────────────────────────────────

function AliasesPanel({ entity }: { entity: KgEntityDetail }) {
  if (entity.aliases.length === 0) {
    return <Empty text="No aliases recorded for this node." />
  }
  return (
    <ul className="space-y-1">
      {entity.aliases.map((a) => (
        <li
          key={a.aliasId}
          className="flex items-center gap-3 rounded border border-chrome-border/40 bg-background px-2 py-1 text-[11px]"
        >
          <span className="font-mono text-foreground">{a.alias}</span>
          <span className="ml-auto tabular-nums text-chrome-text/55">
            conf {a.confidence != null ? a.confidence.toFixed(2) : "—"}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Evidence ────────────────────────────────────────────────────────

function EvidencePanel({
  evidence,
  onOpenLens,
  onOpenSourceRow,
}: {
  evidence: KgEvidenceRow[]
  onOpenLens: (queryId: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
}) {
  if (evidence.length === 0) {
    return <Empty text="No evidence rows. User-asserted facts may be evidence-free." />
  }
  return (
    <ul className="space-y-1">
      {evidence.map((e) => (
        <li
          key={e.evidenceId}
          className="rounded border border-chrome-border/40 bg-background px-2 py-1.5 text-[11px]"
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-chrome-text/70">ev #{e.evidenceId}</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{
                background: e.edgeId
                  ? "color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)"
                  : "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
                color: e.edgeId ? "var(--rvbbit-accent)" : "var(--brand-kg)",
              }}
            >
              {e.edgeId ? "edge" : "node"}
            </span>
            <span className="truncate font-mono text-chrome-text/70">
              {evidenceProvenanceLabel(e)}
            </span>
            <Metric
              label="conf"
              value={e.confidence != null ? e.confidence.toFixed(2) : "—"}
            />
            <span className="ml-auto flex items-center gap-2 tabular-nums text-chrome-text/55">
              {e.createdAt ? fmtAgo(e.createdAt) : "—"}
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
                  className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                  style={{ color: "var(--brand-finder)" }}
                  title={`Open source row ${e.sourceTable}#${e.sourcePk}`}
                >
                  <Database className="h-3 w-3" />
                  row
                </button>
              ) : null}
              {e.queryId ? (
                <button
                  type="button"
                  onClick={() => onOpenLens(e.queryId!)}
                  className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                  style={{ color: "var(--brand-query-lens)" }}
                  title="Open this fact's write in Query Lens"
                >
                  <Eye className="h-3 w-3" />
                  lens
                </button>
              ) : null}
            </span>
          </div>
          {e.evidenceText ? (
            <div className="mt-1 rounded bg-foreground/[0.04] px-2 py-1 font-mono text-[11px] text-foreground/85">
              {shortEvidenceText(e.evidenceText, 320)}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// ── RAG Preview ─────────────────────────────────────────────────────

function RagPanel({
  rows,
  graphId,
  onOpenEntity,
  sourceFromHere,
}: {
  rows: KgRagContextRow[]
  graphId: string
  onOpenEntity: (
    kind: string,
    label: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  sourceFromHere: KgEntitySource
}) {
  if (rows.length === 0) {
    return <Empty text="No graph context — try expanding depth or use a different seed." />
  }
  return (
    <Panel
      icon={TreeStructure}
      title={`Top ${rows.length} edges by kg_context score`}
      right={
        <span className="text-[10px] text-chrome-text/55">
          what the model would see for this seed
        </span>
      }
    >
      <ul className="space-y-1">
        {rows.map((r) => (
          <li
            key={r.edgeId}
            className="flex items-center gap-2 rounded border border-chrome-border/40 bg-background px-2 py-1 text-[11px]"
          >
            <span className="w-6 text-right font-mono tabular-nums text-chrome-text/60">
              #{r.contextRank}
            </span>
            <button
              type="button"
              onClick={() =>
                onOpenEntity(r.fromKind, r.fromLabel, graphId, sourceFromHere, r.fromNodeId)
              }
              className="truncate text-left font-mono hover:text-foreground"
              title="Open subject"
            >
              {r.fromLabel}
            </button>
            <span className="text-chrome-text/55">—[</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{
                background: "color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)",
                color: "var(--rvbbit-accent)",
              }}
            >
              {r.predicate}
            </span>
            <span className="text-chrome-text/55">]{r.edgeDirection === "out" ? "→" : "←"}</span>
            <button
              type="button"
              onClick={() =>
                onOpenEntity(r.toKind, r.toLabel, graphId, sourceFromHere, r.toNodeId)
              }
              className="truncate text-left font-mono hover:text-foreground"
              title="Open object"
            >
              {r.toLabel}
            </button>
            <span className="ml-auto flex items-center gap-3 tabular-nums text-chrome-text/55">
              <span>d{r.depth}</span>
              <span>s {r.score.toFixed(2)}</span>
              <span>ev {fmtCount(r.evidenceCount)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-6 text-center text-[11px] italic text-chrome-text/55">{text}</div>
  )
}

// ── Path Finder panel ───────────────────────────────────────────────

function PathPanel({
  seedEntity,
  activeConnectionId,
  onOpenEntity,
  sourceFromHere,
}: {
  seedEntity: KgEntityDetail
  activeConnectionId: string | null
  onOpenEntity: (
    kind: string,
    label: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  sourceFromHere: KgEntitySource
}) {
  const [targetQ, setTargetQ] = useState("")
  const [targetHits, setTargetHits] = useState<KgNodeSearchHit[]>([])
  const [target, setTarget] = useState<KgNodeSearchHit | null>(null)
  const [maxDepth, setMaxDepth] = useState(3)
  const [paths, setPaths] = useState<KgPath[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounced target search.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      if (!targetQ.trim()) {
        setTargetHits([])
        return
      }
      const rows = await searchKgNodes(
        activeConnectionId,
        seedEntity.graphId,
        null,
        targetQ,
        20,
      )
      if (!cancelled) setTargetHits(rows)
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [targetQ, activeConnectionId, seedEntity.graphId])

  const find = useCallback(async () => {
    if (!activeConnectionId || !target) return
    setLoading(true)
    setError(null)
    const r = await fetchKgPaths(
      activeConnectionId,
      seedEntity.graphId,
      seedEntity.kind,
      seedEntity.label,
      target.kind,
      target.label,
      maxDepth,
      "both",
    )
    setPaths(r)
    setLoading(false)
    if (r.length === 0) setError(`No path from ${seedEntity.label} to ${target.label} within depth ${maxDepth}.`)
  }, [activeConnectionId, target, seedEntity.graphId, seedEntity.kind, seedEntity.label, maxDepth])

  return (
    <div className="space-y-3">
      <Panel
        icon={TreeStructure}
        title="Find path"
        right={
          <span className="text-[10px] text-chrome-text/55">
            from <span className="font-mono">{seedEntity.label}</span> · graph <span className="font-mono">{seedEntity.graphId}</span>
          </span>
        }
      >
        <div className="space-y-2">
          <div className="relative">
            <input
              value={target ? `${target.kind} · ${target.label}` : targetQ}
              onChange={(e) => {
                setTarget(null)
                setTargetQ(e.target.value)
              }}
              placeholder="Target node label…"
              className="w-full rounded border border-chrome-border/60 bg-background px-2 py-1 text-[12px] font-mono text-foreground placeholder:text-chrome-text/40 focus:outline-none focus:ring-1 focus:ring-rvbbit-accent/30"
            />
            {!target && targetHits.length > 0 ? (
              <div className="absolute left-0 right-0 top-9 z-20 max-h-[200px] overflow-auto rounded-md border border-chrome-border bg-chrome-bg shadow-lg">
                {targetHits.map((h) => (
                  <button
                    key={h.nodeId}
                    type="button"
                    onClick={() => {
                      setTarget(h)
                      setTargetQ("")
                      setTargetHits([])
                    }}
                    className="flex w-full items-center gap-2 border-b border-chrome-border/40 px-2 py-1.5 text-left text-[11px] hover:bg-foreground/[0.06]"
                  >
                    <span
                      className="rounded-full px-1.5 py-0 text-[9px] uppercase tracking-wider"
                      style={{
                        background: "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
                        color: "var(--brand-kg)",
                      }}
                    >
                      {h.kind}
                    </span>
                    <span className="truncate font-mono text-foreground">{h.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-chrome-text/70">max depth:</span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={maxDepth}
              onChange={(e) => setMaxDepth(parseInt(e.target.value, 10))}
              className="w-32"
            />
            <span className="font-mono tabular-nums">{maxDepth}</span>
            <button
              type="button"
              onClick={() => void find()}
              disabled={!target || loading}
              className="ml-auto rounded border border-chrome-border/60 px-3 py-0.5 text-[11px] hover:border-chrome-border hover:bg-foreground/[0.06] disabled:opacity-50"
            >
              {loading ? "searching…" : "find paths"}
            </button>
          </div>
          {error ? (
            <div className="rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">{error}</div>
          ) : null}
        </div>
      </Panel>

      {paths != null && paths.length > 0 ? (
        <Panel
          icon={TreeStructure}
          title={`Paths · ${paths.length}`}
          right={
            <span className="text-[10px] text-chrome-text/55">
              shortest first
            </span>
          }
        >
          <ul className="space-y-2">
            {paths.map((p, i) => (
              <li
                key={i}
                className="rounded border border-chrome-border/40 bg-background px-2 py-2"
              >
                <div className="flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/55">
                  <span>length {p.length}</span>
                </div>
                <PathChain
                  path={p}
                  graphId={seedEntity.graphId}
                  onOpenEntity={onOpenEntity}
                  sourceFromHere={sourceFromHere}
                />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}

function PathChain({
  path,
  graphId,
  onOpenEntity,
  sourceFromHere,
}: {
  path: KgPath
  graphId: string
  onOpenEntity: (
    kind: string,
    label: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  sourceFromHere: KgEntitySource
}) {
  // We have labels[i] and edges[i] between labels[i] and labels[i+1].
  // We don't have per-node kinds in the path payload; fall back to "node"
  // pill style. The node IDs are clickable to open detail without kind
  // (we'll let resolveKgNodeId handle nodeId-direct).
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
      {path.labels.map((label, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              onOpenEntity("", label, graphId, sourceFromHere, path.nodeIds[i] ?? null)
            }
            className="inline-flex items-center gap-1 rounded border border-chrome-border/40 bg-secondary-background/40 px-1.5 py-0.5 font-mono hover:border-chrome-border hover:text-foreground"
            title={`node ${path.nodeIds[i]}`}
          >
            <span className="text-foreground">{label}</span>
          </button>
          {i < path.edges.length ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-chrome-text/55">─</span>
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                style={{
                  background: "color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)",
                  color: "var(--rvbbit-accent)",
                }}
                title={`edge ${path.edges[i].edgeId} · conf ${path.edges[i].confidence?.toFixed(2) ?? "—"}`}
              >
                {path.edges[i].predicate}
              </span>
              <span className="text-chrome-text/55">→</span>
            </span>
          ) : null}
        </span>
      ))}
    </div>
  )
}
