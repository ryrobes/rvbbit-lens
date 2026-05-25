"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  FileText,
  Layers,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  HBars,
  Metric,
  Panel,
  Readout,
  type HBarRow,
} from "./instruments"
import type { RvbbitCachePayload } from "@/lib/desktop/types"

interface RvbbitCacheWindowProps {
  payload: RvbbitCachePayload
  activeConnectionId: string | null
  onOpenOperator?: (name: string) => void
  onOpenSpecialist?: (name: string) => void
  onOpenTable?: (schema: string, name: string) => void
}

type TabKey = "overview" | "receipts" | "embeddings" | "bitmaps"

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "Overview", icon: Sparkles },
  { key: "receipts", label: "Receipts", icon: FileText },
  { key: "embeddings", label: "Embeddings", icon: Brain },
  { key: "bitmaps", label: "Bitmaps", icon: Layers },
]

const REFRESH_OPTIONS_MS = [
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "1m" },
]

// ── Row shapes ──────────────────────────────────────────────────────

interface ReceiptRollupRow {
  operator: string
  model: string | null
  calls: number
  errors: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  avgLatencyMs: number
  lastAt: number | null
}

interface EmbeddingRow {
  specialist: string
  model: string | null
  dim: number
  entries: number
  lastAt: number | null
}

interface BitmapRow {
  relation: string
  predicate: string
  modelVersion: string | null
  rowGroups: number
  nSet: number
  nTotal: number
}

interface OverviewStats {
  receipts: { count: number; cost: number; tokensIn: number; tokensOut: number; errors: number }
  embeddings: { entries: number; specialists: number }
  bitmaps: { rowGroups: number; matches: number; total: number }
}

/**
 * Rvbbit Cache — a dashboard over the cross-cutting cache surfaces
 * the extension maintains (LLM judgments, embedding cache, semantic
 * bitmaps). Per-operator and per-specialist detail lives in their own
 * dedicated windows; this one answers "what's the *cache layer* doing
 * across all of them?" — handy for cost auditing and capacity sizing.
 */
export function RvbbitCacheWindow({
  payload,
  activeConnectionId,
  onOpenOperator,
  onOpenSpecialist,
  onOpenTable,
}: RvbbitCacheWindowProps) {
  // The legacy `initialView` payload maps stale tab keys (judgments,
  // specialists) onto the new tab set. Default to Overview.
  const initialTab: TabKey =
    payload.initialView === "embeddings"
      ? "embeddings"
      : payload.initialView === "bitmaps"
        ? "bitmaps"
        : payload.initialView === "receipts"
          ? "receipts"
          : "overview"

  const [tab, setTab] = useState<TabKey>(initialTab)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(10_000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const loading = updatedAt === 0

  const [receipts, setReceipts] = useState<ReceiptRollupRow[]>([])
  const [embeddings, setEmbeddings] = useState<EmbeddingRow[]>([])
  const [bitmaps, setBitmaps] = useState<BitmapRow[]>([])
  const [stats, setStats] = useState<OverviewStats | null>(null)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [r, e, b] = await Promise.all([
      runQuery(activeConnectionId, RECEIPTS_SQL).then(parseReceipts),
      runQuery(activeConnectionId, EMBEDDINGS_SQL).then(parseEmbeddings),
      runQuery(activeConnectionId, BITMAPS_SQL).then(parseBitmaps),
    ])
    const firstErr = r.error ?? e.error ?? b.error ?? null
    setError(firstErr)
    setReceipts(r.rows)
    setEmbeddings(e.rows)
    setBitmaps(b.rows)
    setStats(deriveStats(r.rows, e.rows, b.rows))
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
    if (!activeConnectionId || paused) return
    const id = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, paused, intervalMs, reload])

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
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
          <Sparkles className="h-3.5 w-3.5 text-rvbbit-accent" />
          Rvbbit Cache
        </span>
        {!loading && stats ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(stats.receipts.count)}
              </span>{" "}
              receipts
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(stats.embeddings.entries)}
              </span>{" "}
              embeddings
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(stats.bitmaps.rowGroups)}
              </span>{" "}
              bitmap groups
            </span>
            {stats.receipts.errors > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span className="text-danger">{stats.receipts.errors} errors</span>
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
            title={paused ? "Resume" : "Pause"}
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
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      {/* tab bar */}
      <div className="flex items-center gap-px border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition",
              tab === t.key
                ? "border-rvbbit-accent text-rvbbit-accent"
                : "border-transparent text-chrome-text/65 hover:text-foreground",
            )}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            loading cache layer…
          </div>
        ) : tab === "overview" ? (
          <OverviewTab
            stats={stats}
            receipts={receipts}
            embeddings={embeddings}
            bitmaps={bitmaps}
            onJumpTab={setTab}
          />
        ) : tab === "receipts" ? (
          <ReceiptsTab rows={receipts} onOpenOperator={onOpenOperator} />
        ) : tab === "embeddings" ? (
          <EmbeddingsTab rows={embeddings} onOpenSpecialist={onOpenSpecialist} />
        ) : (
          <BitmapsTab rows={bitmaps} onOpenTable={onOpenTable} />
        )}
      </div>
    </div>
  )
}

