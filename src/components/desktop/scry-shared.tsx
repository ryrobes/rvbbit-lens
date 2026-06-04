import { Hash, Table2 } from "@/lib/icons"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"

/** `schema.rel` for a table hit, `schema.rel.col` for a column hit. */
export function hitLabel(h: DataSearchHit): string {
  return h.col ? `${h.schema}.${h.rel}.${h.col}` : `${h.schema}.${h.rel}`
}

/** Tiny kind glyph — table vs column — shared by the prompt and the window. */
export function KindBadge({ kind }: { kind: DataSearchHit["kind"] }) {
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

/** Amber-phosphor similarity meter. `null` score = the ILIKE fallback ran. */
export function ScoreBar({ score }: { score: number | null }) {
  if (score == null) {
    return <span className="text-[9px] uppercase tracking-wide text-chrome-text/35">ilike</span>
  }
  const pct = Math.max(0, Math.min(100, Math.round(score * 100)))
  return (
    <span className="flex items-center gap-1" title={`similarity ${pct}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-foreground/[0.08]">
        <span className="block h-full rounded-full bg-terminal" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-6 text-right text-[9px] tabular-nums text-chrome-text/50">{pct}</span>
    </span>
  )
}
