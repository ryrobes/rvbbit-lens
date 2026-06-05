/**
 * Shared, pure formatting helpers for the Finder window and its hover tooltip.
 * Kept dependency-light (no React state) so both modules can import them without
 * a circular reference.
 */
import { Eye, Layers, Sparkles, Table2 } from "@/lib/icons"
import type { SchemaTable } from "@/lib/db/types"

export function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

export function fmtBytes(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"]
  let v = b
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** The list/tooltip icon for a table, keyed off the real access method, not a name guess. */
export function iconForTable(t: SchemaTable) {
  if (t.kind === "view") return Eye
  if (t.kind === "matview") return Layers
  if (t.isRvbbit && t.kind === "table") return Sparkles
  return Table2
}
