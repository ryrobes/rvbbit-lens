"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

/** 1s-tick clock while `active` — used for live "elapsed" cells. */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  FileCode2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchWarrenInventory,
  fetchWarrenJobs,
  nodeHeartbeatState,
  type NodeHeartbeatState,
  type WarrenInventoryRow,
  type WarrenJob,
  type WarrenJobStatus,
} from "@/lib/rvbbit/warren"
import { fetchInstalledRuntimes, type InstalledRuntime } from "@/lib/rvbbit/capabilities"
import { fmtAgo, fmtCount, fmtMs } from "./instruments"
import type { WarrenPayload } from "@/lib/desktop/types"

interface WarrenWindowProps {
  payload: WarrenPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenJob: (jobId: string, jobName: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenOperator: (name: string) => void
}

type TabKey = "inventory" | "jobs" | "runtimes"
const TABS: { key: TabKey; label: string }[] = [
  { key: "inventory", label: "Inventory" },
  { key: "jobs", label: "Jobs" },
  { key: "runtimes", label: "Python runtimes" },
]

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

/**
 * Warren dashboard — the deployment-fleet hub. Inventory tab renders
 * `rvbbit.warren_inventory` grouped by node with active deployments
 * stacked inside. Jobs tab renders the queue with status filters.
 *
 * Polls both surfaces on the configured interval; pause to freeze.
 */
export function WarrenWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenJob,
  onOpenSpecialist,
}: WarrenWindowProps) {
  const [inventory, setInventory] = useState<WarrenInventoryRow[]>([])
  const [jobs, setJobs] = useState<WarrenJob[]>([])
  const [runtimes, setRuntimes] = useState<InstalledRuntime[]>([])
  const [tab, setTab] = useState<TabKey>(payload.initialTab ?? "inventory")
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const loading = updatedAt === 0

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [inv, jobsRes, rt] = await Promise.all([
      fetchWarrenInventory(activeConnectionId),
      fetchWarrenJobs(activeConnectionId, { limit: 200 }),
      fetchInstalledRuntimes(activeConnectionId),
    ])
    setInventory(inv.rows)
    setJobs(jobsRes.jobs)
    setRuntimes(rt.runtimes)
    setError(inv.error ?? jobsRes.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    if (!activeConnectionId || !hasRvbbit) return () => { cancelled = true }
    if (paused) return () => { cancelled = true }
    const id = setInterval(() => void reload(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, reload])

  // ── derived counts ──
  const nodeCounts = useMemo(() => {
    const seen = new Set<string>()
    let ready = 0
    let stale = 0
    let offline = 0
    let total = 0
    for (const r of inventory) {
      if (seen.has(r.node_id)) continue
      seen.add(r.node_id)
      total += 1
      const hb = nodeHeartbeatState(r.last_heartbeat)
      if (hb === "fresh" && (r.node_status === "ready" || r.node_status === "busy")) ready += 1
      else if (hb === "stale") stale += 1
      else if (hb === "offline") offline += 1
    }
    return { total, ready, stale, offline }
  }, [inventory])

  const jobCounts = useMemo(() => {
    let queued = 0
    let running = 0
    let failed = 0
    for (const j of jobs) {
      if (j.status === "queued") queued += 1
      else if (j.status === "running") running += 1
      else if (j.status === "failed") failed += 1
    }
    return { queued, running, failed }
  }, [jobs])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Rocket className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension —
          warren tables require it.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            paused ? "bg-foreground/[0.05] text-chrome-text" : "bg-success/10 text-success",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              paused ? "bg-chrome-text" : "animate-pulse bg-success",
            )}
          />
          {paused ? "paused" : "live"}
        </span>
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Rocket className="h-3.5 w-3.5 text-brand-warren" />
          {loading ? "loading…" : `${nodeCounts.total} nodes`}
        </span>
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium text-success">{nodeCounts.ready}</span> ready
            </span>
            {nodeCounts.stale > 0 ? (
              <span className="text-warning">{nodeCounts.stale} stale</span>
            ) : null}
            {nodeCounts.offline > 0 ? (
              <span className="text-danger">{nodeCounts.offline} offline</span>
            ) : null}
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(jobs.length)}
              </span>{" "}
              jobs
            </span>
            {jobCounts.queued > 0 ? (
              <span className="text-chrome-text/70">{jobCounts.queued} queued</span>
            ) : null}
            {jobCounts.running > 0 ? (
              <span className="text-rvbbit-accent">{jobCounts.running} running</span>
            ) : null}
            {jobCounts.failed > 0 ? (
              <span className="text-danger">{jobCounts.failed} failed</span>
            ) : null}
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="Refresh interval"
            className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {REFRESH_OPTIONS_MS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume polling" : "Pause polling"}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {/* tab bar */}
      <div className="flex items-center gap-px border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "border-b-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition",
              tab === t.key
                ? "border-brand-warren text-brand-warren"
                : "border-transparent text-chrome-text/65 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "inventory" ? (
          <InventoryTab inventory={inventory} onOpenSpecialist={onOpenSpecialist} />
        ) : null}
        {tab === "jobs" ? <JobsTab jobs={jobs} onOpenJob={onOpenJob} /> : null}
        {tab === "runtimes" ? (
          <RuntimesTab runtimes={runtimes} loading={loading} onOpenSpecialist={onOpenSpecialist} />
        ) : null}
      </div>
    </div>
  )
}

