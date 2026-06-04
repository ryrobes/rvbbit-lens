"use client"

/**
 * Client-side model for rvbbit semantic operators.
 *
 * Operators are rows in `rvbbit.operators`; runs land in
 * `rvbbit.receipts`. Everything is plain SQL — this module just shapes
 * the rows into types, generates the management SQL (create_operator /
 * UPDATE / set_operator_* / judgment_purge), and runs it through the
 * existing /api/db/query endpoint. See rvbbit's docs/OPERATORS.md.
 */

// ── Flow-control primitives ─────────────────────────────────────────

/** A validator: inline SQL, a Postgres function, or shorthand fn name. */
export type Validator = { sql: string } | { function: string } | string

export interface RetryPlan {
  until: Validator
  max_attempts?: number
  instructions?: string
}

export interface Ward {
  validator: Validator
  mode?: "blocking" | "advisory"
}

export interface WardsPlan {
  pre?: Ward[]
  post?: Ward[]
}

export interface TakesPlan {
  /** homogeneous mode — re-run the operator this many times */
  factor?: number
  models?: string[]
  /** heterogeneous mode — an explicit list of nodes, each its own engine */
  nodes?: OpStep[]
  reduce?: "vote" | "first_valid" | "evaluator"
  filter?: Validator
  evaluator?: { model?: string; instructions?: string }
}

/** The six node-kind primitives — peers, each `inputs → output`. */
export type NodeKind = "llm" | "specialist" | "python" | "code" | "sql" | "mcp"

export interface OpStep {
  name: string
  kind: NodeKind
  // llm
  model?: string
  system?: string
  user?: string
  max_tokens?: number
  temperature?: number
  // code — a built-in deterministic function
  fn?: string
  // specialist — names a registered model backend
  specialist?: string
  // python — a managed CPython handler (rvbbit.python_handlers) in an
  // env (rvbbit.python_envs); see OPERATORS.md §16.
  env?: string
  handler?: string
  timeout_ms?: number
  // mcp — references rvbbit.mcp_servers / rvbbit.mcp_tools
  server?: string
  tool?: string
  // sql
  sql?: string
  params?: string[]
  // specialist / python / code / mcp — templated input mapping
  inputs?: Record<string, string>
}

/** A fresh node of the given kind, for the builder's "add node". */
export function defaultNode(kind: NodeKind, name: string): OpStep {
  switch (kind) {
    case "llm":
      return { name, kind, model: "anthropic/claude-haiku-4.5", system: "", user: "{{ inputs.text }}" }
    case "code":
      return { name, kind, fn: "trim", inputs: { text: "{{ inputs.text }}" } }
    case "specialist":
      return { name, kind, specialist: "", inputs: { text: "{{ inputs.text }}" } }
    case "python":
      return { name, kind, env: "", handler: "", inputs: { text: "{{ inputs.text }}" }, timeout_ms: 1000 }
    case "sql":
      return { name, kind, sql: "SELECT 1 AS value", params: [] }
    case "mcp":
      return { name, kind, server: "", tool: "", inputs: {} }
  }
}

/** A registered model backend — a row in rvbbit.backends. */
export interface RvbbitSpecialist {
  name: string
  transport: string
  endpoint_url: string
  batch_size: number
  max_concurrent: number
  timeout_ms: number
  description: string | null
  transport_opts: Record<string, unknown> | null
}

// ── The operator row ────────────────────────────────────────────────

export type OperatorShape = "scalar" | "aggregate" | "dimension" | "rowset"
export type OperatorReturn = "bool" | "text" | "float8" | "jsonb"

export interface RvbbitOperator {
  name: string
  shape: OperatorShape
  arg_names: string[]
  arg_types: string[]
  return_type: string
  model: string
  system_prompt: string
  user_prompt: string
  parser: string
  max_tokens: number
  temperature: number | null
  steps: OpStep[] | null
  retry: RetryPlan | null
  wards: WardsPlan | null
  takes: TakesPlan | null
  description: string | null
  tests: unknown[] | null
  infix_symbol: string | null
  created_at?: string
  updated_at?: string
}

