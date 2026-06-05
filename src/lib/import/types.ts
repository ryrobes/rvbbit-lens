/**
 * Shared contract for the CSV importer — the types that cross the
 * client (drop surface + import window) / server (inspect + run routes)
 * boundary. Pure types only, safe to import from either side.
 *
 * Flow: drop a CSV → /api/db/import/inspect reads a bounded head slice
 * and returns a {@link InspectResult} (detected dialect + inferred typed
 * columns + a row sample). The user edits column names/types and picks a
 * target (schema + table + HEAP/RVBBIT) to form an {@link ImportConfig},
 * then /api/db/import/run streams the full file into a freshly-created
 * table via COPY, emitting {@link ImportProgress} frames.
 */

/** Postgres column types the inferrer can assign. `text` is the always-safe fallback. */
export type PgType =
  | "text"
  | "boolean"
  | "integer"
  | "bigint"
  | "double precision"
  | "numeric"
  | "date"
  | "timestamptz"

/** Table storage. `heap` = standard Postgres; `rvbbit` = `CREATE TABLE … USING rvbbit`. */
export type AccessMethod = "heap" | "rvbbit"

export type CsvEncoding = "utf-8" | "utf-16le" | "latin1"

/**
 * How to interpret the raw bytes. Detected from a head sample, then
 * user-overridable in the import window before the full load runs.
 */
export interface CsvDialect {
  /** Field separator — usually one of `, ; \t |`. */
  delimiter: string
  /** Quote char — almost always `"`. Quoted fields may contain the delimiter + newlines. */
  quote: string
  /** Whether the first row is column names (else columns are synthesized `col_1…`). */
  hasHeader: boolean
  encoding: CsvEncoding
  /** Token that maps to SQL NULL. Default `""` (empty field → NULL). */
  nullToken: string
  /** Trim surrounding whitespace from each unquoted field before coercion. */
  trimWhitespace: boolean
}

/** One CSV column mapped to a target table column. */
export interface ImportColumn {
  /** 0-based position in the CSV row. */
  sourceIndex: number
  /** Original header text (or synthesized `col_<n>` when {@link CsvDialect.hasHeader} is false). */
  sourceName: string
  /** SQL-safe identifier to create — sanitized from sourceName, user-editable. */
  targetName: string
  /** Target Postgres type — starts at {@link inferredType}, user-overridable. */
  type: PgType
  /** What the sniffer guessed from the sample (lets the UI offer "reset to inferred"). */
  inferredType: PgType
  nullable: boolean
  /** Whether to include this column in the import (lets the user drop junk columns). */
  include: boolean
  /** A few raw sample values (for the preview + to explain the inferred type). */
  sampleValues: string[]
}

/** Result of inspecting the head slice of a dropped file. */
export interface InspectResult {
  dialect: CsvDialect
  columns: ImportColumn[]
  /** First N fully-parsed rows (raw cell strings), for the preview grid. */
  sampleRows: string[][]
  /** Size of the whole file, bytes. */
  totalBytes: number
  /** Size of the head slice we actually parsed, bytes. */
  sampledBytes: number
  /** Extrapolated row count from avg sampled line length (null if not estimable). */
  estimatedRows: number | null
  /** Non-fatal observations (ragged rows in sample, BOM stripped, deduped names, …). */
  warnings: string[]
}

/** Everything the run route needs to create the table and load it. */
export interface ImportConfig {
  connectionId: string
  schema: string
  table: string
  accessMethod: AccessMethod
  dialect: CsvDialect
  columns: ImportColumn[]
}

export type ImportPhase = "creating" | "copying" | "done" | "error"

/** A progress frame streamed back from the run route (newline-delimited JSON). */
export interface ImportProgress {
  phase: ImportPhase
  bytesRead: number
  totalBytes: number
  rowsRead: number
  rowsLoaded: number
  rowsRejected: number
  message?: string
  error?: string
}
