"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  Brain,
  Eye,
  FlowArrow,
  RefreshCw,
  TreeStructure,
  Wand2,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount, Metric, Panel } from "./instruments"
import {
  fetchAllExtractionRuns,
  fetchExtractionErrors,
  type KgExtractionError,
  type KgExtractionRunDetail,
} from "@/lib/rvbbit/kg"
import type { KgExtractionRunsPayload, KgSourceContext } from "@/lib/desktop/types"

interface KgExtractionRunsWindowProps {
  payload: KgExtractionRunsPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenQueryLens: (queryId: string) => void
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
}

export function KgExtractionRunsWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenQueryLens,
  onOpenOperator,
  onOpenSpecialist,
  onOpenSourceRow,
}: KgExtractionRunsWindowProps) {
  const [graphFilter, setGraphFilter] = useState<string | null>(payload.graphId ?? null)
  const [runs, setRuns] = useState<KgExtractionRunDetail[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(payload.runId ?? null)
  const [errors, setErrors] = useState<KgExtractionError[]>([])
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0

  const selected = runs.find((r) => r.runId === selectedId) ?? null

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      const rows = await fetchAllExtractionRuns(activeConnectionId, graphFilter, 100)
      if (cancelled) return
      setRuns(rows)
      setUpdatedAt(Date.now())
      if (selectedId == null && rows.length > 0) setSelectedId(rows[0].runId)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, graphFilter, selectedId])

  useEffect(() => {
    if (!activeConnectionId || selectedId == null) return
    let cancelled = false
    const run = async () => {
      const rows = await fetchExtractionErrors(activeConnectionId, selectedId, 200)
      if (!cancelled) setErrors(rows)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selectedId])

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    const rows = await fetchAllExtractionRuns(activeConnectionId, graphFilter, 100)
    setRuns(rows)
    setUpdatedAt(Date.now())
    setError(null)
    if (selectedId != null) {
      const errs = await fetchExtractionErrors(activeConnectionId, selectedId, 200)
      setErrors(errs)
    }
  }, [activeConnectionId, graphFilter, selectedId])

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-chrome-text">
        The active connection has no <code>pg_rvbbit</code> extension installed.
      </div>
    )
  }

  // Distinct graphs across runs — used for the header filter.
  const graphs = Array.from(new Set(runs.map((r) => r.graphId))).sort()

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-chrome-border/60 bg-secondary-background/40 px-3 py-2">
        <FlowArrow
          className="h-3.5 w-3.5"
          style={{ color: "var(--brand-kg)" }}
        />
        <span className="text-[11px] uppercase tracking-wider text-chrome-text">
          Extraction Runs
        </span>
        <GraphFilterChip
          value={graphFilter}
          options={graphs}
          onChange={(v) => {
            setGraphFilter(v)
            setSelectedId(null)
          }}
        />
        <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/60">
          {loading ? "loading…" : updatedAt ? `updated ${fmtAgo(updatedAt)}` : "—"}
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </span>
      </header>

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <RunsRail
          runs={runs}
          selectedId={selectedId}
          onPick={setSelectedId}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {!selected ? (
            <div className="grid h-full place-items-center text-[11px] text-chrome-text/60">
              {runs.length === 0
                ? "No extraction runs yet. Run rvbbit.kg_ingest_table(...) to seed."
                : "Pick a run from the left rail."}
            </div>
          ) : (
            <RunDetail
              run={selected}
              errors={errors}
              onOpenQueryLens={onOpenQueryLens}
              onOpenOperator={onOpenOperator}
              onOpenSpecialist={onOpenSpecialist}
              onOpenSourceRow={onOpenSourceRow}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Header bits ─────────────────────────────────────────────────────

function GraphFilterChip({
  value,
  options,
  onChange,
}: {
  value: string | null
  options: string[]
  onChange: (v: string | null) => void
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums text-foreground">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: "var(--brand-kg)" }}
      />
      <span>graph:</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="bg-transparent font-mono text-[11px] text-foreground focus:outline-none"
      >
        <option value="">all</option>
        {options.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Left rail ───────────────────────────────────────────────────────

function RunsRail({
  runs,
  selectedId,
  onPick,
}: {
  runs: KgExtractionRunDetail[]
  selectedId: number | null
  onPick: (id: number) => void
}) {
  return (
    <div className="flex w-[260px] min-w-[260px] flex-col border-r border-chrome-border/60 bg-secondary-background/30">
      <div className="border-b border-chrome-border/60 px-3 py-2 text-[10px] uppercase tracking-wider text-chrome-text">
        Runs · {runs.length}
      </div>
      <div className="flex-1 overflow-auto">
        {runs.length === 0 ? (
          <div className="px-3 py-4 text-[11px] italic text-chrome-text/55">
            No runs
          </div>
        ) : (
          runs.map((r) => {
            const isActive = r.runId === selectedId
            return (
              <button
                key={r.runId}
                type="button"
                onClick={() => onPick(r.runId)}
                className={cn(
                  "block w-full border-b border-chrome-border/40 px-3 py-2 text-left text-[11px] hover:bg-foreground/[0.04]",
                  isActive ? "bg-foreground/[0.06] text-foreground" : "text-chrome-text",
                )}
                style={
                  isActive
                    ? { boxShadow: "inset 3px 0 0 var(--brand-kg)" }
                    : undefined
                }
              >
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  <span className="font-mono text-foreground">#{r.runId}</span>
                  <span className="ml-auto font-mono text-[10px] tabular-nums text-chrome-text/55">
                    {r.createdAt ? fmtAgo(r.createdAt) : "—"}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-chrome-text/70">
                  {r.sourceTable ?? "—"}
                  {r.sourceColumn ? `:${r.sourceColumn}` : ""}
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] tabular-nums text-chrome-text/60">
                  <span>{fmtCount(r.rowsSeen)} rows</span>
                  <span>{fmtCount(r.triplesInserted)} triples</span>
                  {r.errors > 0 ? (
                    <span className="text-danger">{fmtCount(r.errors)} err</span>
                  ) : null}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Run detail pane ─────────────────────────────────────────────────

function RunDetail({
  run,
  errors,
  onOpenQueryLens,
  onOpenOperator,
  onOpenSpecialist,
  onOpenSourceRow,
}: {
  run: KgExtractionRunDetail
  errors: KgExtractionError[]
  onOpenQueryLens: (queryId: string) => void
  onOpenOperator: (name: string, receiptId?: string | null) => void
  onOpenSpecialist: (name: string) => void
  onOpenSourceRow: (ctx: KgSourceContext) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      {/* Action bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono text-foreground">run #{run.runId}</span>
        <StatusPill status={run.status} />
        <span className="rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] tabular-nums">
          graph: <span className="font-mono">{run.graphId}</span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {run.queryId ? (
            <button
              type="button"
              onClick={() => onOpenQueryLens(run.queryId!)}
              className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
              style={{ color: "var(--brand-query-lens)" }}
              title="Open this run's query_id in the Query Lens"
            >
              <Eye className="h-3 w-3" />
              lens
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenOperator("triples")}
            className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
            style={{ color: "var(--brand-operators)" }}
            title="Open the rvbbit.triples operator (the extractor)"
          >
            <Wand2 className="h-3 w-3" />
            operator
          </button>
          <button
            type="button"
            onClick={() => onOpenSpecialist("embed")}
            className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
            style={{ color: "var(--brand-specialists)" }}
            title="Open the embed backend (used for alias resolution during ingest)"
          >
            <Brain className="h-3 w-3" />
            embed
          </button>
        </div>
      </div>

      {/* Metrics + metadata */}
      <Panel icon={FlowArrow} title="Run metadata">
        <div className="grid grid-cols-4 gap-3">
          <Metric label="rows seen" value={fmtCount(run.rowsSeen)} />
          <Metric label="triples inserted" value={fmtCount(run.triplesInserted)} />
          <Metric
            label="errors"
            value={fmtCount(run.errors)}
            tone={run.errors > 0 ? "danger" : undefined}
          />
          <Metric
            label="duration"
            value={
              run.finishedAt && run.createdAt
                ? `${(((run.finishedAt - run.createdAt) / 1000) | 0)}s`
                : "—"
            }
          />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
          <KV
            k="source"
            v={
              run.sourceTable
                ? `${run.sourceTable}${run.sourceColumn ? `:${run.sourceColumn}` : ""}`
                : "—"
            }
            mono
          />
          <KV k="focus" v={run.focus ?? "—"} />
          <KV k="created" v={run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"} />
          <KV
            k="finished"
            v={run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}
          />
        </div>
        {run.properties && Object.keys(run.properties as object).length > 0 ? (
          <details className="mt-3 rounded border border-chrome-border/40 bg-doc-bg/40 p-2 text-[10px]">
            <summary className="cursor-pointer text-chrome-text/70">properties</summary>
            <pre className="mt-2 overflow-auto font-mono leading-tight text-foreground/80">
              {JSON.stringify(run.properties, null, 2)}
            </pre>
          </details>
        ) : null}
      </Panel>

      {/* Errors */}
      <Panel
        icon={AlertTriangle}
        title="Per-row errors"
        right={<span className="text-[10px] tabular-nums">{errors.length} shown</span>}
        className="mt-3"
      >
        {errors.length === 0 ? (
          <div className="py-2 text-center text-[11px] italic text-chrome-text/55">
            No errors recorded for this run.
          </div>
        ) : (
          <ul className="space-y-1">
            {errors.map((e) => (
              <li
                key={e.errorId}
                className="rounded border border-chrome-border/40 bg-background px-2 py-1.5 text-[11px]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-chrome-text/70">err #{e.errorId}</span>
                  {e.sourceTable && e.sourcePk ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenSourceRow({
                          sourceTable: e.sourceTable!,
                          sourcePk: e.sourcePk!,
                          sourceColumn: e.sourceColumn,
                        })
                      }
                      className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                      style={{ color: "var(--brand-finder)" }}
                      title={`Open source row ${e.sourceTable}#${e.sourcePk}`}
                    >
                      <TreeStructure className="h-3 w-3" />
                      row
                    </button>
                  ) : null}
                  <span className="truncate font-mono text-chrome-text/70">
                    {e.sourceTable}
                    {e.sourcePk ? `#${e.sourcePk}` : ""}
                    {e.sourceColumn ? `:${e.sourceColumn}` : ""}
                  </span>
                  <span className="ml-auto tabular-nums text-chrome-text/55">
                    {e.createdAt ? fmtAgo(e.createdAt) : "—"}
                  </span>
                </div>
                {e.error ? (
                  <div className="mt-1 rounded bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger">
                    {e.error}
                  </div>
                ) : null}
                {e.inputPreview ? (
                  <div className="mt-1 rounded bg-foreground/[0.04] px-2 py-1 font-mono text-[10px] text-foreground/75">
                    {e.inputPreview}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">{k}</span>
      <span className={cn("truncate text-[12px] text-foreground", mono && "font-mono")}>
        {v}
      </span>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  // Rvbbit's kg_extraction_runs.status enum: running / ok / partial / failed.
  const tone =
    s === "ok"
      ? { bg: "color-mix(in oklch, var(--success) 18%, transparent)", fg: "var(--success)" }
      : s === "running" || s === "started" || s === "in_progress"
        ? { bg: "color-mix(in oklch, var(--info) 18%, transparent)", fg: "var(--info)" }
        : s === "partial"
          ? { bg: "color-mix(in oklch, var(--warning) 18%, transparent)", fg: "var(--warning)" }
          : s === "failed" || s === "error"
            ? { bg: "color-mix(in oklch, var(--danger) 18%, transparent)", fg: "var(--danger)" }
            : { bg: "var(--foreground)", fg: "var(--background)" }
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {status || "—"}
    </span>
  )
}
