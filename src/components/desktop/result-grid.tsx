"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ClipboardCopy, Eye, GripVertical, Search, Table2 } from "@/lib/icons"
import type { QueryResultColumn } from "@/lib/db/types"
import type { DesktopColumnDragPayload, DesktopColumnRef, DesktopParamValue } from "@/lib/desktop/types"
import type { CrossFilter } from "@/lib/desktop/reactive-sql"
import { cn } from "@/lib/utils"
import { formatCellValue } from "@/lib/sql/format"
import { setActiveColumnDragSource, writeColumnDragPayload } from "@/lib/desktop/column-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { ContextMenu, type ContextMenuState } from "./context-menu"

interface ColumnDragSource {
  parentWindowId: string
  parentBlockName: string
  parentTitle: string
  parentSql: string
  relationKey: string
  columns: DesktopColumnRef[]
}

interface ResultGridProps {
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  className?: string
  /** Rotate the native grid so fields are vertical and result rows become columns. */
  transposed?: boolean
  onTransposedChange?: (next: boolean) => void
  /** When provided, headers become draggable and emit a column-drag payload. */
  columnDragSource?: ColumnDragSource | null
  /** When provided, clicking a cell emits a param. cascade=true (plain/⌘) is a
   *  cascading filter; cascade=false (⌥) is a "pick" — published but not
   *  self-filtering. */
  onEmitCellParam?: (
    field: string,
    value: unknown,
    dataTypeId: number,
    operator?: "eq" | "in",
    cascade?: boolean,
    /** The clicked column's real source table+column (pg provenance), so the
     *  emitted param can broadcast to other blocks that read the same table. */
    source?: { schema?: string; table?: string; column?: string },
  ) => void
  /** Params sourced from THIS block — used to highlight the cells that are the
   *  live filter (cascade) or a published pick value. */
  activeParams?: DesktopParamValue[]
  onOpenRow?: (input: {
    row: Record<string, unknown>
    rowIndex: number
    column: QueryResultColumn
  }) => void
  /** Extra entries appended to the cell context menu (e.g. semantic lineage). */
  extraCellMenuItems?: (input: {
    row: Record<string, unknown>
    rowIndex: number
    column: QueryResultColumn
    value: unknown
  }) => Array<{
    id: string
    label: string
    icon: React.ComponentType<{ className?: string }>
    disabled?: boolean
    onSelect: () => void
  }>
  /** Cross-filter: a plain cell click hands back the whole COLUMN (with its
   *  source-table provenance) + value, so a multi-statement dashboard can filter
   *  sibling tiles by the real table. Takes precedence over onEmitCellParam. */
  onCellFilter?: (column: QueryResultColumn, value: unknown) => void
  /** Active cross-filters that ORIGINATED in this tile — highlight the cells whose
   *  value is selected (the tile isn't filtered by its own filter, so this is the
   *  visible "you clicked this" indicator, mirroring single-block param highlighting). */
  highlightFilters?: CrossFilter[]
}

const ROW_HEIGHT = 24
const MIN_COL_WIDTH = 80
const TRANSPOSED_FIELD_KEY = "__rvbbit_transposed_field"
const TRANSPOSED_ROW_WIDTH = 152

