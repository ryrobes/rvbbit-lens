"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import {
  AlertTriangle,
  CheckCircle2,
  FlowArrow,
  Pause,
  Play,
  Plus,
  RefreshCw,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchOperators,
  fetchOperatorTraffic,
  type RvbbitOperator,
  type OperatorTraffic,
} from "@/lib/rvbbit/operators"
import { fmtAgo, fmtCount, fmtMs } from "./instruments"

interface OperatorsWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenOperator: (name: string | null) => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "1m" },
]

/**
 * Operator registry — the "finder" for the Studio. Catalog rows joined
 * to the last-24h receipt rollup so the eye can immediately tell which
 * operators are live, which are failing, and which are dormant. Mirrors
 * the Capabilities catalog density.
 */
export function OperatorsWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenOperator,
}: OperatorsWindowProps) {
  const [operators, setOperators] = useState<RvbbitOperator[]>([])
  const [traffic, setTraffic] = useState<OperatorTraffic[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(10_000)
  const workspaceActive = useWorkspaceActive()
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [ops, tx] = await Promise.all([
      fetchOperators(activeConnectionId),
      fetchOperatorTraffic(activeConnectionId),
    ])
    setOperators(ops.operators)
    setTraffic(tx.rows)
    setError(ops.error ?? tx.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [reload])

  useEffect(() => {
    const h = () => void reload()
    window.addEventListener("rvbbit-lens:operators-changed", h)
    return () => window.removeEventListener("rvbbit-lens:operators-changed", h)
  }, [reload])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused || !workspaceActive) return
    const id = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, reload, workspaceActive])

  // ── derive ──
  const trafficByName = useMemo(() => {
    const m = new Map<string, OperatorTraffic>()
    for (const t of traffic) m.set(t.operator, t)
    return m
  }, [traffic])

  const rows = useMemo(() => {
    return [...operators]
      .map((op) => ({ op, t: trafficByName.get(op.name) ?? null }))
      .sort((a, b) => {
        const aCalls = a.t?.n_calls ?? 0
        const bCalls = b.t?.n_calls ?? 0
        if (aCalls !== bCalls) return bCalls - aCalls
        return a.op.name.localeCompare(b.op.name)
      })
  }, [operators, trafficByName])

  const totalCalls = traffic.reduce((s, t) => s + t.n_calls, 0)
  const totalErrors = traffic.reduce((s, t) => s + t.n_errors, 0)
  const busyCount = traffic.filter((t) => t.n_calls > 0).length

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <FlowArrow className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension —
          semantic operators are unavailable.
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
          <FlowArrow className="h-3.5 w-3.5 text-rvbbit-accent" />
          {loading ? "loading…" : `${operators.length} operators`}
        </span>
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium text-rvbbit-accent">{busyCount}</span> active
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(totalCalls)}
              </span>{" "}
              calls (24h)
            </span>
            {totalErrors > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span className="text-danger">{totalErrors} errors</span>
              </>
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
          <button
            type="button"
            onClick={() => onOpenOperator(null)}
            className="inline-flex items-center gap-1 rounded border border-main/40 bg-main/15 px-2 py-0.5 text-[11px] text-main hover:bg-main/25"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && !loading ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            No operators yet. Create one with “New”.
          </div>
        ) : (
          <ul>
            {rows.map(({ op, t }) => (
              <OperatorRow
                key={op.name}
                op={op}
                traffic={t}
                onOpen={() => onOpenOperator(op.name)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── Row ─────────────────────────────────────────────────────────────

function OperatorRow({
  op,
  traffic,
  onOpen,
}: {
  op: RvbbitOperator
  traffic: OperatorTraffic | null
  onOpen: () => void
}) {
  const calls = traffic?.n_calls ?? 0
  const errors = traffic?.n_errors ?? 0
  const errorRate = calls > 0 ? errors / calls : 0
  const tone =
    errorRate >= 0.1
      ? "danger"
      : errorRate > 0
        ? "warning"
        : calls > 0
          ? "active"
          : "idle"

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-start gap-2.5 border-b border-chrome-border/40 px-3 py-2 text-left transition",
          "hover:bg-foreground/[0.04]",
          tone === "danger" ? "border-l-2 border-l-danger/60" : "",
          tone === "warning" ? "border-l-2 border-l-warning/60" : "",
          tone === "active" ? "border-l-2 border-l-rvbbit-accent/60" : "",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[12px] font-medium text-foreground">
              rvbbit.{op.name}
            </span>
            <span className="rounded bg-secondary-background px-1 text-[9px] uppercase tracking-wide text-chrome-text/70">
              {op.shape}
            </span>
            <span className="font-mono text-[10px] text-chrome-text/60">
              → {op.return_type}
            </span>
            {traffic?.last_at ? (
              <span
                className="ml-1 text-[10px] text-chrome-text/45"
                title={new Date(traffic.last_at).toISOString()}
              >
                {fmtAgo(traffic.last_at)}
              </span>
            ) : null}
          </div>
          {op.description ? (
            <div className="mt-0.5 line-clamp-1 text-[11px] text-chrome-text/75">
              {op.description}
            </div>
          ) : null}
        </div>

        {/* traffic + flow chips */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {calls > 0 ? (
            <>
              <TrafficChip
                tone={tone}
                primary={`${fmtCount(calls)} call${calls === 1 ? "" : "s"}`}
                secondary={`p95 ${fmtMs(traffic!.p95_latency_ms)}`}
              />
              {errors > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-medium text-danger ring-1 ring-danger/30">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {errors} err
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-1.5 py-0.5 text-[9px] font-medium text-success ring-1 ring-success/30">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  clean
                </span>
              )}
            </>
          ) : (
            <span className="rounded-full bg-foreground/[0.05] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55 ring-1 ring-chrome-border/40">
              dormant
            </span>
          )}
          {op.steps ? <FlowChip label={`${op.steps.length}-step`} /> : null}
          {op.takes ? (
            <FlowChip
              label={
                op.takes.nodes
                  ? `takes ×${op.takes.nodes.length}`
                  : `takes ×${op.takes.factor ?? 1}`
              }
            />
          ) : null}
          {op.retry ? <FlowChip label="retry" /> : null}
          {op.wards ? <FlowChip label="wards" /> : null}
        </div>
      </button>
    </li>
  )
}

function TrafficChip({
  tone,
  primary,
  secondary,
}: {
  tone: "active" | "warning" | "danger" | "idle"
  primary: string
  secondary: string
}) {
  const cls =
    tone === "danger"
      ? "bg-danger/12 text-danger ring-danger/30"
      : tone === "warning"
        ? "bg-warning/12 text-warning ring-warning/30"
        : "bg-rvbbit-accent/12 text-rvbbit-accent ring-rvbbit-accent/30"
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ring-1",
        cls,
      )}
    >
      <span className="tabular-nums">{primary}</span>
      <span className="text-chrome-text/60">·</span>
      <span className="tabular-nums text-chrome-text/70">{secondary}</span>
    </span>
  )
}

function FlowChip({ label }: { label: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-rvbbit-accent/40 bg-rvbbit-bg/50 px-1.5 py-0.5",
        "text-[9px] font-medium text-rvbbit-accent",
      )}
    >
      {label}
    </span>
  )
}
