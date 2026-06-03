"use client"

/**
 * Catalog Drift data layer.
 *
 * Diffs fingerprint snapshots across crawl runs (see docs/CATALOG_KG_PLAN.md
 * §11). SQL-first, mirrors [[data-search]]/data-search.ts.
 *
 * Surface:
 *   - rvbbit.catalog_runs_list(graph, n)
 *   - rvbbit.catalog_drift(run_a, run_b, graph, only_changed)
 *   - rvbbit.catalog_drift_summary(run_a, run_b, graph)
 *   - rvbbit.catalog_object_history(graph, obj_key)
 */

export const CATALOG_GRAPH = "db_catalog"

export interface CatalogRun {
  runId: number
  status: string
  startedAt: number | null
  finishedAt: number | null
  tables: number
  columns: number
  snapshots: number
}

export type DriftChangeType = "added" | "dropped" | "changed" | "unchanged"

export interface DriftRow {
  objKey: string
  kind: "db_table" | "db_column"
  schema: string
  rel: string
  col: string | null
  changeType: DriftChangeType
  severity: number
  flags: string[]
  /** Structured per-facet diff; shape varies — see renderers in drift-window. */
  diff: Record<string, unknown>
}

export interface DriftSummary {
  installed: boolean
  total: number
  added: number
  dropped: number
  changed: number
  tables: number
  columns: number
  maxSeverity: number
  flags: Record<string, number>
}

export interface ObjectHistoryPoint {
  runId: number
  capturedAt: number | null
  nRows: number | null
  ndv: number | null
  nullFrac: number | null
}

// ── plumbing ─────────────────────────────────────────────────────────

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string, rowLimit = 5000): Promise<QueryOk | QueryErr> {
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

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function epoch(v: unknown): number | null {
  return v ? new Date(String(v)).getTime() : null
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function asStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  return []
}

// ── fetchers ─────────────────────────────────────────────────────────

export async function fetchRuns(connectionId: string): Promise<CatalogRun[]> {
  const res = await runQuery(
    connectionId,
    `SELECT run_id, status, started_at, finished_at, tables_seen, columns_seen, snapshots
       FROM rvbbit.catalog_runs_list(${sqlStr(CATALOG_GRAPH)}, 50)`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: num(r.run_id),
    status: String(r.status ?? ""),
    startedAt: epoch(r.started_at),
    finishedAt: epoch(r.finished_at),
    tables: num(r.tables_seen),
    columns: num(r.columns_seen),
    snapshots: num(r.snapshots),
  }))
}

export async function fetchDriftSummary(
  connectionId: string,
  runA: number,
  runB: number,
): Promise<DriftSummary> {
  const empty: DriftSummary = {
    installed: false, total: 0, added: 0, dropped: 0, changed: 0,
    tables: 0, columns: 0, maxSeverity: 0, flags: {},
  }
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.catalog_drift_summary(${runA}, ${runB}, ${sqlStr(CATALOG_GRAPH)}) AS s`,
  )
  if (!res.ok || res.rows.length === 0) return empty
  const s = (res.rows[0].s ?? {}) as Record<string, unknown>
  return {
    installed: true,
    total: num(s.total),
    added: num(s.added),
    dropped: num(s.dropped),
    changed: num(s.changed),
    tables: num(s.tables),
    columns: num(s.columns),
    maxSeverity: num(s.max_severity),
    flags: (s.flags ?? {}) as Record<string, number>,
  }
}

export async function fetchDrift(
  connectionId: string,
  runA: number,
  runB: number,
  onlyChanged = true,
): Promise<{ rows: DriftRow[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT obj_key, kind, schema_name, rel_name, col_name,
            change_type, severity, flags, diff
       FROM rvbbit.catalog_drift(${runA}, ${runB}, ${sqlStr(CATALOG_GRAPH)}, ${onlyChanged})
      ORDER BY severity DESC, obj_key`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      objKey: String(r.obj_key ?? ""),
      kind: (String(r.kind ?? "db_column") as DriftRow["kind"]),
      schema: String(r.schema_name ?? ""),
      rel: String(r.rel_name ?? ""),
      col: strOrNull(r.col_name),
      changeType: (String(r.change_type ?? "changed") as DriftChangeType),
      severity: num(r.severity),
      flags: asStrArray(r.flags),
      diff: (r.diff ?? {}) as Record<string, unknown>,
    })),
  }
}

export async function fetchObjectHistory(
  connectionId: string,
  objKey: string,
): Promise<ObjectHistoryPoint[]> {
  const res = await runQuery(
    connectionId,
    `SELECT run_id, captured_at, n_rows, ndv, null_frac
       FROM rvbbit.catalog_object_history(${sqlStr(CATALOG_GRAPH)}, ${sqlStr(objKey)})`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: num(r.run_id),
    capturedAt: epoch(r.captured_at),
    nRows: numOrNull(r.n_rows),
    ndv: numOrNull(r.ndv),
    nullFrac: numOrNull(r.null_frac),
  }))
}
