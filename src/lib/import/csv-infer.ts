/**
 * CSV → Postgres type inference and SQL-safe identifier sanitizing.
 *
 * The inferrer is deliberately conservative: it assigns the *narrowest*
 * type that fits every sampled non-null value, and falls back to `text`
 * the moment a value doesn't fit. Better to import cleanly as text and let
 * the user widen than to guess a type that rejects rows on load.
 */

import type { DateColumnFormat, PgType } from "./types"
import { detectDateColumn } from "./date-formats"

/** Order matters for the picker UI: narrowest → widest, text last. */
export const PG_TYPE_OPTIONS: PgType[] = [
  "boolean",
  "integer",
  "bigint",
  "double precision",
  "numeric",
  "date",
  "timestamptz",
  "text",
]

export const INT_RE = /^[+-]?\d+$/
// Requires a decimal point or exponent (pure ints are caught by INT_RE first).
export const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+(\.\d+)?e[+-]?\d+|\d+\.\d*e[+-]?\d+)$/i

const BOOL_TRUE = new Set(["true", "t", "yes", "y"])
const BOOL_FALSE = new Set(["false", "f", "no", "n"])

const INT4_MIN = -2147483648n
const INT4_MAX = 2147483647n
const INT8_MIN = -9223372036854775808n
const INT8_MAX = 9223372036854775807n

function fitsRange(s: string, min: bigint, max: bigint): boolean {
  try {
    const v = BigInt(s)
    return v >= min && v <= max
  } catch {
    return false
  }
}

function isBoolish(v: string): boolean {
  const l = v.toLowerCase()
  return BOOL_TRUE.has(l) || BOOL_FALSE.has(l)
}

/** Normalize a boolean-ish token to the Postgres COPY literal, or null. */
export function boolToken(v: string): "t" | "f" | null {
  const l = v.toLowerCase()
  if (BOOL_TRUE.has(l)) return "t"
  if (BOOL_FALSE.has(l)) return "f"
  return null
}

export function fitsInt4(s: string): boolean {
  return fitsRange(s, INT4_MIN, INT4_MAX)
}
export function fitsInt8(s: string): boolean {
  return fitsRange(s, INT8_MIN, INT8_MAX)
}

/**
 * Infer the narrowest Postgres type that fits every non-null sample value,
 * plus a source date format when the column is a (possibly non-ISO) date /
 * timestamp. `nullTokens` are treated as absent. An all-null/empty column is
 * `text`. Order: boolean → int → float → date/timestamp → text.
 */
export function inferColumn(
  values: string[],
  nullTokens: Set<string> = new Set([""]),
): { type: PgType; dateFormat?: DateColumnFormat } {
  const vals: string[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (nullTokens.has(v)) continue
    vals.push(v)
  }
  if (vals.length === 0) return { type: "text" }

  // boolean — textual only (0/1 stay integer so we don't hijack int columns)
  if (vals.every(isBoolish)) return { type: "boolean" }

  // integers
  if (vals.every((v) => INT_RE.test(v))) {
    if (vals.every((v) => fitsRange(v, INT4_MIN, INT4_MAX))) return { type: "integer" }
    if (vals.every((v) => fitsRange(v, INT8_MIN, INT8_MAX))) return { type: "bigint" }
    return { type: "numeric" } // integers too big for int8 → arbitrary precision
  }

  // decimals / floats
  if (vals.every((v) => INT_RE.test(v) || FLOAT_RE.test(v))) return { type: "double precision" }

  // dates / timestamps (ISO + common US/EU/month-name forms)
  const dateFormat = detectDateColumn(values, nullTokens)
  if (dateFormat) return { type: dateFormat.hasTime ? "timestamptz" : "date", dateFormat }

  return { type: "text" }
}

/** Type-only inference (used where the date format isn't needed). */
export function sniffColumnType(values: string[], nullTokens: Set<string> = new Set([""])): PgType {
  return inferColumn(values, nullTokens).type
}

/**
 * Postgres fully-reserved words that cannot be used as an unquoted column
 * name. Not exhaustive — just the ones realistically seen as CSV headers.
 * A sanitized name colliding with one gets a `_col` suffix so we never have
 * to emit a quoted identifier (the whole point is unquoted-safe names).
 */
const RESERVED = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric",
  "both", "case", "cast", "check", "collate", "column", "constraint", "create",
  "current_catalog", "current_date", "current_role", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc",
  "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign",
  "from", "grant", "group", "having", "in", "initially", "intersect", "into",
  "lateral", "leading", "limit", "localtime", "localtimestamp", "not", "null",
  "offset", "on", "only", "or", "order", "placing", "primary", "references",
  "returning", "select", "session_user", "some", "symmetric", "table", "then",
  "to", "trailing", "true", "union", "unique", "user", "using", "variadic",
  "when", "where", "window", "with",
])

/** Postgres identifier length cap (NAMEDATALEN - 1). */
const MAX_IDENT = 63

/**
 * Turn an arbitrary header into a lowercase, unquoted-safe SQL identifier,
 * deduped against `used` (which is mutated to record the result). The goal
 * is names you never have to quote: `Order Date` → `order_date`, `2024` →
 * `c_2024`, `select` → `select_col`, duplicate `id` → `id_2`.
 */
export function sanitizeIdent(raw: string, used: Set<string>): string {
  let s = (raw ?? "").replace(/^﻿/, "").trim().toLowerCase()
  s = s.replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
  if (s === "") s = "col"
  if (/^[0-9]/.test(s)) s = `c_${s}`
  if (RESERVED.has(s)) s = `${s}_col`
  if (s.length > MAX_IDENT) s = s.slice(0, MAX_IDENT)

  let candidate = s
  let n = 2
  while (used.has(candidate)) {
    const suffix = `_${n}`
    candidate = `${s.slice(0, MAX_IDENT - suffix.length)}${suffix}`
    n++
  }
  used.add(candidate)
  return candidate
}

/** Does an identifier need double-quoting to be valid Postgres? After
 *  {@link sanitizeIdent} the answer should be no — but schema names come
 *  from the catalog and could be anything, so DDL still checks. */
export function identNeedsQuote(name: string): boolean {
  return !/^[a-z_][a-z0-9_]*$/.test(name) || RESERVED.has(name)
}
