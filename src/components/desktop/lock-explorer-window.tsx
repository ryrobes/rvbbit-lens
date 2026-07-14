"use client"

import { useCallback, useMemo, useState } from "react"

import {
  Activity,
  AlertTriangle,
  Clock,
  Database,
  Eye,
  FileText,
  GitBranch,
  Lock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  Wrench,
} from "@/lib/icons"
import type {
  LockExplorerEdge,
  LockExplorerLock,
  LockExplorerSession,
  LockExplorerSnapshot,
} from "@/lib/db/lock-explorer"
import {
  ROW_LOCK_MODES,
  TABLE_LOCK_MODES,
  lockModeLabel,
  lockModesConflict,
  type LockModeDefinition,
} from "@/lib/desktop/lock-compatibility"
import { usePolling } from "@/lib/desktop/use-polling"
import { cn } from "@/lib/utils"

type ExplorerView = "causal" | "resources" | "matrix"
type MatrixKind = "table" | "row"
type SqlOpener = (title: string, sql: string, run: boolean) => void

interface LockExplorerWindowProps {
  activeConnectionId: string | null
  workspaceActive?: boolean
  onOpenSql: SqlOpener
}

interface HistoryEntry {
  at: number
  snapshot: LockExplorerSnapshot
}

interface Selection {
  kind: "session" | "edge"
  pid?: number
  backendStart?: string | null
  waiterPid?: number
  blockerPid?: number
}

interface DerivedEdge extends LockExplorerEdge {
  id: string
  waiter: LockExplorerSession | null
  blocker: LockExplorerSession | null
  waiterLock: LockExplorerLock | null
  blockerLock: LockExplorerLock | null
  resourceKey: string
  resourceLabel: string
  blockKind: "hard" | "soft" | "unknown"
  waitMs: number | null
  officialConflict: boolean | null
}

interface ResourceGroup {
  key: string
  label: string
  lockType: string
  locks: LockExplorerLock[]
}

interface MatrixModePair {
  requested: string
  held: string
}

interface MatrixAffectedResource {
  key: string
  label: string
  edges: DerivedEdge[]
}

interface RecentEvent {
  id: string
  at: number
  tone: "danger" | "success" | "neutral"
  label: string
}

const REFRESH_OPTIONS = [
  { value: 1000, label: "1s" },
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
] as const

const HISTORY_LIMIT = 600

export function LockExplorerWindow({
  activeConnectionId,
  workspaceActive = true,
  onOpenSql,
}: LockExplorerWindowProps) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [intervalMs, setIntervalMs] = useState(1000)
  const [paused, setPaused] = useState(false)
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [view, setView] = useState<ExplorerView>("causal")
  const [selection, setSelection] = useState<Selection | null>(null)
  const [previewPid, setPreviewPid] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const poll = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    try {
      const response = await fetch(
        `/api/db/lock-explorer?connectionId=${encodeURIComponent(activeConnectionId)}`,
        { cache: "no-store" },
      )
      const body = await response.json().catch(() => null) as LockExplorerSnapshot | { error?: string } | null
      if (!response.ok || !body || !("sampledAt" in body)) {
        throw new Error(body && "error" in body ? body.error || `HTTP ${response.status}` : `HTTP ${response.status}`)
      }
      const snapshot = body as LockExplorerSnapshot
      setError(null)
      setHistory((previous) => {
        const next = [...previous, { at: Date.now(), snapshot }]
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
  const derivedEdges = useMemo(() => sample ? deriveEdges(sample) : [], [sample])
  const resources = useMemo(() => sample ? groupResources(sample.locks) : [], [sample])
  const recentEvents = useMemo(() => deriveRecentEvents(history), [history])
  const selectedEdge = useMemo(
    () => selection?.kind === "edge"
      ? derivedEdges.find((edge) => edge.waiterPid === selection.waiterPid && edge.blockerPid === selection.blockerPid) ?? null
      : null,
    [derivedEdges, selection],
  )
  const suggestedPid = useMemo(() => suggestSessionPid(sample, derivedEdges), [sample, derivedEdges])
  const selectedSession = useMemo(() => {
    if (!sample) return null
    if (selection?.kind === "edge") return selectedEdge?.waiter ?? selectedEdge?.blocker ?? null
    const pid = selection?.pid ?? suggestedPid
    if (pid == null) return null
    return sample.sessions.find((session) => (
      session.pid === pid
      && (!selection?.backendStart || session.backendStart === selection.backendStart)
    )) ?? null
  }, [sample, selection, selectedEdge, suggestedPid])
  const matrixFocusEdge = useMemo(() => {
    if (selectedEdge?.waiterLock?.lockType === "relation" && selectedEdge.blockerLock?.lockType === "relation") {
      return selectedEdge
    }
    if (selectedSession) {
      return derivedEdges.find((edge) => (
        edge.waiterLock?.lockType === "relation"
        && edge.blockerLock?.lockType === "relation"
        && (edge.waiterPid === selectedSession.pid || edge.blockerPid === selectedSession.pid)
      )) ?? null
    }
    return derivedEdges.find((edge) => edge.waiterLock?.lockType === "relation" && edge.blockerLock?.lockType === "relation") ?? null
  }, [derivedEdges, selectedEdge, selectedSession])

  const waitingCount = sample?.locks.filter((item) => !item.granted).length ?? 0
  function selectSession(pid: number) {
    const session = sample?.sessions.find((item) => item.pid === pid)
    setSelection({ kind: "session", pid, backendStart: session?.backendStart ?? null })
  }

  function selectEdge(edge: DerivedEdge) {
    setSelection({ kind: "edge", waiterPid: edge.waiterPid, blockerPid: edge.blockerPid })
  }

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
    setPreviewPid(null)
  }

  function returnLive() {
    setReplayIndex(null)
    setPaused(false)
  }

  if (!activeConnectionId) {
    return (
      <WindowSurface>
        <CenteredState icon={Database} title="No active connection" detail="Select a Postgres connection to inspect its lock state." />
      </WindowSurface>
    )
  }

  if (!sample) {
    return (
      <WindowSurface>
        <CenteredState
          icon={Lock}
          title={error ? "Lock snapshot failed" : "Reading lock state"}
          detail={error ?? "Waiting for the first metadata sample."}
          busy={!error}
        />
      </WindowSurface>
    )
  }

  return (
    <WindowSurface>
      <header className="shrink-0 border-b border-chrome-border/65 bg-secondary-background/50 px-3 py-2 group-data-[focused=false]/window:bg-secondary-background/30">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-brand-lock-explorer/35 bg-brand-lock-explorer/10">
            <Lock className="h-4 w-4 text-brand-lock-explorer" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="shrink-0 text-sm font-semibold">Lock Explorer</h2>
              <span className="truncate font-mono text-[10px] text-chrome-text/65">
                {sample.connectionLabel} / {sample.database}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[9px] uppercase text-chrome-text/50">
              <StatusDot live={!paused && replayIndex == null} />
              <span>{derivedEdges.length} blocker edge{derivedEdges.length === 1 ? "" : "s"}</span>
              <span>{waitingCount} waiting</span>
              <span>{sample.locks.length} observed</span>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <SegmentedControl
              value={view}
              options={[
                { value: "causal", label: "Causal", icon: GitBranch },
                { value: "resources", label: "Resources", icon: Database },
                { value: "matrix", label: "Matrix", icon: Shield },
              ]}
              onChange={setView}
            />
            <select
              aria-label="Refresh interval"
              value={intervalMs}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
              className="h-7 rounded-sm border border-chrome-border/60 bg-secondary-background/60 px-1.5 font-mono text-[10px] text-chrome-text outline-none focus:border-brand-lock-explorer/60"
            >
              {REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button
              type="button"
              title={paused ? "Resume live sampling" : "Pause sampling"}
              onClick={togglePause}
              className="grid h-7 w-7 place-items-center rounded-sm border border-chrome-border/60 bg-secondary-background/60 text-chrome-text transition hover:border-brand-lock-explorer/45 hover:text-foreground"
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="Refresh now"
              onClick={() => void poll()}
              className="grid h-7 w-7 place-items-center rounded-sm border border-chrome-border/60 bg-secondary-background/60 text-chrome-text transition hover:border-brand-lock-explorer/45 hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/8 px-3 py-1.5 text-[10px] text-danger">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{error}</span>
          <span className="ml-auto text-danger/65">showing last good sample</span>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(255px,31%)]">
        <main className="relative min-h-0 min-w-0 overflow-hidden border-r border-chrome-border/55 bg-background/15">
          {view === "causal" ? (
            <CausalView
              sample={sample}
              edges={derivedEdges}
              selected={selection}
              previewPid={previewPid}
              onSelectSession={selectSession}
              onSelectEdge={selectEdge}
              onPreviewPid={setPreviewPid}
              onViewResources={() => setView("resources")}
            />
          ) : null}
          {view === "resources" ? (
            <ResourcesView
              groups={resources}
              selected={selection}
              onSelectSession={selectSession}
            />
          ) : null}
          {view === "matrix" ? (
            <CompatibilityView
              locks={sample.locks}
              edges={derivedEdges}
              selectedEdge={matrixFocusEdge}
              onSelectEdge={selectEdge}
            />
          ) : null}
        </main>

        <Inspector
          sample={sample}
          edge={selectedEdge}
          session={selectedSession}
          edges={derivedEdges}
          events={recentEvents}
          previewPid={previewPid}
          onPreviewPid={setPreviewPid}
          onOpenSql={onOpenSql}
        />
      </div>

      <HistoryStrip
        history={history}
        currentIndex={currentIndex}
        replayIndex={replayIndex}
        paused={paused}
        onReplayAt={replayAt}
        onReturnLive={returnLive}
      />
    </WindowSurface>
  )
}

function WindowSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-block-bg/45 text-[12px] text-foreground backdrop-blur-md group-data-[focused=false]/window:bg-block-bg/25 group-data-[focused=false]/window:backdrop-blur-lg">
      {children}
    </div>
  )
}

