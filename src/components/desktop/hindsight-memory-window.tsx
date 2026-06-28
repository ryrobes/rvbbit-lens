"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  RefreshCw,
  Search,
  Table2,
  Tag,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { HindsightMemoryPayload } from "@/lib/desktop/types"
import { KnowledgeGraphCanvas, type KgExplorerLayout } from "./kg-sigma-canvas"
import {
  fetchHindsightBanks,
  fetchHindsightGraph,
  fetchHindsightMemories,
  fetchHindsightMemoryDetail,
  fetchHindsightOps,
  fetchHindsightOverview,
  recallHindsight,
  type HindsightBank,
  type HindsightGraphResult,
  type HindsightMemoryDetail,
  type HindsightMemoryRow,
  type HindsightOpsRows,
  type HindsightOverview,
  type HindsightRecallResult,
} from "@/lib/rvbbit/hindsight"
import type { KgGraphEdge, KgGraphNode } from "@/lib/rvbbit/kg"
import { fmtAgo, fmtCount, Metric, Panel } from "./instruments"

type Tab = "overview" | "memories" | "recall" | "graph" | "ops"

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "memories", label: "Memories" },
  { key: "recall", label: "Recall" },
  { key: "graph", label: "Graph" },
  { key: "ops", label: "Ops" },
]

interface HindsightMemoryWindowProps {
  payload: HindsightMemoryPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onChangePayload: (mut: (p: HindsightMemoryPayload) => HindsightMemoryPayload) => void
}

