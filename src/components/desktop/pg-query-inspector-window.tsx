"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  ClipboardCopy,
  Database,
  Eye,
  Hash,
  LineChart,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "@/lib/icons"
import { usePolling } from "@/lib/desktop/use-polling"
import type { PgQueryInspectorPayload } from "@/lib/desktop/types"
import type {
  ActivityRow,
  PgQueryObservationSnapshot,
  PgQuerySummaryResult,
  PgStatementStats,
} from "@/lib/db/pg-stats"
import { cn } from "@/lib/utils"
import { formatSqlSafe } from "./metric-shared"
import { Sparkline } from "./sparkline"
import { SqlEditor } from "./sql-editor"

interface PgQueryInspectorWindowProps {
  payload: PgQueryInspectorPayload
  workspaceActive?: boolean
  onOpenSql: (title: string, sql: string, run: boolean) => void
}

interface HistoryEntry {
  at: number
  snapshot: PgQueryObservationSnapshot
}

interface ObservedExecution {
  key: string
  pid: number
  applicationName: string | null
  user: string | null
  queryStart: string | null
  firstSeenAt: string
  lastSeenAt: string
}

const HISTORY_LIMIT = 120
const OBSERVED_EXECUTION_LIMIT = 500
const REFRESH_OPTIONS = [
  { value: 1000, label: "1s" },
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
  { value: 10_000, label: "10s" },
]

