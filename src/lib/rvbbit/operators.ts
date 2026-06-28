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

/** The node-kind primitives — peers, each `inputs → output`. */
export type NodeKind = "llm" | "specialist" | "python" | "code" | "sql" | "mcp" | "agent"

/**
 * A tool an `agent` node may call: the built-in read-only `query` tool, or an
 * allow-listed MCP tool (a `rvbbit.mcp_tools` row addressed by server + tool).
 */
export type AgentToolRef = { builtin: "query" } | { server: string; tool: string }

/** Termination budget for an `agent` loop — first cap to trip ends it. */
export interface AgentBudget {
  tokens?: number
  cost_usd?: number
  wall_ms?: number
}

export interface AgentMemoryConfig {
  enabled?: boolean
  provider?: "hindsight"
  service?: string
  context?: string
  required?: boolean
  allow_tools?: boolean
  recall_before_run?: boolean
  retain_final?: boolean
  async_retain?: boolean
  limit?: number
  max_chars?: number
  recall_options?: Record<string, unknown>
  retain_options?: Record<string, unknown>
}

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
  // agent — a bounded tool-calling loop (kind:"agent"). `model` + `system`
  // are reused from above; `task` is the user turn; the loop calls `tools`,
  // feeds results back, and stops on no-tool-call or a `budget`/max_iters cap.
  task?: string
  tools?: AgentToolRef[]
  /** Optional long-term memory capability for the agent loop. `true` means
   * Hindsight with scoped defaults; object form tunes service/context/fallbacks. */
  memory?: boolean | AgentMemoryConfig
  max_iters?: number
  budget?: AgentBudget
  tool_result_max_chars?: number
  // specialist / python / code / mcp — templated input mapping
  inputs?: Record<string, string>
}

/** True if any step is an agent loop — such operators must NOT be cached
 * (a memoized agent replays a frozen transcript instead of re-inspecting
 * live state), so the save path forces cache_policy='never'. */
export function hasAgentStep(steps: OpStep[] | null): boolean {
  return !!steps?.some((s) => s.kind === "agent")
}

/**
 * Convert operator-context templates ({{ arg }}) to step-context
 * ({{ inputs.arg }}) — used when materializing the single-LLM prompt as a
 * pipeline step, since steps reference args via `inputs.`.
 */
export function toStepTemplate(text: string, argNames: string[]): string {
  let out = text
  for (const a of argNames) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out.replace(new RegExp(`\\{\\{\\s*${esc}\\s*\\}\\}`, "g"), `{{ inputs.${a} }}`)
  }
  return out
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
    case "agent":
      return {
        name,
        kind,
        model: "openai/gpt-5.4-mini",
        system:
          "You are a helpful analyst. Use the `query` tool (read-only SQL) to gather what you need, then answer. Stop calling tools once you can answer.",
        task: "{{ inputs.text }}",
        tools: [{ builtin: "query" }],
        max_iters: 8,
        budget: { cost_usd: 0.5, wall_ms: 120000 },
        tool_result_max_chars: 8000,
      }
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

export interface MemoryService {
  name: string
  provider: string
  status: string
  endpoint_url: string | null
}

// ── The operator row ────────────────────────────────────────────────

export type OperatorShape = "scalar" | "aggregate" | "dimension" | "rowset" | "query"
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
    // Start as a real one-step pipeline so the canvas opens with an actual,
    // editable/deletable node wired to the input — not a phantom exec block.
    steps: [
      {
        name: "node1",
        kind: "llm",
        model: "anthropic/claude-haiku-4.5",
        system: "",
        user: "{{ inputs.text }}",
      },
    ],
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