export function HindsightMemoryWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onChangePayload,
}: HindsightMemoryWindowProps) {
  const [tab, setTab] = useState<Tab>(payload.initialTab ?? "overview")
  const [bankId, setBankId] = useState<string | null>(payload.bankId ?? null)
  const [overview, setOverview] = useState<HindsightOverview | null>(null)
  const [banks, setBanks] = useState<HindsightBank[]>([])
  const [memories, setMemories] = useState<HindsightMemoryRow[]>([])
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const [detail, setDetail] = useState<HindsightMemoryDetail | null>(null)
  const [memoryQuery, setMemoryQuery] = useState("")
  const [recallQuery, setRecallQuery] = useState("")
  const [topK, setTopK] = useState(10)
  const [recall, setRecall] = useState<HindsightRecallResult | null>(null)
  const [graphResult, setGraphResult] = useState<HindsightGraphResult>({ graph: null })
  const [graphLimit, setGraphLimit] = useState(90)
  const [graphLayout, setGraphLayout] = useState<KgExplorerLayout>("clusters")
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<number | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null)
  const [ops, setOps] = useState<HindsightOpsRows | null>(null)
  const [loadingCore, setLoadingCore] = useState(false)
  const [loadingMemories, setLoadingMemories] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadingRecall, setLoadingRecall] = useState(false)
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [loadingOps, setLoadingOps] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)

  useEffect(() => {
    onChangePayload((p) => ({ ...p, initialTab: tab, bankId }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, bankId])

  const selectedBank = useMemo(
    () => banks.find((bank) => bank.bankId === bankId) ?? null,
    [bankId, banks],
  )
  const effectiveRecallBankId = bankId ?? banks[0]?.bankId ?? null

  const loadCore = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) {
      setOverview(null)
      setBanks([])
      return
    }
    setLoadingCore(true)
    setError(null)
    const overviewResult = await fetchHindsightOverview(activeConnectionId)
    const banksResult = overviewResult.overview?.availability.ready
      ? await fetchHindsightBanks(activeConnectionId)
      : { banks: [] as HindsightBank[] }
    setOverview(overviewResult.overview)
    setBanks(banksResult.banks)
    setError(overviewResult.error ?? ("error" in banksResult ? banksResult.error : null) ?? null)
    setUpdatedAt(Date.now())
    setLoadingCore(false)
  }, [activeConnectionId, hasRvbbit])

  const loadMemories = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    setLoadingMemories(true)
    const result = await fetchHindsightMemories(activeConnectionId, {
      bankId,
      query: memoryQuery,
      limit: 180,
    })
    setMemories(result.rows)
    setError(result.error ?? null)
    setSelectedMemoryId((current) => {
      if (current && result.rows.some((row) => row.id === current)) return current
      return result.rows[0]?.id ?? null
    })
    setLoadingMemories(false)
  }, [activeConnectionId, bankId, hasRvbbit, memoryQuery])

  const loadGraph = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    setLoadingGraph(true)
    const result = await fetchHindsightGraph(activeConnectionId, { bankId, limit: graphLimit })
    setGraphResult(result)
    setError(result.error ?? null)
    setSelectedEdgeId(null)
    setLoadingGraph(false)
  }, [activeConnectionId, bankId, graphLimit, hasRvbbit])

  const loadOps = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    setLoadingOps(true)
    const result = await fetchHindsightOps(activeConnectionId, bankId)
    setOps(result)
    setError(result.errors[0] ?? null)
    setLoadingOps(false)
  }, [activeConnectionId, bankId, hasRvbbit])

  const refreshActive = useCallback(async () => {
    await loadCore()
    if (tab === "memories") await loadMemories()
    if (tab === "graph") await loadGraph()
    if (tab === "ops") await loadOps()
  }, [loadCore, loadGraph, loadMemories, loadOps, tab])

  useEffect(() => {
    queueMicrotask(() => {
      void loadCore()
    })
  }, [loadCore])

  useEffect(() => {
    if (!bankId && banks.length === 1) {
      queueMicrotask(() => setBankId(banks[0].bankId))
    }
  }, [bankId, banks])

  useEffect(() => {
    if (tab !== "memories") return
    const timer = window.setTimeout(() => {
      void loadMemories()
    }, 150)
    return () => window.clearTimeout(timer)
  }, [loadMemories, tab])

  useEffect(() => {
    if (!activeConnectionId || !selectedMemoryId || !hasRvbbit) {
      queueMicrotask(() => setDetail(null))
      return
    }
    let cancelled = false
    const run = async () => {
      setLoadingDetail(true)
      const result = await fetchHindsightMemoryDetail(activeConnectionId, selectedMemoryId)
      if (!cancelled) {
        setDetail(result.detail)
        if (result.error) setError(result.error)
        setLoadingDetail(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, selectedMemoryId])

  useEffect(() => {
    if (tab === "graph") {
      queueMicrotask(() => {
        void loadGraph()
      })
    }
  }, [loadGraph, tab])

  useEffect(() => {
    if (tab === "ops") {
      queueMicrotask(() => {
        void loadOps()
      })
    }
  }, [loadOps, tab])

  const runRecall = useCallback(async () => {
    if (!activeConnectionId || !effectiveRecallBankId || !recallQuery.trim()) return
    setLoadingRecall(true)
    setRecall(null)
    const result = await recallHindsight(
      activeConnectionId,
      effectiveRecallBankId,
      recallQuery.trim(),
      { top_k: topK },
    )
    setRecall(result.recall)
    setError(result.error ?? null)
    setLoadingRecall(false)
  }, [activeConnectionId, effectiveRecallBankId, recallQuery, topK])

  const selectedEdge = useMemo(
    () => graphResult.graph?.edges.find((edge) => edge.edgeId === selectedEdgeId) ?? null,
    [graphResult.graph, selectedEdgeId],
  )

  if (!activeConnectionId) {
    return <Centered icon={Database} title="No active connection" detail="Open a database connection to inspect Hindsight memory." />
  }
  if (!hasRvbbit) {
    return <Centered icon={Brain} title="RVBBIT is not installed" detail="Hindsight registration and SQL wrappers live under the rvbbit extension." />
  }

  const ready = overview?.availability.ready ?? false
  const graphActive = ready && tab === "graph"
  return (
    <div className="flex h-full flex-col bg-background/20 text-foreground backdrop-blur-[2px] group-data-[focused=false]/window:bg-background/10">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-chrome-border/60 bg-chrome-bg/40 px-3 backdrop-blur">
        <div className="grid h-7 w-7 place-items-center rounded-md border border-chrome-border/70 bg-foreground/[0.055]">
          <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold leading-tight text-foreground">Hindsight Memory</div>
          <div className="truncate font-mono text-[9px] text-chrome-text/70">
            {ready
              ? `${fmtCount(overview?.memories ?? 0)} memories · ${fmtCount(overview?.links ?? 0)} links`
              : loadingCore
                ? "scanning schema"
                : "schema not ready"}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <select
            value={bankId ?? "__all__"}
            onChange={(e) => setBankId(e.target.value === "__all__" ? null : e.target.value)}
            className="h-7 max-w-[240px] rounded-md border border-chrome-border/70 bg-secondary-background/75 px-2 font-mono text-[10px] text-chrome-text/90 outline-none backdrop-blur focus:border-rvbbit-accent/60"
          >
            <option value="__all__">all banks</option>
            {banks.map((bank) => (
              <option key={bank.bankId} value={bank.bankId}>
                {bank.name || bank.bankId}
              </option>
            ))}
          </select>
          <span
            className={cn(
              "hidden rounded border px-1.5 py-0.5 font-mono text-[9px] md:inline-flex",
              ready
                ? "border-success/35 bg-success/10 text-success"
                : "border-warning/35 bg-warning/10 text-warning",
            )}
          >
            {ready ? "ready" : "missing"}
          </span>
          <button
            type="button"
            onClick={() => void refreshActive()}
            disabled={loadingCore || loadingMemories || loadingGraph || loadingOps}
            title="Refresh"
            className="grid h-7 w-7 place-items-center rounded-md border border-chrome-border/70 text-chrome-text/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-45"
          >
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                (loadingCore || loadingMemories || loadingGraph || loadingOps) && "animate-spin",
              )}
            />
          </button>
        </div>
      </div>

      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-chrome-border/55 bg-chrome-bg/25 px-3 backdrop-blur">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "h-8 rounded-md px-2.5 text-[11px] font-medium transition-colors",
              tab === item.key
                ? "bg-foreground/[0.09] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                : "text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <div className="ml-auto hidden font-mono text-[10px] text-chrome-text/65 md:block">
          updated {updatedAt ? fmtAgo(updatedAt) : "never"}
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 bg-doc-bg/30 p-3 group-data-[focused=false]/window:bg-doc-bg/15",
          graphActive ? "flex flex-col overflow-hidden" : "overflow-auto",
        )}
      >
        {error ? (
          <div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            {error}
          </div>
        ) : null}
        {!ready ? (
          <MissingSchema overview={overview} loading={loadingCore} />
        ) : tab === "overview" ? (
          <Overview overview={overview} banks={banks} selectedBank={selectedBank} onSelectBank={setBankId} />
        ) : tab === "memories" ? (
          <MemoriesView
            query={memoryQuery}
            onQuery={setMemoryQuery}
            rows={memories}
            selectedId={selectedMemoryId}
            onSelect={setSelectedMemoryId}
            detail={detail}
            loading={loadingMemories}
            loadingDetail={loadingDetail}
          />
        ) : tab === "recall" ? (
          <RecallView
            bankId={effectiveRecallBankId}
            banks={banks}
            query={recallQuery}
            onQuery={setRecallQuery}
            topK={topK}
            onTopK={setTopK}
            recall={recall}
            loading={loadingRecall}
            onRun={runRecall}
            onSelectMemory={(id) => {
              setSelectedMemoryId(id)
              setTab("memories")
            }}
          />
        ) : tab === "graph" ? (
          <GraphView
            result={graphResult}
            loading={loadingGraph}
            limit={graphLimit}
            onLimit={setGraphLimit}
            layout={graphLayout}
            onLayout={setGraphLayout}
            hoveredNodeId={hoveredNodeId}
            hoveredEdgeId={hoveredEdgeId}
            selectedEdgeId={selectedEdgeId}
            selectedEdge={selectedEdge}
            onHoverNode={setHoveredNodeId}
            onHoverEdge={setHoveredEdgeId}
            onClickNode={() => undefined}
            onClickEdge={(edge) => setSelectedEdgeId(edge.edgeId)}
            onOpenNodeDetail={() => undefined}
            onRefresh={loadGraph}
          />
        ) : (
          <OpsView ops={ops} loading={loadingOps} />
        )}
      </div>
    </div>
  )
}

