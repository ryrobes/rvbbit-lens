"use client"

// Shared building blocks for the Metrics apps (Creator / Inspector / Catalog):
// the form-field kit (matching operator-inspector styling), the key-value
// ParamRowsEditor with a raw-JSON escape hatch, the def-time VersionPicker, and
// a small status/empty note. Kept here so the three windows stay consistent.

import { useMemo, useState } from "react"
import { format as formatSql } from "sql-formatter"
import { AlertTriangle, Loader2, Plus, Trash2 } from "@/lib/icons"
import {
  paramsToRows,
  rowsToParams,
  type MetricVersion,
  type ParamRow,
} from "@/lib/rvbbit/metrics"

export const inputCls =
  "h-7 w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"
export const areaCls =
  "w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1 font-mono text-[11px] leading-snug text-foreground outline-none transition-colors placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-baseline gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">{label}</span>
        {hint ? <span className="text-[10px] text-chrome-text/35">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="truncate text-[10px] uppercase tracking-wider" style={{ color: "var(--syntax-keyword)" }}>
          {title}
        </span>
        <div className="flex-1" />
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/** Loading / error / empty inline note. */
export function StatusNote({
  state,
  message,
  className,
}: {
  state: "loading" | "error" | "empty"
  message?: string
  className?: string
}) {
  return (
    <div className={`flex items-center gap-2 px-3 py-6 text-[11px] ${className ?? ""}`}>
      {state === "loading" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-chrome-text/50" />
      ) : state === "error" ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
      ) : null}
      <span className={state === "error" ? "whitespace-pre-wrap break-words text-danger" : "text-chrome-text/50"}>
        {message ?? (state === "loading" ? "Loading…" : state === "empty" ? "Nothing here yet." : "")}
      </span>
    </div>
  )
}

/**
 * Key-value editor for a metric's default params (the {param} tokens). Edits a
 * Record<string, unknown> via string-valued rows; a "raw JSON" toggle drops to a
 * jsonb textarea for nested values. The parent owns the params object.
 */
export function ParamRowsEditor({
  params,
  onChange,
}: {
  params: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const rows = useMemo(() => paramsToRows(params), [params])
  const [raw, setRaw] = useState(false)
  const [rawText, setRawText] = useState("")
  const [rawError, setRawError] = useState<string | null>(null)

  function commitRows(next: ParamRow[]) {
    onChange(rowsToParams(next))
  }

  function enterRaw() {
    setRawText(JSON.stringify(params ?? {}, null, 2))
    setRawError(null)
    setRaw(true)
  }
  function commitRaw(text: string) {
    setRawText(text)
    if (text.trim() === "") {
      setRawError(null)
      onChange({})
      return
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawError("Expected a JSON object")
        return
      }
      setRawError(null)
      onChange(parsed as Record<string, unknown>)
    } catch (e) {
      setRawError(e instanceof Error ? e.message : "Invalid JSON")
    }
  }

  if (raw) {
    return (
      <div className="space-y-1">
        <textarea
          className={`${areaCls} h-28`}
          spellCheck={false}
          value={rawText}
          onChange={(e) => commitRaw(e.target.value)}
          placeholder='{ "min": 50, "region": "US" }'
        />
        {rawError ? <div className="text-[10px] text-danger">{rawError}</div> : null}
        <button
          type="button"
          onClick={() => setRaw(false)}
          className="inline-flex items-center gap-1 text-[10px] text-chrome-text/55 hover:text-foreground"
        >
          ⤺ key–value editor
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {rows.length === 0 ? <div className="text-[10px] text-chrome-text/35">No default params.</div> : null}
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            className={`${inputCls} flex-[0_0_38%]`}
            placeholder="name"
            value={row.key}
            onChange={(e) => {
              const next = rows.slice()
              next[i] = { ...row, key: e.target.value }
              commitRows(next)
            }}
          />
          <input
            className={inputCls}
            placeholder="default value"
            value={row.value}
            onChange={(e) => {
              const next = rows.slice()
              next[i] = { ...row, value: e.target.value }
              commitRows(next)
            }}
          />
          <button
            type="button"
            title="Remove"
            onClick={() => {
              const next = rows.slice()
              next.splice(i, 1)
              commitRows(next)
            }}
            className="rounded px-1 text-danger hover:bg-danger/10"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-0.5">
        <button
          type="button"
          onClick={() => commitRows([...rows, { key: "", value: "" }])}
          className="inline-flex items-center gap-1 text-[10px] text-chrome-text/60 hover:text-foreground"
        >
          <Plus className="h-2.5 w-2.5" /> add param
        </button>
        <button
          type="button"
          onClick={enterRaw}
          className="inline-flex items-center gap-1 text-[10px] text-chrome-text/45 hover:text-foreground"
        >
          ⤷ raw JSON
        </button>
      </div>
    </div>
  )
}

/** Pretty-print composed metric SQL (which comes back as one long line) so the
 *  read-only preview reads top-to-bottom instead of growing the window wide.
 *  Falls back to the raw string if the formatter chokes on it. */
export function formatSqlSafe(sql: string | null | undefined): string {
  const raw = (sql ?? "").trim()
  if (!raw) return ""
  try {
    return formatSql(raw, { language: "postgresql", keywordCase: "upper" })
  } catch {
    return raw
  }
}

/** Pretty-print a metric TEMPLATE body — which still contains {param}, {param!}
 *  and {metric:NAME} tokens. The default parser throws on those, so treat the
 *  tokens as opaque placeholders (paramTypes.custom) to keep them intact. Used
 *  when LOADING a saved metric into the editor, not on every keystroke. */
export function formatMetricBody(sql: string | null | undefined): string {
  const raw = (sql ?? "").trim()
  if (!raw) return ""
  try {
    return formatSql(raw, {
      language: "postgresql",
      keywordCase: "upper",
      paramTypes: { custom: [{ regex: "\\{[A-Za-z0-9_:!]+\\}" }] },
    })
  } catch {
    return raw
  }
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * DEF-TIME version picker: a discrete list of a metric's definition versions
 * (newest first) plus a "Latest" entry. Selecting a version yields its
 * created_at, which the parent passes as def_as_of; "Latest" yields null (now()).
 */
export function VersionPicker({
  versions,
  selectedVersion,
  onSelect,
}: {
  versions: MetricVersion[]
  /** null = Latest. */
  selectedVersion: number | null
  onSelect: (version: MetricVersion | null) => void
}) {
  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`flex w-full items-center justify-between rounded-[3px] px-2 py-1 text-left text-[11px] ${
          selectedVersion == null ? "bg-main/15 text-main" : "text-chrome-text/70 hover:bg-foreground/[0.05]"
        }`}
      >
        <span className="font-medium">Latest</span>
        <span className="text-[10px] opacity-60">now()</span>
      </button>
      {versions.map((v) => (
        <button
          key={v.version}
          type="button"
          onClick={() => onSelect(v)}
          className={`flex w-full items-center justify-between rounded-[3px] px-2 py-1 text-left text-[11px] ${
            selectedVersion === v.version ? "bg-main/15 text-main" : "text-chrome-text/70 hover:bg-foreground/[0.05]"
          }`}
        >
          <span className="font-mono">v{v.version}</span>
          <span className="text-[10px] opacity-60">{fmtTime(v.createdAt)}</span>
        </button>
      ))}
    </div>
  )
}
