"use client"

import { useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  Layers,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Loader2,
} from "@/lib/icons"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { SchemaSnapshot, SchemaTable } from "@/lib/db/types"
import { cn } from "@/lib/utils"
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./context-menu"
import {
  deleteTemplateSql,
  insertTemplateSql,
  quoteSqlIdent,
  selectTopSql,
  updateTemplateSql,
} from "@/lib/desktop/sql-builder"
import { Sparkline } from "./sparkline"
import { useTableTimeline } from "@/lib/rvbbit/use-table-timeline"
import type { TimelineTick } from "@/lib/rvbbit/time-travel"
import { driftSeverityColor } from "@/lib/rvbbit/drift-flags"
import { fmtAgo, fmtBytes, fmtRows } from "@/lib/rvbbit/finder-format"
import { DriftChips, FinderTooltip, useFinderHoverCard } from "./finder-tooltip"

interface FinderWindowProps {
  schema: SchemaSnapshot | null
  loading: boolean
  activeConnectionId: string | null
  onOpenTable: (schema: string, name: string) => void
  onReload: () => void
  onOpenConnections: () => void
  /** Open a SQL window with the given SQL — run it (SELECTs) or just show it
   *  in the editor (DDL / templates / destructive ops to review-then-run). */
  onOpenSql?: (title: string, sql: string, run: boolean) => void
  /** Fetch + show an object's CREATE script (async). */
  onViewDdl?: (schema: string, name: string, kind: string) => void
}

