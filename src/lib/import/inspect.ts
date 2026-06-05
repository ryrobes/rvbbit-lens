/**
 * Inspect a bounded head sample of a CSV: detect dialect, parse a row
 * sample, synthesize/sanitize column names, and infer a Postgres type per
 * column. Pure (no server-only / db deps) so it's unit-testable and can run
 * either side; the inspect route is a thin wrapper that feeds it bytes.
 */

import { parse } from "csv-parse/sync"
import type { CsvDialect, ImportColumn, InspectResult } from "./types"
import { detectDelimiter, detectEncoding, decodeSample, detectHasHeader } from "./csv-dialect"
import { inferColumn, sanitizeIdent } from "./csv-infer"

/** Rows shown in the preview grid (sniffing uses every sampled row). */
const PREVIEW_ROWS = 100
/** Sample cells surfaced per column to justify the inferred type. */
const SAMPLE_CELLS = 8

export interface InspectInput {
  bytes: Uint8Array
  /** Size of the whole file; lets us extrapolate the row count + flag truncation. */
  totalBytes: number
  /** User overrides applied on a re-inspect (delimiter, quote, header, encoding, …). */
  hints?: Partial<CsvDialect>
}

/**
 * Cut `text` at the last newline that occurs *outside* a quoted field, so a
 * truncated sample ends on a complete record. A simple quote-parity toggle is
 * correct for RFC-4180 doubled-quote escaping (`""` flips twice → net even).
 * Returns the original text if no safe boundary is found (e.g. a single row
 * larger than the whole sample).
 */
function trimToLastRecordBoundary(text: string, quote: string): string {
  let inQuotes = false
  let lastBoundary = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === quote) inQuotes = !inQuotes
    else if (ch === "\n" && !inQuotes) lastBoundary = i
  }
  return lastBoundary >= 0 ? text.slice(0, lastBoundary + 1) : text
}

export function inspectCsv({ bytes, totalBytes, hints }: InspectInput): InspectResult {
  const warnings: string[] = []
  const sampledBytes = bytes.length
  const truncated = sampledBytes < totalBytes

  const detected = detectEncoding(bytes)
  const encoding = hints?.encoding ?? detected.encoding
  if (detected.bomLength > 0) warnings.push(`Stripped a ${encoding} byte-order mark.`)

  const fullText = decodeSample(bytes, encoding)

  const delimiter = hints?.delimiter ?? detectDelimiter(fullText)
  const quote = hints?.quote ?? '"'
  const nullToken = hints?.nullToken ?? ""
  const trimWhitespace = hints?.trimWhitespace ?? false

  // A truncated sample almost always cuts mid-row — often inside a quoted
  // field — which leaves a dangling opening quote that the parser rejects
  // ("Quote Not Closed"). Trim back to the last record boundary that sits
  // outside any quoted field so we only ever parse complete rows.
  const text = truncated ? trimToLastRecordBoundary(fullText, quote) : fullText

  let rows: string[][]
  try {
    rows = parse(text, {
      delimiter,
      quote,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as string[][]
  } catch (e) {
    rows = []
    warnings.push(`Parse error: ${e instanceof Error ? e.message : String(e)}`)
  }

  const parsedRowCount = rows.length
  const hasHeader = hints?.hasHeader ?? detectHasHeader(rows)
  const headerRow = hasHeader ? rows[0] : null
  const dataRows = hasHeader ? rows.slice(1) : rows
  if (!hasHeader) warnings.push("No header row detected — column names were generated.")

  // Column count = widest row seen, so ragged rows don't silently lose columns.
  let colCount = headerRow?.length ?? 0
  for (const r of rows) colCount = Math.max(colCount, r.length)
  if (colCount === 0) {
    return {
      dialect: { delimiter, quote, hasHeader, encoding, nullToken, trimWhitespace },
      columns: [],
      sampleRows: [],
      totalBytes,
      sampledBytes,
      estimatedRows: 0,
      warnings: [...warnings, "No columns found in the sample."],
    }
  }

  const ragged = rows.filter((r) => r.length !== colCount).length
  if (ragged > 0) {
    warnings.push(`${ragged} sampled row${ragged === 1 ? "" : "s"} had a different column count (ragged).`)
  }

  const usedNames = new Set<string>()
  const nullTokens = new Set([nullToken])
  let renamed = 0

  const columns: ImportColumn[] = []
  for (let i = 0; i < colCount; i++) {
    const rawName = headerRow?.[i]?.trim()
    const sourceName = rawName && rawName.length > 0 ? rawName : `col_${i + 1}`
    const targetName = sanitizeIdent(sourceName, usedNames)
    if (targetName !== sourceName) renamed++

    const colValues = dataRows.map((r) => r[i] ?? "")
    const { type: inferredType, dateFormat } = inferColumn(colValues, nullTokens)
    const sampleValues = colValues.filter((v) => v.trim() !== "").slice(0, SAMPLE_CELLS)

    columns.push({
      sourceIndex: i,
      sourceName,
      targetName,
      type: inferredType,
      inferredType,
      dateFormat,
      nullable: true, // import-friendly default; the user can tighten to NOT NULL
      include: true,
      sampleValues,
    })
  }
  if (renamed > 0) {
    warnings.push(`${renamed} column name${renamed === 1 ? " was" : "s were"} adjusted to be SQL-safe.`)
  }

  const sampleRows = dataRows.slice(0, PREVIEW_ROWS).map((r) => {
    const padded = r.slice(0, colCount)
    while (padded.length < colCount) padded.push("")
    return padded
  })

  // Exact when the sample is the whole file; otherwise extrapolate from the
  // average bytes/row over the parsed sample.
  let estimatedRows: number | null
  if (!truncated) {
    estimatedRows = dataRows.length
  } else if (parsedRowCount > 0) {
    const avgBytesPerRow = sampledBytes / parsedRowCount
    const totalRows = Math.round(totalBytes / avgBytesPerRow)
    estimatedRows = Math.max(0, totalRows - (hasHeader ? 1 : 0))
  } else {
    estimatedRows = null
  }

  return {
    dialect: { delimiter, quote, hasHeader, encoding, nullToken, trimWhitespace },
    columns,
    sampleRows,
    totalBytes,
    sampledBytes,
    estimatedRows,
    warnings,
  }
}
