"use client"

/**
 * Tableau-style shelf editor for a Vega-Lite spec.
 *
 * Source of truth is the Vega-Lite spec object itself — the shelves are a
 * round-tripping projection of that spec via `shelfFromSpec` /
 * `specFromShelf`. Anything the shelf doesn't understand is preserved in
 * `state.residual` so it survives an edit.
 *
 * Bret-Victor touches:
 *  - Every shelf interaction writes through immediately (no "Apply" button).
 *  - Pill captions update live as you change aggregate / type / timeUnit.
 *  - Hovering a field highlights it in the chart axis context.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Calendar,
  Check,
  Filter,
  Hash,
  Search,
  Sparkles,
  Tag,
  X,
} from "@/lib/icons"
import type { QueryResultColumn } from "@/lib/db/types"
import { classifyColumn, type ColumnRole } from "@/lib/desktop/chart-infer"
import {
  AGGREGATE_OPS,
  countPill,
  defaultVegaType,
  filterCaption,
  isDimPill,
  MARK_TYPES,
  MULTI_DIM_JOIN_SEP,
  pillCaption,
  pillFromColumn,
  shelfFromSpec,
  specFromShelf,
  suggestedMarks,
  TIME_UNITS,
  type AggregateOp,
  type ChannelPill,
  type FilterOp,
  type FilterPill,
  type MarkType,
  type ShelfChannel,
  type ShelfState,
  type StackMode,
  type TimeUnit,
  type VegaType,
} from "@/lib/desktop/chart-shelf"

interface ChartShelfProps {
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  /** The current persisted spec (may be null when auto-inferred). */
  spec: Record<string, unknown> | null
  /**
   * Called when any shelf interaction produces a new spec. The host
   * persists this as the user-spec.
   */
  onChangeSpec: (next: Record<string, unknown>) => void
  /** Children = the live chart canvas, rendered below the shelves. */
  children: React.ReactNode
}

// ── Top component ───────────────────────────────────────────────────

