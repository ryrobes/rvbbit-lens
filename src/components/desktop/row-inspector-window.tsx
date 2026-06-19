"use client"

import { useMemo, useState } from "react"
import { Check, ClipboardCopy, Table2 } from "@/lib/icons"
import type { QueryResultColumn } from "@/lib/db/types"
import type { RowInspectorPayload } from "@/lib/desktop/types"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"
import { SqlEditor } from "./sql-editor"

interface RowInspectorWindowProps {
  payload: RowInspectorPayload
}

export function RowInspectorWindow({ payload }: RowInspectorWindowProps) {
  const validInitial = payload.selectedColumn
    ? payload.columns.some((c) => c.name === payload.selectedColumn)
    : false
  const [selectedColumn, setSelectedColumn] = useState<string | null>(validInitial ? payload.selectedColumn! : null)
  const [copied, setCopied] = useState<"cell" | "row" | null>(null)

  const selected = selectedColumn ? payload.columns.find((c) => c.name === selectedColumn) ?? null : null
  const selectedValue = selected ? payload.row[selected.name] : payload.row
  const doc = useMemo(
    () => documentForValue(selectedValue, selected),
    [selected, selectedValue],
  )
  const rowJson = useMemo(() => stringifyJson(payload.row), [payload.row])

  async function copy(text: string, what: "cell" | "row") {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied((prev) => (prev === what ? null : prev)), 1200)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg text-foreground group-data-[focused=false]/window:bg-doc-bg/70">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/35 px-2 group-data-[focused=false]/window:bg-chrome-bg/20">
        <div className="grid h-6 w-6 place-items-center rounded border border-chrome-border/60 bg-foreground/[0.04]">
          <Table2 className="h-3.5 w-3.5 text-rvbbit-accent" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold leading-tight text-foreground">{payload.sourceTitle}</div>
          <div className="truncate font-mono text-[9px] text-chrome-text/55">
            row {payload.rowIndex + 1} · {payload.columns.length} fields
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton
            copied={copied === "row"}
            label="Copy row"
            onClick={() => void copy(rowJson, "row")}
          />
          <CopyButton
            copied={copied === "cell"}
            label={selected ? "Copy field" : "Copy view"}
            onClick={() => void copy(doc.text, "cell")}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-chrome-border/55 bg-foreground/[0.012]">
          <button
            type="button"
            onClick={() => setSelectedColumn(null)}
            className={cn(
              "border-b border-chrome-border/30 px-3 py-2 text-left transition-colors",
              selectedColumn == null ? "bg-main/12" : "hover:bg-foreground/[0.04]",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-rvbbit-accent" />
              <span className="font-mono text-[11px] text-foreground">full row</span>
              <span className="ml-auto text-[9px] uppercase tracking-wider text-chrome-text/45">json</span>
            </div>
            <div className="mt-1 truncate text-[10px] text-chrome-text/55">{payload.columns.length} fields</div>
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {payload.columns.map((column) => {
              const value = payload.row[column.name]
              const kind = valueKind(column, value)
              return (
                <button
                  key={column.name}
                  type="button"
                  onClick={() => setSelectedColumn(column.name)}
                  className={cn(
                    "w-full border-b border-chrome-border/25 px-3 py-2 text-left transition-colors",
                    selectedColumn === column.name ? "bg-main/12" : "hover:bg-foreground/[0.04]",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        kind === "json" ? "bg-rvbbit-accent" : kind === "null" ? "bg-chrome-text/30" : "bg-main/70",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">{column.name}</span>
                    <span className="shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/45">{kind}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="truncate text-[10px] text-chrome-text/55">{previewValue(value)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[9px] text-chrome-text/35">
                    {column.dataTypeName ?? `oid:${column.dataTypeId}`}
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-chrome-border/40 px-2">
            <span className="truncate font-mono text-[11px] text-foreground/85">
              {selected ? selected.name : "full row"}
            </span>
            {selected ? (
              <span className="shrink-0 text-[10px] text-chrome-text/45">
                {selected.dataTypeName ?? `oid:${selected.dataTypeId}`}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 rounded border border-chrome-border/45 bg-foreground/[0.03] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
              {doc.language}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <SqlEditor
              value={doc.text}
              onChange={() => undefined}
              readOnly
              autoFocus={false}
              language={doc.language}
              wrap={doc.language === "plain"}
              fontSize={12}
              height="100%"
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function CopyButton({
  copied,
  label,
  onClick,
}: {
  copied: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded border border-chrome-border/55 bg-foreground/[0.03] px-2 text-[10px] text-chrome-text transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
      title={label}
    >
      {copied ? <Check className="h-3 w-3 text-rvbbit-accent" /> : <ClipboardCopy className="h-3 w-3" />}
      <span>{copied ? "copied" : label}</span>
    </button>
  )
}

function documentForValue(value: unknown, column: QueryResultColumn | null): { text: string; language: "json" | "plain" } {
  const json = jsonText(value, column)
  if (json != null) return { text: json, language: "json" }
  if (value == null) return { text: "null", language: "plain" }
  return { text: typeof value === "string" ? value : formatCellValue(value), language: "plain" }
}

function jsonText(value: unknown, column: QueryResultColumn | null): string | null {
  if (value == null) return column == null ? "null" : null
  if (typeof value === "object") return stringifyJson(value)
  if (typeof value === "string" && (isJsonColumn(column) || looksLikeJson(value))) {
    try {
      return stringifyJson(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return null
}

function valueKind(column: QueryResultColumn, value: unknown): "json" | "null" | "text" | "number" | "bool" {
  if (value == null) return "null"
  if (isJsonColumn(column) || typeof value === "object" || (typeof value === "string" && looksLikeJson(value))) return "json"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "number" || typeof value === "bigint") return "number"
  return "text"
}

function isJsonColumn(column: QueryResultColumn | null): boolean {
  const type = column?.dataTypeName?.toLowerCase() ?? ""
  return type === "json" || type === "jsonb" || type.endsWith(" json") || type.endsWith(" jsonb")
}

function looksLikeJson(value: string): boolean {
  const s = value.trim()
  return s.length > 1 && ((s[0] === "{" && s.endsWith("}")) || (s[0] === "[" && s.endsWith("]")))
}

function previewValue(value: unknown): string {
  if (value == null) return "null"
  const raw = typeof value === "string" ? value : formatCellValue(value)
  return raw.replace(/\s+/g, " ").slice(0, 140)
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)
  } catch {
    return String(value)
  }
}
