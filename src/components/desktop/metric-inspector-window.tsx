"use client"

// ⊞ Metric Inspector — the bitemporal showcase. Master-detail: a left rail of
// metrics (listMetrics) and a right pane that runs + observes ONE metric across
// BOTH temporal axes:
//   • DEF-TIME  — which definition version (VersionPicker → def_as_of)
//   • DATA-TIME — rvbbit AS OF over the metric's underlying tables (a
//     TimeTravelScrubber, wired exactly like time-travel-strip.tsx)
// The resolved SQL is the observable surface (read-only editor); RUN expands
// rvbbit.metric() into a ResultGrid annotated with the as-of pair it ran at.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Play, Pencil, RefreshCw, Sigma, Loader2, ChevronDown, ChevronRight, Clock } from "@/lib/icons"
import {
  fetchMetricVersions,
  listMetrics,
  resolveMetricSql,
  runMetric,
  type MetricRunResult,
  type MetricSummary,
  type MetricVersion,
} from "@/lib/rvbbit/metrics"
import {
  colorForSeriesIndex,
  detectRvbbitTables,
  fetchTimeline,
  seriesKey,
  type RvbbitTableRef,
  type TimelineSeries,
  type TimelineTick,
} from "@/lib/rvbbit/time-travel"
import type { MetricInspectorPayload } from "@/lib/desktop/types"
import type { QueryResultColumn } from "@/lib/db/types"
import { ResultGrid } from "./result-grid"
import { SqlEditor } from "./sql-editor"
import { TimeTravelScrubber } from "./time-travel-scrubber"
import {
  Field,
  fmtTime,
  formatSqlSafe,
  ParamRowsEditor,
  Section,
  StatusNote,
  VersionPicker,
} from "./metric-shared"

interface Props {
  payload: MetricInspectorPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenCreator: (name?: string) => void
}

type Tab = "run" | "history"

