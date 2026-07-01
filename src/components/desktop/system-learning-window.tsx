"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import { usePolling } from "@/lib/desktop/use-polling"
import {
  Activity,
  AlertTriangle,
  Brain,
  Check,
  ClipboardCopy,
  Database,
  FlowArrow,
  GitBranch,
  Globe,
  Layers,
  RefreshCw,
  Search,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchSystemLearningArtifacts,
  fetchSystemLearningBrainStatus,
  syncSystemLearningBrain,
  SYSTEM_LEARNING_PROMPTS,
  type SystemLearningArtifact,
  type SystemLearningBrainStatus,
} from "@/lib/rvbbit/brain"
import { fmtAgo, fmtCount, Metric, Panel } from "./instruments"

interface SystemLearningWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenRouting: () => void
  onOpenBrain: () => void
  onOpenMcpServers: () => void
  onOpenOperator: (operatorName: string | null) => void
  onOpenSql: (sql: string, title: string) => void
}

interface ArtifactBuckets {
  acceleration: SystemLearningArtifact[]
  layouts: SystemLearningArtifact[]
  routes: SystemLearningArtifact[]
  operators: SystemLearningArtifact[]
  recent: SystemLearningArtifact[]
}

const EMPTY_BUCKETS: ArtifactBuckets = {
  acceleration: [],
  layouts: [],
  routes: [],
  operators: [],
  recent: [],
}

const REFRESH_MS = 10_000

