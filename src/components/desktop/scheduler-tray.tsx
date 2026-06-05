"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo } from "./instruments"
import { SqlEditor } from "./sql-editor"
import {
  CREATE_EXTENSION_SQL,
  detectCronState,
  exec,
  isAccelTickJob,
  isCatalogJob,
  isSemanticJob,
  listCronJobs,
  listCronRuns,
  scheduleSql,
  setActiveSql,
  unscheduleSql,
  type CronJob,
  type CronRun,
  type CronState,
} from "@/lib/rvbbit/cron"
import {
  builderToCron,
  cronToBuilder,
  CRON_PRESETS,
  describeCron,
  DOW_NAMES,
  isValidCron,
  nextRuns,
  type CronBuilder,
} from "@/lib/desktop/cron-expr"

interface SchedulerTrayProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSql: (sql: string, title: string) => void
  onOpenDrift: () => void
}

interface EditState {
  jobid: number | null
  name: string
  builder: CronBuilder
  command: string
}

const CRAWL_COMMAND = "SELECT rvbbit.catalog_crawl();"
// The accelerator freshness heartbeat. Runs every minute; the policy-aware
// rvbbit.accel_tick() decides which dirty, high-value tables to refresh.
const ACCEL_TICK_COMMAND = "SELECT rvbbit.accel_tick(4);"

