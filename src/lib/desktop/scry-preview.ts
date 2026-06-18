"use client"

/**
 * Scry preview — the on-demand "data in a node" layer (P3).
 *
 * Pure data fetchers over /api/db/query: a small live TABLE preview, a COLUMN
 * top-values preview, and KG metadata from rvbbit.kg_nodes.properties. Preview
 * fetchers THROW on transport/SQL error (so the node shows an error state) but
 * return empty data for a legitimately empty result. Metadata is best-effort
 * (never throws) and falls back to the hit's fingerprint.
 */

import { CATALOG_GRAPH, type DataSearchHit } from "@/lib/rvbbit/data-search"

const PREVIEW_ROW_LIMIT = 8 // table preview rows
const PREVIEW_COL_LIMIT = 6 // table preview visible columns
const VALUE_LIMIT = 8 // column top-values rows

function quoteIdent(s: string): string {
  return `"${String(s).replace(/"/g, '""')}"`
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
const qualified = (schema: string, rel: string) => `${quoteIdent(schema)}.${quoteIdent(rel)}`

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string, rowLimit = 16): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── value coercion (kg_nodes.properties values are often stringified) ──
function asNum(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function asStr(v: unknown): string | null {
  return v == null || v === "" ? null : String(v)
}
function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === "t" || v === 1 || v === "1"
}

// ── result + meta types ──
export interface PreviewColumn {
  name: string
}
export interface TablePreview {
  mode: "table"
  columns: PreviewColumn[]
  rows: Array<Record<string, unknown>>
  hiddenCols: number
}
export interface ColumnPreview {
  mode: "column"
  values: { value: unknown; n: number }[]
}
export type PreviewData = TablePreview | ColumnPreview

export type NodeMeta =
  | {
      kind: "db_table"
      rowCount: number | null
      nCols: number | null
      sizeBytes: number | null
      comment: string | null
      doc: string | null
    }
  | {
      kind: "db_column"
      dataType: string | null
      ndv: number | null
      nullFrac: number | null
      isPk: boolean
      isFk: boolean
      fkTarget: string | null
      doc: string | null
    }

export async function fetchTablePreview(connectionId: string, schema: string, rel: string): Promise<TablePreview> {
  const sql = `SELECT * FROM ${qualified(schema, rel)} LIMIT ${PREVIEW_ROW_LIMIT}`
  const res = await runQuery(connectionId, sql, PREVIEW_ROW_LIMIT)
  if (!res.ok) throw new Error(res.error || "preview failed")
  const allCols = res.columns ?? []
  const columns = allCols.slice(0, PREVIEW_COL_LIMIT)
  return { mode: "table", columns, rows: res.rows ?? [], hiddenCols: Math.max(0, allCols.length - columns.length) }
}

export async function fetchColumnPreview(
  connectionId: string,
  schema: string,
  rel: string,
  col: string,
): Promise<ColumnPreview> {
  const sql =
    `SELECT ${quoteIdent(col)} AS value, count(*) AS n ` +
    `FROM ${qualified(schema, rel)} ` +
    `GROUP BY 1 ORDER BY n DESC NULLS LAST LIMIT ${VALUE_LIMIT}`
  const res = await runQuery(connectionId, sql, VALUE_LIMIT)
  if (!res.ok) throw new Error(res.error || "preview failed")
  return { mode: "column", values: (res.rows ?? []).map((r) => ({ value: r.value, n: asNum(r.n) ?? 0 })) }
}

/** Best-effort KG metadata — never throws; falls back to the hit's fingerprint. */
export async function fetchNodeMeta(connectionId: string, hit: DataSearchHit, graph: string = CATALOG_GRAPH): Promise<NodeMeta> {
  const fallbackDoc = hit.doc || null
  const sql =
    `SELECT properties FROM rvbbit.kg_nodes ` +
    `WHERE node_id = ${Number(hit.nodeId)} AND graph_id = ${sqlStr(graph)}`
  const res = await runQuery(connectionId, sql, 1)
  let props: Record<string, unknown> = {}
  if (res.ok && res.rows[0]?.properties != null) {
    const raw = res.rows[0].properties
    if (typeof raw === "string") {
      try {
        props = JSON.parse(raw) as Record<string, unknown>
      } catch {
        props = {}
      }
    } else if (typeof raw === "object") {
      props = raw as Record<string, unknown>
    }
  }
  if (hit.kind === "db_table") {
    return {
      kind: "db_table",
      rowCount: asNum(props.n_rows),
      nCols: asNum(props.n_columns),
      sizeBytes: asNum(props.size_bytes),
      comment: asStr(props.comment),
      doc: asStr(props.search_doc) ?? fallbackDoc,
    }
  }
  return {
    kind: "db_column",
    dataType: asStr(props.data_type),
    ndv: asNum(props.ndv),
    nullFrac: asNum(props.null_frac),
    isPk: asBool(props.is_pk),
    isFk: asBool(props.is_fk),
    fkTarget: asStr(props.fk_target),
    doc: asStr(props.search_doc) ?? fallbackDoc,
  }
}
