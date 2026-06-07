import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete"
import type { SQLNamespace } from "@codemirror/lang-sql"
import type { SchemaColumn, SchemaFunction, SchemaSnapshot, SchemaTable } from "@/lib/db/types"

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
  /** Extra completion source for callable routines (the rvbbit semantic
   *  functions); undefined when the connection exposes none. */
  functionSource: CompletionSource | undefined
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
  if (!snapshot) return null
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
  const functionSource = buildFunctionCompletionSource(snapshot.functions ?? [])
  if (snapshot.tables.length === 0 && !functionSource) return null
  return { namespace, defaultSchema, functionSource }
}

// ── Function completion ──────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Completion icon by rvbbit operator shape (so dimension/rowset/aggregate ops
 *  read differently from plain scalar functions); falls back to pg kind. */
function completionType(fn: SchemaFunction): string {
  switch (fn.shape) {
    case "aggregate":
      return "method"
    case "dimension":
      return "interface"
    case "rowset":
      return "class"
    case "scalar":
      return "function"
  }
  return fn.kind === "aggregate" ? "method" : "function"
}

/** A routine → a snippet completion. `qualify` prefixes the schema (`rvbbit.`)
 *  for bare-word completion; omit it once the user has already typed `schema.`.
 *  Required (non-default) args become tab-stops so arity is obvious. */
function functionCompletion(fn: SchemaFunction, qualify: boolean): Completion {
  const prefix = qualify ? `${fn.schema}.` : ""
  let body: string
  if (fn.requiredCount > 0) {
    body = Array.from({ length: fn.requiredCount }, (_, i) => {
      const name = fn.argNames[i]
      return name ? `\${${name}}` : "${}"
    }).join(", ")
  } else if (fn.args.trim().length > 0) {
    body = "${}" // only optional args — land the cursor inside the parens
  } else {
    body = "" // genuinely no args
  }
  const sig = `${fn.schema}.${fn.name}(${fn.args}) → ${truncate(fn.result, 120)}`
  return snippetCompletion(`${prefix}${fn.name}(${body})`, {
    label: fn.name,
    type: completionType(fn),
    detail: truncate(fn.args, 48) || undefined,
    info: fn.comment ? `${fn.comment} — ${sig}` : sig,
  })
}

/** A completion source that offers callable routines: bare words insert the
 *  fully-qualified call (`rvbbit.synth_sql(…)`); after `schema.` it offers that
 *  schema's functions unqualified (so they sit alongside lang-sql's tables). */
function buildFunctionCompletionSource(functions: SchemaFunction[]): CompletionSource | undefined {
  if (functions.length === 0) return undefined
  // Dedupe overloads by schema+name, keeping the richest (most input args).
  const byKey = new Map<string, SchemaFunction>()
  for (const fn of functions) {
    const key = `${fn.schema}.${fn.name}`
    const prev = byKey.get(key)
    if (!prev || fn.argNames.length > prev.argNames.length) byKey.set(key, fn)
  }
  const all = [...byKey.values()]
  const bareOptions = all.map((fn) => functionCompletion(fn, true))
  const bySchema = new Map<string, Completion[]>()
  for (const fn of all) {
    const list = bySchema.get(fn.schema) ?? []
    list.push(functionCompletion(fn, false))
    bySchema.set(fn.schema, list)
  }

  return (ctx: CompletionContext): CompletionResult | null => {
    const tok = ctx.matchBefore(/[\w.]*/)
    if (!tok) return null
    const dot = tok.text.lastIndexOf(".")
    if (dot >= 0) {
      // schema-qualified: offer that schema's functions (unqualified insert).
      // A non-schema prefix (e.g. a table alias `r.`) returns null → no noise.
      const options = bySchema.get(tok.text.slice(0, dot))
      if (!options) return null
      return { from: tok.from + dot + 1, options, validFor: /^\w*$/ }
    }
    // bare word: offer all routines, qualified insert. Don't dump the full list
    // on an empty token unless the user explicitly asked (Ctrl-Space).
    if (tok.from === tok.to && !ctx.explicit) return null
    return { from: tok.from, options: bareOptions, validFor: /^\w*$/ }
  }
}
