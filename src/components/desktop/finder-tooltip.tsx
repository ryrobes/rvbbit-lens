"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { SchemaTable } from "@/lib/db/types"
import { FLAG_META, TONE_CLASS, driftSeverityColor } from "@/lib/rvbbit/drift-flags"
import { fmtAgo, fmtBytes, iconForTable } from "@/lib/rvbbit/finder-format"

/* ──────────────────────────── storage model ──────────────────────────── */

interface FootprintSeg {
  key: string
  label: string
  bytes: number
  color: string
  /** heap pages may transiently overlap uncompacted rows while the shadow heap is dirty. */
  stale?: boolean
}

// The five DISJOINT tiers that sum to the real footprint. Order = stacked order.
const SEG_DEFS: Array<{ key: string; label: string; field: keyof SchemaTable; color: string }> = [
  { key: "heap", label: "heap", field: "heapBytes", color: "var(--info)" },
  { key: "hot", label: "parquet · hot", field: "hotParquetBytes", color: "var(--rvbbit-accent)" },
  { key: "cold", label: "parquet · cold", field: "coldBytes", color: "var(--chart-1)" },
  { key: "index", label: "indexes", field: "indexBytes", color: "var(--terminal-dim)" },
  { key: "toast", label: "toast", field: "toastBytes", color: "var(--chart-5)" },
]

// Redundant accelerator COPIES — never summed into the footprint total.
const COPY_DEFS: Array<{ key: string; label: string; field: keyof SchemaTable; color: string }> = [
  { key: "vortex", label: "vortex copy", field: "vortexBytes", color: "var(--chart-4)" },
  { key: "variants", label: "alt-layout copies", field: "variantBytes", color: "var(--chart-3)" },
]

