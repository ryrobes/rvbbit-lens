"use client"

import { useCallback, useMemo, useState } from "react"

import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  Database,
  LineChart,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
} from "@/lib/icons"
import { usePolling } from "@/lib/desktop/use-polling"
import type {
  PgStatementCatalogRow,
  PgStatementCatalogSnapshot,
} from "@/lib/db/pg-stats"
import { cn } from "@/lib/utils"
import { Sparkline } from "./sparkline"

interface PgQueryExplorerWindowProps {
  activeConnectionId: string | null
  workspaceActive?: boolean
  onOpenQuery: (statement: PgStatementCatalogRow) => void
  onOpenSql: (title: string, sql: string, run: boolean) => void
}

type SortMode = "total" | "mean" | "calls" | "rows" | "max"
type QueryLens = "all" | "notable" | "slow" | "wide"

interface CatalogHistoryEntry {
  at: number
  calls: number
  runtimeMs: number
}

const HISTORY_LIMIT = 120
const POLL_MS = 10_000

/**
 * Historical Query Explorer — an honest pg_stat_statements browser. It treats
 * the extension as a normalized-query aggregate ledger (since stats reset),
 * not as an execution log. Per-instance evidence remains the responsibility of
 * sampled live sessions or a dedicated log/telemetry extension.
 */