export function SystemLearningWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenRouting,
  onOpenBrain,
  onOpenMcpServers,
  onOpenOperator,
  onOpenSql,
}: SystemLearningWindowProps) {
  const [status, setStatus] = useState<SystemLearningBrainStatus | null>(null)
  const [buckets, setBuckets] = useState<ArtifactBuckets>(EMPTY_BUCKETS)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const reloadInFlightRef = useRef<Promise<void> | null>(null)
  const workspaceActive = useWorkspaceActive()
  const loading = updatedAt === 0

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    if (reloadInFlightRef.current) return reloadInFlightRef.current
    setBusy(true)
    const run = (async () => {
      const nextStatus = await fetchSystemLearningBrainStatus(activeConnectionId)
      setStatus(nextStatus)
      if (!nextStatus.installed) {
        setBuckets(EMPTY_BUCKETS)
        setError(nextStatus.error ?? null)
        setUpdatedAt(Date.now())
        return
      }
      const artifacts = await fetchSystemLearningArtifacts(activeConnectionId, { limit: 80 })
      const recent = artifacts.rows.slice(0, 12)
      const acceleration = artifacts.rows
        .filter((row) => row.objectType === "heap_acceleration_candidate" || row.objectType === "acceleration_state")
        .slice(0, 12)
      const layouts = artifacts.rows.filter((row) => row.objectType === "workload_layout").slice(0, 10)
      const routes = artifacts.rows.filter((row) => row.objectType === "route_shape").slice(0, 10)
      const operators = artifacts.rows.filter((row) => row.objectType === "operator").slice(0, 10)
      setBuckets({
        acceleration,
        layouts,
        routes,
        operators,
        recent,
      })
      setError(nextStatus.error ?? artifacts.error ?? null)
      setUpdatedAt(Date.now())
    })()
    reloadInFlightRef.current = run
    try {
      await run
    } finally {
      reloadInFlightRef.current = null
      setBusy(false)
    }
  }, [activeConnectionId])

  const syncBrain = useCallback(async () => {
    if (!activeConnectionId) return
    setSyncing(true)
    try {
      const res = await syncSystemLearningBrain(activeConnectionId)
      if (!res.ok) {
        setError(res.error ?? "system learning sync failed")
        return
      }
      await reload()
    } finally {
      setSyncing(false)
    }
  }, [activeConnectionId, reload])

  usePolling(reload, REFRESH_MS, {
    enabled: !!activeConnectionId && hasRvbbit && workspaceActive && !syncing,
    resetKey: activeConnectionId,
  })

  const readiness = useMemo(() => readinessState(status), [status])
  const syncGap = Math.max(0, (status?.indexedItems ?? 0) - (status?.docs ?? 0))
  const totalArtifacts = status?.indexedItems ?? 0

  if (!activeConnectionId) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Brain className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          Select a connection.
        </div>
      </div>
    )
  }

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Brain className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            readiness.tone === "ready"
              ? "bg-success/10 text-success"
              : readiness.tone === "warning"
                ? "bg-warning/10 text-warning"
                : "bg-danger/10 text-danger",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              readiness.tone === "ready"
                ? "animate-pulse bg-success"
                : readiness.tone === "warning"
                  ? "bg-warning"
                  : "bg-danger",
            )}
          />
          {readiness.label}
        </span>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
          System Learning
        </span>
        {!loading ? (
          <>
            <span className="text-chrome-text/40">/</span>
            <span className="tabular-nums">
              {fmtCount(totalArtifacts)} artifacts / {fmtCount(status?.docs ?? 0)} brain docs
            </span>
          </>
        ) : null}
        {updatedAt > 0 ? (
          <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void reload()}
            disabled={busy || syncing}
            title="Refresh"
            className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground hover:border-rvbbit-accent/50 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", busy ? "animate-spin" : "")} />
            refresh
          </button>
          <button
            type="button"
            onClick={() => void syncBrain()}
            disabled={syncing || !status?.sourceId}
            title="Sync System Learning into Document Brain"
            className="inline-flex h-6 items-center gap-1 rounded border border-rvbbit-accent/40 bg-rvbbit-accent/10 px-2 text-[11px] text-rvbbit-accent hover:border-rvbbit-accent disabled:opacity-50"
          >
            <Database className={cn("h-3 w-3", syncing ? "animate-pulse" : "")} />
            sync brain
          </button>
          <button
            type="button"
            onClick={onOpenRouting}
            title="Open Adaptive Routing"
            className="inline-flex h-6 items-center rounded border border-chrome-border bg-secondary-background px-2 text-chrome-text hover:text-foreground"
          >
            <GitBranch className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenBrain}
            title="Open Document Brain"
            className="inline-flex h-6 items-center rounded border border-chrome-border bg-secondary-background px-2 text-chrome-text hover:text-foreground"
          >
            <Brain className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenMcpServers}
            title="Open MCP Servers"
            className="inline-flex h-6 items-center rounded border border-chrome-border bg-secondary-background px-2 text-chrome-text hover:text-foreground"
          >
            <Globe className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-[11px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        ) : null}

        <div className="grid gap-3 xl:grid-cols-[1fr_1.2fr]">
          <Panel icon={Activity} title="Readiness">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Metric label="artifacts" value={fmtCount(status?.indexedItems ?? 0)} />
              <Metric label="brain docs" value={fmtCount(status?.docs ?? 0)} tone={syncGap > 0 ? "warning" : undefined} />
              <Metric label="groups" value={fmtCount(status?.groups.length ?? 0)} />
              <Metric label="sync gap" value={fmtCount(syncGap)} tone={syncGap > 0 ? "warning" : "muted"} />
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <ReadinessStep done={!!status?.installed} icon={Layers} label="registry" value={status?.installed ? "present" : "missing"} />
              <ReadinessStep done={!!status?.enabled} icon={Database} label="source" value={status?.enabled ? `#${status.sourceId}` : "paused"} />
              <ReadinessStep done={(status?.docs ?? 0) > 0} icon={Brain} label="brain" value={`${fmtCount(status?.docs ?? 0)} docs`} />
              <ReadinessStep done={syncGap === 0 && (status?.docs ?? 0) > 0} icon={Globe} label="agent" value={readiness.detail} />
            </div>
          </Panel>

          <Panel icon={Search} title="Prompt Handles">
            <div className="grid gap-2 md:grid-cols-2">
              {SYSTEM_LEARNING_PROMPTS.map((prompt) => (
                <PromptCard key={prompt.label} prompt={prompt} />
              ))}
            </div>
          </Panel>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <ArtifactSection
            icon={Zap}
            title="Acceleration"
            rows={buckets.acceleration}
            empty={status?.installed ? "no acceleration artifacts" : "system learning missing"}
            onOpenSql={onOpenSql}
            onOpenOperator={onOpenOperator}
          />
          <ArtifactSection
            icon={Layers}
            title="Workload Layouts"
            rows={buckets.layouts}
            empty={status?.installed ? "no workload layout artifacts" : "system learning missing"}
            onOpenSql={onOpenSql}
            onOpenOperator={onOpenOperator}
          />
          <ArtifactSection
            icon={GitBranch}
            title="Route Shapes"
            rows={buckets.routes}
            empty={status?.installed ? "no route shape artifacts" : "system learning missing"}
            onOpenSql={onOpenSql}
            onOpenOperator={onOpenOperator}
          />
          <ArtifactSection
            icon={FlowArrow}
            title="Operators"
            rows={buckets.operators}
            empty={status?.installed ? "no operator artifacts" : "system learning missing"}
            onOpenSql={onOpenSql}
            onOpenOperator={onOpenOperator}
          />
        </div>

        <div className="mt-3">
          <ArtifactSection
            icon={Activity}
            title="Recent Artifacts"
            rows={buckets.recent}
            empty={status?.installed ? "no recent artifacts" : "system learning missing"}
            onOpenSql={onOpenSql}
            onOpenOperator={onOpenOperator}
            dense
          />
        </div>
      </div>
    </div>
  )
}

