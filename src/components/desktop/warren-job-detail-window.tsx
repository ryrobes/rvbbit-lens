"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  FlowArrow,
  Globe,
  Rocket,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchWarrenJob,
  type WarrenJob,
  type WarrenJobStatus,
} from "@/lib/rvbbit/warren"
import { CodePreview } from "./code-preview"
import { fmtAgo, fmtMs } from "./instruments"
import type { WarrenJobDetailPayload } from "@/lib/desktop/types"

interface WarrenJobDetailWindowProps {
  payload: WarrenJobDetailPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSpecialist: (name: string) => void
  onOpenOperator: (name: string) => void
}

/**
 * Live tracker for a single warren job. Auto-polls every 2s while the
 * status is non-terminal; once `completed`/`failed`/`cancelled`, polling
 * stops. On `completed`, the header surfaces cross-link chips to the
 * registered backend (Specialist Detail) and operator (Operator Flow).
 *
 * Lifted out as its own window so deploys are trackable in parallel —
 * a deploy from Capability Detail can keep running while the user
 * picks a second capability and queues another job.
 */
export function WarrenJobDetailWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenSpecialist,
  onOpenOperator,
}: WarrenJobDetailWindowProps) {
  const [job, setJob] = useState<WarrenJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0
  const terminal = isTerminal(job?.status)

  const poll = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchWarrenJob(activeConnectionId, payload.jobId)
    if (r.error) setError(r.error)
    else setError(null)
    setJob(r.job)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, payload.jobId])

  // initial + polling-while-non-terminal
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await poll()
    }
    void run()
    if (!activeConnectionId) return () => { cancelled = true }
    const id = setInterval(() => {
      if (terminal) return
      void poll()
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, terminal, poll])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text/70">
        No pg_rvbbit extension on this connection.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" /> loading job {payload.jobId.slice(0, 8)}…
        </span>
      </div>
    )
  }
  if (!job) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg p-6 text-center text-[12px] text-danger">
        <div>
          <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
          {error ?? `job ${payload.jobId} not found`}
        </div>
      </div>
    )
  }

  const titleName = job.name ?? payload.jobName ?? job.job_id.slice(0, 8)

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Rocket className="h-4 w-4 text-brand-warren" />
        <span className="text-[13px] font-medium text-foreground">{titleName}</span>
        <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/65">
          {job.kind}
        </span>
        <JobStatusPill status={job.status} />
        {job.claimed_by ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-brand-warren/10 px-1.5 py-0.5 font-mono text-[10px] text-brand-warren"
            title={job.claimed_at ? `claimed ${fmtAgo(job.claimed_at)}` : ""}
          >
            on {job.claimed_by}
          </span>
        ) : null}
        {job.attempts > 1 ? (
          <span className="text-[10px] text-chrome-text/55">
            attempt {job.attempts}
          </span>
        ) : null}
        {job.backend_name ? (
          <button
            type="button"
            onClick={() => onOpenSpecialist(job.backend_name!)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-specialists/40 bg-brand-specialists/10 px-2 py-0.5 text-[10px] text-brand-specialists hover:bg-brand-specialists/15"
            title={`open backend ${job.backend_name} in Specialist Detail`}
          >
            <Brain className="h-3 w-3" />
            {job.backend_name}
          </button>
        ) : null}
        {job.operator_name ? (
          <button
            type="button"
            onClick={() => onOpenOperator(job.operator_name!)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-operators/40 bg-brand-operators/10 px-2 py-0.5 text-[10px] text-brand-operators hover:bg-brand-operators/15"
            title={`open rvbbit.${job.operator_name} in Operator Flow`}
          >
            <FlowArrow className="h-3 w-3" />
            {job.operator_name}
          </button>
        ) : null}
        <span className="ml-auto text-[10px] text-chrome-text/45">
          {terminal ? "polling stopped" : `polling · last ${fmtAgo(updatedAt)}`}
        </span>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {/* body */}
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <StatusTimeline job={job} />

        <div className="grid grid-cols-2 gap-2.5">
          <Card title="Target selector">
            <pre className="font-mono text-[11px] text-foreground/90">
              {JSON.stringify(job.target_selector, null, 0)}
            </pre>
          </Card>
          <Card title="Endpoint">
            {job.endpoint_url ? (
              <span className="break-all font-mono text-[11px] text-foreground">
                {job.endpoint_url}
              </span>
            ) : (
              <span className="text-[11px] text-chrome-text/55">
                {job.status === "completed"
                  ? "(no endpoint reported)"
                  : "(set on completion)"}
              </span>
            )}
          </Card>
        </div>

        {job.error ? (
          <Card title="Error" tone="danger">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-danger">
              {job.error}
            </pre>
          </Card>
        ) : null}

        {job.logs != null ? <LogsPanel logs={job.logs} /> : null}

        <ManifestPanel manifest={job.manifest} />
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────

function isTerminal(s: WarrenJobStatus | undefined): boolean {
  return s === "completed" || s === "failed" || s === "cancelled"
}

const STATUS_TONE: Record<WarrenJobStatus, { ring: string; bg: string; fg: string; label: string }> = {
  queued: {
    ring: "ring-chrome-border/40",
    bg: "bg-foreground/[0.05]",
    fg: "text-chrome-text/75",
    label: "queued",
  },
  running: {
    ring: "ring-rvbbit-accent/30",
    bg: "bg-rvbbit-accent/15",
    fg: "text-rvbbit-accent",
    label: "running",
  },
  completed: {
    ring: "ring-success/40",
    bg: "bg-success/15",
    fg: "text-success",
    label: "completed",
  },
  failed: {
    ring: "ring-danger/40",
    bg: "bg-danger/15",
    fg: "text-danger",
    label: "failed",
  },
  cancelled: {
    ring: "ring-chrome-border/40",
    bg: "bg-foreground/[0.05]",
    fg: "text-chrome-text/65",
    label: "cancelled",
  },
}

function JobStatusPill({ status }: { status: WarrenJobStatus }) {
  const t = STATUS_TONE[status] ?? STATUS_TONE.queued
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ring-1",
        t.bg,
        t.fg,
        t.ring,
      )}
    >
      {status === "running" ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-rvbbit-accent" />
        </span>
      ) : status === "completed" ? (
        <CheckCircle2 className="h-2.5 w-2.5" />
      ) : status === "failed" ? (
        <X className="h-2.5 w-2.5" />
      ) : (
        <Clock className="h-2.5 w-2.5" />
      )}
      {t.label}
    </span>
  )
}

