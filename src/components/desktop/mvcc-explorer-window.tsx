"use client"

import { useCallback, useMemo, useState, type ComponentType } from "react"

import {
  Activity,
  Clock,
  Database,
  Eye,
  FileText,
  Layers,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Target,
  TerminalSquare,
  Wrench,
} from "@/lib/icons"
import type {
  MvccExplorerPreparedTransaction,
  MvccExplorerReplicationSlot,
  MvccExplorerSession,
  MvccExplorerSnapshot,
  MvccExplorerTable,
  MvccExplorerVacuumWorker,
} from "@/lib/db/mvcc-explorer"
import { usePolling } from "@/lib/desktop/use-polling"
import type { MvccExplorerPayload } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"

type ExplorerView = "horizon" | "tables" | "workers"
type TableSort = "vacuum" | "freeze" | "size"
type SqlOpener = (title: string, sql: string, run: boolean) => void

interface MvccExplorerWindowProps {
  payload: MvccExplorerPayload
  activeConnectionId: string | null
  workspaceActive?: boolean
  onOpenSql: SqlOpener
  onChangePayload: (mutate: (payload: MvccExplorerPayload) => MvccExplorerPayload) => void
}

interface HistoryEntry {
  at: number
  snapshot: MvccExplorerSnapshot
}

type Selection =
  | { kind: "candidate"; id: string }
  | { kind: "table"; oid: string }
  | { kind: "worker"; pid: number }

interface HorizonCandidate {
  id: string
  kind: "session" | "slot" | "prepared"
  label: string
  sublabel: string
  xid: string
  age: number
  source: "backend_xmin" | "backend_xid" | "slot_xmin" | "catalog_xmin" | "prepared_xid"
  session?: MvccExplorerSession
  slot?: MvccExplorerReplicationSlot
  prepared?: MvccExplorerPreparedTransaction
}

const REFRESH_OPTIONS = [
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
] as const

const HISTORY_LIMIT = 600

