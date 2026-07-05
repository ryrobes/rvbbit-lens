"use client"

import {
  fetchLlmModels,
  fetchOperators,
  type LlmModel,
  type OpStep,
  type RvbbitOperator,
} from "./operators"

interface QueryOk<R = Record<string, unknown>> {
  ok: true
  columns: { name: string }[]
  rows: R[]
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery<R = Record<string, unknown>>(
  connectionId: string,
  sql: string,
  rowLimit = 10000,
): Promise<QueryOk<R> | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit }),
    })
    return (await res.json()) as QueryOk<R> | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

const CUBE_MODEL_OPERATORS = ["cube_enrich", "propose_cube_draft", "propose_metric_draft"]
const CUBE_MODEL_SQL_LIST = CUBE_MODEL_OPERATORS.map(sqlStr).join(", ")

export type ModelScopeId = "semantic" | "cube"

export interface ModelUsage {
  model: string
  calls: number
  totalCostUsd: number
  lastAt: string | null
}

export interface ModelRate {
  model: string
  inputPerMtok: number | null
  outputPerMtok: number | null
  currency: string
  confidence: string | null
  source: string | null
}

export interface OperatorModelUsage {
  operator: string
  model: string | null
  calls: number
  totalCostUsd: number
  lastAt: string | null
}

export interface ScopeModelSetting {
  id: ModelScopeId
  label: string
  detail: string
  setter: string
  operatorNames: string[]
  operatorCount: number
  currentModel: string | null
  mixed: boolean
  distribution: Array<{ model: string; operators: number }>
  calls30d: number
  cost30d: number
}

export interface OperatorModelSetting {
  operator: string
  shape: string
  model: string
  scope: "cube" | "semantic" | "agent" | "pipeline" | "other"
  description: string | null
  stepModels: string[]
  inheritsCatalogModel: boolean
  explicitStepModels: boolean
  calls30d: number
  cost30d: number
  lastAt: string | null
}

export interface ModelSettingsBundle {
  models: LlmModel[]
  rates: ModelRate[]
  modelUsage: ModelUsage[]
  operatorUsage: OperatorModelUsage[]
  scopes: ScopeModelSetting[]
  operators: OperatorModelSetting[]
  errors: string[]
}

function steps(op: RvbbitOperator): OpStep[] {
  return Array.isArray(op.steps) ? op.steps : []
}

function hasStepKind(op: RvbbitOperator, kinds: string[]): boolean {
  return steps(op).some((s) => kinds.includes(s.kind))
}

function isSingleLlmOperator(op: RvbbitOperator): boolean {
  return op.steps == null
}

function isLlmCatalogOperator(op: RvbbitOperator): boolean {
  return isSingleLlmOperator(op) || hasStepKind(op, ["llm"])
}

function isModelBearingOperator(op: RvbbitOperator): boolean {
  return isLlmCatalogOperator(op) || hasStepKind(op, ["agent"])
}

function isCubeModelOperator(op: RvbbitOperator): boolean {
  return CUBE_MODEL_OPERATORS.includes(op.name)
}

function isSemanticScopeOperator(op: RvbbitOperator): boolean {
  return !isCubeModelOperator(op) && isLlmCatalogOperator(op)
}

function unique(arr: Array<string | undefined | null>): string[] {
  return [...new Set(arr.filter((s): s is string => !!s && s.trim().length > 0))]
}

function operatorStepModels(op: RvbbitOperator): string[] {
  return unique(
    steps(op)
      .filter((s) => s.kind === "llm" || s.kind === "agent")
      .map((s) => s.model),
  )
}

function operatorScope(op: RvbbitOperator): OperatorModelSetting["scope"] {
  if (isCubeModelOperator(op)) return "cube"
  if (hasStepKind(op, ["agent"])) return "agent"
  if (isSemanticScopeOperator(op)) return "semantic"
  if (op.steps != null) return "pipeline"
  return "other"
}

function distribution(ops: RvbbitOperator[]): Array<{ model: string; operators: number }> {
  const counts = new Map<string, number>()
  for (const op of ops) counts.set(op.model, (counts.get(op.model) ?? 0) + 1)
  return [...counts.entries()]
    .map(([model, operators]) => ({ model, operators }))
    .sort((a, b) => b.operators - a.operators || a.model.localeCompare(b.model))
}

function usageForOperators(
  usage: OperatorModelUsage[],
  names: Set<string>,
): { calls: number; cost: number } {
  let calls = 0
  let cost = 0
  for (const u of usage) {
    if (!names.has(u.operator)) continue
    calls += u.calls
    cost += u.totalCostUsd
  }
  return { calls, cost }
}

