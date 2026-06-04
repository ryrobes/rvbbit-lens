"use client"

/**
 * Model Studio data layer — SQL-native model train / evaluate / predict / observe.
 *
 * Thin SQL-first shims over the existing model lifecycle (rvbbit.ml_models /
 * ml_training_runs / ml_model_status / the auto-generated predict_<model>
 * operator) plus rvbbit.evaluate_model + rvbbit.ml_evaluations.
 * See docs/MODEL_STUDIO_PLAN.md. Mirrors lib/rvbbit/catalog-drift.ts.
 */

export interface FeatureSpec { name: string; type: string }

export interface MlModel {
  name: string
  task: string
  status: string
  operatorName: string | null
  targetColumn: string | null
  featureSchema: FeatureSpec[]
  metrics: Record<string, unknown>
  trainingOpts: Record<string, unknown>
  sourceSql: string | null
  backendName: string | null
  description: string | null
  trainedAt: number | null
  updatedAt: number | null
  latestRunStatus: string | null
  latestError: string | null
}

export interface MlRun {
  runId: string
  status: string
  worker: string | null
  error: string | null
  createdAt: number | null
  startedAt: number | null
  finishedAt: number | null
}

export interface MlEvaluation {
  evalId: string
  evalName: string | null
  status: string
  nRows: number | null
  metrics: Record<string, unknown>
  labelColumn: string | null
  evalSql: string
  error: string | null
  createdAt: number | null
}

export interface PredictionStats {
  nInvocations: number
  totalLatencyMs: number
  firstAt: number | null
  lastAt: number | null
}

export interface PredictionReceipt {
  receiptId: string
  inputs: unknown
  parsed: unknown
  output: string | null
  latencyMs: number | null
  error: string | null
  invocationAt: number | null
}

// ── plumbing ─────────────────────────────────────────────────────────

interface QueryOk { ok: true; columns: { name: string }[]; rows: Array<Record<string, unknown>> }
interface QueryErr { ok: false; error: string }

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

function num(v: unknown): number { return v == null ? 0 : Number(v) }
function numOrNull(v: unknown): number | null { return v == null ? null : Number(v) }
function strOrNull(v: unknown): string | null { return v == null ? null : String(v) }
function epoch(v: unknown): number | null { return v ? new Date(String(v)).getTime() : null }
function sqlStr(s: string): string { return `'${String(s).replace(/'/g, "''")}'` }
function quoteIdent(s: string): string { return `"${String(s).replace(/"/g, '""')}"` }
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function featArr(v: unknown): FeatureSpec[] {
  if (!Array.isArray(v)) return []
  return v.map((f) => {
    const o = obj(f)
    return { name: String(o.name ?? ""), type: String(o.type ?? "text") }
  })
}

// ── reads ────────────────────────────────────────────────────────────

export async function fetchModels(connectionId: string): Promise<{ models: MlModel[]; installed: boolean; error?: string }> {
  const probe = await runQuery(connectionId, `SELECT to_regclass('rvbbit.ml_models') IS NOT NULL AS ok`)
  if (!probe.ok || !probe.rows[0]?.ok) return { models: [], installed: false }
  const res = await runQuery(
    connectionId,
    `SELECT name, task, status, operator_name, target_column, feature_schema, metrics,
            training_opts, source_sql, backend_name, description, trained_at, updated_at,
            latest_run_status, latest_error
       FROM rvbbit.ml_model_status
      ORDER BY updated_at DESC NULLS LAST, name`,
  )
  if (!res.ok) return { models: [], installed: true, error: res.error }
  return {
    installed: true,
    models: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      task: String(r.task ?? ""),
      status: String(r.status ?? ""),
      operatorName: strOrNull(r.operator_name),
      targetColumn: strOrNull(r.target_column),
      featureSchema: featArr(r.feature_schema),
      metrics: obj(r.metrics),
      trainingOpts: obj(r.training_opts),
      sourceSql: strOrNull(r.source_sql),
      backendName: strOrNull(r.backend_name),
      description: strOrNull(r.description),
      trainedAt: epoch(r.trained_at),
      updatedAt: epoch(r.updated_at),
      latestRunStatus: strOrNull(r.latest_run_status),
      latestError: strOrNull(r.latest_error),
    })),
  }
}

