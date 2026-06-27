"use client"

import { useCallback, useMemo, useState } from "react"
import { VegaEmbed } from "react-vega"
import type { Result as VegaEmbedResult } from "vega-embed"
import { BarChart3, ChevronDown, ChevronRight, Hash, LineChart, Table2 } from "@/lib/icons"
import type { QueryResultColumn, StatementResult } from "@/lib/db/types"
import type { DesktopParamValue, StatementViewKind } from "@/lib/desktop/types"
import type { CrossFilter } from "@/lib/desktop/reactive-sql"
import { classifyColumn, inferChartSpec } from "@/lib/desktop/chart-infer"
import { vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"
import { ResultGrid } from "./result-grid"
import { extractUiArtifacts, UiArtifactView, type UiArtifactActionInput, type UiArtifactActionResult, type UiArtifactParamInput } from "./ui-artifact-view"

// A vertical "transcript" of every statement's result in a multi-statement block —
// nothing swallowed. Each statement is a compact card: a header (#, command,
// summary, statement text, and — for SELECTs with rows — a tiny view switcher) +
// a collapsible body (grid / chart / big-number for SELECTs, summary for DML).
// Per-card view picks persist in the block payload (see statementViewKey). The
// card pieces (CardMeta / ViewSwitcher / CardBody) are exported so ArrangeGrid can
// render the SAME tiles in a bento grid.

const COMMAND_COLOR: Record<string, string> = {
  SELECT: "text-rvbbit-accent",
  INSERT: "text-success",
  UPDATE: "text-warning",
  DELETE: "text-danger",
}

const VIEW_BUTTONS: { kind: StatementViewKind; icon: React.ComponentType<{ className?: string }>; title: string }[] = [
  { kind: "table", icon: Table2, title: "Table" },
  { kind: "number", icon: Hash, title: "Big number" },
  { kind: "bar", icon: BarChart3, title: "Bar chart" },
  { kind: "line", icon: LineChart, title: "Line chart" },
]

/** Stable key for a statement's view override — a hash of its normalized text, so
 *  an override follows the statement across reorder. We hash the SOURCE statement
 *  (pre-filter) when available so the key is STABLE while a cross-filter/broadcast
 *  rewrites the executed SQL — otherwise the view + tile layout would reset on every
 *  filter. Falls back to the executed text, then position. */
export function statementViewKey(s: StatementResult, sourceText?: string): string {
  const text = sourceText ?? s.sql
  if (!text) return `idx:${s.index}`
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** The full per-run key set — the single source of truth for BOTH statementViews
 *  and statementLayout, so a tile's view + slot + span always appear/disappear
 *  together. Identical statements get an occurrence suffix (#N) so they stay
 *  distinct. keys[i] corresponds to results[i]. */
export function statementKeys(results: StatementResult[], sourceStatements?: string[]): string[] {
  const seen = new Map<string, number>()
  return results.map((s) => {
    const base = statementViewKey(s, sourceStatements?.[s.index])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}

export function defaultKind(s: StatementResult): StatementViewKind {
  // A lone scalar reads better as a number than a 1×1 table; everything else is a
  // table until the user flips it (no surprise auto-charting of detail queries).
  if (s.rows.length === 1 && s.columns.length === 1) return "number"
  return "table"
}

function summaryOf(s: StatementResult): string {
  if (s.columns.length > 0) {
    return `${s.rows.length}${s.truncated ? "+" : ""} row${s.rows.length === 1 ? "" : "s"}`
  }
  if (s.command === "INSERT" || s.command === "UPDATE" || s.command === "DELETE") {
    return `${s.rowCount} row${s.rowCount === 1 ? "" : "s"} affected`
  }
  return "OK"
}

/** The statement's identity row: index badge, command tag, summary, text. */
export function CardMeta({ s }: { s: StatementResult }) {
  const cmd = s.command || "—"
  const color = COMMAND_COLOR[cmd] ?? "text-chrome-text/70"
  return (
    <>
      <span className="inline-flex h-4 items-center justify-center rounded bg-foreground/[0.08] px-1 text-[9px] tabular-nums text-chrome-text/70">
        {s.index + 1}
      </span>
      <span className={cn("shrink-0 font-medium uppercase tracking-wide", color)}>{cmd}</span>
      <span className="shrink-0 tabular-nums text-chrome-text/55">{summaryOf(s)}</span>
      {s.sql ? (
        <span className="truncate font-mono text-[10px] text-chrome-text/45">{s.sql.replace(/\s+/g, " ")}</span>
      ) : null}
    </>
  )
}

/** The 4-icon table/number/bar/line switcher (writes statementViews in both modes). */
export function ViewSwitcher({
  viewKey,
  kind,
  onSetView,
}: {
  viewKey: string
  kind: StatementViewKind
  onSetView: (key: string, kind: StatementViewKind) => void
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-chrome-border/50 p-0.5">
      {VIEW_BUTTONS.map(({ kind: k, icon: Icon, title }) => (
        <button
          key={k}
          type="button"
          title={title}
          onClick={() => onSetView(viewKey, k)}
          className={cn(
            "grid h-4 w-4 place-items-center rounded transition-colors",
            kind === k ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/40 hover:text-foreground",
          )}
        >
          <Icon className="h-3 w-3" />
        </button>
      ))}
    </span>
  )
}

export function ResultTranscript({
  results,
  views,
  onSetView,
  onCellFilter,
  onChartFilter,
  crossFilters,
  sourceStatements,
  activeParams,
  onEmitParam,
  onRunAction,
}: {
  results: StatementResult[]
  /** Per-statement view overrides, keyed by statementKeys. */
  views?: Record<string, StatementViewKind>
  onSetView?: (key: string, kind: StatementViewKind) => void
  /** Click a grid cell to cross-filter sibling statements by its source table.
   *  `stmtIndex` is the clicked statement so it can be excluded (no self-filter). */
  onCellFilter?: (column: QueryResultColumn, value: unknown, stmtIndex: number) => void
  /** Click a chart mark → cross-filter, mirroring the point-selection SET. */
  onChartFilter?: (column: QueryResultColumn, values: unknown[], stmtIndex: number) => void
  /** Active block-local cross-filters — each tile highlights the value(s) clicked IN
   *  it (so the selection stays visible after the re-run remount). */
  crossFilters?: CrossFilter[]
  /** Pre-filter statement texts (by index) for STABLE view/layout keys across a
   *  cross-filter/broadcast rewrite. */
  sourceStatements?: string[]
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  onRunAction?: (input: UiArtifactActionInput) => Promise<UiArtifactActionResult>
}) {
  // Expand/collapse is a delta on the per-card default (has-grid → open). View
  // kind lives in `views` (the payload) so it survives the per-run remount.
  const [toggled, setToggled] = useState<Set<number>>(new Set())
  const toggle = (i: number) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const keys = useMemo(() => statementKeys(results, sourceStatements), [results, sourceStatements])

  return (
    <div className="flex h-full flex-col gap-1.5 overflow-y-auto bg-doc-bg p-1.5">
      {results.map((s) => {
        const hasGrid = s.columns.length > 0 && s.rows.length > 0
        const emptySelect = s.columns.length > 0 && s.rows.length === 0
        const expandable = hasGrid || emptySelect || !!s.sql
        const open = (toggled.has(s.index) ? !hasGrid : hasGrid) && expandable
        const key = keys[s.index]
        const kind: StatementViewKind = views?.[key] ?? defaultKind(s)
        return (
          <div
            key={s.index}
            className="shrink-0 overflow-hidden rounded-md border border-chrome-border/70 bg-chrome-bg/40"
          >
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => expandable && toggle(s.index)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 text-left",
                  expandable ? "cursor-pointer" : "cursor-default",
                )}
              >
                {expandable ? (
                  open ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-chrome-text/50" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-chrome-text/50" />
                  )
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <CardMeta s={s} />
              </button>
              {hasGrid && onSetView ? <ViewSwitcher viewKey={key} kind={kind} onSetView={onSetView} /> : null}
            </div>
            {open ? (
              <div className="border-t border-chrome-border/50">
                {s.sql ? (
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap border-b border-chrome-border/40 bg-doc-bg px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-chrome-text/70">
                    {s.sql}
                  </pre>
                ) : null}
                <CardBody
                  s={s}
                  kind={hasGrid ? kind : "table"}
                  hasGrid={hasGrid}
                  emptySelect={emptySelect}
                  onCellFilter={onCellFilter ? (c, v) => onCellFilter(c, v, s.index) : undefined}
                  onChartFilter={onChartFilter ? (c, v) => onChartFilter(c, v, s.index) : undefined}
                  highlightFilters={crossFilters?.filter((f) => f.sourceStmtIndex === s.index)}
                  activeParams={activeParams}
                  onEmitParam={onEmitParam}
                  onRunAction={onRunAction}
                  sourceStmtIndex={s.index}
                />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** The result body for one statement at a given view kind. `fill` makes the grid/
 *  number fill its container (arrange tiles) instead of a fixed transcript height. */
export function CardBody({
  s,
  kind,
  hasGrid,
  emptySelect,
  fill,
  onCellFilter,
  onChartFilter,
  highlightFilters,
  activeParams,
  onEmitParam,
  onRunAction,
  sourceStmtIndex,
}: {
  s: StatementResult
  kind: StatementViewKind
  hasGrid: boolean
  emptySelect: boolean
  fill?: boolean
  onCellFilter?: (column: QueryResultColumn, value: unknown) => void
  onChartFilter?: (column: QueryResultColumn, values: unknown[]) => void
  /** Cross-filters that ORIGINATED in this tile — highlight their value(s). */
  highlightFilters?: CrossFilter[]
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  onRunAction?: (input: UiArtifactActionInput) => Promise<UiArtifactActionResult>
  sourceStmtIndex?: number
}) {
  if (!hasGrid) {
    return emptySelect ? (
      <div className="px-2 py-3 text-center text-[11px] text-chrome-text/45">No rows returned.</div>
    ) : null
  }
  const uiArtifacts = extractUiArtifacts(s.rows)
  if (uiArtifacts) {
    return (
      <div className={fill ? "h-full" : "h-72"}>
        <UiArtifactView
          artifacts={uiArtifacts}
          fill
          activeParams={activeParams}
          onEmitParam={onEmitParam}
          onRunAction={onRunAction}
          sourceStmtIndex={sourceStmtIndex}
        />
      </div>
    )
  }
  if (kind === "number") {
    return (
      <div className={fill ? "h-full" : "h-40"}>
        <BigNumber s={s} fill={fill} />
      </div>
    )
  }
  if (kind === "bar" || kind === "line") {
    return (
      <MiniChart columns={s.columns} rows={s.rows} kind={kind} fill={fill} onChartFilter={onChartFilter} highlightFilters={highlightFilters} />
    )
  }
  return (
    <div className={fill ? "h-full" : "h-56"}>
      <ResultGrid columns={s.columns} rows={s.rows} onCellFilter={onCellFilter} highlightFilters={highlightFilters} />
    </div>
  )
}

function BigNumber({ s, fill }: { s: StatementResult; fill?: boolean }) {
  const col = s.columns.find((c) => classifyColumn(c) === "numeric") ?? s.columns[0]
  const val = col ? s.rows[0]?.[col.name] : undefined
  const isNull = val === null || val === undefined
  // Compact when filling a small arrange tile (a 1×1 is only ~58px tall after the
  // header): smaller number, no secondary line.
  return (
    <div className={cn("flex h-full min-w-0 flex-col items-center justify-center gap-0.5", fill ? "p-2" : "gap-1 p-4")}>
      <div
        className={cn(
          "max-w-full truncate font-semibold tabular-nums",
          fill ? "text-2xl" : "text-3xl",
          isNull ? "text-chrome-text/40" : "text-foreground",
        )}
      >
        {isNull ? "NULL" : formatCellValue(val)}
      </div>
      {col ? (
        <div className="max-w-full truncate text-[11px] uppercase tracking-wide text-chrome-text/50">{col.name}</div>
      ) : null}
      {!fill && s.rows.length > 1 ? (
        <div className="text-[10px] text-chrome-text/40">first of {s.rows.length} rows</div>
      ) : null}
    </div>
  )
}

function MiniChart({
  columns,
  rows,
  kind,
  fill,
  onChartFilter,
  highlightFilters,
}: {
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  kind: "bar" | "line"
  fill?: boolean
  onChartFilter?: (column: QueryResultColumn, values: unknown[]) => void
  highlightFilters?: CrossFilter[]
}) {
  const inferred = useMemo(() => inferChartSpec(columns, rows), [columns, rows])
  const xField = inferred?.xField ?? null

  // Value(s) of a cross-filter that ORIGINATED in this tile, matched to the chart's x
  // field by pg provenance — used to keep the clicked mark highlighted AFTER the
  // re-run remount (data-driven, so it survives Vega losing its transient selection).
  const highlightValues = useMemo(() => {
    if (!xField || !highlightFilters?.length) return null
    const col = columns.find((c) => c.name === xField)
    const f = highlightFilters.find(
      (hf) => {
        if (!col) return false
        if (!hf.sourceTable) return hf.column.toLowerCase() === col.name.toLowerCase()
        return (
          !!col.sourceColumn &&
          hf.column.toLowerCase() === col.sourceColumn.toLowerCase() &&
          (!col.sourceTable || hf.sourceTable.toLowerCase() === col.sourceTable.toLowerCase())
        )
      },
    )
    if (!f) return null
    const vals = (Array.isArray(f.value) ? f.value : [f.value]).filter((v) => v !== null && v !== undefined)
    return vals.length ? vals : null
  }, [xField, highlightFilters, columns])

  const spec = useMemo(() => {
    if (!inferred) return null
    const base: Record<string, unknown> = { ...inferred.spec }
    // Keep the inferred axes; just swap the mark to the user's pick. Axes come
    // from column types (inferChartSpec) so there's no axis UI to author.
    base.mark =
      kind === "line" ? { type: "line", point: true, interpolate: "monotone" } : { type: "bar" }
    // Persistent selection highlight: when a value clicked in THIS tile is active, dim
    // non-matching marks via a data-driven opacity (Vega's own click-selection resets
    // on the re-run re-render, so we drive it from the cross-filter instead).
    if (highlightValues && xField && base.encoding && typeof base.encoding === "object") {
      const fld = JSON.stringify(xField)
      const test = highlightValues
        .map((v) => `datum[${fld}] === ${typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v))}`)
        .join(" || ")
      base.encoding = { ...(base.encoding as Record<string, unknown>), opacity: { condition: { test, value: 1 }, value: 0.3 } }
    }
    return {
      ...base,
      config: vegaConfigFromTheme(),
      data: { values: rows },
      width: "container",
      height: "container",
      autosize: { type: "fit", contains: "padding", resize: true },
    }
  }, [inferred, kind, rows, highlightValues, xField])

  // Wire the chart's point-selection "click" signal → cross-filter (mirrors the
  // single-block chart → global-param path, so multi-statement charts filter too).
  const handleEmbed = useCallback(
    (res: VegaEmbedResult) => {
      if (!onChartFilter) return
      const handler = (_name: string, value: unknown) => {
        let field: string | null = null
        let values: unknown[] = []
        if (value && typeof value === "object") {
          const entries = Object.entries(value as Record<string, unknown>).filter(
            ([k]) => k !== "_vgsid_" && k !== "vlPoint",
          )
          if (entries.length > 0) {
            const [f, raw] = entries[0] as [string, unknown]
            field = f
            values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined && v !== null)
          }
        }
        const fld = field ?? xField // empty selection carries no field → use the x field to clear
        if (!fld) return
        const col = columns.find((c) => c.name === fld)
        if (!col) return
        // Vega parses a temporal axis into epoch-ms / Date — convert back to an ISO
        // string so the predicate (`order_date = '2024-01-15…'`) matches the pg
        // date/timestamp column instead of `= 1705276800000` (zero rows). Defensively
        // ISO-stringify ANY Date so it never reaches quoteSqlLiteral as a JS object.
        const temporal = classifyColumn(col) === "temporal"
        const norm = values.map((v) =>
          v instanceof Date ? v.toISOString() : temporal && typeof v === "number" ? new Date(v).toISOString() : v,
        )
        onChartFilter(col, norm)
      }
      try {
        res.view.addSignalListener("click", handler)
      } catch {
        /* spec has no "click" selection (non-selectable chart) — ignore */
      }
    },
    [columns, onChartFilter, xField],
  )

  if (!spec) {
    return (
      <div className="grid h-24 place-items-center px-3 text-center text-[11px] text-chrome-text/45">
        Not chartable — needs a numeric column.
      </div>
    )
  }
  return (
    <div className={cn("min-h-0 p-1", fill ? "h-full w-full" : "h-56 w-full")}>
      <VegaEmbed
        spec={spec as unknown as Parameters<typeof VegaEmbed>[0]["spec"]}
        options={{ actions: false, renderer: "svg", tooltip: { theme: "dark" } }}
        onEmbed={handleEmbed}
        className="h-full w-full"
      />
    </div>
  )
}
