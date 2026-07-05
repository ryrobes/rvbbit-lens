"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { usePolling } from "@/lib/desktop/use-polling"
import {
  Activity,
  Brain,
  Clock,
  Cpu,
  Database,
  KeyRound,
  Lock,
  Pause,
  Play,
  Sparkles,
  TerminalSquare,
  Wand2,
} from "@/lib/icons"
import { Sparkline } from "./sparkline"
import { Gauge } from "./gauge"
import { cn } from "@/lib/utils"
import type {
  RvbbitSnapshot,
  ActivityRow,
  PgStatsSnapshot,
  UserTableRow,
} from "@/lib/db/pg-stats"

interface PgMonitorWindowProps {
  activeConnectionId: string | null
  /** False when the monitor's workspace is parked — polling stands
   *  down so a backgrounded monitor doesn't keep hitting the DB. */
  workspaceActive?: boolean
}

const REFRESH_OPTIONS_MS: Array<{ ms: number; label: string }> = [
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
]

const HISTORY_LIMIT = 60

interface HistoryEntry {
  t: number
  snap: PgStatsSnapshot
}

/**
 * btop-style live monitor for the active Postgres connection. One
 * endpoint poll per tick; rates are derived client-side as deltas
 * between successive cumulative samples. Each panel is its own
 * self-contained instrument so the whole window reads like an
 * instrument cluster, not a dashboard.
 */
