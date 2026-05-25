"use client"

import { useMemo } from "react"
import { Check, Hash, Quote, X as XIcon } from "@/lib/icons"
import type { QueryResultColumn } from "@/lib/db/types"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"

interface SingleCellCalloutProps {
  column: QueryResultColumn
  value: unknown
}

/**
 * Render a 1-row × 1-column result as a hero callout instead of a 1x1
 * data grid. Aggregations like `SELECT count(*) FROM …` or
 * `SELECT max(date) FROM …` are usually the whole point of the
 * query — the grid frame steals attention from the value, and we
 * want the value to be the value.
 */
export function SingleCellCallout({ column, value }: SingleCellCalloutProps) {
  const kind = useMemo(() => classify(column, value), [column, value])

  if (kind === "null") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-chrome-text/70">
          {column.name}
        </span>
        <span className="text-5xl text-chrome-text/40 italic">∅ null</span>
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/40">
          {column.dataTypeName ?? `oid:${column.dataTypeId}`}
        </span>
      </div>
    )
  }

  if (kind === "boolean") {
    const b = value as boolean
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-chrome-text/70">
          {column.name}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-full border-2 px-6 py-2 text-3xl font-semibold",
            b
              ? "border-success/60 bg-success/15 text-success"
              : "border-danger/60 bg-danger/15 text-danger",
          )}
        >
          {b ? <Check className="h-7 w-7" /> : <XIcon className="h-7 w-7" />}
          {b ? "true" : "false"}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/50">boolean</span>
      </div>
    )
  }

  if (kind === "number") {
    const n = typeof value === "bigint" ? value.toString() : Number(value)
    const display = formatNumber(n)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-chrome-text/70">
          {column.name}
        </span>
        <span className="flex items-baseline gap-3">
          <Hash className="h-5 w-5 self-center text-chrome-text/40" />
          <span className="font-mono text-6xl font-semibold tabular-nums text-foreground">
            {display.main}
          </span>
          {display.suffix ? (
            <span className="text-2xl text-rvbbit-accent">{display.suffix}</span>
          ) : null}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/50">
          {column.dataTypeName ?? `oid:${column.dataTypeId}`}
        </span>
      </div>
    )
  }

  if (kind === "json") {
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-chrome-text/70">
          {column.name} · {column.dataTypeName ?? "json"}
        </span>
        <pre className="flex-1 overflow-auto rounded-base border border-chrome-border/50 bg-doc-bg p-4 font-mono text-sm text-foreground">
          {(() => {
            try {
              return JSON.stringify(value, null, 2)
            } catch {
              return String(value)
            }
          })()}
        </pre>
      </div>
    )
  }

  // string / fallback
  const text = formatCellValue(value)
  const long = text.length > 80
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-chrome-text/70">
        {column.name}
      </span>
      <span className="flex max-w-[80%] items-center gap-3">
        <Quote className="h-5 w-5 shrink-0 text-chrome-text/40" />
        <span
          className={cn(
            "select-text text-foreground",
            long ? "text-left text-sm leading-relaxed" : "text-3xl font-semibold",
          )}
        >
          {text}
        </span>
      </span>
      <span className="text-[10px] uppercase tracking-wider text-chrome-text/50">
        {column.dataTypeName ?? `oid:${column.dataTypeId}`}
      </span>
    </div>
  )
}

type Kind = "null" | "boolean" | "number" | "json" | "string"

function classify(column: QueryResultColumn, value: unknown): Kind {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number" || typeof value === "bigint") return "number"
  if (typeof value === "object") return "json"
  // Postgres numeric types come back as strings from node-pg by default.
  const oid = column.dataTypeId
  if (oid === 20 || oid === 21 || oid === 23 || oid === 700 || oid === 701 || oid === 1700 || oid === 790) {
    const s = String(value).trim()
    if (s !== "" && Number.isFinite(Number(s))) return "number"
  }
  return "string"
}

function formatNumber(value: number | string | bigint): { main: string; suffix: string } {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value
  if (!Number.isFinite(n)) {
    return { main: String(value), suffix: "" }
  }
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return { main: (n / 1_000_000_000).toFixed(2), suffix: "B" }
  if (abs >= 1_000_000) return { main: (n / 1_000_000).toFixed(2), suffix: "M" }
  if (abs >= 10_000) return { main: (n / 1_000).toFixed(1), suffix: "K" }
  if (Number.isInteger(n)) return { main: n.toLocaleString(), suffix: "" }
  return { main: n.toLocaleString(undefined, { maximumFractionDigits: 4 }), suffix: "" }
}