export function MetricInspectorWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenCreator,
}: Props) {
  // ── Metric catalog (left rail) ──────────────────────────────────────
  const [metrics, setMetrics] = useState<MetricSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(payload.metricName ?? null)
  // Bumping this re-triggers the load effect (refresh button) without calling
  // setState synchronously in the effect body.
  const [listReloadKey, setListReloadKey] = useState(0)

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const { metrics: rows, error } = await listMetrics(activeConnectionId)
      if (cancelled) return
      setMetrics(rows)
      setListError(error)
      // Seed selection on first load when none was passed in.
      setSelectedName((cur) => cur ?? rows[0]?.name ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, listReloadKey])

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* LEFT RAIL — metric list */}
        <div className="w-56 shrink-0 border-r border-chrome-border/50 overflow-y-auto">
          <div className="flex items-center gap-1.5 border-b border-chrome-border/50 px-3 py-2">
            <Sigma className="h-3.5 w-3.5 text-main" />
            <span className="text-[11px] uppercase tracking-wider text-chrome-text/60">Metrics</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setListReloadKey((k) => k + 1)}
              title="Reload metrics"
              className="rounded p-1 text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {metrics == null ? (
            <StatusNote state="loading" />
          ) : listError ? (
            <StatusNote state="error" message={listError} />
          ) : metrics.length === 0 ? (
            <StatusNote state="empty" message="No metrics defined yet." />
          ) : (
            <ul className="py-1">
              {metrics.map((m) => (
                <li key={m.name}>
                  <button
                    type="button"
                    onClick={() => setSelectedName(m.name)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                      selectedName === m.name
                        ? "bg-main/15 text-main"
                        : "text-chrome-text/75 hover:bg-foreground/[0.04]"
                    }`}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="truncate font-mono text-[12px]">{m.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] opacity-60">v{m.version}</span>
                    </span>
                    {m.grain ? (
                      <span className="truncate text-[10px] text-chrome-text/45">{m.grain}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* RIGHT PANE — the inspector */}
        {selectedName ? (
          <MetricDetail
            key={selectedName}
            connectionId={activeConnectionId}
            name={selectedName}
            summary={metrics?.find((m) => m.name === selectedName) ?? null}
            onOpenCreator={onOpenCreator}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <StatusNote state="empty" message="Select a metric." />
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Detail pane for one metric
// ─────────────────────────────────────────────────────────────────────────

function MetricDetail({
  connectionId,
  name,
  summary,
  onOpenCreator,
}: {
  connectionId: string
  name: string
  summary: MetricSummary | null
  onOpenCreator: (name?: string) => void
}) {
  const [tab, setTab] = useState<Tab>("run")

  // ── Versions (def-time axis) ──────────────────────────────────────
  const [versions, setVersions] = useState<MetricVersion[] | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null) // null = Latest

  // ── Params (overrides for this run) ───────────────────────────────
  const [params, setParams] = useState<Record<string, unknown>>({})

  // ── Data-time axis ────────────────────────────────────────────────
  const [dataAsOf, setDataAsOf] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { versions: rows, error } = await fetchMetricVersions(connectionId, name)
      if (cancelled) return
      setVersions(rows)
      setVersionsError(error)
      // Seed params from the latest version's defaults (editable thereafter).
      if (rows[0]) setParams(rows[0].params ?? {})
    })()
    return () => {
      cancelled = true
    }
  }, [connectionId, name])

  const selectedVersionObj = useMemo(
    () => (selectedVersion == null ? null : versions?.find((v) => v.version === selectedVersion) ?? null),
    [selectedVersion, versions],
  )
  // Pin def-time with the FULL-precision created_at string (createdAtIso), not a
  // ms round-trip: resolve_metric filters created_at <= def_as_of, and truncating
  // microseconds could drop below this version and select the prior one.
  const defAsOf = selectedVersionObj ? selectedVersionObj.createdAtIso : null

  // ── Resolved SQL (debounced) — the observable surface ─────────────
  const [resolvedSql, setResolvedSql] = useState<string | null>(null)
  const resolvedFormatted = useMemo(() => formatSqlSafe(resolvedSql), [resolvedSql])
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      setResolving(true)
      const { sql, error } = await resolveMetricSql(connectionId, name, params, defAsOf)
      if (cancelled) return
      setResolvedSql(sql)
      setResolveError(error)
      setResolving(false)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [connectionId, name, params, defAsOf])

  // ── Run ───────────────────────────────────────────────────────────
  const [result, setResult] = useState<MetricRunResult | null>(null)
  const [running, setRunning] = useState(false)
  // Capture the as-of pair the displayed result was actually run at.
  const [ranAtLabel, setRanAtLabel] = useState<string | null>(null)

  const onRun = useCallback(async () => {
    setRunning(true)
    const res = await runMetric(connectionId, name, params, defAsOf, dataAsOf)
    setResult(res)
    const defLabel = selectedVersion == null ? "latest" : `v${selectedVersion}`
    const dataLabel = dataAsOf ? fmtScrubberLabel(dataAsOf) : "latest"
    setRanAtLabel(`def: ${defLabel} · data: ${dataLabel}`)
    setRunning(false)
  }, [connectionId, name, params, defAsOf, dataAsOf, selectedVersion])

  // ── Data-time wiring: detect tables → fetch timelines → series ────
  const series = useDataTimeSeries(connectionId, resolvedSql)

  const gridColumns: QueryResultColumn[] = useMemo(
    () => (result?.columns ?? []).map((c) => ({ name: c, dataTypeId: 25 })),
    [result],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex items-start gap-2 border-b border-chrome-border/50 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sigma className="h-4 w-4 shrink-0 text-main" />
            <span className="truncate text-[15px] font-semibold text-foreground">{name}</span>
            {summary?.owner ? (
              <span className="shrink-0 rounded border border-foreground/10 px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/60">
                {summary.owner}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-chrome-text/55">
            {summary?.grain ? <span>grain: {summary.grain}</span> : null}
            {summary?.description ? (
              <span className="truncate text-chrome-text/45">{summary.description}</span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenCreator(name)}
          title="Edit this metric in the Creator"
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1 text-[11px] text-chrome-text/75 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </header>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b border-chrome-border/50 px-3">
        {(["run", "history"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${
              tab === t
                ? "border-main text-foreground"
                : "border-transparent text-chrome-text/55 hover:text-foreground"
            }`}
          >
            {t === "run" ? "Run" : "History"}
          </button>
        ))}
      </div>

      {tab === "run" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* TWO AXES side by side */}
          <div className="grid grid-cols-2 gap-3 px-3 py-2">
            {/* (A) DEF-TIME */}
            <div className="rounded-[3px] border border-chrome-border/60 bg-foreground/[0.02]">
              <AxisCaption label="Definition (def-time)" sub="which version of the SQL" />
              <div className="max-h-44 overflow-y-auto px-1.5 pb-1.5">
                {versions == null ? (
                  <StatusNote state="loading" />
                ) : versionsError ? (
                  <StatusNote state="error" message={versionsError} />
                ) : (
                  <VersionPicker
                    versions={versions}
                    selectedVersion={selectedVersion}
                    onSelect={(v) => setSelectedVersion(v ? v.version : null)}
                  />
                )}
              </div>
            </div>

            {/* (B) DATA-TIME */}
            <div className="flex flex-col rounded-[3px] border border-chrome-border/60 bg-foreground/[0.02]">
              <AxisCaption label="Data (data-time)" sub="rvbbit AS OF over the tables" />
              <div className="flex min-h-[180px] flex-1 px-1.5 pb-1.5">
                {series === null ? (
                  <div className="flex flex-1 items-center gap-2 px-1.5 py-3 text-[11px] text-chrome-text/45">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-chrome-text/50" />
                    resolving temporal tables…
                  </div>
                ) : series.length === 0 ? (
                  <div className="flex flex-1 flex-col gap-1 px-1.5 py-3 text-[11px] text-chrome-text/45">
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3" /> latest only
                    </span>
                    <span className="text-chrome-text/35">no temporal tables in this metric</span>
                  </div>
                ) : (
                  <div className="ml-auto h-full">
                    <TimeTravelScrubber series={series} asOf={dataAsOf} onChange={setDataAsOf} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Params */}
          <Section title="Params">
            <Field label="overrides" hint="for this run only">
              <ParamRowsEditor params={params} onChange={setParams} />
            </Field>
          </Section>

          {/* Resolved SQL */}
          <Section
            title="Resolved SQL"
            right={
              resolving ? (
                <span className="flex items-center gap-1 text-[10px] text-chrome-text/45">
                  <Loader2 className="h-3 w-3 animate-spin" /> resolving
                </span>
              ) : null
            }
          >
            {resolveError ? (
              <StatusNote state="error" message={resolveError} className="px-0" />
            ) : (
              <div className="h-36 overflow-hidden rounded-[3px] border border-chrome-border/60">
                <SqlEditor value={resolvedFormatted} onChange={() => {}} height="100%" readOnly wrap fontSize={12} />
              </div>
            )}
          </Section>

          {/* Run */}
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onRun()}
                disabled={running || !resolvedSql || !!resolveError}
                className="flex items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 py-1.5 text-[12px] text-main transition-colors hover:bg-main/25 disabled:opacity-40"
              >
                {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Run
              </button>
              {result && result.error == null ? (
                <span className="flex items-center gap-2 text-[11px] text-chrome-text/55">
                  <span className="tabular-nums text-foreground">{result.rows.length} rows</span>
                  {ranAtLabel ? <span className="font-mono text-chrome-text/45">{ranAtLabel}</span> : null}
                </span>
              ) : null}
            </div>
          </div>

          {/* Result */}
          {running ? (
            <StatusNote state="loading" message="Running metric…" />
          ) : result?.error ? (
            <StatusNote state="error" message={result.error} />
          ) : result ? (
            result.rows.length === 0 ? (
              <StatusNote state="empty" message="Metric returned no rows." />
            ) : (
              <div className="min-h-[160px] flex-1 px-3 pb-3">
                <div className="h-full min-h-[160px] overflow-hidden rounded-[3px] border border-chrome-border/60">
                  <ResultGrid columns={gridColumns} rows={result.rows} className="h-full" />
                </div>
              </div>
            )
          ) : (
            <div className="px-3 pb-4 pt-1 text-[11px] text-chrome-text/40">
              Pick a definition + data instant, then Run to observe this metric.
            </div>
          )}
        </div>
      ) : (
        <VersionHistory
          versions={versions}
          versionsError={versionsError}
          selectedVersion={selectedVersion}
          onSelect={setSelectedVersion}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Version history tab
// ─────────────────────────────────────────────────────────────────────────

function VersionHistory({
  versions,
  versionsError,
  selectedVersion,
  onSelect,
}: {
  versions: MetricVersion[] | null
  versionsError: string | null
  selectedVersion: number | null
  onSelect: (v: number | null) => void
}) {
  if (versions == null) return <StatusNote state="loading" />
  if (versionsError) return <StatusNote state="error" message={versionsError} />
  if (versions.length === 0) return <StatusNote state="empty" message="No versions recorded." />

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1.5">
      {versions.map((v) => (
        <VersionRow
          key={v.version}
          version={v}
          open={selectedVersion === v.version}
          onToggle={() => onSelect(selectedVersion === v.version ? null : v.version)}
        />
      ))}
    </div>
  )
}