export async function fetchMemoryServices(
  connectionId: string,
): Promise<{ services: MemoryService[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT name, provider, status, endpoint_url
       FROM rvbbit.memory_services
      WHERE provider = 'hindsight'
      ORDER BY (status = 'ready') DESC, name`,
  )
  if (!res.ok) {
    if (/relation .*memory_services.* does not exist|does not exist/i.test(res.error)) {
      return { services: [] }
    }
    return { services: [], error: res.error }
  }
  return {
    services: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      provider: String(r.provider ?? ""),
      status: String(r.status ?? ""),
      endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    })),
  }
}

const RECEIPT_COLUMNS =
  "receipt_id::text AS receipt_id, operator, inputs, output, error, model, " +
  "n_tokens_in, n_tokens_out, cost_usd, latency_ms, sub_calls, " +
  "query_id::text AS query_id, invocation_at"

function coerceReceipt(r: Record<string, unknown>, operatorName = ""): OperatorReceipt {
  return {
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
  }
}

export async function fetchReceipts(
  connectionId: string,
  operatorName: string,
  limit = 40,
): Promise<{ receipts: OperatorReceipt[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${RECEIPT_COLUMNS} ` +
      `FROM rvbbit.receipts WHERE operator = ${sqlStr(operatorName)} ` +
      `ORDER BY invocation_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  )
  if (!res.ok) return { receipts: [], error: res.error }
  return { receipts: res.rows.map((r) => coerceReceipt(r, operatorName)) }
}

export async function fetchReceiptById(
  connectionId: string,
  receiptId: string,
): Promise<{ receipt: OperatorReceipt | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${RECEIPT_COLUMNS} FROM rvbbit.receipts ` +
      `WHERE receipt_id = ${sqlStr(receiptId)}::uuid LIMIT 1`,
  )
  if (!res.ok) return { receipt: null, error: res.error }
  return { receipt: res.rows[0] ? coerceReceipt(res.rows[0]) : null }
}

// ── Paginated / filtered history (the executions shelf) ──────────────

export type ReceiptStatusFilter = "all" | "ok" | "error"

export interface ReceiptPageOpts {
  status?: ReceiptStatusFilter
  /** null = all time; otherwise restrict to the last N hours. */
  windowHours?: number | null
  /** ILIKE over inputs / output / error text. */
  search?: string
  /** Keyset cursor: invocation_at of the last row of the previous page. */
  before?: string | null
  limit?: number
}

/** `\`, `%` and `_` are LIKE metacharacters — neutralize them so a raw
 *  search string matches literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function receiptWhere(operatorName: string, opts: ReceiptPageOpts): string {
  const clauses = [`operator = ${sqlStr(operatorName)}`]
  if (opts.status === "ok") clauses.push("error IS NULL")
  else if (opts.status === "error") clauses.push("error IS NOT NULL")
  if (opts.windowHours != null && opts.windowHours > 0) {
    clauses.push(`invocation_at > now() - interval '${Math.floor(opts.windowHours)} hours'`)
  }
  const q = (opts.search ?? "").trim()
  if (q.length > 0) {
    const like = sqlStr(`%${escapeLike(q)}%`)
    clauses.push(
      `(inputs::text ILIKE ${like} OR coalesce(output, '') ILIKE ${like} ` +
        `OR coalesce(error, '') ILIKE ${like})`,
    )
  }
  return clauses.join(" AND ")
}

/**
 * One page of executions for the history shelf. Keyset-paginated on
 * `invocation_at` (matching the `(operator, invocation_at)` index) so it
 * stays fast across thousands of runs. `nextCursor` is null at the end.
 */
export async function fetchReceiptsPage(
  connectionId: string,
  operatorName: string,
  opts: ReceiptPageOpts = {},
): Promise<{ receipts: OperatorReceipt[]; nextCursor: string | null; error?: string }> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const where = receiptWhere(operatorName, opts)
  const cursor =
    opts.before && opts.before.length > 0
      ? ` AND invocation_at < ${sqlStr(opts.before)}::timestamptz`
      : ""
  const res = await runQuery(
    connectionId,
    `SELECT ${RECEIPT_COLUMNS} FROM rvbbit.receipts WHERE ${where}${cursor} ` +
      `ORDER BY invocation_at DESC LIMIT ${limit + 1}`,
  )
  if (!res.ok) return { receipts: [], nextCursor: null, error: res.error }
  const rows = res.rows.map((r) => coerceReceipt(r, operatorName))
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    receipts: page,
    nextCursor: hasMore ? page[page.length - 1].invocation_at : null,
  }
}

