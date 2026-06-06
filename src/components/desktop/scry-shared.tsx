"use client"

import type { ReactNode } from "react"
import { Hash, Table2, TreeStructure } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"

/** `schema.rel` for a table hit, `schema.rel.col` for a column hit. */
export function hitLabel(h: DataSearchHit): string {
  return h.col ? `${h.schema}.${h.rel}.${h.col}` : `${h.schema}.${h.rel}`
}

/**
 * Label to show on a node/rail row. The DATA layer's hits are KG entities living
 * in a synthetic "data" graph, so their `schema.rel` qualifier is noise — we show
 * the bare entity name. The structure layer keeps the fully-qualified identifier.
 */
export function displayLabel(h: DataSearchHit, dataLayer = false): string {
  if (dataLayer) return h.rel || h.doc || hitLabel(h)
  return hitLabel(h)
}

/**
 * Tiny kind glyph. Structure layer: table vs column. Data layer: every hit is an
 * extracted entity, so it gets one amber "entity" glyph (a graph node) — the
 * visual tell that you're exploring meaning, not schema.
 */
export function KindBadge({ kind, dataLayer = false }: { kind: DataSearchHit["kind"]; dataLayer?: boolean }) {
  if (dataLayer) {
    return (
      <span
        title="entity — extracted from the data"
        className="grid h-4 w-4 shrink-0 place-items-center rounded-sm bg-terminal/15 text-terminal/80"
      >
        <TreeStructure className="h-2.5 w-2.5" />
      </span>
    )
  }
  const Icon = kind === "db_table" ? Table2 : Hash
  return (
    <span
      title={kind === "db_table" ? "table" : "column"}
      className="grid h-4 w-4 shrink-0 place-items-center rounded-sm bg-foreground/[0.06] text-chrome-text/70"
    >
      <Icon className="h-2.5 w-2.5" />
    </span>
  )
}

/**
 * Small Warm-Ink action button shared by the Scry control cluster (and reusable
 * by node toolbars). Stops pointerdown so clicking it never arms a canvas pan.
 */
export function ScryActionButton({
  label,
  icon,
  onClick,
  active,
  disabled,
  danger,
  title,
}: {
  label?: string
  icon: ReactNode
  onClick: () => void
  active?: boolean
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
      }}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:opacity-40",
        active
          ? "bg-terminal/20 text-foreground"
          : "bg-block-bg text-chrome-text hover:text-foreground",
        danger ? "hover:bg-danger/15" : "hover:bg-terminal/15",
      )}
      style={{ borderColor: active ? "var(--terminal)" : "var(--chrome-border)" }}
    >
      {icon}
      {label ? <span className="font-mono">{label}</span> : null}
    </button>
  )
}

/**
 * Amber-phosphor relevance meter. The hybrid `data_search` always returns a
 * normalized RRF score, so the null branch below is just a defensive fallback
 * for malformed/empty rows (not a live "lexical-only" signal).
 */
export function ScoreBar({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-[9px] uppercase tracking-wide text-chrome-text/35">lex</span>
  }
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)))
  return (
    <span className="flex items-center gap-1" title={`relevance ${pct}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-foreground/[0.08]">
        <span className="block h-full rounded-full bg-terminal" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-6 text-right text-[9px] tabular-nums text-chrome-text/50">{pct}</span>
    </span>
  )
}