export function ChartShelf({
  columns,
  rows,
  spec,
  onChangeSpec,
  children,
}: ChartShelfProps) {
  // Parsed shelf state — derived from spec. Editing the shelf produces a
  // new spec which is written via onChangeSpec; the next render re-parses.
  const state = useMemo<ShelfState>(() => shelfFromSpec(spec), [spec])

  // Drag-and-drop hover/active state for visual feedback only.
  const [hoverChannel, setHoverChannel] = useState<ShelfChannel | "filter" | null>(null)
  const [hoverField, setHoverField] = useState<string | null>(null)

  const apply = useCallback(
    (mutator: (s: ShelfState) => ShelfState) => {
      const next = mutator(state)
      onChangeSpec(specFromShelf(next))
    },
    [state, onChangeSpec],
  )

  // ── Pill mutations ────────────────────────────────────────────────

  const setMark = useCallback(
    (mark: ShelfState["mark"]) => apply((s) => ({ ...s, mark })),
    [apply],
  )
  const setSingle = useCallback(
    (channel: "color" | "size" | "shape", pill: ChannelPill | null) =>
      apply((s) => ({ ...s, [channel]: pill })),
    [apply],
  )
  const setPositional = useCallback(
    (channel: "x" | "y", pills: ChannelPill[]) =>
      apply((s) => ({ ...s, [channel]: pills })),
    [apply],
  )
  const setTooltip = useCallback(
    (pills: ChannelPill[]) => apply((s) => ({ ...s, tooltip: pills })),
    [apply],
  )
  const setFilters = useCallback(
    (filters: FilterPill[]) => apply((s) => ({ ...s, filters })),
    [apply],
  )

  // Drop a field column onto a channel.
  //
  // For x/y the multi-pill invariant is: every pill is a dim, or there is
  // exactly one measure/temporal pill. Drops that violate that rewrite the
  // shelf to a single pill (the user's most recent intent wins). This keeps
  // the shelf state always emittable as legal Vega-Lite — no half-built
  // calc-concat where one of the joined fields needs an aggregate.
  const dropFieldOn = useCallback(
    (channel: ShelfChannel | "filter", colName: string) => {
      const col = columns.find((c) => c.name === colName)
      if (!col) return
      if (channel === "filter") {
        const role = classifyColumn(col)
        const next: FilterPill = {
          field: col.name,
          type: defaultVegaType(role),
          op: role === "numeric" || role === "temporal" ? "between" : "eq",
        }
        apply((s) =>
          s.filters.some((f) => f.field === col.name)
            ? s
            : { ...s, filters: [...s.filters, next] },
        )
        return
      }
      const pill = pillFromColumn(col, { channel })
      if (channel === "tooltip") {
        apply((s) =>
          s.tooltip.some((p) => p.field === col.name && p.aggregate === pill.aggregate)
            ? s
            : { ...s, tooltip: [...s.tooltip, pill] },
        )
        return
      }
      if (channel === "x" || channel === "y") {
        apply((s) => {
          const current = s[channel]
          if (current.length === 0) return { ...s, [channel]: [pill] }
          const allDimsNow = current.every(isDimPill)
          const newIsDim = isDimPill(pill)
          if (allDimsNow && newIsDim) {
            if (current.some((p) => p.field === pill.field)) return s
            return { ...s, [channel]: [...current, pill] }
          }
          return { ...s, [channel]: [pill] }
        })
        return
      }
      setSingle(channel, pill)
    },
    [apply, columns, setSingle],
  )

  // Native-DnD handlers — encode the field as a custom MIME so other
  // desktop drag flows don't accidentally trigger this drop target.
  const handleDragOver = useCallback(
    (e: React.DragEvent, channel: ShelfChannel | "filter") => {
      if (e.dataTransfer.types.includes(FIELD_MIME)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setHoverChannel(channel)
      }
    },
    [],
  )
  const handleDrop = useCallback(
    (e: React.DragEvent, channel: ShelfChannel | "filter") => {
      const name = e.dataTransfer.getData(FIELD_MIME)
      setHoverChannel(null)
      if (name) {
        e.preventDefault()
        dropFieldOn(channel, name)
      }
    },
    [dropFieldOn],
  )
  const handleDragLeave = useCallback(() => setHoverChannel(null), [])

  // Suggested marks (helpful hint, not enforced)
  const goodMarks = useMemo(() => new Set(suggestedMarks(state)), [state])

  return (
    <div className="flex min-h-0 flex-1 bg-doc-bg">
      <FieldRail
        columns={columns}
        rows={rows}
        hoverField={hoverField}
        onHoverField={setHoverField}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <ShelvesStrip
          state={state}
          columns={columns}
          rows={rows}
          hoverChannel={hoverChannel}
          goodMarks={goodMarks}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={handleDragLeave}
          onSetMark={setMark}
          onSetPositional={setPositional}
          onSetSingle={setSingle}
          onSetTooltip={setTooltip}
          onSetFilters={setFilters}
        />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

// ── DnD mime ───────────────────────────────────────────────────────

const FIELD_MIME = "application/x-rvbbit-chart-field"

// ── Role glyph ─────────────────────────────────────────────────────

function RoleGlyph({ role, className }: { role: ColumnRole; className?: string }) {
  const map: Record<ColumnRole, { icon: React.ComponentType<{ className?: string }>; color: string; title: string }> = {
    numeric: { icon: Hash, color: "var(--chart-1)", title: "numeric" },
    temporal: { icon: Calendar, color: "var(--chart-3)", title: "temporal" },
    categorical: { icon: Tag, color: "var(--chart-4)", title: "categorical" },
    boolean: { icon: Check, color: "var(--chart-2)", title: "boolean" },
    unknown: { icon: Tag, color: "var(--chrome-text)", title: "unknown" },
  }
  const m = map[role]
  const Ic = m.icon
  return (
    <span
      title={m.title}
      className={cn("inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center", className)}
      style={{ color: m.color }}
    >
      <Ic className="h-3 w-3" />
    </span>
  )
}

function TypeGlyph({ type, className }: { type: VegaType; className?: string }) {
  const role: ColumnRole =
    type === "quantitative"
      ? "numeric"
      : type === "temporal"
        ? "temporal"
        : type === "ordinal"
          ? "categorical"
          : "categorical"
  return <RoleGlyph role={role} className={className} />
}

// ── Field rail ─────────────────────────────────────────────────────

function FieldRail({
  columns,
  rows,
  hoverField,
  onHoverField,
}: {
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  hoverField: string | null
  onHoverField: (name: string | null) => void
}) {
  const [q, setQ] = useState("")
  const filtered = useMemo(() => {
    const lo = q.trim().toLowerCase()
    if (!lo) return columns
    return columns.filter((c) => c.name.toLowerCase().includes(lo))
  }, [columns, q])

  // Pre-classify so we can stable-sort and show the role glyph.
  const items = useMemo(
    () =>
      filtered.map((c) => ({
        col: c,
        role: classifyColumn(c),
        sample: rows.length > 0 ? rows[0][c.name] : null,
      })),
    [filtered, rows],
  )

  return (
    <div className="flex w-[164px] shrink-0 flex-col border-r border-chrome-border/60 bg-chrome-bg/40">
      <div className="flex items-center gap-1 border-b border-chrome-border/40 px-2 py-1">
        <Search className="h-3 w-3 text-chrome-text/55" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="fields"
          className="w-full bg-transparent text-[11px] text-foreground outline-none placeholder:text-chrome-text/40"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-0.5">
        {items.length === 0 ? (
          <div className="px-2 py-3 text-[10px] text-chrome-text/45">no fields</div>
        ) : (
          items.map(({ col, role, sample }) => (
            <FieldCard
              key={col.name}
              column={col}
              role={role}
              sample={sample}
              hovered={hoverField === col.name}
              onHover={onHoverField}
            />
          ))
        )}
      </div>
    </div>
  )
}

function FieldCard({
  column,
  role,
  sample,
  hovered,
  onHover,
}: {
  column: QueryResultColumn
  role: ColumnRole
  sample: unknown
  hovered: boolean
  onHover: (name: string | null) => void
}) {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(FIELD_MIME, column.name)
    e.dataTransfer.effectAllowed = "copy"
  }
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onMouseEnter={() => onHover(column.name)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "group flex cursor-grab items-center gap-1.5 px-2 py-1 text-[11px] active:cursor-grabbing",
        hovered ? "bg-foreground/[0.06] text-foreground" : "text-chrome-text/90 hover:bg-foreground/[0.04]",
      )}
      title={`${column.name} · ${column.dataTypeName ?? `oid:${column.dataTypeId}`}${
        sample != null ? `\nsample: ${truncateValue(sample)}` : ""
      }`}
    >
      <RoleGlyph role={role} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{column.name}</span>
    </div>
  )
}

