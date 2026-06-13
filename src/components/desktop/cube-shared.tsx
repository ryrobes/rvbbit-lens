"use client"

// Shared building blocks for the Cube Studio apps (Catalog / Creator / Inspector).
// Re-exports the form-field kit + helpers from metric-shared (so the two studios stay visually
// identical) and adds cube-specific bits: a health pill, a drift gauge, and an inline
// column-doc editor (set_cube_column_doc).

import { useState } from "react"
import { Check, Loader2, Pencil } from "@/lib/icons"
import { setCubeColumnDoc, type CubeColumn, type CubeHealth } from "@/lib/rvbbit/cubes"

export {
  Field,
  Section,
  StatusNote,
  formatSqlSafe,
  fmtTime,
  inputCls,
  areaCls,
} from "./metric-shared"

/** Cube freshness pill: fresh=green / dirty,stale=amber / error,missing=red. */
export function HealthBadge({
  status,
  size = "sm",
}: {
  status: string | null | undefined
  size?: "sm" | "md"
}) {
  if (!status) return null
  const tone =
    status === "fresh"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-500"
      : status === "dirty" || status === "stale"
        ? "border-amber-500/40 bg-amber-500/15 text-amber-500"
        : status === "error" || status === "missing"
          ? "border-danger/40 bg-danger/15 text-danger"
          : "border-foreground/20 bg-foreground/[0.06] text-chrome-text/60"
  const sz = size === "md" ? "px-2 py-0.5 text-[11px]" : "px-1.5 py-px text-[10px]"
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium uppercase tracking-wide ${tone} ${sz}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  )
}

/** Compact drift readout: a 0–1 ratio bar + the engine's refresh recommendation. */
export function DriftGauge({
  ratio,
  recommendation,
}: {
  ratio: number | null | undefined
  recommendation: string | null | undefined
}) {
  const r = ratio == null || !Number.isFinite(ratio) ? null : Math.max(0, Math.min(1, ratio))
  const tone =
    r == null ? "bg-foreground/20" : r < 0.1 ? "bg-emerald-500" : r < 0.5 ? "bg-amber-500" : "bg-danger"
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/[0.08]">
        <div className={`h-full ${tone}`} style={{ width: `${(r ?? 0) * 100}%` }} />
      </div>
      <span className="tabular-nums text-[11px] text-chrome-text/70">
        {r == null ? "—" : `${(r * 100).toFixed(1)}%`}
      </span>
      {recommendation ? (
        <span className="text-[10px] uppercase tracking-wide text-chrome-text/50">{recommendation}</span>
      ) : null}
    </div>
  )
}

/** Small "who wrote this doc" tag: pack (curated) / human / LLM-drafted. */
export function ProvenanceTag({ editedBy }: { editedBy: string | null | undefined }) {
  const label = editedBy == null ? "llm" : editedBy
  const tone =
    editedBy == null
      ? "text-chrome-text/40"
      : editedBy === "pack"
        ? "text-main/80"
        : "text-emerald-500/80"
  return <span className={`text-[9px] uppercase tracking-wider ${tone}`}>{label}</span>
}

/**
 * Inline editor for one cube column's doc + semantics (set_cube_column_doc → marks edited_by so
 * a later enrich_cube preserves it). Collapsed it shows the doc + a pencil; expanded it shows two
 * fields + Save. The parent reloads on save.
 */
export function CubeColumnDocEditor({
  connectionId,
  cube,
  column,
  onSaved,
}: {
  connectionId: string
  cube: string
  column: CubeColumn
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [doc, setDoc] = useState(column.doc ?? "")
  const [semantics, setSemantics] = useState(column.semantics ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const { ok, error: err } = await setCubeColumnDoc(connectionId, cube, column.name, {
      doc: doc.trim() || null,
      semantics: semantics.trim() || null,
      editor: "human",
    })
    setSaving(false)
    if (!ok) {
      setError(err)
      return
    }
    setOpen(false)
    onSaved()
  }

  const areaCls =
    "w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1 font-mono text-[11px] leading-snug text-foreground outline-none focus:border-main/50 focus:bg-foreground/[0.06]"

  if (!open) {
    return (
      <div className="group/cell flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <span className="block text-chrome-text/75">
            {column.doc ?? <span className="text-chrome-text/30">—</span>}
          </span>
          {column.semantics ? (
            <span className="mt-0.5 block text-[10px] italic text-chrome-text/45">{column.semantics}</span>
          ) : null}
        </div>
        <button
          type="button"
          title="Edit doc"
          onClick={() => setOpen(true)}
          className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/[0.08] hover:text-foreground group-hover/cell:opacity-100"
        >
          <Pencil className="h-2.5 w-2.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <textarea
        className={`${areaCls} h-12`}
        spellCheck={false}
        value={doc}
        onChange={(e) => setDoc(e.target.value)}
        placeholder="what this column is"
      />
      <textarea
        className={`${areaCls} h-10`}
        spellCheck={false}
        value={semantics}
        onChange={(e) => setSemantics(e.target.value)}
        placeholder="semantics / how to use it (optional)"
      />
      {error ? <div className="text-[10px] text-danger">{error}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex h-6 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[10px] text-main hover:bg-main/25 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />} Save
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[10px] text-chrome-text/50 hover:text-foreground"
        >
          cancel
        </button>
      </div>
    </div>
  )
}

/** A small read-only stat cell for the Health tab. */
export function HealthStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02] px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] text-foreground">{value}</div>
    </div>
  )
}

/** Format seconds as a coarse "x ago" string for the health tab. */
export function fmtAgo(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—"
  const s = Math.max(0, Math.floor(seconds))
  if (s < 90) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export type { CubeColumn, CubeHealth }
