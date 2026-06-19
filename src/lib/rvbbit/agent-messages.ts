/**
 * Data layer for the agent **Messages** app — a viewer over
 * `rvbbit.agent_messages`, the per-turn transcript of `kind:"agent"` operator
 * runs (see OPERATORS.md / the agent-loop primitive). One **run** = one agent
 * call (a `run_id`); the list rolls runs up with their cost/tokens, and the
 * transcript drills into the turns.
 */

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

/** Terminal state of a run, derived from the transcript (agent_messages has no
 *  explicit status column in v0). */
export type AgentRunStatus = "done" | "capped" | "error" | "running"

export interface AgentRunMessageHeat {
  turnIdx: number
  role: string
  tokens: number
  error: boolean
  toolName: string | null
}

/** One rolled-up agent run (a `run_id`). */
export interface AgentRun {
  runId: string
  operator: string | null
  model: string | null
  startedAt: string
  endedAt: string
  turns: number
  toolCalls: number
  /** Tool turns that returned an error the agent then recovered from. A
   *  non-fatal signal (the loop kept going) — NOT a run failure. */
  toolErrors: number
  tokensIn: number
  tokensOut: number
  costUsd: number | null
  status: AgentRunStatus
  task: string | null
  messageHeat: AgentRunMessageHeat[]
}

/** One transcript turn. */
export interface AgentTurn {
  turnIdx: number
  role: string
  content: string | null
  toolName: string | null
  toolCalls: unknown
  finishReason: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number | null
  latencyMs: number
  error: string | null
  createdAt: string
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function arrayVal(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * A run is "error" only if the LOOP itself broke — run_step_agent writes a
 * `role='error'` turn when the model call fails. Tool turns that errored (bad
 * SQL the agent then corrected) are recovered, NOT a run failure. So derive
 * from the loop-level error + how the last assistant turn finished.
 */
function deriveStatus(runErrored: boolean, lastFinish: string | null): AgentRunStatus {
  if (runErrored) return "error"
  if (lastFinish === "stop" || lastFinish === "end_turn") return "done"
  // No terminal answer (hit max_iters / a budget cap mid-loop).
  return "capped"
}

/** List runs rolled up by run_id, newest first. */
export async function fetchAgentRuns(
  connectionId: string,
  opts: { limit?: number; operator?: string | null } = {},
): Promise<{ runs: AgentRun[]; error?: string }> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const where = opts.operator ? `WHERE operator = ${sqlStr(opts.operator)}` : ""
  const sql = `
    SELECT run_id::text AS run_id,
           max(operator)                                              AS operator,
           max(model)                                                 AS model,
           min(created_at)                                            AS started_at,
           max(created_at)                                            AS ended_at,
           count(*)                                                   AS turns,
           count(*) FILTER (WHERE role = 'tool')                      AS tool_calls,
           count(*) FILTER (WHERE role = 'tool' AND error IS NOT NULL) AS tool_errors,
           coalesce(sum(tokens_in), 0)                                AS tokens_in,
           coalesce(sum(tokens_out), 0)                               AS tokens_out,
           sum(cost_usd)                                              AS cost_usd,
           bool_or(role = 'error')                                    AS run_errored,
           (array_agg(content ORDER BY turn_idx)
              FILTER (WHERE role = 'user'))[1]                        AS task,
           (array_agg(finish_reason ORDER BY turn_idx DESC)
              FILTER (WHERE role = 'assistant'
                        AND finish_reason IS NOT NULL))[1]            AS last_finish,
           jsonb_agg(
             jsonb_build_object(
               'turnIdx', turn_idx,
               'role', role,
               'tokens', coalesce(tokens_in, 0) + coalesce(tokens_out, 0),
               'error', error IS NOT NULL OR role = 'error',
               'toolName', tool_name
             )
             ORDER BY turn_idx
           )                                                           AS message_heat
      FROM rvbbit.agent_messages
      ${where}
     GROUP BY run_id
     ORDER BY started_at DESC
     LIMIT ${limit}`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { runs: [], error: res.error }
  const runs: AgentRun[] = res.rows.map((r) => ({
    runId: String(r.run_id ?? ""),
    operator: strOrNull(r.operator),
    model: strOrNull(r.model),
    startedAt: String(r.started_at ?? ""),
    endedAt: String(r.ended_at ?? ""),
    turns: num(r.turns),
    toolCalls: num(r.tool_calls),
    toolErrors: num(r.tool_errors),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    costUsd: numOrNull(r.cost_usd),
    status: deriveStatus(r.run_errored === true, strOrNull(r.last_finish)),
    task: strOrNull(r.task),
    messageHeat: arrayVal(r.message_heat).map((m) => {
      const row = m as Record<string, unknown>
      return {
        turnIdx: num(row.turnIdx ?? row.turnidx),
        role: String(row.role ?? ""),
        tokens: num(row.tokens),
        error: row.error === true,
        toolName: strOrNull(row.toolName ?? row.toolname),
      }
    }),
  }))
  return { runs }
}

/** The full transcript of one run, ordered by turn. */
export async function fetchAgentTranscript(
  connectionId: string,
  runId: string,
): Promise<{ turns: AgentTurn[]; error?: string }> {
  const sql = `
    SELECT turn_idx, role, content, tool_name, tool_calls, finish_reason,
           tokens_in, tokens_out, cost_usd, latency_ms, error, created_at
      FROM rvbbit.agent_messages
     WHERE run_id = ${sqlStr(runId)}
     ORDER BY turn_idx`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { turns: [], error: res.error }
  const turns: AgentTurn[] = res.rows.map((r) => ({
    turnIdx: num(r.turn_idx),
    role: String(r.role ?? ""),
    content: strOrNull(r.content),
    toolName: strOrNull(r.tool_name),
    toolCalls: r.tool_calls ?? null,
    finishReason: strOrNull(r.finish_reason),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    costUsd: numOrNull(r.cost_usd),
    latencyMs: num(r.latency_ms),
    error: strOrNull(r.error),
    createdAt: String(r.created_at ?? ""),
  }))
  return { turns }
}

/** Distinct operator names that have agent transcripts — for the filter. */
export async function fetchAgentOperators(
  connectionId: string,
): Promise<{ operators: string[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT DISTINCT operator FROM rvbbit.agent_messages WHERE operator IS NOT NULL ORDER BY operator`,
  )
  if (!res.ok) return { operators: [], error: res.error }
  return { operators: res.rows.map((r) => String(r.operator)).filter(Boolean) }
}