function truncateValue(v: unknown): string {
  const s = v == null ? "" : String(v)
  return s.length > 24 ? `${s.slice(0, 23)}…` : s
}

// ── Shelves strip ──────────────────────────────────────────────────

interface ShelvesProps {
  state: ShelfState
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  hoverChannel: ShelfChannel | "filter" | null
  goodMarks: Set<MarkType>
  onDragOver: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDrop: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDragLeave: () => void
  onSetMark: (mark: ShelfState["mark"]) => void
  onSetPositional: (channel: "x" | "y", pills: ChannelPill[]) => void
  onSetSingle: (channel: "color" | "size" | "shape", pill: ChannelPill | null) => void
  onSetTooltip: (pills: ChannelPill[]) => void
  onSetFilters: (filters: FilterPill[]) => void
}

function ShelvesStrip(props: ShelvesProps) {
  const {
    state,
    columns,
    rows,
    hoverChannel,
    goodMarks,
    onDragOver,
    onDrop,
    onDragLeave,
    onSetMark,
    onSetPositional,
    onSetSingle,
    onSetTooltip,
    onSetFilters,
  } = props

  return (
    <div className="space-y-0.5 border-b border-chrome-border/60 bg-chrome-bg/30 p-1.5">
      <MarkRow
        mark={state.mark}
        goodMarks={goodMarks}
        canStack={state.color != null || state.mark.type === "bar" || state.mark.type === "area"}
        onChange={onSetMark}
      />
      <PositionalShelf
        label="Columns"
        channel="x"
        pills={state.x}
        hovered={hoverChannel === "x"}
        columns={columns}
        rows={rows}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        onChange={(pills) => onSetPositional("x", pills)}
      />
      <PositionalShelf
        label="Rows"
        channel="y"
        pills={state.y}
        hovered={hoverChannel === "y"}
        columns={columns}
        rows={rows}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        onChange={(pills) => onSetPositional("y", pills)}
        showCountShortcut
      />
      <div className="grid grid-cols-3 gap-0.5">
        <SingleShelf
          label="Color"
          channel="color"
          pill={state.color}
          hovered={hoverChannel === "color"}
          columns={columns}
          rows={rows}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragLeave={onDragLeave}
          onChange={(p) => onSetSingle("color", p)}
          compact
        />
        <SingleShelf
          label="Size"
          channel="size"
          pill={state.size}
          hovered={hoverChannel === "size"}
          columns={columns}
          rows={rows}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragLeave={onDragLeave}
          onChange={(p) => onSetSingle("size", p)}
          compact
        />
        <SingleShelf
          label="Shape"
          channel="shape"
          pill={state.shape}
          hovered={hoverChannel === "shape"}
          columns={columns}
          rows={rows}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragLeave={onDragLeave}
          onChange={(p) => onSetSingle("shape", p)}
          compact
        />
      </div>
      <MultiShelf
        label="Tooltip"
        channel="tooltip"
        pills={state.tooltip}
        hovered={hoverChannel === "tooltip"}
        columns={columns}
        rows={rows}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        onChange={onSetTooltip}
      />
      <FilterShelf
        filters={state.filters}
        hovered={hoverChannel === "filter"}
        columns={columns}
        rows={rows}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
        onChange={onSetFilters}
      />
    </div>
  )
}