function readinessState(status: SystemLearningBrainStatus | null): {
  label: string
  detail: string
  tone: "ready" | "warning" | "danger"
} {
  if (!status) return { label: "loading", detail: "checking", tone: "warning" }
  if (!status.installed) return { label: "missing", detail: "migrate", tone: "danger" }
  if (!status.enabled) return { label: "paused", detail: "source off", tone: "warning" }
  if (status.docs === 0 && status.indexedItems > 0) return { label: "needs sync", detail: "sync brain", tone: "warning" }
  if (status.docs < status.indexedItems) return { label: "partial", detail: "sync lag", tone: "warning" }
  return { label: "ready", detail: "grounded", tone: "ready" }
}

function ReadinessStep({
  done,
  icon: Icon,
  label,
  value,
}: {
  done: boolean
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded border border-chrome-border/50 bg-chrome-bg/35 px-2 py-2">
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded border",
          done
            ? "border-success/30 bg-success/10 text-success"
            : "border-warning/30 bg-warning/10 text-warning",
        )}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[10px] uppercase tracking-wider text-chrome-text/45">{label}</span>
        <span className="block truncate font-mono text-[11px] text-foreground">{value}</span>
      </span>
    </div>
  )
}

function PromptCard({ prompt }: { prompt: (typeof SYSTEM_LEARNING_PROMPTS)[number] }) {
  return (
    <div className="min-w-0 rounded-md border border-chrome-border/50 bg-chrome-bg/35 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">{prompt.label}</div>
          <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-chrome-text/75">{prompt.query}</div>
          <div className="mt-1 line-clamp-1 text-[10px] text-chrome-text/45">{prompt.useWhen}</div>
        </div>
        <IconButton title="Copy prompt" onClick={() => void copyText(prompt.query)}>
          <ClipboardCopy className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  )
}