export async function fetchRuns(connectionId: string, modelName: string): Promise<MlRun[]> {
  const res = await runQuery(
    connectionId,
    `SELECT run_id::text AS run_id, status, worker_id, error, created_at, started_at, finished_at
       FROM rvbbit.ml_training_runs WHERE model_name = ${sqlStr(modelName)}
      ORDER BY created_at DESC LIMIT 50`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: String(r.run_id ?? ""),
    status: String(r.status ?? ""),
    worker: strOrNull(r.worker_id),
    error: strOrNull(r.error),
    createdAt: epoch(r.created_at),
    startedAt: epoch(r.started_at),
    finishedAt: epoch(r.finished_at),
  }))
}

export async function fetchEvaluations(connectionId: string, modelName: string): Promise<MlEvaluation[]> {
  const res = await runQuery(
    connectionId,
    `SELECT eval_id::text AS eval_id, eval_name, status, n_rows, metrics, label_column,
            eval_sql, error, created_at
       FROM rvbbit.ml_evaluations WHERE model_name = ${sqlStr(modelName)}
      ORDER BY created_at DESC LIMIT 50`,
  )
  if (!res.ok) return []
  return res.rows.map(mapEval)
}

function mapEval(r: Record<string, unknown>): MlEvaluation {
  return {
    evalId: String(r.eval_id ?? ""),
    evalName: strOrNull(r.eval_name),
    status: String(r.status ?? ""),
    nRows: numOrNull(r.n_rows),
    metrics: obj(r.metrics),
    labelColumn: strOrNull(r.label_column),
    evalSql: String(r.eval_sql ?? ""),
    error: strOrNull(r.error),
    createdAt: epoch(r.created_at),
  }
}

// ── writes / actions ─────────────────────────────────────────────────

/** Run rvbbit.evaluate_model and return the recorded evaluation row. */
export async function runEvaluate(
  connectionId: string,
  modelName: string,
  evalSql: string,
  labelColumn: string | null,
  evalName: string | null,
): Promise<{ evaluation?: MlEvaluation; error?: string; sql: string }> {
  const sql = `SELECT rvbbit.evaluate_model(${sqlStr(modelName)}, ${sqlStr(evalSql)}, ${
    labelColumn ? sqlStr(labelColumn) : "NULL"
  }, ${evalName ? sqlStr(evalName) : "NULL"}) AS eval_id`
  const res = await runQuery(connectionId, sql, 1)
  if (!res.ok) return { error: res.error, sql }
  const evalId = String(res.rows[0]?.eval_id ?? "")
  const fetched = await runQuery(
    connectionId,
    `SELECT eval_id::text AS eval_id, eval_name, status, n_rows, metrics, label_column,
            eval_sql, error, created_at
       FROM rvbbit.ml_evaluations WHERE eval_id = ${sqlStr(evalId)}`,
  )
  if (!fetched.ok || fetched.rows.length === 0) return { error: "evaluation row not found", sql }
  return { evaluation: mapEval(fetched.rows[0]), sql }
}

export function trainModelSql(opts: {
  modelName: string
  sourceSql: string
  targetColumn: string
  task: string
  featureSchema: FeatureSpec[]
  trainingOpts: Record<string, unknown>
  description?: string | null
}): string {
  return `SELECT rvbbit.train_model(
  model_name => ${sqlStr(opts.modelName)},
  source_sql => ${sqlStr(opts.sourceSql)},
  target_column => ${sqlStr(opts.targetColumn)},
  task => ${sqlStr(opts.task)},
  feature_schema => ${sqlStr(JSON.stringify(opts.featureSchema))}::jsonb,
  training_opts => ${sqlStr(JSON.stringify(opts.trainingOpts))}::jsonb${
    opts.description ? `,\n  description => ${sqlStr(opts.description)}` : ""
  }
) AS run_id`
}

export async function trainModel(connectionId: string, opts: Parameters<typeof trainModelSql>[0]): Promise<{ runId?: string; error?: string; sql: string }> {
  const sql = trainModelSql(opts)
  const res = await runQuery(connectionId, sql, 1)
  if (!res.ok) return { error: res.error, sql }
  return { runId: String(res.rows[0]?.run_id ?? ""), sql }
}

export function predictSql(operatorName: string, row: Record<string, unknown>): string {
  return `SELECT rvbbit.${quoteIdent(operatorName)}(${sqlStr(JSON.stringify(row))}::jsonb) AS prediction`
}

