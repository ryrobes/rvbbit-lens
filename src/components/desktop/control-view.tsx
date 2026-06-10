"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, Search, X } from "@/lib/icons"
import type { QueryResult, QueryResultColumn } from "@/lib/db/types"
import type { DesktopParamValue } from "@/lib/desktop/types"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { classifyColumn } from "@/lib/desktop/chart-infer"
import { formatCellValue } from "@/lib/sql/format"
import { cn } from "@/lib/utils"

const MAX_OPTIONS = 500

export type ControlKind = "dropdown" | "multiselect" | "datepicker" | "slider"

/** Stable key that separates a real NULL from the literal text "null". */
const keyOf = (v: unknown): string => (v == null ? " null" : String(v))

/** Compare two cell values numerically when both look numeric, else lexically
 *  (ISO date/timestamp strings sort correctly as text). */
function cmp(a: unknown, b: unknown): number {
  const sa = String(a), sb = String(b)
  // Numeric only when both look numeric (start with a digit/sign) — so ISO
  // date/timestamp strings (which Number()s to NaN) fall to lexical order, and
  // whitespace-only cells don't coerce to 0.
  if (/^\s*-?\d/.test(sa) && /^\s*-?\d/.test(sb)) {
    const na = Number(a), nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

interface ControlViewProps {
  result: QueryResult
  field: string | null
  /** Widget kind — list (dropdown/multiselect) or range (datepicker/slider). */
  kind: ControlKind
  activeParams: DesktopParamValue[]
  onChangeField: (field: string) => void
  /** Emit a pick param. `operator` "in" = discrete set (action set/toggle/remove);
   *  "gte"/"lte" = a scalar threshold (a null value clears it). */
  onEmit: (
    field: string,
    value: unknown,
    dataTypeId: number,
    spec: { operator: "in" | "gte" | "lte"; action?: "set" | "toggle" | "remove" },
  ) => void
  /** Optional probe for the true min/max of the column over the FULL relation
   *  (datepicker/slider bounds); falls back to the loaded result otherwise. */
  onProbeBounds?: (field: string) => Promise<{ min: unknown; max: unknown } | null>
}

/**
 * Renders a SQL block's result as an interactive selector that publishes a
 * "pick" param: a dropdown/multiselect of the column's distinct values, or a
 * datepicker/slider bounded by the column's min/max. The pick is `cascade:false`
 * so it never self-filters this block — drag the shelf chip onto a target.
 */
export function ControlView({ result, field, kind, activeParams, onChangeField, onEmit, onProbeBounds }: ControlViewProps) {
  const multi = kind === "multiselect"
  const isRange = kind === "datepicker" || kind === "slider"
  // Present mode: the control itself IS the content (the viewer picks values) —
  // only its *binding* affordance (which column it targets) is editor chrome.
  const present = usePresentMode()

  const col = useMemo<QueryResultColumn | undefined>(
    () =>
      result.columns.find((c) => c.name === field) ??
      result.columns.find((c) => {
        const role = classifyColumn(c)
        if (kind === "datepicker") return role === "temporal"
        if (kind === "slider") return role === "numeric"
        return role === "categorical"
      }) ??
      result.columns[0],
    [result.columns, field, kind],
  )

  // Raw selected values (this block's pick param for the column) + a keyed set.
  const selectedValues = useMemo<unknown[]>(() => {
    if (!col) return []
    const p = activeParams.find((x) => x.field === col.name && x.cascade === false)
    return p ? (Array.isArray(p.value) ? p.value : [p.value]) : []
  }, [activeParams, col])
  const selected = useMemo(() => new Set(selectedValues.map(keyOf)), [selectedValues])

  // ── list (dropdown / multiselect) options ────────────────────────────────
  const options = useMemo(() => {
    if (!col || isRange) return [] as unknown[]
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const row of result.rows) {
      const v = row?.[col.name]
      const k = keyOf(v)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(v)
      if (out.length >= MAX_OPTIONS) break
    }
    out.sort((a, b) => (a == null ? 1 : b == null ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })))
    return out
  }, [result.rows, col, isRange])

  const [filter, setFilter] = useState("")
  // Threshold comparison for range controls (≥ / ≤); the saved param's operator
  // wins over this local default when present.
  const [localRangeOp, setLocalRangeOp] = useState<"gte" | "lte">("gte")
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return options
    return options.filter((v) => String(v == null ? "" : formatCellValue(v)).toLowerCase().includes(f))
  }, [options, filter])

  // ── range (datepicker / slider) bounds: loaded result, refined by a probe ──
  const rowsBounds = useMemo<{ min: unknown; max: unknown } | null>(() => {
    if (!col || !isRange) return null
    let lo: unknown, hi: unknown, any = false
    for (const row of result.rows) {
      const v = row?.[col.name]
      if (v == null) continue
      if (!any) { lo = v; hi = v; any = true; continue }
      if (cmp(v, lo) < 0) lo = v
      if (cmp(v, hi) > 0) hi = v
    }
    return any ? { min: lo, max: hi } : null
  }, [result.rows, col, isRange])

  // Keyed by field so a stale probe for a previously-selected column is ignored
  // (avoids a synchronous reset-setState in the effect).
  const [probed, setProbed] = useState<{ field: string; min: unknown; max: unknown } | null>(null)
  useEffect(() => {
    if (!col || !isRange || !onProbeBounds) return
    let cancelled = false
    void onProbeBounds(col.name).then((b) => { if (!cancelled && b) setProbed({ field: col.name, ...b }) })
    return () => { cancelled = true }
    // Re-probe only when the column/result changes, not on every desktop edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col, isRange])
  const bounds = probed && col && probed.field === col.name ? probed : rowsBounds

  if (!col) {
    return <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">No columns to bind.</div>
  }

  const status = isRange
    ? selectedValues[0] != null ? String(formatCellValue(selectedValues[0])) : "—"
    : selected.size > 0 ? `${selected.size} selected` : multi ? "multi" : "single"

  // Effective threshold op = the saved param's op (so a reload reflects it),
  // else the local toggle default.
  const savedOp = activeParams.find((x) => x.field === col.name && x.cascade === false)?.operator
  const rangeOp: "gte" | "lte" = savedOp === "lte" || savedOp === "gte" ? savedOp : localRangeOp

  const pickList = (value: unknown) => {
    if (multi) onEmit(col.name, value, col.dataTypeId, { operator: "in", action: "toggle" })
    else onEmit(col.name, value, col.dataTypeId, { operator: "in", action: selected.has(keyOf(value)) ? "remove" : "set" })
  }
  const changeRangeOp = (op: "gte" | "lte") => {
    setLocalRangeOp(op)
    if (selectedValues[0] != null) onEmit(col.name, selectedValues[0], col.dataTypeId, { operator: op })
  }

  // Single-select dropdown: a real <select>. "" = the "(any)" clear option.
  const selectedKey = selectedValues.length > 0 ? keyOf(selectedValues[0]) : ""
  const onDropdownChange = (key: string) => {
    if (key === "") {
      if (selectedValues.length > 0) onEmit(col.name, selectedValues[0], col.dataTypeId, { operator: "in", action: "remove" })
      return
    }
    const i = options.findIndex((o) => keyOf(o) === key)
    if (i >= 0) onEmit(col.name, options[i], col.dataTypeId, { operator: "in", action: "set" })
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg">
      {present ? null : (
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1.5">
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55">field</span>
        <select
          value={col.name}
          onChange={(e) => onChangeField(e.target.value)}
          className="min-w-0 flex-1 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          {result.columns.map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="max-w-[42%] shrink-0 truncate text-[10px] text-chrome-text/45">{status}</span>
      </div>
      )}

      {isRange ? (
        <RangeBody
          kind={kind}
          bounds={bounds}
          current={selectedValues[0]}
          op={rangeOp}
          onChangeOp={changeRangeOp}
          onSet={(v) => onEmit(col.name, v, col.dataTypeId, { operator: rangeOp })}
          onClear={() => onEmit(col.name, null, col.dataTypeId, { operator: rangeOp })}
        />
      ) : !multi ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1 p-3">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">value</span>
          <select
            value={selectedKey}
            onChange={(e) => onDropdownChange(e.target.value)}
            className="rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">(any)</option>
            {options.map((v) => (
              <option key={keyOf(v)} value={keyOf(v)}>
                {v == null ? "∅ null" : String(formatCellValue(v))}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          {options.length > 8 ? (
            <div className="relative shrink-0 border-b border-chrome-border px-2 py-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter values…"
                spellCheck={false}
                className="w-full rounded border border-chrome-border bg-secondary-background py-0.5 pl-6 pr-2 text-[11px] text-foreground outline-none placeholder:text-chrome-text/35 focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {shown.map((v, i) => {
              const isSel = selected.has(keyOf(v))
              return (
                <button
                  key={`${String(v)}-${i}`}
                  type="button"
                  onClick={() => pickList(v)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] text-foreground transition-colors",
                    isSel ? "bg-main/15 ring-1 ring-inset ring-main/45" : "hover:bg-main/10",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-sm border",
                      isSel ? "border-main bg-main/30" : "border-chrome-border",
                    )}
                  >
                    {isSel ? <Check className="h-2.5 w-2.5 text-main" /> : null}
                  </span>
                  <span className={cn("truncate", v == null && "italic text-chrome-text/45")}>
                    {v == null ? "∅ null" : formatCellValue(v)}
                  </span>
                </button>
              )
            })}
            {shown.length === 0 ? (
              <div className="grid h-full place-items-center text-[11px] text-chrome-text/50">No matching values.</div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

// ── range widgets ────────────────────────────────────────────────────────────

function RangeBody({
  kind,
  bounds,
  current,
  op,
  onChangeOp,
  onSet,
  onClear,
}: {
  kind: ControlKind
  bounds: { min: unknown; max: unknown } | null
  current: unknown
  op: "gte" | "lte"
  onChangeOp: (op: "gte" | "lte") => void
  onSet: (v: unknown) => void
  onClear: () => void
}) {
  // Present mode: the threshold direction (≥/≤) is fixed to what was saved —
  // render it as a static label rather than an interactive toggle.
  const present = usePresentMode()
  if (!bounds) {
    return <div className="grid flex-1 place-items-center px-3 text-center text-[11px] text-chrome-text/55">No range available for this column.</div>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-[9px] uppercase tracking-wider text-chrome-text/55">match</span>
        {present ? (
          <span className="rounded px-1.5 py-0.5 text-[10px] text-foreground">
            {op === "gte" ? "≥ at least" : "≤ at most"}
          </span>
        ) : (
          (["gte", "lte"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onChangeOp(id)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                op === id ? "bg-main/20 text-foreground" : "text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
              )}
            >
              {id === "gte" ? "≥ at least" : "≤ at most"}
            </button>
          ))
        )}
      </div>
      {kind === "datepicker" ? (
        <DateInput min={bounds.min} max={bounds.max} current={current} onSet={onSet} />
      ) : (
        <Slider key={String(current ?? "")} min={bounds.min} max={bounds.max} current={current} onSet={onSet} />
      )}
      <div className="flex items-center justify-between">
        <span className="truncate text-[10px] text-chrome-text/45">
          {String(formatCellValue(bounds.min))} – {String(formatCellValue(bounds.max))}
        </span>
        {current != null ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="h-3 w-3" /> clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function toDateInput(v: unknown): string {
  const s = String(v ?? "")
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ""
}

function DateInput({ min, max, current, onSet }: { min: unknown; max: unknown; current: unknown; onSet: (v: unknown) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">date</span>
      <input
        type="date"
        min={toDateInput(min)}
        max={toDateInput(max)}
        value={toDateInput(current)}
        onChange={(e) => { if (e.target.value) onSet(e.target.value) }}
        className="rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  )
}

function Slider({ min, max, current, onSet }: { min: unknown; max: unknown; current: unknown; onSet: (v: unknown) => void }) {
  const lo = Number(min)
  const hi = Number(max)
  const intish = Number.isInteger(lo) && Number.isInteger(hi)
  const span = hi - lo
  const step = span <= 0 ? 1 : intish ? Math.max(1, Math.round(span / 100)) : span / 100
  const start = current == null || Number.isNaN(Number(current)) ? lo : Number(current)
  // Local while dragging; remounted (via key on `current`) when the bound value
  // changes externally, so no syncing effect is needed.
  const [drag, setDrag] = useState(start)

  if (Number.isNaN(lo) || Number.isNaN(hi)) {
    return <div className="grid flex-1 place-items-center text-[11px] text-chrome-text/55">Pick a numeric column for a slider.</div>
  }
  // Round to integers, or to 6 significant figures for fractional columns, so
  // the readout + the published literal don't carry IEEE float noise.
  const clean = (n: number) => (intish ? Math.round(n) : Number(n.toPrecision(6)))
  const commit = () => onSet(clean(drag))
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">value</span>
        <span className="font-mono text-[12px] tabular-nums text-foreground">{clean(drag)}</span>
      </div>
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={drag}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="w-full accent-main"
      />
    </label>
  )
}
