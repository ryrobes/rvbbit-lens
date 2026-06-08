"use client"

import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import { Check, ChevronRight, Database, Plus, RefreshCw, Trash2, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  deleteSyncJob,
  emptySpec,
  listSyncJobs,
  listSyncRuns,
  runSyncJob,
  upsertSyncJob,
  type SyncJob,
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
}

/** Group the per-table rows (already DESC by started_at) into their runs. A run
 *  is one run_id; the singleton lock means runs never temporally interleave. */
function groupByRun(runs: SyncRun[]): RunGroup[] {
  const out: RunGroup[] = []
  for (const r of runs) {
    const key = r.runId ?? "?"
    const last = out[out.length - 1]
    if (last && last.runId === key) last.rows.push(r)
    else out.push({ runId: key, startedAt: r.startedAt, rows: [r], errors: 0 })
  }
  for (const g of out) {
    const times = g.rows.map((x) => x.startedAt).filter((t): t is number => t != null)
    g.startedAt = times.length ? Math.min(...times) : g.startedAt
    g.errors = g.rows.filter((x) => x.action === "error").length
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
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[11px] text-chrome-text/50">
            Pick a sync job, or create one to mirror a Postgres source into rvbbit tables with full time-travel.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Job detail + runs ──────────────────────────────────────────────────

function actionColor(a: string | null): string {
  switch (a) {
    case "snapshot": return "text-success bg-success/12"
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
                        {g.rows.length} {g.rows.length === 1 ? "table" : "tables"}
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

  const setSrv = (k: keyof SyncSpec["server"], v: string | number) =>
    setSpec((s) => ({ ...s, server: { ...s.server, [k]: v } }))

  const fieldCls = "w-full rounded border border-chrome-border bg-background/70 px-1.5 py-1 text-[11px] text-foreground focus:border-rvbbit-accent/60 focus:outline-none"
  const labelCls = "block text-[10px] uppercase tracking-wide text-chrome-text/50"

  const submit = () => {
    const tables = tablesText.split(",").map((t) => t.trim()).filter(Boolean)
    onSave(name, { ...spec, tables })
  }

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
    </div>
  )
}