// ── Inventory tab ───────────────────────────────────────────────────

interface GroupedNode {
  node: WarrenInventoryRow
  deployments: WarrenInventoryRow[]
}

function InventoryTab({
  inventory,
  onOpenSpecialist,
}: {
  inventory: WarrenInventoryRow[]
  onOpenSpecialist: (name: string) => void
}) {
  const grouped = useMemo<GroupedNode[]>(() => {
    const byId = new Map<string, GroupedNode>()
    for (const row of inventory) {
      const e = byId.get(row.node_id) ?? { node: row, deployments: [] }
      if (row.deployment_id) e.deployments.push(row)
      byId.set(row.node_id, e)
    }
    return [...byId.values()].sort((a, b) =>
      a.node.node_name.localeCompare(b.node.node_name),
    )
  }, [inventory])

  if (grouped.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
        no warren nodes registered. <br />
        register one with{" "}
        <span className="font-mono">rvbbit.register_warren_node(...)</span>.
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2.5 overflow-auto p-3">
      {grouped.map((g) => (
        <NodeCard key={g.node.node_id} group={g} onOpenSpecialist={onOpenSpecialist} />
      ))}
    </div>
  )
}

const HEARTBEAT_TONE: Record<NodeHeartbeatState, string> = {
  unknown: "bg-foreground/[0.05] text-chrome-text/60 ring-chrome-border/40",
  fresh: "bg-success/15 text-success ring-success/30",
  stale: "bg-warning/15 text-warning ring-warning/30",
  offline: "bg-danger/15 text-danger ring-danger/30",
}