/** A blank operator for the "new operator" builder. */
export function emptyOperator(): RvbbitOperator {
  return {
    name: "",
    shape: "scalar",
    arg_names: ["text"],
    arg_types: ["text"],
    return_type: "text",
    model: "anthropic/claude-haiku-4.5",
    system_prompt: "",
    user_prompt: "{{ text }}",
    parser: "strip",
    max_tokens: 256,
    temperature: null,
    steps: null,
    retry: null,
    wards: null,
    takes: null,
    description: null,
    tests: null,
    infix_symbol: null,
  }
}

// ── Receipts ────────────────────────────────────────────────────────

export interface SubCall {
  step: string
  kind: string
  model?: string
  tokens_in?: number
  tokens_out?: number
  latency_ms?: number
  error?: string | null
}

export interface OperatorReceipt {
  receipt_id: string
  operator: string
  inputs: Record<string, unknown> | null
  output: string | null
  error: string | null
  model: string | null
  n_tokens_in: number
  n_tokens_out: number
  cost_usd: number | null
  latency_ms: number
  sub_calls: SubCall[] | null
  query_id: string | null
  invocation_at: string
}

// ── Fetch helpers ───────────────────────────────────────────────────

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

const OPERATOR_COLUMNS =
  "name, shape, arg_names, arg_types, return_type, model, system_prompt, " +
  "user_prompt, parser, max_tokens, temperature, steps, retry, wards, takes, " +
  "description, tests, infix_symbol, created_at, updated_at"

function coerceOperator(row: Record<string, unknown>): RvbbitOperator {
  return {
    name: String(row.name ?? ""),
    shape: (row.shape as OperatorShape) ?? "scalar",
    arg_names: Array.isArray(row.arg_names) ? (row.arg_names as string[]) : [],
    arg_types: Array.isArray(row.arg_types) ? (row.arg_types as string[]) : [],
    return_type: String(row.return_type ?? "text"),
    model: String(row.model ?? ""),
    system_prompt: String(row.system_prompt ?? ""),
    user_prompt: String(row.user_prompt ?? ""),
    parser: String(row.parser ?? "strip"),
    max_tokens: Number(row.max_tokens ?? 256),
    temperature: row.temperature == null ? null : Number(row.temperature),
    steps: (row.steps as OpStep[] | null) ?? null,
    retry: (row.retry as RetryPlan | null) ?? null,
    wards: (row.wards as WardsPlan | null) ?? null,
    takes: (row.takes as TakesPlan | null) ?? null,
    description: row.description == null ? null : String(row.description),
    tests: (row.tests as unknown[] | null) ?? null,
    infix_symbol: row.infix_symbol == null ? null : String(row.infix_symbol),
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  }
}