export function PgQueryInspectorWindow({
  payload,
  workspaceActive = true,
  onOpenSql,
}: PgQueryInspectorWindowProps) {
  const liveActivity = payload.source === "historical" ? null : payload.activity
  const historicalStatement = payload.source === "historical" ? payload.statement : null
  const [intervalMs, setIntervalMs] = useState(2000)
  const [paused, setPaused] = useState(false)
  const [latest, setLatest] = useState<PgQueryObservationSnapshot | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [baseline, setBaseline] = useState<{ calls: number; at: number } | null>(null)
  const [observed, setObserved] = useState<ObservedExecution[]>(() => (
    liveActivity ? [observedFromRow(liveActivity, payload.capturedAt)] : []
  ))
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.parse(payload.capturedAt) || 0)
  const [summaryCapability, setSummaryCapability] = useState<PgQuerySummaryResult | null>(null)
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const targetQueryId = liveActivity?.query_id ?? historicalStatement?.query_id ?? null
  const targetQuery = liveActivity?.query ?? historicalStatement?.query ?? null

  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/db/pg-query-observation", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: payload.connectionId,
          source: historicalStatement ? "historical" : "live",
          pid: liveActivity?.pid ?? null,
          backendStart: liveActivity?.backend_start ?? null,
          queryId: targetQueryId,
          query: targetQuery,
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? `HTTP ${response.status}`)
        return
      }
      const snapshot = await response.json() as PgQueryObservationSnapshot
      const observedAt = Date.parse(snapshot.timestamp) || Date.now()
      setLatest(snapshot)
      setError(null)
      setHistory((previous) => [
        ...previous.slice(-(HISTORY_LIMIT - 1)),
        { at: observedAt, snapshot },
      ])
      setObserved((previous) => mergeObservedExecutions(previous, snapshot.matching_sessions, snapshot.timestamp))
      if (snapshot.statement_stats) {
        setBaseline((previous) => (
          previous == null || snapshot.statement_stats!.calls < previous.calls
            ? { calls: snapshot.statement_stats!.calls, at: observedAt }
            : previous
        ))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [payload.connectionId, historicalStatement, liveActivity, targetQuery, targetQueryId])

  usePolling(poll, intervalMs, {
    enabled: workspaceActive && !paused,
    resetKey: historicalStatement
      ? `${payload.connectionId}:historical:${historicalStatement.query_id}`
      : `${payload.connectionId}:${liveActivity?.pid}:${liveActivity?.backend_start}`,
  })

  useEffect(() => {
    if (!workspaceActive) return
    const timer = window.setInterval(() => setClockNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [workspaceActive])

  useEffect(() => {
    let cancelled = false
    void fetch(`/api/db/pg-query-summary?connectionId=${encodeURIComponent(payload.connectionId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result: PgQuerySummaryResult) => {
        if (!cancelled) setSummaryCapability(result)
      })
      .catch((cause) => {
        if (!cancelled) setSummaryCapability({
          available: false,
          model: null,
          summary: null,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
    return () => {
      cancelled = true
    }
  }, [payload.connectionId, targetQueryId])

  const capturedQuery = targetQuery?.trim() ?? ""
  const formattedQuery = useMemo(
    () => formatSqlSafe(capturedQuery) || "-- Query text is not available to the current role.",
    [capturedQuery],
  )
  const stats = latest?.statement_stats ?? historicalStatement ?? null
  const callsSinceOpen = stats && baseline ? Math.max(0, stats.calls - baseline.calls) : null
  const rateValues = useMemo(() => statementRateValues(history), [history])
  const latencyValues = useMemo(
    () => history.map((entry) => (
      entry.snapshot.statement_stats?.mean_exec_time_ms
        ?? historicalStatement?.mean_exec_time_ms
        ?? 0
    )),
    [history, historicalStatement],
  )
  const concurrencyValues = useMemo(
    () => history.map((entry) => entry.snapshot.matching_sessions.length),
    [history],
  )
  const originalStatus = describeOriginalStatus(liveActivity, latest)

  const generateSummary = useCallback(async () => {
    if (!capturedQuery || summaryLoading) return
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const response = await fetch("/api/db/pg-query-summary", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: payload.connectionId,
          query: capturedQuery,
          stats,
        }),
      })
      const result = await response.json() as PgQuerySummaryResult
      if (!response.ok || result.error) {
        setSummaryError(result.error ?? `HTTP ${response.status}`)
      } else {
        setAiSummary(result.summary)
        setSummaryCapability(result)
      }
    } catch (cause) {
      setSummaryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSummaryLoading(false)
    }
  }, [capturedQuery, payload.connectionId, stats, summaryLoading])

  const copyQuery = useCallback(async () => {
    if (!capturedQuery) return
    try {
      await navigator.clipboard.writeText(capturedQuery)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }, [capturedQuery])

  return (
    <div className="flex h-full flex-col overflow-hidden text-[11px] text-foreground">
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wider",
            originalStatus.tone === "success" && "bg-success/10 text-success",
            originalStatus.tone === "warning" && "bg-warning/10 text-warning",
            originalStatus.tone === "muted" && "bg-foreground/[0.05] text-chrome-text",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", originalStatus.dotClass)} />
          {originalStatus.label}
        </span>
        <span className="inline-flex items-center gap-1 font-mono text-chrome-text/80">
          <Hash className="h-3 w-3" />
          {targetQueryId ?? (liveActivity ? `pid ${liveActivity.pid}` : "query identity unavailable")}
        </span>
        <span className="text-chrome-text/35">·</span>
        <span className="truncate text-chrome-text/65">
          {historicalStatement ? "aggregate opened" : "captured"} {fmtTimestamp(payload.capturedAt)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {error ? (
            <span className="max-w-64 truncate rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[9px] text-danger" title={error}>
              {error}
            </span>
          ) : null}
          <select
            value={intervalMs}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
            className="h-6 rounded border border-chrome-border bg-secondary-background px-1 text-[10px] text-foreground outline-none"
            title="Observation interval"
          >
            {REFRESH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground"
            title={paused ? "Resume observation" : "Pause observation"}
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => void poll()}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground"
            title="Refresh now"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-3">
        <AiSummaryPanel
          capability={summaryCapability}
          summary={aiSummary}
          error={summaryError}
          loading={summaryLoading}
          queryAvailable={!!capturedQuery}
          onGenerate={() => void generateSummary()}
        />

        <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard
            label="query latency"
            value={stats ? fmtMs(stats.mean_exec_time_ms) : "—"}
            detail={stats
              ? `${stats.min_exec_time_ms == null ? "—" : fmtMs(stats.min_exec_time_ms)} – ${stats.max_exec_time_ms == null ? "—" : fmtMs(stats.max_exec_time_ms)} range`
              : "pg_stat_statements unavailable"}
            accent
          />
          <MetricCard
            label="total query time"
            value={stats ? fmtMs(stats.total_exec_time_ms) : "—"}
            detail={stats ? "cumulative execution time" : "extension data unavailable"}
          />
          <MetricCard
            label="index usage"
            value="—"
            detail="plans are not retained by pg_stat_statements"
          />
          <MetricCard
            label="calls"
            value={stats ? fmtCount(stats.calls) : "—"}
            detail={callsSinceOpen == null ? "since stats reset" : `${fmtCount(callsSinceOpen)} since opened`}
          />
          <MetricCard
            label="rows returned"
            value={stats ? fmtCount(stats.rows) : "—"}
            detail={stats && stats.calls > 0 ? `${fmtCount(stats.rows / stats.calls)} per call` : "no cumulative rows"}
          />
          <MetricCard
            label="active now"
            value={String(latest?.matching_sessions.length ?? 0)}
            detail={`${fmtCount(observed.length)} sampled execution${observed.length === 1 ? "" : "s"}`}
            tone={(latest?.matching_sessions.length ?? 0) > 0 ? "success" : undefined}
          />
        </section>

        <section className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
          <Panel title={stats ? "Observed query telemetry" : "Observed concurrency"} icon={LineChart}>
            {stats ? (
              <div className="grid grid-cols-2 gap-3">
                <TelemetryStrip
                  label="mean latency"
                  value={fmtMs(stats.mean_exec_time_ms)}
                  values={latencyValues}
                  color="var(--warning)"
                />
                <TelemetryStrip
                  label="calls / min"
                  value={fmtRate(rateValues.at(-1) ?? 0)}
                  values={rateValues}
                  color="var(--rvbbit-accent)"
                />
              </div>
            ) : (
              <div className="flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <Sparkline values={concurrencyValues} height={52} maxPoints={HISTORY_LIMIT} color="var(--rvbbit-accent)" />
                </div>
                <div className="w-24 shrink-0 text-right">
                  <div className="font-mono text-lg text-foreground">{String(latest?.matching_sessions.length ?? 0)}</div>
                  <div className="text-[8px] uppercase tracking-wider text-chrome-text/45">running now</div>
                </div>
              </div>
            )}
            <div className="mt-1 text-[9px] text-chrome-text/45">
              {history.length} live sample{history.length === 1 ? "" : "s"}; {historicalStatement
                ? "this trajectory begins when the detail window opens—the aggregate counters began earlier."
                : "the window keeps the captured query even after its original backend ends."}
            </div>
          </Panel>

          {liveActivity ? (
            <Panel title="Live identity" icon={Database}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <CompactMeta label="database" value={liveActivity.datname ?? "—"} />
                <CompactMeta label="user" value={liveActivity.usename ?? "—"} />
                <CompactMeta label="application" value={liveActivity.application_name ?? "—"} />
                <CompactMeta label="client" value={clientLabel(liveActivity)} />
                <CompactMeta label="captured pid" value={String(liveActivity.pid)} mono />
                <CompactMeta label="match" value={matchModeLabel(latest?.match_mode)} />
                <CompactMeta label="query started" value={fmtTimestamp(liveActivity.query_start)} />
                <CompactMeta label="backend started" value={fmtTimestamp(liveActivity.backend_start)} />
              </div>
            </Panel>
          ) : (
            <Panel title="Historical identity" icon={Database}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <CompactMeta label="query id" value={historicalStatement?.query_id ?? "—"} mono />
                <CompactMeta label="roles" value={historicalStatement?.users.join(", ") || "—"} />
                <CompactMeta label="scope" value={historicalStatement?.toplevel === false ? "nested statement" : "top-level statement"} />
                <CompactMeta label="match" value={matchModeLabel(latest?.match_mode)} />
                <CompactMeta label="stats since" value={fmtTimestamp(historicalStatement?.stats_since ?? null)} />
                <CompactMeta label="min/max since" value={fmtTimestamp(historicalStatement?.minmax_stats_since ?? null)} />
                <CompactMeta label="reset boundary" value={fmtTimestamp(latest?.pg_stat_statements_reset ?? null)} />
                <CompactMeta label="provenance" value="pg_stat_statements aggregate" />
              </div>
            </Panel>
          )}
        </section>

        {liveActivity ? <CapturedSessionPanel row={liveActivity} /> : null}

        <Panel title={historicalStatement ? "Normalized SQL" : "Captured SQL"} icon={TerminalSquare} className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <ActionButton icon={ClipboardCopy} label={copied ? "Copied" : "Copy SQL"} disabled={!capturedQuery} onClick={() => void copyQuery()} />
            <ActionButton icon={TerminalSquare} label="Open SQL" disabled={!capturedQuery} onClick={() => onOpenSql(historicalStatement ? `Historical query #${historicalStatement.query_id}` : `Query from pid ${liveActivity?.pid}`, capturedQuery, false)} />
            <ActionButton icon={LineChart} label="Explain" disabled={!capturedQuery} onClick={() => openExplainSql(capturedQuery, historicalStatement ? `query #${historicalStatement.query_id}` : `pid ${liveActivity?.pid}`, onOpenSql)} />
            {liveActivity ? <ActionButton icon={Eye} label="Inspect captured session" onClick={() => openSessionInspectSql(liveActivity, onOpenSql)} /> : null}
            {liveActivity ? <ActionButton icon={AlertTriangle} label="Cancel captured query" tone="warning" onClick={() => openActivitySignalSql("cancel", liveActivity, onOpenSql)} /> : null}
            {liveActivity ? <ActionButton icon={Wrench} label="Terminate captured session" tone="danger" onClick={() => openActivitySignalSql("terminate", liveActivity, onOpenSql)} /> : null}
          </div>
          <div className="h-52 overflow-hidden rounded border border-chrome-border/55 bg-background/45">
            <SqlEditor
              value={formattedQuery}
              onChange={() => undefined}
              readOnly
              autoFocus={false}
              wrap
              fontSize={11}
              height="100%"
            />
          </div>
        </Panel>

        {stats ? <StatementStatsPanel stats={stats} resetAt={latest?.pg_stat_statements_reset ?? null} /> : (
          <Panel title="Statement history" icon={Activity} className="mt-3">
            <div className="text-[10px] text-chrome-text/65">
              {statementStatsHint(latest)} The live observer will still count executions that remain visible during a polling sample.
            </div>
          </Panel>
        )}

        {stats ? <NotableEvidencePanel stats={stats} /> : null}

        <Panel
          title="Matching executions"
          icon={Activity}
          className="mt-3"
          right={<span>{latest?.matching_sessions.length ?? 0} active · {observed.length} sampled</span>}
        >
          <MatchingExecutions rows={latest?.matching_sessions ?? []} clockNow={clockNow} onOpenSql={onOpenSql} />
        </Panel>
      </main>
    </div>
  )
}

function CapturedSessionPanel({ row }: { row: ActivityRow }) {
  const wait = row.wait_event_type
    ? `${row.wait_event_type}/${row.wait_event ?? "unknown"}`
    : "none"
  return (
    <Panel title="Captured session metadata" icon={Eye} className="mt-3">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-chrome-border/40 bg-chrome-border/30 md:grid-cols-5">
        <StatCell label="state" value={row.state ?? "—"} />
        <StatCell label="query age" value={row.query_start_ms_ago == null ? "—" : fmtMs(row.query_start_ms_ago)} />
        <StatCell label="transaction age" value={row.xact_start_ms_ago == null ? "—" : fmtMs(row.xact_start_ms_ago)} />
        <StatCell label="wait" value={wait} />
        <StatCell label="state changed" value={fmtTimestamp(row.state_change)} />
        <StatCell label="transaction started" value={fmtTimestamp(row.xact_start)} />
        <StatCell label="query id" value={row.query_id ?? "—"} />
        <StatCell label="leader pid" value={row.leader_pid == null ? "—" : String(row.leader_pid)} />
        <StatCell label="backend xid" value={row.backend_xid ?? "—"} />
        <StatCell label="backend xmin" value={row.backend_xmin ?? "—"} />
      </div>
    </Panel>
  )
}

function AiSummaryPanel({
  capability,
  summary,
  error,
  loading,
  queryAvailable,
  onGenerate,
}: {
  capability: PgQuerySummaryResult | null
  summary: string | null
  error: string | null
  loading: boolean
  queryAvailable: boolean
  onGenerate: () => void
}) {
  return (
    <section className="mb-3 overflow-hidden rounded-md border border-rvbbit-accent/30 bg-secondary-background/40">
      <header className="flex min-h-9 items-center gap-2 border-b border-rvbbit-accent/15 px-3 py-1.5">
        <div className="grid h-6 w-6 place-items-center rounded-sm border border-rvbbit-accent/30 bg-rvbbit-accent/8">
          <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-rvbbit-accent">AI query summary</div>
          <div className="font-mono text-[8px] text-chrome-text/40">
            {capability?.model ? `General Semantic · ${capability.model}` : "user-configured General Semantic model"}
          </div>
        </div>
        {capability?.available ? (
          <button
            type="button"
            disabled={!queryAvailable || loading}
            onClick={onGenerate}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-rvbbit-accent/35 bg-rvbbit-accent/8 px-2 text-[9px] text-rvbbit-accent transition hover:bg-rvbbit-accent/12 disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {summary ? "Regenerate" : loading ? "Summarizing…" : "Generate summary"}
          </button>
        ) : null}
      </header>
      <div className="px-3 py-2.5">
        {summary ? (
          <p className="text-[11px] leading-relaxed text-foreground/80">{summary}</p>
        ) : error || capability?.error ? (
          <p className="font-mono text-[9px] text-danger/75">{error ?? capability?.error}</p>
        ) : capability == null ? (
          <div className="flex items-center gap-1.5 text-[9px] text-chrome-text/45"><Loader2 className="h-3 w-3 animate-spin" /> checking configured model…</div>
        ) : capability.available ? (
          <p className="text-[9px] text-chrome-text/50">Generate a one-sentence explanation using the configured model. This is an explicit action because semantic operators may be metered.</p>
        ) : (
          <p className="text-[9px] text-chrome-text/50">No General Semantic summarizer is configured on this connection. Configure the <span className="font-mono">summarize</span> operator in Model Settings to enable this panel.</p>
        )}
      </div>
    </section>
  )
}

function NotableEvidencePanel({ stats }: { stats: PgStatementStats }) {
  const meanRows = stats.calls > 0 ? stats.rows / stats.calls : 0
  const slow = (stats.max_exec_time_ms ?? 0) > 1000
  const wide = meanRows > 10_000
  return (
    <Panel
      title="Notable evidence"
      icon={AlertTriangle}
      className="mt-3"
      right={<span>thresholds · 1s / 10k rows</span>}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2">
        <EvidenceCard
          notable={slow}
          label="slow execution"
          value={stats.max_exec_time_ms == null ? "not recorded" : `max ${fmtMs(stats.max_exec_time_ms)}`}
          detail={slow
            ? "At least one execution crossed 1 second; pg_stat_statements does not retain when it happened."
            : "No recorded maximum above 1 second in the current aggregate window."}
        />
        <EvidenceCard
          notable={wide}
          label="wide result"
          value={`${fmtCount(meanRows)} rows / call`}
          detail={wide
            ? "The average execution returned more than 10k rows, so at least one execution crossed that threshold."
            : "Average rows per call is below 10k; individual row-count outliers are not retained."}
        />
        <EvidenceCard
          label="index-backed calls"
          value="not recorded"
          detail="Index-use percentage requires per-execution plan telemetry such as auto_explain or pg_stat_monitor. Block counters are not a safe proxy."
        />
      </div>
    </Panel>
  )
}

function EvidenceCard({
  notable = false,
  label,
  value,
  detail,
}: {
  notable?: boolean
  label: string
  value: string
  detail: string
}) {
  return (
    <div className={cn("rounded-md border px-2.5 py-2", notable ? "border-warning/35 bg-warning/[0.06]" : "border-chrome-border/60 bg-secondary-background/40")}>
      <div className={cn("text-[8px] uppercase tracking-wider", notable ? "text-warning" : "text-chrome-text/40")}>{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm", notable ? "text-warning" : "text-foreground/75")}>{value}</div>
      <p className="mt-1 text-[8px] leading-relaxed text-chrome-text/45">{detail}</p>
    </div>
  )
}

function MetricCard({
  label,
  value,
  detail,
  accent = false,
  tone,
}: {
  label: string
  value: string
  detail: string
  accent?: boolean
  tone?: "success"
}) {
  return (
    <div className="rounded-md border border-chrome-border/60 bg-secondary-background/40 px-2.5 py-2">
      <div className="text-[8px] uppercase tracking-[0.16em] text-chrome-text/45">{label}</div>
      <div className={cn("mt-0.5 font-mono text-lg leading-tight", accent && "text-rvbbit-accent", tone === "success" && "text-success")}>
        {value}
      </div>
      <div className="mt-1 truncate text-[9px] text-chrome-text/45" title={detail}>{detail}</div>
    </div>
  )
}

function Panel({
  title,
  icon: Icon,
  children,
  className,
  right,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  className?: string
  right?: React.ReactNode
}) {
  return (
    <section className={cn("rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3", className)}>
      <header className="mb-2 flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-chrome-text/65">
        <Icon className="h-3 w-3 text-rvbbit-accent" />
        <span>{title}</span>
        {right ? <span className="ml-auto text-chrome-text/45">{right}</span> : null}
      </header>
      {children}
    </section>
  )
}

function CompactMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] uppercase tracking-wider text-chrome-text/40">{label}</div>
      <div className={cn("truncate text-[10px] text-foreground/85", mono && "font-mono")} title={value}>{value}</div>
    </div>
  )
}

function TelemetryStrip({
  label,
  value,
  values,
  color,
}: {
  label: string
  value: string
  values: number[]
  color: string
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[8px] uppercase tracking-wider text-chrome-text/40">{label}</span>
        <span className="font-mono text-sm text-foreground">{value}</span>
      </div>
      <Sparkline values={values} height={42} maxPoints={HISTORY_LIMIT} color={color} />
    </div>
  )
}

function StatementStatsPanel({ stats, resetAt }: { stats: PgStatementStats; resetAt: string | null }) {
  const hitTotal = stats.shared_blks_hit + stats.shared_blks_read
  const hitRatio = hitTotal > 0 ? stats.shared_blks_hit / hitTotal : null
  return (
    <Panel title="pg_stat_statements" icon={Activity} className="mt-3" right={<span>reset {fmtTimestamp(resetAt)}</span>}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(105px,1fr))] gap-px overflow-hidden rounded border border-chrome-border/40 bg-chrome-border/30">
        <StatCell label="total runtime" value={fmtMs(stats.total_exec_time_ms)} />
        <StatCell label="min runtime" value={stats.min_exec_time_ms == null ? "—" : fmtMs(stats.min_exec_time_ms)} />
        <StatCell label="max runtime" value={stats.max_exec_time_ms == null ? "—" : fmtMs(stats.max_exec_time_ms)} />
        <StatCell label="runtime σ" value={fmtMs(stats.stddev_exec_time_ms)} />
        <StatCell label="planning" value={fmtMs(stats.total_plan_time_ms)} />
        <StatCell label="cache hit" value={hitRatio == null ? "—" : `${(hitRatio * 100).toFixed(1)}%`} />
        <StatCell label="blocks read" value={fmtCount(stats.shared_blks_read)} />
        <StatCell label="temp blocks" value={fmtCount(stats.temp_blks_read + stats.temp_blks_written)} />
        <StatCell label="WAL" value={fmtBytes(stats.wal_bytes)} />
      </div>
    </Panel>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary-background/90 px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-wider text-chrome-text/40">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-foreground/85" title={value}>{value}</div>
    </div>
  )
}