// ── Mark row ───────────────────────────────────────────────────────

function MarkRow({
  mark,
  goodMarks,
  canStack,
  onChange,
}: {
  mark: ShelfState["mark"]
  goodMarks: Set<MarkType>
  canStack: boolean
  onChange: (m: ShelfState["mark"]) => void
}) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-chrome-border/40 bg-secondary-background/40 px-1.5 py-1">
      <span className="flex w-[70px] shrink-0 items-center gap-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
        <Sparkles className="h-3 w-3 text-rvbbit-accent" />
        Mark
      </span>
      <div className="flex flex-wrap items-center gap-0.5">
        {MARK_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange({ ...mark, type: t })}
            title={`mark: ${t}${goodMarks.has(t) ? " (suggested)" : ""}`}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px]",
              mark.type === t
                ? "border-rvbbit-accent/60 bg-rvbbit-bg text-foreground"
                : goodMarks.has(t)
                  ? "border-chrome-border/40 bg-doc-bg text-chrome-text/85 hover:border-rvbbit-accent/40"
                  : "border-chrome-border/30 bg-doc-bg text-chrome-text/45 hover:text-chrome-text/85",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {/* Stack toggle */}
      {(mark.type === "bar" || mark.type === "area") && canStack ? (
        <div className="ml-auto flex items-center gap-1 rounded border border-chrome-border/40 bg-doc-bg p-0.5 text-[9px]">
          {(["zero", "normalize", null] as const).map((s) => (
            <button
              key={String(s)}
              type="button"
              onClick={() => onChange({ ...mark, stack: s as StackMode })}
              className={cn(
                "rounded px-1 py-px font-mono",
                mark.stack === s
                  ? "bg-rvbbit-accent/20 text-foreground"
                  : "text-chrome-text/60 hover:text-foreground",
              )}
              title={
                s === "zero" ? "stacked" : s === "normalize" ? "100% normalized" : "side-by-side"
              }
            >
              {s === "zero" ? "▤" : s === "normalize" ? "▥" : "▦"}
            </button>
          ))}
        </div>
      ) : null}
      {/* Per-mark accents */}
      {mark.type === "line" ? (
        <label className="ml-auto inline-flex items-center gap-1 text-[9px] text-chrome-text/70">
          <input
            type="checkbox"
            checked={mark.point === true}
            onChange={(e) => onChange({ ...mark, point: e.target.checked })}
          />
          points
        </label>
      ) : null}
    </div>
  )
}

// ── Single-pill shelf (color / size / shape) ───────────────────────