async function fetchModelUsage(connectionId: string): Promise<{ rows: ModelUsage[]; error?: string }> {
  const res = await runQuery<Record<string, unknown>>(
    connectionId,
    `SELECT r.model,
            count(*)::int AS calls,
            coalesce(sum(c.total_cost_usd), 0)::float8 AS total_cost_usd,
            max(r.invocation_at) AS last_at
       FROM rvbbit.receipts r
       LEFT JOIN rvbbit.receipt_costs c USING (receipt_id)
      WHERE r.invocation_at >= now() - interval '30 days'
        AND r.model IS NOT NULL
      GROUP BY r.model
      ORDER BY total_cost_usd DESC, calls DESC`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      model: String(r.model ?? ""),
      calls: Number(r.calls ?? 0),
      totalCostUsd: Number(r.total_cost_usd ?? 0),
      lastAt: r.last_at == null ? null : String(r.last_at),
    })),
  }
}

async function fetchOperatorUsage(
  connectionId: string,
): Promise<{ rows: OperatorModelUsage[]; error?: string }> {
  const res = await runQuery<Record<string, unknown>>(
    connectionId,
    `SELECT r.operator,
            r.model,
            count(*)::int AS calls,
            coalesce(sum(c.total_cost_usd), 0)::float8 AS total_cost_usd,
            max(r.invocation_at) AS last_at
       FROM rvbbit.receipts r
       LEFT JOIN rvbbit.receipt_costs c USING (receipt_id)
      WHERE r.invocation_at >= now() - interval '30 days'
      GROUP BY r.operator, r.model
      ORDER BY total_cost_usd DESC, calls DESC`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      operator: String(r.operator ?? ""),
      model: r.model == null ? null : String(r.model),
      calls: Number(r.calls ?? 0),
      totalCostUsd: Number(r.total_cost_usd ?? 0),
      lastAt: r.last_at == null ? null : String(r.last_at),
    })),
  }
}

async function fetchModelRates(connectionId: string): Promise<{ rows: ModelRate[]; error?: string }> {
  const res = await runQuery<Record<string, unknown>>(
    connectionId,
    `WITH provider_rates AS (
       SELECT model,
              input_per_mtok::float8 AS input_per_mtok,
              output_per_mtok::float8 AS output_per_mtok,
              currency,
              rate_confidence,
              rate_source,
              0 AS source_rank
         FROM rvbbit.provider_model_catalog
        WHERE available
          AND (rate_kind = 'standard' OR rate_kind IS NULL)
      ),
      compat_rates AS (
       SELECT model,
              input_per_mtok::float8 AS input_per_mtok,
              output_per_mtok::float8 AS output_per_mtok,
              currency,
              'manual'::text AS rate_confidence,
              'rvbbit.model_rates'::text AS rate_source,
              1 AS source_rank
         FROM rvbbit.model_rates
      ),
      ranked AS (
       SELECT *,
              row_number() OVER (
                PARTITION BY model
                ORDER BY (input_per_mtok IS NULL OR output_per_mtok IS NULL), source_rank
              ) AS rn
         FROM (
           SELECT * FROM provider_rates
           UNION ALL
           SELECT * FROM compat_rates
         ) r
      )
      SELECT model, input_per_mtok, output_per_mtok, currency, rate_confidence, rate_source
        FROM ranked
       WHERE rn = 1
       ORDER BY model`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      model: String(r.model ?? ""),
      inputPerMtok: r.input_per_mtok == null ? null : Number(r.input_per_mtok),
      outputPerMtok: r.output_per_mtok == null ? null : Number(r.output_per_mtok),
      currency: String(r.currency ?? "USD"),
      confidence: r.rate_confidence == null ? null : String(r.rate_confidence),
      source: r.rate_source == null ? null : String(r.rate_source),
    })),
  }
}

