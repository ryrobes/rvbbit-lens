"use client"

import { useMemo } from "react"
import { VegaEmbed } from "react-vega"
import type { VisualizationSpec } from "vega-embed"
import { Check } from "@/lib/icons"
import { vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import type { DesktopParamOperator, DesktopParamValue } from "@/lib/desktop/types"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"

export interface UiArtifactRow extends Record<string, unknown> {
  rvbbit_artifact: "ui"
  artifact_id?: string
  artifact_kind?: string
  renderer?: string
  title?: string
  spec?: Record<string, unknown> | null
  data?: unknown[] | null
  layout?: Record<string, unknown> | null
  bindings?: Record<string, unknown> | null
  diagnostics?: Record<string, unknown> | null
}

export function extractUiArtifacts(rows: Record<string, unknown>[]): UiArtifactRow[] | null {
  if (rows.length === 0) return null
  const artifacts = rows.filter((row): row is UiArtifactRow => row.rvbbit_artifact === "ui")
  return artifacts.length === rows.length ? artifacts : null
}

export type UiArtifactParamInput = {
  field: string
  value: unknown
  operator?: DesktopParamOperator
  multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
  cascade?: boolean
  type?: string
  sourceStmtIndex?: number
}

export function UiArtifactView({
  artifacts,
  fill,
  activeParams,
  onEmitParam,
  sourceStmtIndex,
}: {
  artifacts: UiArtifactRow[]
  fill?: boolean
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  sourceStmtIndex?: number
}) {
  return (
    <div className={cn("grid gap-2 overflow-auto bg-doc-bg p-2", fill ? "h-full auto-rows-fr" : "h-full auto-rows-min")}>
      {artifacts.map((artifact, index) => (
        <UiArtifactCard
          key={artifact.artifact_id ?? `${artifact.renderer ?? "artifact"}-${index}`}
          artifact={artifact}
          fill={fill}
          activeParams={activeParams}
          onEmitParam={onEmitParam}
          sourceStmtIndex={sourceStmtIndex}
        />
      ))}
    </div>
  )
}

function UiArtifactCard({
  artifact,
  fill,
  activeParams,
  onEmitParam,
  sourceStmtIndex,
}: {
  artifact: UiArtifactRow
  fill?: boolean
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  sourceStmtIndex?: number
}) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-md border border-chrome-border/70 bg-chrome-bg/45", fill ? "h-full" : "")}>
      {artifact.title ? (
        <div className="border-b border-chrome-border/60 px-2 py-1.5 text-[11px] font-medium text-chrome-text">
          {artifact.title}
        </div>
      ) : null}
      <div className={cn("min-h-0", fill ? "h-[calc(100%-2rem)]" : "")}>
        {artifact.renderer === "metric_card" ? (
          <MetricCardArtifact artifact={artifact} fill={fill} />
        ) : artifact.renderer === "vega_lite" ? (
          <VegaLiteArtifact artifact={artifact} fill={fill} />
        ) : artifact.renderer === "table_view" ? (
          <TableArtifact artifact={artifact} fill={fill} />
        ) : artifact.renderer === "filter_control" ? (
          <FilterControlArtifact
            artifact={artifact}
            fill={fill}
            activeParams={activeParams}
            onEmitParam={onEmitParam}
            sourceStmtIndex={sourceStmtIndex}
          />
        ) : (
          <pre className="max-h-80 overflow-auto p-3 text-[11px] text-chrome-text">
            {JSON.stringify(artifact, null, 2)}
          </pre>
        )}
      </div>
    </section>
  )
}

const MAX_CONTROL_OPTIONS = 500

const keyOf = (v: unknown): string => (v == null ? "__rvbbit_null__" : String(v))

function rowsForArtifact(artifact: UiArtifactRow): Record<string, unknown>[] {
  return Array.isArray(artifact.data)
    ? artifact.data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    : []
}

function artifactString(spec: Record<string, unknown>, key: string): string {
  const value = spec[key]
  return typeof value === "string" ? value.trim() : ""
}

function controlKind(spec: Record<string, unknown>): "dropdown" | "multiselect" | "datepicker" | "slider" {
  const raw = artifactString(spec, "kind").toLowerCase()
  if (raw === "multiselect") return "multiselect"
  if (raw === "datepicker") return "datepicker"
  if (raw === "slider") return "slider"
  return "dropdown"
}