export function PgMonitorWindow({
  activeConnectionId,
  workspaceActive = true,
}: PgMonitorWindowProps) {
  const [intervalMs, setIntervalMs] = useState<number>(2000)
  const [paused, setPaused] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const ageTickRef = useRef(0)
  const [, forceTick] = useState(0)

  const poll = useCallback(async () => {
    if (!activeConnectionId) return
    try {
      const res = await fetch(
        `/api/db/pg-stats?connectionId=${encodeURIComponent(activeConnectionId)}`,
        { cache: "no-store" },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const snap = (await res.json()) as PgStatsSnapshot
      setError(null)
      setHistory((prev) => {
        const next = [...prev, { t: Date.now(), snap }]
        if (next.length > HISTORY_LIMIT) next.shift()
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [activeConnectionId])

  // In-flight-guarded poll: a slow spell (e.g. a running sync) can't queue a backlog
  // of pg-stats requests that flush in a burst when pressure drops.
  usePolling(poll, intervalMs, {
    enabled: !!activeConnectionId && !paused && workspaceActive,
    resetKey: activeConnectionId,
  })

  // Re-render every ~500ms so "age" displays (query runtime, last
  // vacuum, etc.) tick smoothly without re-fetching.
  useEffect(() => {
    if (!workspaceActive) return
    const id = setInterval(() => {
      ageTickRef.current += 1
      forceTick((t) => t + 1)
    }, 500)
    return () => clearInterval(id)
  }, [workspaceActive])

  const current = history[history.length - 1]?.snap ?? null
  const rates = useMemo(() => computeRates(history), [history])

  if (!activeConnectionId) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-xs text-chrome-text">
        Select a connection to start monitoring.
      </div>
    )
  }

  if (!current) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-xs text-chrome-text">
        <div>
          <Activity className="mx-auto mb-2 h-5 w-5 animate-pulse text-main" />
          Initial poll…
          {error ? <div className="mt-2 text-danger">{error}</div> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-[12px]">
      <HeaderStrip
        snap={current}
        intervalMs={intervalMs}
        paused={paused}
        onIntervalChange={setIntervalMs}
        onTogglePause={() => setPaused((p) => !p)}
        error={error}
      />

      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ThroughputPanel rates={rates} cumulative={current.cumulative} />
          <CachePanel cumulative={current.cumulative} rates={rates} />
          <ConnectionsPanel snap={current} />
          <WalPanel rates={rates} wal={current.wal} />
        </div>

        <TopTablesPanel rows={current.topTables} />
        <ActiveQueriesPanel rows={current.activity.rows} />
        {current.locks.total > 0 ? <LocksPanel locks={current.locks} /> : null}
        {current.rvbbit ? <RvbbitPanel rvbbit={current.rvbbit} rates={rates} /> : null}
      </div>
    </div>
  )
}

// ── HEADER STRIP ───────────────────────────────────────────────────

function HeaderStrip({
  snap,
  intervalMs,
  paused,
  onIntervalChange,
  onTogglePause,
  error,
}: {
  snap: PgStatsSnapshot
  intervalMs: number
  paused: boolean
  onIntervalChange: (ms: number) => void
  onTogglePause: () => void
  error: string | null
}) {
  const uptime = fmtDuration(snap.database.uptime_seconds * 1000)
  const versionShort = (snap.database.version.match(/PostgreSQL (\d+\.\d+)/)?.[0] ?? snap.database.version).slice(0, 24)
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
          paused
            ? "bg-foreground/[0.05] text-chrome-text"
            : "bg-success/10 text-success",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            paused ? "bg-chrome-text" : "bg-success animate-pulse",
          )}
        />
        {paused ? "paused" : "live"}
      </span>
      <span className="flex items-center gap-1.5 text-foreground">
        <Database className="h-3 w-3" />
        <span className="font-mono">{snap.database.name}</span>
      </span>
      <span className="text-chrome-text/70">·</span>
      <span className="text-chrome-text">{versionShort}</span>
      <span className="text-chrome-text/70">·</span>
      <span className="inline-flex items-center gap-1 text-chrome-text">
        <Clock className="h-3 w-3" />
        uptime {uptime}
      </span>
      <span className="text-chrome-text/70">·</span>
      <span className="text-chrome-text">size {snap.database.size_pretty}</span>

      <div className="ml-auto flex items-center gap-1.5">
        {error ? (
          <span className="rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10px] text-danger">
            {error}
          </span>
        ) : null}
        <select
          value={intervalMs}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
          className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          title="Refresh interval"
        >
          {REFRESH_OPTIONS_MS.map((o) => (
            <option key={o.ms} value={o.ms}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onTogglePause}
          title={paused ? "Resume" : "Pause"}
          className="grid h-6 w-6 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground"
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
      </div>
    </div>
  )
}

// ── PANELS ─────────────────────────────────────────────────────────

function Panel({
  icon: Icon,
  title,
  children,
  right,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3", className)}>
      <header className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text">
        <Icon className="h-3 w-3 text-rvbbit-accent" />
        <span>{title}</span>
        <span className="ml-auto flex items-center gap-1 text-chrome-text/60">{right}</span>
      </header>
      {children}
    </section>
  )
}

function ThroughputPanel({
  rates,
  cumulative,
}: {
  rates: Rates
  cumulative: PgStatsSnapshot["cumulative"]
}) {
  return (
    <Panel icon={Activity} title="Throughput" right={<span>tps</span>}>
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-foreground">
            {fmtRate(rates.commits_per_sec)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-chrome-text">commits / s</span>
        </div>
        <Sparkline values={rates.commitSeries} height={36} color="var(--main)" />
        <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] text-chrome-text/80">
          <Stat label="rollbacks/s" value={fmtRate(rates.rollbacks_per_sec)} />
          <Stat label="rows ret/s" value={fmtRate(rates.tup_returned_per_sec)} />
          <Stat label="rows ins/s" value={fmtRate(rates.tup_inserted_per_sec)} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px] text-chrome-text/80">
          <Stat label="upd/s" value={fmtRate(rates.tup_updated_per_sec)} />
          <Stat label="del/s" value={fmtRate(rates.tup_deleted_per_sec)} />
          <Stat label="total commits" value={fmtCount(cumulative.xact_commit)} />
        </div>
      </div>
    </Panel>
  )
}

function CachePanel({
  cumulative,
  rates,
}: {
  cumulative: PgStatsSnapshot["cumulative"]
  rates: Rates
}) {
  const total = cumulative.blks_hit + cumulative.blks_read
  const hitPct = total > 0 ? (cumulative.blks_hit / total) * 100 : 100
  return (
    <Panel icon={Cpu} title="Cache hit ratio" right={<span>shared buffers</span>}>
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-foreground">{hitPct.toFixed(2)}</span>
          <span className="text-[10px] uppercase tracking-wider text-chrome-text">%</span>
          <span className="ml-auto text-[10px] text-chrome-text">
            hit {fmtCount(cumulative.blks_hit)} · read {fmtCount(cumulative.blks_read)}
          </span>
        </div>
        <Gauge value={hitPct} max={100} goodHigh />
        <Sparkline values={rates.blksHitRatioSeries} height={28} yMin={0} yMax={100} color="var(--success)" fillOpacity={0.16} />
        <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] text-chrome-text/80">
          <Stat label="hits/s" value={fmtRate(rates.blks_hit_per_sec)} />
          <Stat label="reads/s" value={fmtRate(rates.blks_read_per_sec)} />
          <Stat label="temp B/s" value={fmtBytes(rates.temp_bytes_per_sec) + "/s"} />
        </div>
      </div>
    </Panel>
  )
}

