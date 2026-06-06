"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { CaretRight, LineChart, RefreshCw } from "@/lib/icons"
import { fmtAgo, fmtCount } from "./instruments"
import { Sparkline } from "./sparkline"
import {
  fetchDrift,
  fetchDriftSummary,
  fetchObjectHistory,
  fetchRuns,
  type CatalogRun,
  type DriftRow,
  type DriftSummary,
  type ObjectHistoryPoint,
} from "@/lib/rvbbit/catalog-drift"
import type { DriftPayload } from "@/lib/desktop/types"
import { FLAG_META, TONE_CLASS } from "@/lib/rvbbit/drift-flags"

interface DriftWindowProps {
  payload: DriftPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenTable: (schema: string, name: string) => void
}

// FLAG_META + TONE_CLASS now live in @/lib/rvbbit/drift-flags (shared with the Finder).

export function DriftWindow({ payload, activeConnectionId, hasRvbbit, onOpenTable }: DriftWindowProps) {
  const [runs, setRuns] = useState<CatalogRun[]>([])
  const [runA, setRunA] = useState<number | null>(payload.runA ?? null)
  const [runB, setRunB] = useState<number | null>(payload.runB ?? null)
  const [summary, setSummary] = useState<DriftSummary | null>(null)
  const [rows, setRows] = useState<DriftRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load runs once; default to the two most recent.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    ;(async () => {
      const rs = await fetchRuns(activeConnectionId)
      if (cancelled) return
      setRuns(rs)
      setRunB((prev) => prev ?? rs[0]?.runId ?? null)
      setRunA((prev) => prev ?? rs[1]?.runId ?? null)
    })()
    return () => { cancelled = true }
  }, [activeConnectionId])

  // Recompute drift whenever the pair changes.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    ;(async () => {
      if (runA == null || runB == null || runA === runB) {
        if (!cancelled) { setRows([]); setSummary(null) }
        return
      }
      setLoading(true)
      const [sum, drift] = await Promise.all([
        fetchDriftSummary(activeConnectionId, runA, runB),
        fetchDrift(activeConnectionId, runA, runB, true),
      ])
      if (cancelled) return
      setSummary(sum)
      setRows(drift.rows)
      setError(drift.error ?? null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [activeConnectionId, runA, runB])

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const rs = await fetchRuns(activeConnectionId)
    setRuns(rs)
  }, [activeConnectionId])

  const swap = useCallback(() => {
    setRunA(runB)
    setRunB(runA)
  }, [runA, runB])

  // Group rows by schema.rel, table row first.
  const groups = useMemo(() => {
    const map = new Map<string, { table: DriftRow | null; cols: DriftRow[] }>()
    for (const r of rows) {
      const key = `${r.schema}.${r.rel}`
      const g = map.get(key) ?? { table: null, cols: [] }
      if (r.kind === "db_table") g.table = r
      else g.cols.push(r)
      map.set(key, g)
    }
    return Array.from(map.entries())
      .map(([key, g]) => ({
        key,
        table: g.table,
        cols: g.cols,
        sev: Math.max(g.table?.severity ?? 0, ...g.cols.map((c) => c.severity), 0),
      }))
      .sort((a, b) => b.sev - a.sev || a.key.localeCompare(b.key))
  }, [rows])

  // ── gates ───────────────────────────────────────────────────────────
  if (!activeConnectionId) return <Centered>Connect to a database to view catalog drift.</Centered>
  if (!hasRvbbit) {
    return (
      <Centered>
        Drift needs the <span className="font-mono">rvbbit</span> extension on this connection.
      </Centered>
    )
  }
  if (runs.length < 2) {
    return (
      <Centered>
        Drift compares two catalog crawls — there {runs.length === 1 ? "is only 1" : "are 0"} so far.
        Run <span className="font-medium">Crawl</span> in Data Search at least twice (with changes in
        between) to see drift.
      </Centered>
    )
  }

  return (
    <div className="flex h-full flex-col text-foreground">
      {/* Header: run pair + summary */}
      <div className="shrink-0 border-b border-chrome-border/60 bg-chrome-bg/40 px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[12px] font-medium">
            <LineChart className="h-4 w-4" style={{ color: "var(--brand-kg)" }} />
            Drift
          </div>
          <button
            type="button"
            onClick={reload}
            className="flex items-center gap-1 rounded-base border border-chrome-border/60 px-2 py-0.5 text-[10px] text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
            title="Reload run list"
          >
            <RefreshCw className="h-3 w-3" /> Runs
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11px]">
          <RunSelect label="baseline" runs={runs} value={runA} exclude={runB} onChange={setRunA} />
          <button
            type="button"
            onClick={swap}
            className="rounded-base px-1 text-chrome-text/60 hover:text-foreground"
            title="Swap baseline / current"
          >
            ↔
          </button>
          <RunSelect label="current" runs={runs} value={runB} exclude={runA} onChange={setRunB} />
        </div>

        {summary ? <SummaryBand summary={summary} loading={loading} /> : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {runA === runB ? (
          <Centered>Pick two different runs to compare.</Centered>
        ) : error ? (
          <Centered><span className="text-danger">{error}</span></Centered>
        ) : !loading && rows.length === 0 ? (
          <Centered>No changes between these two runs.</Centered>
        ) : (
          <div className="divide-y divide-chrome-border/30">
            {groups.map((g) => (
              <DriftGroup
                key={g.key}
                group={g}
                connectionId={activeConnectionId}
                onOpenTable={onOpenTable}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── run selector ─────────────────────────────────────────────────────

function RunSelect({
  label, runs, value, exclude, onChange,
}: {
  label: string
  runs: CatalogRun[]
  value: number | null
  exclude: number | null
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-chrome-text/45">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-base border border-chrome-border/60 bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:outline-none"
      >
        {runs.map((r) => (
          <option key={r.runId} value={r.runId} disabled={r.runId === exclude}>
            #{r.runId} · {fmtAgo(r.finishedAt ?? r.startedAt ?? 0)} · {fmtCount(r.columns)} cols
          </option>
        ))}
      </select>
    </label>
  )
}

// ── summary band ─────────────────────────────────────────────────────

function SummaryBand({ summary, loading }: { summary: DriftSummary; loading: boolean }) {
  const flagEntries = Object.entries(summary.flags)
    .filter(([f]) => f in FLAG_META)
    .sort((a, b) => b[1] - a[1])
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
      <Stat n={summary.changed} label="changed" tone="info" />
      <Stat n={summary.added} label="added" tone="add" />
      <Stat n={summary.dropped} label="dropped" tone="danger" />
      <span className="mx-1 text-chrome-text/30">|</span>
      {flagEntries.map(([f, c]) => (
        <span key={f} className={`rounded-full px-1.5 py-0.5 ${TONE_CLASS[FLAG_META[f].tone]}`}>
          {FLAG_META[f].label} {c}
        </span>
      ))}
      {loading ? <span className="text-chrome-text/45">…</span> : null}
    </div>
  )
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  if (!n) return null
  return (
    <span className={`rounded-full px-1.5 py-0.5 font-medium ${TONE_CLASS[tone]}`}>
      {n} {label}
    </span>
  )
}

// ── per-table group ──────────────────────────────────────────────────

function DriftGroup({
  group, connectionId, onOpenTable,
}: {
  group: { key: string; table: DriftRow | null; cols: DriftRow[] }
  connectionId: string
  onOpenTable: (schema: string, name: string) => void
}) {
  const [schema, rel] = group.key.split(/\.(.*)/s)
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpenTable(schema, rel)}
          className="font-mono text-[12px] text-foreground hover:underline"
          title={`Open ${group.key}`}
        >
          <span className="text-chrome-text/55">{schema}.</span>{rel}
        </button>
        {group.table ? <FlagChips flags={group.table.flags} /> : null}
      </div>
      {group.table && Object.keys(group.table.diff).length > 0 ? (
        <div className="mb-1.5 ml-1">
          <FacetPills diff={group.table.diff} />
        </div>
      ) : null}
      <div className="space-y-1">
        {group.cols.map((c) => (
          <DriftCol key={c.objKey} row={c} connectionId={connectionId} />
        ))}
      </div>
    </div>
  )
}

// ── per-column drift card with expandable history ────────────────────

function DriftCol({ row, connectionId }: { row: DriftRow; connectionId: string }) {
  const [open, setOpen] = useState(false)
  const [hist, setHist] = useState<ObjectHistoryPoint[] | null>(null)

  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && hist == null) {
      setHist(await fetchObjectHistory(connectionId, row.objKey))
    }
  }, [open, hist, connectionId, row.objKey])

  return (
    <div className="rounded-base bg-foreground/[0.02]">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-foreground/[0.04]"
      >
        <CaretRight
          className={`h-3 w-3 shrink-0 text-chrome-text/40 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-mono text-[11px] text-foreground">{row.col}</span>
        <SeverityBar severity={row.severity} />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <FlagChips flags={row.flags} />
        </div>
      </button>
      <div className="px-2 pb-1.5 pl-7">
        <FacetPills diff={row.diff} />
        {open ? <HistoryPanel hist={hist} kind={row.kind} /> : null}
      </div>
    </div>
  )
}

function HistoryPanel({ hist, kind }: { hist: ObjectHistoryPoint[] | null; kind: DriftRow["kind"] }) {
  if (hist == null) return <div className="mt-1 text-[10px] text-chrome-text/40">loading history…</div>
  if (hist.length < 2) return <div className="mt-1 text-[10px] text-chrome-text/40">not enough history</div>
  const ndv = hist.map((h) => h.ndv ?? 0)
  const nf = hist.map((h) => (h.nullFrac ?? 0) * 100)
  const rows = hist.map((h) => h.nRows ?? 0)
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-3">
      {kind === "db_table" ? (
        <Mini label="rows" values={rows} />
      ) : (
        <>
          <Mini label="distinct" values={ndv} />
          <Mini label="% null" values={nf} />
        </>
      )}
    </div>
  )
}

function Mini({ label, values }: { label: string; values: number[] }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between text-[9px] text-chrome-text/45">
        <span>{label}</span>
        <span className="font-mono">{fmtCount(values[values.length - 1] ?? 0)}</span>
      </div>
      <Sparkline values={values} height={24} color="var(--brand-kg)" />
    </div>
  )
}

// ── facet pills (interprets the diff jsonb) ──────────────────────────

function FacetPills({ diff }: { diff: Record<string, unknown> }) {
  const pills: React.ReactNode[] = []
  const ab = (k: string) => diff[k] as { a?: unknown; b?: unknown } | undefined

  const dt = ab("data_type")
  if (dt) pills.push(<Pill key="dt" tone="danger">{`type ${dt.a} → ${dt.b}`}</Pill>)

  const nl = ab("nullable")
  if (nl) pills.push(<Pill key="nl" tone="warn">{`nullable ${nl.a} → ${nl.b}`}</Pill>)

  const pk = ab("is_pk")
  if (pk) pills.push(<Pill key="pk" tone="warn">{`pk ${pk.a} → ${pk.b}`}</Pill>)

  const fk = ab("fk_target")
  if (fk) pills.push(<Pill key="fk" tone="warn">{`fk ${fk.a ?? "—"} → ${fk.b ?? "—"}`}</Pill>)

  const nr = diff.n_rows as { a?: number; b?: number; pct?: number } | undefined
  if (nr) pills.push(
    <Pill key="nr" tone="muted">
      {`rows ${fmtCount(nr.a ?? 0)} → ${fmtCount(nr.b ?? 0)}${nr.pct != null ? ` (${nr.pct > 0 ? "+" : ""}${nr.pct}%)` : ""}`}
    </Pill>,
  )

  const nd = ab("ndv")
  if (nd) pills.push(<Pill key="nd" tone="muted">{`distinct ${fmtCount(Number(nd.a ?? 0))} → ${fmtCount(Number(nd.b ?? 0))}`}</Pill>)

  const nf = diff.null_frac as { a?: number; b?: number } | undefined
  if (nf) pills.push(
    <Pill key="nf" tone={(nf.b ?? 0) - (nf.a ?? 0) >= 0.1 ? "danger" : "muted"}>
      {`null ${pct(nf.a)} → ${pct(nf.b)}`}
    </Pill>,
  )

  const vals = diff.values as { new_values?: string[]; lost_values?: string[]; psi?: number } | undefined
  if (vals) {
    for (const v of (vals.new_values ?? []).slice(0, 6)) pills.push(<Pill key={`+${v}`} tone="info">{`+${v}`}</Pill>)
    for (const v of (vals.lost_values ?? []).slice(0, 6)) pills.push(<Pill key={`-${v}`} tone="warn">{`−${v}`}</Pill>)
    if (vals.psi != null) pills.push(<Pill key="psi" tone="info">{`PSI ${vals.psi}`}</Pill>)
  }

  const rng = diff.range as { min_a?: string; min_b?: string; max_a?: string; max_b?: string } | undefined
  if (rng && (rng.min_a !== rng.min_b || rng.max_a !== rng.max_b)) {
    pills.push(<Pill key="rng" tone="muted">{`range [${trunc(rng.min_a)}…${trunc(rng.max_a)}] → [${trunc(rng.min_b)}…${trunc(rng.max_b)}]`}</Pill>)
  }

  const ed = diff.embed_drift as number | undefined
  if (ed != null && ed >= 0.05) pills.push(<Pill key="ed" tone="info">{`char drift ${ed}`}</Pill>)

  if (pills.length === 0) return null
  return <div className="flex flex-wrap gap-1">{pills}</div>
}

function Pill({ tone, children }: { tone: keyof typeof TONE_CLASS; children: React.ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${TONE_CLASS[tone]}`}>{children}</span>
  )
}

function FlagChips({ flags }: { flags: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {flags.filter((f) => f in FLAG_META).map((f) => (
        <span key={f} className={`rounded-full px-1.5 py-0.5 text-[9px] ${TONE_CLASS[FLAG_META[f].tone]}`}>
          {FLAG_META[f].label}
        </span>
      ))}
    </div>
  )
}

function SeverityBar({ severity }: { severity: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(severity * 100)))
  const color = severity >= 0.7 ? "var(--danger)" : severity >= 0.4 ? "var(--warning)" : "var(--brand-kg)"
  return (
    <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-foreground/[0.06]">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function pct(v: unknown): string {
  if (v == null) return "—"
  return `${(Number(v) * 100).toFixed(1)}%`
}
function trunc(s: unknown, n = 12): string {
  if (s == null) return "—"
  const t = String(s)
  return t.length <= n ? t : t.slice(0, n - 1) + "…"
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center text-[11px] leading-relaxed text-chrome-text/60">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  )
}
