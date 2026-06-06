"use client"

/**
 * UI-only node positions for the operator builder canvas. Kept out of the
 * operator DDL (positions aren't part of an operator's semantics) in a
 * lens-managed side table, created lazily on first use:
 *
 *   rvbbit.operator_layout(operator text pk, layout jsonb, updated_at)
 *
 * `layout` is `{ v: 1, positions: { [nodeId]: {x, y} } }`. A node with no
 * stored position falls back to the deterministic auto-layout, so this is
 * a pure override layer — deleting the row restores the tidy default.
 */

export interface NodePos {
  x: number
  y: number
}
export type OperatorLayout = Record<string, NodePos>

interface QueryOk {
  ok: true
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 5000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

const DDL =
  "CREATE TABLE IF NOT EXISTS rvbbit.operator_layout (" +
  "operator text PRIMARY KEY, " +
  "layout jsonb NOT NULL DEFAULT '{}'::jsonb, " +
  "updated_at timestamptz NOT NULL DEFAULT now())"

// Create the table at most once per connection per session.
const ensured = new Set<string>()
async function ensureTable(connectionId: string): Promise<boolean> {
  if (ensured.has(connectionId)) return true
  const res = await runQuery(connectionId, DDL)
  if (res.ok) ensured.add(connectionId)
  return res.ok
}

export async function fetchOperatorLayout(
  connectionId: string,
  operatorName: string,
): Promise<{ layout: OperatorLayout; error?: string }> {
  if (!(await ensureTable(connectionId))) return { layout: {} }
  const res = await runQuery(
    connectionId,
    `SELECT layout FROM rvbbit.operator_layout WHERE operator = ${sqlStr(operatorName)}`,
  )
  if (!res.ok) return { layout: {}, error: res.error }
  const raw = res.rows[0]?.layout as { positions?: OperatorLayout } | null | undefined
  return { layout: (raw && typeof raw === "object" ? raw.positions ?? {} : {}) }
}

export async function saveOperatorLayout(
  connectionId: string,
  operatorName: string,
  layout: OperatorLayout,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await ensureTable(connectionId))) return { ok: false }
  const json = sqlStr(JSON.stringify({ v: 1, positions: layout }))
  const res = await runQuery(
    connectionId,
    `INSERT INTO rvbbit.operator_layout (operator, layout, updated_at) ` +
      `VALUES (${sqlStr(operatorName)}, ${json}::jsonb, now()) ` +
      `ON CONFLICT (operator) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`,
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function clearOperatorLayout(
  connectionId: string,
  operatorName: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await ensureTable(connectionId))) return { ok: false }
  const res = await runQuery(
    connectionId,
    `DELETE FROM rvbbit.operator_layout WHERE operator = ${sqlStr(operatorName)}`,
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}