export function PgQueryExplorerWindow({
  activeConnectionId,
  workspaceActive = true,
  onOpenQuery,
  onOpenSql,
}: PgQueryExplorerWindowProps) {
  const [snapshot, setSnapshot] = useState<PgStatementCatalogSnapshot | null>(null)
  const [history, setHistory] = useState<CatalogHistoryEntry[]>([])
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortMode>("total")
  const [lens, setLens] = useState<QueryLens>("all")
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const poll = useCallback(async () => {
    if (!activeConnectionId) return
    try {
      const response = await fetch(
        `/api/db/pg-query-explorer?connectionId=${encodeURIComponent(activeConnectionId)}&limit=500`,
        { cache: "no-store" },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? `HTTP ${response.status}`)
        return
      }
      const next = await response.json() as PgStatementCatalogSnapshot
      setSnapshot(next)
      setError(null)
      if (next.available && !next.error) {
        const totals = catalogTotals(next.rows)
        const entry = {
          at: Date.parse(next.timestamp) || Date.now(),
          calls: totals.calls,
          runtimeMs: totals.runtimeMs,
        }
        setHistory((previous) => {
          const last = previous.at(-1)
          if (last && (entry.calls < last.calls || entry.runtimeMs < last.runtimeMs)) return [entry]
          return [...previous.slice(-(HISTORY_LIMIT - 1)), entry]
        })
      } else {
        setHistory([])
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [activeConnectionId])

  usePolling(poll, POLL_MS, {
    enabled: !!activeConnectionId && workspaceActive && !paused,
    resetKey: activeConnectionId,
  })

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = (snapshot?.rows ?? []).filter((row) => {
      if (needle && !`${row.query_id} ${row.query} ${row.users.join(" ")}`.toLowerCase().includes(needle)) return false
      if (lens === "slow") return (row.max_exec_time_ms ?? 0) > 1000
      if (lens === "wide") return rowsPerCall(row) > 10_000
      if (lens === "notable") return isNotable(row)
      return true
    })
    return rows.sort((a, b) => sortValue(b, sort) - sortValue(a, sort))
  }, [snapshot, query, sort, lens])

  if (!activeConnectionId) {
    return <CenteredMessage icon={Database} title="Choose a Postgres connection" detail="The query catalog follows the active SQL Desktop connection." />
  }

  if (!snapshot && !error) {
    return <CenteredMessage icon={Activity} title="Reading statement history" detail="Checking pg_stat_statements and its reset boundary…" pulse />
  }

  const unavailable = snapshot && (!snapshot.available || snapshot.error)
  if (unavailable || (!snapshot && error)) {
    const message = snapshot?.error ?? error
    const preload = !!message?.toLowerCase().includes("shared_preload_libraries")
    return (
      <div className="flex h-full flex-col overflow-hidden text-foreground">
        <ExplorerHeader paused={paused} onTogglePaused={() => setPaused((value) => !value)} onRefresh={() => void poll()} />
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-8 text-center">
          <div className="max-w-xl">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-warning/35 bg-warning/8">
              <AlertTriangle className="h-5 w-5 text-warning" />
            </div>
            <h2 className="mt-4 text-sm font-medium">
              {preload ? "pg_stat_statements needs to be preloaded" : "Install pg_stat_statements to explore query history"}
            </h2>
            <p className="mt-2 text-[11px] leading-relaxed text-chrome-text/60">
              {preload
                ? "The extension objects exist, but PostgreSQL is not collecting statement statistics. Add pg_stat_statements to shared_preload_libraries, restart PostgreSQL, then create the extension in this database."
                : "This explorer reads normalized query counters from pg_stat_statements. Install and preload the extension first; no historical query aggregate can be reconstructed before collection begins."}
            </p>
            {message ? <pre className="mt-3 whitespace-pre-wrap rounded border border-danger/25 bg-danger/5 p-2 text-left font-mono text-[9px] text-danger/70">{message}</pre> : null}
            <button
              type="button"
              onClick={() => onOpenSql("Set up pg_stat_statements", pgssSetupSql(), false)}
              className="mt-4 inline-flex h-7 items-center gap-1.5 rounded border border-warning/40 bg-warning/8 px-2.5 text-[10px] text-warning hover:bg-warning/12"
            >
              <TerminalSquare className="h-3 w-3" />
              Open setup checklist
            </button>
            <p className="mt-4 text-[9px] leading-relaxed text-chrome-text/40">
              For timestamped individual executions, bind logs or plan telemetry such as auto_explain or pg_stat_monitor. pg_stat_statements itself stores aggregates, not a completed-query event log.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const ready = snapshot!
  const totals = catalogTotals(ready.rows)
  const rates = catalogRates(history)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-[11px] text-foreground">
      <ExplorerHeader paused={paused} onTogglePaused={() => setPaused((value) => !value)} onRefresh={() => void poll()} error={error} />

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
        <section className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(135px,1fr))] overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/40">
          <Metric label="normalized queries" value={fmtCount(ready.rows.length)} detail={`${fmtCount(ready.total_entries)} tracked entries`} accent />
          <Metric label="executions" value={fmtCount(totals.calls)} detail="since statistics reset" />
          <Metric label="total query time" value={fmtDuration(totals.runtimeMs)} detail={`${fmtDuration(rates.runtimeMsPerSecond)}/s now`} />
          <Metric label="rows returned" value={fmtCount(totals.rows)} detail="cumulative statement rows" />
          <Metric label="observation boundary" value={fmtShortTimestamp(ready.reset_at)} detail="pg_stat_statements reset" />
        </section>

        <section className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(100%,330px),1fr))] gap-3">
          <Trajectory
            title="Execution rate"
            value={`${fmtRate(rates.callsPerSecond)}/s`}
            detail={`${history.length} explorer samples · collection started before this window`}
            values={rates.callSeries}
            color="var(--rvbbit-accent)"
          />
          <Trajectory
            title="Database time consumed"
            value={`${fmtDuration(rates.runtimeMsPerSecond)}/s`}
            detail="counter deltas while this explorer is open"
            values={rates.runtimeSeries}
            color="var(--warning)"
          />
        </section>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-chrome-border/60 bg-secondary-background/40">
          <div className="shrink-0 border-b border-chrome-border/45 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[10px] font-medium">
                  <Activity className="h-3 w-3 text-rvbbit-accent" />
                  Query history
                </div>
                <div className="text-[8px] text-chrome-text/40">
                  aggregate identities since {fmtTimestamp(ready.reset_at)} · click any row to inspect
                </div>
              </div>
              <label className="relative ml-auto min-w-[220px] max-w-[420px] flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/35" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter normalized SQL, query id, or role"
                  className="h-7 w-full rounded-sm border border-chrome-border/55 bg-background/45 pl-7 pr-2 font-mono text-[9px] outline-none placeholder:text-chrome-text/35 focus:border-rvbbit-accent/55"
                />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {(["all", "notable", "slow", "wide"] as QueryLens[]).map((option) => (
                <TinyToggle key={option} active={lens === option} onClick={() => setLens(option)}>{option}</TinyToggle>
              ))}
              <span className="mx-1 h-3 w-px bg-chrome-border/50" />
              <span className="text-[8px] uppercase tracking-wider text-chrome-text/35">sort</span>
              {(["total", "mean", "calls", "rows", "max"] as SortMode[]).map((option) => (
                <TinyToggle key={option} active={sort === option} onClick={() => setSort(option)}>{option}</TinyToggle>
              ))}
              <span className="ml-auto font-mono text-[8px] text-chrome-text/40">{visibleRows.length}/{ready.rows.length} shown{ready.truncated ? " · source capped" : ""}</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[860px] table-fixed text-[10px]">
              <thead className="sticky top-0 z-10 bg-secondary-background text-[8px] uppercase tracking-wider text-chrome-text/50">
                <tr>
                  <th className="w-[44%] px-3 py-1.5 text-left">normalized query</th>
                  <th className="w-[12%] px-2 py-1.5 text-right">runtime share</th>
                  <th className="w-[10%] px-2 py-1.5 text-right">calls</th>
                  <th className="w-[10%] px-2 py-1.5 text-right">mean</th>
                  <th className="w-[10%] px-2 py-1.5 text-right">max</th>
                  <th className="w-[10%] px-2 py-1.5 text-right">rows / call</th>
                  <th className="w-[4%] px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <StatementRow key={row.query_id} row={row} onOpen={() => onOpenQuery(row)} />
                ))}
              </tbody>
            </table>
            {visibleRows.length === 0 ? (
              <div className="grid h-32 place-items-center font-mono text-[9px] text-chrome-text/40">no query identities match this lens</div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 border-t border-chrome-border/35 px-2.5 py-1.5 text-[8px] text-chrome-text/40">
            <Clock className="h-3 w-3" />
            pg_stat_statements has no per-execution timestamps or plan nodes; “slow” uses recorded max latency and “wide” uses average rows per call.
          </div>
        </section>
      </main>
    </div>
  )
}