// ── Overview tab ────────────────────────────────────────────────────

function OverviewTab({
  stats,
  receipts,
  embeddings,
  onJumpTab,
}: {
  stats: OverviewStats | null
  receipts: ReceiptRollupRow[]
  embeddings: EmbeddingRow[]
  bitmaps: BitmapRow[]
  onJumpTab: (t: TabKey) => void
}) {
  // Hooks first — React requires hook order to be stable across renders,
  // so we compute even when stats is null and short-circuit below.
  const topOperators = useMemo(() => {
    const m = new Map<string, { calls: number; cost: number; errors: number }>()
    for (const r of receipts) {
      const cur = m.get(r.operator) ?? { calls: 0, cost: 0, errors: 0 }
      cur.calls += r.calls
      cur.cost += r.costUsd
      cur.errors += r.errors
      m.set(r.operator, cur)
    }
    return [...m.entries()]
      .map(([op, v]) => ({ op, ...v }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8)
  }, [receipts])

  const topModels = useMemo(() => {
    const m = new Map<string, { calls: number; cost: number; tokens: number }>()
    for (const r of receipts) {
      const key = r.model ?? "(no model)"
      const cur = m.get(key) ?? { calls: 0, cost: 0, tokens: 0 }
      cur.calls += r.calls
      cur.cost += r.costUsd
      cur.tokens += r.tokensIn + r.tokensOut
      m.set(key, cur)
    }
    return [...m.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost || b.calls - a.calls)
      .slice(0, 8)
  }, [receipts])

  if (!stats) {
    return (
      <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
        no cache data
      </div>
    )
  }

  // Estimate embedding storage. Rough — float32 × dim × entries.
  const estBytes = embeddings.reduce((s, r) => s + r.entries * r.dim * 4, 0)
  const matchRate =
    stats.bitmaps.total > 0 ? stats.bitmaps.matches / stats.bitmaps.total : 0

  return (
    <div className="space-y-2.5 p-2.5">
      {/* hero — three surface clusters */}
      <div className="grid grid-cols-3 gap-2.5">
        <SurfaceHero
          icon={FileText}
          title="Receipts"
          headline={fmtCount(stats.receipts.count)}
          headlineUnit="calls"
          onClick={() => onJumpTab("receipts")}
          metrics={[
            ["cost", stats.receipts.cost > 0 ? `$${stats.receipts.cost.toFixed(4)}` : "—"],
            [
              "tokens",
              `${fmtCount(stats.receipts.tokensIn)}→${fmtCount(stats.receipts.tokensOut)}`,
            ],
            ["errors", String(stats.receipts.errors)],
          ]}
          tone={stats.receipts.errors > 0 ? "warning" : "neutral"}
        />
        <SurfaceHero
          icon={Brain}
          title="Embeddings"
          headline={fmtCount(stats.embeddings.entries)}
          headlineUnit="entries"
          onClick={() => onJumpTab("embeddings")}
          metrics={[
            ["specialists", String(stats.embeddings.specialists)],
            ["est. size", fmtBytes(estBytes)],
            [
              "avg/spec",
              stats.embeddings.specialists > 0
                ? fmtCount(Math.round(stats.embeddings.entries / stats.embeddings.specialists))
                : "0",
            ],
          ]}
        />
        <SurfaceHero
          icon={Layers}
          title="Bitmaps"
          headline={fmtCount(stats.bitmaps.rowGroups)}
          headlineUnit="row groups"
          onClick={() => onJumpTab("bitmaps")}
          metrics={[
            ["matches", fmtCount(stats.bitmaps.matches)],
            ["rows scanned", fmtCount(stats.bitmaps.total)],
            ["match rate", `${(matchRate * 100).toFixed(1)}%`],
          ]}
        />
      </div>

      {/* breakdown rows */}
      <div className="grid grid-cols-2 gap-2.5">
        <Panel icon={Activity} title="Top operators" right={<span>by call count</span>}>
          {topOperators.length === 0 ? (
            <EmptyHint label="no operator activity recorded" />
          ) : (
            <HBars
              rows={topOperators.map<HBarRow>((o) => ({
                label: `rvbbit.${o.op}`,
                value: o.calls,
                valueLabel: fmtCount(o.calls),
                sub: o.cost > 0 ? `$${o.cost.toFixed(4)}` : "",
                color: o.errors > 0 ? "var(--danger)" : "var(--rvbbit-accent)",
                title:
                  `${o.calls} call(s)` +
                  (o.cost > 0 ? ` · $${o.cost.toFixed(4)}` : "") +
                  (o.errors > 0 ? ` · ${o.errors} err` : ""),
              }))}
            />
          )}
        </Panel>
        <Panel icon={Sparkles} title="Top models" right={<span>by spend</span>}>
          {topModels.length === 0 ? (
            <EmptyHint label="no model spend recorded" />
          ) : (
            <HBars
              rows={topModels.map<HBarRow>((m) => ({
                label: shortModel(m.model),
                value: m.cost > 0 ? m.cost : m.calls,
                valueLabel: m.cost > 0 ? `$${m.cost.toFixed(4)}` : fmtCount(m.calls),
                sub: `${fmtCount(m.tokens)} tok`,
                color: "var(--chart-3)",
                title: `${m.model} · ${fmtCount(m.calls)} call(s) · ${fmtCount(m.tokens)} tok`,
              }))}
            />
          )}
        </Panel>
      </div>

      <p className="px-1 text-[10px] leading-snug text-chrome-text/45">
        Receipts, embeddings, and bitmaps are independent caches. Operator-flow
        receipts persist by content; embeddings are deduped by (specialist, text);
        bitmaps materialize predicate outcomes per row group. Per-operator and
        per-specialist drill-down lives in their dedicated windows.
      </p>
    </div>
  )
}

function SurfaceHero({
  icon: Icon,
  title,
  headline,
  headlineUnit,
  metrics,
  tone,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  headline: string
  headlineUnit: string
  metrics: [string, string][]
  tone?: "warning" | "neutral"
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-secondary-background/40 p-3 text-left transition",
        "hover:border-rvbbit-accent/40 hover:bg-secondary-background/70",
        tone === "warning" ? "border-warning/30" : "border-chrome-border/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text/65">
        <Icon className="h-3.5 w-3.5 text-rvbbit-accent" />
        {title}
        <span className="ml-auto text-[9px] normal-case tracking-normal text-chrome-text/45">
          drill in →
        </span>
      </div>
      <Readout value={headline} unit={headlineUnit} accent />
      <div className="grid grid-cols-3 gap-1.5">
        {metrics.map(([k, v]) => (
          <Metric key={k} label={k} value={v} />
        ))}
      </div>
    </button>
  )
}

// ── Receipts tab ────────────────────────────────────────────────────

function ReceiptsTab({
  rows,
  onOpenOperator,
}: {
  rows: ReceiptRollupRow[]
  onOpenOperator?: (name: string) => void
}) {
  if (rows.length === 0) {
    return <EmptyHint label="no receipts recorded yet" big />
  }
  return (
    <div className="p-2.5">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-chrome-bg/80 text-[9px] uppercase tracking-wider text-chrome-text/55 backdrop-blur">
          <tr>
            <th className="px-2 py-1 text-left font-medium">operator</th>
            <th className="px-2 py-1 text-left font-medium">model</th>
            <th className="px-2 py-1 text-right font-medium">calls</th>
            <th className="px-2 py-1 text-right font-medium">tokens (in/out)</th>
            <th className="px-2 py-1 text-right font-medium">cost</th>
            <th className="px-2 py-1 text-right font-medium">avg lat</th>
            <th className="px-2 py-1 text-right font-medium">errors</th>
            <th className="px-2 py-1 text-right font-medium">last call</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.operator}::${r.model ?? ""}`}
              onClick={() => onOpenOperator?.(r.operator)}
              className={cn(
                "cursor-pointer border-t border-chrome-border/30 transition hover:bg-foreground/[0.04]",
                r.errors > 0 ? "border-l-2 border-l-danger/60" : "",
              )}
              title="open operator flow"
            >
              <td className="px-2 py-1 font-mono text-rvbbit-accent">rvbbit.{r.operator}</td>
              <td className="px-2 py-1 font-mono text-chrome-text/75">
                {r.model ? shortModel(r.model) : <span className="opacity-50">—</span>}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {fmtCount(r.calls)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/75">
                {fmtCount(r.tokensIn)} / {fmtCount(r.tokensOut)}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                {r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "—"}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/75">
                {fmtMs(r.avgLatencyMs)}
              </td>
              <td
                className={cn(
                  "px-2 py-1 text-right font-mono tabular-nums",
                  r.errors > 0 ? "text-danger" : "text-chrome-text/45",
                )}
              >
                {r.errors > 0 ? r.errors : "0"}
              </td>
              <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/70">
                {r.lastAt ? fmtAgo(r.lastAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Embeddings tab ──────────────────────────────────────────────────

function EmbeddingsTab({
  rows,
  onOpenSpecialist,
}: {
  rows: EmbeddingRow[]
  onOpenSpecialist?: (name: string) => void
}) {
  if (rows.length === 0) {
    return <EmptyHint label="no embedding cache entries" big />
  }
  const totalEntries = rows.reduce((s, r) => s + r.entries, 0)
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5 p-2.5">
      {rows.map((r) => {
        const share = totalEntries > 0 ? r.entries / totalEntries : 0
        const estBytes = r.entries * r.dim * 4
        return (
          <button
            key={`${r.specialist}::${r.model ?? ""}::${r.dim}`}
            type="button"
            onClick={() => onOpenSpecialist?.(r.specialist)}
            className="flex flex-col gap-2 rounded-md border border-chrome-border bg-secondary-background/40 p-2.5 text-left transition hover:border-brand-specialists/40 hover:bg-secondary-background/70"
            title="open specialist detail"
          >
            <div className="flex items-center gap-1.5">
              <Brain className="h-3.5 w-3.5 shrink-0 text-brand-specialists" />
              <span className="truncate font-mono text-[12px] font-medium text-foreground">
                {r.specialist}
              </span>
              <span className="ml-auto rounded bg-foreground/[0.05] px-1 font-mono text-[9px] text-chrome-text/65">
                dim {r.dim}
              </span>
            </div>
            {r.model ? (
              <div className="truncate font-mono text-[10px] text-chrome-text/55">
                {r.model}
              </div>
            ) : null}
            <Readout value={fmtCount(r.entries)} unit="entries" accent />
            <div className="grid grid-cols-2 gap-2 border-t border-chrome-border/40 pt-1.5">
              <Metric label="est. size" value={fmtBytes(estBytes)} />
              <Metric
                label="share"
                value={`${(share * 100).toFixed(1)}%`}
                tone="muted"
              />
            </div>
            {/* share bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-sm bg-foreground/[0.05]">
              <div
                className="h-full rounded-sm bg-brand-specialists"
                style={{ width: `${Math.max(1.5, share * 100)}%` }}
              />
            </div>
            {r.lastAt ? (
              <div className="text-[10px] text-chrome-text/55">
                last computed {fmtAgo(r.lastAt)}
              </div>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ── Bitmaps tab ─────────────────────────────────────────────────────

function BitmapsTab({
  rows,
  onOpenTable,
}: {
  rows: BitmapRow[]
  onOpenTable?: (schema: string, name: string) => void
}) {
  if (rows.length === 0) {
    return <EmptyHint label="no semantic bitmaps materialized" big />
  }
  return (
    <div className="p-2.5">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-chrome-bg/80 text-[9px] uppercase tracking-wider text-chrome-text/55 backdrop-blur">
          <tr>
            <th className="px-2 py-1 text-left font-medium">relation</th>
            <th className="px-2 py-1 text-left font-medium">predicate</th>
            <th className="px-2 py-1 text-left font-medium">model version</th>
            <th className="px-2 py-1 text-right font-medium">row groups</th>
            <th className="px-2 py-1 text-right font-medium">matches</th>
            <th className="px-2 py-1 text-right font-medium">rows scanned</th>
            <th className="px-2 py-1 text-left font-medium">match rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rate = r.nTotal > 0 ? r.nSet / r.nTotal : 0
            const parsed = parseRelation(r.relation)
            return (
              <tr
                key={`${r.relation}::${r.predicate}::${r.modelVersion ?? ""}::${i}`}
                onClick={() => parsed && onOpenTable?.(parsed.schema, parsed.name)}
                className={cn(
                  "border-t border-chrome-border/30 transition",
                  parsed
                    ? "cursor-pointer hover:bg-foreground/[0.04]"
                    : "cursor-default",
                )}
                title={parsed ? `open ${r.relation}` : ""}
              >
                <td className="px-2 py-1 font-mono text-foreground">{r.relation}</td>
                <td className="px-2 py-1 font-mono text-rvbbit-accent">{r.predicate}</td>
                <td className="px-2 py-1 font-mono text-chrome-text/65">
                  {r.modelVersion ?? "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                  {fmtCount(r.rowGroups)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                  {fmtCount(r.nSet)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/75">
                  {fmtCount(r.nTotal)}
                </td>
                <td className="px-2 py-1">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-sm bg-foreground/[0.05]">
                      <div
                        className="h-full rounded-sm bg-rvbbit-accent"
                        style={{ width: `${Math.max(1.5, rate * 100)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-chrome-text/75">
                      {(rate * 100).toFixed(1)}%
                    </span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────

function EmptyHint({ label, big }: { label: string; big?: boolean }) {
  return (
    <div
      className={cn(
        "grid place-items-center text-[11px] text-chrome-text/45",
        big ? "h-full" : "h-16",
      )}
    >
      {label}
    </div>
  )
}

function shortModel(model: string | null): string {
  if (!model) return "(no model)"
  const slash = model.lastIndexOf("/")
  return slash >= 0 ? model.slice(slash + 1) : model
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function parseRelation(text: string): { schema: string; name: string } | null {
  if (!text) return null
  const dot = text.indexOf(".")
  if (dot >= 0) {
    const schema = text.slice(0, dot).replace(/^"/, "").replace(/"$/, "")
    const name = text.slice(dot + 1).replace(/^"/, "").replace(/"$/, "")
    return { schema, name }
  }
  return { schema: "public", name: text.replace(/^"/, "").replace(/"$/, "") }
}

// ── SQL ─────────────────────────────────────────────────────────────

const RECEIPTS_SQL = `SELECT operator, model,
       count(*)::int                       AS calls,
       count(*) FILTER (WHERE error IS NOT NULL)::int AS errors,
       coalesce(sum(n_tokens_in), 0)::bigint   AS tokens_in,
       coalesce(sum(n_tokens_out), 0)::bigint  AS tokens_out,
       coalesce(sum(cost_usd), 0)::float       AS cost_usd,
       coalesce(avg(latency_ms), 0)::int       AS avg_ms,
       max(invocation_at)                      AS last_at
FROM rvbbit.receipts
GROUP BY operator, model
ORDER BY calls DESC`

const EMBEDDINGS_SQL = `SELECT specialist, model, dim,
       count(*)::int   AS entries,
       max(computed_at) AS last_at
FROM rvbbit.embedding_cache
GROUP BY specialist, model, dim
ORDER BY entries DESC`

const BITMAPS_SQL = `SELECT table_oid::regclass::text AS relation,
       predicate_name,
       model_version,
       count(*)::int       AS row_groups,
       coalesce(sum(n_set), 0)::bigint   AS matches,
       coalesce(sum(n_total), 0)::bigint AS rows_total
FROM rvbbit.semantic_bitmaps
GROUP BY table_oid, predicate_name, model_version
ORDER BY rows_total DESC NULLS LAST
LIMIT 200`

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 2000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

function parseReceipts(
  res: QueryOk | QueryErr,
): { rows: ReceiptRollupRow[]; error: string | null } {
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      operator: String(r.operator ?? ""),
      model: r.model == null ? null : String(r.model),
      calls: num(r.calls),
      errors: num(r.errors),
      tokensIn: num(r.tokens_in),
      tokensOut: num(r.tokens_out),
      costUsd: num(r.cost_usd),
      avgLatencyMs: num(r.avg_ms),
      lastAt: epoch(r.last_at),
    })),
  }
}