export function SchedulerTray({ activeConnectionId, hasRvbbit, onOpenSql, onOpenDrift }: SchedulerTrayProps) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<CronState | null>(null)
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [runs, setRuns] = useState<CronRun[]>([])
  const [editing, setEditing] = useState<EditState | null>(null)
  const [running, setRunning] = useState<number | null>(null)
  const [runResult, setRunResult] = useState<{ jobid: number; ok: boolean; msg: string } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const s = await detectCronState(activeConnectionId)
    setState(s.state)
    setError(s.error)
    if (s.state?.created) {
      const j = await listCronJobs(activeConnectionId)
      setJobs(j.jobs)
      if (j.error) setError(j.error)
    } else {
      setJobs([])
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [open, reload])

  // Lightweight status poll so the systray dot reflects reality without opening.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    void (async () => {
      const s = await detectCronState(activeConnectionId)
      if (cancelled) return
      setState(s.state)
      if (s.state?.created) {
        const j = await listCronJobs(activeConnectionId)
        if (!cancelled) setJobs(j.jobs)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditing(null)
      }
    }
    document.addEventListener("mousedown", h, true)
    return () => document.removeEventListener("mousedown", h, true)
  }, [open])

  const mutate = useCallback(
    async (sql: string) => {
      if (!activeConnectionId || busy) return
      setBusy(true)
      const r = await exec(activeConnectionId, sql)
      if (!r.ok) setError(r.error)
      await reload()
      setBusy(false)
    },
    [activeConnectionId, busy, reload],
  )

  // Run a job's command immediately (ad-hoc, via this connection). pg_cron has no
  // "trigger now", so we just execute the SQL — note this does NOT create a
  // cron.job_run_details entry (only scheduled runs do).
  const runNow = useCallback(
    async (job: CronJob) => {
      if (!activeConnectionId || running != null) return
      setRunning(job.jobid)
      setRunResult(null)
      const started = Date.now()
      const r = await exec(activeConnectionId, job.command)
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      setRunResult({
        jobid: job.jobid,
        ok: r.ok,
        msg: r.ok ? `ran ✓ ${secs}s` : (r.error ?? "failed").slice(0, 120),
      })
      setRunning(null)
    },
    [activeConnectionId, running],
  )

  const toggleRuns = useCallback(
    async (jobid: number) => {
      if (expanded === jobid) {
        setExpanded(null)
        return
      }
      setExpanded(jobid)
      setRuns([])
      if (!activeConnectionId) return
      const r = await listCronRuns(activeConnectionId, jobid, hasRvbbit)
      setRuns(r.runs)
      if (r.error) setError(r.error)
    },
    [activeConnectionId, expanded, hasRvbbit],
  )

  const status = useMemo(() => trayStatus(state, jobs), [state, jobs])
  const crawlJob = jobs.find(isCatalogJob)
  const accelTickJob = jobs.find(isAccelTickJob)

  return (
    <div ref={wrapRef} className="relative" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Scheduled tasks (pg_cron)"
        aria-label="Scheduled tasks"
        className={cn(
          "relative grid h-6 w-6 place-items-center rounded transition-colors",
          open ? "bg-foreground/[0.1] text-foreground" : "text-chrome-text/70 hover:text-foreground",
        )}
      >
        <Clock className="h-3.5 w-3.5" />
        <span
          className={cn("absolute -right-0 -top-0 h-1.5 w-1.5 rounded-full", status.dot)}
          style={status.pulse ? undefined : undefined}
        />
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[420px] overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/95 text-[12px] text-chrome-text shadow-2xl backdrop-blur">
          {/* header */}
          <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/60 px-3 py-2">
            <Clock className="h-3.5 w-3.5 text-rvbbit-accent" />
            <span className="font-medium text-foreground">Scheduled Tasks</span>
            <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider", status.badgeClass)}>
              {status.badge}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => onOpenSql("SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobid;", "cron.job")}
                title="Open cron.job in a SQL window"
                disabled={!state?.created}
                className="grid h-6 w-6 place-items-center rounded text-chrome-text/60 hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-30"
              >
                <Database className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void reload()}
                title="Reload"
                className="grid h-6 w-6 place-items-center rounded text-chrome-text/60 hover:bg-foreground/[0.08] hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {error ? (
            <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="break-words">{error}</span>
              <button type="button" onClick={() => setError(null)} className="ml-auto text-warning/70 hover:text-warning">
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}

          <div className="max-h-[60vh] overflow-auto">
            {!activeConnectionId ? (
              <Empty label="No active connection." />
            ) : !state ? (
              <Empty label="checking pg_cron…" />
            ) : !state.created ? (
              <SetupView state={state} busy={busy} onCreate={() => void mutate(CREATE_EXTENSION_SQL)} />
            ) : editing ? (
              <Editor
                edit={editing}
                setEdit={setEditing}
                busy={busy}
                onSave={async (name, schedule, command) => {
                  await mutate(scheduleSql(name, schedule, command))
                  setEditing(null)
                }}
              />
            ) : (
              <div className="p-2">
                {/* catalog refresh preset */}
                {hasRvbbit ? (
                  <CrawlPreset
                    job={crawlJob}
                    busy={busy}
                    onSchedule={() =>
                      void mutate(scheduleSql("rvbbit_catalog_refresh", "0 3 * * *", CRAWL_COMMAND))
                    }
                  />
                ) : null}

                {/* accelerator freshness heartbeat preset */}
                {hasRvbbit ? (
                  <div className="mt-1">
                    <AccelTickPreset
                      job={accelTickJob}
                      busy={busy}
                      onSchedule={() =>
                        void mutate(scheduleSql("rvbbit_accel_tick", "* * * * *", ACCEL_TICK_COMMAND))
                      }
                    />
                  </div>
                ) : null}

                <div className="mb-1.5 mt-2 flex items-center px-1">
                  <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">
                    {jobs.length} job{jobs.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({
                        jobid: null,
                        name: "",
                        builder: { preset: "daily", minute: 0, hour: 3, dom: 1, dow: 1, raw: "0 3 * * *" },
                        command: hasRvbbit ? CRAWL_COMMAND : "SELECT 1;",
                      })
                    }
                    className="ml-auto inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2 py-0.5 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25"
                  >
                    <Plus className="h-3 w-3" /> New task
                  </button>
                </div>

                {jobs.length === 0 ? (
                  <Empty label="No scheduled tasks yet." />
                ) : (
                  <div className="space-y-1">
                    {jobs.map((j) => (
                      <JobRow
                        key={j.jobid}
                        job={j}
                        expanded={expanded === j.jobid}
                        runs={runs}
                        rvbbit={hasRvbbit}
                        busy={busy}
                        running={running === j.jobid}
                        result={runResult?.jobid === j.jobid ? runResult : null}
                        onRunNow={() => void runNow(j)}
                        onToggleRuns={() => void toggleRuns(j.jobid)}
                        onSetActive={(a) => void mutate(setActiveSql(j.jobid, a))}
                        onDelete={() => void mutate(unscheduleSql(j.jobid))}
                        onEdit={() =>
                          setEditing({
                            jobid: j.jobid,
                            name: j.jobname ?? `job_${j.jobid}`,
                            builder: cronToBuilder(j.schedule),
                            command: j.command,
                          })
                        }
                        onInspect={() =>
                          onOpenSql(
                            `SELECT runid, status, start_time, end_time, return_message\nFROM cron.job_run_details WHERE jobid = ${j.jobid}\nORDER BY start_time DESC LIMIT 50;`,
                            `runs · ${j.jobname ?? j.jobid}`,
                          )
                        }
                        onOpenDrift={isCatalogJob(j) ? onOpenDrift : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Setup (pg_cron not yet created) ─────────────────────────────────

function SetupView({ state, busy, onCreate }: { state: CronState; busy: boolean; onCreate: () => void }) {
  // Can create here only if preloaded AND this db is pg_cron's home.
  const homeMatch = !state.cronDb || state.cronDb === state.thisDb
  const canCreate = state.available && state.preloaded && homeMatch
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-1.5 text-chrome-text/80">
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
        pg_cron is not set up in <span className="font-mono text-foreground">{state.thisDb}</span>.
      </div>
      {canCreate ? (
        <>
          <p className="text-[11px] leading-snug text-chrome-text/60">
            pg_cron is preloaded — it can be created here with no restart.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onCreate}
            className="inline-flex items-center gap-1.5 rounded bg-rvbbit-accent/15 px-2.5 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
          >
            <Check className="h-3 w-3" /> Create pg_cron extension
          </button>
        </>
      ) : state.preloaded && !homeMatch ? (
        <p className="text-[11px] leading-snug text-chrome-text/60">
          pg_cron&apos;s home database is{" "}
          <span className="font-mono text-foreground">{state.cronDb}</span> — connect there to manage
          jobs, or set <span className="font-mono">cron.database_name = &apos;{state.thisDb}&apos;</span> and restart.
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-snug text-chrome-text/60">
            Add to <span className="font-mono">postgresql.conf</span> and restart (no in-app install — it
            needs a server restart):
          </p>
          <pre className="overflow-x-auto rounded bg-background/70 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-foreground/90">
{`shared_preload_libraries = 'pg_cron'\ncron.database_name = '${state.thisDb}'`}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Catalog refresh preset ──────────────────────────────────────────

function CrawlPreset({ job, busy, onSchedule }: { job?: CronJob; busy: boolean; onSchedule: () => void }) {
  if (job) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-rvbbit-accent/30 bg-rvbbit-bg/30 px-2.5 py-1.5">
        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-rvbbit-accent" />
        <span className="text-[11px] text-chrome-text/80">
          Catalog refresh scheduled — <span className="text-foreground">{describeCron(job.schedule)}</span>
        </span>
        <span className={cn("ml-auto h-1.5 w-1.5 rounded-full", job.active ? "bg-success" : "bg-chrome-text/40")} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-chrome-border bg-secondary-background/40 px-2.5 py-1.5">
      <RefreshCw className="h-3.5 w-3.5 shrink-0 text-chrome-text/60" />
      <span className="text-[11px] text-chrome-text/70">Keep the catalog / KG / drift fingerprints fresh.</span>
      <button
        type="button"
        disabled={busy}
        onClick={onSchedule}
        className="ml-auto rounded bg-rvbbit-accent/15 px-2 py-0.5 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
      >
        Schedule crawl
      </button>
    </div>
  )
}

// ── Accelerator freshness heartbeat preset ──────────────────────────

function AccelTickPreset({ job, busy, onSchedule }: { job?: CronJob; busy: boolean; onSchedule: () => void }) {
  if (job) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-rvbbit-accent/30 bg-rvbbit-bg/30 px-2.5 py-1.5">
        <Zap className="h-3.5 w-3.5 shrink-0 text-rvbbit-accent" />
        <span className="text-[11px] text-chrome-text/80">
          Accelerator heartbeat — <span className="text-foreground">{describeCron(job.schedule)}</span>
        </span>
        <span className={cn("ml-auto h-1.5 w-1.5 rounded-full", job.active ? "bg-success" : "bg-chrome-text/40")} />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-chrome-border bg-secondary-background/40 px-2.5 py-1.5">
      <Zap className="h-3.5 w-3.5 shrink-0 text-chrome-text/60" />
      <span className="text-[11px] text-chrome-text/70">
        Keep accelerators fresh — policy-driven delta/full refresh of dirty tables.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onSchedule}
        className="ml-auto rounded bg-rvbbit-accent/15 px-2 py-0.5 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
      >
        Schedule heartbeat
      </button>
    </div>
  )
}

// ── Job row + run history ───────────────────────────────────────────

function JobRow({
  job,
  expanded,
  runs,
  rvbbit,
  busy,
  running,
  result,
  onRunNow,
  onToggleRuns,
  onSetActive,
  onDelete,
  onEdit,
  onInspect,
  onOpenDrift,
}: {
  job: CronJob
  expanded: boolean
  runs: CronRun[]
  rvbbit: boolean
  busy: boolean
  running: boolean
  result: { ok: boolean; msg: string } | null
  onRunNow: () => void
  onToggleRuns: () => void
  onSetActive: (a: boolean) => void
  onDelete: () => void
  onEdit: () => void
  onInspect: () => void
  onOpenDrift?: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const totalCost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0)
  return (
    <div className={cn("rounded-md border bg-secondary-background/40", expanded ? "border-rvbbit-accent/40" : "border-chrome-border/60")}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={onToggleRuns} className="grid h-5 w-5 shrink-0 place-items-center rounded text-chrome-text/50 hover:text-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDot(job.lastStatus, job.active))} title={job.lastStatus ?? "never run"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-foreground">{job.jobname ?? `job ${job.jobid}`}</span>
            {isSemanticJob(job) && rvbbit ? (
              <span className="rounded bg-rvbbit-accent/15 px-1 text-[8.5px] uppercase tracking-wider text-rvbbit-accent">semantic</span>
            ) : null}
          </div>
          {result ? (
            <div className={cn("truncate text-[10px]", result.ok ? "text-success" : "text-danger")}>{result.msg}</div>
          ) : (
            <div className="truncate text-[10px] text-chrome-text/55">{describeCron(job.schedule)}</div>
          )}
        </div>
        <span className="shrink-0 text-[9px] text-chrome-text/40">
          {job.lastStart ? fmtAgo(job.lastStart) : "—"}
        </span>
        <span className="flex shrink-0 items-center">
          {running ? (
            <span className="grid h-6 w-6 place-items-center text-rvbbit-accent" title="running…">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            </span>
          ) : (
            <IconBtn icon={Zap} title="Run now (executes the command immediately; not recorded in cron history)" disabled={busy} onClick={onRunNow} />
          )}
          <IconBtn icon={job.active ? Pause : Play} title={job.active ? "Pause" : "Resume"} disabled={busy} onClick={() => onSetActive(!job.active)} active={job.active} />
          <IconBtn icon={Pencil} title="Edit" disabled={busy} onClick={onEdit} />
          {confirmDel ? (
            <span className="inline-flex items-center">
              <IconBtn icon={Check} title="Confirm delete" danger disabled={busy} onClick={() => { setConfirmDel(false); onDelete() }} />
              <IconBtn icon={X} title="Cancel" onClick={() => setConfirmDel(false)} />
            </span>
          ) : (
            <IconBtn icon={Trash2} title="Unschedule" danger onClick={() => setConfirmDel(true)} />
          )}
        </span>
      </div>

      {expanded ? (
        <div className="border-t border-chrome-border/40 px-2 py-1.5">
          <pre className="mb-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-background/50 px-2 py-1 font-mono text-[10px] text-foreground/80">{job.command}</pre>
          <div className="mb-1 flex items-center gap-2 text-[9px] uppercase tracking-wider text-chrome-text/45">
            <span>recent runs</span>
            {rvbbit && totalCost > 0 ? <span className="text-rvbbit-accent">${totalCost.toFixed(4)} total</span> : null}
            <button type="button" onClick={onInspect} className="ml-auto normal-case tracking-normal text-chrome-text/55 hover:text-foreground">inspect ↗</button>
            {onOpenDrift ? (
              <button type="button" onClick={onOpenDrift} className="normal-case tracking-normal text-chrome-text/55 hover:text-foreground">drift ↗</button>
            ) : null}
          </div>
          {runs.length === 0 ? (
            <div className="py-1 text-center text-[10px] text-chrome-text/40">no runs recorded</div>
          ) : (
            <table className="w-full text-[10px]">
              <tbody>
                {runs.slice(0, 8).map((r) => (
                  <tr key={r.runid} className="border-t border-chrome-border/20">
                    <td className="py-0.5">
                      <span className={cn("mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle", statusDot(r.status, true))} />
                      {r.startTime ? fmtAgo(r.startTime) : "—"}
                    </td>
                    <td className="py-0.5 text-right font-mono tabular-nums text-chrome-text/65">
                      {r.durationS != null ? `${r.durationS < 1 ? (r.durationS * 1000).toFixed(0) + "ms" : r.durationS.toFixed(1) + "s"}` : "—"}
                    </td>
                    <td className="py-0.5 text-right font-mono tabular-nums text-chrome-text/65">
                      {r.costUsd ? `$${r.costUsd.toFixed(4)}` : ""}
                    </td>
                    <td className="py-0.5 pl-2 text-chrome-text/60">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── The visual cron editor ──────────────────────────────────────────

function Editor({
  edit,
  setEdit,
  busy,
  onSave,
}: {
  edit: EditState
  setEdit: (e: EditState | null) => void
  busy: boolean
  onSave: (name: string, schedule: string, command: string) => void
}) {
  const expr = builderToCron(edit.builder)
  const valid = edit.name.trim() !== "" && edit.command.trim() !== "" && isValidCron(expr)
  const upd = (patch: Partial<CronBuilder>) => setEdit({ ...edit, builder: { ...edit.builder, ...patch } })
  const runs = nextRuns(expr, 3)

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">
          {edit.jobid == null ? "New task" : "Edit task"}
        </span>
        <button type="button" onClick={() => setEdit(null)} className="ml-auto text-chrome-text/55 hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <Field label="Name">
        <input
          value={edit.name}
          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          disabled={edit.jobid != null}
          placeholder="my_task"
          className="h-7 w-full rounded border border-chrome-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </Field>

      <Field label="Schedule">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={edit.builder.preset}
            onChange={(e) => upd({ preset: e.target.value as CronBuilder["preset"] })}
            className="h-7 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {edit.builder.preset === "weekly" ? (
            <Select value={edit.builder.dow} onChange={(dow) => upd({ dow })} options={DOW_NAMES.map((n, i) => [i, n])} />
          ) : null}
          {edit.builder.preset === "monthly" ? (
            <Select value={edit.builder.dom} onChange={(dom) => upd({ dom })} options={Array.from({ length: 31 }, (_, i) => [i + 1, `day ${i + 1}`])} />
          ) : null}
          {edit.builder.preset !== "hourly" && edit.builder.preset !== "custom" ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[10px] text-chrome-text/50">at</span>
              <Select value={edit.builder.hour} onChange={(hour) => upd({ hour })} options={Array.from({ length: 24 }, (_, i) => [i, String(i).padStart(2, "0")])} />
              <span className="text-chrome-text/40">:</span>
              <Select value={edit.builder.minute} onChange={(minute) => upd({ minute })} options={[0, 15, 30, 45].map((m) => [m, String(m).padStart(2, "0")])} />
            </span>
          ) : null}
          {edit.builder.preset === "hourly" ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[10px] text-chrome-text/50">at minute</span>
              <Select value={edit.builder.minute} onChange={(minute) => upd({ minute })} options={[0, 5, 10, 15, 20, 30, 45].map((m) => [m, String(m)])} />
            </span>
          ) : null}
        </div>
        {edit.builder.preset === "custom" ? (
          <input
            value={edit.builder.raw}
            onChange={(e) => upd({ raw: e.target.value })}
            placeholder="*/5 * * * *"
            className="mt-1.5 h-7 w-full rounded border border-chrome-border bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        ) : null}
      </Field>

      {/* live preview */}
      <div className="rounded border border-chrome-border/60 bg-background/40 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-rvbbit-accent">{expr || "—"}</span>
          <span className="text-[10px] text-chrome-text/55">{describeCron(expr)}</span>
        </div>
        {runs.length > 0 ? (
          <div className="mt-1 text-[10px] text-chrome-text/45">
            next: {runs.map((d) => d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join("  ·  ")}
          </div>
        ) : (
          <div className="mt-1 text-[10px] text-danger/70">not a valid schedule</div>
        )}
      </div>

      <Field label="SQL command">
        <div className="overflow-hidden rounded border border-chrome-border bg-background">
          <SqlEditor
            value={edit.command}
            onChange={(v) => setEdit({ ...edit, command: v })}
            height={92}
            fontSize={12}
            onRun={() => {
              if (valid) onSave(edit.name.trim(), expr, edit.command.trim())
            }}
          />
        </div>
      </Field>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => onSave(edit.name.trim(), expr, edit.command.trim())}
          className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2.5 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
        >
          <Check className="h-3 w-3" /> {edit.jobid == null ? "Schedule" : "Save"}
        </button>
        <button type="button" onClick={() => setEdit(null)} className="text-[11px] text-chrome-text/55 hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── small bits ──────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wider text-chrome-text/45">{label}</span>
      {children}
    </label>
  )
}

function Select({ value, onChange, options }: { value: number; onChange: (v: number) => void; options: [number, string][] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  )
}

function IconBtn({
  icon: Icon,
  title,
  onClick,
  disabled,
  active,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-6 w-6 place-items-center rounded transition disabled:opacity-40",
        danger
          ? "text-chrome-text/55 hover:bg-danger/10 hover:text-danger"
          : active
            ? "text-rvbbit-accent hover:bg-rvbbit-accent/10"
            : "text-chrome-text/60 hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function Empty({ label }: { label: string }) {
  return <div className="grid place-items-center px-4 py-6 text-center text-[11px] text-chrome-text/45">{label}</div>
}

function trayStatus(state: CronState | null, jobs: CronJob[]): {
  dot: string
  pulse: boolean
  badge: string
  badgeClass: string
} {
  if (!state) return { dot: "bg-chrome-text/30", pulse: false, badge: "…", badgeClass: "bg-foreground/[0.06] text-chrome-text/55" }
  if (!state.created) return { dot: "bg-warning", pulse: false, badge: "setup", badgeClass: "bg-warning/15 text-warning" }
  const failed = jobs.some((j) => j.lastStatus === "failed")
  const active = jobs.some((j) => j.active)
  if (failed) return { dot: "bg-danger", pulse: false, badge: "run failed", badgeClass: "bg-danger/15 text-danger" }
  if (active) return { dot: "bg-success", pulse: false, badge: `${jobs.filter((j) => j.active).length} active`, badgeClass: "bg-success/10 text-success" }
  return { dot: "bg-chrome-text/40", pulse: false, badge: "idle", badgeClass: "bg-foreground/[0.06] text-chrome-text/55" }
}

function statusDot(status: string | null, active: boolean): string {
  if (status === "failed") return "bg-danger"
  if (status === "succeeded") return active ? "bg-success" : "bg-success/50"
  if (status === "running") return "bg-rvbbit-accent animate-pulse"
  return active ? "bg-chrome-text/40" : "bg-chrome-text/25"
}