function MatchingExecutions({
  rows,
  clockNow,
  onOpenSql,
}: {
  rows: ActivityRow[]
  clockNow: number
  onOpenSql: (title: string, sql: string, run: boolean) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-chrome-border/55 px-3 py-4 text-center text-[10px] text-chrome-text/55">
        No matching query is running right now. This inspector remains pinned and continues watching.
      </div>
    )
  }
  return (
    <div className="max-h-48 overflow-auto rounded border border-chrome-border/40">
      <table className="w-full text-[10px]">
        <thead className="sticky top-0 z-10 bg-secondary-background text-[8px] uppercase tracking-wider text-chrome-text/55">
          <tr>
            <th className="px-2 py-1 text-left">pid</th>
            <th className="px-2 py-1 text-left">user / app</th>
            <th className="px-2 py-1 text-left">wait</th>
            <th className="px-2 py-1 text-right">runtime</th>
            <th className="px-2 py-1 text-right">actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={executionKey(row)} className="border-t border-chrome-border/30">
              <td className="px-2 py-1 font-mono text-foreground">{row.pid}</td>
              <td className="px-2 py-1">
                <div className="text-foreground/85">{row.usename ?? "—"}</div>
                <div className="max-w-56 truncate text-[9px] text-chrome-text/45">{row.application_name ?? "—"}</div>
              </td>
              <td className="px-2 py-1 text-chrome-text/65">
                {row.wait_event_type ? `${row.wait_event_type}/${row.wait_event ?? "unknown"}` : "—"}
              </td>
              <td className="px-2 py-1 text-right font-mono">{activityAge(row.query_start, row.query_start_ms_ago, clockNow)}</td>
              <td className="px-2 py-1">
                <div className="flex justify-end gap-1">
                  <MiniAction label="Inspect" icon={Eye} onClick={() => openSessionInspectSql(row, onOpenSql)} />
                  <MiniAction label="Cancel" icon={AlertTriangle} tone="warning" onClick={() => openActivitySignalSql("cancel", row, onOpenSql)} />
                  <MiniAction label="Terminate" icon={Wrench} tone="danger" onClick={() => openActivitySignalSql("terminate", row, onOpenSql)} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  tone = "default",
  disabled = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  tone?: "default" | "warning" | "danger"
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[9px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "border-danger/40 bg-danger/10 text-danger hover:bg-danger/15"
          : tone === "warning"
            ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/15"
            : "border-chrome-border/60 bg-foreground/[0.04] text-chrome-text hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  )
}

function MiniAction({
  label,
  icon: Icon,
  onClick,
  tone = "default",
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  tone?: "default" | "warning" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "grid h-5 w-5 place-items-center rounded border border-chrome-border/45 text-chrome-text hover:bg-foreground/[0.07] hover:text-foreground",
        tone === "warning" && "border-warning/35 text-warning",
        tone === "danger" && "border-danger/35 text-danger",
      )}
    >
      <Icon className="h-2.5 w-2.5" />
    </button>
  )
}