function ExplorerHeader({
  paused,
  onTogglePaused,
  onRefresh,
  error,
}: {
  paused: boolean
  onTogglePaused: () => void
  onRefresh: () => void
  error?: string | null
}) {
  return (
    <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rvbbit-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-rvbbit-accent">
        <span className={cn("h-1.5 w-1.5 rounded-full bg-rvbbit-accent", !paused && "animate-pulse")} />
        {paused ? "paused" : "statement history"}
      </span>
      <span className="font-mono text-[10px] text-chrome-text/65">pg_stat_statements</span>
      <span className="text-[9px] text-chrome-text/35">normalized aggregates, not an execution log</span>
      <div className="ml-auto flex items-center gap-1">
        {error ? <span className="max-w-64 truncate text-[9px] text-danger" title={error}>{error}</span> : null}
        <button type="button" onClick={onTogglePaused} title={paused ? "Resume refresh" : "Pause refresh"} className="grid h-6 w-6 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground">
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </button>
        <button type="button" onClick={onRefresh} title="Refresh now" className="grid h-6 w-6 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    </header>
  )
}

function StatementRow({ row, onOpen }: { row: PgStatementCatalogRow; onOpen: () => void }) {
  const slow = (row.max_exec_time_ms ?? 0) > 1000
  const wide = rowsPerCall(row) > 10_000
  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onOpen()
      }}
      title="Open historical query detail"
      className="group cursor-pointer border-t border-chrome-border/25 align-middle outline-none transition-colors hover:bg-rvbbit-accent/[0.055] focus:bg-rvbbit-accent/[0.08]"
    >
      <td className="px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded bg-foreground/[0.045] px-1 font-mono text-[7px] text-chrome-text/45">#{row.query_id}</span>
          <div className="min-w-0">
            <div className="line-clamp-2 break-all font-mono text-[9px] leading-relaxed text-foreground/78">{row.query || "-- query text unavailable"}</div>
            <div className="mt-1 flex items-center gap-1">
              {slow ? <EvidenceBadge tone="warning">slow max</EvidenceBadge> : null}
              {wide ? <EvidenceBadge tone="danger">wide mean</EvidenceBadge> : null}
              {row.users.length > 0 ? <span className="truncate text-[8px] text-chrome-text/35">{row.users.join(", ")}</span> : null}
            </div>
          </div>
        </div>
      </td>
      <td className="relative overflow-hidden px-2 py-2 text-right font-mono">
        <span className="absolute inset-y-1 left-0 bg-rvbbit-accent/[0.075]" style={{ width: `${Math.min(100, row.runtime_share * 100)}%` }} />
        <span className="relative">{(row.runtime_share * 100).toFixed(row.runtime_share >= 0.1 ? 1 : 2)}%</span>
      </td>
      <td className="px-2 py-2 text-right font-mono text-foreground/75">{fmtCount(row.calls)}</td>
      <td className="px-2 py-2 text-right font-mono text-foreground/75">{fmtDuration(row.mean_exec_time_ms)}</td>
      <td className={cn("px-2 py-2 text-right font-mono", slow ? "text-warning" : "text-foreground/75")}>{fmtDuration(row.max_exec_time_ms ?? 0)}</td>
      <td className={cn("px-2 py-2 text-right font-mono", wide ? "text-danger" : "text-foreground/75")}>{fmtCount(rowsPerCall(row))}</td>
      <td className="px-2 py-2 text-right"><ChevronRight className="ml-auto h-3 w-3 text-chrome-text/25 transition-transform group-hover:translate-x-0.5 group-hover:text-rvbbit-accent" /></td>
    </tr>
  )
}