export function ResultGrid({
  columns,
  rows,
  className,
  transposed = false,
  onTransposedChange,
  columnDragSource,
  onEmitCellParam,
  activeParams,
  onOpenRow,
  onCellFilter,
  highlightFilters,
  extraCellMenuItems,
}: ResultGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [selectedHeaders, setSelectedHeaders] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Client-side sort + filter over the already-fetched rows (no re-query).
  const [filter, setFilter] = useState("")
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null)
  const cycleSort = (name: string) =>
    setSort((s) => (!s || s.col !== name ? { col: name, dir: "asc" } : s.dir === "asc" ? { col: name, dir: "desc" } : null))
  // Present mode: cell-click filtering stays, but column drag-to-group, header
  // multi-select, and width-resize are authoring affordances — turn them off.
  const present = usePresentMode()
  const dragEnabled = !!columnDragSource && !present

  useEffect(() => {
    parentRef.current?.scrollTo({ left: 0, top: 0 })
  }, [transposed])

  // Per-column lookup of values that are an active param for this block, so the
  // matching cells can be highlighted (cascade = the live filter; otherwise a
  // published "pick"). One param per column, so a single entry per field.
  const paramHighlights = useMemo(() => {
    const map = new Map<string, { values: Set<string>; cascade: boolean }>()
    for (const p of activeParams ?? []) {
      const isPick = p.cascade === false
      // An eq cascade already narrows the grid to its single value, so
      // highlighting it is redundant noise — only highlight picks (which don't
      // narrow) and multi-value IN filters.
      if (!isPick && p.operator !== "in") continue
      const vals = (Array.isArray(p.value) ? p.value : [p.value]).map((v) => String(v))
      map.set(p.field, { values: new Set(vals), cascade: !isPick })
    }
    return map
  }, [activeParams])

  // Cross-filter highlights, keyed by grid-column NAME, matched to a filter by pg
  // provenance (the filter carries the REAL source column, the grid column may be
  // aliased). The originating tile isn't filtered by its own filter, so this marks
  // what was clicked — the visible selection that survives the re-run remount.
  const crossHighlights = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!highlightFilters?.length) return map
    for (const c of columns) {
      const f = highlightFilters.find(
        (hf) => {
          if (!hf.sourceTable) return hf.column.toLowerCase() === c.name.toLowerCase()
          return (
            !!c.sourceColumn &&
            hf.column.toLowerCase() === c.sourceColumn.toLowerCase() &&
            (!c.sourceTable || hf.sourceTable.toLowerCase() === c.sourceTable.toLowerCase())
          )
        },
      )
      if (!f) continue
      const vals = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => String(v))
      map.set(c.name, new Set(vals))
    }
    return map
  }, [highlightFilters, columns])

  function onHeaderDragStart(e: React.DragEvent<HTMLDivElement>, name: string) {
    if (!columnDragSource || present) return
    const sourceCol = columnDragSource.columns.find((c) => c.name === name)
    if (!sourceCol) return
    const multi = columnDragSource.columns.filter((c) => selectedHeaders.has(c.name))
    const cols = multi.some((c) => c.name === sourceCol.name) && multi.length > 0 ? multi : [sourceCol]
    const payload: DesktopColumnDragPayload = {
      kind: "rvbbit-lens.desktop.column",
      parentWindowId: columnDragSource.parentWindowId,
      parentBlockName: columnDragSource.parentBlockName,
      parentTitle: columnDragSource.parentTitle,
      parentSql: columnDragSource.parentSql,
      relationKey: columnDragSource.relationKey,
      columns: cols,
      // Full source column set so a multi-arg semantic bind can offer sibling
      // columns (e.g. contradicts(a, b) with b bound to another column).
      sourceColumns: columnDragSource.columns,
    }
    writeColumnDragPayload(e.dataTransfer, payload)
    setActiveColumnDragSource({
      parentWindowId: payload.parentWindowId,
      parentBlockName: payload.parentBlockName,
      relationKey: payload.relationKey,
      columns: cols,
    })
    const dimCount = cols.filter((c) => c.role === "dimension").length
    const metricCount = cols.length - dimCount
    const sublabel = cols.length > 1
      ? `${dimCount} dim · ${metricCount} metric`
      : (sourceCol.role === "metric" ? "metric" : "dimension")
    attachDragGhost(e.dataTransfer, {
      variant: "column",
      label: cols.length > 1 ? cols.map((c) => c.name).join(", ") : sourceCol.name,
      sublabel,
      count: cols.length,
    })
  }

  function onHeaderClick(e: React.MouseEvent<HTMLDivElement>, name: string) {
    if (!columnDragSource || present) return
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
      // Single click → toggle role hint? For now we just toggle selection.
      setSelectedHeaders((s) => {
        const next = new Set(s)
        if (next.has(name)) next.delete(name); else next.add(name)
        return next
      })
      return
    }
    setSelectedHeaders((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const columnWidths = useMemo(() => {
    return columns.map((c) => colWidths[c.name] ?? estimateWidth(c, rows))
  }, [colWidths, columns, rows])

  // Rows actually shown: filtered (any cell contains the text) then sorted.
  // In transposed mode, a field-name filter keeps all row columns visible and
  // narrows the vertical field list instead.
  const viewRows = useMemo(() => {
    let out = rows
    const f = filter.trim().toLowerCase()
    if (f) {
      const matchedFieldName = transposed && columns.some((c) => columnMatchesFilter(c, f))
      if (!matchedFieldName) {
        out = out.filter((r) => columns.some((c) => cellMatchesFilter(r[c.name], f)))
      }
    }
    if (sort) {
      const { col, dir } = sort
      const mul = dir === "asc" ? 1 : -1
      out = [...out].sort((a, b) => {
        const av = a[col]
        const bv = b[col]
        if (av == null && bv == null) return 0
        if (av == null) return 1 // nulls last regardless of dir
        if (bv == null) return -1
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul
        const as = String(formatCellValue(av))
        const bs = String(formatCellValue(bv))
        const an = Number(as)
        const bn = Number(bs)
        if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * mul
        return as.localeCompare(bs) * mul
      })
    }
    return out
  }, [rows, columns, filter, sort, transposed])

  const transposedColumns = useMemo(() => {
    if (!transposed) return columns
    const f = filter.trim().toLowerCase()
    if (!f) return columns
    return columns.filter((c) => columnMatchesFilter(c, f) || viewRows.some((r) => cellMatchesFilter(r[c.name], f)))
  }, [columns, filter, transposed, viewRows])

  const fieldColumnWidth = colWidths[TRANSPOSED_FIELD_KEY] ?? estimateFieldWidth(columns)

  const virtualizer = useVirtualizer({
    count: transposed ? transposedColumns.length : viewRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  })

  const rowColumnVirtualizer = useVirtualizer({
    horizontal: true,
    count: transposed ? viewRows.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TRANSPOSED_ROW_WIDTH,
    overscan: 8,
  })

  function startResize(name: string, e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[name] ?? (name === TRANSPOSED_FIELD_KEY
      ? estimateFieldWidth(columns)
      : estimateWidth(columns.find((c) => c.name === name)!, rows))
    function onMove(ev: PointerEvent) {
      const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX))
      setColWidths((w) => ({ ...w, [name]: next }))
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  if (columns.length === 0) {
    return (
      <div className="grid h-full place-items-center text-xs text-chrome-text/70">
        No columns
      </div>
    )
  }

  const totalWidth = columnWidths.reduce((a, b) => a + b, 0)
  const transposedRowsWidth = rowColumnVirtualizer.getTotalSize()
  const transposedTotalWidth = fieldColumnWidth + transposedRowsWidth
  const rowVirtualItems = rowColumnVirtualizer.getVirtualItems()

  const countLabel = transposed
    ? (filter.trim() || sort
      ? `${transposedColumns.length} fields × ${viewRows.length} rows`
      : `${columns.length} fields × ${rows.length} rows`)
    : (filter.trim() || sort ? `${viewRows.length} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`)

  function openCellContextMenu(
    e: React.MouseEvent<HTMLDivElement>,
    row: Record<string, unknown>,
    rowIndex: number,
    column: QueryResultColumn,
  ) {
    e.preventDefault()
    e.stopPropagation()
    const value = row?.[column.name]
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          id: "open-row",
          label: "Open row",
          icon: Eye,
          disabled: !onOpenRow,
          onSelect: () => onOpenRow?.({ row, rowIndex, column }),
        },
        {
          id: "copy-cell",
          label: "Copy cell",
          icon: ClipboardCopy,
          onSelect: () => void copyToClipboard(value == null ? "" : cellText(value)),
        },
        {
          id: "copy-row",
          label: "Copy row JSON",
          icon: Table2,
          onSelect: () => void copyToClipboard(stringifyJson(row)),
        },
        ...(extraCellMenuItems?.({ row, rowIndex, column, value }) ?? []),
      ],
    })
  }

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex items-center gap-1.5 border-b border-chrome-border bg-chrome-bg/60 px-2 py-1">
        <Search className="h-3 w-3 shrink-0 text-chrome-text/40" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={transposed ? "filter fields or values…" : "filter rows…"}
          spellCheck={false}
          className="h-5 min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-chrome-text/35"
        />
        <span className="shrink-0 text-[10px] tabular-nums text-chrome-text/45">
          {countLabel}
        </span>
        {onTransposedChange && !present ? (
          <span className="inline-flex shrink-0 overflow-hidden rounded border border-chrome-border/60 text-[10px]">
            <button
              type="button"
              onClick={() => onTransposedChange(false)}
              title="Show rows as rows"
              className={cn(
                "px-1.5 py-0.5 transition-colors",
                !transposed ? "bg-main/15 text-foreground" : "text-chrome-text/55 hover:text-foreground",
              )}
            >
              Rows
            </button>
            <button
              type="button"
              onClick={() => onTransposedChange(true)}
              title="Show fields on the left and rows as columns"
              className={cn(
                "border-l border-chrome-border/50 px-1.5 py-0.5 transition-colors",
                transposed ? "bg-main/15 text-foreground" : "text-chrome-text/55 hover:text-foreground",
              )}
            >
              Fields
            </button>
          </span>
        ) : null}
      </div>
      <div
        ref={parentRef}
        className="flex flex-1 flex-col overflow-auto bg-doc-bg group-data-[focused=false]/window:bg-doc-bg/70"
      >
      {transposed ? (
        <>
      <div className="sticky top-0 z-20 flex border-b border-chrome-border bg-chrome-bg/95 backdrop-blur" style={{ minWidth: transposedTotalWidth }}>
        <div
          className="sticky left-0 z-30 flex items-center border-r border-chrome-border/70 bg-chrome-bg/95 px-2 py-1 text-[11px] uppercase tracking-wider text-chrome-text"
          style={{ width: fieldColumnWidth }}
        >
          <span className="truncate text-foreground">Field</span>
          {present ? null : (
            <div
              onPointerDown={(e) => startResize(TRANSPOSED_FIELD_KEY, e)}
              className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-main/50"
            />
          )}
        </div>
        <div className="relative h-full" style={{ width: transposedRowsWidth }}>
          {rowVirtualItems.map((vcol) => {
            const row = viewRows[vcol.index]
            const sourceIndex = rows.indexOf(row)
            return (
              <div
                key={vcol.key}
                className="absolute top-0 flex h-full items-center border-r border-chrome-border/60 px-2 py-1 text-[11px] uppercase tracking-wider text-chrome-text"
                style={{ transform: `translateX(${vcol.start}px)`, width: vcol.size }}
                title={`Result row ${sourceIndex >= 0 ? sourceIndex + 1 : vcol.index + 1}`}
              >
                <span className="truncate text-foreground">row {sourceIndex >= 0 ? sourceIndex + 1 : vcol.index + 1}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ height: virtualizer.getTotalSize(), minWidth: transposedTotalWidth }} className="relative">
        {virtualizer.getVirtualItems().map((vrow) => {
          const c = transposedColumns[vrow.index]
          if (!c) return null
          const role = columnDragSource?.columns.find((col) => col.name === c.name)?.role
          const isSelected = selectedHeaders.has(c.name)
          const isNumeric = isNumericType(c)
          return (
            <div
              key={vrow.key}
              className={cn(
                "absolute left-0 right-0 flex border-b border-chrome-border/30",
                vrow.index % 2 === 0 ? "bg-transparent" : "bg-foreground/[0.025]",
              )}
              style={{ transform: `translateY(${vrow.start}px)`, height: ROW_HEIGHT, minWidth: transposedTotalWidth }}
            >
              <div
                draggable={dragEnabled}
                onDragStart={(e) => onHeaderDragStart(e, c.name)}
                onDragEnd={() => setActiveColumnDragSource(null)}
                onClick={(e) => onHeaderClick(e, c.name)}
                className={cn(
                  "group sticky left-0 z-10 flex select-none items-center border-r border-chrome-border/70 bg-doc-bg px-2 py-0.5 text-[12px] group-data-[focused=false]/window:bg-doc-bg/90",
                  dragEnabled && "cursor-grab active:cursor-grabbing hover:bg-foreground/[0.05]",
                  isSelected && "bg-main/15 text-foreground",
                )}
                style={{ width: fieldColumnWidth }}
                title={dragEnabled ? "Drag onto canvas to GROUP BY this field. Cmd/Ctrl-click to multi-select." : undefined}
              >
                {dragEnabled ? (
                  <GripVertical className={cn("mr-1 h-3 w-3 shrink-0", role === "metric" ? "text-chart-3" : "text-main/70")} />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-foreground">{c.name}</span>
                <span className="ml-2 truncate text-[10px] text-chrome-text/70">
                  {c.dataTypeName ?? `oid:${c.dataTypeId}`}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    cycleSort(c.name)
                  }}
                  title="Sort row columns by this field"
                  className={cn(
                    "ml-1 shrink-0 px-0.5 text-[10px] leading-none hover:text-foreground",
                    sort?.col === c.name
                      ? "text-main"
                      : "text-chrome-text/40 opacity-0 group-hover:opacity-100",
                  )}
                >
                  {sort?.col === c.name ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                </button>
              </div>
              <div className="relative" style={{ width: transposedRowsWidth }}>
                {rowVirtualItems.map((vcol) => {
                  const row = viewRows[vcol.index]
                  const value = row?.[c.name]
                  const hl = paramHighlights.get(c.name)
                  const picked = hl ? hl.values.has(String(value)) : false
                  const crossPicked = crossHighlights.get(c.name)?.has(String(value)) ?? false
                  return (
                    <div
                      key={`${c.name}:${vcol.key}`}
                      onClick={(e) => {
                        if (onCellFilter) {
                          e.preventDefault()
                          e.stopPropagation()
                          onCellFilter(c, value)
                          return
                        }
                        if (!onEmitCellParam) return
                        e.preventDefault()
                        e.stopPropagation()
                        const cascade = e.metaKey || e.ctrlKey
                        onEmitCellParam(c.name, value, c.dataTypeId, "in", cascade, {
                          schema: c.sourceSchema,
                          table: c.sourceTable,
                          column: c.sourceColumn,
                        })
                      }}
                      onContextMenu={(e) => openCellContextMenu(e, row, rows.indexOf(row), c)}
                      className={cn(
                        "absolute top-0 h-full truncate border-r border-chrome-border/30 px-2 py-0.5 text-[12px]",
                        isNumeric ? "text-right tabular-nums" : "text-left",
                        value == null ? "text-chrome-text/40 italic" : "text-foreground",
                        (onEmitCellParam || onCellFilter) && "cursor-pointer hover:bg-main/10",
                        picked &&
                          (hl!.cascade
                            ? "bg-main/25 text-foreground"
                            : "bg-main/15 text-foreground ring-1 ring-inset ring-main/55"),
                        crossPicked && "bg-rvbbit-accent/20 text-foreground ring-1 ring-inset ring-rvbbit-accent/60",
                      )}
                      style={{ transform: `translateX(${vcol.start}px)`, width: vcol.size }}
                      title={
                        onCellFilter
                          ? `${value == null ? "null" : String(formatCellValue(value))} — click to filter the dashboard`
                          : onEmitCellParam
                            ? `${value == null ? "null" : String(formatCellValue(value))} — click to select · ⌘ filter`
                            : value == null ? "null" : String(formatCellValue(value))
                      }
                    >
                      {value == null ? "∅" : formatCellValue(value)}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
        </>
      ) : (
        <>
      <div className="sticky top-0 z-10 flex border-b border-chrome-border bg-chrome-bg/95 backdrop-blur" style={{ minWidth: totalWidth }}>
        {columns.map((c, i) => {
          const role = columnDragSource?.columns.find((col) => col.name === c.name)?.role
          const isSelected = selectedHeaders.has(c.name)
          return (
            <div
              key={c.name}
              draggable={dragEnabled}
              onDragStart={(e) => onHeaderDragStart(e, c.name)}
              onDragEnd={() => setActiveColumnDragSource(null)}
              onClick={(e) => onHeaderClick(e, c.name)}
              className={cn(
                "group relative flex select-none items-center border-r border-chrome-border/60 px-2 py-1 text-[11px] uppercase tracking-wider text-chrome-text",
                dragEnabled && "cursor-grab active:cursor-grabbing hover:bg-foreground/[0.05]",
                isSelected && "bg-main/15 text-foreground",
              )}
              style={{ width: columnWidths[i] }}
              title={dragEnabled ? "Drag onto canvas to GROUP BY this column. Cmd/Ctrl-click to multi-select." : undefined}
            >
              {dragEnabled ? (
                <GripVertical className={cn("mr-1 h-3 w-3 shrink-0", role === "metric" ? "text-chart-3" : "text-main/70")} />
              ) : null}
              <span className="truncate text-foreground">{c.name}</span>
              <span className="ml-2 truncate text-[10px] text-chrome-text/70">
                {c.dataTypeName ?? `oid:${c.dataTypeId}`}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  cycleSort(c.name)
                }}
                title="Sort by this column"
                className={cn(
                  "ml-1 shrink-0 px-0.5 text-[10px] leading-none hover:text-foreground",
                  sort?.col === c.name
                    ? "text-main"
                    : "text-chrome-text/40 opacity-0 group-hover:opacity-100",
                )}
              >
                {sort?.col === c.name ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
              </button>
              {present ? null : (
                <div
                  onPointerDown={(e) => startResize(c.name, e)}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-main/50"
                />
              )}
            </div>
          )
        })}
      </div>

      <div style={{ height: virtualizer.getTotalSize(), minWidth: totalWidth }} className="relative">
        {virtualizer.getVirtualItems().map((vrow) => {
          const row = viewRows[vrow.index]
          return (
            <div
              key={vrow.key}
              className={cn(
                "absolute left-0 right-0 flex border-b border-chrome-border/30",
                vrow.index % 2 === 0 ? "bg-transparent" : "bg-foreground/[0.025]",
              )}
              style={{ transform: `translateY(${vrow.start}px)`, height: ROW_HEIGHT, minWidth: totalWidth }}
            >
              {columns.map((c, ci) => {
                const value = row?.[c.name]
                const isNumeric = isNumericType(c)
                const hl = paramHighlights.get(c.name)
                const picked = hl ? hl.values.has(String(value)) : false
                const crossPicked = crossHighlights.get(c.name)?.has(String(value)) ?? false
                return (
                  <div
                    key={c.name}
                    onClick={(e) => {
                      // Cross-filter (multi-statement dashboard): a click filters
                      // sibling tiles by this column's real source table.
                      if (onCellFilter) {
                        e.preventDefault()
                        e.stopPropagation()
                        onCellFilter(c, value)
                        return
                      }
                      // Left-click → "pick": toggle this value into a multi-select
                      // IN set. It highlights + publishes to the shelf but does
                      // NOT filter this grid — drag the chip onto a target to bind.
                      // ⌘/Ctrl-click → cascade filter: narrows this grid (and any
                      // {block} children) — the classic drill-down.
                      if (!onEmitCellParam) return
                      e.preventDefault()
                      e.stopPropagation()
                      const cascade = e.metaKey || e.ctrlKey
                      onEmitCellParam(c.name, value, c.dataTypeId, "in", cascade, {
                        schema: c.sourceSchema,
                        table: c.sourceTable,
                        column: c.sourceColumn,
                      })
                    }}
                    onContextMenu={(e) => openCellContextMenu(e, row, rows.indexOf(row), c)}
                    className={cn(
                      "truncate border-r border-chrome-border/30 px-2 py-0.5 text-[12px]",
                      isNumeric ? "text-right tabular-nums" : "text-left",
                      value == null ? "text-chrome-text/40 italic" : "text-foreground",
                      (onEmitCellParam || onCellFilter) && "cursor-pointer hover:bg-main/10",
                      picked &&
                        (hl!.cascade
                          ? "bg-main/25 text-foreground"
                          : "bg-main/15 text-foreground ring-1 ring-inset ring-main/55"),
                      crossPicked && "bg-rvbbit-accent/20 text-foreground ring-1 ring-inset ring-rvbbit-accent/60",
                    )}
                    style={{ width: columnWidths[ci] }}
                    title={
                      onCellFilter
                        ? `${value == null ? "null" : String(formatCellValue(value))} — click to filter the dashboard`
                        : onEmitCellParam
                          ? `${value == null ? "null" : String(formatCellValue(value))} — click to select · ⌘ filter`
                          : value == null ? "null" : String(formatCellValue(value))
                    }
                  >
                    {value == null ? "∅" : formatCellValue(value)}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
        </>
      )}
      </div>
      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  )
}

function cellMatchesFilter(value: unknown, filter: string): boolean {
  return value != null && String(formatCellValue(value)).toLowerCase().includes(filter)
}

function columnMatchesFilter(column: QueryResultColumn, filter: string): boolean {
  return (
    column.name.toLowerCase().includes(filter) ||
    (column.dataTypeName ?? `oid:${column.dataTypeId}`).toLowerCase().includes(filter)
  )
}

function isNumericType(c: QueryResultColumn): boolean {
  const name = (c.dataTypeName ?? "").toLowerCase()
  if (!name) {
    return [20, 21, 23, 700, 701, 1700].includes(c.dataTypeId)
  }
  return (
    name.includes("int") ||
    name === "numeric" ||
    name.includes("float") ||
    name === "real" ||
    name === "double" ||
    name === "money"
  )
}

function estimateWidth(column: QueryResultColumn, rows: Record<string, unknown>[]): number {
  const sample = rows.slice(0, 20)
  const sampleMax = sample.reduce((max, r) => {
    const v = r[column.name]
    const len = v == null ? 1 : String(formatCellValue(v)).length
    return Math.max(max, len)
  }, column.name.length)
  return Math.min(360, Math.max(MIN_COL_WIDTH, sampleMax * 7 + 24))
}

function estimateFieldWidth(columns: QueryResultColumn[]): number {
  const max = columns.reduce((n, c) => Math.max(n, c.name.length + (c.dataTypeName?.length ?? 0) + 4), 12)
  return Math.min(360, Math.max(180, max * 7 + 28))
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Best effort only; right-click copy should never disturb the grid.
  }
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value
  if (value != null && typeof value === "object") return stringifyJson(value)
  return formatCellValue(value)
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)
  } catch {
    return String(value)
  }
}