export async function fetchOperators(
  connectionId: string,
): Promise<{ operators: RvbbitOperator[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${OPERATOR_COLUMNS} FROM rvbbit.operators ORDER BY name`,
  )
  if (!res.ok) return { operators: [], error: res.error }
  return { operators: res.rows.map(coerceOperator) }
}

export async function fetchReceipts(
  connectionId: string,
  operatorName: string,
  limit = 40,
): Promise<{ receipts: OperatorReceipt[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT receipt_id::text AS receipt_id, operator, inputs, output, error, model, ` +
      `n_tokens_in, n_tokens_out, cost_usd, latency_ms, sub_calls, ` +
      `query_id::text AS query_id, invocation_at ` +
      `FROM rvbbit.receipts WHERE operator = ${sqlStr(operatorName)} ` +
      `ORDER BY invocation_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  )
  if (!res.ok) return { receipts: [], error: res.error }
  return {
    receipts: res.rows.map((r) => ({
      receipt_id: String(r.receipt_id ?? ""),
      operator: String(r.operator ?? operatorName),
      inputs: (r.inputs as Record<string, unknown> | null) ?? null,
      output: r.output == null ? null : String(r.output),
      error: r.error == null ? null : String(r.error),
      model: r.model == null ? null : String(r.model),
      n_tokens_in: Number(r.n_tokens_in ?? 0),
      n_tokens_out: Number(r.n_tokens_out ?? 0),
      cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      latency_ms: Number(r.latency_ms ?? 0),
      sub_calls: (r.sub_calls as SubCall[] | null) ?? null,
      query_id: r.query_id == null ? null : String(r.query_id),
      invocation_at: String(r.invocation_at ?? ""),
    })),
  }
}

/**
 * Per-operator rollup for the registry list view. Aggregates the recent
 * receipt log with a single GROUP BY so the operators window can sort
 * busiest-first and surface traffic chips without re-fetching per-row.
 *
 * Window is the last 24h by default — matches the "is this thing
 * live?" question the list view answers. `lookback_hours` lets the
 * caller widen it if needed.
 */
export interface OperatorTraffic {
  operator: string
  n_calls: number
  n_errors: number
  avg_latency_ms: number
  p95_latency_ms: number
  last_at: number | null
}

export async function fetchOperatorTraffic(
  connectionId: string,
  lookback_hours = 24,
): Promise<{ rows: OperatorTraffic[]; error?: string }> {
  const hours = Math.max(1, Math.min(720, lookback_hours))
  const res = await runQuery(
    connectionId,
    `SELECT
       operator,
       count(*)::int AS n_calls,
       count(*) FILTER (WHERE error IS NOT NULL)::int AS n_errors,
       coalesce(avg(latency_ms), 0)::int AS avg_latency_ms,
       coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
       max(invocation_at) AS last_at
     FROM rvbbit.receipts
     WHERE invocation_at > now() - interval '${hours} hours'
     GROUP BY operator`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      operator: String(r.operator ?? ""),
      n_calls: Number(r.n_calls ?? 0),
      n_errors: Number(r.n_errors ?? 0),
      avg_latency_ms: Number(r.avg_latency_ms ?? 0),
      p95_latency_ms: Number(r.p95_latency_ms ?? 0),
      last_at: r.last_at ? new Date(String(r.last_at)).getTime() : null,
    })),
  }
}

export async function fetchSpecialists(
  connectionId: string,
): Promise<{ specialists: RvbbitSpecialist[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT name, transport, endpoint_url, batch_size, max_concurrent, " +
      "timeout_ms, description, transport_opts FROM rvbbit.backends ORDER BY name",
  )
  if (!res.ok) return { specialists: [], error: res.error }
  return {
    specialists: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      transport: String(r.transport ?? ""),
      endpoint_url: String(r.endpoint_url ?? ""),
      batch_size: Number(r.batch_size ?? 0),
      max_concurrent: Number(r.max_concurrent ?? 0),
      timeout_ms: Number(r.timeout_ms ?? 0),
      description: r.description == null ? null : String(r.description),
      transport_opts: (r.transport_opts as Record<string, unknown> | null) ?? null,
    })),
  }
}

/** Call the operator for real (one billable run). Returns the raw output. */
export async function runOperator(
  connectionId: string,
  op: RvbbitOperator,
  argValues: string[],
): Promise<{ output: string | null; error?: string }> {
  const args = argValues.map((v) => sqlStr(v)).join(", ")
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.${quoteIdent(op.name)}(${args}) AS result`,
  )
  if (!res.ok) return { output: null, error: res.error }
  const val = res.rows[0]?.result
  return { output: val == null ? null : String(val) }
}