function SingleShelf({
  label,
  channel,
  pill,
  hovered,
  columns,
  rows,
  onDragOver,
  onDrop,
  onDragLeave,
  onChange,
  compact,
}: {
  label: string
  channel: "color" | "size" | "shape"
  pill: ChannelPill | null
  hovered: boolean
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  onDragOver: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDrop: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDragLeave: () => void
  onChange: (pill: ChannelPill | null) => void
  compact?: boolean
}) {
  return (
    <div
      onDragOver={(e) => onDragOver(e, channel)}
      onDrop={(e) => onDrop(e, channel)}
      onDragLeave={onDragLeave}
      className={cn(
        "flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors",
        hovered
          ? "border-rvbbit-accent/60 bg-rvbbit-bg/40"
          : "border-chrome-border/40 bg-secondary-background/30",
      )}
    >
      <span
        className={cn(
          "shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55",
          compact ? "w-[40px]" : "w-[70px]",
        )}
      >
        {label}
      </span>
      {pill ? (
        <Pill
          pill={pill}
          columns={columns}
          rows={rows}
          channel={channel}
          onChange={(p) => onChange(p)}
          onRemove={() => onChange(null)}
        />
      ) : (
        <span className="rounded border border-dashed border-chrome-border/40 px-1.5 py-0.5 text-[10px] text-chrome-text/45">
          drop a field
        </span>
      )}
    </div>
  )
}

// ── Positional shelf (Columns / Rows — multi-pill, Tableau-style) ───

function PositionalShelf({
  label,
  channel,
  pills,
  hovered,
  columns,
  rows,
  onDragOver,
  onDrop,
  onDragLeave,
  onChange,
  showCountShortcut,
}: {
  label: string
  channel: "x" | "y"
  pills: ChannelPill[]
  hovered: boolean
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  onDragOver: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDrop: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDragLeave: () => void
  onChange: (pills: ChannelPill[]) => void
  showCountShortcut?: boolean
}) {
  const isNested = pills.length >= 2
  return (
    <div
      onDragOver={(e) => onDragOver(e, channel)}
      onDrop={(e) => onDrop(e, channel)}
      onDragLeave={onDragLeave}
      className={cn(
        "flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors",
        hovered
          ? "border-rvbbit-accent/60 bg-rvbbit-bg/40"
          : "border-chrome-border/40 bg-secondary-background/30",
      )}
    >
      <span className="w-[70px] shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {pills.length === 0 ? (
          <>
            <span className="rounded border border-dashed border-chrome-border/40 px-1.5 py-0.5 text-[10px] text-chrome-text/45">
              drop a field
            </span>
            {showCountShortcut ? (
              <button
                type="button"
                onClick={() => onChange([countPill(channel)])}
                className="rounded border border-chrome-border/40 bg-doc-bg px-1.5 py-0.5 text-[10px] text-chrome-text/85 hover:border-rvbbit-accent/40 hover:text-foreground"
                title="Use count(*) — no field needed"
              >
                count(*)
              </button>
            ) : null}
          </>
        ) : (
          pills.map((p, i) => (
            <span key={`${p.field}/${i}`} className="inline-flex items-center gap-1">
              {i > 0 ? (
                <span
                  className="font-mono text-[10px] text-chrome-text/50"
                  title="nested dim — joined as a single axis"
                >
                  {MULTI_DIM_JOIN_SEP.trim()}
                </span>
              ) : null}
              <Pill
                pill={p}
                columns={columns}
                rows={rows}
                channel={channel}
                multiDim={isNested}
                onChange={(next) => {
                  const copy = [...pills]
                  copy[i] = next
                  // If user gave the edited pill an aggregate / quantitative /
                  // temporal type, the multi-dim invariant breaks — collapse
                  // to just this pill.
                  if (isNested && !isDimPill(next)) {
                    onChange([next])
                    return
                  }
                  onChange(copy)
                }}
                onRemove={() => onChange(pills.filter((_, j) => j !== i))}
              />
            </span>
          ))
        )}
      </div>
    </div>
  )
}

// ── Multi-pill shelf (Tooltip) ─────────────────────────────────────