function observedFromRow(row: ActivityRow, observedAt: string): ObservedExecution {
  return {
    key: executionKey(row),
    pid: row.pid,
    applicationName: row.application_name,
    user: row.usename,
    queryStart: row.query_start,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
  }
}

function mergeObservedExecutions(
  previous: ObservedExecution[],
  rows: ActivityRow[],
  observedAt: string,
): ObservedExecution[] {
  const byKey = new Map(previous.map((execution) => [execution.key, execution]))
  for (const row of rows) {
    const key = executionKey(row)
    const existing = byKey.get(key)
    byKey.set(key, existing
      ? { ...existing, lastSeenAt: observedAt }
      : observedFromRow(row, observedAt))
  }
  return [...byKey.values()]
    .sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
    .slice(0, OBSERVED_EXECUTION_LIMIT)
}

function executionKey(row: ActivityRow): string {
  return `${row.pid}:${row.backend_start}:${row.query_start ?? "unknown"}`
}

function statementRateValues(history: HistoryEntry[]): number[] {
  return history.map((entry, index) => {
    if (index === 0) return 0
    const previous = history[index - 1]
    const calls = entry.snapshot.statement_stats?.calls
    const previousCalls = previous.snapshot.statement_stats?.calls
    if (calls == null || previousCalls == null || calls < previousCalls) return 0
    const minutes = Math.max((entry.at - previous.at) / 60_000, 1 / 6000)
    return (calls - previousCalls) / minutes
  })
}