function StatusDot({ live }: { live: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1", live ? "text-success" : "text-warning")}>
      <span className={cn("h-1.5 w-1.5 rounded-full", live ? "animate-pulse bg-success" : "bg-warning")} />
      {live ? "live" : "replay"}
    </span>
  )
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string; icon: React.ComponentType<{ className?: string }> }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex h-7 items-center rounded-sm border border-chrome-border/60 bg-secondary-background/45 p-0.5">
      {options.map((option) => {
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-[2px] px-1.5 text-[10px] transition",
              value === option.value
                ? "bg-foreground/10 text-foreground shadow-sm"
                : "text-chrome-text/65 hover:text-foreground",
            )}
          >
            <Icon className="h-3 w-3" />
            <span className="hidden min-[1100px]:inline">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function CausalView({
  sample,
  edges,
  selected,
  previewPid,
  onSelectSession,
  onSelectEdge,
  onPreviewPid,
  onViewResources,
}: {
  sample: LockExplorerSnapshot
  edges: DerivedEdge[]
  selected: Selection | null
  previewPid: number | null
  onSelectSession: (pid: number) => void
  onSelectEdge: (edge: DerivedEdge) => void
  onPreviewPid: (pid: number | null) => void
  onViewResources: () => void
}) {
  const layout = useMemo(() => buildCausalLayout(sample, edges), [sample, edges])
  const affected = useMemo(() => previewPid == null ? new Set<number>() : downstreamPids(previewPid, edges), [previewPid, edges])
  if (edges.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-md border border-success/30 bg-success/8">
            <GitBranch className="h-6 w-6 text-success" />
          </div>
          <div className="mt-3 text-sm font-semibold">No blocking edges</div>
          <div className="mt-1 font-mono text-[10px] text-chrome-text/60">
            {sample.locks.length} held or requested locks observed at {fmtClock(sample.sampledAt)}
          </div>
          <button
            type="button"
            onClick={onViewResources}
            className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-sm border border-brand-lock-explorer/45 bg-brand-lock-explorer/8 px-2.5 text-[10px] text-brand-lock-explorer hover:bg-brand-lock-explorer/15"
          >
            <Database className="h-3.5 w-3.5" />
            View held locks
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 overflow-auto">
      {previewPid != null ? (
        <div className="absolute top-2 right-2 z-10 rounded-sm border border-warning/35 bg-chrome-bg/85 px-2 py-1 font-mono text-[9px] text-warning shadow-lg backdrop-blur-md">
          preview release pid {previewPid}: {Math.max(0, affected.size - 1)} downstream session{affected.size === 2 ? "" : "s"}
        </div>
      ) : null}
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="h-full min-h-[360px] w-full min-w-[640px]"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id="lock-arrow-hard" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--danger)" opacity="0.75" />
          </marker>
          <marker id="lock-arrow-soft" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--warning)" opacity="0.75" />
          </marker>
        </defs>

        {edges.map((edge, index) => {
          const from = layout.nodes.get(edge.blockerPid)
          const to = layout.nodes.get(edge.waiterPid)
          if (!from || !to) return null
          const selectedEdge = selected?.kind === "edge" && selected.waiterPid === edge.waiterPid && selected.blockerPid === edge.blockerPid
          const selectedSession = selected?.kind === "session" && (selected.pid === edge.waiterPid || selected.pid === edge.blockerPid)
          const dimmed = previewPid != null && (affected.has(edge.waiterPid) || affected.has(edge.blockerPid))
          const x1 = from.x + 88
          const y1 = from.y
          const x2 = to.x - 88
          const y2 = to.y
          const mx = (x1 + x2) / 2
          const my = (y1 + y2) / 2 + ((index % 3) - 1) * 12
          const path = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
          const color = edge.blockKind === "hard" ? "var(--danger)" : "var(--warning)"
          return (
            <g
              key={edge.id}
              className="cursor-pointer"
              opacity={dimmed ? 0.18 : selectedEdge || selectedSession ? 1 : 0.68}
              onClick={() => onSelectEdge(edge)}
            >
              <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
              />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={selectedEdge ? 2.6 : 1.5}
                strokeDasharray={edge.blockKind === "soft" ? "5 4" : "8 5"}
                markerEnd={edge.blockKind === "hard" ? "url(#lock-arrow-hard)" : "url(#lock-arrow-soft)"}
              >
                <animate attributeName="stroke-dashoffset" from="26" to="0" dur="1.4s" repeatCount="indefinite" />
              </path>
              <rect
                x={mx - 73}
                y={my - 15}
                width={146}
                height={30}
                rx={5}
                fill="var(--chrome-bg)"
                fillOpacity={0.92}
                stroke={color}
                strokeOpacity={selectedEdge ? 0.9 : 0.42}
              />
              <text x={mx} y={my - 2} textAnchor="middle" style={{ fill: color, fontSize: 9, fontFamily: "var(--font-mono, monospace)" }}>
                {truncate(edge.resourceLabel, 24)}
              </text>
              <text x={mx} y={my + 10} textAnchor="middle" style={{ fill: "var(--chrome-text)", opacity: 0.72, fontSize: 8, fontFamily: "var(--font-mono, monospace)" }}>
                {shortMode(edge.waiterLock?.mode)} waits / {shortMode(edge.blockerLock?.mode)} {edge.blockKind}
              </text>
            </g>
          )
        })}

        {[...layout.nodes.values()].map((node) => {
          const session = node.pid === 0 ? null : sample.sessions.find((item) => item.pid === node.pid) ?? null
          const isSelected = selected?.kind === "session" && selected.pid === node.pid
          const downstream = downstreamPids(node.pid, edges)
          const isRoot = rootBlockerPids(edges).includes(node.pid)
          const isWaiting = edges.some((edge) => edge.waiterPid === node.pid)
          const color = isRoot ? "var(--danger)" : isWaiting ? "var(--warning)" : "var(--brand-lock-explorer)"
          const previewed = previewPid != null && affected.has(node.pid)
          const app = node.pid === 0 ? "prepared transaction" : sessionLabel(session)
          const detail = node.pid === 0
            ? "pid 0"
            : `${session?.state ?? "unknown"}${session?.waitEventType === "Lock" ? ` / ${session.waitEvent ?? "Lock"}` : ""}`
          return (
            <g
              key={node.pid}
              transform={`translate(${node.x - 88}, ${node.y - 34})`}
              className="cursor-pointer"
              opacity={previewed ? 0.22 : 1}
              onClick={() => onSelectSession(node.pid)}
              onMouseEnter={() => isRoot && onPreviewPid(node.pid)}
              onMouseLeave={() => isRoot && onPreviewPid(null)}
            >
              <rect
                width={176}
                height={68}
                rx={7}
                fill="var(--chrome-bg)"
                fillOpacity={0.9}
                stroke={color}
                strokeWidth={isSelected ? 2.5 : 1.2}
                strokeOpacity={isSelected ? 1 : 0.62}
              />
              <circle cx={12} cy={13} r={3.5} fill={color}>
                {isWaiting ? <animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite" /> : null}
              </circle>
              <text x={21} y={17} style={{ fill: "var(--foreground)", fontSize: 11, fontWeight: 600, fontFamily: "var(--font-mono, monospace)" }}>
                pid {node.pid}
              </text>
              {downstream.size > 1 ? (
                <text x={164} y={17} textAnchor="end" style={{ fill: color, fontSize: 9, fontFamily: "var(--font-mono, monospace)" }}>
                  {downstream.size - 1} down
                </text>
              ) : null}
              <text x={12} y={36} style={{ fill: "var(--foreground)", opacity: 0.88, fontSize: 10 }}>
                {truncate(app, 25)}
              </text>
              <text x={12} y={52} style={{ fill: "var(--chrome-text)", opacity: 0.68, fontSize: 9, fontFamily: "var(--font-mono, monospace)" }}>
                {truncate(detail, 28)}
              </text>
              <text x={164} y={52} textAnchor="end" style={{ fill: "var(--chrome-text)", opacity: 0.58, fontSize: 8, fontFamily: "var(--font-mono, monospace)" }}>
                {session?.transactionStart ? fmtDuration(Date.parse(sample.sampledAt) - Date.parse(session.transactionStart)) : ""}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function ResourcesView({
  groups,
  selected,
  onSelectSession,
}: {
  groups: ResourceGroup[]
  selected: Selection | null
  onSelectSession: (pid: number) => void
}) {
  if (groups.length === 0) {
    return <EmptyInline icon={Database} label="No non-observer locks in this sample" />
  }
  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(170px,1fr)_100px_minmax(220px,1.35fr)] border-b border-chrome-border/60 bg-chrome-bg/88 px-3 py-1.5 text-[9px] uppercase text-chrome-text/55 backdrop-blur-md">
        <span>Resource</span>
        <span>Type</span>
        <span>Holders and requests</span>
      </div>
      {groups.slice(0, 120).map((group) => {
        const waiting = group.locks.some((item) => !item.granted)
        return (
          <div
            key={group.key}
            className={cn(
              "grid min-h-12 grid-cols-[minmax(170px,1fr)_100px_minmax(220px,1.35fr)] items-center border-b border-chrome-border/35 px-3 py-2",
              waiting ? "bg-warning/6" : "hover:bg-foreground/[0.025]",
            )}
          >
            <div className="min-w-0 pr-3">
              <div className="truncate font-mono text-[10px] text-foreground" title={group.label}>{group.label}</div>
              <div className="mt-0.5 text-[9px] text-chrome-text/45">{group.locks.length} lock{group.locks.length === 1 ? "" : "s"}</div>
            </div>
            <div className="font-mono text-[9px] uppercase text-chrome-text/60">{group.lockType}</div>
            <div className="flex min-w-0 flex-wrap gap-1">
              {group.locks.map((item, index) => {
                const selectedPid = selected?.kind === "session" && selected.pid === item.pid
                return (
                  <button
                    key={`${item.pid ?? "prepared"}-${item.mode}-${index}`}
                    type="button"
                    disabled={item.pid == null}
                    title={`${item.granted ? "held" : "waiting"}: ${lockModeLabel(item.mode)}${item.fastPath ? " (fast path)" : ""}`}
                    onClick={() => item.pid != null && onSelectSession(item.pid)}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-[3px] border px-1.5 font-mono text-[9px] transition",
                      item.granted
                        ? "border-success/25 bg-success/7 text-success"
                        : "border-warning/45 bg-warning/12 text-warning",
                      selectedPid && "ring-1 ring-brand-lock-explorer",
                    )}
                  >
                    <span>{item.pid ?? "prepared"}</span>
                    <span className="text-current opacity-65">{shortMode(item.mode)}</span>
                    {item.fastPath ? <span className="opacity-45">fp</span> : null}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CompatibilityView({
  locks,
  edges,
  selectedEdge,
  onSelectEdge,
}: {
  locks: LockExplorerLock[]
  edges: DerivedEdge[]
  selectedEdge: DerivedEdge | null
  onSelectEdge: (edge: DerivedEdge) => void
}) {
  const [kind, setKind] = useState<MatrixKind>("table")
  const [hovered, setHovered] = useState<MatrixModePair | null>(null)
  const [pinned, setPinned] = useState<MatrixModePair | null>(null)
  const modes = kind === "table" ? TABLE_LOCK_MODES : ROW_LOCK_MODES
  const visibleLocks = useMemo(
    () => kind === "table" ? locks.filter((item) => item.lockType === "relation") : [],
    [kind, locks],
  )
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const item of visibleLocks) result.set(item.mode, (result.get(item.mode) ?? 0) + 1)
    return result
  }, [visibleLocks])
  const focusedPair = kind === "table"
    && selectedEdge?.waiterLock?.lockType === "relation"
    && selectedEdge.blockerLock?.lockType === "relation"
    ? { requested: selectedEdge.waiterLock.mode, held: selectedEdge.blockerLock.mode }
    : null
  const selectedPair = pinned ?? focusedPair
  const activePair = hovered ?? selectedPair
  const affectedResources = useMemo(() => {
    if (kind !== "table" || !selectedPair) return []
    const grouped = new Map<string, MatrixAffectedResource>()
    for (const edge of edges) {
      if (
        edge.waiterLock?.lockType !== "relation"
        || edge.blockerLock?.lockType !== "relation"
        || edge.waiterLock.mode !== selectedPair.requested
        || edge.blockerLock.mode !== selectedPair.held
      ) continue
      const current = grouped.get(edge.resourceKey) ?? {
        key: edge.resourceKey,
        label: edge.resourceLabel,
        edges: [],
      }
      current.edges.push(edge)
      grouped.set(edge.resourceKey, current)
    }
    return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [edges, kind, selectedPair])

  function changeKind(next: MatrixKind) {
    setKind(next)
    setHovered(null)
    setPinned(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-7 items-center rounded-sm border border-chrome-border/60 bg-secondary-background/45 p-0.5">
          {(["table", "row"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeKind(option)}
              className={cn(
                "h-6 rounded-[2px] px-2 text-[10px] capitalize",
                kind === option ? "bg-foreground/10 text-foreground" : "text-chrome-text/65",
              )}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="min-w-0 font-mono text-[10px] text-chrome-text/65">
          {activePair
            ? `${lockModeLabel(activePair.requested)} requested vs ${lockModeLabel(activePair.held)} held`
            : `${kind === "table" ? "Relation" : "Row"} lock compatibility`}
        </div>
        {pinned ? (
          <button
            type="button"
            title="Return to the focused blocker edge"
            onClick={() => setPinned(null)}
            className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-brand-lock-explorer/30 bg-brand-lock-explorer/7 text-brand-lock-explorer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="mt-4 min-w-[520px] shrink-0 overflow-x-auto">
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `minmax(140px, 1fr) repeat(${modes.length}, minmax(38px, 54px))` }}
        >
          <div className="flex items-end pb-1 text-[9px] uppercase text-chrome-text/45">requested / held</div>
          {modes.map((mode) => (
            <MatrixHeader
              key={mode.mode}
              mode={mode}
              count={counts.get(mode.mode) ?? 0}
              active={activePair?.held === mode.mode}
              selected={selectedPair?.held === mode.mode}
            />
          ))}
          {modes.map((requested) => (
            <MatrixRow
              key={requested.mode}
              requested={requested}
              modes={modes}
              liveCount={counts.get(requested.mode) ?? 0}
              activePair={activePair}
              selectedPair={selectedPair}
              hovered={hovered}
              onHover={setHovered}
              onSelect={setPinned}
            />
          ))}
        </div>
      </div>

      {kind === "table" ? (
        <MatrixAffectedResources
          pair={selectedPair}
          resources={affectedResources}
          onSelectEdge={onSelectEdge}
        />
      ) : null}

      <div className="mt-3 grid shrink-0 grid-cols-3 gap-3 border-t border-chrome-border/45 pt-3">
        <Metric label="observed modes" value={String(counts.size)} />
        <Metric label={kind === "table" ? "relation locks" : "row locks visible"} value={String(visibleLocks.length)} />
        <Metric label="matrix" value={kind === "table" ? "8 x 8" : "4 x 4"} />
      </div>
      {kind === "row" ? (
        <div className="mt-3 border-l-2 border-info/45 pl-2 text-[10px] leading-relaxed text-chrome-text/65">
          Row locks are an official compatibility model. PostgreSQL usually exposes a blocked row operation as a transaction ID wait, not as the exact tuple holder.
        </div>
      ) : null}
    </div>
  )
}

function MatrixHeader({
  mode,
  count,
  active,
  selected,
}: {
  mode: LockModeDefinition
  count: number
  active: boolean
  selected: boolean
}) {
  return (
    <div
      title={mode.label}
      className={cn(
        "flex h-11 flex-col items-center justify-end rounded-sm border border-chrome-border/35 bg-secondary-background/30 pb-1 transition",
        active && "border-brand-lock-explorer/45 bg-brand-lock-explorer/8",
        selected && "ring-1 ring-brand-lock-explorer",
      )}
    >
      <span className="font-mono text-[9px] text-foreground">{mode.shortLabel}</span>
      <span className={cn("font-mono text-[8px]", count ? "text-brand-lock-explorer" : "text-chrome-text/35")}>{count}</span>
    </div>
  )
}

function MatrixRow({
  requested,
  modes,
  liveCount,
  activePair,
  selectedPair,
  hovered,
  onHover,
  onSelect,
}: {
  requested: LockModeDefinition
  modes: readonly LockModeDefinition[]
  liveCount: number
  activePair: MatrixModePair | null
  selectedPair: MatrixModePair | null
  hovered: MatrixModePair | null
  onHover: (pair: MatrixModePair | null) => void
  onSelect: (pair: MatrixModePair) => void
}) {
  const activeRequested = activePair?.requested === requested.mode
  const selectedRequested = selectedPair?.requested === requested.mode
  return (
    <>
      <div className={cn(
        "flex h-10 min-w-0 items-center justify-between rounded-sm border border-chrome-border/35 bg-secondary-background/30 px-2 transition",
        activeRequested && "border-brand-lock-explorer/45 bg-brand-lock-explorer/8",
        selectedRequested && "ring-1 ring-brand-lock-explorer",
      )}>
        <span className="truncate text-[9px] font-medium text-foreground" title={requested.label}>{requested.label}</span>
        {liveCount ? <span className="font-mono text-[8px] text-brand-lock-explorer">{liveCount}</span> : null}
      </div>
      {modes.map((held) => {
        const conflict = requested.conflicts.includes(held.mode)
        const selected = requested.mode === selectedPair?.requested && held.mode === selectedPair.held
        const hot = hovered?.requested === requested.mode && hovered.held === held.mode
        const crosshair = activePair != null && (
          requested.mode === activePair.requested || held.mode === activePair.held
        )
        return (
          <button
            key={held.mode}
            type="button"
            title={`${requested.label} ${conflict ? "conflicts with" : "is compatible with"} ${held.label}`}
            aria-pressed={selected}
            onClick={() => onSelect({ requested: requested.mode, held: held.mode })}
            onMouseEnter={() => onHover({ requested: requested.mode, held: held.mode })}
            onMouseLeave={() => onHover(null)}
            className={cn(
              "relative grid h-10 place-items-center rounded-sm border font-mono text-[10px] transition",
              conflict
                ? "border-danger/25 bg-danger/8 text-danger"
                : "border-success/15 bg-success/[0.025] text-success/35",
              crosshair && "border-brand-lock-explorer/30 bg-brand-lock-explorer/[0.055]",
              hot && "ring-1 ring-brand-lock-explorer/70 text-foreground",
              selected && "z-10 ring-2 ring-brand-lock-explorer bg-brand-lock-explorer/15 text-foreground",
            )}
          >
            {conflict ? "X" : ""}
          </button>
        )
      })}
    </>
  )
}

function MatrixAffectedResources({
  pair,
  resources,
  onSelectEdge,
}: {
  pair: MatrixModePair | null
  resources: MatrixAffectedResource[]
  onSelectEdge: (edge: DerivedEdge) => void
}) {
  const requested = pair ? TABLE_LOCK_MODES.find((mode) => mode.mode === pair.requested) : null
  const conflict = pair && requested ? requested.conflicts.includes(pair.held) : false

  return (
    <section className="mt-4 flex min-h-[112px] flex-1 flex-col overflow-hidden border-t border-chrome-border/45 pt-3">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <span className="text-[9px] font-medium uppercase text-chrome-text/55">Affected relations</span>
        {pair ? (
          <span className="truncate font-mono text-[9px] text-chrome-text/65">
            {shortMode(pair.requested)} requested / {shortMode(pair.held)} held
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[9px] text-brand-lock-explorer">
          {resources.length} live
        </span>
      </div>

      {resources.length ? (
        <div className="min-h-0 overflow-auto border-y border-chrome-border/30">
          <div className="sticky top-0 z-10 grid min-w-[560px] grid-cols-[minmax(145px,1.2fr)_minmax(115px,1fr)_minmax(115px,1fr)_auto] gap-2 border-b border-chrome-border/35 bg-chrome-bg/95 px-2 py-1 text-[8px] uppercase text-chrome-text/40 backdrop-blur-md">
            <span>blocked relation</span>
            <span>waiting</span>
            <span>blocking</span>
            <span>kind</span>
          </div>
          {resources.map((resource) => {
            const waiters = summarizeEdgeSessions(resource.edges, "waiter")
            const blockers = summarizeEdgeSessions(resource.edges, "blocker")
            const kinds = [...new Set(resource.edges.map((edge) => edge.blockKind))]
            return (
              <button
                key={resource.key}
                type="button"
                title={`Inspect ${resource.label}`}
                onClick={() => onSelectEdge(resource.edges[0])}
                className="grid w-full min-w-[560px] grid-cols-[minmax(145px,1.2fr)_minmax(115px,1fr)_minmax(115px,1fr)_auto] items-center gap-2 border-b border-chrome-border/25 px-2 py-2 text-left transition last:border-b-0 hover:bg-brand-lock-explorer/[0.055]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[10px] text-foreground">{resource.label}</span>
                  <span className="block text-[8px] text-chrome-text/40">{resource.edges.length} wait edge{resource.edges.length === 1 ? "" : "s"}</span>
                </span>
                <span className="truncate font-mono text-[9px] text-warning" title={waiters}>{waiters}</span>
                <span className="truncate font-mono text-[9px] text-danger" title={blockers}>{blockers}</span>
                <span className="flex justify-end gap-1">
                  {kinds.map((value) => (
                    <span
                      key={value}
                      className={cn(
                        "rounded-sm border px-1 py-0.5 font-mono text-[8px] uppercase",
                        value === "hard"
                          ? "border-danger/35 bg-danger/8 text-danger"
                          : value === "soft"
                            ? "border-warning/35 bg-warning/8 text-warning"
                            : "border-chrome-border/40 text-chrome-text/50",
                      )}
                    >
                      {value}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="grid min-h-[72px] flex-1 place-items-center border-y border-chrome-border/25 text-[10px] text-chrome-text/45">
          {!pair
            ? "No active relation-lock intersection."
            : conflict
              ? "No live blocked relations at this intersection."
              : "Compatible pair: no blocking relation edges."}
        </div>
      )}
    </section>
  )
}

function summarizeEdgeSessions(edges: DerivedEdge[], side: "waiter" | "blocker"): string {
  const sessions = new Map<number, LockExplorerSession | null>()
  for (const edge of edges) {
    const pid = side === "waiter" ? edge.waiterPid : edge.blockerPid
    sessions.set(pid, side === "waiter" ? edge.waiter : edge.blocker)
  }
  return [...sessions].map(([pid, session]) => `${sessionLabel(session)} · ${pid}`).join(", ")
}

function Inspector({
  sample,
  edge,
  session,
  edges,
  events,
  previewPid,
  onPreviewPid,
  onOpenSql,
}: {
  sample: LockExplorerSnapshot
  edge: DerivedEdge | null
  session: LockExplorerSession | null
  edges: DerivedEdge[]
  events: RecentEvent[]
  previewPid: number | null
  onPreviewPid: (pid: number | null) => void
  onOpenSql: SqlOpener
}) {
  const focusSession = edge?.waiter ?? session
  const impactPid = edge?.blockerPid ?? session?.pid ?? null
  const actionSession = edge ? edge.blocker : session
  const downstream = impactPid == null ? new Set<number>() : downstreamPids(impactPid, edges)
  const canPreview = impactPid != null && downstream.size > 1
  const isBlocker = impactPid != null && edges.some((item) => item.blockerPid === impactPid)
  const canCancel = actionSession?.state === "active"
  const query = focusSession?.query
  const explanation = edge ? explainEdge(edge, edges) : explainSession(session, edges)

  return (
    <aside className="min-h-0 overflow-auto bg-secondary-background/25 group-data-[focused=false]/window:bg-secondary-background/15">
      <section className="border-b border-chrome-border/45 p-3">
        <div className="flex items-start gap-2">
          <div className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-md border",
            edge || isBlocker ? "border-danger/35 bg-danger/8 text-danger" : "border-brand-lock-explorer/35 bg-brand-lock-explorer/8 text-brand-lock-explorer",
          )}>
            {edge ? <GitBranch className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[11px] font-semibold text-foreground">
              {edge ? `pid ${edge.waiterPid} waits` : focusSession ? `pid ${focusSession.pid}` : "No selected session"}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-chrome-text/60">
              {edge?.resourceLabel ?? sessionLabel(focusSession)}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-chrome-text/80">{explanation}</p>
      </section>

      {focusSession ? (
        <section className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-chrome-border/45 p-3">
          <Metric label="user" value={focusSession.user ?? "unknown"} />
          <Metric label="database" value={focusSession.database ?? "cluster"} />
          <Metric label="application" value={focusSession.applicationName || "unnamed"} />
          <Metric label="state" value={focusSession.state ?? focusSession.backendType ?? "unknown"} />
          <Metric label="query age" value={ageFrom(focusSession.queryStart, sample.sampledAt)} />
          <Metric label="transaction age" value={ageFrom(focusSession.transactionStart, sample.sampledAt)} tone={focusSession.state === "idle in transaction" ? "danger" : undefined} />
          <Metric label="wait" value={focusSession.waitEventType ? `${focusSession.waitEventType}/${focusSession.waitEvent ?? ""}` : "none"} />
          <Metric label="client" value={focusSession.clientAddr ?? "local"} />
        </section>
      ) : null}

      {edge ? (
        <section className="border-b border-chrome-border/45 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="requested" value={lockModeLabel(edge.waiterLock?.mode)} tone="warning" />
            <Metric label={edge.blockKind === "soft" ? "ahead in queue" : "held by blocker"} value={lockModeLabel(edge.blockerLock?.mode)} tone="danger" />
            <Metric label="wait age" value={edge.waitMs == null ? "sampled" : fmtDuration(edge.waitMs)} />
            <Metric label="downstream" value={String(Math.max(0, downstreamPids(edge.blockerPid, edges).size - 1))} />
          </div>
          <div className="mt-3 space-y-1.5 text-[9px] leading-relaxed">
            <Evidence label="observed" value={`pg_blocking_pids(${edge.waiterPid}) includes ${edge.blockerPid}; requested resource and mode are visible.`} tone="success" />
            <Evidence label="inferred" value={edge.officialConflict == null ? "Block relationship is authoritative; this lock class is outside the relation matrix." : `Official relation matrix confirms ${edge.officialConflict ? "a conflict" : "compatibility; queue precedence supplies the soft block"}.`} tone="warning" />
            <Evidence label="unknown" value={edge.waiterLock?.lockType === "transactionid" ? "The exact row and original statement that acquired its lock are not exposed." : "A prior statement in the same transaction may have acquired the held lock."} tone="neutral" />
          </div>
        </section>
      ) : null}

      {query ? (
        <section className="border-b border-chrome-border/45 p-3">
          <div className="mb-1 flex items-center gap-1 text-[9px] uppercase text-chrome-text/50">
            <FileText className="h-3 w-3" /> current or last statement
          </div>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-chrome-border/40 bg-background/35 p-2 font-mono text-[9px] leading-relaxed text-chrome-text/80">
            {query}
          </pre>
        </section>
      ) : null}

      {canPreview ? (
        <section className="border-b border-chrome-border/45 p-3">
          <button
            type="button"
            onClick={() => onPreviewPid(previewPid === impactPid ? null : impactPid)}
            className={cn(
              "flex h-8 w-full items-center justify-center gap-1.5 rounded-sm border text-[10px] transition",
              previewPid === impactPid
                ? "border-warning/55 bg-warning/12 text-warning"
                : "border-chrome-border/55 bg-secondary-background/45 text-chrome-text hover:border-warning/40 hover:text-foreground",
            )}
          >
            <Eye className="h-3.5 w-3.5" />
            {previewPid === impactPid ? "Clear release preview" : `Preview release of pid ${impactPid}`}
          </button>
        </section>
      ) : null}

      {isBlocker && actionSession ? (
        <section className="grid grid-cols-2 gap-2 border-b border-chrome-border/45 p-3">
          <button
            type="button"
            disabled={!sample.permissions.signalBackend || !canCancel}
            title={!sample.permissions.signalBackend
              ? "Current role cannot signal backends"
              : canCancel
                ? "Open reviewed pg_cancel_backend SQL"
                : "This blocker has no active statement to cancel; end its transaction or terminate the session"}
            onClick={() => openSignalSql("cancel", actionSession, onOpenSql)}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-sm border border-warning/35 bg-warning/7 text-[9px] text-warning disabled:cursor-not-allowed disabled:opacity-40"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> Cancel SQL
          </button>
          <button
            type="button"
            disabled={!sample.permissions.signalBackend}
            title={sample.permissions.signalBackend ? "Open reviewed pg_terminate_backend SQL" : "Current role cannot signal backends"}
            onClick={() => openSignalSql("terminate", actionSession, onOpenSql)}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-sm border border-danger/35 bg-danger/7 text-[9px] text-danger disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Wrench className="h-3.5 w-3.5" /> Terminate SQL
          </button>
        </section>
      ) : null}

      <section className="p-3">
        <div className="mb-2 flex items-center gap-1 text-[9px] uppercase text-chrome-text/50">
          <Clock className="h-3 w-3" /> What changed
        </div>
        {events.length ? (
          <div className="space-y-1.5">
            {events.slice(-8).reverse().map((event) => (
              <div key={event.id} className="grid grid-cols-[46px_6px_1fr] items-start gap-1.5 text-[9px]">
                <span className="font-mono text-chrome-text/40">{fmtClock(event.at)}</span>
                <span className={cn("mt-1 h-1.5 w-1.5 rounded-full", event.tone === "danger" ? "bg-danger" : event.tone === "success" ? "bg-success" : "bg-chrome-text/40")} />
                <span className="leading-relaxed text-chrome-text/70">{event.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[9px] text-chrome-text/45">No blocker transitions in retained samples.</div>
        )}
      </section>
    </aside>
  )
}

function HistoryStrip({
  history,
  currentIndex,
  replayIndex,
  paused,
  onReplayAt,
  onReturnLive,
}: {
  history: HistoryEntry[]
  currentIndex: number
  replayIndex: number | null
  paused: boolean
  onReplayAt: (index: number) => void
  onReturnLive: () => void
}) {
  const changes = useMemo(() => transitionIndexes(history), [history])
  const sample = currentIndex >= 0 ? history[currentIndex] : null
  return (
    <footer className="h-[68px] shrink-0 border-t border-chrome-border/65 bg-chrome-bg/45 px-3 py-2 group-data-[focused=false]/window:bg-chrome-bg/25">
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 shrink-0 text-brand-lock-explorer" />
        <span className="font-mono text-[9px] text-chrome-text/55">
          {sample ? fmtClock(sample.at) : "no samples"}
        </span>
        <div className="relative h-4 min-w-0 flex-1">
          {changes.map((index) => (
            <span
              key={index}
              className="pointer-events-none absolute top-0 h-1.5 w-1 rounded-full bg-danger"
              style={{ left: `${history.length <= 1 ? 0 : (index / (history.length - 1)) * 100}%` }}
            />
          ))}
          <input
            aria-label="Lock history"
            type="range"
            min={0}
            max={Math.max(0, history.length - 1)}
            value={Math.max(0, currentIndex)}
            disabled={history.length <= 1}
            onChange={(event) => onReplayAt(Number(event.target.value))}
            className="absolute inset-x-0 bottom-0 h-2 w-full cursor-pointer disabled:cursor-default"
            style={{ accentColor: "var(--brand-lock-explorer)" }}
          />
        </div>
        <span className="w-16 shrink-0 text-right font-mono text-[9px] text-chrome-text/50">
          {history.length} sample{history.length === 1 ? "" : "s"}
        </span>
        {(replayIndex != null || paused) ? (
          <button
            type="button"
            onClick={onReturnLive}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-brand-lock-explorer/40 bg-brand-lock-explorer/8 px-1.5 text-[9px] text-brand-lock-explorer"
          >
            <RotateCcw className="h-3 w-3" /> Live
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[8px] text-chrome-text/35">
        <span>{history[0] ? fmtClock(history[0].at) : ""}</span>
        <span>{replayIndex == null && !paused ? "recording" : "paused"}</span>
        <span>{history.at(-1) ? fmtClock(history.at(-1)!.at) : ""}</span>
      </div>
    </footer>
  )
}

function CenteredState({
  icon: Icon,
  title,
  detail,
  busy = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string
  busy?: boolean
}) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-md border border-brand-lock-explorer/35 bg-brand-lock-explorer/8">
          <Icon className={cn("h-6 w-6 text-brand-lock-explorer", busy && "animate-pulse")} />
        </div>
        <div className="mt-3 text-sm font-semibold">{title}</div>
        <div className="mt-1 max-w-sm text-[11px] text-chrome-text/65">{detail}</div>
      </div>
    </div>
  )
}

function EmptyInline({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-[11px] text-chrome-text/55">
      <div><Icon className="mx-auto mb-2 h-5 w-5" />{label}</div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "danger" | "warning"
}) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] uppercase text-chrome-text/45">{label}</div>
      <div className={cn(
        "mt-0.5 truncate font-mono text-[10px] text-foreground",
        tone === "danger" && "text-danger",
        tone === "warning" && "text-warning",
      )} title={value}>{value}</div>
    </div>
  )
}

function Evidence({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "success" | "warning" | "neutral"
}) {
  return (
    <div className="grid grid-cols-[54px_1fr] gap-2">
      <span className={cn(
        "font-mono uppercase",
        tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-chrome-text/45",
      )}>{label}</span>
      <span className="text-chrome-text/65">{value}</span>
    </div>
  )
}

function deriveEdges(snapshot: LockExplorerSnapshot): DerivedEdge[] {
  const sessions = new Map(snapshot.sessions.map((session) => [session.pid, session]))
  return snapshot.edges.map((edge) => {
    const waiterLock = snapshot.locks.find((lock) => lock.pid === edge.waiterPid && !lock.granted) ?? null
    const resourceKey = waiterLock ? lockResourceKey(waiterLock) : `unknown:${edge.waiterPid}`
    const blockerCandidates = snapshot.locks.filter((lock) => (
      (edge.blockerPid === 0 ? lock.pid == null : lock.pid === edge.blockerPid)
      && lockResourceKey(lock) === resourceKey
    ))
    const blockerLock = blockerCandidates.find((lock) => lock.granted)
      ?? blockerCandidates.find((lock) => !lock.granted)
      ?? null
    const blockKind = blockerLock ? (blockerLock.granted ? "hard" : "soft") : "unknown"
    return {
      ...edge,
      id: `${edge.waiterPid}:${edge.blockerPid}:${resourceKey}`,
      waiter: sessions.get(edge.waiterPid) ?? null,
      blocker: sessions.get(edge.blockerPid) ?? null,
      waiterLock,
      blockerLock,
      resourceKey,
      resourceLabel: waiterLock ? lockResourceLabel(waiterLock) : "unresolved resource",
      blockKind,
      waitMs: waiterLock?.waitStart ? Math.max(0, Date.parse(snapshot.sampledAt) - Date.parse(waiterLock.waitStart)) : null,
      officialConflict: waiterLock?.lockType === "relation" && blockerLock?.lockType === "relation"
        ? lockModesConflict(waiterLock.mode, blockerLock.mode)
        : null,
    }
  })
}

function groupResources(locks: LockExplorerLock[]): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>()
  for (const lock of locks) {
    const key = lockResourceKey(lock)
    const group = groups.get(key) ?? {
      key,
      label: lockResourceLabel(lock),
      lockType: lock.lockType,
      locks: [],
    }
    group.locks.push(lock)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => {
    const aw = a.locks.some((lock) => !lock.granted) ? 1 : 0
    const bw = b.locks.some((lock) => !lock.granted) ? 1 : 0
    return bw - aw || b.locks.length - a.locks.length || a.label.localeCompare(b.label)
  })
}

function lockResourceKey(lock: LockExplorerLock): string {
  return [
    lock.lockType,
    lock.databaseOid,
    lock.relationOid,
    lock.page,
    lock.tuple,
    lock.virtualXid,
    lock.transactionId,
    lock.classId,
    lock.objectId,
    lock.objectSubId,
  ].map((value) => value ?? "").join("|")
}

function lockResourceLabel(lock: LockExplorerLock): string {
  if (lock.lockType === "relation") {
    const relation = lock.relationName
      ? `${lock.schemaName ? `${lock.schemaName}.` : ""}${lock.relationName}`
      : `relation ${lock.relationOid ?? "?"}`
    return lock.databaseName && !lock.relationName ? `${lock.databaseName}:${relation}` : relation
  }
  if (lock.lockType === "transactionid") return `xid ${lock.transactionId ?? "?"}`
  if (lock.lockType === "virtualxid") return `vxid ${lock.virtualXid ?? "?"}`
  if (lock.lockType === "advisory") return `advisory ${lock.classId ?? "?"}/${lock.objectId ?? "?"}/${lock.objectSubId ?? "?"}`
  if (lock.lockType === "tuple") return `${lock.schemaName ?? "relation"}.${lock.relationName ?? lock.relationOid ?? "?"} tuple ${lock.page ?? "?"}/${lock.tuple ?? "?"}`
  if (lock.lockType === "page") return `${lock.schemaName ?? "relation"}.${lock.relationName ?? lock.relationOid ?? "?"} page ${lock.page ?? "?"}`
  if (lock.lockType === "object") return `object ${lock.classId ?? "?"}/${lock.objectId ?? "?"}/${lock.objectSubId ?? "?"}`
  return `${lock.lockType} ${lock.relationOid ?? lock.transactionId ?? lock.virtualXid ?? lock.objectId ?? ""}`.trim()
}

function rootBlockerPids(edges: DerivedEdge[]): number[] {
  const blockers = new Set(edges.map((edge) => edge.blockerPid))
  const waiters = new Set(edges.map((edge) => edge.waiterPid))
  const roots = [...blockers].filter((pid) => !waiters.has(pid))
  return roots.length ? roots : [...blockers]
}

function downstreamPids(pid: number, edges: DerivedEdge[]): Set<number> {
  const byBlocker = new Map<number, number[]>()
  for (const edge of edges) {
    const list = byBlocker.get(edge.blockerPid) ?? []
    list.push(edge.waiterPid)
    byBlocker.set(edge.blockerPid, list)
  }
  const seen = new Set<number>([pid])
  const queue = [pid]
  while (queue.length) {
    const current = queue.shift()!
    for (const next of byBlocker.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

function buildCausalLayout(snapshot: LockExplorerSnapshot, edges: DerivedEdge[]) {
  const pids = new Set<number>()
  for (const edge of edges) {
    pids.add(edge.blockerPid)
    pids.add(edge.waiterPid)
  }
  const roots = rootBlockerPids(edges)
  const depth = new Map<number, number>(roots.map((pid) => [pid, 0]))
  const queue = [...roots]
  while (queue.length) {
    const pid = queue.shift()!
    const nextDepth = (depth.get(pid) ?? 0) + 1
    for (const edge of edges.filter((item) => item.blockerPid === pid)) {
      if (depth.has(edge.waiterPid) && (depth.get(edge.waiterPid) ?? 0) <= nextDepth) continue
      depth.set(edge.waiterPid, nextDepth)
      queue.push(edge.waiterPid)
    }
  }
  for (const pid of pids) if (!depth.has(pid)) depth.set(pid, 0)
  const columns = new Map<number, number[]>()
  for (const [pid, value] of depth) {
    const list = columns.get(value) ?? []
    list.push(pid)
    columns.set(value, list)
  }
  for (const list of columns.values()) {
    list.sort((a, b) => {
      const sa = snapshot.sessions.find((item) => item.pid === a)
      const sb = snapshot.sessions.find((item) => item.pid === b)
      return Date.parse(sa?.transactionStart ?? sa?.queryStart ?? snapshot.sampledAt)
        - Date.parse(sb?.transactionStart ?? sb?.queryStart ?? snapshot.sampledAt)
    })
  }
  const maxDepth = Math.max(0, ...columns.keys())
  const maxRows = Math.max(1, ...[...columns.values()].map((list) => list.length))
  const width = Math.max(700, 240 + maxDepth * 280)
  const height = Math.max(360, 100 + maxRows * 100)
  const nodes = new Map<number, { pid: number; x: number; y: number }>()
  for (const [column, list] of columns) {
    const x = maxDepth === 0 ? width / 2 : 120 + (column / maxDepth) * (width - 240)
    const spacing = height / (list.length + 1)
    list.forEach((pid, index) => nodes.set(pid, { pid, x, y: spacing * (index + 1) }))
  }
  return { nodes, width, height }
}

function suggestSessionPid(snapshot: LockExplorerSnapshot | null, edges: DerivedEdge[]): number | null {
  if (!snapshot) return null
  const roots = rootBlockerPids(edges)
  if (roots.length) {
    return roots.sort((a, b) => downstreamPids(b, edges).size - downstreamPids(a, edges).size)[0] ?? null
  }
  const lockPid = snapshot.locks.find((lock) => lock.pid != null)?.pid
  return lockPid ?? snapshot.sessions.find((session) => session.backendType === "client backend")?.pid ?? null
}

function explainEdge(edge: DerivedEdge, edges: DerivedEdge[]): string {
  const waited = edge.waitMs == null ? "is waiting" : `has waited ${fmtDuration(edge.waitMs)}`
  const relation = edge.resourceLabel
  const blockerPhrase = edge.blockKind === "soft"
    ? `PID ${edge.blockerPid} is ahead with ${lockModeLabel(edge.blockerLock?.mode)}`
    : `PID ${edge.blockerPid} holds ${lockModeLabel(edge.blockerLock?.mode)}`
  const downstream = Math.max(0, downstreamPids(edge.blockerPid, edges).size - 1)
  return `PID ${edge.waiterPid} ${waited} for ${lockModeLabel(edge.waiterLock?.mode)} on ${relation}. ${blockerPhrase}. ${downstream} downstream session${downstream === 1 ? " depends" : "s depend"} on this chain.`
}

function explainSession(session: LockExplorerSession | null, edges: DerivedEdge[]): string {
  if (!session) return "Select a session or blocker edge to inspect its evidence."
  const blockedBy = edges.filter((edge) => edge.waiterPid === session.pid)
  const blocks = Math.max(0, downstreamPids(session.pid, edges).size - 1)
  if (blocks > 0) {
    const idle = session.state === "idle in transaction" ? " It is idle in transaction." : ""
    return `PID ${session.pid} is a root or intermediate blocker with ${blocks} downstream session${blocks === 1 ? "" : "s"}.${idle}`
  }
  if (blockedBy.length) return `PID ${session.pid} is waiting behind ${blockedBy.map((edge) => edge.blockerPid).join(", ")}.`
  return `PID ${session.pid} currently has no observed blocker edge in this sample.`
}

function deriveRecentEvents(history: HistoryEntry[]): RecentEvent[] {
  const events: RecentEvent[] = []
  for (let index = 1; index < history.length; index++) {
    const before = new Set(history[index - 1].snapshot.edges.map(edgeIdentity))
    const after = new Set(history[index].snapshot.edges.map(edgeIdentity))
    for (const edge of after) {
      if (before.has(edge)) continue
      const [waiter, blocker] = edge.split(":")
      events.push({ id: `${history[index].at}:start:${edge}`, at: history[index].at, tone: "danger", label: `pid ${waiter} began waiting behind pid ${blocker}` })
    }
    for (const edge of before) {
      if (after.has(edge)) continue
      const [waiter, blocker] = edge.split(":")
      events.push({ id: `${history[index].at}:stop:${edge}`, at: history[index].at, tone: "success", label: `wait edge ${blocker} -> ${waiter} cleared` })
    }
  }
  return events.slice(-40)
}

function transitionIndexes(history: HistoryEntry[]): number[] {
  const result: number[] = []
  for (let index = 1; index < history.length; index++) {
    const before = history[index - 1].snapshot.edges.map(edgeIdentity).sort().join("|")
    const after = history[index].snapshot.edges.map(edgeIdentity).sort().join("|")
    if (before !== after) result.push(index)
  }
  return result
}

function edgeIdentity(edge: LockExplorerEdge): string {
  return `${edge.waiterPid}:${edge.blockerPid}`
}

function openSignalSql(kind: "cancel" | "terminate", session: LockExplorerSession, onOpenSql: SqlOpener) {
  const fn = kind === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend"
  const action = kind === "cancel" ? "Cancel" : "Terminate"
  const start = sqlLiteral(session.backendStart)
  const activeGuard = kind === "cancel" ? "\n    AND state = 'active'" : ""
  const successNote = kind === "cancel"
    ? "Cancel signal sent; the session remains connected."
    : "Terminate signal sent; the session and its locks should disappear."
  const missingNote = kind === "cancel"
    ? "No matching active session; it may be idle, ended, or have a reused PID."
    : "No matching session identity; it ended or its PID was reused."
  const sql = `-- Revalidates pid + full-precision backend_start so PID reuse cannot target another session.
WITH target AS MATERIALIZED (
  SELECT pid
  FROM pg_stat_activity
  WHERE pid = ${session.pid}
    AND backend_start = ${start}::timestamptz${activeGuard}
), signal AS MATERIALIZED (
  SELECT pid, ${fn}(pid) AS signaled
  FROM target
)
SELECT pid, signaled,
       CASE WHEN signaled THEN ${sqlLiteral(successNote)} ELSE 'Postgres rejected the signal.' END AS outcome
FROM signal
UNION ALL
SELECT NULL::integer, false, ${sqlLiteral(missingNote)}
WHERE NOT EXISTS (SELECT 1 FROM signal);`
  onOpenSql(`${action} blocker pid ${session.pid}`, sql, false)
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sessionLabel(session: LockExplorerSession | null): string {
  if (!session) return "unknown session"
  return session.applicationName || session.user || session.backendType || `pid ${session.pid}`
}

function shortMode(mode: string | null | undefined): string {
  if (!mode) return "?"
  return TABLE_LOCK_MODES.find((item) => item.mode === mode)?.shortLabel
    ?? mode.replace(/Lock$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")
}

function ageFrom(value: string | null, sampledAt: string): string {
  return value ? fmtDuration(Math.max(0, Date.parse(sampledAt) - Date.parse(value))) : "none"
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

function fmtClock(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 3))}...`
}