/** Total matching the current filters — drives the shelf's "N runs" count. */
export async function fetchReceiptCount(
  connectionId: string,
  operatorName: string,
  opts: ReceiptPageOpts = {},
): Promise<number> {
  const res = await runQuery(
    connectionId,
    `SELECT count(*)::bigint AS n FROM rvbbit.receipts ` +
      `WHERE ${receiptWhere(operatorName, opts)}`,
  )
  if (!res.ok || res.rows.length === 0) return 0
  return Number(res.rows[0].n ?? 0)
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

// ── LLM model catalog (for the builder's model picker) ──────────────
//
// rvbbit.provider_models is the canonical list of usable chat models —
// cloud providers AND Warren-hosted local LLMs, which the warren agent
// registers via rvbbit.register_self_hosted_model (auth_state='configured',
// raw.kind='self_hosted'). So one catalog covers both; the target string is
// just `provider/model`.

export interface LlmModel {
  provider: string
  model: string
  displayName: string | null
  /** Registered from a Warren / local vLLM rather than a cloud provider. */
  selfHosted: boolean
}

export async function fetchLlmModels(
  connectionId: string,
): Promise<{ models: LlmModel[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT pm.provider, pm.model, pm.display_name, " +
      "(coalesce(pc.raw->>'kind', '') = 'self_hosted') AS self_hosted " +
      "FROM rvbbit.provider_models pm " +
      "JOIN rvbbit.provider_catalog pc ON pc.provider = pm.provider " +
      "WHERE pm.available AND pc.auth_state IN ('configured', 'public') " +
      "ORDER BY self_hosted DESC, pm.provider, pm.model",
  )
  if (!res.ok) return { models: [], error: res.error }
  return {
    models: res.rows.map((r) => ({
      provider: String(r.provider ?? ""),
      model: String(r.model ?? ""),
      displayName: r.display_name == null ? null : String(r.display_name),
      selfHosted: r.self_hosted === true || r.self_hosted === "t",
    })),
  }
}

// ── Python runtime metadata (for the builder's env/handler pickers) ──

export interface PythonEnv {
  name: string
  status: string
  pythonVersion: string | null
}

export interface PythonHandler {
  name: string
  env: string
  entrypoint: string | null
  description: string | null
}

export async function fetchPythonEnvs(
  connectionId: string,
): Promise<{ envs: PythonEnv[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT name, status, python_version FROM rvbbit.python_envs ORDER BY name",
  )
  if (!res.ok) return { envs: [], error: res.error }
  return {
    envs: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      status: String(r.status ?? ""),
      pythonVersion: r.python_version == null ? null : String(r.python_version),
    })),
  }
}

export async function fetchPythonHandlers(
  connectionId: string,
): Promise<{ handlers: PythonHandler[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT name, env_name, entrypoint, description FROM rvbbit.python_handlers ORDER BY name",
  )
  if (!res.ok) return { handlers: [], error: res.error }
  return {
    handlers: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      env: String(r.env_name ?? ""),
      entrypoint: r.entrypoint == null ? null : String(r.entrypoint),
      description: r.description == null ? null : String(r.description),
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
 * SQL to persist an operator. `create` routes through create_operator
 * (an upsert that also (re)builds the typed wrapper) — used for new
 * operators AND whenever an existing operator's signature changes, since
 * the wrapper function has to be regenerated. Non-signature edits take
 * the lighter in-place UPDATE. Flow control is always (re)applied via the
 * set_operator_* helpers, then the cache is purged so retry/wards/takes
 * edits take effect on already-seen inputs.
 *
 * Note: changing arg count/types leaves the previous wrapper overload as
 * a harmless orphan (create_operator's CREATE OR REPLACE only replaces a
 * matching signature). New calls resolve to the new signature.
 */
export function buildSaveSql(op: RvbbitOperator, opts: { create: boolean }): string {
  const stmts: string[] = []

  if (opts.create) {
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
      // Preserve infix/tests on recreate (create_operator defaults them to
      // NULL, which would otherwise wipe them for an existing operator).
      `op_infix_symbol => ${sqlStrOrNull(op.infix_symbol)}`,
      `op_tests => ${sqlJsonbOrNull(op.tests)}`,
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

  // Agent operators must bypass the result cache (a memoized agent would
  // replay a frozen transcript); plain operators stay memoized. create_operator
  // leaves cache_policy at its default, so set it explicitly on every save.
  stmts.push(
    `UPDATE rvbbit.operators SET cache_policy = ${sqlStr(hasAgentStep(op.steps) ? "never" : "memoize")} WHERE name = ${sqlStr(op.name)}`,
  )

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

/** Persist an operator; returns an error string on failure. `create`
 *  regenerates the wrapper (new operator or a changed signature). */
export async function saveOperator(
  connectionId: string,
  op: RvbbitOperator,
  opts: { create: boolean },
): Promise<{ error?: string }> {
  const res = await runQuery(connectionId, buildSaveSql(op, opts))
  return res.ok ? {} : { error: res.error }
}

/** Whether two operators differ in their SQL signature (which forces a
 *  wrapper rebuild via create_operator). */
export function signatureChanged(a: RvbbitOperator, b: RvbbitOperator): boolean {
  const eqArr = (x: string[], y: string[]) =>
    x.length === y.length && x.every((v, i) => v === y[i])
  return (
    !eqArr(a.arg_names, b.arg_names) ||
    !eqArr(a.arg_types, b.arg_types) ||
    a.return_type !== b.return_type ||
    a.shape !== b.shape
  )
}
