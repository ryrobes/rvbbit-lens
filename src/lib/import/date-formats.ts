/**
 * Detect and normalize common date / datetime formats to unambiguous ISO,
 * so the importer never relies on Postgres's session DateStyle (which would
 * silently misread `3/4/2025` as MDY even when the data is DMY).
 *
 * Covered: ISO, numeric year-first (`YYYY/M/D`), US `M/D/Y`, EU `D/M/Y`
 * (with `/`, `-`, or `.` separators, 2- or 4-digit years), and month-name
 * forms (`Jan 5, 2024`, `5 January 2024`, `05-Jan-2024`) — each with an
 * optional time (`HH:MM[:SS][.fff]`, AM/PM, and `Z`/`±HH[:MM]` offset).
 * Anything else stays text.
 */

import type { DateColumnFormat, DateLayout } from "./types"

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

interface Time { h: number; mi: number; s: number; frac: string; tz: string | null }

type Raw =
  | { kind: "iso"; y: number; mo: number; d: number; time: Time | null }
  | { kind: "num"; parts: [number, number, number]; lens: [number, number, number]; yearPos: "first" | "last"; sep: string; time: Time | null }
  | { kind: "month"; monthFirst: boolean; month: number; day: number; year: number; yearLen: number; time: Time | null }

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](.+)$/
const NUM = /^(\d{1,4})([/.-])(\d{1,2})([/.-])(\d{1,4})(?:[ T](.+))?$/
const MONTH_MDY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})(?:[ T](.+))?$/
const MONTH_DMY = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?[ -](\d{2,4})(?:[ T](.+))?$/
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s?([ap]m)?\s?(Z|[+-]\d{2}:?\d{2})?$/i

function parseTime(raw: string | undefined): Time | null | "invalid" {
  if (raw == null || raw.trim() === "") return null
  const m = TIME.exec(raw.trim())
  if (!m) return "invalid"
  let h = Number(m[1])
  const mi = Number(m[2])
  const s = m[3] ? Number(m[3]) : 0
  const frac = m[4] ?? ""
  const ampm = m[5]?.toLowerCase()
  if (ampm) {
    if (h < 1 || h > 12) return "invalid"
    if (ampm === "pm" && h !== 12) h += 12
    if (ampm === "am" && h === 12) h = 0
  }
  if (h > 23 || mi > 59 || s > 60) return "invalid"
  let tz: string | null = null
  if (m[6]) tz = m[6].toUpperCase() === "Z" ? "Z" : m[6]
  return { h, mi, s, frac, tz }
}

/** Structural parse — identifies the layout family + raw components, without
 *  resolving MDY vs DMY (that's a column-level decision). */
function rawParse(value: string): Raw | null {
  const v = value.trim()
  if (v === "") return null

  let m = ISO_DATE.exec(v)
  if (m) return { kind: "iso", y: +m[1], mo: +m[2], d: +m[3], time: null }

  m = ISO_TS.exec(v)
  if (m) {
    const time = parseTime(m[4])
    if (time === "invalid") return null
    return { kind: "iso", y: +m[1], mo: +m[2], d: +m[3], time }
  }

  m = NUM.exec(v)
  if (m && m[2] === m[4]) {
    const time = parseTime(m[6])
    if (time === "invalid") return null
    const lens: [number, number, number] = [m[1].length, m[3].length, m[5].length]
    const yearPos: "first" | "last" = lens[0] === 4 ? "first" : "last"
    return { kind: "num", parts: [+m[1], +m[3], +m[5]], lens, yearPos, sep: m[2], time }
  }

  m = MONTH_MDY.exec(v)
  if (m) {
    const month = MONTHS[m[1].toLowerCase()]
    if (month) {
      const time = parseTime(m[4])
      if (time === "invalid") return null
      return { kind: "month", monthFirst: true, month, day: +m[2], year: +m[3], yearLen: m[3].length, time }
    }
  }

  m = MONTH_DMY.exec(v)
  if (m) {
    const month = MONTHS[m[2].toLowerCase()]
    if (month) {
      const time = parseTime(m[4])
      if (time === "invalid") return null
      return { kind: "month", monthFirst: false, month, day: +m[1], year: +m[3], yearLen: m[3].length, time }
    }
  }

  return null
}

/**
 * Decide the date format for a whole column, or null if not all sampled
 * values are dates of one consistent family. Resolves MDY/DMY from the
 * sample (a day > 12 disambiguates); when every day ≤ 12 it falls back to a
 * separator-based default (`.` → DMY, else MDY) and flags `ambiguous`.
 */
