"use client"

import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import { Activity, AlertTriangle, Check, ChevronRight, ClipboardCopy, Database, Plus, RefreshCw, Trash2, TrendingUp, X, Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { SqlEditor } from "./sql-editor"
import {
  buildUpsertSyncSql,
  deleteSyncJob,
  emptySpec,
  fetchSyncOverview,
  listSyncJobs,
  listSyncRuns,
  runSyncJob,
  upsertSyncJob,
  type SyncJob,
  type SyncOverview as SyncOverviewData,
  type SyncRun,
  type SyncSpec,
} from "@/lib/rvbbit/sync"

function ago(ms: number | null): string {
  if (ms == null) return "never"
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function runTime(ms: number | null): string {
  if (ms == null) return "—"
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

interface RunGroup {
  runId: string
  startedAt: number | null
  rows: SyncRun[]
  errors: number
  tables: number   // table syncs only (excludes 'error' + 'import' rows)
}

/** Group the per-table rows (already DESC by started_at) into their runs. A run
 *  is one run_id; the singleton lock means runs never temporally interleave. */
function groupByRun(runs: SyncRun[]): RunGroup[] {
  const out: RunGroup[] = []
  for (const r of runs) {
    const key = r.runId ?? "?"
    const last = out[out.length - 1]
    if (last && last.runId === key) last.rows.push(r)
    else out.push({ runId: key, startedAt: r.startedAt, rows: [r], errors: 0, tables: 0 })
  }
  for (const g of out) {
    const times = g.rows.map((x) => x.startedAt).filter((t): t is number => t != null)
    g.startedAt = times.length ? Math.min(...times) : g.startedAt
    g.errors = g.rows.filter((x) => x.action === "error").length
    g.tables = g.rows.filter((x) => x.action !== "error" && x.action !== "import").length
  }
  return out
}

export function SyncMirrorWindow({ activeConnectionId }: { activeConnectionId: string | null }) {
  const [jobs, setJobs] = useState<SyncJob[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ name: string; isNew: boolean; spec: SyncSpec } | null>(null)
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [running, setRunning] = useState(false)
  const workspaceActive = useWorkspaceActive()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await listSyncJobs(activeConnectionId)
    setJobs(r.jobs)
    setError(r.error)
  }, [activeConnectionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const refreshRuns = useCallback(async () => {
    if (!activeConnectionId || !selected) {
      setRuns([])
      return
    }
    const r = await listSyncRuns(activeConnectionId, selected)
    setRuns(r.runs)
  }, [activeConnectionId, selected])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

  // Poll while a run is in flight — sync_runs commits per table, so progress
  // shows up live even while the CALL is still pending.
  useEffect(() => {
    if (!running || !workspaceActive) return
    const h = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(h)
  }, [running, refreshRuns, workspaceActive])

  const selectedJob = useMemo(() => jobs.find((j) => j.jobName === selected) ?? null, [jobs, selected])

  const onRun = useCallback(async () => {
    if (!activeConnectionId || !selected || running) return
    setRunning(true)
    setError(null)
    const r = await runSyncJob(activeConnectionId, selected)
    if (!r.ok) setError(r.error)
    setRunning(false)
    await refreshRuns()
    await reload()
  }, [activeConnectionId, selected, running, refreshRuns, reload])

  const onSave = useCallback(
    async (name: string, spec: SyncSpec) => {
      if (!activeConnectionId || !name.trim()) return
      setBusy(true)
      const r = await upsertSyncJob(activeConnectionId, name.trim(), spec)
      if (!r.ok) setError(r.error)
      setBusy(false)
      setEditing(null)
      await reload()
      setSelected(name.trim())
    },
    [activeConnectionId, reload],
  )

  const onDelete = useCallback(
    async (name: string) => {
      if (!activeConnectionId) return
      await deleteSyncJob(activeConnectionId, name)
      if (selected === name) setSelected(null)
      await reload()
    },
    [activeConnectionId, selected, reload],
  )

  return (
    <div className="flex h-full text-chrome-text">
      {/* Left rail: jobs */}
      <div className="flex w-52 shrink-0 flex-col border-r border-chrome-border">
        <div className="flex items-center gap-1.5 border-b border-chrome-border px-2.5 py-1.5">
          <Database className="h-3.5 w-3.5 text-rvbbit-accent" />
          <span className="text-[11px] font-medium text-foreground">Temporal Mirror</span>
          <button
            type="button"
            onClick={() => setEditing({ name: "", isNew: true, spec: emptySpec() })}
            title="New sync job"
            className="ml-auto inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          <button
            type="button"
            onClick={() => {
              setSelected(null)
              setEditing(null)
            }}
            className={cn(
              "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]",
              selected === null && !editing ? "bg-rvbbit-accent/10 text-foreground" : "text-chrome-text hover:bg-foreground/[0.05]",
            )}
          >
            <Activity className="h-3 w-3 shrink-0 text-rvbbit-accent" />
            <span className="flex-1 truncate">Overview</span>
          </button>
          <div className="my-1 border-t border-chrome-border/50" />
          {jobs.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-chrome-text/50">No sync jobs yet.</div>
          ) : (
            jobs.map((j) => (
              <button
                key={j.jobName}
                type="button"
                onClick={() => {
                  setSelected(j.jobName)
                  setEditing(null)
                }}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px]",
                  selected === j.jobName && !editing ? "bg-rvbbit-accent/10" : "hover:bg-foreground/[0.05]",
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", j.enabled ? "bg-success" : "bg-chrome-text/40")} />
                <span className="min-w-0 flex-1 truncate text-foreground">{j.jobName}</span>
                <span className="shrink-0 text-[9.5px] text-chrome-text/45">{ago(j.lastRunAt)}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {error ? (
          <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
            <span className="break-words">{error}</span>
            <button type="button" onClick={() => setError(null)} className="ml-auto shrink-0 text-danger/70 hover:text-danger">
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}

        {editing ? (
          <JobForm
            initialName={editing.name}
            isNew={editing.isNew}
            initialSpec={editing.spec}
            busy={busy}
            onSave={onSave}
            onCancel={() => setEditing(null)}
          />
        ) : selectedJob ? (
          <JobDetail
            job={selectedJob}
            runs={runs}
            running={running}
            onRun={onRun}
            onEdit={() => setEditing({ name: selectedJob.jobName, isNew: false, spec: selectedJob.spec })}
            onDelete={() => onDelete(selectedJob.jobName)}
            onRefresh={refreshRuns}
          />
        ) : (
          <SyncOverview
            activeConnectionId={activeConnectionId}
            workspaceActive={workspaceActive}
            onOpenJob={(name) => {
              setSelected(name)
              setEditing(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

// ── Job detail + runs ──────────────────────────────────────────────────

function actionColor(a: string | null): string {
  switch (a) {
    case "snapshot": return "text-success bg-success/12"
    case "import": return "text-rvbbit-accent bg-rvbbit-accent/12"
    case "empty": return "text-chrome-text/70 bg-foreground/[0.06]"
    case "error": return "text-danger bg-danger/12"
    default: return "text-chrome-text/70 bg-foreground/[0.06]"
  }
}

function JobDetail({
  job,
  runs,
  running,
  onRun,
  onEdit,
  onDelete,
  onRefresh,
}: {
  job: SyncJob
  runs: SyncRun[]
  running: boolean
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const groups = useMemo(() => groupByRun(runs), [runs])
  const s = job.spec
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-chrome-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-foreground">{job.jobName}</span>
          <button
            type="button"
            onClick={onRun}
            disabled={running}
            className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2 py-0.5 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", running && "animate-spin")} /> {running ? "Running…" : "Run now"}
          </button>
          <button type="button" onClick={onEdit} className="rounded px-2 py-0.5 text-[11px] text-chrome-text hover:bg-foreground/10 hover:text-foreground">
            Edit
          </button>
          {confirmDel ? (
            <span className="flex items-center gap-1 text-[10px] text-danger">
              delete?
              <button type="button" onClick={onDelete} className="rounded p-0.5 hover:bg-danger/15"><Check className="h-3 w-3" /></button>
              <button type="button" onClick={() => setConfirmDel(false)} className="rounded p-0.5 hover:bg-foreground/10"><X className="h-3 w-3" /></button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} title="Delete job" className="rounded p-0.5 text-chrome-text/60 hover:bg-danger/15 hover:text-danger">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button type="button" onClick={onRefresh} title="Refresh runs" className="ml-auto rounded p-0.5 text-chrome-text/60 hover:bg-foreground/10 hover:text-foreground">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-chrome-text/60">
          <span>source: <span className="font-mono text-foreground/80">{s.server.user}@{s.server.host}:{s.server.port}/{s.server.dbname}</span></span>
          <span>dest schema: <span className="font-mono text-foreground/80">{s.dest_schema}</span></span>
          <span>{s.tables.length > 0 ? `${s.tables.length} tables` : `whole schema (${s.remote_schema})`}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {runs.length === 0 ? (
          <div className="px-3 py-5 text-center text-[11px] text-chrome-text/50">No runs yet — hit “Run now”.</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-chrome-background/95 text-[10px] uppercase tracking-wide text-chrome-text/45">
              <tr className="border-b border-chrome-border">
                <th className="px-2.5 py-1 text-left font-medium">table</th>
                <th className="px-2 py-1 text-left font-medium">action</th>
                <th className="px-2 py-1 text-right font-medium">gen</th>
                <th className="px-2 py-1 text-right font-medium">rows</th>
                <th className="px-2 py-1 text-right font-medium">ms</th>
                <th className="px-2.5 py-1 text-left font-medium">error</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.runId}>
                  <tr className="bg-foreground/[0.05]">
                    <td colSpan={6} className="border-y border-chrome-border/60 px-2.5 py-1 text-[10px]">
                      <span className="font-medium text-foreground/85">{runTime(g.startedAt)}</span>
                      <span className="text-chrome-text/45">
                        {" · "}
                        {g.tables} {g.tables === 1 ? "table" : "tables"}
                        {g.errors > 0 ? ` · ${g.errors} error${g.errors === 1 ? "" : "s"}` : ""}
                      </span>
                    </td>
                  </tr>
                  {g.rows.map((r, i) => (
                    <tr key={`${g.runId}:${i}`} className="border-b border-chrome-border/30 hover:bg-foreground/[0.03]">
                      <td className="px-2.5 py-1 pl-4 font-mono text-foreground/90">{r.sourceTable ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", actionColor(r.action))}>{r.action ?? "—"}</span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-chrome-text/80">{r.generation ?? ""}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-chrome-text/80">{r.rowsLoaded ?? ""}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-chrome-text/55">{r.elapsedMs ?? ""}</td>
                      <td className="max-w-[260px] truncate px-2.5 py-1 text-danger/90" title={r.error ?? ""}>{r.error ?? ""}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Job form ────────────────────────────────────────────────────────────

function JobForm({
  initialName,
  isNew,
  initialSpec,
  busy,
  onSave,
  onCancel,
}: {
  initialName: string
  isNew: boolean
  initialSpec: SyncSpec
  busy: boolean
  onSave: (name: string, spec: SyncSpec) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const [spec, setSpec] = useState<SyncSpec>(initialSpec)
  const [tablesText, setTablesText] = useState(initialSpec.tables.join(", "))
  const [copied, setCopied] = useState(false)

  const setSrv = (k: keyof SyncSpec["server"], v: string | number) =>
    setSpec((s) => ({ ...s, server: { ...s.server, [k]: v } }))

  const fieldCls = "w-full rounded border border-chrome-border bg-background/70 px-1.5 py-1 text-[11px] text-foreground focus:border-rvbbit-accent/60 focus:outline-none"
  const labelCls = "block text-[10px] uppercase tracking-wide text-chrome-text/50"

  // The spec exactly as Save would persist it (tablesText parsed identically).
  const previewSpec = useMemo<SyncSpec>(
    () => ({ ...spec, tables: tablesText.split(",").map((t) => t.trim()).filter(Boolean) }),
    [spec, tablesText],
  )
  // Derive the preview from the SAME builder upsertSyncJob() runs, so the shown
  // DDL can never drift from what Save actually executes.
  const ddl = useMemo(
    () => buildUpsertSyncSql(name.trim() || "job_name", previewSpec, true, true),
    [name, previewSpec],
  )

  const submit = () => {
    onSave(name, previewSpec)
  }

  const copyDdl = useCallback(() => {
    void navigator.clipboard
      ?.writeText(ddl)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }, [ddl])

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-2 text-[12px] font-medium text-foreground">{isNew ? "New sync job" : `Edit “${initialName}”`}</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2">
          <span className={labelCls}>job name</span>
          <input value={name} disabled={!isNew} onChange={(e) => setName(e.target.value)} className={cn(fieldCls, !isNew && "opacity-60")} placeholder="prod_mirror" />
        </label>
        <label><span className={labelCls}>server name</span><input value={spec.server.name} onChange={(e) => setSrv("name", e.target.value)} className={fieldCls} placeholder="prod_src" /></label>
        <label><span className={labelCls}>host</span><input value={spec.server.host} onChange={(e) => setSrv("host", e.target.value)} className={fieldCls} placeholder="db.prod.internal" /></label>
        <label><span className={labelCls}>port</span><input type="number" value={spec.server.port} onChange={(e) => setSrv("port", Number(e.target.value) || 5432)} className={fieldCls} /></label>
        <label><span className={labelCls}>database</span><input value={spec.server.dbname} onChange={(e) => setSrv("dbname", e.target.value)} className={fieldCls} placeholder="warehouse" /></label>
        <label><span className={labelCls}>user</span><input value={spec.server.user} onChange={(e) => setSrv("user", e.target.value)} className={fieldCls} /></label>
        <label><span className={labelCls}>password</span><input type="password" value={spec.server.password} onChange={(e) => setSrv("password", e.target.value)} className={fieldCls} /></label>
        <label><span className={labelCls}>fetch_size</span><input type="number" value={spec.server.fetch_size ?? 10000} onChange={(e) => setSrv("fetch_size", Number(e.target.value) || 10000)} className={fieldCls} /></label>
        <label><span className={labelCls}>remote schema</span><input value={spec.remote_schema} onChange={(e) => setSpec((s) => ({ ...s, remote_schema: e.target.value }))} className={fieldCls} /></label>
        <label><span className={labelCls}>fdw schema</span><input value={spec.fdw_schema} onChange={(e) => setSpec((s) => ({ ...s, fdw_schema: e.target.value }))} className={fieldCls} /></label>
        <label><span className={labelCls}>dest schema</span><input value={spec.dest_schema} onChange={(e) => setSpec((s) => ({ ...s, dest_schema: e.target.value }))} className={fieldCls} /></label>
        <label className="col-span-2">
          <span className={labelCls}>tables (comma-separated; empty = whole schema)</span>
          <input value={tablesText} onChange={(e) => setTablesText(e.target.value)} className={fieldCls} placeholder="customers, orders, accounts" />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <button type="button" onClick={submit} disabled={busy || !name.trim() || !spec.server.host} className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2.5 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40">
          <Check className="h-3 w-3" /> Save job
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-chrome-text hover:bg-foreground/10 hover:text-foreground">
          <ChevronRight className="h-3 w-3 rotate-180" /> Cancel
        </button>
      </div>

      {/* Reveal the SQL behind the form: the exact upsert DDL, built from the same
          helper Save runs (so it can't drift). Copy it, then tweak job_name /
          dest_schema / tables per schema to bulk-create many mirrors without a
          bespoke import UI. Editing fields above updates this live. */}
      <div className="mt-3 border-t border-chrome-border/60 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className={labelCls}>SQL DDL — copy &amp; paste to bulk-create</span>
          <button
            type="button"
            onClick={copyDdl}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-chrome-text hover:bg-foreground/10 hover:text-foreground"
          >
            {copied ? <><Check className="h-3 w-3 text-rvbbit-accent" /> copied</> : <><ClipboardCopy className="h-3 w-3" /> copy</>}
          </button>
        </div>
        <div className="overflow-hidden rounded border border-chrome-border bg-background/40">
          <SqlEditor value={ddl} onChange={() => {}} readOnly autoFocus={false} wrap compact language="sql" height={180} fontSize={11} />
        </div>
      </div>
    </div>
  )
}

// ── Overview dashboard ──────────────────────────────────────────────────
// A single observability surface for "why is the sync slow?": live sweep status,
// per-job timings, re-import vs skip, recent sweeps, and the slowest tables + recent
// errors across all jobs. Derived entirely from sync_runs/sync_jobs/sync_lock — see
// fetchSyncOverview. run_sync now logs an action='import' row for the IMPORT FOREIGN
// SCHEMA phase when it re-imports (shown in the "import" column + the recent-sweeps ↻
// glyph; excluded from per-table counts/rows/slowest). Only fdw_setup_server and
// skipped imports stay row-less; an in-progress import still shows as "importing…".

function fmtDur(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return rem ? `${m}m ${rem}s` : `${m}m`
}
function fmtCount(n: number | null): string {
  if (n == null) return "—"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Make a mouse-only onClick row keyboard-activatable (Enter/Space). */
const onKeyActivate = (fn: () => void) => (e: { key: string; preventDefault: () => void }) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    fn()
  }
}

/** Tiny bar sparkline of recent per-sweep durations (oldest→newest). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-chrome-text/25">—</span>
  const max = Math.max(...values, 1)
  return (
    <span className="inline-flex h-3.5 items-end gap-[1.5px] align-middle">
      {values.map((v, i) => (
        <span key={i} className="w-[3px] rounded-sm bg-rvbbit-accent/45" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </span>
  )
}

const sectionLabel = "mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-chrome-text/45"

function SyncOverview({
  activeConnectionId,
  workspaceActive,
  onOpenJob,
}: {
  activeConnectionId: string | null
  workspaceActive: boolean
  onOpenJob: (name: string) => void
}) {
  const [ov, setOv] = useState<SyncOverviewData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeConnectionId) {
      // No connection: reset rather than wedge on a permanent "Loading…".
      setOv(null)
      setErr(null)
      setLoading(false)
      return
    }
    const r = await fetchSyncOverview(activeConnectionId)
    if (r.overview) setOv(r.overview) // keep last-good data on a transient poll error
    setErr(r.error)
    setLoading(false)
  }, [activeConnectionId])

  useEffect(() => {
    setOv(null) // drop any prior data before the first fetch of this connection
    setLoading(true)
    void load()
  }, [load])

  // Poll faster while a sweep is in flight (sync_runs commits per table, so
  // progress is visible live); back off when idle.
  const running = ov?.status.running ?? false
  useEffect(() => {
    if (!workspaceActive) return
    const h = setInterval(() => void load(), running ? 2000 : 6000)
    return () => clearInterval(h)
  }, [load, workspaceActive, running])

  if (loading && !ov) {
    return <div className="flex flex-1 items-center justify-center text-[11px] text-chrome-text/50">Loading overview…</div>
  }
  if (!ov) {
    return <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-chrome-text/50">{err ?? "No overview data."}</div>
  }

  const st = ov.status
  // A live sweep with no rows attributable to it yet (active_run gated to the lock
  // heartbeat) = it's in fdw_setup + IMPORT FOREIGN SCHEMA, the phase run_sync logs
  // no per-table row for. Show that honestly instead of the previous sweep's stats.
  const importing = st.running && ov.liveJobs.length === 0
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* poll failed but we still have last-good data — surface it non-destructively */}
      {err ? (
        <div className="border-b border-warning/40 bg-warning/10 px-3 py-1 text-[11px] text-warning">
          refresh failed — showing last good data ({err})
        </div>
      ) : null}
      {/* live status banner */}
      <div className="border-b border-chrome-border px-3 py-2">
        {st.running ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            <span className="font-medium text-foreground">Sweep running</span>
            {importing ? (
              <span className="text-warning/80">provisioning / importing schema — no table committed yet ({ago(st.lastHeartbeatAt)})</span>
            ) : (
              <span className="text-chrome-text/60">last table {ago(st.lastHeartbeatAt)}</span>
            )}
            {st.pid != null ? <span className="text-chrome-text/40">pid {st.pid}</span> : null}
          </div>
        ) : st.staleLock ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">Stale lock — backend pid {st.pid} is gone</span>
            <span className="text-warning/70">a crashed run left the lock held; the next CALL will steal it</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            <span className="h-2 w-2 rounded-full bg-chrome-text/30" />
            <span className="font-medium text-foreground/80">Idle</span>
            <span className="text-chrome-text/55">{st.lastActivityAt != null ? `last sweep ${ago(st.lastActivityAt)}` : "no sweeps recorded"}</span>
          </div>
        )}
      </div>

      {/* in-flight progress (only while a sweep runs) */}
      {st.running ? (
        <div className="border-b border-chrome-border px-3 py-2">
          <div className={sectionLabel}><RefreshCw className="h-3 w-3 animate-spin" /> in flight</div>
          {ov.liveJobs.length > 0 ? (
            <div className="space-y-1">
              {ov.liveJobs.map((lj) => (
                <div key={lj.jobName} className="flex items-center gap-2 text-[11px]">
                  <span className="w-32 shrink-0 truncate font-mono text-foreground/85">{lj.jobName}</span>
                  <div className="relative h-2 flex-1 overflow-hidden rounded bg-foreground/[0.06]">
                    <div className="absolute inset-y-0 left-0 rounded bg-rvbbit-accent/60" style={{ width: `${lj.pct ?? 0}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums text-chrome-text/70">
                    {lj.tablesDone}/{lj.tablesTotal ?? "?"}{lj.pct != null ? ` · ${lj.pct}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-chrome-text/55">Provisioning / importing schema — no table progress yet (this phase isn’t logged per-table).</div>
          )}
        </div>
      ) : null}

      {/* per-job rollup */}
      <div className="px-3 py-2">
        <div className={sectionLabel}><TrendingUp className="h-3 w-3" /> jobs · last sweep</div>
        <table className="w-full text-[11px]">
          <thead className="text-[9.5px] uppercase tracking-wide text-chrome-text/40">
            <tr className="border-b border-chrome-border/60">
              <th className="py-1 text-left font-medium">job</th>
              <th className="py-1 text-right font-medium">last run</th>
              <th className="py-1 text-right font-medium">tables</th>
              <th className="py-1 text-right font-medium">rows</th>
              <th className="py-1 text-right font-medium" title="wall span of the last sweep pass (now includes IMPORT FOREIGN SCHEMA when re-imported)">dur</th>
              <th className="py-1 text-right font-medium" title="IMPORT FOREIGN SCHEMA time when the remote schema changed; 'skip' = schema unchanged so the re-import (a catalog-DDL storm) was avoided">import</th>
              <th className="py-1 text-right font-medium">err</th>
              <th className="py-1 pl-2 text-right font-medium">trend</th>
            </tr>
          </thead>
          <tbody>
            {ov.jobStats.map((j) => (
              <tr
                key={j.jobName}
                role="button"
                tabIndex={0}
                onClick={() => onOpenJob(j.jobName)}
                onKeyDown={onKeyActivate(() => onOpenJob(j.jobName))}
                className="cursor-pointer border-b border-chrome-border/25 hover:bg-foreground/[0.04]"
              >
                <td className="py-1 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", j.enabled ? "bg-success" : "bg-chrome-text/35")} />
                    <span className="truncate font-mono text-foreground/90">{j.jobName}</span>
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-chrome-text/55">{ago(j.lastRunAt)}</td>
                <td className="py-1 text-right tabular-nums text-chrome-text/80">{j.tablesSynced ?? "—"}</td>
                <td className="py-1 text-right tabular-nums text-chrome-text/80">{fmtCount(j.rowsLoaded)}</td>
                <td className="py-1 text-right tabular-nums text-foreground/85">{fmtDur(j.lastDurMs)}</td>
                <td
                  className={cn("py-1 text-right tabular-nums", j.reImported ? "text-rvbbit-accent" : j.provisionError ? "text-danger/70" : "text-chrome-text/35")}
                  title={j.reImported ? "re-imported the foreign schema (remote shape changed)" : j.provisionError ? "provisioning failed this run — see errors (not a skip)" : "schema unchanged — re-import skipped"}
                >
                  {j.reImported ? fmtDur(j.importMs) : j.provisionError ? "—" : "skip"}
                </td>
                <td className={cn("py-1 text-right tabular-nums", (j.errors ?? 0) > 0 ? "font-medium text-danger" : "text-chrome-text/35")}>{j.errors ?? 0}</td>
                <td className="py-1 pl-2 text-right"><Sparkline values={j.trend} /></td>
              </tr>
            ))}
            {ov.jobStats.length === 0 ? (
              <tr><td colSpan={8} className="py-3 text-center text-chrome-text/45">No sync jobs.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* recent sweeps + why-slow */}
      <div className="grid grid-cols-2 gap-3 px-3 pb-3">
        <div>
          <div className={sectionLabel}><Activity className="h-3 w-3" /> recent sweeps</div>
          <table className="w-full text-[11px]">
            <tbody>
              {ov.sweeps.map((s) => (
                <tr key={s.runId} className="border-b border-chrome-border/25">
                  <td className="py-1 text-left text-chrome-text/70">{ago(s.startedAt)}</td>
                  <td className="py-1 text-right tabular-nums text-foreground/85">{fmtDur(s.wallMs)}</td>
                  <td
                    className="py-1 text-right tabular-nums text-chrome-text/60"
                    title={s.imports > 0 ? `${s.imports} re-import${s.imports === 1 ? "" : "s"} · ${fmtDur(s.importMs)}` : "no re-imports (all schemas unchanged)"}
                  >
                    {s.jobs}j · {s.tables}t{s.imports > 0 ? <span className="text-rvbbit-accent"> · {s.imports}↻</span> : null}
                  </td>
                  <td className="py-1 text-right tabular-nums text-chrome-text/60">{fmtCount(s.rowsLoaded)}</td>
                  <td className={cn("py-1 text-right tabular-nums", s.errors > 0 ? "text-danger" : "text-chrome-text/30")}>{s.errors > 0 ? `${s.errors}✕` : "ok"}</td>
                </tr>
              ))}
              {ov.sweeps.length === 0 ? (
                <tr><td className="py-3 text-center text-chrome-text/45">No sweeps yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div>
          <div className={sectionLabel}><Zap className="h-3 w-3" /> slowest tables</div>
          <table className="w-full text-[11px]">
            <tbody>
              {ov.slowTables.map((t, i) => (
                <tr
                  key={`${t.jobName}:${t.sourceTable}:${i}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenJob(t.jobName)}
                  onKeyDown={onKeyActivate(() => onOpenJob(t.jobName))}
                  className="cursor-pointer border-b border-chrome-border/25 hover:bg-foreground/[0.04]"
                >
                  <td className="py-1 text-left">
                    <span className="font-mono text-foreground/85">{t.jobName}</span>
                    <span className="text-chrome-text/45">.{t.sourceTable}</span>
                  </td>
                  <td className="py-1 text-right tabular-nums text-chrome-text/55">{fmtCount(t.rowsLoaded)}</td>
                  <td className="py-1 text-right tabular-nums text-warning/90">{fmtDur(t.elapsedMs)}</td>
                </tr>
              ))}
              {ov.slowTables.length === 0 ? (
                <tr><td className="py-3 text-center text-chrome-text/45">No table timings yet.</td></tr>
              ) : null}
            </tbody>
          </table>
          {ov.errors.length > 0 ? (
            <>
              <div className={cn(sectionLabel, "mt-2 text-danger/70")}><AlertTriangle className="h-3 w-3" /> recent errors</div>
              <div className="space-y-1">
                {ov.errors.map((e, i) => (
                  <div
                    key={`${e.jobName}:${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenJob(e.jobName)}
                    onKeyDown={onKeyActivate(() => onOpenJob(e.jobName))}
                    className="cursor-pointer rounded bg-danger/[0.07] px-1.5 py-1 text-[10.5px] hover:bg-danger/[0.12]"
                  >
                    <span className="font-mono text-foreground/80">{e.jobName}{e.sourceTable ? `.${e.sourceTable}` : ""}</span>
                    <span className="text-chrome-text/40"> · {ago(e.startedAt)}</span>
                    <div className="truncate text-danger/85" title={e.error ?? ""}>{e.error}</div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