export async function fetchModelSettingsBundle(
  connectionId: string,
): Promise<ModelSettingsBundle> {
  const [modelsRes, opsRes, modelUsageRes, operatorUsageRes, ratesRes] = await Promise.all([
    fetchLlmModels(connectionId),
    fetchOperators(connectionId),
    fetchModelUsage(connectionId),
    fetchOperatorUsage(connectionId),
    fetchModelRates(connectionId),
  ])

  const errors = [
    modelsRes.error,
    opsRes.error,
    modelUsageRes.error,
    operatorUsageRes.error,
    ratesRes.error,
  ].filter((e): e is string => !!e)

  const operators = opsRes.operators.filter(isModelBearingOperator)
  const cubeOps = operators.filter(isCubeModelOperator)
  const semanticOps = operators.filter(isSemanticScopeOperator)
  const operatorUsageByName = new Map<string, OperatorModelUsage[]>()
  for (const row of operatorUsageRes.rows) {
    const arr = operatorUsageByName.get(row.operator) ?? []
    arr.push(row)
    operatorUsageByName.set(row.operator, arr)
  }

  const makeScope = (
    id: ModelScopeId,
    label: string,
    detail: string,
    setter: string,
    scopedOps: RvbbitOperator[],
  ): ScopeModelSetting => {
    const dist = distribution(scopedOps)
    const names = new Set(scopedOps.map((op) => op.name))
    const usage = usageForOperators(operatorUsageRes.rows, names)
    return {
      id,
      label,
      detail,
      setter,
      operatorNames: [...names].sort(),
      operatorCount: scopedOps.length,
      currentModel: dist.length === 1 ? dist[0].model : null,
      mixed: dist.length > 1,
      distribution: dist,
      calls30d: usage.calls,
      cost30d: usage.cost,
    }
  }

  return {
    models: modelsRes.models,
    rates: ratesRes.rows,
    modelUsage: modelUsageRes.rows,
    operatorUsage: operatorUsageRes.rows,
    scopes: [
      makeScope(
        "semantic",
        "General Semantic",
        "LLM operators outside cube and metric drafting",
        "rvbbit.set_semantic_model",
        semanticOps,
      ),
      makeScope(
        "cube",
        "Cube + Metric Drafting",
        "cube_enrich, propose_cube_draft, propose_metric_draft",
        "rvbbit.set_cube_model",
        cubeOps,
      ),
    ],
    operators: operators
      .map((op) => {
        const usage = operatorUsageByName.get(op.name) ?? []
        const stepModels = operatorStepModels(op)
        return {
          operator: op.name,
          shape: op.shape,
          model: op.model,
          scope: operatorScope(op),
          description: op.description,
          stepModels,
          inheritsCatalogModel: stepModels.length === 0 || stepModels.includes(op.model),
          explicitStepModels: stepModels.length > 0,
          calls30d: usage.reduce((sum, row) => sum + row.calls, 0),
          cost30d: usage.reduce((sum, row) => sum + row.totalCostUsd, 0),
          lastAt:
            usage
              .map((row) => row.lastAt)
              .filter((v): v is string => !!v)
              .sort()
              .at(-1) ?? null,
        }
      })
      .sort((a, b) => b.calls30d - a.calls30d || a.operator.localeCompare(b.operator)),
    errors,
  }
}

export async function saveScopeModel(
  connectionId: string,
  scope: ModelScopeId,
  model: string,
): Promise<{ changed: number; purged: number; error?: string }> {
  const v = sqlStr(model)
  const sql =
    scope === "semantic"
      ? `WITH affected AS MATERIALIZED (
             SELECT name
               FROM rvbbit.operators
              WHERE name NOT IN (${CUBE_MODEL_SQL_LIST})
                AND rvbbit._operator_is_llm(steps)
           ),
           changed AS (
             SELECT rvbbit.set_semantic_model(${v})::int AS changed
           )
           SELECT changed.changed::int AS changed,
                  coalesce((SELECT sum(rvbbit.judgment_purge(name))::bigint FROM affected), 0) AS purged
             FROM changed`
      : `WITH affected AS MATERIALIZED (
             SELECT name
               FROM rvbbit.operators
              WHERE name IN (${CUBE_MODEL_SQL_LIST})
           ),
           changed AS (
             SELECT rvbbit.set_cube_model(${v}) AS model
           )
           SELECT (SELECT count(*)::int FROM affected) AS changed,
                  coalesce((SELECT sum(rvbbit.judgment_purge(name))::bigint FROM affected), 0) AS purged
             FROM changed`

  const res = await runQuery<Record<string, unknown>>(connectionId, sql)
  if (!res.ok) return { changed: 0, purged: 0, error: res.error }
  return {
    changed: Number(res.rows[0]?.changed ?? 0),
    purged: Number(res.rows[0]?.purged ?? 0),
  }
}

export async function saveOperatorModel(
  connectionId: string,
  operator: string,
  model: string,
): Promise<{ changed: number; purged: number; error?: string }> {
  // Purge the operator's judgment cache in the same statement, exactly as the
  // scope save does — otherwise memoized outputs from the OLD model keep serving.
  const op = sqlStr(operator)
  const res = await runQuery<Record<string, unknown>>(
    connectionId,
    `WITH changed AS (
       SELECT rvbbit.set_operator_model(${op}, ${sqlStr(model)}) AS model
     )
     SELECT 1 AS changed,
            coalesce(rvbbit.judgment_purge(${op})::bigint, 0) AS purged
       FROM changed`,
  )
  if (!res.ok) return { changed: 0, purged: 0, error: res.error }
  return {
    changed: 1,
    purged: Number(res.rows[0]?.purged ?? 0),
  }
}