export function detectDateColumn(values: string[], nullTokens: Set<string> = new Set([""])): DateColumnFormat | null {
  const parsed: Raw[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (nullTokens.has(v)) continue
    const p = rawParse(v)
    if (!p) return null
    parsed.push(p)
  }
  if (parsed.length === 0) return null

  const kinds = new Set(parsed.map((p) => p.kind))
  if (kinds.size > 1) return null
  const kind = parsed[0].kind
  const hasTime = parsed.some((p) => p.time != null)

  if (kind === "iso") return { layout: "iso", hasTime }

  if (kind === "num") {
    const nums = parsed as Extract<Raw, { kind: "num" }>[]
    const yearPositions = new Set(nums.map((p) => p.yearPos))
    if (yearPositions.size > 1) return null // inconsistent year position
    if (nums[0].yearPos === "first") {
      // Validate it really is Y/M/D (months ≤ 12) so we don't mislabel data.
      if (!nums.every((p) => p.parts[1] >= 1 && p.parts[1] <= 12 && p.parts[2] >= 1 && p.parts[2] <= 31)) return null
      return { layout: "ymd", hasTime }
    }
    // year last → resolve month/day order
    const firstGt12 = nums.some((p) => p.parts[0] > 12)
    const secondGt12 = nums.some((p) => p.parts[1] > 12)
    if (firstGt12 && secondGt12) return null // neither can be a month
    let dayFirst: boolean
    let ambiguous = false
    if (firstGt12) dayFirst = true
    else if (secondGt12) dayFirst = false
    else {
      dayFirst = nums[0].sep === "." // European dotted dates default DMY
      ambiguous = true
    }
    const fmt: DateColumnFormat = { layout: dayFirst ? "dmy" : "mdy", hasTime }
    if (ambiguous) fmt.ambiguous = true
    return fmt
  }

  // month-name
  const months = parsed as Extract<Raw, { kind: "month" }>[]
  const firsts = new Set(months.map((p) => p.monthFirst))
  if (firsts.size > 1) return null
  return { layout: months[0].monthFirst ? "monthname-mdy" : "monthname-dmy", hasTime }
}

function fullYear(y: number, len: number): number {
  if (len === 4 || y >= 100) return y
  return y < 70 ? 2000 + y : 1900 + y // matches Postgres's 2-digit pivot
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0")
}

function buildIso(y: number, mo: number, d: number, time: Time | null, hasTime: boolean): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`
  if (!hasTime) return date
  const t = time ?? { h: 0, mi: 0, s: 0, frac: "", tz: null }
  let s = `${date} ${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}${t.frac}`
  if (t.tz) s += t.tz === "Z" ? "+00" : t.tz
  return s
}

/**
 * Normalize a single value to an ISO string per the column's chosen format,
 * or null if it doesn't fit (the row is then quarantined at load time).
 */
export function normalizeToIso(value: string, fmt: DateColumnFormat): string | null {
  const p = rawParse(value)
  if (!p) return null

  switch (fmt.layout) {
    case "iso":
      if (p.kind !== "iso") return null
      return buildIso(p.y, p.mo, p.d, p.time, fmt.hasTime)
    case "ymd":
      if (p.kind !== "num" || p.yearPos !== "first") return null
      return buildIso(fullYear(p.parts[0], p.lens[0]), p.parts[1], p.parts[2], p.time, fmt.hasTime)
    case "mdy":
      if (p.kind !== "num" || p.yearPos !== "last") return null
      return buildIso(fullYear(p.parts[2], p.lens[2]), p.parts[0], p.parts[1], p.time, fmt.hasTime)
    case "dmy":
      if (p.kind !== "num" || p.yearPos !== "last") return null
      return buildIso(fullYear(p.parts[2], p.lens[2]), p.parts[1], p.parts[0], p.time, fmt.hasTime)
    case "monthname-mdy":
      if (p.kind !== "month" || !p.monthFirst) return null
      return buildIso(fullYear(p.year, p.yearLen), p.month, p.day, p.time, fmt.hasTime)
    case "monthname-dmy":
      if (p.kind !== "month" || p.monthFirst) return null
      return buildIso(fullYear(p.year, p.yearLen), p.month, p.day, p.time, fmt.hasTime)
    default:
      return null
  }
}

/** Short human label for the layout, for the column-config UI. */
export function dateLayoutLabel(layout: DateLayout): string {
  switch (layout) {
    case "iso": return "ISO"
    case "ymd": return "Y/M/D"
    case "mdy": return "M/D/Y"
    case "dmy": return "D/M/Y"
    case "monthname-mdy": return "Mon D, Y"
    case "monthname-dmy": return "D Mon Y"
  }
}

/** Layouts offered in the per-column format picker. */
export const DATE_LAYOUTS: DateLayout[] = ["iso", "ymd", "mdy", "dmy", "monthname-mdy", "monthname-dmy"]