export function FinderWindow({
  schema,
  loading,
  activeConnectionId,
  onOpenTable,
  onReload,
  onOpenConnections,
  onOpenSql,
  onViewDdl,
}: FinderWindowProps) {
  const [search, setSearch] = useState("")
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(() => new Set(["public", "rvbbit"]))
  const hover = useFinderHoverCard()

  const grouped = useMemo(() => groupTables(schema?.tables ?? [], search), [schema?.tables, search])

  if (!activeConnectionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Plug className="h-8 w-8 text-chrome-text/60" />
        <div className="text-sm text-chrome-text">No connection selected.</div>
        <Button size="sm" variant="neutral" onClick={onOpenConnections}>Open Connections</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/60" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search objects..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={onReload} title="Reload schema" className="h-7 w-7">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
        <Database className="h-3 w-3" />
        <span className="truncate">{schema?.currentDatabase ?? "—"}</span>
        {schema?.hasRvbbit ? (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-rvbbit-accent/40 bg-rvbbit-bg/40 px-1.5 py-0 text-[9px] uppercase tracking-wide text-rvbbit-accent">
            <Sparkles className="h-2.5 w-2.5" />
            rvbbit v{schema.rvbbitVersion}
          </span>
        ) : null}
        <div className="flex-1" />
        <span>
          {(schema?.tables?.length ?? 0)} objects ·{" "}
          {(schema?.schemas?.length ?? 0)} schemas
        </span>
      </div>

      <div className="flex-1 overflow-y-auto" onScroll={hover.dismiss}>
        {!schema && loading ? (
          <div className="flex h-32 items-center justify-center text-xs text-chrome-text/70">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading schema...
          </div>
        ) : null}
        {schema && grouped.length === 0 ? (
          <div className="px-4 py-3 text-xs text-chrome-text/70">No objects match &quot;{search}&quot;.</div>
        ) : null}
        {grouped.map(({ schema: ns, tables }) => {
          const isOpen = openSchemas.has(ns)
          return (
            <div key={ns} className="border-b border-chrome-border/50 last:border-b-0">
              <button
                type="button"
                onClick={() => {
                  setOpenSchemas((s) => {
                    const next = new Set(s)
                    if (next.has(ns)) next.delete(ns)
                    else next.add(ns)
                    return next
                  })
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] uppercase tracking-wider text-chrome-text hover:bg-foreground/[0.04]"
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <FolderOpen className="h-3 w-3" />
                <span className="flex-1">{ns}</span>
                <span className="text-chrome-text/60">{tables.length}</span>
              </button>
              {isOpen ? (
                <div className="space-y-px pb-1">
                  {tables.map((t) => (
                    <TableRow
                      key={`${t.schema}.${t.name}`}
                      table={t}
                      connectionId={activeConnectionId}
                      onOpen={() => onOpenTable(t.schema, t.name)}
                      onHover={hover.open}
                      onHoverEnd={hover.close}
                      onOpenSql={onOpenSql}
                      onViewDdl={onViewDdl}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {hover.target ? (
        <FinderTooltip
          key={`${hover.target.table.schema}.${hover.target.table.name}`}
          table={hover.target.table}
          anchor={hover.target.rect}
        />
      ) : null}
    </div>
  )
}

function TableRow({
  table,
  connectionId,
  onOpen,
  onHover,
  onHoverEnd,
  onOpenSql,
  onViewDdl,
}: {
  table: SchemaTable
  connectionId: string | null
  onOpen: () => void
  onHover: (table: SchemaTable, el: HTMLElement) => void
  onHoverEnd: () => void
  onOpenSql?: (title: string, sql: string, run: boolean) => void
  onViewDdl?: (schema: string, name: string, kind: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const isRvbbit = !!table.isRvbbit

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const qual = `${quoteSqlIdent(table.schema)}.${quoteSqlIdent(table.name)}`
    const cols = table.columns ?? []
    const isViewish = table.kind === "view" || table.kind === "matview"
    const dropVerb = table.kind === "matview" ? "MATERIALIZED VIEW" : table.kind === "view" ? "VIEW" : "TABLE"
    const dropLabelKind = table.kind === "matview" ? "materialized view" : table.kind === "view" ? "view" : "table"
    const items: ContextMenuItem[] = [
      { id: "open", label: "Open (200 rows)", icon: Play, onSelect: onOpen },
      {
        id: "select",
        label: "Select 1000 rows",
        icon: Table2,
        disabled: !onOpenSql,
        onSelect: () => onOpenSql?.(table.name, selectTopSql(table.schema, table.name, 1000), true),
      },
      {
        id: "ddl",
        label: "View DDL",
        icon: FileCode2,
        disabled: !onViewDdl,
        onSelect: () => onViewDdl?.(table.schema, table.name, table.kind),
      },
      {
        id: "copy",
        label: "Copy qualified name",
        icon: ClipboardCopy,
        onSelect: () => void copyText(qual),
      },
    ]
    if (!isViewish) {
      items.push(
        {
          id: "insert",
          label: "Generate INSERT",
          icon: Plus,
          separatorBefore: true,
          disabled: !onOpenSql,
          onSelect: () => onOpenSql?.(`INSERT ${table.name}`, insertTemplateSql(table.schema, table.name, cols), false),
        },
        {
          id: "update",
          label: "Generate UPDATE",
          disabled: !onOpenSql,
          onSelect: () => onOpenSql?.(`UPDATE ${table.name}`, updateTemplateSql(table.schema, table.name, cols), false),
        },
        {
          id: "delete",
          label: "Generate DELETE",
          disabled: !onOpenSql,
          onSelect: () => onOpenSql?.(`DELETE ${table.name}`, deleteTemplateSql(table.schema, table.name), false),
        },
        {
          id: "truncate",
          label: "Truncate…",
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          disabled: !onOpenSql,
          onSelect: () => onOpenSql?.(`TRUNCATE ${table.name}`, `TRUNCATE TABLE ${qual};`, false),
        },
      )
    }
    items.push({
      id: "drop",
      label: `Drop ${dropLabelKind}…`,
      icon: Trash2,
      danger: true,
      separatorBefore: isViewish,
      disabled: !onOpenSql,
      onSelect: () => onOpenSql?.(`DROP ${table.name}`, `DROP ${dropVerb} ${qual};`, false),
    })
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  return (
    <div>
      <div
        onContextMenu={openMenu}
        className="group flex items-center gap-1 px-2 py-1 text-xs hover:bg-foreground/[0.05]"
      >
        {/* expand affordance — only rvbbit tables have a time-travel history */}
        {isRvbbit ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            title="time-travel history"
            className="grid h-3.5 w-3.5 shrink-0 place-items-center text-chrome-text/35 hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <TableKindIcon table={table} className={cn("h-3 w-3 shrink-0", isRvbbit ? "text-rvbbit-accent" : "text-chrome-text/70")} />
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={onOpen}
          title={table.comment || `${table.schema}.${table.name}`}
          className="min-w-0 flex-1 truncate text-left text-foreground hover:underline"
        >
          {table.name}
        </button>
        <span
          tabIndex={0}
          onMouseEnter={(e) => onHover(table, e.currentTarget)}
          onMouseLeave={onHoverEnd}
          onFocus={(e) => onHover(table, e.currentTarget)}
          onBlur={onHoverEnd}
          aria-label={hoverFallbackTitle(table)}
          className="rounded outline-none focus-visible:ring-1 focus-visible:ring-rvbbit-accent/50"
        >
          <RowBadges table={table} />
        </span>
      </div>
      {expanded && isRvbbit ? <TableTimelinePanel table={table} connectionId={connectionId} /> : null}
      {/* Heap tables have no expand panel, so surface their drift flags inline
          (rvbbit tables show the same chips inside the time-travel panel). */}
      {!isRvbbit && (table.driftFlags?.length ?? 0) > 0 ? (
        <div className="px-7 pb-1 pl-9">
          <DriftChips flags={table.driftFlags!} />
        </div>
      ) : null}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* best effort */
  }
}

function TableKindIcon({ table, className }: { table: SchemaTable; className?: string }) {
  if (table.kind === "view") return <Eye className={className} />
  if (table.kind === "matview") return <Layers className={className} />
  if (table.isRvbbit && table.kind === "table") return <Sparkles className={className} />
  return <Table2 className={className} />
}

function RowBadges({ table }: { table: SchemaTable }) {
  const isRvbbit = !!table.isRvbbit
  // All provenance/detail now lives in the hover card (FinderTooltip); the badges
  // stay as compact glanceable glyphs with NO native title= (avoids a second
  // tooltip popping over the card).
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {table.colCount != null ? (
        <span className="text-[9px] tabular-nums text-chrome-text/35">{table.colCount}c</span>
      ) : null}
      {isRvbbit && table.freshness && table.freshness !== "na" ? (
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ backgroundColor: table.freshness === "fresh" ? "var(--success)" : "var(--warning)" }}
        />
      ) : null}
      {isRvbbit && table.rgCount != null && table.rgCount > 0 ? (
        <TierBar rgCount={table.rgCount} coldCount={table.coldCount ?? 0} />
      ) : null}
      {table.lanceEnabled ? <span className="text-[9px] text-rvbbit-accent">✦</span> : null}
      {table.driftSeverity != null && table.driftSeverity > 0 ? (
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full ring-1 ring-foreground/10"
          style={{ backgroundColor: driftSeverityColor(table.driftSeverity) }}
        />
      ) : null}
      {table.heat != null && table.heat > 0 ? (
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ backgroundColor: "var(--viz-series-5)", opacity: table.heat >= 10 ? 1 : table.heat >= 3 ? 0.7 : 0.4 }}
        />
      ) : null}
      <span className="w-12 text-right text-[10px] tabular-nums text-chrome-text/60">{rowsLabel(table)}</span>
    </div>
  )
}

function rowsLabel(t: SchemaTable): string {
  if (t.kind === "view") return "view"
  if (t.kind === "matview") return "mv"
  if (t.rows == null) return "·"
  return (t.rowsSource === "estimate" ? "~" : "") + fmtRows(t.rows)
}

/** Concise a11y / no-JS fallback for the hover trigger (the rich card has the rest). */
function hoverFallbackTitle(t: SchemaTable): string {
  const parts: string[] = [`${t.schema}.${t.name}`]
  if (t.rows != null) parts.push(`${t.rows.toLocaleString()} rows`)
  const disk =
    (t.heapBytes ?? 0) + (t.hotParquetBytes ?? 0) + (t.coldBytes ?? 0) + (t.indexBytes ?? 0) + (t.toastBytes ?? 0)
  if (disk > 0) parts.push(`${fmtBytes(disk)} on disk`)
  return parts.join(" · ")
}

function TierBar({ rgCount, coldCount }: { rgCount: number; coldCount: number }) {
  const cold = Math.min(Math.max(coldCount, 0), rgCount)
  const hot = rgCount - cold
  const label = cold > 0 ? `${cold}/${rgCount}` : null
  if (rgCount > 12) {
    const hotPct = Math.round((hot / rgCount) * 100)
    return (
      <span className="flex items-center gap-1">
        <span className="flex h-1.5 w-6 overflow-hidden rounded-full">
          <span className="h-full" style={{ width: `${hotPct}%`, backgroundColor: "var(--rvbbit-accent)" }} />
          <span className="h-full flex-1" style={{ backgroundColor: "var(--info)" }} />
        </span>
        {label ? <span className="text-[9px] text-chrome-text/40">{label}</span> : null}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1">
      <span className="flex h-1.5 items-center gap-[1px]">
        {Array.from({ length: rgCount }).map((_, i) => (
          <span
            key={i}
            className="h-1.5 w-[3px] rounded-[1px]"
            style={{ backgroundColor: i < hot ? "var(--rvbbit-accent)" : "var(--info)" }}
          />
        ))}
      </span>
      {label ? <span className="text-[9px] text-chrome-text/40">{label}</span> : null}
    </span>
  )
}

function TableTimelinePanel({ table, connectionId }: { table: SchemaTable; connectionId: string | null }) {
  const { ticks, loading } = useTableTimeline(connectionId, { schema: table.schema, name: table.name }, true)
  return (
    <div className="px-7 pb-1.5 pt-0.5">
      <div className="rounded border border-chrome-border/40 bg-foreground/[0.02] px-2 py-1.5">
        {loading ? (
          <div className="flex h-7 items-center gap-1.5 text-[10px] text-chrome-text/50">
            <Loader2 className="h-3 w-3 animate-spin" /> loading history…
          </div>
        ) : ticks.length === 0 ? (
          <div className="text-[10px] text-chrome-text/40">no time-travel history yet</div>
        ) : (
          <TimelineScrubber ticks={ticks} />
        )}
        {ticks.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[9px] text-chrome-text/50">
            <span>gen {table.generation ?? ticks[0]?.generation ?? "—"}</span>
            {table.lastCompactAt ? <span>· compacted {fmtAgo(table.lastCompactAt)}</span> : null}
            {table.rgCount != null ? (
              <span>
                · {table.rgCount} rg{table.coldCount ? ` (${table.coldCount} cold)` : ""}
              </span>
            ) : null}
            {table.parquetBytes ? <span>· {fmtBytes(table.parquetBytes)}</span> : null}
          </div>
        ) : null}
        {(table.driftFlags?.length ?? 0) > 0 ? (
          <div className="mt-1">
            <DriftChips flags={table.driftFlags!} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Drag (or hover) across a table's time-travel history and the row count +
 * marker move live "as of" that generation — nothing is committed, it's pure
 * exploration. Reuses the lazy-fetched timeline + the Sparkline visual.
 */
function TimelineScrubber({ ticks }: { ticks: TimelineTick[] }) {
  const series = useMemo(() => ticks.slice().reverse(), [ticks]) // oldest → newest (left → right)
  // Plot the per-checkpoint slice (rows written *in* that generation), NOT
  // `visible_rows_estimate` — which is a running cumulative sum and so ramps
  // upward forever for refresh-in-place tables (cubes, materialized aggs rewrite
  // the full row count each generation, never tombstoned → the sum balloons).
  // The slice reflects the table's actual size trajectory: flat when stable,
  // up/down when it really grows or shrinks. Cumulative stays on hover.
  const values = useMemo(() => series.map((t) => t.rowsWritten), [series])
  const max = useMemo(() => Math.max(1, ...values), [values])
  const [idx, setIdx] = useState<number | null>(null) // null ⇒ "now" (latest)
  const ref = useRef<HTMLDivElement | null>(null)
  const n = series.length
  const H = 30

  const active = idx == null ? n - 1 : Math.max(0, Math.min(n - 1, idx))
  const tick = series[active]
  const markerPct = n > 1 ? (active / (n - 1)) * 100 : 50
  // mirror Sparkline.buildPath's toY (padTop=2, inner=H-4) so the dot rides the curve
  const PAD = 2
  const inner = Math.max(1, H - PAD * 2)
  const dotTop = tick ? PAD + inner - (tick.rowsWritten / max) * inner : H / 2

  const scrub = (clientX: number) => {
    const el = ref.current
    if (!el || n === 0) return
    const rect = el.getBoundingClientRect()
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    setIdx(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }

  return (
    <div>
      <div
        ref={ref}
        className="relative cursor-ew-resize touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub(e.clientX)
        }}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerUp={() => setIdx(null)}
        onPointerLeave={() => setIdx(null)}
        title="drag to scrub rows-per-checkpoint over time"
      >
        <Sparkline values={values} height={H} color="var(--rvbbit-accent)" yMin={0} yMax={max} />
        {n > 0 ? (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-terminal/50"
              style={{ left: `${markerPct}%` }}
            />
            <div
              className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-terminal ring-2 ring-block-bg"
              style={{ left: `${markerPct}%`, top: dotTop }}
            />
          </>
        ) : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5 font-mono text-[9px] text-chrome-text/55">
        <span
          className="tabular-nums text-foreground"
          title={
            tick
              ? `${tick.visibleRowsEstimate.toLocaleString()} cumulative across all retained generations` +
                (tick.tombstonesVisible ? ` · ${tick.tombstonesVisible.toLocaleString()} tombstoned` : "")
              : undefined
          }
        >
          {tick ? tick.rowsWritten.toLocaleString() : "—"}
        </span>
        <span>rows / gen</span>
        <span className="ml-auto">
          {tick ? `${idx == null ? "now" : "as of"} ${fmtDateTime(tick.committedAt)} · gen ${tick.generation}` : ""}
        </span>
      </div>
    </div>
  )
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function groupTables(tables: SchemaTable[], search: string) {
  const filtered = search
    ? tables.filter((t) =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.schema.toLowerCase().includes(search.toLowerCase()),
      )
    : tables
  const map = new Map<string, SchemaTable[]>()
  for (const t of filtered) {
    const list = map.get(t.schema) ?? []
    list.push(t)
    map.set(t.schema, list)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => schemaSortKey(a) - schemaSortKey(b) || a.localeCompare(b))
    .map(([ns, ts]) => ({ schema: ns, tables: ts }))
}

function schemaSortKey(name: string): number {
  if (name === "public") return 0
  if (name === "rvbbit") return 1
  if (name.startsWith("pg_")) return 5
  return 2
}
