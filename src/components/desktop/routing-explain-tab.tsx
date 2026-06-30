"use client"

import { useCallback, useMemo, useState } from "react"
import { AlertTriangle, Check, Database, GitBranch, Layers, Play, Sigma, Sparkles } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtCount, Metric, Panel } from "./instruments"
import { EngineDot, ShapeChips } from "./routing-charts"
import {
  ENGINES,
  engineMeta,
  routeExplain,
  runOptimizeQuery,
  type ColumnarTable,
  type RouteExplain,
} from "@/lib/rvbbit/routing"

interface RoutingExplainTabProps {
  activeConnectionId: string | null
  columnarTables: ColumnarTable[]
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const u = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

export function RoutingExplainTab({
  activeConnectionId,
  columnarTables,
}: RoutingExplainTabProps) {
  const firstTable = columnarTables[0]
  const [sql, setSql] = useState(
    firstTable ? `SELECT count(*) FROM ${firstTable.schema}.${firstTable.name}` : "",
  )
  const [result, setResult] = useState<RouteExplain | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [optMsg, setOptMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const run = useCallback(async () => {
    if (!activeConnectionId || !sql.trim()) return
    setRunning(true)
    const res = await routeExplain(activeConnectionId, sql)
    setError(res.error ?? null)
    setResult(res.explain)
    setRunning(false)
  }, [activeConnectionId, sql])

  // Benchmark this exact query across every engine; pin it if a non-base engine wins.
  const optimize = useCallback(async () => {
    if (!activeConnectionId || !sql.trim() || optimizing) return
    setOptimizing(true)
    setOptMsg(null)
    const res = await runOptimizeQuery(activeConnectionId, sql)
    setOptimizing(false)
    if (!res.ok || !res.result) {
      setOptMsg({ ok: false, text: res.error ?? "optimize failed" })
      return
    }
    const r = res.result
    if (r.ok === false) {
      setOptMsg({ ok: false, text: String(r.reason ?? "not optimizable") })
    } else if (r.skipped) {
      setOptMsg({ ok: false, text: String(r.skipped) })
    } else if (r.pinned) {
      const margin = typeof r.margin_pct === "number" ? `+${r.margin_pct.toFixed(0)}%` : ""
      setOptMsg({ ok: true, text: `pinned ${String(r.winner)} ${margin} over ${String(r.base_engine)}` })
      void run()
    } else {
      const margin = typeof r.margin_pct === "number" ? ` (best +${r.margin_pct.toFixed(0)}%)` : ""
      setOptMsg({ ok: true, text: `base engine kept — no decisive win${margin}` })
    }
  }, [activeConnectionId, sql, optimizing, run])

  const examples = useMemo(() => {
    const out: { label: string; sql: string }[] = []
    for (const t of columnarTables.slice(0, 3)) {
      const ref = `${t.schema}.${t.name}`
      out.push({ label: `count · ${t.name}`, sql: `SELECT count(*) FROM ${ref}` })
      out.push({ label: `scan · ${t.name}`, sql: `SELECT * FROM ${ref} LIMIT 100` })
    }
    return out
  }, [columnarTables])

  return (
    <div className="space-y-2.5 p-2.5">
      <Panel
        icon={GitBranch}
        title="Explain a route"
        right={<span>plans the query — never executes it</span>}
      >
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              void run()
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder="SELECT … FROM an_rvbbit_columnar_table"
          className="w-full resize-y rounded border border-chrome-border bg-doc-bg px-2 py-1.5 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:border-main/60"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || !sql.trim() || !activeConnectionId}
            className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
          >
            <Play className="h-3 w-3" />
            {running ? "Routing…" : "Route it"}
            <span className="text-[9px] text-rvbbit-accent/60">⌘⏎</span>
          </button>
          <button
            type="button"
            onClick={() => void optimize()}
            disabled={optimizing || !sql.trim() || !activeConnectionId}
            title="Benchmark this query across every engine and pin the fastest if it decisively beats the base rule"
            className="inline-flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[11px] font-medium text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-40"
          >
            <Sparkles className={cn("h-3 w-3", optimizing && "animate-pulse")} />
            {optimizing ? "Benchmarking…" : "Optimize"}
          </button>
          {columnarTables.length > 0 ? (
            <span className="ml-1 text-[10px] text-chrome-text/45">
              {columnarTables.length} rvbbit-enabled table{columnarTables.length === 1 ? "" : "s"}:
            </span>
          ) : null}
          {examples.map((ex) => (
            <button
              key={ex.label}
              type="button"
              onClick={() => setSql(ex.sql)}
              className="rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 font-mono text-[9px] text-chrome-text/70 hover:border-rvbbit-accent/40 hover:text-foreground"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </Panel>

      {error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="break-words font-mono">{error}</span>
        </div>
      ) : null}

      {optMsg ? (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11px]",
            optMsg.ok
              ? "border-success/40 bg-success/10 text-success"
              : "border-warning/40 bg-warning/10 text-warning",
          )}
        >
          {optMsg.ok ? (
            <Check className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="break-words">{optMsg.text}</span>
        </div>
      ) : null}

      {result ? (
        <>
          <VerdictPanel explain={result} />
          <CandidatesPanel explain={result} />
          <div className="grid grid-cols-2 gap-2.5">
            <ShapePanel explain={result} />
            <TablesPanel explain={result} />
          </div>
          {result.postgresExplain ? (
            <Panel icon={Sigma} title="PostgreSQL plan">
              <pre className="overflow-auto whitespace-pre-wrap rounded border border-chrome-border bg-doc-bg p-2 font-mono text-[10px] leading-relaxed text-chrome-text/85">
                {result.postgresExplain}
              </pre>
            </Panel>
          ) : null}
        </>
      ) : !error ? (
        <div className="grid h-32 place-items-center text-center text-[11px] text-chrome-text/45">
          <div>
            <GitBranch className="mx-auto mb-2 h-6 w-6 text-chrome-text/25" />
            Route a SELECT to see which engine the planner picks, and why.
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Verdict ─────────────────────────────────────────────────────────

function VerdictPanel({ explain }: { explain: RouteExplain }) {
  const m = engineMeta(explain.chosenCandidate)
  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: `color-mix(in oklch, ${m.color} 40%, var(--chrome-border))`,
        background: `color-mix(in oklch, ${m.color} 7%, var(--secondary-background))`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">routed to</span>
        <span
          className="inline-flex items-center gap-1.5 font-mono text-[18px] font-semibold"
          style={{ color: m.color }}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
          {m.label}
        </span>
        {explain.physicalPath ? (
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{
              background: `color-mix(in oklch, ${m.color} 16%, var(--secondary-background))`,
              color: m.color,
            }}
            title="Physical storage actually read for this route (heap = unaccelerated SeqScan; parquet/vortex = native columnar scan)"
          >
            {explain.physicalPath}
          </span>
        ) : null}
        <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/80">
          via {explain.routeSource || "—"}
        </span>
        {explain.confidence != null ? (
          <span className="text-[11px] text-chrome-text/70">
            confidence{" "}
            <span className="font-mono text-foreground">
              {(explain.confidence * 100).toFixed(0)}%
            </span>
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider",
            explain.safeSelect
              ? "bg-success/15 text-success"
              : "bg-warning/15 text-warning",
          )}
        >
          {explain.safeSelect ? "safe select" : "unsafe"}
        </span>
      </div>
      {explain.reason ? (
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/75">{explain.reason}</p>
      ) : null}
    </div>
  )
}

// ── Candidates ──────────────────────────────────────────────────────

function CandidatesPanel({ explain }: { explain: RouteExplain }) {
  const byName = new Map(explain.candidates.map((c) => [c.name, c]))
  const ordered = ENGINES.map((e) => ({
    engine: e,
    cand: byName.get(e.id) ?? null,
  }))
  return (
    <Panel icon={Database} title="Candidate engines" right={<span>{ENGINES.length} considered</span>}>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {ordered.map(({ engine, cand }) => {
          const selected = cand?.selected ?? false
          const available = cand?.available ?? false
          return (
            <div
              key={engine.id}
              className={cn(
                "rounded border p-2",
                selected
                  ? "border-rvbbit-accent/60 bg-rvbbit-bg/50"
                  : available
                    ? "border-chrome-border bg-secondary-background"
                    : "border-chrome-border/50 bg-secondary-background/40 opacity-55",
              )}
            >
              <div className="flex items-center gap-1.5">
                <EngineDot id={engine.id} />
                <span className="font-mono text-[11px] font-medium text-foreground">
                  {engine.label}
                </span>
                {selected ? (
                  <span className="ml-auto rounded-full bg-rvbbit-accent/20 px-1.5 text-[8px] uppercase tracking-wider text-rvbbit-accent">
                    chosen
                  </span>
                ) : (
                  <span
                    className={cn(
                      "ml-auto text-[9px] uppercase tracking-wider",
                      available ? "text-chrome-text/50" : "text-danger/70",
                    )}
                  >
                    {available ? "available" : "unavailable"}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[9px] leading-snug text-chrome-text/60">
                {cand?.reason || engine.blurb}
              </p>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ── Query shape ─────────────────────────────────────────────────────

function ShapePanel({ explain }: { explain: RouteExplain }) {
  const f = explain.features
  const str = (k: string): string => (typeof f[k] === "string" ? (f[k] as string) : "")
  const n = (k: string): number | null => (typeof f[k] === "number" ? (f[k] as number) : null)
  const flag = (k: string): boolean => f[k] === true

  const shapeKey = str("shape_key")
  const normalized = str("normalized_sql")
  const nativeFn = str("native_function")
  const signals: { label: string; on: boolean }[] = [
    { label: "where", on: flag("where") },
    { label: "group by", on: flag("group_by") },
    { label: "order by", on: flag("order_by") },
    { label: "having", on: flag("having") },
    { label: "distinct", on: flag("distinct") },
  ]

  return (
    <Panel icon={Sigma} title="Query shape">
      {normalized ? (
        <pre className="mb-2 overflow-auto whitespace-pre-wrap rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] leading-relaxed text-chrome-text/80">
          {normalized}
        </pre>
      ) : null}
      <div className="mb-2 grid grid-cols-4 gap-2">
        <Metric label="table rows" value={n("table_rows") != null ? fmtCount(n("table_rows")!) : "—"} />
        <Metric
          label="row groups"
          value={n("row_group_count") != null ? String(n("row_group_count")) : "—"}
        />
        <Metric label="joins" value={n("join_count") != null ? String(n("join_count")) : "0"} />
        <Metric
          label="aggregates"
          value={n("aggregate_count") != null ? String(n("aggregate_count")) : "0"}
        />
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {signals.map((s) => (
          <span
            key={s.label}
            className={cn(
              "rounded px-1.5 py-px font-mono text-[9px]",
              s.on
                ? "bg-rvbbit-accent/15 text-rvbbit-accent"
                : "bg-foreground/[0.04] text-chrome-text/35",
            )}
          >
            {s.label}
          </span>
        ))}
        {nativeFn ? (
          <span className="rounded bg-chart-3/15 px-1.5 py-px font-mono text-[9px] text-chart-3">
            native fn: {nativeFn}
          </span>
        ) : null}
      </div>
      {shapeKey ? (
        <>
          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
            shape key
          </div>
          <ShapeChips shape={shapeKey} />
        </>
      ) : null}
    </Panel>
  )
}

// ── Tables ──────────────────────────────────────────────────────────

function TablesPanel({ explain }: { explain: RouteExplain }) {
  return (
    <Panel icon={Layers} title="Rvbbit tables">
      {explain.tables.length === 0 ? (
        <p className="text-[11px] text-chrome-text/55">
          No rvbbit-enabled tables referenced by this query.
        </p>
      ) : (
        <div className="space-y-2">
          {explain.tables.map((t, i) => (
            <div key={i} className="rounded border border-chrome-border bg-secondary-background p-2">
              <div className="font-mono text-[11px] text-foreground">
                {t.schema}.<span className="text-rvbbit-accent">{t.table}</span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-2">
                <Metric label="rows" value={fmtCount(t.rows)} />
                <Metric label="size" value={fmtBytes(t.bytes)} />
                <Metric label="row groups" value={String(t.rowGroups)} />
                <Metric
                  label="deletes"
                  value={String(t.deleteCount)}
                  tone={t.deleteCount > 0 ? "warning" : "muted"}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
