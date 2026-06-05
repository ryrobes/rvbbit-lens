"use client"

import { Loader2 } from "@/lib/icons"
import type { NodeMeta, TablePreview, ColumnPreview } from "@/lib/desktop/scry-preview"
import type { PreviewEntry } from "./use-scry-preview"

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
function fmtBytes(b: number | null): string {
  if (b == null) return "—"
  const u = ["B", "KB", "MB", "GB", "TB"]
  let v = b
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}
function fmtNum(n: number | null): string {
  return n == null ? "—" : n.toLocaleString()
}
function pct(f: number | null): string {
  return f == null ? "—" : `${Math.round(f * 100)}%`
}
function cell(v: unknown): string {
  if (v == null) return "∅"
  if (typeof v === "object") return trunc(JSON.stringify(v), 40)
  return trunc(String(v), 40)
}

/** The expanded in-node panel: KG metadata strip + a small live preview. */
export function ScryPreviewPanel({ preview }: { preview?: PreviewEntry }) {
  if (!preview || preview.loading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-2 text-[10px] text-chrome-text/50">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    )
  }
  if (preview.error) {
    return <div className="px-2 py-2 text-[10px] leading-snug text-danger/90">{trunc(preview.error, 120)}</div>
  }
  return (
    <div className="max-h-[220px] overflow-y-auto">
      {preview.meta ? <MetaStrip meta={preview.meta} /> : null}
      {preview.preview?.mode === "table" ? <TableView p={preview.preview} /> : null}
      {preview.preview?.mode === "column" ? <ColumnView p={preview.preview} /> : null}
    </div>
  )
}

function MetaStrip({ meta }: { meta: NodeMeta }) {
  const line =
    meta.kind === "db_table"
      ? `${fmtNum(meta.rowCount)} rows · ${fmtNum(meta.nCols)} cols · ${fmtBytes(meta.sizeBytes)}`
      : `${meta.dataType ?? "—"} · ndv ${fmtNum(meta.ndv)} · null ${pct(meta.nullFrac)}` +
        (meta.isPk ? " · PK" : "") +
        (meta.isFk ? ` · FK→${meta.fkTarget ?? "?"}` : "")
  const doc = meta.doc
  return (
    <div className="border-b border-chrome-border/40 px-2 py-1.5">
      <div className="font-mono text-[10px] tabular-nums text-chrome-text/80">{line}</div>
      {doc ? <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-chrome-text/50">{trunc(doc, 160)}</div> : null}
    </div>
  )
}

function TableView({ p }: { p: TablePreview }) {
  if (p.rows.length === 0) return <div className="px-2 py-2 text-[10px] text-chrome-text/40">no rows</div>
  return (
    <table className="w-full border-collapse text-[10px]">
      <thead>
        <tr style={{ background: "color-mix(in oklch, var(--terminal) 10%, transparent)" }}>
          {p.columns.map((c) => (
            <th key={c.name} className="truncate px-1.5 py-1 text-left font-normal text-chrome-text/70" title={c.name}>
              {trunc(c.name, 14)}
            </th>
          ))}
          {p.hiddenCols > 0 ? <th className="px-1 py-1 text-right font-normal text-terminal/60">+{p.hiddenCols}</th> : null}
        </tr>
      </thead>
      {/* rows are inert — only the panel's own scroll is interactive */}
      <tbody className="pointer-events-none">
        {p.rows.map((row, i) => (
          <tr key={i} className="border-t border-chrome-border/25">
            {p.columns.map((c) => (
              <td key={c.name} className="max-w-[70px] truncate px-1.5 py-0.5 text-foreground/85" title={cell(row[c.name])}>
                {cell(row[c.name])}
              </td>
            ))}
            {p.hiddenCols > 0 ? <td /> : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ColumnView({ p }: { p: ColumnPreview }) {
  if (p.values.length === 0) return <div className="px-2 py-2 text-[10px] text-chrome-text/40">no values</div>
  const max = Math.max(1, ...p.values.map((v) => v.n))
  return (
    <div className="px-2 py-1.5">
      {p.values.map((v, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="w-[55%] truncate font-mono text-[10px] text-foreground/85" title={cell(v.value)}>
            {cell(v.value)}
          </span>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]">
            <span
              className="block h-full rounded-full bg-terminal"
              style={{ width: `${Math.max(4, Math.round((v.n / max) * 100))}%` }}
            />
          </span>
          <span className="w-10 text-right text-[9px] tabular-nums text-chrome-text/55">{fmtNum(v.n)}</span>
        </div>
      ))}
    </div>
  )
}
