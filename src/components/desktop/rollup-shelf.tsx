"use client"

import { ChevronDown, Layers, Sigma, TreeStructure, X, type LucideIcon } from "@/lib/icons"
import type { RollupSpec } from "@/lib/desktop/types"
import {
  clearPivot,
  cycleMeasureAgg,
  measureLabel,
  removeGroupBy,
  removeMeasure,
} from "@/lib/desktop/sql-builder"
import { cn } from "@/lib/utils"

interface RollupShelfProps {
  spec: RollupSpec
  /** Apply a pure spec transform; the host rebuilds SQL + reruns. */
  onEdit: (transform: (s: RollupSpec) => RollupSpec) => void
}

/**
 * Editable view of a column-aggregate window's `RollupSpec` — the sibling
 * of the chart shelf and the params chip bar. Group-by and measure pills
 * are removable; measure pills cycle their aggregate on click; the pivot
 * chip shows its value count (with truncation) and clears on ✕. Every
 * edit flows back through `buildRollupQuery`, exactly like a drag merge.
 */
export function RollupShelf({ spec, onEdit }: RollupShelfProps) {
  const pivot = spec.pivot ?? null
  const showDivider = spec.groupBy.length > 0 && spec.measures.length > 0

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-chrome-border/60 bg-chrome-bg/40 px-2 py-1.5">
      <span className="select-none text-[9px] uppercase tracking-wider text-chrome-text/70">Rollup</span>

      {spec.groupBy.map((c) => (
        <Chip
          key={`g:${c.name}`}
          icon={Layers}
          iconClass="text-main/75"
          label={c.name}
          title={`GROUP BY ${c.name} · ✕ to remove`}
          onRemove={() => onEdit((s) => removeGroupBy(s, c.name))}
        />
      ))}

      {showDivider ? <span className="mx-0.5 h-3.5 w-px bg-chrome-border/60" /> : null}

      {spec.measures.map((m) => {
        const cyclable = !!m.column
        return (
          <Chip
            key={`m:${m.id}`}
            icon={Sigma}
            iconClass="text-chart-3"
            label={measureLabel(m)}
            cyclable={cyclable}
            title={cyclable
              ? `${measureLabel(m)} · click to change aggregate · ✕ to remove`
              : `${measureLabel(m)} · ✕ to remove`}
            onClick={cyclable ? () => onEdit((s) => cycleMeasureAgg(s, m.id)) : undefined}
            onRemove={() => onEdit((s) => removeMeasure(s, m.id))}
          />
        )
      })}

      {pivot ? (
        <>
          <span className="mx-0.5 h-3.5 w-px bg-chrome-border/60" />
          <Chip
            icon={TreeStructure}
            iconClass="text-rvbbit-accent"
            label={`${pivot.column.name} · ${pivot.values.length}${pivot.truncated ? "+" : ""}`}
            title={`pivoted across ${pivot.values.length}${pivot.truncated ? "+ (capped)" : ""} values of ${pivot.column.name} · ✕ to remove`}
            onRemove={() => onEdit(clearPivot)}
          />
        </>
      ) : null}
    </div>
  )
}

function Chip({
  icon: Icon,
  iconClass,
  label,
  title,
  cyclable,
  onClick,
  onRemove,
}: {
  icon: LucideIcon
  iconClass?: string
  label: string
  title: string
  cyclable?: boolean
  onClick?: () => void
  onRemove: () => void
}) {
  return (
    <span
      role={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        "group inline-flex max-w-[220px] items-center gap-1 rounded-full border border-chrome-border/50 bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors",
        onClick && "cursor-pointer hover:border-main/50",
      )}
    >
      <Icon className={cn("h-3 w-3 shrink-0", iconClass)} />
      <span className="truncate">{label}</span>
      {cyclable ? <ChevronDown className="h-2.5 w-2.5 shrink-0 text-chrome-text/40" /> : null}
      <span
        role="button"
        aria-label="remove"
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="ml-0.5 inline-grid h-3.5 w-3.5 place-items-center rounded-full text-chrome-text/55 hover:bg-danger/20 hover:text-danger"
      >
        <X className="h-2.5 w-2.5" />
      </span>
    </span>
  )
}
