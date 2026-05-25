"use client"

import { fetchOperators } from "./operators"

/**
 * Client-side model for rvbbit *backends* — the model-serving endpoints
 * behind `specialist` operator nodes (rows in `rvbbit.backends`; the
 * table was renamed from `rvbbit.specialists`, the `specialist_health()`
 * function and `specialist_usage` view kept their older names).
 * Traffic is reconstructed from the receipt log (see fetchSpecialistCalls);
 * liveness from the `rvbbit.specialist_health()` function. A backend is
 * not directly callable, so the live test wraps it in a probe operator.
 */

export interface SpecialistHealth {
  specialist: string
  transport: string
  endpoint: string
  reachable: boolean
  latency_ms: number | null
  reported_model: string | null
  error: string | null
}

interface QueryOk {
  ok: true
  columns: { name: string }[]
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
function ident(name: string): string {
  return name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

/** Liveness probe — hits each backend's /health endpoint. May be slow. */
export async function fetchSpecialistHealth(
  connectionId: string,
): Promise<{ health: SpecialistHealth[]; error?: string }> {
  const res = await runQuery(connectionId, "SELECT * FROM rvbbit.specialist_health()")
  if (!res.ok) return { health: [], error: res.error }
  return {
    health: res.rows.map((r) => ({
      specialist: String(r.specialist ?? ""),
      transport: String(r.transport ?? ""),
      endpoint: String(r.endpoint ?? ""),
      reachable: r.reachable === true || r.reachable === "t",
      latency_ms: r.latency_ms == null ? null : num(r.latency_ms),
      reported_model: r.reported_model == null ? null : String(r.reported_model),
      error: r.error ? String(r.error) : null,
    })),
  }
}

/**
 * Derive a specialist's wire-input keys and the operators that use it,
 * by scanning every operator's `specialist` nodes (steps + takes nodes).
 */
export async function fetchSpecialistContext(
  connectionId: string,
  name: string,
): Promise<{ inputKeys: string[]; usedBy: string[] }> {
  const { operators } = await fetchOperators(connectionId)
  const keys = new Set<string>()
  const usedBy = new Set<string>()
  for (const op of operators) {
    const nodes = [...(op.steps ?? []), ...(op.takes?.nodes ?? [])]
    for (const n of nodes) {
      if (n.kind === "specialist" && n.specialist === name) {
        usedBy.add(op.name)
        for (const k of Object.keys(n.inputs ?? {})) keys.add(k)
      }
    }
  }
  return { inputKeys: [...keys], usedBy: [...usedBy] }
}

// ── Derived traffic (the receipts event log) ────────────────────────

/**
 * One specialist invocation, reconstructed from a `kind:"specialist"`
 * entry in a receipt's `sub_calls` array. `rvbbit.specialist_usage` is
 * only a thin rollup (and conflates models / throwaway probes); the
 * receipts are the real event log — every call, with its operator,
 * latency and error, individually addressable. In a specialist
 * sub_call the `model` field carries the *specialist name*.
 */
export interface SpecialistCall {
  specialist: string
  operator: string
  step: string
  /** epoch ms of the parent receipt's invocation */
  at: number
  latencyMs: number
  tokensIn: number
  tokensOut: number
  error: string | null
}

const SPECIALIST_CALLS_SQL = `WITH recent AS (
  SELECT operator, invocation_at, sub_calls
  FROM rvbbit.receipts
  WHERE jsonb_typeof(sub_calls) = 'array'
  ORDER BY invocation_at DESC
  LIMIT 6000
)
SELECT sc->>'model'                          AS specialist,
       r.operator                            AS operator,
       sc->>'step'                           AS step,
       r.invocation_at                       AS at,
       COALESCE((sc->>'latency_ms')::int, 0) AS latency_ms,
       COALESCE((sc->>'tokens_in')::int, 0)  AS tokens_in,
       COALESCE((sc->>'tokens_out')::int, 0) AS tokens_out,
       sc->>'error'                          AS error
FROM recent r, LATERAL jsonb_array_elements(r.sub_calls) sc
WHERE sc->>'kind' = 'specialist'
ORDER BY r.invocation_at`

/**
 * Every specialist call across the recent receipt log, oldest → newest.
 * Powers both the fleet overview and the per-specialist monitor — the
 * caller groups + buckets client-side rather than asking SQL to
 * pre-aggregate, so the full distribution stays visible.
 */
export async function fetchSpecialistCalls(
  connectionId: string,
): Promise<{ calls: SpecialistCall[]; error?: string }> {
  const res = await runQuery(connectionId, SPECIALIST_CALLS_SQL)
  if (!res.ok) return { calls: [], error: res.error }
  const calls: SpecialistCall[] = res.rows.map((r) => ({
    specialist: String(r.specialist ?? ""),
    operator: String(r.operator ?? ""),
    step: String(r.step ?? ""),
    at: r.at ? new Date(String(r.at)).getTime() : 0,
    latencyMs: num(r.latency_ms),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    error: r.error == null ? null : String(r.error),
  }))
  return { calls }
}

// ── Live test ───────────────────────────────────────────────────────

/**
 * Test a specialist backend with concrete inputs. Specialists aren't
 * directly callable, so this wraps it in a one-off probe operator,
 * calls it, and cleans up — leaving no permanent objects.
 */
export async function testSpecialist(
  connectionId: string,
  specialist: string,
  inputs: Record<string, string>,
): Promise<{ output: string | null; latencyMs: number; error?: string }> {
  const keys = Object.keys(inputs).filter((k) => k.trim().length > 0)
  if (keys.length === 0) {
    return { output: null, latencyMs: 0, error: "Add at least one input field." }
  }
  const opName = `__studio_probe_${ident(specialist)}`
  const node = {
    name: "probe",
    kind: "specialist",
    specialist,
    inputs: Object.fromEntries(keys.map((k) => [k, `{{ inputs.${ident(k)} }}`])),
  }
  const argNames = keys.map(ident)
  const createSql =
    `SELECT rvbbit.create_operator(` +
    `op_name => ${sqlStr(opName)}, ` +
    `op_arg_names => ARRAY[${argNames.map(sqlStr).join(", ")}]::text[], ` +
    `op_arg_types => ARRAY[${argNames.map(() => sqlStr("text")).join(", ")}]::text[], ` +
    `op_return_type => 'text', op_parser => 'raw_text', ` +
    `op_steps => ${sqlStr(JSON.stringify([node]))}::jsonb)`
  const callArgs = keys.map((k) => sqlStr(inputs[k])).join(", ")
  const callSql = `SELECT rvbbit.${opName}(${callArgs}) AS result`
  const dropSig = [...argNames.map(() => "text"), "jsonb"].join(", ")
  const cleanupSql =
    `DROP FUNCTION IF EXISTS rvbbit.${opName}(${dropSig}); ` +
    `DELETE FROM rvbbit.operators WHERE name = ${sqlStr(opName)}`

  const started = Date.now()
  const res = await runQuery(connectionId, `${createSql};\n${callSql}`)
  const latencyMs = Date.now() - started
  // Always clean up, even on failure.
  await runQuery(connectionId, cleanupSql)

  if (!res.ok) return { output: null, latencyMs, error: res.error }
  const val = res.rows[res.rows.length - 1]?.result
  return { output: val == null ? null : String(val), latencyMs }
}