function VersionRow({
  version,
  open,
  onToggle,
}: {
  version: MetricVersion
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-[3px] border border-chrome-border/60 bg-foreground/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-foreground/[0.04]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-chrome-text/55" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-chrome-text/55" />
        )}
        <span className="font-mono text-foreground">v{version.version}</span>
        {version.grain ? <span className="text-[11px] text-chrome-text/55">{version.grain}</span> : null}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-chrome-text/45">
          {fmtTime(version.createdAt)}
        </span>
      </button>
      {open ? (
        <div className="border-t border-chrome-border/50 p-2">
          {version.description ? (
            <div className="mb-1.5 text-[11px] text-chrome-text/55">{version.description}</div>
          ) : null}
          <div className="h-40 overflow-hidden rounded-[3px] border border-chrome-border/60">
            <SqlEditor value={version.sql} onChange={() => {}} height="100%" readOnly fontSize={12} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Small bits
// ─────────────────────────────────────────────────────────────────────────

function AxisCaption({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="border-b border-chrome-border/40 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--syntax-keyword)" }}>
        {label}
      </div>
      <div className="text-[10px] text-chrome-text/40">{sub}</div>
    </div>
  )
}

/** Compact "May 28, 02:25" for the ran-at summary chip. */
function fmtScrubberLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