function describeOriginalStatus(
  captured: ActivityRow | null,
  latest: PgQueryObservationSnapshot | null,
): { label: string; tone: "success" | "warning" | "muted"; dotClass: string } {
  if (!captured) return { label: "historical aggregate", tone: "muted", dotClass: "bg-rvbbit-accent" }
  if (!latest) return { label: "connecting", tone: "muted", dotClass: "bg-chrome-text animate-pulse" }
  const original = latest.original_session
  if (!original) return { label: "original ended", tone: "muted", dotClass: "bg-chrome-text/60" }
  if (original.query_start !== captured.query_start) {
    return { label: "session moved on", tone: "warning", dotClass: "bg-warning" }
  }
  if (original.state === "active") {
    return { label: "original running", tone: "success", dotClass: "bg-success animate-pulse" }
  }
  return { label: "query finished", tone: "muted", dotClass: "bg-chrome-text/60" }
}

function statementStatsHint(snapshot: PgQueryObservationSnapshot | null): string {
  if (!snapshot) return "Checking pg_stat_statements."
  if (!snapshot.pg_stat_statements_available) return "pg_stat_statements is not installed on this connection."
  if (snapshot.statement_stats_error) return `pg_stat_statements could not be read: ${snapshot.statement_stats_error}`
  if (snapshot.match_mode !== "query_id") return "This query has no query_id, so cumulative statement counters cannot be linked safely."
  return "No pg_stat_statements entry exists for this query yet."
}