function NodeCard({
  group,
  onOpenSpecialist,
}: {
  group: GroupedNode
  onOpenSpecialist: (name: string) => void
}) {
  const n = group.node
  const hb = nodeHeartbeatState(n.last_heartbeat)
  return (
    <section className="flex flex-col gap-2 rounded-md border border-chrome-border bg-secondary-background/40 p-2.5">
      {/* header */}
      <div className="flex items-center gap-1.5">
        <Cpu className="h-3.5 w-3.5 text-brand-warren" />
        <span className="font-mono text-[12px] font-medium text-foreground">
          {n.node_name}
        </span>
        <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/65">
          {n.node_status}
        </span>
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ring-1",
            HEARTBEAT_TONE[hb],
          )}
          title={n.last_heartbeat ? `last heartbeat ${fmtAgo(n.last_heartbeat)}` : "no heartbeat"}
        >
          {hb}
        </span>
        {n.gpu_count != null && n.gpu_count > 0 ? (
          <span className="rounded bg-warning/10 px-1 text-[9px] uppercase tracking-wider text-warning">
            {n.gpu_count}×gpu
          </span>
        ) : null}
        {n.version ? (
          <span className="ml-auto font-mono text-[9px] text-chrome-text/55">
            {n.version}
          </span>
        ) : null}
      </div>

      {n.base_url ? (
        <div className="truncate font-mono text-[10px] text-chrome-text/50">
          {n.base_url}
        </div>
      ) : null}

      {/* metric bars */}
      <div className="space-y-1">
        <UtilBar
          label="cpu"
          pct={n.cpu_pct}
          sub={n.load1 != null ? `load1 ${n.load1.toFixed(2)}` : null}
        />
        <UtilBar
          label="mem"
          pct={
            n.mem_total_bytes && n.mem_total_bytes > 0 && n.mem_used_bytes != null
              ? (n.mem_used_bytes / n.mem_total_bytes) * 100
              : null
          }
          sub={
            n.mem_used_bytes != null && n.mem_total_bytes != null
              ? `${gb(n.mem_used_bytes)} / ${gb(n.mem_total_bytes)}`
              : null
          }
        />
        {n.gpu_count != null && n.gpu_count > 0 ? (
          <UtilBar
            label="gpu"
            pct={n.gpu_util_pct}
            sub={
              n.gpu_mem_used_bytes != null && n.gpu_mem_total_bytes != null
                ? `${gb(n.gpu_mem_used_bytes)} / ${gb(n.gpu_mem_total_bytes)}`
                : null
            }
            tone="warning"
          />
        ) : null}
      </div>

      {/* labels */}
      {Object.keys(n.labels).length > 0 ? (
        <div className="flex flex-wrap gap-1 border-t border-chrome-border/40 pt-1.5">
          {Object.entries(n.labels).map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-foreground/[0.04] px-1 py-px font-mono text-[9px] text-chrome-text/65"
            >
              {k}: {typeof v === "string" ? v : JSON.stringify(v)}
            </span>
          ))}
        </div>
      ) : null}

      {/* deployments */}
      <div className="border-t border-chrome-border/40 pt-1.5">
        <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/50">
          {group.deployments.length === 0
            ? "no active deployments"
            : `${group.deployments.length} active deployment${group.deployments.length === 1 ? "" : "s"}`}
        </div>
        {group.deployments.length > 0 ? (
          <div className="space-y-1">
            {group.deployments.map((d, i) => (
              <DeploymentRow
                key={d.deployment_id ?? d.deployment_name ?? `slot-${i}`}
                row={d}
                onOpenSpecialist={onOpenSpecialist}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function UtilBar({
  label,
  pct,
  sub,
  tone,
}: {
  label: string
  pct: number | null
  sub?: string | null
  tone?: "warning"
}) {
  const safe = pct == null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2">
      <div className="w-8 shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/50">
        {label}
      </div>
      <div className="relative h-2 flex-1 overflow-hidden rounded-sm bg-foreground/[0.05]">
        {safe != null ? (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-sm",
              tone === "warning" ? "bg-warning/70" : "bg-rvbbit-accent/80",
            )}
            style={{ width: `${Math.max(1.5, safe)}%` }}
          />
        ) : null}
      </div>
      <div className="flex w-[100px] shrink-0 items-baseline justify-end gap-1 text-[10px]">
        <span className="font-mono tabular-nums text-foreground">
          {safe == null ? "—" : `${Math.round(safe)}%`}
        </span>
        {sub ? (
          <span className="font-mono tabular-nums text-chrome-text/50">{sub}</span>
        ) : null}
      </div>
    </div>
  )
}

function gb(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const DEPLOY_STATUS_TONE: Record<string, string> = {
  running: "bg-success/15 text-success ring-success/30",
  starting: "bg-rvbbit-accent/15 text-rvbbit-accent ring-rvbbit-accent/30",
  stopped: "bg-foreground/[0.05] text-chrome-text/65 ring-chrome-border/40",
  failed: "bg-danger/15 text-danger ring-danger/40",
  removed: "bg-foreground/[0.05] text-chrome-text/45 ring-chrome-border/40",
}

function DeploymentRow({
  row,
  onOpenSpecialist,
}: {
  row: WarrenInventoryRow
  onOpenSpecialist: (name: string) => void
}) {
  const status = row.deployment_status ?? "starting"
  const tone = DEPLOY_STATUS_TONE[status] ?? DEPLOY_STATUS_TONE.starting
  return (
    <div className="flex items-center gap-1.5 rounded border border-chrome-border/40 bg-foreground/[0.02] px-1.5 py-1">
      <span
        className={cn(
          "rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ring-1",
          tone,
        )}
      >
        {status}
      </span>
      <span className="font-mono text-[10px] text-foreground">
        {row.deployment_name ?? "(unnamed)"}
      </span>
      {row.kind ? (
        <span className="rounded bg-foreground/[0.05] px-1 text-[9px] text-chrome-text/55">
          {row.kind}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {row.backend_name ? (
          <button
            type="button"
            onClick={() => onOpenSpecialist(row.backend_name!)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-specialists/40 bg-brand-specialists/10 px-1.5 py-px text-[9px] text-brand-specialists hover:bg-brand-specialists/15"
            title={`open backend ${row.backend_name} in Specialist Detail`}
          >
            <Brain className="h-2.5 w-2.5" />
            {row.backend_name}
          </button>
        ) : null}
        {/* Runtime deployments register a runtime_name with no backend —
            that is expected, not a missing backend. */}
        {row.runtime_name ? (
          <button
            type="button"
            onClick={() => onOpenSpecialist(row.runtime_name!)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-1.5 py-px text-[9px] text-brand-capability hover:bg-brand-capability/15"
            title={`open runtime ${row.runtime_name}`}
          >
            <FileCode2 className="h-2.5 w-2.5" />
            {row.runtime_name}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Jobs tab ────────────────────────────────────────────────────────

type JobFilter = "all" | WarrenJobStatus

const JOB_FILTERS: { key: JobFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "queued", label: "queued" },
  { key: "running", label: "running" },
  { key: "completed", label: "completed" },
  { key: "failed", label: "failed" },
  { key: "cancelled", label: "cancelled" },
]

const JOB_STATUS_TONE: Record<WarrenJobStatus, string> = {
  queued: "bg-foreground/[0.05] text-chrome-text/75 ring-chrome-border/40",
  running: "bg-rvbbit-accent/15 text-rvbbit-accent ring-rvbbit-accent/30",
  completed: "bg-success/15 text-success ring-success/30",
  failed: "bg-danger/15 text-danger ring-danger/40",
  cancelled: "bg-foreground/[0.05] text-chrome-text/65 ring-chrome-border/40",
}

function JobsTab({
  jobs,
  onOpenJob,
}: {
  jobs: WarrenJob[]
  onOpenJob: (jobId: string, jobName: string | null) => void
}) {
  const [filter, setFilter] = useState<JobFilter>("all")
  const visible = useMemo(
    () => (filter === "all" ? jobs : jobs.filter((j) => j.status === filter)),
    [jobs, filter],
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1.5">
        {JOB_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition",
              filter === f.key
                ? "bg-brand-warren/15 text-brand-warren"
                : "text-chrome-text hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-chrome-text/55">
          {visible.length} shown
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            no jobs match
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-chrome-bg/80 text-[9px] uppercase tracking-wider text-chrome-text/55 backdrop-blur">
              <tr>
                <th className="px-2 py-1 text-left font-medium">created</th>
                <th className="px-2 py-1 text-left font-medium">job</th>
                <th className="px-2 py-1 text-left font-medium">kind</th>
                <th className="px-2 py-1 text-left font-medium">status</th>
                <th className="px-2 py-1 text-left font-medium">node</th>
                <th className="px-2 py-1 text-left font-medium">elapsed</th>
                <th className="px-2 py-1 text-left font-medium">err / msg</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((j) => (
                <JobRow key={j.job_id} job={j} onOpen={() => onOpenJob(j.job_id, j.name)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function JobRow({ job, onOpen }: { job: WarrenJob; onOpen: () => void }) {
  const isRunning = job.status === "running"
  // Live tick while the job is running so the elapsed column counts up
  // without violating React's purity rule (no Date.now() in render).
  const now = useNowWhile(isRunning)
  const elapsed =
    job.finished_at && job.created_at
      ? job.finished_at - job.created_at
      : job.created_at
        ? now - job.created_at
        : 0
  return (
    <tr
      onClick={onOpen}
      className={cn(
        "cursor-pointer border-t border-chrome-border/30 transition hover:bg-foreground/[0.04]",
        isRunning ? "bg-rvbbit-accent/[0.04]" : "",
      )}
    >
      <td className="whitespace-nowrap px-2 py-1 font-mono tabular-nums text-chrome-text/70">
        {job.created_at ? fmtAgo(job.created_at) : "—"}
      </td>
      <td className="px-2 py-1 font-mono text-foreground">
        {job.name ?? <span className="text-chrome-text/55">(unnamed)</span>}
      </td>
      <td className="px-2 py-1 text-chrome-text/65">{job.kind}</td>
      <td className="px-2 py-1">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ring-1",
            JOB_STATUS_TONE[job.status],
          )}
        >
          {job.status === "completed" ? (
            <CheckCircle2 className="h-2.5 w-2.5" />
          ) : job.status === "failed" ? (
            <X className="h-2.5 w-2.5" />
          ) : job.status === "running" ? (
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
              <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-rvbbit-accent" />
            </span>
          ) : null}
          {job.status}
        </span>
      </td>
      <td className="px-2 py-1 font-mono text-chrome-text/65">
        {job.claimed_by ?? "—"}
      </td>
      <td className="px-2 py-1 font-mono tabular-nums text-chrome-text/65">
        {elapsed > 0 ? fmtMs(elapsed) : "—"}
      </td>
      <td className="max-w-[280px] truncate px-2 py-1 text-[10px]">
        {job.error ? (
          <span className="text-danger">{job.error}</span>
        ) : job.backend_name ? (
          <span className="font-mono text-chrome-text/55">→ {job.backend_name}</span>
        ) : job.runtime_name ? (
          <span className="font-mono text-brand-capability/80">→ {job.runtime_name}</span>
        ) : (
          <span className="text-chrome-text/40">—</span>
        )}
      </td>
    </tr>
  )
}

// ── Python runtimes tab ─────────────────────────────────────────────

function runtimeTone(status: string): string {
  if (status === "ready") return "bg-success/15 text-success ring-success/30"
  if (status === "failed" || status === "disabled") return "bg-danger/15 text-danger ring-danger/40"
  if (status === "starting") return "bg-warning/15 text-warning ring-warning/40"
  return "bg-foreground/[0.05] text-chrome-text/70 ring-chrome-border/40"
}

/**
 * Registered execution runtimes (rvbbit.python_runtimes plus rvbbit.mcp_gateways).
 * A Warren-deployed runtime appears here with runtime_source = 'warren'. These
 * back operator node kinds such as `python` and `mcp` — peers of model
 * backends, not models.
 */
function RuntimesTab({
  runtimes,
  loading,
  onOpenSpecialist,
}: {
  runtimes: InstalledRuntime[]
  loading: boolean
  onOpenSpecialist: (name: string) => void
}) {
  if (!loading && runtimes.length === 0) {
    return (
      <div className="grid h-40 place-items-center px-6 text-center text-[11px] text-chrome-text/55">
        <div>
          <FileCode2 className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
          No execution runtimes registered. Deploy{" "}
          <span className="font-mono">python-runtime</span> or{" "}
          <span className="font-mono">mcp-gateway</span> to add one.
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2 p-2.5">
      <p className="text-[11px] text-chrome-text/55">
        Execution endpoints from runtime catalogs that run operator nodes like{" "}
        <span className="font-mono">kind: python</span> and{" "}
        <span className="font-mono">kind: mcp</span>. Runtime health is separate from backend
        health.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {runtimes.map((rt) => (
          <button
            key={rt.name}
            type="button"
            onClick={() => onOpenSpecialist(rt.name)}
            className="flex flex-col gap-1 rounded border border-chrome-border/50 bg-foreground/[0.02] p-2 text-left transition-colors hover:border-brand-capability/40"
          >
            <div className="flex items-center gap-1.5">
              <FileCode2 className="h-3 w-3 shrink-0 text-brand-capability" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground">
                {rt.name}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ring-1",
                  runtimeTone(rt.status),
                )}
              >
                {rt.status || "unknown"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[9px] text-chrome-text/55">
              <span className="rounded bg-foreground/10 px-1 uppercase tracking-wide">
                {rt.language ?? "python"}
              </span>
              {rt.runtime_source ? <span>via {rt.runtime_source}</span> : null}
              {rt.endpoint_url ? (
                <span className="min-w-0 flex-1 truncate text-right font-mono text-chrome-text/40">
                  {rt.endpoint_url}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
