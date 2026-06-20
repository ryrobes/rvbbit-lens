"use client"

import { useMemo, useState } from "react"
import { VegaEmbed } from "react-vega"
import { BarChart3, ChevronDown, ChevronRight, Hash, LineChart, Table2 } from "@/lib/icons"
import type { QueryResultColumn, StatementResult } from "@/lib/db/types"
import type { StatementViewKind } from "@/lib/desktop/types"
import { classifyColumn, inferChartSpec } from "@/lib/desktop/chart-infer"
import { vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"
import { ResultGrid } from "./result-grid"

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
 *  an override follows the statement across reorder and resets if it's rewritten.
 *  Falls back to position when the statement couldn't be labeled. */
export function statementViewKey(s: StatementResult): string {
  if (!s.sql) return `idx:${s.index}`
  const norm = s.sql.toLowerCase().replace(/\s+/g, " ").trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** The full per-run key set — the single source of truth for BOTH statementViews
 *  and statementLayout, so a tile's view + slot + span always appear/disappear
 *  together. Identical statements get an occurrence suffix (#N) so they stay
 *  distinct. keys[i] corresponds to results[i]. */
export function statementKeys(results: StatementResult[]): string[] {
  const seen = new Map<string, number>()
  return results.map((s) => {
    const base = statementViewKey(s)
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
}: {
  results: StatementResult[]
  /** Per-statement view overrides, keyed by statementKeys. */
  views?: Record<string, StatementViewKind>
  onSetView?: (key: string, kind: StatementViewKind) => void
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

  const keys = useMemo(() => statementKeys(results), [results])

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
                <CardBody s={s} kind={hasGrid ? kind : "table"} hasGrid={hasGrid} emptySelect={emptySelect} />
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
}: {
  s: StatementResult
  kind: StatementViewKind
  hasGrid: boolean
  emptySelect: boolean
  fill?: boolean
}) {
  if (!hasGrid) {
    return emptySelect ? (
      <div className="px-2 py-3 text-center text-[11px] text-chrome-text/45">No rows returned.</div>
    ) : null
  }
  if (kind === "number") {
    return (
      <div className={fill ? "h-full" : "h-40"}>
        <BigNumber s={s} fill={fill} />
      </div>
    )
  }
  if (kind === "bar" || kind === "line") {
    return <MiniChart columns={s.columns} rows={s.rows} kind={kind} fill={fill} />
  }
  return (
    <div className={fill ? "h-full" : "h-56"}>
      <ResultGrid columns={s.columns} rows={s.rows} />
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
}: {
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  kind: "bar" | "line"
  fill?: boolean
}) {
  const spec = useMemo(() => {
    const inferred = inferChartSpec(columns, rows)
    if (!inferred) return null
    const base: Record<string, unknown> = { ...inferred.spec }
    // Keep the inferred axes; just swap the mark to the user's pick. Axes come
    // from column types (inferChartSpec) so there's no axis UI to author.
    base.mark =
      kind === "line" ? { type: "line", point: true, interpolate: "monotone" } : { type: "bar" }
    return {
      ...base,
      config: vegaConfigFromTheme(),
      data: { values: rows },
      width: "container",
      height: fill ? "container" : 200,
      autosize: { type: "fit", contains: "padding", resize: true },
    }
  }, [columns, rows, kind, fill])

  if (!spec) {
    return (
      <div className="grid h-24 place-items-center px-3 text-center text-[11px] text-chrome-text/45">
        Not chartable — needs a numeric column.
      </div>
    )
  }
  return (
    <div className={cn("p-1", fill ? "h-full w-full" : "w-full")}>
      <VegaEmbed
        spec={spec as unknown as Parameters<typeof VegaEmbed>[0]["spec"]}
        options={{ actions: false, renderer: "svg", tooltip: { theme: "dark" } }}
        className={fill ? "h-full w-full" : "w-full"}
      />
    </div>
  )
}