function asBytes(v: unknown): number {
  const n = typeof v === "number" ? v : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

interface Footprint {
  segments: FootprintSeg[]
  total: number
  copies: FootprintSeg[]
  lanceUntracked: boolean
}

function buildFootprint(t: SchemaTable): Footprint {
  const stale = !!t.isRvbbit && t.freshness === "stale"
  const segments: FootprintSeg[] = SEG_DEFS.map((d) => ({
    key: d.key,
    label: d.label,
    bytes: asBytes(t[d.field]),
    color: d.color,
    stale: d.key === "heap" && stale,
  })).filter((s) => s.bytes > 0)
  const total = segments.reduce((acc, s) => acc + s.bytes, 0)
  const copies: FootprintSeg[] = COPY_DEFS.map((d) => ({
    key: d.key,
    label: d.label,
    bytes: asBytes(t[d.field]),
    color: d.color,
  })).filter((s) => s.bytes > 0)
  return { segments, total, copies, lanceUntracked: !!t.lanceEnabled }
}

/* ──────────────────────────── hover hook ──────────────────────────── */

export interface HoverTarget {
  table: SchemaTable
  rect: DOMRect
}

/**
 * Intent-friendly hover-card controller: a short open delay (so fast scroll-scans
 * don't flicker cards), a tiny close grace period, and dismiss-on-scroll/escape.
 * The card itself is pointer-events:none, so there's no enter/leave bookkeeping on it.
 */
export function useFinderHoverCard() {
  const [target, setTarget] = useState<HoverTarget | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const clearOpen = () => {
    if (openTimer.current != null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  const clearClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const open = useCallback((table: SchemaTable, el: HTMLElement) => {
    clearClose()
    clearOpen()
    const rect = el.getBoundingClientRect()
    openTimer.current = window.setTimeout(() => setTarget({ table, rect }), 350)
  }, [])

  const close = useCallback(() => {
    clearOpen()
    clearClose()
    closeTimer.current = window.setTimeout(() => setTarget(null), 120)
  }, [])

  const dismiss = useCallback(() => {
    clearOpen()
    clearClose()
    setTarget(null)
  }, [])

  // Escape closes immediately while a card is open.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [target, dismiss])

  // Drop any pending/open card on unmount.
  useEffect(() => () => {
    clearOpen()
    clearClose()
  }, [])

  return { target, open, close, dismiss }
}

/* ──────────────────────────── shared drift chips ──────────────────────────── */

export function DriftChips({ flags }: { flags: string[] }) {
  const known = flags.filter((f) => f in FLAG_META)
  if (known.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[9px] text-chrome-text/45">drift:</span>
      {known.map((f) => (
        <span key={f} className={`rounded-full px-1.5 py-0.5 text-[9px] ${TONE_CLASS[FLAG_META[f].tone]}`}>
          {FLAG_META[f].label}
        </span>
      ))}
    </div>
  )
}

/* ──────────────────────────── the card ──────────────────────────── */

const CARD_W = 300

export function FinderTooltip({ table, anchor }: { table: SchemaTable; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({ left: 0, top: 0, ready: false })

  // Measure self, then place: right-aligned to the anchor, flipping above if it
  // would overflow the bottom, clamped inside the viewport on both axes.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cw = el.offsetWidth || CARD_W
    const ch = el.offsetHeight
    const m = 8
    let left = anchor.right - cw
    left = Math.min(Math.max(m, left), window.innerWidth - cw - m)
    let top = anchor.bottom + 6
    if (top + ch > window.innerHeight - m) {
      const above = anchor.top - ch - 6
      top = above >= m ? above : Math.max(m, window.innerHeight - ch - m)
    }
    setPos({ left, top, ready: true })
  }, [anchor])

  if (typeof document === "undefined") return null

  const Icon = iconForTable(table)
  const fp = buildFootprint(table)
  const isRvbbit = !!table.isRvbbit
  // Kinds with no local heap of their own — show a precise reason instead of the
  // empty-footprint "no on-disk footprint yet" (which implies a pending compaction).
  const noStorageMsg =
    table.kind === "view"
      ? "view · no on-disk storage"
      : table.kind === "foreign"
        ? "foreign table · no local storage"
        : table.kind === "partition"
          ? "partitioned parent · data in child partitions"
          : null
  const typeChip = isRvbbit ? "rvbbit" : table.kind

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: CARD_W,
        visibility: pos.ready ? "visible" : "hidden",
      }}
      className="pointer-events-none z-50 max-h-[80vh] overflow-y-auto rounded-md border border-chrome-border bg-chrome-bg/95 p-2.5 text-chrome-text shadow-lg backdrop-blur-md motion-safe:duration-100"
    >
      {/* header */}
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${isRvbbit ? "text-rvbbit-accent" : "text-chrome-text/70"}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {table.schema}.{table.name}
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0 text-[8px] uppercase tracking-wide ${
            isRvbbit ? "border-rvbbit-accent/40 text-rvbbit-accent" : "border-chrome-border text-chrome-text/55"
          }`}
        >
          {typeChip}
        </span>
      </div>

      {/* footprint */}
      {noStorageMsg ? (
        <div className="mt-2 text-[10px] text-chrome-text/45">{noStorageMsg}</div>
      ) : (
        <FootprintBar fp={fp} />
      )}

      {/* vitals */}
      <Vitals table={table} />
    </div>,
    document.body,
  )
}

function FootprintBar({ fp }: { fp: Footprint }) {
  const { segments, total, copies, lanceUntracked } = fp
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-wide text-chrome-text/45">on-disk footprint</span>
        <span className="font-mono text-[11px] tabular-nums text-foreground">
          {total > 0 ? fmtBytes(total) : "—"}
        </span>
      </div>
      {/* stacked bar — flexGrow keeps proportions, minWidth keeps tiny tiers visible */}
      {total > 0 ? (
        <div className="mt-1 flex h-2 overflow-hidden rounded-full ring-1 ring-foreground/10">
          {segments.map((s) => (
            <span
              key={s.key}
              style={{ flexGrow: s.bytes, flexBasis: 0, minWidth: 3, backgroundColor: s.color }}
              title={`${s.label} · ${fmtBytes(s.bytes)}`}
            />
          ))}
        </div>
      ) : (
        <div className="mt-1 flex h-2 items-center rounded-full bg-foreground/[0.06] px-2 text-[8px] text-chrome-text/40">
          no on-disk footprint yet
        </div>
      )}
      {/* legend */}
      {total > 0 ? (
        <div className="mt-1.5 space-y-0.5">
          {segments.map((s) => (
            <LegendRow key={s.key} color={s.color} label={s.label} bytes={s.bytes} pct={(s.bytes / total) * 100} stale={s.stale} />
          ))}
        </div>
      ) : null}
      {/* accelerator copies + lance — separated; NOT part of the total */}
      {copies.length > 0 || lanceUntracked ? (
        <div className="mt-1.5 border-t border-chrome-border/40 pt-1.5 space-y-0.5">
          {copies.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-[9px] text-chrome-text/45">
              <span className="h-2 w-2 shrink-0 rounded-[2px] opacity-60" style={{ backgroundColor: s.color }} />
              <span className="flex-1">{s.label}</span>
              <span className="tabular-nums">{fmtBytes(s.bytes)}</span>
              <span className="text-chrome-text/30">copy</span>
            </div>
          ))}
          {lanceUntracked ? (
            <div className="flex items-center gap-1.5 text-[9px] text-chrome-text/45">
              <span className="h-2 w-2 shrink-0 rounded-full ring-1 ring-chrome-text/30" />
              <span className="flex-1">vector index</span>
              <span className="italic text-chrome-text/30">size not tracked</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function LegendRow({
  color,
  label,
  bytes,
  pct,
  stale,
}: {
  color: string
  label: string
  bytes: number
  pct: number
  stale?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
      <span className="flex-1 text-chrome-text/70">
        {label}
        {stale ? <span className="ml-1 text-warning" title="shadow heap dirty — may overlap uncompacted rows">⚠</span> : null}
      </span>
      <span className="tabular-nums text-chrome-text/55">{fmtBytes(bytes)}</span>
      <span className="w-8 text-right tabular-nums text-chrome-text/35">{pct >= 0.5 ? `${Math.round(pct)}%` : "<1%"}</span>
    </div>
  )
}

function Vitals({ table }: { table: SchemaTable }) {
  const isRvbbit = !!table.isRvbbit
  const rows = rowsLine(table)
  const showFresh = isRvbbit && table.freshness && table.freshness !== "na"
  const showGen = isRvbbit && (table.generation != null || table.lastCompactAt)
  const showRg = isRvbbit && table.rgCount != null && table.rgCount > 0
  const showHeat = table.heat != null && table.heat > 0
  const showDrift = (table.driftFlags?.length ?? 0) > 0
  return (
    <div className="mt-2 border-t border-chrome-border/40 pt-1.5 font-mono text-[10px] text-chrome-text/60">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {rows ? <span className="text-chrome-text/75">{rows}</span> : null}
        {showFresh ? (
          <span className="inline-flex items-center gap-1">
            <span
              className="h-[5px] w-[5px] rounded-full"
              style={{ backgroundColor: table.freshness === "fresh" ? "var(--success)" : "var(--warning)" }}
            />
            {table.freshness === "fresh" ? "fresh" : "stale"}
          </span>
        ) : null}
        {showGen ? (
          <span>
            gen {table.generation ?? "—"}
            {table.lastCompactAt ? ` · compacted ${fmtAgo(table.lastCompactAt)}` : ""}
          </span>
        ) : null}
        {showRg ? (
          <span>
            {table.rgCount} rg{table.coldCount ? ` (${table.coldCount} cold)` : ""}
          </span>
        ) : null}
        {showHeat ? <span>{table.heat} queries · 7d</span> : null}
      </div>
      {showDrift ? (
        <div className="mt-1 flex items-center gap-1.5">
          {table.driftSeverity != null && table.driftSeverity > 0 ? (
            <span
              className="h-[5px] w-[5px] shrink-0 rounded-full"
              style={{ backgroundColor: driftSeverityColor(table.driftSeverity) }}
            />
          ) : null}
          <DriftChips flags={table.driftFlags!} />
        </div>
      ) : null}
    </div>
  )
}

function rowsLine(t: SchemaTable): string | null {
  if (t.kind === "view") return "view"
  if (t.kind === "matview") return "materialized view"
  if (t.rows == null) return null
  const n = t.rows.toLocaleString()
  const src =
    t.rowsSource === "crawl"
      ? `crawled ${fmtAgo(t.profiledAt)}`
      : t.rowsSource === "live"
        ? "live"
        : t.rowsSource === "estimate"
          ? "est."
          : ""
  return `${t.rowsSource === "estimate" ? "~" : ""}${n} rows${src ? ` · ${src}` : ""}`
}