function controlOperator(spec: Record<string, unknown>, kind: string): DesktopParamOperator {
  const raw = artifactString(spec, "operator").toLowerCase()
  if (raw === "eq" || raw === "in" || raw === "gte" || raw === "lte") return raw
  return kind === "slider" || kind === "datepicker" ? "gte" : "in"
}

function distinctFieldValues(rows: Record<string, unknown>[], field: string): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const row of rows) {
    const value = row[field]
    const key = keyOf(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= MAX_CONTROL_OPTIONS) break
  }
  out.sort((a, b) => (a == null ? 1 : b == null ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })))
  return out
}

function fieldBounds(rows: Record<string, unknown>[], field: string): { min: unknown; max: unknown } | null {
  let min: unknown
  let max: unknown
  let any = false
  for (const row of rows) {
    const value = row[field]
    if (value == null) continue
    if (!any) {
      min = value
      max = value
      any = true
      continue
    }
    if (String(value) < String(min)) min = value
    if (String(value) > String(max)) max = value
  }
  return any ? { min, max } : null
}

function selectedValues(activeParams: DesktopParamValue[] | undefined, field: string): unknown[] {
  const param = activeParams?.find((p) => p.field === field && p.cascade === false)
  if (!param) return []
  return Array.isArray(param.value) ? param.value : [param.value]
}