export async function predictRow(
  connectionId: string,
  operatorName: string,
  row: Record<string, unknown>,
): Promise<{ prediction?: unknown; error?: string; sql: string }> {
  const sql = predictSql(operatorName, row)
  const res = await runQuery(connectionId, sql, 1)
  if (!res.ok) return { error: res.error, sql }
  return { prediction: res.rows[0]?.prediction ?? null, sql }
}

export async function fetchPredictionStats(connectionId: string, operatorName: string): Promise<PredictionStats | null> {
  const res = await runQuery(
    connectionId,
    `SELECT n_invocations, total_latency_ms, first_at, last_at
       FROM rvbbit.judgment_stats(${sqlStr(operatorName)})`,
  )
  if (!res.ok || res.rows.length === 0) return null
  const r = res.rows[0]
  return {
    nInvocations: num(r.n_invocations),
    totalLatencyMs: num(r.total_latency_ms),
    firstAt: epoch(r.first_at),
    lastAt: epoch(r.last_at),
  }
}

export async function fetchPredictionReceipts(connectionId: string, operatorName: string, limit = 25): Promise<PredictionReceipt[]> {
  const res = await runQuery(
    connectionId,
    `SELECT receipt_id::text AS receipt_id, inputs, parsed, output, latency_ms, error, invocation_at
       FROM rvbbit.receipts WHERE operator = ${sqlStr(operatorName)}
      ORDER BY invocation_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    receiptId: String(r.receipt_id ?? ""),
    inputs: r.inputs ?? null,
    parsed: r.parsed ?? null,
    output: strOrNull(r.output),
    latencyMs: numOrNull(r.latency_ms),
    error: strOrNull(r.error),
    invocationAt: epoch(r.invocation_at),
  }))
}

// ── orchestration: versions, monitoring, lifecycle ──────────────────

export interface MlVersion {
  runId: string
  versionNo: number
  status: string
  metrics: Record<string, unknown>
  artifactUri: string | null
  createdAt: number | null
  finishedAt: number | null
  isActive: boolean
}

export interface AccuracyPoint {
  evalId: string
  evalName: string | null
  createdAt: number | null
  nRows: number
  metricName: string
  metricValue: number | null
}

export async function fetchVersions(connectionId: string, modelName: string): Promise<MlVersion[]> {
  const res = await runQuery(
    connectionId,
    `SELECT run_id::text AS run_id, version_no, status, metrics, artifact_uri, created_at, finished_at, is_active
       FROM rvbbit.ml_model_versions WHERE model_name = ${sqlStr(modelName)}
      ORDER BY version_no DESC`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: String(r.run_id ?? ""),
    versionNo: num(r.version_no),
    status: String(r.status ?? ""),
    metrics: obj(r.metrics),
    artifactUri: strOrNull(r.artifact_uri),
    createdAt: epoch(r.created_at),
    finishedAt: epoch(r.finished_at),
    isActive: r.is_active === true,
  }))
}

export async function fetchAccuracySeries(connectionId: string, modelName: string): Promise<AccuracyPoint[]> {
  const res = await runQuery(
    connectionId,
    `SELECT eval_id::text AS eval_id, eval_name, created_at, n_rows, metric_name, metric_value
       FROM rvbbit.ml_accuracy_series(${sqlStr(modelName)})`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    evalId: String(r.eval_id ?? ""),
    evalName: strOrNull(r.eval_name),
    createdAt: epoch(r.created_at),
    nRows: num(r.n_rows),
    metricName: String(r.metric_name ?? ""),
    metricValue: numOrNull(r.metric_value),
  }))
}

async function callVoid(connectionId: string, sql: string): Promise<{ ok: boolean; error?: string }> {
  const res = await runQuery(connectionId, sql, 1)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export function setModelEnabled(connectionId: string, modelName: string, enabled: boolean) {
  const fn = enabled ? "enable_model" : "disable_model"
  return callVoid(connectionId, `SELECT rvbbit.${fn}(${sqlStr(modelName)})`)
}

export function dropModel(connectionId: string, modelName: string, dropOperator = false) {
  return callVoid(connectionId, `SELECT rvbbit.drop_model(${sqlStr(modelName)}, ${dropOperator ? "true" : "false"})`)
}

export const ML_TASKS = [
  "classification", "regression", "tabular_classification", "tabular_regression",
  "forecasting", "anomaly", "survival", "causal", "embedding", "rerank", "custom",
] as const