function Overview({
  overview,
  banks,
  selectedBank,
  onSelectBank,
}: {
  overview: HindsightOverview | null
  banks: HindsightBank[]
  selectedBank: HindsightBank | null
  onSelectBank: (bankId: string | null) => void
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
      <div className="space-y-3">
        <Panel icon={Activity} title="Footprint">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="banks" value={fmtCount(overview?.banks ?? 0)} />
            <Metric label="documents" value={fmtCount(overview?.documents ?? 0)} />
            <Metric label="chunks" value={fmtCount(overview?.chunks ?? 0)} />
            <Metric label="memories" value={fmtCount(overview?.memories ?? 0)} />
            <Metric label="links" value={fmtCount(overview?.links ?? 0)} />
            <Metric label="entities" value={fmtCount(overview?.entities ?? 0)} />
            <Metric label="invalidated" value={fmtCount(overview?.invalidated ?? 0)} tone={(overview?.invalidated ?? 0) > 0 ? "warning" : undefined} />
            <Metric label="latest" value={overview?.latestMemoryAt ? fmtAgo(overview.latestMemoryAt) : "never"} />
          </div>
        </Panel>

        <Panel icon={Database} title="Banks">
          <div className="overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/25">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-chrome-bg/50 text-[9px] uppercase tracking-wider text-chrome-text/60 backdrop-blur">
                <tr>
                  <th className="px-2 py-1.5">bank</th>
                  <th className="px-2 py-1.5 text-right">memories</th>
                  <th className="px-2 py-1.5 text-right">docs</th>
                  <th className="px-2 py-1.5 text-right">links</th>
                  <th className="px-2 py-1.5 text-right">updated</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <tr
                    key={bank.bankId}
                    onClick={() => onSelectBank(bank.bankId)}
                    className={cn(
                      "cursor-pointer border-t border-chrome-border/40 transition-colors hover:bg-foreground/[0.04]",
                      selectedBank?.bankId === bank.bankId && "bg-rvbbit-accent/10",
                    )}
                  >
                    <td className="min-w-0 px-2 py-1.5">
                      <div className="truncate font-mono text-foreground">{bank.name || bank.bankId}</div>
                      {bank.name ? <div className="truncate font-mono text-[9px] text-chrome-text/60">{bank.bankId}</div> : null}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCount(bank.memoryUnits)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCount(bank.documents)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCount(bank.links)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-chrome-text/60">{bank.updatedAt ? fmtAgo(bank.updatedAt) : "never"}</td>
                  </tr>
                ))}
                {banks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-8 text-center text-chrome-text/60">No banks found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel icon={CheckCircle2} title="Service">
          <div className="space-y-2">
            {(overview?.services ?? []).map((service) => (
              <div key={service.name} className="rounded-md border border-chrome-border/60 bg-secondary-background/35 p-2 backdrop-blur">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-foreground">{service.name}</span>
                  <span className="rounded border border-success/30 bg-success/10 px-1.5 py-0.5 font-mono text-[9px] text-success">
                    {service.status ?? "unknown"}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[9px] text-chrome-text/60">{service.endpointUrl ?? "-"}</div>
                <JsonBlock value={service.health} compact />
              </div>
            ))}
            {(overview?.services ?? []).length === 0 ? (
              <div className="text-[11px] text-chrome-text/60">No registered Hindsight memory service rows.</div>
            ) : null}
          </div>
        </Panel>
        <Panel icon={Table2} title="Tables">
          <div className="grid grid-cols-2 gap-2">
            {(overview?.tables ?? []).map((row) => (
              <Metric key={row.table} label={row.table} value={fmtCount(row.rows)} />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function MemoriesView({
  query,
  onQuery,
  rows,
  selectedId,
  onSelect,
  detail,
  loading,
  loadingDetail,
}: {
  query: string
  onQuery: (q: string) => void
  rows: HindsightMemoryRow[]
  selectedId: string | null
  onSelect: (id: string) => void
  detail: HindsightMemoryDetail | null
  loading: boolean
  loadingDetail: boolean
}) {
  return (
    <div className="grid h-full min-h-[560px] gap-3 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)]">
      <Panel
        icon={Search}
        title="Memory Units"
        right={<span>{loading ? "loading" : `${fmtCount(rows.length)} shown`}</span>}
        className="min-h-0"
      >
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-chrome-border/60 bg-secondary-background/55 px-2 py-1">
          <Search className="h-3.5 w-3.5 text-chrome-text/45" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="filter memory text"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-chrome-text/40"
          />
        </div>
        <div className="max-h-[calc(100vh-260px)] min-h-[430px] overflow-auto rounded-md border border-chrome-border/60 bg-secondary-background/25">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row.id)}
              className={cn(
                "block w-full border-b border-chrome-border/35 px-2.5 py-2 text-left transition-colors last:border-b-0 hover:bg-foreground/[0.04]",
                row.id === selectedId && "bg-rvbbit-accent/10",
              )}
            >
              <div className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-chrome-text/60">
                <span className="rounded border border-chrome-border/65 bg-foreground/[0.03] px-1">{row.factType ?? "memory"}</span>
                <span className="truncate font-mono normal-case tracking-normal">{row.bankId}</span>
                <span className="ml-auto font-mono normal-case tracking-normal">
                  {row.mentionedAt ? fmtAgo(row.mentionedAt) : row.updatedAt ? fmtAgo(row.updatedAt) : "undated"}
                </span>
              </div>
              <div className="line-clamp-3 text-[12px] leading-snug text-foreground">{row.text}</div>
              {row.tags.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.tags.slice(0, 4).map((tag) => (
                    <span key={tag} className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[9px] text-chrome-text/65">
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </button>
          ))}
          {rows.length === 0 ? (
            <div className="grid h-full min-h-[220px] place-items-center text-[11px] text-chrome-text/60">
              {loading ? "Loading memories..." : "No matching memory units."}
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        icon={FileText}
        title="Evidence"
        right={loadingDetail ? <span>loading</span> : selectedId ? <span className="font-mono">{selectedId.slice(0, 8)}</span> : null}
        className="min-h-0"
      >
        {!detail ? (
          <div className="grid min-h-[430px] place-items-center text-[11px] text-chrome-text/60">Select a memory unit.</div>
        ) : (
          <div className="max-h-[calc(100vh-240px)] min-h-[430px] overflow-auto space-y-3 pr-1">
            <DetailSection title="memory" value={detail.memory} />
            <DetailSection title="document" value={detail.document} />
            <DetailSection title="chunk" value={detail.chunk} />
            <DetailSection title={`links (${detail.links.length})`} value={detail.links} />
            <DetailSection title={`entities (${detail.entities.length})`} value={detail.entities} />
            <DetailSection title={`invalidations (${detail.invalidations.length})`} value={detail.invalidations} />
          </div>
        )}
      </Panel>
    </div>
  )
}

function RecallView({
  bankId,
  banks,
  query,
  onQuery,
  topK,
  onTopK,
  recall,
  loading,
  onRun,
  onSelectMemory,
}: {
  bankId: string | null
  banks: HindsightBank[]
  query: string
  onQuery: (q: string) => void
  topK: number
  onTopK: (n: number) => void
  recall: HindsightRecallResult | null
  loading: boolean
  onRun: () => void
  onSelectMemory: (id: string) => void
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
      <Panel icon={Brain} title="Recall">
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/45" />
              <input
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRun()
                }}
                placeholder={bankId ? `recall from ${bankId}` : "select a memory bank"}
                className="h-9 w-full rounded-md border border-chrome-border/60 bg-secondary-background/55 pl-8 pr-2 font-mono text-[12px] text-foreground outline-none placeholder:text-chrome-text/40 focus:border-rvbbit-accent/60"
              />
            </label>
            <button
              type="button"
              onClick={() => void onRun()}
              disabled={loading || !bankId || !query.trim()}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-rvbbit-accent/35 bg-rvbbit-accent/10 px-3 text-[11px] font-medium text-rvbbit-accent transition-colors hover:bg-rvbbit-accent/15 disabled:opacity-45"
            >
              <Search className={cn("h-3.5 w-3.5", loading && "animate-pulse")} />
              Recall
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-chrome-text/65">
              bank: {bankId ?? banks[0]?.bankId ?? "none"}
            </span>
            <div className="ml-auto flex rounded-md border border-chrome-border/60 bg-secondary-background/55 p-0.5">
              {[5, 10, 20].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => onTopK(n)}
                  className={cn(
                    "h-7 rounded px-2 font-mono text-[10px] transition-colors",
                    topK === n ? "bg-foreground/[0.10] text-foreground" : "text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground",
                  )}
                >
                  top {n}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-md border border-chrome-border/60 bg-secondary-background/20">
            {(recall?.results ?? []).map((row) => (
              <button
                key={row.id || row.text}
                type="button"
                onClick={() => row.id && onSelectMemory(row.id)}
                className="block w-full border-b border-chrome-border/35 px-3 py-2 text-left last:border-b-0 hover:bg-foreground/[0.04]"
              >
                <div className="mb-1 flex items-center gap-2 text-[9px] uppercase tracking-wider text-chrome-text/60">
                  <span>{row.factType ?? "memory"}</span>
                  {row.mentionedAt ? <span className="ml-auto font-mono normal-case tracking-normal">{fmtAgo(row.mentionedAt)}</span> : null}
                </div>
                <div className="text-[12px] leading-snug text-foreground">{row.text}</div>
              </button>
            ))}
            {recall && recall.results.length === 0 ? (
              <div className="px-3 py-8 text-center text-[11px] text-chrome-text/60">No recall results.</div>
            ) : null}
            {!recall ? (
              <div className="px-3 py-8 text-center text-[11px] text-chrome-text/60">
                {loading ? "Calling Hindsight..." : "Run recall to inspect ranked evidence."}
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
      <Panel icon={Table2} title="Raw Response">
        <JsonBlock value={recall?.raw ?? {}} />
      </Panel>
    </div>
  )
}

function GraphView({
  result,
  loading,
  limit,
  onLimit,
  layout,
  onLayout,
  hoveredNodeId,
  hoveredEdgeId,
  selectedEdgeId,
  selectedEdge,
  onHoverNode,
  onHoverEdge,
  onClickNode,
  onClickEdge,
  onOpenNodeDetail,
  onRefresh,
}: {
  result: HindsightGraphResult
  loading: boolean
  limit: number
  onLimit: (n: number) => void
  layout: KgExplorerLayout
  onLayout: (layout: KgExplorerLayout) => void
  hoveredNodeId: number | null
  hoveredEdgeId: number | null
  selectedEdgeId: number | null
  selectedEdge: KgGraphEdge | null
  onHoverNode: (id: number | null) => void
  onHoverEdge: (id: number | null) => void
  onClickNode: (n: KgGraphNode) => void
  onClickEdge: (e: KgGraphEdge) => void
  onOpenNodeDetail: (n: KgGraphNode) => void
  onRefresh: () => void
}) {
  const graph = result.graph
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-chrome-border/60 bg-secondary-background/55 p-0.5">
          {(["clusters", "circular", "force"] as KgExplorerLayout[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onLayout(mode)}
              className={cn(
                "h-7 rounded px-2 font-mono text-[10px] transition-colors",
                layout === mode ? "bg-foreground/[0.10] text-foreground" : "text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-chrome-border/60 bg-secondary-background/55 p-0.5">
          {[50, 90, 160, 250].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onLimit(n)}
              className={cn(
                "h-7 rounded px-2 font-mono text-[10px] transition-colors",
                limit === n ? "bg-foreground/[0.10] text-foreground" : "text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-chrome-border/60 px-2 text-[10px] text-chrome-text/85 hover:bg-foreground/[0.06] disabled:opacity-45"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          Refresh
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-chrome-border/60 bg-doc-bg/60 group-data-[focused=false]/window:bg-doc-bg/35">
        {graph && graph.nodes.length > 0 ? (
          <KnowledgeGraphCanvas
            graph={graph}
            mode={layout}
            initialViewLayer="detail"
            hoveredNodeId={hoveredNodeId}
            hoveredEdgeId={hoveredEdgeId}
            selectedEdgeId={selectedEdgeId}
            onHoverNode={onHoverNode}
            onHoverEdge={onHoverEdge}
            onClickNode={onClickNode}
            onClickEdge={onClickEdge}
            onOpenNodeDetail={onOpenNodeDetail}
          />
        ) : (
          <div className="grid h-full min-h-0 place-items-center text-[11px] text-chrome-text/60">
            {loading ? "Building graph..." : result.error ?? "No memory graph rows found."}
          </div>
        )}
      </div>
      {selectedEdge ? (
        <div className="shrink-0 rounded-md border border-chrome-border/60 bg-secondary-background/35 px-3 py-2 text-[11px] backdrop-blur">
          <span className="font-mono text-chrome-text/60">edge</span>{" "}
          <span className="text-foreground">{selectedEdge.predicate}</span>{" "}
          <span className="font-mono text-chrome-text/60">score {selectedEdge.score.toFixed(2)}</span>
        </div>
      ) : null}
    </div>
  )
}

function OpsView({ ops, loading }: { ops: HindsightOpsRows | null; loading: boolean }) {
  if (loading && !ops) {
    return <Centered icon={Activity} title="Loading operations" detail="Reading Hindsight operational tables." />
  }
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <OpsSection title="async operations" rows={ops?.asyncOperations ?? []} />
      <OpsSection title="audit log" rows={ops?.auditLog ?? []} />
      <OpsSection title="llm requests" rows={ops?.llmRequests ?? []} />
      <OpsSection title="invalidated memories" rows={ops?.invalidated ?? []} />
      <OpsSection title="graph queue" rows={ops?.graphQueue ?? []} />
      {ops?.errors.length ? (
        <Panel icon={AlertTriangle} title="Errors">
          <ul className="space-y-1 text-[11px] text-danger">
            {ops.errors.map((err) => <li key={err}>{err}</li>)}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}

function OpsSection({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  return (
    <Panel icon={Clock} title={title} right={<span>{fmtCount(rows.length)}</span>}>
      <div className="max-h-[360px] overflow-auto rounded-md border border-chrome-border/60 bg-secondary-background/20">
        {rows.map((row, i) => (
          <JsonBlock key={String(row.id ?? row.operation_id ?? row.unit_id ?? i)} value={row} compact className="border-b border-chrome-border/35 last:border-b-0" />
        ))}
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-chrome-text/60">No rows.</div>
        ) : null}
      </div>
    </Panel>
  )
}

function MissingSchema({ overview, loading }: { overview: HindsightOverview | null; loading: boolean }) {
  const availability = overview?.availability
  return (
    <Centered
      icon={loading ? RefreshCw : AlertTriangle}
      title={loading ? "Scanning Hindsight schema" : "Hindsight schema is not ready"}
      detail={[
        ["schema", availability?.schemaExists],
        ["banks", availability?.banks],
        ["memory_units", availability?.memoryUnits],
        ["memory_links", availability?.memoryLinks],
        ["entities", availability?.entities],
      ].map(([name, ok]) => `${name}: ${ok ? "ok" : "missing"}`).join(" · ")}
      spin={loading}
    />
  )
}

function DetailSection({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-chrome-text/60">
        <Tag className="h-3 w-3" />
        {title}
      </div>
      <JsonBlock value={value ?? {}} />
    </div>
  )
}

function JsonBlock({
  value,
  compact,
  className,
}: {
  value: unknown
  compact?: boolean
  className?: string
}) {
  return (
    <pre
      className={cn(
        "max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-chrome-border/35 bg-doc-bg/55 p-2 font-mono text-[10px] leading-relaxed text-chrome-text/85",
        compact && "max-h-[180px] rounded-none border-0 bg-transparent p-2 text-[9px]",
        className,
      )}
    >
      {JSON.stringify(value ?? {}, null, compact ? 0 : 2)}
    </pre>
  )
}

function Centered({
  icon: Icon,
  title,
  detail,
  spin,
}: {
  icon: typeof Brain
  title: string
  detail: string
  spin?: boolean
}) {
  return (
    <div className="grid h-full min-h-[420px] place-items-center bg-doc-bg/25 p-6 text-center group-data-[focused=false]/window:bg-doc-bg/10">
      <div className="max-w-xl">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-md border border-chrome-border/70 bg-foreground/[0.055]">
          <Icon className={cn("h-5 w-5 text-rvbbit-accent", spin && "animate-spin")} />
        </div>
        <div className="text-[13px] font-semibold text-foreground">{title}</div>
        <div className="mt-1 font-mono text-[10px] leading-relaxed text-chrome-text/65">{detail}</div>
      </div>
    </div>
  )
}
