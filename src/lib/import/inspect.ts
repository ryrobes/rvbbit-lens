/**
 * Inspect a bounded head sample of a CSV: detect dialect, parse a row
 * sample, synthesize/sanitize column names, and infer a Postgres type per
 * column. Pure (no server-only / db deps) so it's unit-testable and can run
 * either side; the inspect route is a thin wrapper that feeds it bytes.
 */

import { parse } from "csv-parse/sync"
import type { CsvDialect, ImportColumn, InspectResult } from "./types"
import { detectDelimiter, detectEncoding, decodeSample, detectHasHeader } from "./csv-dialect"
import { sanitizeIdent, sniffColumnType } from "./csv-infer"

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

export function inspectCsv({ bytes, totalBytes, hints }: InspectInput): InspectResult {
  const warnings: string[] = []
  const sampledBytes = bytes.length
  const truncated = sampledBytes < totalBytes

  const detected = detectEncoding(bytes)
  const encoding = hints?.encoding ?? detected.encoding
  if (detected.bomLength > 0) warnings.push(`Stripped a ${encoding} byte-order mark.`)

  const text = decodeSample(bytes, encoding)

  const delimiter = hints?.delimiter ?? detectDelimiter(text)
  const quote = hints?.quote ?? '"'
  const nullToken = hints?.nullToken ?? ""
  const trimWhitespace = hints?.trimWhitespace ?? false

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

  // The last row of a truncated sample is almost certainly a half-read line.
  if (truncated && rows.length > 1) rows.pop()

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
    const inferredType = sniffColumnType(colValues, nullTokens)
    const sampleValues = colValues.filter((v) => v.trim() !== "").slice(0, SAMPLE_CELLS)

    columns.push({
      sourceIndex: i,
      sourceName,
      targetName,
      type: inferredType,
      inferredType,
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