function ConnectionsPanel({ snap }: { snap: PgStatsSnapshot }) {
  const { activity, database } = snap
  const clientTotal = activity.active + activity.idle + activity.idle_in_transaction
  const cap = Math.max(database.max_connections, clientTotal + 1)
  return (
    <Panel icon={TerminalSquare} title="Connections" right={<span>max {database.max_connections}</span>}>
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-foreground">{clientTotal}</span>
          <span className="text-[10px] uppercase tracking-wider text-chrome-text">clients</span>
          {activity.waiting > 0 ? (
            <span className="ml-auto rounded-full bg-warning/20 px-1.5 py-0 text-[10px] text-warning">
              {activity.waiting} waiting
            </span>
          ) : null}
        </div>
        <Gauge value={clientTotal} max={cap} />
        <div className="grid grid-cols-4 gap-2 pt-1 text-[10px]">
          <PillStat label="active" value={activity.active} color="var(--success)" />
          <PillStat label="idle" value={activity.idle} color="var(--chrome-text)" />
          <PillStat label="idle-tx" value={activity.idle_in_transaction} color="var(--warning)" />
          <PillStat label="waiting" value={activity.waiting} color="var(--danger)" />
        </div>
        {activity.longest_active_ms > 0 ? (
          <div className="pt-1 text-[10px] text-chrome-text">
            longest active query: <span className="font-mono tabular-nums text-foreground">{fmtMs(activity.longest_active_ms)}</span>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

function WalPanel({
  rates,
  wal,
}: {
  rates: Rates
  wal: PgStatsSnapshot["wal"]
}) {
  if (!wal) {
    return (
      <Panel icon={KeyRound} title="WAL">
        <div className="text-[10px] text-chrome-text">pg_stat_wal not available on this server.</div>
      </Panel>
    )
  }
  return (
    <Panel icon={KeyRound} title="WAL" right={<span>bytes / sec</span>}>
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-foreground">
            {fmtBytes(rates.wal_bytes_per_sec)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-chrome-text">/s</span>
          <span className="ml-auto text-[10px] text-chrome-text">total {fmtBytes(wal.wal_bytes)}</span>
        </div>
        <Sparkline values={rates.walBytesSeries} height={36} color="var(--rvbbit-accent)" />
        <div className="grid grid-cols-3 gap-2 pt-1 text-[10px] text-chrome-text/80">
          <Stat label="records/s" value={fmtRate(rates.wal_records_per_sec)} />
          <Stat label="fpi/s" value={fmtRate(rates.wal_fpi_per_sec)} />
          <Stat label="records total" value={fmtCount(wal.wal_records)} />
        </div>
      </div>
    </Panel>
  )
}

function TopTablesPanel({ rows }: { rows: UserTableRow[] }) {
  return (
    <Panel icon={Database} title="Top tables" className="mt-3" right={<span>by total size</span>}>
      <div className="overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/80">
            <tr>
              <th className="px-2 py-1 text-left">schema.table</th>
              <th className="px-2 py-1 text-right">size</th>
              <th className="px-2 py-1 text-right">live</th>
              <th className="px-2 py-1 text-right">dead</th>
              <th className="px-2 py-1 text-right">seq</th>
              <th className="px-2 py-1 text-right">idx</th>
              <th className="px-2 py-1 text-right">ins</th>
              <th className="px-2 py-1 text-right">upd</th>
              <th className="px-2 py-1 text-right">del</th>
              <th className="px-2 py-1 text-right">vacuum</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => {
              const deadRatio = t.n_live_tup + t.n_dead_tup > 0
                ? t.n_dead_tup / (t.n_live_tup + t.n_dead_tup)
                : 0
              const rvbbit = t.schema === "rvbbit" || t.schema === "pg_rvbbit"
              return (
                <tr
                  key={`${t.schema}.${t.table}`}
                  className={cn(
                    "border-t border-chrome-border/30",
                    i % 2 === 1 && "bg-foreground/[0.02]",
                  )}
                >
                  <td className={cn("px-2 py-1 font-mono", rvbbit ? "text-rvbbit-accent" : "text-foreground")}>
                    {t.schema}.<span className="opacity-90">{t.table}</span>
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtBytes(t.size_bytes)}</td>
                  <td className="px-2 py-1 text-right font-mono text-foreground">{fmtCount(t.n_live_tup)}</td>
                  <td className={cn(
                    "px-2 py-1 text-right font-mono",
                    deadRatio > 0.2 ? "text-warning" : deadRatio > 0.5 ? "text-danger" : "text-chrome-text",
                  )}>
                    {fmtCount(t.n_dead_tup)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(t.seq_scan)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(t.idx_scan)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(t.n_tup_ins)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(t.n_tup_upd)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(t.n_tup_del)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text/80">
                    {t.last_vacuum ? fmtAgo(t.last_vacuum) : "—"}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function ActiveQueriesPanel({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <Panel icon={Activity} title="Active queries" className="mt-3">
        <div className="text-[10px] text-chrome-text">No other client backends. The desktop&apos;s pool reuses one connection.</div>
      </Panel>
    )
  }
  return (
    <Panel icon={Activity} title="Active queries" className="mt-3" right={<span>{rows.length} session{rows.length === 1 ? "" : "s"}</span>}>
      <div className="overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/80">
            <tr>
              <th className="px-2 py-1 text-left">pid</th>
              <th className="px-2 py-1 text-left">state</th>
              <th className="px-2 py-1 text-left">app</th>
              <th className="px-2 py-1 text-left">wait</th>
              <th className="px-2 py-1 text-right">runtime</th>
              <th className="px-2 py-1 text-left">query</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.pid}
                className={cn(
                  "border-t border-chrome-border/30 align-top",
                  i % 2 === 1 && "bg-foreground/[0.02]",
                )}
              >
                <td className="px-2 py-1 font-mono text-chrome-text">{r.pid}</td>
                <td className={cn(
                  "px-2 py-1 font-mono",
                  r.state === "active" && "text-success",
                  r.state === "idle in transaction" && "text-warning",
                  r.state === "idle" && "text-chrome-text",
                )}>
                  {r.state ?? "—"}
                </td>
                <td className="px-2 py-1 text-foreground">{r.application_name ?? "—"}</td>
                <td className="px-2 py-1 text-chrome-text">
                  {r.wait_event_type ? `${r.wait_event_type}/${r.wait_event}` : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono text-foreground">
                  {r.query_start_ms_ago != null ? fmtMs(r.query_start_ms_ago) : "—"}
                </td>
                <td className="px-2 py-1 max-w-[480px] truncate font-mono text-chrome-text/80" title={r.query_preview ?? ""}>
                  {r.query_preview ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function LocksPanel({ locks }: { locks: PgStatsSnapshot["locks"] }) {
  return (
    <Panel icon={Lock} title="Locks" className="mt-3" right={<span>{locks.total} total · {locks.waiting} waiting</span>}>
      <div className="flex flex-wrap gap-1">
        {Object.entries(locks.by_mode).map(([mode, count]) => (
          <span
            key={mode}
            className="inline-flex items-center gap-1 rounded-full border border-chrome-border/60 bg-secondary-background px-2 py-0.5 font-mono text-[10px]"
          >
            <span className="text-chrome-text">{mode}</span>
            <span className="text-foreground tabular-nums">{count}</span>
          </span>
        ))}
      </div>
    </Panel>
  )
}

function RvbbitPanel({ rvbbit, rates }: { rvbbit: RvbbitSnapshot; rates: Rates }) {
  return (
    <Panel icon={Sparkles} title="Rvbbit" className="mt-3" right={<span>last 60s · cumulative</span>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-chrome-text">calls / min</div>
          <div className="font-mono text-2xl tabular-nums text-foreground">{rvbbit.recent_calls}</div>
          <Sparkline values={rates.rvbbitCallsSeries} height={24} color="var(--rvbbit-accent)" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-chrome-text">tokens in / out (60s)</div>
          <div className="font-mono text-xl tabular-nums text-foreground">
            {fmtCount(rvbbit.recent_tokens_in)} <span className="text-chrome-text/70">/</span> {fmtCount(rvbbit.recent_tokens_out)}
          </div>
          <div className="text-[10px] text-chrome-text">total {fmtCount(rvbbit.total_tokens_in)} in · {fmtCount(rvbbit.total_tokens_out)} out</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-chrome-text">total cost</div>
          <div className="font-mono text-2xl tabular-nums text-foreground">${rvbbit.total_cost_usd.toFixed(4)}</div>
          <div className="text-[10px] text-chrome-text">{rvbbit.specialist_count} specialists registered</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-chrome-text">cache surfaces</div>
          <div className="font-mono text-[11px] tabular-nums text-foreground">
            receipts <span className="text-rvbbit-accent">{fmtCount(rvbbit.receipts_total)}</span>
          </div>
          <div className="font-mono text-[11px] tabular-nums text-foreground">
            embeddings <span className="text-rvbbit-accent">{fmtCount(rvbbit.embedding_cache_total)}</span>
          </div>
          <div className="font-mono text-[11px] tabular-nums text-foreground">
            bitmaps <span className="text-rvbbit-accent">{fmtCount(rvbbit.bitmap_total)}</span>
          </div>
        </div>
      </div>

      {rvbbit.operators.length > 0 ? (
        <div className="mt-3 overflow-hidden">
          <table className="w-full text-[11px]">
            <thead className="text-[9px] uppercase tracking-wider text-chrome-text/80">
              <tr>
                <th className="px-2 py-1 text-left">operator</th>
                <th className="px-2 py-1 text-left">model</th>
                <th className="px-2 py-1 text-right">calls</th>
                <th className="px-2 py-1 text-right">tokens in</th>
                <th className="px-2 py-1 text-right">tokens out</th>
                <th className="px-2 py-1 text-right">cost</th>
                <th className="px-2 py-1 text-right">avg latency</th>
              </tr>
            </thead>
            <tbody>
              {rvbbit.operators.map((o, i) => (
                <tr key={`${o.operator}:${o.model}:${i}`} className={cn("border-t border-chrome-border/30", i % 2 === 1 && "bg-foreground/[0.02]")}>
                  <td className="px-2 py-1 font-mono text-rvbbit-accent">
                    <span className="inline-flex items-center gap-1"><Wand2 className="h-3 w-3" />{o.operator}</span>
                  </td>
                  <td className="px-2 py-1 font-mono text-chrome-text">{o.model}</td>
                  <td className="px-2 py-1 text-right font-mono text-foreground">{fmtCount(o.calls)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(o.tokens_in)}</td>
                  <td className="px-2 py-1 text-right font-mono text-chrome-text">{fmtCount(o.tokens_out)}</td>
                  <td className="px-2 py-1 text-right font-mono text-foreground">${o.cost_usd.toFixed(4)}</td>
                  <td className="px-2 py-1 text-right font-mono text-foreground">{fmtMs(o.avg_latency_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 text-[10px] text-chrome-text">No LLM calls recorded yet. Run something with <span className="font-mono text-rvbbit-accent">rvbbit.about / means / knn_text</span> to populate.</div>
      )}
    </Panel>
  )
}

// ── small bits ─────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono tabular-nums text-foreground">{value}</div>
      <div className="text-chrome-text/70">{label}</div>
    </div>
  )
}

function PillStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1 font-mono tabular-nums">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        <span className="text-foreground">{value}</span>
      </span>
      <span className="text-chrome-text/70">{label}</span>
    </div>
  )
}

// ── rate calculation ───────────────────────────────────────────────

interface Rates {
  commits_per_sec: number
  rollbacks_per_sec: number
  tup_returned_per_sec: number
  tup_inserted_per_sec: number
  tup_updated_per_sec: number
  tup_deleted_per_sec: number
  blks_hit_per_sec: number
  blks_read_per_sec: number
  temp_bytes_per_sec: number
  wal_bytes_per_sec: number
  wal_records_per_sec: number
  wal_fpi_per_sec: number
  // sparkline series — same length as history
  commitSeries: number[]
  blksHitRatioSeries: number[]
  walBytesSeries: number[]
  rvbbitCallsSeries: number[]
}

function computeRates(history: HistoryEntry[]): Rates {
  const cs: number[] = []
  const ch: number[] = []
  const wb: number[] = []
  const ac: number[] = []
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1]
    const curr = history[i]
    const dt = Math.max(0.001, (curr.t - prev.t) / 1000)
    cs.push(Math.max(0, (curr.snap.cumulative.xact_commit - prev.snap.cumulative.xact_commit) / dt))
    const blksDelta = (curr.snap.cumulative.blks_hit + curr.snap.cumulative.blks_read)
      - (prev.snap.cumulative.blks_hit + prev.snap.cumulative.blks_read)
    const hitsDelta = curr.snap.cumulative.blks_hit - prev.snap.cumulative.blks_hit
    ch.push(blksDelta > 0 ? (hitsDelta / blksDelta) * 100 : 100)
    const walDelta = (curr.snap.wal?.wal_bytes ?? 0) - (prev.snap.wal?.wal_bytes ?? 0)
    wb.push(Math.max(0, walDelta / dt))
    if (curr.snap.rvbbit && prev.snap.rvbbit) {
      ac.push(Math.max(0, curr.snap.rvbbit.total_calls - prev.snap.rvbbit.total_calls))
    } else {
      ac.push(0)
    }
  }

  // For the headline numbers, average the last ~5 deltas so a single
  // spike doesn't dominate the display.
  const last = (arr: number[], n = 5) => {
    if (arr.length === 0) return 0
    const slice = arr.slice(-n)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  }

  const recent = history.slice(-2)
  const recentDeltaPerSec = (key: keyof PgStatsSnapshot["cumulative"]): number => {
    if (recent.length < 2) return 0
    const dt = Math.max(0.001, (recent[1].t - recent[0].t) / 1000)
    return Math.max(0, (Number(recent[1].snap.cumulative[key]) - Number(recent[0].snap.cumulative[key])) / dt)
  }

  return {
    commits_per_sec: last(cs),
    rollbacks_per_sec: recentDeltaPerSec("xact_rollback"),
    tup_returned_per_sec: recentDeltaPerSec("tup_returned"),
    tup_inserted_per_sec: recentDeltaPerSec("tup_inserted"),
    tup_updated_per_sec: recentDeltaPerSec("tup_updated"),
    tup_deleted_per_sec: recentDeltaPerSec("tup_deleted"),
    blks_hit_per_sec: recentDeltaPerSec("blks_hit"),
    blks_read_per_sec: recentDeltaPerSec("blks_read"),
    temp_bytes_per_sec: recentDeltaPerSec("temp_bytes"),
    wal_bytes_per_sec: last(wb),
    wal_records_per_sec: (() => {
      if (recent.length < 2 || !recent[0].snap.wal || !recent[1].snap.wal) return 0
      const dt = Math.max(0.001, (recent[1].t - recent[0].t) / 1000)
      return Math.max(0, (recent[1].snap.wal.wal_records - recent[0].snap.wal.wal_records) / dt)
    })(),
    wal_fpi_per_sec: (() => {
      if (recent.length < 2 || !recent[0].snap.wal || !recent[1].snap.wal) return 0
      const dt = Math.max(0.001, (recent[1].t - recent[0].t) / 1000)
      return Math.max(0, (recent[1].snap.wal.wal_fpi - recent[0].snap.wal.wal_fpi) / dt)
    })(),
    commitSeries: cs,
    blksHitRatioSeries: ch,
    walBytesSeries: wb,
    rvbbitCallsSeries: ac,
  }
}

// ── formatters ─────────────────────────────────────────────────────

function fmtRate(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  if (n >= 1) return n.toFixed(2)
  return n.toFixed(3)
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0"
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let val = n
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i += 1 }
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[i]}`
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "0"
  if (ms < 1) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`
}

function fmtDuration(ms: number): string {
  return fmtMs(ms)
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const dt = Date.now() - t
  return fmtDuration(dt) + " ago"
}