function Trajectory({
  title,
  value,
  detail,
  values,
  color,
}: {
  title: string
  value: string
  detail: string
  values: number[]
  color: string
}) {
  return (
    <section className="rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-wider text-chrome-text/45"><LineChart className="h-3 w-3" />{title}</div>
          <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
          <div className="truncate text-[8px] text-chrome-text/40" title={detail}>{detail}</div>
        </div>
        <div className="w-[52%] min-w-28 self-stretch">
          <Sparkline values={values} height={54} maxPoints={HISTORY_LIMIT} color={color} />
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return (
    <div className="min-w-0 border-r border-chrome-border/35 bg-secondary-background/40 px-3 py-2 last:border-r-0">
      <div className="text-[8px] uppercase tracking-[0.14em] text-chrome-text/42">{label}</div>
      <div className={cn("mt-0.5 truncate font-mono text-base", accent ? "text-rvbbit-accent" : "text-foreground")}>{value}</div>
      <div className="truncate text-[8px] text-chrome-text/40" title={detail}>{detail}</div>
    </div>
  )
}

function TinyToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded-sm px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-chrome-text/45 hover:bg-foreground/[0.05]", active && "bg-rvbbit-accent/10 text-rvbbit-accent")}>{children}</button>
  )
}

function EvidenceBadge({ tone, children }: { tone: "warning" | "danger"; children: React.ReactNode }) {
  return <span className={cn("rounded-sm px-1 py-px text-[7px] uppercase tracking-wider", tone === "warning" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger")}>{children}</span>
}

function CenteredMessage({ icon: Icon, title, detail, pulse = false }: { icon: React.ComponentType<{ className?: string }>; title: string; detail: string; pulse?: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div><Icon className={cn("mx-auto h-6 w-6 text-rvbbit-accent", pulse && "animate-pulse")} /><div className="mt-2 text-sm text-foreground">{title}</div><div className="mt-1 text-[10px] text-chrome-text/50">{detail}</div></div>
    </div>
  )
}

function catalogTotals(rows: PgStatementCatalogRow[]) {
  return rows.reduce((total, row) => ({
    calls: total.calls + row.calls,
    runtimeMs: total.runtimeMs + row.total_exec_time_ms,
    rows: total.rows + row.rows,
  }), { calls: 0, runtimeMs: 0, rows: 0 })
}

function catalogRates(history: CatalogHistoryEntry[]) {
  const calls: number[] = []
  const runtime: number[] = []
  history.forEach((entry, index) => {
    if (index === 0) {
      calls.push(0)
      runtime.push(0)
      return
    }
    const previous = history[index - 1]
    const seconds = Math.max((entry.at - previous.at) / 1000, 0.001)
    calls.push(entry.calls >= previous.calls ? (entry.calls - previous.calls) / seconds : 0)
    runtime.push(entry.runtimeMs >= previous.runtimeMs ? (entry.runtimeMs - previous.runtimeMs) / seconds : 0)
  })
  return {
    callSeries: calls,
    runtimeSeries: runtime,
    callsPerSecond: calls.at(-1) ?? 0,
    runtimeMsPerSecond: runtime.at(-1) ?? 0,
  }
}

function rowsPerCall(row: PgStatementCatalogRow): number {
  return row.calls > 0 ? row.rows / row.calls : 0
}

function isNotable(row: PgStatementCatalogRow): boolean {
  return (row.max_exec_time_ms ?? 0) > 1000 || rowsPerCall(row) > 10_000
}

function sortValue(row: PgStatementCatalogRow, sort: SortMode): number {
  if (sort === "mean") return row.mean_exec_time_ms
  if (sort === "calls") return row.calls
  if (sort === "rows") return rowsPerCall(row)
  if (sort === "max") return row.max_exec_time_ms ?? 0
  return row.total_exec_time_ms
}

function pgssSetupSql(): string {
  return `-- pg_stat_statements requires server configuration and a restart.
-- 1. Add pg_stat_statements to shared_preload_libraries in postgresql.conf.
SHOW shared_preload_libraries;

-- 2. Restart PostgreSQL, then install it in this database as a privileged role.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 3. Confirm collection and its reset boundary.
SELECT * FROM pg_stat_statements_info;
SELECT queryid, calls, total_exec_time, mean_exec_time, rows, query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 50;`
}

function fmtCount(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1)
}

function fmtRate(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—"
  if (ms < 1) return `${Math.round(ms * 1000)}µs`
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

function fmtTimestamp(value: string | null): string {
  if (!value) return "unknown reset"
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) return value
  return timestamp.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function fmtShortTimestamp(value: string | null): string {
  if (!value) return "unknown"
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) return "unknown"
  return timestamp.toLocaleDateString([], { month: "short", day: "numeric" })
}
