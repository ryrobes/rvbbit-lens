"use client"

/**
 * Time-travel helpers for the SQL editor.
 *
 * rvbbit-backed tables expose a snapshot history via
 * `rvbbit.time_travel_timeline(<regclass>)`, and queries can be pinned to a
 * snapshot by prepending a single comment:
 *
 *     -- rvbbit: as_of = '2026-05-28 02:25:00+00'
 *     SELECT count(*) FROM orders;
 *
 * The block-comment form (`/* rvbbit: as_of = '…' *​/`) is also accepted.
 * This module provides:
 *   • `detectRvbbitTables` — uses `rvbbit.route_explain` to find which
 *     rvbbit tables a query touches (no execution).
 *   • `fetchTimeline` — pulls the per-generation timeline rows for one table.
 *   • `parseAsOfComment` / `withAsOf` — read & rewrite the leading comment
 *     so the editor's text stays the source of truth (copy/paste safe).
 */

import { routeExplain } from "./routing"
import { colorForVizSeriesIndex, VIZ_SERIES_COLORS } from "@/lib/desktop/viz-colors"

// ── Types ───────────────────────────────────────────────────────────

export interface TimelineTick {
  generation: number
  /** ISO timestamp. */
  committedAt: string
  rowsWritten: number
  rowGroupsWritten: number
  visibleRowsEstimate: number
  tombstonesVisible: number
}

export interface RvbbitTableRef {
  schema: string
  name: string
}

/**
 * One table's timeline, paired with the color it gets in the scrubber so the
 * caller and the renderer agree without round-tripping through React state.
 */
export interface TimelineSeries {
  table: RvbbitTableRef
  color: string
  ticks: TimelineTick[]
}

/**
 * Color palette for per-table tick lanes. Picked from the existing chart
 * tokens so the scrubber sits comfortably alongside Vega-Lite charts that
 * use the same scale. Tables beyond the palette length wrap to the start.
 */
export const SERIES_PALETTE: string[] = [
  VIZ_SERIES_COLORS[0],
  VIZ_SERIES_COLORS[2],
  VIZ_SERIES_COLORS[3],
  VIZ_SERIES_COLORS[6],
  VIZ_SERIES_COLORS[1],
  VIZ_SERIES_COLORS[4],
]

export function colorForSeriesIndex(i: number): string {
  return colorForVizSeriesIndex(i)
}

export function seriesKey(table: RvbbitTableRef): string {
  return `${table.schema}.${table.name}`
}

// ── Detection ───────────────────────────────────────────────────────

/**
 * List the rvbbit tables referenced by `sql`. Uses `route_explain`, which is
 * plan-only — no side effects, no data scan. Empty when the query doesn't
 * touch any rvbbit-backed storage.
 */
export async function detectRvbbitTables(
  connectionId: string,
  sql: string,
): Promise<RvbbitTableRef[]> {
  if (!sql.trim()) return []
  const res = await routeExplain(connectionId, sql)
  if (!res.explain) return []
  return res.explain.tables.map((t) => ({ schema: t.schema, name: t.table }))
}

// ── Timeline ────────────────────────────────────────────────────────

interface QueryOk {
  ok: true
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 1000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Fetch the per-generation timeline for one rvbbit table. Returns rows
 * sorted by generation DESCending — newest first — to match the visual
 * convention of "top = now" in the scrubber.
 */
export async function fetchTimeline(
  connectionId: string,
  table: RvbbitTableRef,
): Promise<{ ticks: TimelineTick[]; error?: string }> {
  const reg = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
  const sql =
    "SELECT generation, committed_at, rows_written, row_groups_written, " +
    "visible_rows_estimate, tombstones_visible " +
    `FROM rvbbit.time_travel_timeline(${sqlStr(reg)}::regclass) ` +
    "ORDER BY generation DESC LIMIT 1000"
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { ticks: [], error: res.error }
  return {
    ticks: res.rows.map((r) => ({
      generation: Number(r.generation ?? 0),
      committedAt: String(r.committed_at ?? ""),
      rowsWritten: Number(r.rows_written ?? 0),
      rowGroupsWritten: Number(r.row_groups_written ?? 0),
      visibleRowsEstimate: Number(r.visible_rows_estimate ?? 0),
      tombstonesVisible: Number(r.tombstones_visible ?? 0),
    })),
  }
}

// ── SQL comment parse / rewrite ─────────────────────────────────────

/**
 * Recognized leading rvbbit comments. Each match consumes the full comment
 * line including its trailing newline so `body` is the clean rest of the SQL.
 *
 * `s` flag is intentionally omitted — `.` here only sits inside character
 * classes, the patterns are line-oriented.
 */
const LINE_COMMENT =
  /^[ \t]*--[ \t]*rvbbit:[ \t]*as_of[ \t]*=[ \t]*'([^']+)'[ \t]*\r?\n?/
const BLOCK_COMMENT =
  /^[ \t]*\/\*[ \t]*rvbbit:[ \t]*as_of[ \t]*=[ \t]*'([^']+)'[ \t]*\*\/[ \t]*\r?\n?/

export interface ParsedAsOf {
  /** ISO timestamp from the comment, or null if there's no rvbbit comment. */
  asOf: string | null
  /** The SQL with the rvbbit comment stripped. */
  body: string
}

export function parseAsOfComment(sql: string): ParsedAsOf {
  const m = sql.match(LINE_COMMENT) ?? sql.match(BLOCK_COMMENT)
  if (m) return { asOf: m[1], body: sql.slice(m[0].length) }
  return { asOf: null, body: sql }
}

/**
 * Rewrite `sql` to carry the given `asOf` as a leading line comment. If
 * `asOf` is null, any existing rvbbit comment is stripped — putting the
 * editor back into "live" mode.
 */
// Only ISO-timestamp characters — no single quote (would break the '…' literal)
// and no newline (would escape the leading comment into live SQL).
const SAFE_AS_OF = /^[0-9T :.+\-Z]+$/
export function withAsOf(sql: string, asOf: string | null): string {
  const { body } = parseAsOfComment(sql)
  // An unsafe/malformed asOf falls back to live mode rather than being embedded
  // verbatim (a `'` or newline would corrupt the comment or inject SQL).
  if (!asOf || !SAFE_AS_OF.test(asOf)) return body
  return `-- rvbbit: as_of = '${asOf}'\n${body}`
}

// ── Display helpers ────────────────────────────────────────────────

/** Compact "May 28, 02:25" style timestamp for the scrubber UI. */
export function fmtScrubberTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" })
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  return `${date} · ${time}`
}

/** "5m ago" / "3d ago" — concise relative time for tick tooltips. */
export function fmtAgoShort(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s ago`
  const m = Math.round(secs / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * Convert an ISO timestamp to the value accepted by `<input type="datetime-local">`
 * (the spec wants `YYYY-MM-DDTHH:mm`, no timezone, in local time).
 */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** Inverse of isoToLocalInput — convert datetime-local back to ISO (UTC). */
export function localInputToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local) // browser parses as local time
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
