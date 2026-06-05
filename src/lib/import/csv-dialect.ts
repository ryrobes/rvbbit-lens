/**
 * CSV dialect detection over a bounded head sample: byte encoding (via BOM),
 * field delimiter, and whether the first row is a header. Each result is a
 * best-effort default the user can override in the import window.
 */

import { parse } from "csv-parse/sync"
import type { CsvEncoding } from "./types"
import { sniffColumnType } from "./csv-infer"

/** Candidate field separators, in priority order for tie-breaks. */
const DELIMITERS = [",", "\t", ";", "|"]

/** Detect encoding + BOM byte length from the leading bytes. */
export function detectEncoding(bytes: Uint8Array): { encoding: CsvEncoding; bomLength: number } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", bomLength: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", bomLength: 2 }
  }
  // UTF-16BE has no TextDecoder label we expose; treat as utf-16le is wrong,
  // so fall back to utf-8 and let the user pick if the preview looks garbled.
  return { encoding: "utf-8", bomLength: 0 }
}

/** Decode a byte sample to text using the given encoding, stripping a BOM. */
export function decodeSample(bytes: Uint8Array, encoding: CsvEncoding): string {
  // `fatal: false` so a partial multibyte char at the slice boundary yields a
  // replacement char rather than throwing. `ignoreBOM: false` strips the BOM.
  const decoder = new TextDecoder(encoding, { fatal: false, ignoreBOM: false })
  return decoder.decode(bytes)
}

/**
 * Pick the delimiter that yields the most consistent column count across the
 * first rows of the sample. Uses csv-parse per candidate so quoting/escapes
 * are honored (a naive split would miscount delimiters inside quoted fields).
 */
export function detectDelimiter(sample: string): string {
  let best = DELIMITERS[0]
  let bestScore = -1
  for (const delim of DELIMITERS) {
    let rows: string[][]
    try {
      rows = parse(sample, {
        delimiter: delim,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
        to: 30,
      }) as string[][]
    } catch {
      continue
    }
    if (rows.length === 0) continue
    // Mode of the per-row column counts, and how many rows hit that mode.
    const counts = new Map<number, number>()
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1)
    let modeCols = 1
    let modeHits = 0
    for (const [cols, hits] of counts) {
      if (hits > modeHits || (hits === modeHits && cols > modeCols)) {
        modeCols = cols
        modeHits = hits
      }
    }
    if (modeCols < 2) continue // a single column means this delimiter isn't present
    // Consistency dominates column count: a *wrong* delimiter often splits
    // quoted fields into many (but inconsistent) columns, which would beat
    // the right delimiter if we ranked on column count first.
    const consistency = modeHits / rows.length
    const score = consistency * 1000 + modeCols
    if (score > bestScore) {
      bestScore = score
      best = delim
    }
  }
  return best
}

/**
 * Guess whether the first row is a header. Heuristic: if any first-row cell
 * already looks like typed data (a number, date, or boolean) it's probably
 * data, not a label. Defaults to true (header) when ambiguous.
 */
export function detectHasHeader(rows: string[][]): boolean {
  if (rows.length === 0) return true
  const first = rows[0]
  const firstLooksData = first.some(
    (c) => c.trim() !== "" && sniffColumnType([c]) !== "text",
  )
  return !firstLooksData
}