// ─────────────────────────────────────────────────────────────────────────
// Data-time series hook — copies time-travel-strip's detect→fetch→series flow.
// Returns null while detecting; [] when the metric touches no temporal tables.
// ─────────────────────────────────────────────────────────────────────────

function useDataTimeSeries(connectionId: string, resolvedSql: string | null): TimelineSeries[] | null {
  const [tables, setTables] = useState<RvbbitTableRef[] | null>(null)
  const lastDetectedRef = useRef<string | null>(null)

  // (1) Detect the rvbbit tables the resolved SQL touches (debounced). All
  // setState happens inside the deferred timeout (like time-travel-strip) so
  // the effect body never updates state synchronously.
  useEffect(() => {
    const trimmed = resolvedSql?.trim() ?? ""
    if (lastDetectedRef.current === resolvedSql && tables !== null) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      if (!trimmed) {
        lastDetectedRef.current = resolvedSql
        setTables([])
        return
      }
      const res = await detectRvbbitTables(connectionId, resolvedSql!)
      if (cancelled) return
      lastDetectedRef.current = resolvedSql
      setTables(res)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [connectionId, resolvedSql, tables])

  // (2) Fetch per-table timelines, cached by seriesKey.
  const [tickCache, setTickCache] = useState<Record<string, TimelineTick[]>>({})
  useEffect(() => {
    if (!tables || tables.length === 0) return
    const missing = tables.filter((t) => tickCache[seriesKey(t)] === undefined)
    if (missing.length === 0) return
    let cancelled = false
    void (async () => {
      const results = await Promise.all(missing.map((t) => fetchTimeline(connectionId, t)))
      if (cancelled) return
      setTickCache((prev) => {
        const next = { ...prev }
        for (let i = 0; i < missing.length; i++) next[seriesKey(missing[i])] = results[i].ticks
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [connectionId, tables, tickCache])

  // (3) Assemble the colored series (drop tables with no ticks).
  return useMemo(() => {
    if (tables === null) return null
    const out: TimelineSeries[] = []
    let idx = 0
    for (const t of tables) {
      const ticks = tickCache[seriesKey(t)] ?? []
      if (ticks.length === 0) continue
      out.push({ table: t, color: colorForSeriesIndex(idx), ticks })
      idx += 1
    }
    return out
  }, [tables, tickCache])
}