function FilterControlArtifact({
  artifact,
  fill,
  activeParams,
  onEmitParam,
  sourceStmtIndex,
}: {
  artifact: UiArtifactRow
  fill?: boolean
  activeParams?: DesktopParamValue[]
  onEmitParam?: (input: UiArtifactParamInput) => void
  sourceStmtIndex?: number
}) {
  const spec = artifact.spec ?? {}
  const field = artifactString(spec, "field")
  const kind = controlKind(spec)
  const operator = controlOperator(spec, kind)
  const rows = rowsForArtifact(artifact)
  const selected = selectedValues(activeParams, field)
  const selectedKeys = new Set(selected.map(keyOf))
  const disabled = !field || !onEmitParam
  if (!field) {
    return <div className="p-3 text-xs text-chrome-text/50">No field.</div>
  }

  const emit = (value: unknown, action: UiArtifactParamInput["multiValueAction"] = "set", op = operator) => {
    onEmitParam?.({ field, value, operator: op, multiValueAction: action, cascade: false, sourceStmtIndex })
  }

  if (kind === "datepicker") {
    const bounds = fieldBounds(rows, field)
    const current = selected[0] == null ? "" : String(selected[0]).slice(0, 10)
    return (
      <div className={cn("flex min-w-0 flex-col justify-center gap-2 p-3", fill ? "h-full" : "min-h-28")}>
        <input
          type="date"
          value={current}
          min={bounds?.min == null ? undefined : String(bounds.min).slice(0, 10)}
          max={bounds?.max == null ? undefined : String(bounds.max).slice(0, 10)}
          disabled={disabled}
          onChange={(event) => emit(event.target.value || null, "set", operator === "lte" ? "lte" : "gte")}
          className="rounded border border-chrome-border bg-secondary-background px-2 py-1 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-55"
        />
        {selected.length > 0 ? (
          <button type="button" onClick={() => emit(null, "remove", operator)} className="text-left text-[11px] text-chrome-text/55 hover:text-foreground">
            Clear
          </button>
        ) : null}
      </div>
    )
  }

  if (kind === "slider") {
    const values = rows.map((row) => Number(row[field])).filter((v) => Number.isFinite(v))
    const min = values.length ? Math.min(...values) : 0
    const max = values.length ? Math.max(...values) : 100
    const current = selected[0] == null || Number.isNaN(Number(selected[0])) ? min : Number(selected[0])
    return (
      <div className={cn("flex min-w-0 flex-col justify-center gap-2 p-3", fill ? "h-full" : "min-h-28")}>
        <div className="flex items-center justify-between gap-2 text-[11px] text-chrome-text/60">
          <span>{formatCellValue(min)}</span>
          <span className="font-mono text-foreground">{formatCellValue(current)}</span>
          <span>{formatCellValue(max)}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={(max - min) / 100 || 1}
          value={current}
          disabled={disabled}
          onChange={(event) => emit(Number(event.target.value), "set", operator === "lte" ? "lte" : "gte")}
          className="w-full accent-[var(--rvbbit-accent)] disabled:opacity-55"
        />
      </div>
    )
  }

  const options = distinctFieldValues(rows, field)
  if (kind === "dropdown") {
    const current = selected.length > 0 ? keyOf(selected[0]) : ""
    return (
      <div className={cn("flex min-w-0 flex-col justify-center gap-2 p-3", fill ? "h-full" : "min-h-28")}>
        <select
          value={current}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === "") {
              if (selected.length > 0) emit(selected[0], "remove", "in")
              return
            }
            const value = options.find((option) => keyOf(option) === event.target.value)
            emit(value, "set", "in")
          }}
          className="rounded border border-chrome-border bg-secondary-background px-2 py-1 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-55"
        >
          <option value="">(any)</option>
          {options.map((option) => (
            <option key={keyOf(option)} value={keyOf(option)}>
              {option == null ? "NULL" : formatCellValue(option)}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className={cn("min-h-0 overflow-auto p-1", fill ? "h-full" : "max-h-80")}>
      {options.map((option) => {
        const active = selectedKeys.has(keyOf(option))
        return (
          <button
            key={keyOf(option)}
            type="button"
            disabled={disabled}
            onClick={() => emit(option, "toggle", "in")}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-foreground transition-colors disabled:opacity-55",
              active ? "bg-main/15 ring-1 ring-inset ring-main/45" : "hover:bg-main/10",
            )}
          >
            <span className={cn("grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border", active ? "border-main bg-main/30" : "border-chrome-border")}>
              {active ? <Check className="h-2.5 w-2.5 text-main" /> : null}
            </span>
            <span className={cn("truncate", option == null && "italic text-chrome-text/45")}>
              {option == null ? "NULL" : formatCellValue(option)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function MetricCardArtifact({ artifact, fill }: { artifact: UiArtifactRow; fill?: boolean }) {
  const spec = artifact.spec ?? {}
  const value = spec.value
  const label = typeof spec.label === "string" && spec.label.trim() ? spec.label : artifact.title
  return (
    <div className={cn("flex min-w-0 flex-col justify-center gap-1 px-4 py-5", fill ? "h-full" : "min-h-32")}>
      <div className={cn("truncate font-semibold tabular-nums text-foreground", fill ? "text-3xl" : "text-4xl")}>
        {value === null || value === undefined ? "NULL" : formatCellValue(value)}
      </div>
      {label ? (
        <div className="truncate text-[11px] uppercase tracking-wide text-chrome-text/55">{label}</div>
      ) : null}
    </div>
  )
}

function VegaLiteArtifact({ artifact, fill }: { artifact: UiArtifactRow; fill?: boolean }) {
  const spec = useMemo(() => {
    const base = artifact.spec && typeof artifact.spec === "object" ? { ...artifact.spec } : {}
    return {
      ...base,
      config: { ...vegaConfigFromTheme(), ...((base.config as Record<string, unknown> | undefined) ?? {}) },
      width: base.width ?? "container",
      height: fill ? "container" : base.height ?? "container",
      autosize: base.autosize ?? { type: "fit", contains: "padding", resize: true },
    }
  }, [artifact.spec, fill])
  return (
    <div className={cn("min-h-0 p-2", fill ? "h-full w-full" : "h-72 w-full")}>
      <VegaEmbed
        spec={spec as unknown as VisualizationSpec}
        options={{ actions: false, renderer: "svg", tooltip: { theme: "dark" } }}
        className="h-full w-full"
      />
    </div>
  )
}

function TableArtifact({ artifact, fill }: { artifact: UiArtifactRow; fill?: boolean }) {
  const rows = Array.isArray(artifact.data) ? artifact.data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : []
  const columns = Array.isArray(artifact.spec?.columns)
    ? artifact.spec.columns.filter((c): c is string => typeof c === "string")
    : rows[0]
      ? Object.keys(rows[0])
      : []
  if (columns.length === 0) {
    return <div className="p-3 text-xs text-chrome-text/50">No rows.</div>
  }
  return (
    <div className={cn("overflow-auto", fill ? "h-full" : "max-h-80")}>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-chrome-bg">
          <tr>
            {columns.map((col) => (
              <th key={col} className="border-b border-chrome-border px-2 py-1 text-left font-medium text-chrome-text/70">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-foreground/[0.02]">
              {columns.map((col) => (
                <td key={col} className="border-b border-chrome-border/35 px-2 py-1 text-chrome-text">
                  {formatCellValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