export function MvccExplorerWindow({
  payload,
  activeConnectionId,
  workspaceActive = true,
  onOpenSql,
  onChangePayload,
}: MvccExplorerWindowProps) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [intervalMs, setIntervalMs] = useState(2000)
  const [paused, setPaused] = useState(false)
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [tableSort, setTableSort] = useState<TableSort>("vacuum")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const view: ExplorerView = payload.view ?? "horizon"
  const tableSearch = payload.tableSearch ?? ""

  const poll = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    try {
      const response = await fetch(
        `/api/db/mvcc-explorer?connectionId=${encodeURIComponent(activeConnectionId)}`,
        { cache: "no-store" },
      )
      const body = await response.json().catch(() => null) as MvccExplorerSnapshot | { error?: string } | null
      if (!response.ok || !body || !("sampledAt" in body)) {
        throw new Error(body && "error" in body ? body.error || `HTTP ${response.status}` : `HTTP ${response.status}`)
      }
      setError(null)
      setHistory((previous) => {
        const next = [...previous, { at: Date.now(), snapshot: body as MvccExplorerSnapshot }]
        return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

  usePolling(poll, intervalMs, {
    enabled: Boolean(activeConnectionId) && workspaceActive && !paused,
    resetKey: activeConnectionId,
  })

  const currentIndex = replayIndex == null ? history.length - 1 : Math.min(replayIndex, history.length - 1)
  const sample = currentIndex >= 0 ? history[currentIndex]?.snapshot ?? null : null
  const candidates = useMemo(() => sample ? deriveCandidates(sample) : [], [sample])
  const selectedCandidate = useMemo(() => {
    const id = selection?.kind === "candidate" ? selection.id : candidates[0]?.id
    return id ? candidates.find((candidate) => candidate.id === id) ?? null : null
  }, [candidates, selection])
  const selectedTable = useMemo(() => {
    if (!sample) return null
    const needle = tableSearch.trim().toLowerCase()
    const exact = needle
      ? sample.tables.find((table) => `${table.schema}.${table.name}`.toLowerCase() === needle) ?? null
      : null
    const oid = selection?.kind === "table" ? selection.oid : null
    const selected = oid ? sample.tables.find((table) => table.oid === oid) ?? null : null
    if (exact) return exact
    if (!selected || !needle) return selected
    return `${selected.schema}.${selected.name}`.toLowerCase().includes(needle) ? selected : null
  }, [sample, selection, tableSearch])
  const selectedWorker = useMemo(() => {
    if (!sample) return null
    const pid = selection?.kind === "worker" ? selection.pid : null
    return pid == null ? null : sample.vacuumWorkers.find((worker) => worker.pid === pid) ?? null
  }, [sample, selection])

  function togglePause() {
    if (paused) {
      setReplayIndex(null)
      setPaused(false)
    } else {
      setPaused(true)
    }
  }

  function replayAt(index: number) {
    setPaused(true)
    setReplayIndex(index >= history.length - 1 ? null : index)
    setPreviewId(null)
  }

  function returnLive() {
    setReplayIndex(null)
    setPaused(false)
  }

  if (!activeConnectionId) {
    return (
      <WindowSurface>
        <CenteredState icon={Database} title="No active connection" detail="Select a Postgres connection to inspect MVCC and vacuum state." />
      </WindowSurface>
    )
  }

  if (!sample) {
    return (
      <WindowSurface>
        <CenteredState
          icon={Layers}
          title={error ? "MVCC snapshot failed" : "Reading MVCC state"}
          detail={error ?? "Waiting for the first catalog and statistics sample."}
          busy={!error}
        />
      </WindowSurface>
    )
  }

  const vacuumDue = sample.tables.filter((table) => table.autovacuumEnabled && Math.max(table.vacuumPressure, table.insertPressure) >= 1).length
  const maxFreeze = Math.max(0, ...sample.tables.map((table) => Math.max(table.freezePressure, table.multixactFreezePressure)))
  const oldestCandidate = candidates[0] ?? null
  const replaying = replayIndex != null

  return (
    <WindowSurface>
      <header className="shrink-0 border-b border-chrome-border/65 bg-secondary-background/50 px-3 py-2 group-data-[focused=false]/window:bg-secondary-background/30">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-brand-mvcc-explorer/35 bg-brand-mvcc-explorer/10">
            <Layers className="h-4 w-4 text-brand-mvcc-explorer" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="shrink-0 text-sm font-semibold">MVCC Explorer</h2>
              <span className="truncate font-mono text-[10px] text-chrome-text/65">
                {sample.connectionLabel} / {sample.database}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[9px] uppercase text-chrome-text/50">
              <StatusDot live={!paused && !replaying} />
              <span>{candidates.length} horizon candidate{candidates.length === 1 ? "" : "s"}</span>
              <span>{vacuumDue} table{vacuumDue === 1 ? "" : "s"} due</span>
              <span>{sample.vacuumWorkers.length} worker{sample.vacuumWorkers.length === 1 ? "" : "s"}</span>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <SegmentedControl
              value={view}
              options={[
                { value: "horizon", label: "Horizon", icon: Target },
                { value: "tables", label: "Tables", icon: Database },
                { value: "workers", label: "Workers", icon: Activity },
              ]}
              onChange={(next) => onChangePayload((current) => ({ ...current, view: next as ExplorerView }))}
            />
            <select
              aria-label="Refresh interval"
              value={intervalMs}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
              className="h-7 rounded-sm border border-chrome-border/60 bg-secondary-background/60 px-1.5 font-mono text-[10px] text-chrome-text outline-none focus:border-brand-mvcc-explorer/60"
            >
              {REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <IconButton title={paused ? "Resume live sampling" : "Pause sampling"} onClick={togglePause}>
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </IconButton>
            <IconButton title="Refresh now" onClick={() => void poll()} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </IconButton>
          </div>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 border-b border-chrome-border/55 sm:grid-cols-4 lg:grid-cols-5">
        <Metric label="Oldest observed candidate" value={oldestCandidate ? formatXids(oldestCandidate.age) : "none"} detail={oldestCandidate?.label ?? "no exposed xmin"} tone={oldestCandidate && oldestCandidate.age > sample.settings.freezeMaxAge * 0.25 ? "warning" : "neutral"} />
        <Metric label="Database frozen XID age" value={formatXids(sample.databaseAge.frozenXidAge)} detail={`${formatPercent(sample.databaseAge.frozenXidAge / sample.settings.freezeMaxAge)} of max age`} tone={sample.databaseAge.frozenXidAge / sample.settings.freezeMaxAge >= 0.75 ? "danger" : "neutral"} />
        <Metric label="Autovacuum pressure" value={String(vacuumDue)} detail={`of ${sample.tables.length} observed tables`} tone={vacuumDue ? "warning" : "neutral"} />
        <Metric label="Highest freeze pressure" value={formatPercent(maxFreeze)} detail="XID or multixact" tone={maxFreeze >= 0.75 ? "danger" : maxFreeze >= 0.5 ? "warning" : "neutral"} />
        <div className="hidden lg:block">
          <Metric label="Exact tuple forensics" value={sample.permissions.pgstattuple || sample.permissions.pageinspect ? "extension detected" : "not installed"} detail={capabilityLabel(sample)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-hidden">
          {view === "horizon" ? (
            <HorizonView
              sample={sample}
              candidates={candidates}
              selectedId={selection?.kind === "candidate" ? selection.id : selectedCandidate?.id ?? null}
              previewId={previewId}
              onPreview={setPreviewId}
              onSelect={(id) => setSelection({ kind: "candidate", id })}
            />
          ) : null}
          {view === "tables" ? (
            <TablesView
              tables={sample.tables}
              sort={tableSort}
              search={tableSearch}
              selectedOid={selectedTable?.oid ?? null}
              onSort={setTableSort}
              onSearch={(search) => onChangePayload((current) => ({ ...current, tableSearch: search }))}
              onSelect={(oid) => setSelection({ kind: "table", oid })}
            />
          ) : null}
          {view === "workers" ? (
            <WorkersView
              sample={sample}
              selectedPid={selection?.kind === "worker" ? selection.pid : null}
              onSelect={(pid) => setSelection({ kind: "worker", pid })}
            />
          ) : null}
        </main>

        <aside className="hidden w-[310px] shrink-0 overflow-y-auto border-l border-chrome-border/55 bg-secondary-background/20 xl:block">
          <Inspector
            sample={sample}
            view={view}
            candidate={selectedCandidate}
            table={selectedTable}
            worker={selectedWorker}
            onOpenSql={onOpenSql}
          />
        </aside>
      </div>

      <HistoryBar
        history={history}
        index={currentIndex}
        paused={paused}
        replaying={replaying}
        onReplay={replayAt}
        onReturnLive={returnLive}
      />
    </WindowSurface>
  )
}

function HorizonView({
  sample,
  candidates,
  selectedId,
  previewId,
  onPreview,
  onSelect,
}: {
  sample: MvccExplorerSnapshot
  candidates: HorizonCandidate[]
  selectedId: string | null
  previewId: string | null
  onPreview: (id: string | null) => void
  onSelect: (id: string) => void
}) {
  const visible = candidates.slice(0, 14)
  const preview = candidates.find((candidate) => candidate.id === previewId) ?? null
  const remaining = preview ? candidates.filter((candidate) => candidate.id !== preview.id) : candidates
  const next = remaining[0] ?? null
  const sameAgePeers = preview ? remaining.filter((candidate) => candidate.age === preview.age).length : 0
  const axisMax = Math.max(100, Math.ceil((candidates[0]?.age ?? 0) * 1.2))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((position) => ({
    position,
    age: Math.round(Math.expm1(Math.log1p(axisMax) * position)),
  }))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <section className="border-b border-chrome-border/45 px-4 py-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Target className="h-3.5 w-3.5 text-brand-mvcc-explorer" />
              <h3 className="text-[11px] font-semibold uppercase text-foreground/85">Observed cleanup candidates</h3>
              <span className="rounded-sm border border-chrome-border/50 px-1.5 py-0.5 font-mono text-[8px] uppercase text-chrome-text/45">log XID age</span>
            </div>
            <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-chrome-text/60">
              Hover a candidate to preview the visible frontier without it. PostgreSQL does not publish one exact global OldestXmin, so this is a counterfactual over exposed session XIDs/xmins, slot xmins, and prepared XIDs.
            </p>
          </div>
          {preview ? (
            <div className="min-w-[210px] border-l border-warning/35 pl-3 text-right">
              <div className="text-[8px] uppercase text-warning/75">Without {preview.label}</div>
              <div className="mt-0.5 font-mono text-sm text-warning">
                {formatXids(preview.age)} <span className="text-chrome-text/40">→</span> {next ? formatXids(next.age) : "none visible"}
              </div>
              {sameAgePeers ? <div className="mt-0.5 text-[8px] text-warning/60">unchanged: {sameAgePeers} same-age peer{sameAgePeers === 1 ? "" : "s"} remain</div> : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="px-4 py-4">
        <div className="relative ml-[142px] h-5 border-b border-chrome-border/55">
          {ticks.map((tick) => (
            <div key={tick.position} className="absolute bottom-0 top-0" style={{ left: `${tick.position * 100}%` }}>
              <div className="h-full border-l border-chrome-border/30" />
              <span className={cn("absolute top-5 whitespace-nowrap font-mono text-[8px] text-chrome-text/40", tick.position === 1 && "-translate-x-full")}>
                {formatCompact(tick.age)}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-7 space-y-1">
          {visible.length ? visible.map((candidate) => {
            const selected = candidate.id === selectedId
            const previewed = candidate.id === previewId
            const position = logPosition(candidate.age, axisMax)
            return (
              <button
                key={candidate.id}
                type="button"
                onMouseEnter={() => onPreview(candidate.id)}
                onMouseLeave={() => onPreview(null)}
                onFocus={() => onPreview(candidate.id)}
                onBlur={() => onPreview(null)}
                onClick={() => onSelect(candidate.id)}
                className={cn(
                  "group/candidate grid h-10 w-full grid-cols-[134px_minmax(0,1fr)] items-center gap-2 rounded-sm text-left transition",
                  selected ? "bg-brand-mvcc-explorer/10" : "hover:bg-secondary-background/55",
                  previewed && "bg-warning/7",
                )}
              >
                <div className="min-w-0 px-1">
                  <div className="truncate text-[10px] font-medium text-foreground/85">{candidate.label}</div>
                  <div className="truncate font-mono text-[8px] uppercase text-chrome-text/45">{candidate.sublabel}</div>
                </div>
                <div className="relative h-full border-l border-chrome-border/30">
                  <div className="absolute inset-y-1 left-0 right-0 bg-[linear-gradient(to_right,transparent_0,transparent_calc(25%-1px),color-mix(in_oklch,var(--chrome-border)_22%,transparent)_25%,transparent_calc(25%+1px),transparent_calc(50%-1px),color-mix(in_oklch,var(--chrome-border)_22%,transparent)_50%,transparent_calc(50%+1px),transparent_calc(75%-1px),color-mix(in_oklch,var(--chrome-border)_22%,transparent)_75%,transparent_calc(75%+1px))]" />
                  <div
                    className={cn(
                      "absolute top-1/2 h-5 -translate-x-1/2 -translate-y-1/2 border-l",
                      candidate.kind === "session" ? "border-brand-mvcc-explorer" : candidate.kind === "slot" ? "border-warning" : "border-danger",
                      previewed && "opacity-35",
                    )}
                    style={{ left: `${position}%` }}
                  >
                    <span className={cn(
                      "absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border bg-block-bg/90 px-1 py-0.5 font-mono text-[8px]",
                      position > 85 ? "right-1" : "left-1",
                      selected ? "border-brand-mvcc-explorer/55 text-foreground" : "border-chrome-border/45 text-chrome-text/65",
                    )}>
                      {formatCompact(candidate.age)}
                    </span>
                  </div>
                </div>
              </button>
            )
          }) : (
            <div className="grid min-h-32 place-items-center border-y border-chrome-border/30 text-center">
              <div>
                <Shield className="mx-auto h-5 w-5 text-success/70" />
                <div className="mt-2 text-[11px] text-foreground/75">No exposed cleanup candidates</div>
                <div className="mt-1 text-[9px] text-chrome-text/45">No session XID/xmin, replication-slot xmin, or prepared XID is currently visible.</div>
              </div>
            </div>
          )}
          {candidates.length > visible.length ? <div className="pl-1 text-[9px] text-chrome-text/45">+ {candidates.length - visible.length} newer candidates</div> : null}
        </div>
      </section>

      <section className="mt-auto grid border-t border-chrome-border/45 md:grid-cols-2">
        <FreezeGauge
          label="Database transaction ID age"
          value={sample.databaseAge.frozenXidAge}
          max={sample.settings.freezeMaxAge}
          xid={sample.databaseAge.frozenXid}
        />
        <FreezeGauge
          label="Database multixact age"
          value={sample.databaseAge.minMultiXidAge}
          max={sample.settings.multixactFreezeMaxAge}
          xid={sample.databaseAge.minMultiXid}
        />
      </section>

      <EvidenceLedger sample={sample} candidates={candidates} />
    </div>
  )
}

function TablesView({
  tables,
  sort,
  search,
  selectedOid,
  onSort,
  onSearch,
  onSelect,
}: {
  tables: MvccExplorerTable[]
  sort: TableSort
  search: string
  selectedOid: string | null
  onSort: (sort: TableSort) => void
  onSearch: (search: string) => void
  onSelect: (oid: string) => void
}) {
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const hasExactMatch = needle.length > 0 && tables.some(
      (table) => `${table.schema}.${table.name}`.toLowerCase() === needle,
    )
    return [...tables]
      .filter((table) => {
        if (!needle) return true
        const relation = `${table.schema}.${table.name}`.toLowerCase()
        return hasExactMatch ? relation === needle : relation.includes(needle)
      })
      .sort((a, b) => tableScore(b, sort) - tableScore(a, sort))
  }, [search, sort, tables])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-chrome-border/45 px-3 py-2">
        <SegmentedControl
          value={sort}
          options={[
            { value: "vacuum", label: "Vacuum debt" },
            { value: "freeze", label: "Freeze age" },
            { value: "size", label: "Heap size" },
          ]}
          onChange={(value) => onSort(value as TableSort)}
        />
        <label className="relative ml-auto min-w-[190px] max-w-[280px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Filter schema or table"
            className="h-7 w-full rounded-sm border border-chrome-border/55 bg-secondary-background/45 pl-7 pr-2 text-[10px] outline-none placeholder:text-chrome-text/35 focus:border-brand-mvcc-explorer/55"
          />
        </label>
        <span className="font-mono text-[9px] text-chrome-text/45">{visible.length} relations</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 grid min-w-[760px] grid-cols-[minmax(190px,1.5fr)_minmax(150px,1fr)_minmax(130px,0.9fr)_100px_110px] gap-3 border-b border-chrome-border/50 bg-block-bg/95 px-3 py-1.5 text-[8px] uppercase text-chrome-text/45 backdrop-blur-md">
          <span>Relation</span><span>Vacuum trigger</span><span>Freeze age</span><span>Visibility</span><span>Last auto</span>
        </div>
        {visible.map((table) => {
          const pressure = Math.max(table.vacuumPressure, table.insertPressure)
          const freeze = Math.max(table.freezePressure, table.multixactFreezePressure)
          const visibleRatio = table.pages > 0 ? table.allVisiblePages / table.pages : 0
          return (
            <button
              key={table.oid}
              type="button"
              onClick={() => onSelect(table.oid)}
              className={cn(
                "grid min-h-12 w-full min-w-[760px] grid-cols-[minmax(190px,1.5fr)_minmax(150px,1fr)_minmax(130px,0.9fr)_100px_110px] items-center gap-3 border-b border-chrome-border/25 px-3 py-2 text-left transition hover:bg-brand-mvcc-explorer/[0.055]",
                selectedOid === table.oid && "bg-brand-mvcc-explorer/10 ring-1 ring-inset ring-brand-mvcc-explorer/45",
              )}
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] text-foreground/85"><span className="text-chrome-text/45">{table.schema}.</span>{table.name}</div>
                <div className="mt-0.5 flex gap-2 text-[8px] text-chrome-text/45">
                  <span>{formatBytes(table.heapBytesEstimate)} est.</span>
                  <span>{formatCompact(table.liveTuples)} live</span>
                  {!table.autovacuumEnabled ? <span className="text-danger">autovac off</span> : null}
                </div>
              </div>
              <PressureCell value={pressure} label={`${formatCompact(table.deadTuples)} dead / ${formatCompact(table.vacuumTrigger)}`} />
              <PressureCell value={freeze} label={`${formatCompact(table.frozenXidAge)} XIDs`} freeze />
              <div>
                <div className="font-mono text-[10px] text-foreground/75">{formatPercent(visibleRatio)}</div>
                <div className="text-[8px] text-chrome-text/40">all-visible</div>
              </div>
              <div className="text-[9px] text-chrome-text/55">{relativeTime(table.lastAutovacuum ?? table.lastVacuum)}</div>
            </button>
          )
        })}
        {!visible.length ? <div className="grid h-40 place-items-center text-[10px] text-chrome-text/45">No matching relations.</div> : null}
      </div>
    </div>
  )
}

function WorkersView({ sample, selectedPid, onSelect }: {
  sample: MvccExplorerSnapshot
  selectedPid: number | null
  onSelect: (pid: number) => void
}) {
  if (!sample.vacuumWorkers.length) {
    const recent = [...sample.tables]
      .filter((table) => table.lastAutovacuum || table.lastVacuum)
      .sort((a, b) => Date.parse(b.lastAutovacuum ?? b.lastVacuum ?? "") - Date.parse(a.lastAutovacuum ?? a.lastVacuum ?? ""))
      .slice(0, 12)
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <div className="grid min-h-52 place-items-center border-b border-chrome-border/40 px-6 text-center">
          <div>
            <Activity className="mx-auto h-6 w-6 text-brand-mvcc-explorer/70" />
            <h3 className="mt-2 text-xs font-medium">No vacuum workers active</h3>
            <p className="mt-1 max-w-md text-[10px] leading-relaxed text-chrome-text/50">Worker progress appears here while `VACUUM` or autovacuum is running. The table ledger still records recent completion timestamps and cumulative counts.</p>
          </div>
        </div>
        <div className="px-4 py-3">
          <h3 className="text-[9px] uppercase text-chrome-text/50">Recent vacuum activity</h3>
          <div className="mt-2 divide-y divide-chrome-border/25 border-y border-chrome-border/35">
            {recent.map((table) => (
              <div key={table.oid} className="grid grid-cols-[minmax(0,1fr)_100px_90px] gap-3 py-2 text-[9px]">
                <span className="truncate font-mono text-foreground/75">{table.schema}.{table.name}</span>
                <span className="text-chrome-text/50">{table.lastAutovacuum ? "autovacuum" : "manual"}</span>
                <span className="text-right text-chrome-text/50">{relativeTime(table.lastAutovacuum ?? table.lastVacuum)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto p-3">
      <div className="grid gap-2 lg:grid-cols-2">
        {sample.vacuumWorkers.map((worker) => (
          <button
            key={worker.pid}
            type="button"
            onClick={() => onSelect(worker.pid)}
            className={cn(
              "rounded-md border border-chrome-border/45 bg-secondary-background/28 p-3 text-left transition hover:border-brand-mvcc-explorer/40",
              selectedPid === worker.pid && "border-brand-mvcc-explorer/55 bg-brand-mvcc-explorer/8",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-brand-mvcc-explorer/35 bg-brand-mvcc-explorer/8">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-brand-mvcc-explorer" />
              </div>
              <div className="min-w-0">
                <div className="truncate font-mono text-[10px] text-foreground/85">{relationLabel(worker)}</div>
                <div className="mt-0.5 font-mono text-[8px] uppercase text-chrome-text/45">pid {worker.pid} / {worker.database}</div>
              </div>
              <span className="ml-auto rounded-sm border border-chrome-border/45 px-1.5 py-0.5 text-[8px] text-chrome-text/60">{worker.phase}</span>
            </div>
            <WorkerProgress worker={worker} />
          </button>
        ))}
      </div>
    </div>
  )
}

function Inspector({
  sample,
  view,
  candidate,
  table,
  worker,
  onOpenSql,
}: {
  sample: MvccExplorerSnapshot
  view: ExplorerView
  candidate: HorizonCandidate | null
  table: MvccExplorerTable | null
  worker: MvccExplorerVacuumWorker | null
  onOpenSql: SqlOpener
}) {
  if (view === "tables") {
    const target = table ?? [...sample.tables].sort((a, b) => tableScore(b, "vacuum") - tableScore(a, "vacuum"))[0] ?? null
    return target ? <TableInspector table={target} sample={sample} onOpenSql={onOpenSql} /> : <EmptyInspector />
  }
  if (view === "workers") {
    const target = worker ?? sample.vacuumWorkers[0] ?? null
    return target ? <WorkerInspector worker={target} /> : <EmptyInspector title="No active worker" />
  }
  return candidate ? <CandidateInspector candidate={candidate} sample={sample} onOpenSql={onOpenSql} /> : <EmptyInspector title="No exposed horizon candidate" />
}

function CandidateInspector({ candidate, sample, onOpenSql }: {
  candidate: HorizonCandidate
  sample: MvccExplorerSnapshot
  onOpenSql: SqlOpener
}) {
  return (
    <div>
      <InspectorHeader icon={candidate.kind === "session" ? Activity : candidate.kind === "slot" ? Database : Clock} title={candidate.label} subtitle={candidate.sublabel} />
      <InspectorStatement title="Observed">
        PostgreSQL exposes {candidateSourceLabel(candidate)} at age <Mono>{formatXids(candidate.age)}</Mono>.
      </InspectorStatement>
      <InspectorGrid items={[
        ["kind", candidate.kind],
        ["source", candidate.source.replaceAll("_", " ")],
        ["xid", candidate.xid],
        ["XID age", formatNumber(candidate.age)],
        ["share of freeze max", formatPercent(candidate.age / sample.settings.freezeMaxAge)],
      ]} />
      {candidate.session ? <SessionDetails session={candidate.session} /> : null}
      {candidate.slot ? <SlotDetails slot={candidate.slot} /> : null}
      {candidate.prepared ? <PreparedDetails prepared={candidate.prepared} /> : null}

      <InspectorStatement title="Inferred" tone="warning">
        This is a candidate for the visible cleanup frontier. Removing it would move the oldest exposed candidate, but internal horizons and relation-specific rules may still prevent tuple removal.
      </InspectorStatement>
      <InspectorStatement title="Unknown">
        Exact reclaimable tuples and bytes are not derivable from this XID alone.
      </InspectorStatement>

      {candidate.session ? (
        <div className="border-t border-chrome-border/45 p-3">
          <button
            type="button"
            disabled={!sample.permissions.signalBackend}
            onClick={() => openTerminateSql(candidate.session!, onOpenSql)}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-danger/40 bg-danger/7 px-2 text-[9px] text-danger transition hover:bg-danger/12 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <TerminalSquare className="h-3 w-3" /> Review terminate SQL
          </button>
          <p className="mt-2 text-[8px] leading-relaxed text-chrome-text/40">The generated statement rechecks PID and full-precision backend start time before signaling.</p>
        </div>
      ) : null}
    </div>
  )
}

function TableInspector({ table, sample, onOpenSql }: {
  table: MvccExplorerTable
  sample: MvccExplorerSnapshot
  onOpenSql: SqlOpener
}) {
  const vacuumPressure = Math.max(table.vacuumPressure, table.insertPressure)
  const freezePressure = Math.max(table.freezePressure, table.multixactFreezePressure)
  return (
    <div>
      <InspectorHeader icon={Database} title={table.name} subtitle={table.schema} />
      <InspectorStatement title="Observed">
        Statistics estimate <Mono>{formatNumber(table.deadTuples)}</Mono> dead tuples against an effective vacuum trigger of <Mono>{formatNumber(Math.ceil(table.vacuumTrigger))}</Mono>.
      </InspectorStatement>
      <InspectorGrid items={[
        ["vacuum pressure", formatPercent(vacuumPressure)],
        ["freeze pressure", formatPercent(freezePressure)],
        ["heap estimate", formatBytes(table.heapBytesEstimate)],
        ["all-visible pages", table.pages ? formatPercent(table.allVisiblePages / table.pages) : "n/a"],
        ["last autovacuum", relativeTime(table.lastAutovacuum)],
        ["autovacuum", table.autovacuumEnabled ? "enabled" : "disabled"],
      ]} />
      <div className="border-t border-chrome-border/40 p-3">
        <PressureDetail label="Dead tuple threshold" value={table.vacuumPressure} numerator={table.deadTuples} denominator={table.vacuumTrigger} />
        <PressureDetail label="Insert threshold" value={table.insertPressure} numerator={table.insertsSinceVacuum} denominator={table.insertTrigger} />
        <PressureDetail label="Frozen XID age" value={table.freezePressure} numerator={table.frozenXidAge} denominator={table.freezeMaxAge} />
      </div>
      <InspectorStatement title="Inferred" tone={vacuumPressure >= 1 || freezePressure >= 0.75 ? "warning" : "neutral"}>
        {vacuumPressure >= 1
          ? "The statistics threshold is crossed, so this relation is eligible for autovacuum. Scheduling, worker capacity, locks, and cost delay still determine when work begins."
          : "The observed counters are below their effective autovacuum thresholds."}
      </InspectorStatement>
      <InspectorStatement title="Unknown">
        {sample.permissions.pgstattuple || sample.permissions.pageinspect
          ? "Exact physical tuple state requires an explicit forensic scan; this live view intentionally does not run one on every refresh."
          : "Exact bloat and reclaimable bytes require pgstattuple or pageinspect. Dead tuples and heap bytes shown here are estimates."}
      </InspectorStatement>
      <div className="border-t border-chrome-border/45 p-3">
        <button
          type="button"
          onClick={() => openVacuumSql(table, onOpenSql)}
          className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-brand-mvcc-explorer/40 bg-brand-mvcc-explorer/8 px-2 text-[9px] text-brand-mvcc-explorer transition hover:bg-brand-mvcc-explorer/14"
        >
          <TerminalSquare className="h-3 w-3" /> Review VACUUM SQL
        </button>
      </div>
    </div>
  )
}

function WorkerInspector({ worker }: { worker: MvccExplorerVacuumWorker }) {
  const scanned = worker.heapBlocksTotal > 0 ? worker.heapBlocksScanned / worker.heapBlocksTotal : 0
  return (
    <div>
      <InspectorHeader icon={RefreshCw} title={`pid ${worker.pid}`} subtitle={relationLabel(worker)} />
      <InspectorStatement title="Observed">The worker reports phase <Mono>{worker.phase}</Mono> with <Mono>{formatPercent(scanned)}</Mono> of heap blocks scanned.</InspectorStatement>
      <InspectorGrid items={[
        ["database", worker.database],
        ["heap scanned", `${formatNumber(worker.heapBlocksScanned)} / ${formatNumber(worker.heapBlocksTotal)}`],
        ["heap vacuumed", formatNumber(worker.heapBlocksVacuumed)],
        ["index cycles", formatNumber(worker.indexVacuumCount)],
        ["dead item IDs", worker.deadItemIds == null ? "not exposed" : formatNumber(worker.deadItemIds)],
        ["cost delay", worker.delayMs == null ? "not exposed" : `${formatNumber(worker.delayMs)} ms`],
      ]} />
      <InspectorStatement title="Inferred">Progress is phase-dependent: block scan percentage is meaningful during heap scanning, but it is not a reliable whole-job ETA.</InspectorStatement>
    </div>
  )
}

function EvidenceLedger({ sample, candidates }: { sample: MvccExplorerSnapshot; candidates: HorizonCandidate[] }) {
  return (
    <section className="grid border-t border-chrome-border/45 md:grid-cols-3">
      <EvidenceCell icon={Eye} label="Observed" text={`${candidates.length} exposed XID candidates; ${sample.tables.length} table-stat rows; ${sample.vacuumWorkers.length} workers.`} />
      <EvidenceCell icon={Target} label="Inferred" text="Oldest candidate and remove-preview are derived from exposed XIDs, not PostgreSQL's internal global horizon." tone="warning" />
      <EvidenceCell icon={Wrench} label="Unknown" text={sample.permissions.pgstattuple || sample.permissions.pageinspect ? "Exact tuple state is available only through an explicit forensic scan." : "Exact tuple state and reclaimable bytes need pgstattuple or pageinspect."} />
    </section>
  )
}

function EvidenceCell({ icon: Icon, label, text, tone = "neutral" }: {
  icon: ComponentType<{ className?: string }>
  label: string
  text: string
  tone?: "neutral" | "warning"
}) {
  return (
    <div className="border-b border-chrome-border/30 p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className={cn("flex items-center gap-1.5 text-[8px] font-medium uppercase", tone === "warning" ? "text-warning" : "text-chrome-text/55")}>
        <Icon className="h-3 w-3" /> {label}
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-chrome-text/50">{text}</p>
    </div>
  )
}

function FreezeGauge({ label, value, max, xid }: { label: string; value: number; max: number; xid: string }) {
  const ratio = max > 0 ? value / max : 0
  return (
    <div className="border-b border-chrome-border/30 p-3 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[9px] uppercase text-chrome-text/55">{label}</span>
        <span className={cn("font-mono text-[10px]", ratio >= 0.75 ? "text-danger" : ratio >= 0.5 ? "text-warning" : "text-foreground/70")}>{formatPercent(ratio)}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-chrome-border/20">
        <div className={cn("h-full", ratio >= 0.75 ? "bg-danger" : ratio >= 0.5 ? "bg-warning" : "bg-brand-mvcc-explorer")} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[8px] text-chrome-text/40"><span>{formatCompact(value)} age / {xid}</span><span>{formatCompact(max)} max</span></div>
    </div>
  )
}

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "warning" | "danger" }) {
  return (
    <div className="min-w-0 border-r border-chrome-border/45 px-3 py-2 last:border-r-0">
      <div className="truncate text-[8px] uppercase text-chrome-text/45">{label}</div>
      <div className={cn("mt-0.5 truncate font-mono text-sm", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-foreground/85")}>{value}</div>
      <div className="truncate text-[8px] text-chrome-text/40">{detail}</div>
    </div>
  )
}

function PressureCell({ value, label, freeze = false }: { value: number; label: string; freeze?: boolean }) {
  const tone = value >= 1 ? "danger" : value >= 0.7 ? "warning" : "normal"
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 font-mono text-[9px]"><span className={cn(tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-foreground/70")}>{formatPercent(value)}</span><span className="truncate text-[8px] text-chrome-text/40">{label}</span></div>
      <div className="mt-1 h-1 overflow-hidden rounded-sm bg-chrome-border/20"><div className={cn("h-full", tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : freeze ? "bg-brand-mvcc-explorer/70" : "bg-success/70")} style={{ width: `${Math.min(100, value * 100)}%` }} /></div>
    </div>
  )
}

function WorkerProgress({ worker }: { worker: MvccExplorerVacuumWorker }) {
  const scanned = worker.heapBlocksTotal > 0 ? worker.heapBlocksScanned / worker.heapBlocksTotal : 0
  const phases = ["initializing", "scanning heap", "vacuuming indexes", "vacuuming heap", "cleaning up indexes", "truncating heap", "performing final cleanup"]
  const activeIndex = Math.max(0, phases.findIndex((phase) => worker.phase.toLowerCase().includes(phase)))
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between font-mono text-[8px] text-chrome-text/50"><span>{formatNumber(worker.heapBlocksScanned)} scanned</span><span>{formatPercent(scanned)}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-chrome-border/20"><div className="h-full bg-brand-mvcc-explorer" style={{ width: `${Math.min(100, scanned * 100)}%` }} /></div>
      <div className="mt-3 flex gap-1">
        {phases.map((phase, index) => <div key={phase} title={phase} className={cn("h-1 flex-1 rounded-sm", index < activeIndex ? "bg-success/45" : index === activeIndex ? "bg-brand-mvcc-explorer" : "bg-chrome-border/25")} />)}
      </div>
    </div>
  )
}

function PressureDetail({ label, value, numerator, denominator }: { label: string; value: number; numerator: number; denominator: number }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between gap-2 text-[8px]"><span className="uppercase text-chrome-text/50">{label}</span><span className="font-mono text-chrome-text/65">{formatCompact(numerator)} / {formatCompact(denominator)}</span></div>
      <div className="mt-1 h-1 overflow-hidden rounded-sm bg-chrome-border/20"><div className={cn("h-full", value >= 1 ? "bg-danger" : value >= 0.7 ? "bg-warning" : "bg-brand-mvcc-explorer")} style={{ width: `${Math.min(100, value * 100)}%` }} /></div>
    </div>
  )
}

function InspectorHeader({ icon: Icon, title, subtitle }: { icon: ComponentType<{ className?: string }>; title: string; subtitle: string }) {
  return (
    <div className="border-b border-chrome-border/45 p-3">
      <div className="flex items-start gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-brand-mvcc-explorer/35 bg-brand-mvcc-explorer/8"><Icon className="h-4 w-4 text-brand-mvcc-explorer" /></div>
        <div className="min-w-0"><h3 className="truncate font-mono text-xs font-medium">{title}</h3><div className="mt-0.5 truncate text-[9px] text-chrome-text/50">{subtitle}</div></div>
      </div>
    </div>
  )
}

function InspectorStatement({ title, children, tone = "neutral" }: { title: string; children: React.ReactNode; tone?: "neutral" | "warning" }) {
  return (
    <div className="border-b border-chrome-border/35 p-3">
      <div className={cn("text-[8px] font-medium uppercase", tone === "warning" ? "text-warning" : "text-chrome-text/45")}>{title}</div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-chrome-text/60">{children}</p>
    </div>
  )
}

function InspectorGrid({ items }: { items: Array<[string, string]> }) {
  return <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-chrome-border/35 p-3">{items.map(([label, value]) => <div key={label} className="min-w-0"><div className="text-[7px] uppercase text-chrome-text/35">{label}</div><div className="mt-0.5 truncate font-mono text-[9px] text-foreground/70" title={value}>{value}</div></div>)}</div>
}

function SessionDetails({ session }: { session: MvccExplorerSession }) {
  return (
    <>
      <InspectorGrid items={[["user", session.user ?? "unknown"], ["database", session.database ?? "unknown"], ["state", session.state ?? "unknown"], ["transaction", relativeTime(session.transactionStart)], ["application", session.applicationName || "none"], ["wait", session.waitEvent ? `${session.waitEventType}/${session.waitEvent}` : "none"]]} />
      {session.query ? <div className="border-b border-chrome-border/35 p-3"><div className="text-[8px] uppercase text-chrome-text/40">Current or last statement</div><pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded-sm border border-chrome-border/35 bg-block-bg/45 p-2 font-mono text-[8px] leading-relaxed text-chrome-text/60">{session.query}</pre></div> : null}
    </>
  )
}

function SlotDetails({ slot }: { slot: MvccExplorerReplicationSlot }) {
  return <InspectorGrid items={[["slot type", slot.slotType], ["database", slot.database ?? "cluster-wide"], ["state", slot.active ? `active pid ${slot.activePid ?? "?"}` : "inactive"], ["plugin", slot.plugin ?? "physical"], ["xmin", slot.xmin ?? "none"], ["catalog xmin", slot.catalogXmin ?? "none"]]} />
}

function PreparedDetails({ prepared }: { prepared: MvccExplorerPreparedTransaction }) {
  return <InspectorGrid items={[["gid", prepared.gid], ["owner", prepared.owner], ["database", prepared.database], ["prepared", relativeTime(prepared.preparedAt)]]} />
}

function HistoryBar({ history, index, paused, replaying, onReplay, onReturnLive }: {
  history: HistoryEntry[]
  index: number
  paused: boolean
  replaying: boolean
  onReplay: (index: number) => void
  onReturnLive: () => void
}) {
  const selected = history[index]
  return (
    <footer className="shrink-0 border-t border-chrome-border/55 bg-secondary-background/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-brand-mvcc-explorer" />
        <span className="w-[72px] shrink-0 font-mono text-[9px] text-chrome-text/55">{selected ? new Date(selected.at).toLocaleTimeString() : "--:--:--"}</span>
        <input
          aria-label="Snapshot history"
          type="range"
          min={0}
          max={Math.max(0, history.length - 1)}
          value={Math.max(0, index)}
          onChange={(event) => onReplay(Number(event.target.value))}
          className="h-1 min-w-0 flex-1"
          style={{ accentColor: "var(--brand-mvcc-explorer)" }}
        />
        <span className="w-[58px] shrink-0 text-right font-mono text-[8px] text-chrome-text/40">{history.length} samples</span>
        {paused || replaying ? (
          <button type="button" onClick={onReturnLive} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-brand-mvcc-explorer/40 bg-brand-mvcc-explorer/8 px-1.5 text-[8px] text-brand-mvcc-explorer"><RotateCcw className="h-3 w-3" /> Live</button>
        ) : <span className="w-[52px] shrink-0 text-right text-[8px] uppercase text-success/70">recording</span>}
      </div>
    </footer>
  )
}

function SegmentedControl({ value, options, onChange }: {
  value: string
  options: Array<{ value: string; label: string; icon?: ComponentType<{ className?: string }> }>
  onChange: (value: string) => void
}) {
  return (
    <div className="flex h-7 items-center rounded-sm border border-chrome-border/55 bg-secondary-background/45 p-0.5">
      {options.map((option) => {
        const Icon = option.icon
        return <button key={option.value} type="button" onClick={() => onChange(option.value)} className={cn("inline-flex h-5 items-center gap-1 rounded-[2px] px-1.5 text-[9px] text-chrome-text/50 transition", value === option.value && "bg-brand-mvcc-explorer/12 text-foreground shadow-sm")}><>{Icon ? <Icon className="h-3 w-3" /> : null}{option.label}</></button>
      })}
    </div>
  )
}

function IconButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className="grid h-7 w-7 place-items-center rounded-sm border border-chrome-border/60 bg-secondary-background/60 text-chrome-text transition hover:border-brand-mvcc-explorer/45 hover:text-foreground disabled:opacity-40">{children}</button>
}

function WindowSurface({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-block-bg/45 text-foreground backdrop-blur-md group-data-[focused=false]/window:bg-block-bg/25 group-data-[focused=false]/window:backdrop-blur-lg">{children}</div>
}

function CenteredState({ icon: Icon, title, detail, busy = false }: { icon: ComponentType<{ className?: string }>; title: string; detail: string; busy?: boolean }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div><div className="mx-auto grid h-12 w-12 place-items-center rounded-md border border-brand-mvcc-explorer/35 bg-brand-mvcc-explorer/8"><Icon className={cn("h-6 w-6 text-brand-mvcc-explorer", busy && "animate-pulse")} /></div><h2 className="mt-3 text-sm font-medium">{title}</h2><p className="mt-1 max-w-md text-[10px] leading-relaxed text-chrome-text/55">{detail}</p></div>
    </div>
  )
}

function EmptyInspector({ title = "Select an item" }: { title?: string }) {
  return <div className="grid min-h-52 place-items-center p-6 text-center"><div><FileText className="mx-auto h-5 w-5 text-chrome-text/35" /><div className="mt-2 text-[10px] text-chrome-text/50">{title}</div></div></div>
}

function StatusDot({ live }: { live: boolean }) {
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live ? "bg-success" : "bg-warning")} />
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-foreground/75">{children}</span>
}

function deriveCandidates(sample: MvccExplorerSnapshot): HorizonCandidate[] {
  const candidates: HorizonCandidate[] = []
  for (const session of sample.sessions) {
    const xminAge = session.backendXminAge ?? -1
    const xidAge = session.backendXidAge ?? -1
    if (xminAge < 0 && xidAge < 0) continue
    const usesXmin = xminAge >= xidAge
    candidates.push({
      id: `session:${session.pid}:${session.backendStart}`,
      kind: "session",
      label: `pid ${session.pid}`,
      sublabel: `${session.applicationName || session.user || "client"} / ${session.state || "unknown"}`,
      xid: (usesXmin ? session.backendXmin : session.backendXid) ?? "unknown",
      age: usesXmin ? xminAge : xidAge,
      source: usesXmin ? "backend_xmin" : "backend_xid",
      session,
    })
  }
  for (const slot of sample.replicationSlots) {
    const xminAge = Math.max(slot.xminAge ?? -1, slot.catalogXminAge ?? -1)
    if (xminAge < 0) continue
    const usesCatalog = (slot.catalogXminAge ?? -1) >= (slot.xminAge ?? -1)
    candidates.push({ id: `slot:${slot.slotName}`, kind: "slot", label: slot.slotName, sublabel: `${slot.slotType} slot / ${slot.active ? "active" : "inactive"}`, xid: (usesCatalog ? slot.catalogXmin : slot.xmin) ?? "unknown", age: xminAge, source: usesCatalog ? "catalog_xmin" : "slot_xmin", slot })
  }
  for (const prepared of sample.preparedTransactions) {
    candidates.push({ id: `prepared:${prepared.transactionId}:${prepared.gid}`, kind: "prepared", label: prepared.gid, sublabel: `prepared / ${prepared.owner}`, xid: prepared.transactionId, age: prepared.transactionAge, source: "prepared_xid", prepared })
  }
  return candidates.sort((a, b) => b.age - a.age)
}

function candidateSourceLabel(candidate: HorizonCandidate): string {
  switch (candidate.source) {
    case "backend_xid": return "this backend's active top-level XID"
    case "backend_xmin": return "this backend's xmin horizon"
    case "catalog_xmin": return "this replication slot's catalog xmin"
    case "slot_xmin": return "this replication slot's xmin"
    case "prepared_xid": return "this prepared transaction XID"
  }
}

function tableScore(table: MvccExplorerTable, sort: TableSort): number {
  if (sort === "freeze") return Math.max(table.freezePressure, table.multixactFreezePressure)
  if (sort === "size") return table.heapBytesEstimate
  return Math.max(table.vacuumPressure, table.insertPressure)
}

function logPosition(age: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(100, Math.log1p(Math.max(0, age)) / Math.log1p(max) * 100))
}

function capabilityLabel(sample: MvccExplorerSnapshot): string {
  if (sample.permissions.pgstattuple && sample.permissions.pageinspect) return "pgstattuple + pageinspect"
  if (sample.permissions.pgstattuple) return "pgstattuple"
  if (sample.permissions.pageinspect) return "pageinspect"
  return "catalog estimates only"
}

function relationLabel(worker: MvccExplorerVacuumWorker): string {
  return worker.table ? `${worker.schema ? `${worker.schema}.` : ""}${worker.table}` : `relation oid ${worker.relationOid}`
}

function openTerminateSql(session: MvccExplorerSession, onOpenSql: SqlOpener) {
  const started = sqlLiteral(session.backendStart)
  const sql = `-- Review before running. Guarded against PID reuse.\nWITH target AS (\n  SELECT pid\n  FROM pg_stat_activity\n  WHERE pid = ${session.pid}\n    AND backend_start = ${started}::timestamptz\n), action AS (\n  SELECT pg_terminate_backend(pid) AS signaled FROM target\n)\nSELECT CASE\n  WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'not signaled: backend identity changed'\n  WHEN (SELECT signaled FROM action) THEN 'terminate signal sent'\n  ELSE 'not signaled: permission denied or backend exited'\nEND AS outcome;`
  onOpenSql(`Terminate pid ${session.pid}`, sql, false)
}

function openVacuumSql(table: MvccExplorerTable, onOpenSql: SqlOpener) {
  const relation = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
  const sql = `-- Review timing and I/O impact before running.\nVACUUM (VERBOSE, ANALYZE) ${relation};`
  onOpenSql(`Vacuum ${table.schema}.${table.name}`, sql, false)
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function formatXids(value: number): string {
  return `${formatCompact(value)} XIDs`
}

function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}b`
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}m`
  if (abs >= 1_000) return `${trim(value / 1_000)}k`
  return Math.round(value).toLocaleString()
}

function trim(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString()
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "n/a"
  const percent = value * 100
  if (percent > 0 && percent < 0.01) return `${percent.toPrecision(2)}%`
  return `${percent >= 100 ? percent.toFixed(0) : percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 4) return `${trim(value / 1024 ** 4)} TiB`
  if (value >= 1024 ** 3) return `${trim(value / 1024 ** 3)} GiB`
  if (value >= 1024 ** 2) return `${trim(value / 1024 ** 2)} MiB`
  if (value >= 1024) return `${trim(value / 1024)} KiB`
  return `${Math.round(value)} B`
}

function relativeTime(value: string | null): string {
  if (!value) return "never"
  const delta = Date.now() - Date.parse(value)
  if (!Number.isFinite(delta)) return value
  const seconds = Math.max(0, Math.floor(delta / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