// ── SQL generation ──────────────────────────────────────────────────

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function sqlStrOrNull(s: string | null | undefined): string {
  return s == null || s === "" ? "NULL" : sqlStr(s)
}
function sqlTextArray(arr: string[]): string {
  return `ARRAY[${arr.map(sqlStr).join(", ")}]::text[]`
}
function sqlJsonbOrNull(obj: unknown): string {
  return obj == null ? "NULL" : `${sqlStr(JSON.stringify(obj))}::jsonb`
}
function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

/**
 * SQL to persist an operator. New operators go through create_operator
 * (which also builds the typed wrapper); existing ones are UPDATEd in
 * place (signature is immutable in the editor). Flow control is always
 * (re)applied via the set_operator_* helpers, then the cache is purged
 * so retry/wards/takes edits take effect on already-seen inputs.
 */
export function buildSaveSql(op: RvbbitOperator, isNew: boolean): string {
  const stmts: string[] = []

  if (isNew) {
    const args: string[] = [
      `op_name => ${sqlStr(op.name)}`,
      `op_arg_names => ${sqlTextArray(op.arg_names)}`,
      `op_arg_types => ${sqlTextArray(op.arg_types)}`,
      `op_return_type => ${sqlStr(op.return_type)}`,
      `op_system => ${sqlStr(op.system_prompt)}`,
      `op_user => ${sqlStr(op.user_prompt)}`,
      `op_shape => ${sqlStr(op.shape)}`,
      `op_model => ${sqlStr(op.model)}`,
      `op_parser => ${sqlStr(op.parser)}`,
      `op_max_tokens => ${op.max_tokens}`,
      `op_temperature => ${op.temperature == null ? "NULL" : op.temperature}`,
      `op_description => ${sqlStrOrNull(op.description)}`,
      `op_steps => ${sqlJsonbOrNull(op.steps)}`,
    ]
    stmts.push(`SELECT rvbbit.create_operator(\n  ${args.join(",\n  ")}\n)`)
  } else {
    const sets: string[] = [
      `system_prompt = ${sqlStr(op.system_prompt)}`,
      `user_prompt = ${sqlStr(op.user_prompt)}`,
      `model = ${sqlStr(op.model)}`,
      `parser = ${sqlStr(op.parser)}`,
      `max_tokens = ${op.max_tokens}`,
      `temperature = ${op.temperature == null ? "NULL" : op.temperature}`,
      `steps = ${sqlJsonbOrNull(op.steps)}`,
      `description = ${sqlStrOrNull(op.description)}`,
    ]
    stmts.push(`UPDATE rvbbit.operators SET ${sets.join(", ")} WHERE name = ${sqlStr(op.name)}`)
  }

  stmts.push(`SELECT rvbbit.set_operator_retry(${sqlStr(op.name)}, ${sqlJsonbOrNull(op.retry)})`)
  stmts.push(`SELECT rvbbit.set_operator_wards(${sqlStr(op.name)}, ${sqlJsonbOrNull(op.wards)})`)
  stmts.push(`SELECT rvbbit.set_operator_takes(${sqlStr(op.name)}, ${sqlJsonbOrNull(op.takes)})`)
  stmts.push(`SELECT rvbbit.judgment_purge(${sqlStr(op.name)})`)

  return stmts.join(";\n")
}

/** SQL to delete an operator and drop its wrapper function. */
export function buildDeleteSql(op: RvbbitOperator): string {
  const argSig = [...op.arg_types, "jsonb"].join(", ")
  return (
    `DELETE FROM rvbbit.operators WHERE name = ${sqlStr(op.name)};\n` +
    `DROP FUNCTION IF EXISTS rvbbit.${quoteIdent(op.name)}(${argSig})`
  )
}

/** Persist an operator; returns an error string on failure. */
export async function saveOperator(
  connectionId: string,
  op: RvbbitOperator,
  isNew: boolean,
): Promise<{ error?: string }> {
  const res = await runQuery(connectionId, buildSaveSql(op, isNew))
  return res.ok ? {} : { error: res.error }
}
