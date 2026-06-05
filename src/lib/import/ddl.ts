/**
 * Generates the `CREATE TABLE` (and COPY column list) for an import.
 *
 * HEAP vs RVBBIT differ only by the trailing `USING rvbbit` — the rvbbit
 * access method is heap-compatible, so the column list, types, and COPY
 * path are identical either way.
 */

import type { AccessMethod, ImportColumn } from "./types"
import { identNeedsQuote } from "./csv-infer"

/** Double-quote an identifier only when it wouldn't be valid bare. */
export function quoteIdent(name: string): string {
  return identNeedsQuote(name) ? `"${name.replace(/"/g, '""')}"` : name
}

export function qualifiedName(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

/** Columns the user kept, in CSV order. */
export function includedColumns(columns: ImportColumn[]): ImportColumn[] {
  return columns.filter((c) => c.include)
}

export function buildCreateTableSql(args: {
  schema: string
  table: string
  accessMethod: AccessMethod
  columns: ImportColumn[]
}): string {
  const cols = includedColumns(args.columns)
  const lines = cols.map((c) => {
    const notNull = c.nullable ? "" : " NOT NULL"
    return `  ${quoteIdent(c.targetName)} ${c.type}${notNull}`
  })
  // Default access method (heap) needs no clause; only rvbbit is explicit.
  const using = args.accessMethod === "rvbbit" ? " USING rvbbit" : ""
  return `CREATE TABLE ${qualifiedName(args.schema, args.table)} (\n${lines.join(",\n")}\n)${using};`
}

/** `(col_a, col_b, …)` for the COPY target — included columns, in order. */
export function buildCopyColumnList(columns: ImportColumn[]): string {
  return `(${includedColumns(columns).map((c) => quoteIdent(c.targetName)).join(", ")})`
}