function ArtifactSection({
  icon,
  title,
  rows,
  empty,
  onOpenSql,
  onOpenOperator,
  dense = false,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  rows: SystemLearningArtifact[]
  empty: string
  onOpenSql: (sql: string, title: string) => void
  onOpenOperator: (operatorName: string | null) => void
  dense?: boolean
}) {
  return (
    <Panel icon={icon} title={title} right={<span>{fmtCount(rows.length)}</span>}>
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-chrome-border/50 bg-chrome-bg/25 px-3 py-4 text-center text-[11px] text-chrome-text/45">
          {empty}
        </div>
      ) : (
        <div className={cn("grid gap-2", dense ? "xl:grid-cols-2" : "")}>
          {rows.map((row) => (
            <ArtifactCard
              key={row.uri}
              row={row}
              dense={dense}
              onOpenSql={onOpenSql}
              onOpenOperator={onOpenOperator}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

function ArtifactCard({
  row,
  dense,
  onOpenSql,
  onOpenOperator,
}: {
  row: SystemLearningArtifact
  dense?: boolean
  onOpenSql: (sql: string, title: string) => void
  onOpenOperator: (operatorName: string | null) => void
}) {
  const meta = artifactMeta(row)
  return (
    <article className="min-w-0 rounded-md border border-chrome-border/50 bg-chrome-bg/35 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded border border-rvbbit-accent/25 bg-rvbbit-accent/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-rvbbit-accent">
              {typeLabel(row.objectType)}
            </span>
            {row.status ? (
              <span className={cn("rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider", statusClass(row.status))}>
                {row.status}
              </span>
            ) : null}
            {row.occurredAt ? <span className="text-[10px] text-chrome-text/45">{fmtAgo(row.occurredAt)}</span> : null}
          </div>
          <h3 className="mt-1 truncate text-[12px] font-medium text-foreground">{row.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {row.objectType === "operator" ? (
            <IconButton title="Open operator" onClick={() => onOpenOperator(row.operatorName)}>
              <FlowArrow className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          <IconButton title="Open SQL handle" onClick={() => onOpenSql(row.inspectSql, row.title)}>
            <Search className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Copy SQL handle" onClick={() => void copyText(row.inspectSql)}>
            <ClipboardCopy className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {meta.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {meta.map((m) => (
            <span key={m} className="max-w-full truncate rounded bg-secondary-background px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/70">
              {m}
            </span>
          ))}
        </div>
      ) : null}

      <div className={cn("mt-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-chrome-text/70", dense ? "line-clamp-3" : "line-clamp-5")}>
        {row.body}
      </div>

      <div className="mt-2 rounded border border-chrome-border/35 bg-doc-bg/55 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-chrome-text/75">
        <div className="line-clamp-2 break-words">{row.inspectSql}</div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void copyText(row.askQuery)}
          className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 text-[10px] text-chrome-text hover:text-foreground"
        >
          <Brain className="h-3 w-3" />
          copy prompt
        </button>
        <span className="min-w-0 truncate font-mono text-[10px] text-chrome-text/45">{row.uri}</span>
      </div>
    </article>
  )
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-grid h-6 w-6 place-items-center rounded border border-chrome-border bg-secondary-background text-chrome-text hover:border-rvbbit-accent/45 hover:text-foreground"
    >
      {children}
    </button>
  )
}

function artifactMeta(row: SystemLearningArtifact): string[] {
  const out: string[] = []
  if (row.tableName) out.push(`table=${row.tableName}`)
  if (row.columnName) out.push(`column=${row.columnName}`)
  if (row.layout) out.push(`layout=${row.layout}`)
  if (row.layoutKind) out.push(`kind=${row.layoutKind}`)
  if (row.layoutStatus) out.push(`build=${row.layoutStatus}`)
  if (row.engine) out.push(`engine=${row.engine}`)
  if (row.operatorName) out.push(`operator=${row.operatorName}`)
  if (row.shapeFamily) out.push(`family=${row.shapeFamily}`)
  if (row.score != null && Number.isFinite(row.score)) out.push(`score=${row.score.toFixed(2)}`)
  if (row.observations != null && Number.isFinite(row.observations)) out.push(`obs=${fmtCount(row.observations)}`)
  if (row.seqScans != null && Number.isFinite(row.seqScans)) out.push(`seq=${fmtCount(row.seqScans)}`)
  if (row.seqRows != null && Number.isFinite(row.seqRows)) out.push(`rows=${fmtCount(row.seqRows)}`)
  if (row.writes != null && Number.isFinite(row.writes)) out.push(`writes=${fmtCount(row.writes)}`)
  if (row.sizeBytes != null && Number.isFinite(row.sizeBytes)) out.push(`size=${formatBytes(row.sizeBytes)}`)
  return out
}

function typeLabel(kind: string): string {
  if (kind === "heap_acceleration_candidate") return "heap candidate"
  if (kind === "acceleration_state") return "accel state"
  if (kind === "workload_layout") return "layout"
  if (kind === "route_shape") return "route shape"
  if (kind === "operator") return "operator"
  return kind.replace(/_/g, " ")
}

function statusClass(status: string): string {
  const s = status.toLowerCase()
  if (s === "ready" || s === "fresh" || s === "accepted" || s === "built") return "bg-success/10 text-success"
  if (s === "dirty" || s === "not_built" || s === "not_accelerated" || s === "proposed") return "bg-warning/10 text-warning"
  if (s === "rejected" || s === "error") return "bg-danger/10 text-danger"
  return "bg-foreground/[0.06] text-chrome-text"
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // Best effort only; copy actions should not affect the window.
  }
}