function matchModeLabel(mode: PgQueryObservationSnapshot["match_mode"] | undefined): string {
  if (mode === "query_id") return "query_id"
  if (mode === "normalized_sql") return "normalized SQL"
  if (mode === "unavailable") return "unavailable"
  return "checking"
}

function clientLabel(row: ActivityRow): string {
  if (!row.client_addr) return "local"
  return `${row.client_addr}${row.client_port == null ? "" : `:${row.client_port}`}`
}

function activityAge(iso: string | null, fallbackMs: number | null, now: number): string {
  const startedAt = iso ? new Date(iso).getTime() : Number.NaN
  const elapsed = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : fallbackMs
  return elapsed == null ? "—" : fmtMs(elapsed)
}

function fmtTimestamp(iso: string | null): string {
  if (!iso) return "—"
  const timestamp = new Date(iso)
  if (!Number.isFinite(timestamp.getTime())) return iso
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function fmtCount(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  if (!Number.isInteger(value)) return value.toFixed(value < 10 ? 2 : 1)
  return String(value)
}

function fmtRate(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—"
  if (ms < 1) return `${Math.round(ms * 1000)}µs`
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function openExplainSql(
  query: string,
  sourceLabel: string,
  onOpenSql: (title: string, sql: string, run: boolean) => void,
) {
  const normalized = query.trim()
  if (!normalized) return
  onOpenSql(
    `Explain query · ${sourceLabel}`,
    `-- Review before running. EXPLAIN plans the statement but does not execute it.\n-- Normalized historical queries may contain parameter placeholders that need concrete values.\nEXPLAIN (VERBOSE, COSTS, SETTINGS, FORMAT TEXT)\n${normalized}`,
    false,
  )
}

function openSessionInspectSql(
  row: ActivityRow,
  onOpenSql: (title: string, sql: string, run: boolean) => void,
) {
  const started = sqlLiteral(row.backend_start)
  const sql = `-- Live session details, guarded against PID reuse.
SELECT
  a.pid,
  a.datname,
  a.usename,
  a.application_name,
  a.client_addr,
  a.client_port,
  a.backend_start,
  a.xact_start,
  a.query_start,
  a.state_change,
  a.state,
  a.wait_event_type,
  a.wait_event,
  a.backend_xid,
  a.backend_xmin,
  a.query_id,
  pg_blocking_pids(a.pid) AS blocking_pids,
  (
    SELECT coalesce(
      jsonb_agg(jsonb_build_object(
        'locktype', l.locktype,
        'mode', l.mode,
        'granted', l.granted,
        'relation', l.relation,
        'page', l.page,
        'tuple', l.tuple,
        'transactionid', l.transactionid,
        'virtualxid', l.virtualxid
      ) ORDER BY l.granted, l.locktype, l.mode),
      '[]'::jsonb
    )
    FROM pg_locks l
    WHERE l.pid = a.pid
  ) AS locks,
  a.query
FROM pg_stat_activity a
WHERE a.pid = ${row.pid}
  AND a.backend_start = ${started}::timestamptz;`
  onOpenSql(`Inspect session ${row.pid}`, sql, true)
}

function openActivitySignalSql(
  kind: "cancel" | "terminate",
  row: ActivityRow,
  onOpenSql: (title: string, sql: string, run: boolean) => void,
) {
  const fn = kind === "cancel" ? "pg_cancel_backend" : "pg_terminate_backend"
  const action = kind === "cancel" ? "Cancel query" : "Terminate session"
  const started = sqlLiteral(row.backend_start)
  const activeGuard = kind === "cancel" ? "\n    AND state = 'active'" : ""
  const successNote = kind === "cancel"
    ? "Cancel signal sent; the session remains connected."
    : "Terminate signal sent; the session and its locks should disappear."
  const missingNote = kind === "cancel"
    ? "No matching active query; it may be idle, ended, or have a reused PID."
    : "No matching session identity; it ended or its PID was reused."
  const sql = `-- Review before running. Revalidates pid + full-precision backend_start.
WITH target AS MATERIALIZED (
  SELECT pid
  FROM pg_stat_activity
  WHERE pid = ${row.pid}
    AND backend_start = ${started}::timestamptz
    AND pid <> pg_backend_pid()${activeGuard}
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
  onOpenSql(`${action} · pid ${row.pid}`, sql, false)
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
