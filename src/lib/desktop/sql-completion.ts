import type { Completion } from "@codemirror/autocomplete"
import type { SQLNamespace } from "@codemirror/lang-sql"
import type { SchemaColumn, SchemaSnapshot, SchemaTable } from "@/lib/db/types"

/**
 * Schema-aware SQL completion for the CodeMirror editor.
 *
 * Turns the already-loaded {@link SchemaSnapshot} (the same metadata the Finder
 * shows — tables, columns, data types, comments, PK flags) into the nested
 * `SQLNamespace` that `@codemirror/lang-sql` consumes, so the editor suggests
 * tables and columns with type hints in the popup. Pure + client-side: it
 * reuses the snapshot held in desktop-shell, so there are no extra queries.
 */
export interface SqlCompletionSchema {
  /** pg schema → table → column completions, for `sql({ schema })`. */
  namespace: SQLNamespace
  /** Schema whose tables complete unqualified (the Postgres search_path head). */
  defaultSchema: string | undefined
}

function rowsLabel(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** A column → completion with the data type (+ PK/not-null) shown as detail and
 *  any comment as the expandable info panel. */
function columnCompletion(col: SchemaColumn): Completion {
  const flags: string[] = []
  if (col.isPrimaryKey) flags.push("PK")
  if (!col.nullable) flags.push("not null")
  return {
    label: col.name,
    type: "property",
    detail: flags.length ? `${col.dataType} · ${flags.join(" · ")}` : col.dataType,
    info: col.comment ?? undefined,
    boost: col.isPrimaryKey ? 1 : 0,
  }
}

/** A table → a `{ self, children }` namespace node: `self` customizes the table
 *  completion (kind + row count as detail, comment as info), `children` are its
 *  columns (in catalog order). */
function tableNode(table: SchemaTable): SQLNamespace {
  const columns = [...table.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(columnCompletion)
  const rows = table.rows ?? table.rowEstimate
  const bits: string[] = []
  if (table.kind !== "table") bits.push(table.kind)
  if (typeof rows === "number" && rows > 0) bits.push(`${rowsLabel(rows)} rows`)
  return {
    self: {
      label: table.name,
      type: table.kind === "view" || table.kind === "matview" ? "class" : "type",
      detail: bits.join(" · ") || undefined,
      info: table.comment ?? undefined,
    },
    children: columns,
  }
}

export function buildSqlCompletionSchema(
  snapshot: SchemaSnapshot | null,
): SqlCompletionSchema | null {
  if (!snapshot || snapshot.tables.length === 0) return null
  // pg schema → { table → node }. lang-sql lets `schema.table` drill in, and
  // `defaultSchema` tables complete unqualified.
  const namespace: Record<string, Record<string, SQLNamespace>> = {}
  for (const table of snapshot.tables) {
    const tables = (namespace[table.schema] ??= {})
    tables[table.name] = tableNode(table)
  }
  const defaultSchema = snapshot.schemas.includes("public")
    ? "public"
    : snapshot.schemas.find((s) => s !== "rvbbit") ?? snapshot.schemas[0]
  return { namespace, defaultSchema }
}
