/**
 * Per-cell coercion + CSV serialization for the COPY loader.
 *
 * We validate/normalize every value in Node *before* it reaches Postgres, so
 * COPY only ever sees well-formed data — that's what makes row-level
 * quarantine possible (a raw COPY aborts the whole stream on the first bad
 * row). A cell that doesn't fit its column's type is rejected (its row is
 * quarantined); everything else is emitted in a canonical form Postgres
 * accepts without further casting.
 */

import type { CsvDialect, ImportColumn } from "./types"
import { INT_RE, FLOAT_RE, boolToken, fitsInt4, fitsInt8 } from "./csv-infer"
import { normalizeToIso } from "./date-formats"

export type CoerceResult = { value: string | null } | { reject: string }

/** Coerce one raw cell to a COPY-ready value (or a rejection reason). */
export function coerceCell(raw: string, col: ImportColumn, dialect: CsvDialect): CoerceResult {
  const trimmed = raw.trim()

  // NULL — a field equal to the null token (whitespace-only counts).
  if (trimmed === dialect.nullToken) {
    if (col.nullable) return { value: null }
    return { reject: `${col.targetName}: null in a NOT NULL column` }
  }

  switch (col.type) {
    case "text":
      // Typed columns always trim (whitespace is never meaningful around a
      // number/date); text keeps raw unless the user asked to trim.
      return { value: dialect.trimWhitespace ? trimmed : raw }
    case "boolean": {
      const b = boolToken(trimmed)
      return b ? { value: b } : { reject: `${col.targetName}: not a boolean ("${clip(trimmed)}")` }
    }
    case "integer":
      return INT_RE.test(trimmed) && fitsInt4(trimmed)
        ? { value: trimmed }
        : { reject: `${col.targetName}: not a 32-bit integer ("${clip(trimmed)}")` }
    case "bigint":
      return INT_RE.test(trimmed) && fitsInt8(trimmed)
        ? { value: trimmed }
        : { reject: `${col.targetName}: not a 64-bit integer ("${clip(trimmed)}")` }
    case "numeric":
      return INT_RE.test(trimmed) || FLOAT_RE.test(trimmed)
        ? { value: trimmed }
        : { reject: `${col.targetName}: not numeric ("${clip(trimmed)}")` }
    case "double precision":
      return INT_RE.test(trimmed) || FLOAT_RE.test(trimmed)
        ? { value: trimmed }
        : { reject: `${col.targetName}: not a number ("${clip(trimmed)}")` }
    case "date":
    case "timestamptz": {
      const layout = col.dateFormat?.layout ?? "iso"
      const iso = normalizeToIso(trimmed, { layout, hasTime: col.type === "timestamptz" })
      return iso
        ? { value: iso }
        : { reject: `${col.targetName}: not a valid ${col.type} as ${layout} ("${clip(trimmed)}")` }
    }
    default:
      return { value: raw }
  }
}

function clip(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * One CSV line for `COPY … FORMAT csv, NULL ''`. A null → empty field; an
 * empty *string* → quoted `""` (Postgres treats unquoted-empty as the NULL
 * token but quoted-empty as a real empty string); anything containing the
 * delimiter, a quote, or a newline is quoted with internal quotes doubled.
 */
export function toCopyCsvLine(values: (string | null)[]): string {
  return `${values.map(csvField).join(",")}\n`
}

function csvField(v: string | null): string {
  if (v === null) return ""
  if (v === "") return '""'
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}