function MultiShelf({
  label,
  channel,
  pills,
  hovered,
  columns,
  rows,
  onDragOver,
  onDrop,
  onDragLeave,
  onChange,
}: {
  label: string
  channel: "tooltip"
  pills: ChannelPill[]
  hovered: boolean
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  onDragOver: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDrop: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDragLeave: () => void
  onChange: (pills: ChannelPill[]) => void
}) {
  return (
    <div
      onDragOver={(e) => onDragOver(e, channel)}
      onDrop={(e) => onDrop(e, channel)}
      onDragLeave={onDragLeave}
      className={cn(
        "flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors",
        hovered
          ? "border-rvbbit-accent/60 bg-rvbbit-bg/40"
          : "border-chrome-border/40 bg-secondary-background/30",
      )}
    >
      <span className="w-[70px] shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {pills.length === 0 ? (
          <span className="rounded border border-dashed border-chrome-border/40 px-1.5 py-0.5 text-[10px] text-chrome-text/45">
            drop fields
          </span>
        ) : (
          pills.map((p, i) => (
            <Pill
              key={`${p.field}/${p.aggregate ?? "none"}/${i}`}
              pill={p}
              columns={columns}
              rows={rows}
              channel={channel}
              onChange={(next) => {
                const copy = [...pills]
                copy[i] = next
                onChange(copy)
              }}
              onRemove={() => onChange(pills.filter((_, j) => j !== i))}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Filter shelf ───────────────────────────────────────────────────

function FilterShelf({
  filters,
  hovered,
  columns,
  rows,
  onDragOver,
  onDrop,
  onDragLeave,
  onChange,
}: {
  filters: FilterPill[]
  hovered: boolean
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  onDragOver: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDrop: (e: React.DragEvent, channel: ShelfChannel | "filter") => void
  onDragLeave: () => void
  onChange: (filters: FilterPill[]) => void
}) {
  return (
    <div
      onDragOver={(e) => onDragOver(e, "filter")}
      onDrop={(e) => onDrop(e, "filter")}
      onDragLeave={onDragLeave}
      className={cn(
        "flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors",
        hovered
          ? "border-rvbbit-accent/60 bg-rvbbit-bg/40"
          : "border-chrome-border/40 bg-secondary-background/30",
      )}
    >
      <span className="flex w-[70px] shrink-0 items-center gap-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
        <Filter className="h-3 w-3" />
        Filters
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {filters.length === 0 ? (
          <span className="rounded border border-dashed border-chrome-border/40 px-1.5 py-0.5 text-[10px] text-chrome-text/45">
            drop a field to filter
          </span>
        ) : (
          filters.map((f, i) => (
            <FilterPillView
              key={`${f.field}/${i}`}
              filter={f}
              columns={columns}
              rows={rows}
              onChange={(next) => {
                const copy = [...filters]
                copy[i] = next
                onChange(copy)
              }}
              onRemove={() => onChange(filters.filter((_, j) => j !== i))}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── Pill (channel) ─────────────────────────────────────────────────

function Pill({
  pill,
  columns,
  channel,
  multiDim,
  onChange,
  onRemove,
}: {
  pill: ChannelPill
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  channel: ShelfChannel
  /** True when this pill is one of multiple dim pills on a positional shelf. */
  multiDim?: boolean
  onChange: (next: ChannelPill) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // close on outside click
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const role = useMemo(() => {
    const col = columns.find((c) => c.name === pill.field)
    return col ? classifyColumn(col) : null
  }, [columns, pill.field])
  const missing = pill.field !== "" && role == null

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group inline-flex max-w-[260px] items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px]",
          missing
            ? "border-danger/60 bg-danger/10 text-danger"
            : open
              ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
              : "border-chrome-border/50 bg-doc-bg text-foreground hover:border-rvbbit-accent/40",
        )}
        title={missing ? `field "${pill.field}" no longer exists in result columns` : pillCaption(pill)}
      >
        <TypeGlyph type={pill.type} />
        <span className="truncate">{pillCaption(pill)}</span>
        <span
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full text-chrome-text/55 hover:bg-foreground/10 hover:text-foreground"
          title="remove"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      </button>
      {open ? (
        <PillPopover pill={pill} channel={channel} multiDim={multiDim} onChange={onChange} />
      ) : null}
    </div>
  )
}

function PillPopover({
  pill,
  channel,
  multiDim,
  onChange,
}: {
  pill: ChannelPill
  channel: ShelfChannel
  multiDim?: boolean
  onChange: (next: ChannelPill) => void
}) {
  return (
    <div className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-lg backdrop-blur">
      <PopRow label="type">
        {(["quantitative", "temporal", "ordinal", "nominal"] as VegaType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              const next: ChannelPill = { ...pill, type: t }
              // Clear options that don't apply to the new type
              if (t !== "quantitative") next.bin = null
              if (t !== "temporal") next.timeUnit = null
              onChange(next)
            }}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px]",
              pill.type === t
                ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
                : "border-chrome-border/40 bg-doc-bg text-chrome-text/85",
            )}
          >
            {t === "quantitative" ? "Q" : t === "temporal" ? "T" : t === "ordinal" ? "O" : "N"}
            <span className="ml-1 text-[9px] text-chrome-text/55">{t}</span>
          </button>
        ))}
      </PopRow>

      <PopRow label="aggregate">
        <select
          value={pill.aggregate ?? ""}
          onChange={(e) => {
            const v = e.target.value
            onChange({
              ...pill,
              aggregate: v ? (v as AggregateOp) : null,
            })
          }}
          className="rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
          title={multiDim ? "aggregating collapses this nested-dim shelf to a single pill" : undefined}
        >
          <option value="">none</option>
          {AGGREGATE_OPS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        {multiDim ? (
          <span className="text-[9px] text-chrome-text/55">
            nested dim — adding an aggregate collapses the shelf
          </span>
        ) : null}
      </PopRow>

      {pill.type === "temporal" ? (
        <PopRow label="time unit">
          <select
            value={pill.timeUnit ?? ""}
            onChange={(e) => {
              const v = e.target.value
              onChange({ ...pill, timeUnit: v ? (v as TimeUnit) : null })
            }}
            className="rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
          >
            <option value="">none</option>
            {TIME_UNITS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </PopRow>
      ) : null}

      {pill.type === "quantitative" ? (
        <PopRow label="bin">
          <label className="inline-flex items-center gap-1 text-[10px] text-chrome-text/85">
            <input
              type="checkbox"
              checked={!!pill.bin}
              onChange={(e) =>
                onChange({ ...pill, bin: e.target.checked ? { maxbins: 30 } : null })
              }
            />
            enable
          </label>
          {pill.bin ? (
            <label className="inline-flex items-center gap-1 text-[10px] text-chrome-text/85">
              <span className="text-chrome-text/55">max bins</span>
              <input
                type="number"
                min={2}
                max={300}
                value={
                  typeof pill.bin === "object" && pill.bin
                    ? (pill.bin as { maxbins: number }).maxbins
                    : 30
                }
                onChange={(e) =>
                  onChange({
                    ...pill,
                    bin: { maxbins: Math.max(2, Math.min(300, Number(e.target.value) || 30)) },
                  })
                }
                className="w-14 rounded border border-chrome-border bg-doc-bg px-1 py-0.5 text-right font-mono text-[10px] tabular-nums text-foreground outline-none"
              />
            </label>
          ) : null}
        </PopRow>
      ) : null}

      {channel === "x" || channel === "y" ? (
        <PopRow label="sort">
          <select
            value={pill.sort ?? ""}
            onChange={(e) => {
              const v = e.target.value
              onChange({
                ...pill,
                sort: v ? (v as NonNullable<ChannelPill["sort"]>) : null,
              })
            }}
            className="rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
          >
            <option value="">default</option>
            <option value="ascending">ascending</option>
            <option value="descending">descending</option>
            <option value="-y">by -y</option>
            <option value="y">by y</option>
            <option value="-x">by -x</option>
            <option value="x">by x</option>
          </select>
        </PopRow>
      ) : null}

      <PopRow label="title">
        <input
          value={pill.title ?? ""}
          onChange={(e) => onChange({ ...pill, title: e.target.value || null })}
          placeholder={pillCaption(pill)}
          className="w-full rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none placeholder:text-chrome-text/40"
        />
      </PopRow>
    </div>
  )
}

function PopRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[10px]">
      <span className="w-[60px] shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

// ── Filter pill view ───────────────────────────────────────────────

function FilterPillView({
  filter,
  columns,
  rows,
  onChange,
  onRemove,
}: {
  filter: FilterPill
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  onChange: (next: FilterPill) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const role = useMemo(() => {
    const col = columns.find((c) => c.name === filter.field)
    return col ? classifyColumn(col) : null
  }, [columns, filter.field])

  // Distinct value sample for "in" suggestions (cheap — capped).
  const suggestions = useMemo(() => {
    if (role !== "categorical" && role !== "boolean") return []
    const set = new Set<string>()
    for (const r of rows) {
      const v = r[filter.field]
      if (v == null) continue
      set.add(String(v))
      if (set.size >= 40) break
    }
    return [...set].sort()
  }, [rows, filter.field, role])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex max-w-[280px] items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px]",
          open
            ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
            : "border-chrome-border/50 bg-doc-bg text-foreground hover:border-rvbbit-accent/40",
        )}
        title={filterCaption(filter)}
      >
        <Filter className="h-2.5 w-2.5 text-chrome-text/65" />
        <span className="truncate">{filterCaption(filter)}</span>
        <span
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full text-chrome-text/55 hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[240px] rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-lg backdrop-blur">
          <PopRow label="op">
            <select
              value={filter.op}
              onChange={(e) =>
                onChange({ ...filter, op: e.target.value as FilterOp })
              }
              className="rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
            >
              {(["eq", "neq", "in", "gt", "gte", "lt", "lte", "between", "non-null"] as FilterOp[]).map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </PopRow>

          {filter.op === "non-null" ? null : filter.op === "between" ? (
            <PopRow label="range">
              <input
                value={String(filter.values?.[0] ?? "")}
                onChange={(e) => {
                  const arr = [...(filter.values ?? [null, null])]
                  arr[0] = coerce(e.target.value, filter.type)
                  onChange({ ...filter, values: arr })
                }}
                placeholder="min"
                className="w-20 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
              />
              <span className="text-chrome-text/55">…</span>
              <input
                value={String(filter.values?.[1] ?? "")}
                onChange={(e) => {
                  const arr = [...(filter.values ?? [null, null])]
                  arr[1] = coerce(e.target.value, filter.type)
                  onChange({ ...filter, values: arr })
                }}
                placeholder="max"
                className="w-20 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
              />
            </PopRow>
          ) : filter.op === "in" ? (
            <PopRow label="values">
              <div className="flex max-h-[160px] min-w-[200px] flex-col gap-1 overflow-auto">
                <div className="flex flex-wrap gap-1">
                  {(filter.values ?? []).map((v, i) => (
                    <span
                      key={`${String(v)}/${i}`}
                      className="inline-flex items-center gap-0.5 rounded bg-rvbbit-accent/15 px-1 py-px font-mono text-[9px] text-foreground"
                    >
                      {String(v)}
                      <button
                        type="button"
                        onClick={() =>
                          onChange({
                            ...filter,
                            values: (filter.values ?? []).filter((_, j) => j !== i),
                          })
                        }
                        className="text-chrome-text/55 hover:text-foreground"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1 border-t border-chrome-border/40 pt-1">
                    {suggestions.map((s) => {
                      const has = (filter.values ?? []).map(String).includes(s)
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            const next = new Set((filter.values ?? []).map(String))
                            if (has) next.delete(s)
                            else next.add(s)
                            onChange({ ...filter, values: [...next] })
                          }}
                          className={cn(
                            "rounded border px-1 py-px font-mono text-[9px]",
                            has
                              ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
                              : "border-chrome-border/40 bg-doc-bg text-chrome-text/85",
                          )}
                        >
                          {s.length > 20 ? `${s.slice(0, 19)}…` : s}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            </PopRow>
          ) : (
            <PopRow label="value">
              <input
                value={String(filter.value ?? "")}
                onChange={(e) =>
                  onChange({ ...filter, value: coerce(e.target.value, filter.type) })
                }
                className="w-32 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none"
              />
            </PopRow>
          )}
        </div>
      ) : null}
    </div>
  )
}

function coerce(s: string, type: VegaType): unknown {
  if (type === "quantitative") {
    if (s === "") return null
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  return s
}

// ── Exports ────────────────────────────────────────────────────────

export { FIELD_MIME }