interface TimelineStep {
  key: string
  label: string
  /** epoch ms when this stage was entered */
  at: number | null
  state: "pending" | "active" | "ok" | "skipped" | "failed"
}

function StatusTimeline({ job }: { job: WarrenJob }) {
  // Derive the stages from job timestamps + final status. We don't have
  // per-stage transition timestamps for "queued" → "running" beyond
  // `started_at` (when the agent claimed) and `finished_at`, but that
  // covers the path the user cares about.
  const completedOk = job.status === "completed"
  const completedFail = job.status === "failed" || job.status === "cancelled"
  const steps: TimelineStep[] = [
    {
      key: "created",
      label: "Created",
      at: job.created_at,
      state: "ok",
    },
    {
      key: "queued",
      label: "Queued",
      at: job.created_at,
      state: job.status === "queued" ? "active" : "ok",
    },
    {
      key: "running",
      label: "Running",
      at: job.started_at ?? job.claimed_at,
      state:
        job.status === "running"
          ? "active"
          : job.started_at || job.claimed_at
            ? completedFail
              ? "failed"
              : "ok"
            : "pending",
    },
    {
      key: "settled",
      label: completedFail ? "Failed" : "Completed",
      at: job.finished_at,
      state: completedOk
        ? "ok"
        : completedFail
          ? "failed"
          : "pending",
    },
  ]

  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-chrome-text/55">
        status timeline
      </div>
      <div className="flex items-center gap-0">
        {steps.map((s, i) => (
          <div key={s.key} className="flex flex-1 items-center gap-0">
            <TimelineStepCircle step={s} />
            {i < steps.length - 1 ? (
              <div
                className={cn(
                  "h-px flex-1",
                  s.state === "ok"
                    ? "bg-success/50"
                    : s.state === "failed"
                      ? "bg-danger/50"
                      : "bg-chrome-border/50",
                )}
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-baseline gap-0">
        {steps.map((s, i) => (
          <div
            key={s.key}
            className={cn(
              "flex-1 text-[9px]",
              i === 0
                ? "text-left"
                : i === steps.length - 1
                  ? "text-right"
                  : "text-center",
            )}
          >
            <div className="font-mono text-chrome-text/70">{s.label}</div>
            <div className="font-mono tabular-nums text-chrome-text/50">
              {s.at ? new Date(s.at).toLocaleTimeString([], { hour12: false }) : "—"}
            </div>
          </div>
        ))}
      </div>
      {job.finished_at && job.created_at ? (
        <div className="mt-1 text-right text-[9px] text-chrome-text/55">
          total{" "}
          <span className="font-mono tabular-nums">
            {fmtMs(job.finished_at - job.created_at)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function TimelineStepCircle({ step }: { step: TimelineStep }) {
  const tone =
    step.state === "ok"
      ? "border-success bg-success/20 text-success"
      : step.state === "active"
        ? "border-rvbbit-accent bg-rvbbit-accent/20 text-rvbbit-accent"
        : step.state === "failed"
          ? "border-danger bg-danger/20 text-danger"
          : "border-chrome-border/50 bg-secondary-background text-chrome-text/45"
  return (
    <div
      className={cn(
        "relative grid h-5 w-5 shrink-0 place-items-center rounded-full border-2",
        tone,
      )}
      title={step.label}
    >
      {step.state === "ok" ? (
        <CheckCircle2 className="h-2.5 w-2.5" />
      ) : step.state === "failed" ? (
        <X className="h-2.5 w-2.5" />
      ) : step.state === "active" ? (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-rvbbit-accent" />
        </span>
      ) : (
        <Clock className="h-2.5 w-2.5" />
      )}
    </div>
  )
}

function Card({
  title,
  tone,
  children,
}: {
  title: string
  tone?: "danger"
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "rounded-md border p-2.5",
        tone === "danger"
          ? "border-danger/40 bg-danger/10"
          : "border-chrome-border/60 bg-secondary-background/40",
      )}
    >
      <div
        className={cn(
          "mb-1 text-[10px] uppercase tracking-wider",
          tone === "danger" ? "text-danger/85" : "text-chrome-text/55",
        )}
      >
        {title}
      </div>
      {children}
    </section>
  )
}

function LogsPanel({ logs }: { logs: unknown }) {
  return (
    <Card title="Agent logs">
      <CodePreview
        code={JSON.stringify(logs, null, 2)}
        lang="json"
        className="max-h-72 rounded border border-chrome-border/40"
      />
    </Card>
  )
}

function ManifestPanel({ manifest }: { manifest: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-md border border-chrome-border/60 bg-secondary-background/40">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wider text-chrome-text/55 hover:text-foreground"
      >
        <Globe className="h-3 w-3" />
        deployment manifest
        <span className="ml-auto font-mono normal-case tracking-normal text-chrome-text/45">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        <CodePreview
          code={JSON.stringify(manifest, null, 2)}
          lang="json"
          className="max-h-96 rounded-b border-t border-chrome-border/40"
        />
      ) : null}
    </section>
  )
}