function parseEmbeddings(
  res: QueryOk | QueryErr,
): { rows: EmbeddingRow[]; error: string | null } {
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      specialist: String(r.specialist ?? ""),
      model: r.model == null ? null : String(r.model),
      dim: num(r.dim),
      entries: num(r.entries),
      lastAt: epoch(r.last_at),
    })),
  }
}

function parseBitmaps(
  res: QueryOk | QueryErr,
): { rows: BitmapRow[]; error: string | null } {
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      relation: String(r.relation ?? ""),
      predicate: String(r.predicate_name ?? ""),
      modelVersion: r.model_version == null ? null : String(r.model_version),
      rowGroups: num(r.row_groups),
      nSet: num(r.matches),
      nTotal: num(r.rows_total),
    })),
  }
}

function deriveStats(
  receipts: ReceiptRollupRow[],
  embeddings: EmbeddingRow[],
  bitmaps: BitmapRow[],
): OverviewStats {
  const specs = new Set<string>()
  for (const e of embeddings) specs.add(e.specialist)
  return {
    receipts: {
      count: receipts.reduce((s, r) => s + r.calls, 0),
      cost: receipts.reduce((s, r) => s + r.costUsd, 0),
      tokensIn: receipts.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: receipts.reduce((s, r) => s + r.tokensOut, 0),
      errors: receipts.reduce((s, r) => s + r.errors, 0),
    },
    embeddings: {
      entries: embeddings.reduce((s, r) => s + r.entries, 0),
      specialists: specs.size,
    },
    bitmaps: {
      rowGroups: bitmaps.reduce((s, r) => s + r.rowGroups, 0),
      matches: bitmaps.reduce((s, r) => s + r.nSet, 0),
      total: bitmaps.reduce((s, r) => s + r.nTotal, 0),
    },
  }
}
