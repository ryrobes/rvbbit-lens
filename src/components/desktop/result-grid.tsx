"use client"

import { useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { GripVertical } from "@/lib/icons"
import type { QueryResultColumn } from "@/lib/db/types"
import type { DesktopColumnDragPayload, DesktopColumnRef } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
import { formatCellValue } from "@/lib/sql/format"
import { writeColumnDragPayload } from "@/lib/desktop/column-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"

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
  /** When provided, headers become draggable and emit a column-drag payload. */
  columnDragSource?: ColumnDragSource | null
  /** When provided, clicking a cell emits a cascading-filter param. */
  onEmitCellParam?: (field: string, value: unknown, dataTypeId: number, operator?: "eq" | "in") => void
}

const ROW_HEIGHT = 24
const MIN_COL_WIDTH = 80
const DEFAULT_COL_WIDTH = 160

export function ResultGrid({
  columns,
  rows,
  className,
  columnDragSource,
  onEmitCellParam,
}: ResultGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [selectedHeaders, setSelectedHeaders] = useState<Set<string>>(new Set())

  function onHeaderDragStart(e: React.DragEvent<HTMLDivElement>, name: string) {
    if (!columnDragSource) return
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
    }
    writeColumnDragPayload(e.dataTransfer, payload)
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
    if (!columnDragSource) return
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

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  })

  function startResize(name: string, e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[name] ?? estimateWidth(columns.find((c) => c.name === name)!, rows)
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

  return (
    <div ref={parentRef} className={cn("flex h-full flex-col overflow-auto bg-doc-bg", className)}>
      <div className="sticky top-0 z-10 flex border-b border-chrome-border bg-chrome-bg/95 backdrop-blur" style={{ minWidth: totalWidth }}>
        {columns.map((c, i) => {
          const role = columnDragSource?.columns.find((col) => col.name === c.name)?.role
          const isSelected = selectedHeaders.has(c.name)
          return (
            <div
              key={c.name}
              draggable={!!columnDragSource}
              onDragStart={(e) => onHeaderDragStart(e, c.name)}
              onClick={(e) => onHeaderClick(e, c.name)}
              className={cn(
                "relative flex select-none items-center border-r border-chrome-border/60 px-2 py-1 text-[11px] uppercase tracking-wider text-chrome-text",
                columnDragSource && "cursor-grab active:cursor-grabbing hover:bg-foreground/[0.05]",
                isSelected && "bg-main/15 text-foreground",
              )}
              style={{ width: columnWidths[i] }}
              title={columnDragSource ? "Drag onto canvas to GROUP BY this column. Cmd/Ctrl-click to multi-select." : undefined}
            >
              {columnDragSource ? (
                <GripVertical className={cn("mr-1 h-3 w-3 shrink-0", role === "metric" ? "text-chart-3" : "text-main/70")} />
              ) : null}
              <span className="truncate text-foreground">{c.name}</span>
              <span className="ml-2 truncate text-[10px] text-chrome-text/70">
                {c.dataTypeName ?? `oid:${c.dataTypeId}`}
              </span>
              <div
                onPointerDown={(e) => startResize(c.name, e)}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-main/50"
              />
            </div>
          )
        })}
      </div>

      <div style={{ height: virtualizer.getTotalSize(), minWidth: totalWidth }} className="relative">
        {virtualizer.getVirtualItems().map((vrow) => {
          const row = rows[vrow.index]
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
                return (
                  <div
                    key={c.name}
                    onClick={(e) => {
                      // Plain click on a cell → emit/toggle a cascading-filter
                      // param keyed on (this window's block).(column name).
                      // Cmd/Ctrl-click → "in" operator (multi-value accumulate).
                      if (!onEmitCellParam) return
                      e.preventDefault()
                      e.stopPropagation()
                      const operator = e.metaKey || e.ctrlKey ? "in" : "eq"
                      onEmitCellParam(c.name, value, c.dataTypeId, operator)
                    }}
                    className={cn(
                      "truncate border-r border-chrome-border/30 px-2 py-0.5 text-[12px]",
                      isNumeric ? "text-right tabular-nums" : "text-left",
                      value == null ? "text-chrome-text/40 italic" : "text-foreground",
                      onEmitCellParam && "cursor-pointer hover:bg-main/10",
                    )}
                    style={{ width: columnWidths[ci] }}
                    title={
                      onEmitCellParam
                        ? `${value == null ? "null" : String(formatCellValue(value))} — click to filter · ⌘-click to add`
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
    </div>
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
