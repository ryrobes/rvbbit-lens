import type { HtmlBlockSpec } from "@/lib/desktop/app-block"
import type { QueryResult, QueryResultColumn, StatementResult } from "@/lib/db/types"

const SAMPLE_ROWS = 3
const SAMPLE_CHAR_BUDGET = 3_000
const SAMPLE_CELL_CHARS = 320
const SAMPLE_COLUMNS = 24
const OBSERVED_STATEMENTS = 8
const EXECUTED_SQL_CHARS = 4_000

export type AssistantObservedRunState =
  | { kind: "idle" }
  | { kind: "running"; sql: string; startedAt: number }
  | { kind: "done"; result: QueryResult }
  | {
      kind: "error"
      error: string
      code?: string
      detail?: string
      hint?: string
      position?: number | null
    }

export interface AssistantExecutionColumn {
  name: string
  type?: string
}

export interface AssistantStatementExecutionObservation {
  index: number
  query_id?: string
  title?: string
  command?: string
  row_count: number
  truncated: boolean
  columns: AssistantExecutionColumn[]
  sample_rows: Record<string, unknown>[]
}

export type AssistantBlockExecutionObservation =
  | {
      state: "idle"
      observed_at: string
    }
  | {
      state: "running"
      observed_at: string
      started_at: string
      executed_sql?: string
      sql_truncated?: true
    }
  | {
      state: "error"
      observed_at: string
      executed_sql?: string
      sql_truncated?: true
      error: {
        message: string
        code?: string
        detail?: string
        hint?: string
        position?: number | null
      }
    }
  | {
      state: "done"
      observed_at: string
      executed_sql?: string
      sql_truncated?: true
      command?: string
      row_count: number
      duration_ms: number
      queue_wait_ms?: number
      truncated: boolean
      warning?: string
      columns: AssistantExecutionColumn[]
      sample_rows?: Record<string, unknown>[]
      statements?: AssistantStatementExecutionObservation[]
      statements_truncated?: true
    }

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`
}

function compactValue(value: unknown): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return boundedText(value, SAMPLE_CELL_CHARS)
  try {
    const encoded = JSON.stringify(value)
    if (encoded.length <= SAMPLE_CELL_CHARS) return value
    return `${encoded.slice(0, SAMPLE_CELL_CHARS)}…`
  } catch {
    return boundedText(String(value), SAMPLE_CELL_CHARS)
  }
}

function compactRows(
  rows: Record<string, unknown>[],
  maxRows = SAMPLE_ROWS,
  maxChars = SAMPLE_CHAR_BUDGET,
): Record<string, unknown>[] {
  const sample: Record<string, unknown>[] = []
  let used = 2
  for (const row of rows.slice(0, maxRows)) {
    const compact: Record<string, unknown> = {}
    const entries = Object.entries(row).slice(0, SAMPLE_COLUMNS)
    for (const [key, value] of entries) {
      compact[key] = compactValue(value)
      if (JSON.stringify(compact).length + used > maxChars) {
        delete compact[key]
        compact._sample_truncated = true
        break
      }
    }
    if (Object.keys(compact).length === 0) break
    const encoded = JSON.stringify(compact)
    if (used + encoded.length > maxChars) break
    sample.push(compact)
    used += encoded.length + 1
  }
  return sample
}

function compactColumns(columns: QueryResultColumn[]): AssistantExecutionColumn[] {
  return columns.slice(0, SAMPLE_COLUMNS).map((column) => ({
    name: column.name,
    ...(column.dataTypeName ? { type: column.dataTypeName } : {}),
  }))
}

function statementObservation(
  statement: StatementResult,
  htmlBlock: HtmlBlockSpec | null,
  sampleBudget: number,
): AssistantStatementExecutionObservation {
  const query = htmlBlock?.queries[statement.index]
  return {
    index: statement.index,
    ...(query?.id ? { query_id: query.id } : {}),
    ...(query?.title ? { title: query.title } : {}),
    ...(statement.command ? { command: statement.command } : {}),
    row_count: statement.rowCount,
    truncated: statement.truncated,
    columns: compactColumns(statement.columns),
    sample_rows: compactRows(statement.rows, 2, sampleBudget),
  }
}

function compactExecutedSql(sql: string | undefined): {
  executed_sql?: string
  sql_truncated?: true
} {
  if (!sql) return {}
  return {
    executed_sql: boundedText(sql, EXECUTED_SQL_CHARS),
    ...(sql.length > EXECUTED_SQL_CHARS ? { sql_truncated: true as const } : {}),
  }
}

/** Build the deliberately-small runtime fact that rides in desktop_context on
 * the assistant's next turn. Query rows never enter saved desktop state or the
 * conversation transcript; this is an ephemeral view of what actually ran. */
export function buildAssistantExecutionObservation(
  runState: AssistantObservedRunState,
  executedSql: string,
  htmlBlock: HtmlBlockSpec | null,
): AssistantBlockExecutionObservation {
  if (runState.kind === "idle") {
    return { state: "idle", observed_at: new Date().toISOString() }
  }
  if (runState.kind === "running") {
    return {
      state: "running",
      observed_at: new Date().toISOString(),
      started_at: new Date(runState.startedAt).toISOString(),
      ...compactExecutedSql(executedSql || runState.sql),
    }
  }
  if (runState.kind === "error") {
    return {
      state: "error",
      observed_at: new Date().toISOString(),
      ...compactExecutedSql(executedSql),
      error: {
        message: boundedText(runState.error, 2_000) ?? "query failed",
        ...(runState.code ? { code: runState.code } : {}),
        ...(runState.detail ? { detail: boundedText(runState.detail, 2_000) } : {}),
        ...(runState.hint ? { hint: boundedText(runState.hint, 1_000) } : {}),
        ...(runState.position !== undefined ? { position: runState.position } : {}),
      },
    }
  }

  const result = runState.result
  const statements = result.results?.slice(0, OBSERVED_STATEMENTS)
  const sampleBudget = statements?.length
    ? Math.max(320, Math.floor(SAMPLE_CHAR_BUDGET / statements.length))
    : SAMPLE_CHAR_BUDGET
  return {
    state: "done",
    observed_at: new Date().toISOString(),
    ...compactExecutedSql(executedSql || result.sql),
    ...(result.command ? { command: result.command } : {}),
    row_count: result.rowCount,
    duration_ms: result.durationMs,
    ...(result.queueWaitMs !== undefined ? { queue_wait_ms: result.queueWaitMs } : {}),
    truncated: result.truncated,
    ...(result.warning ? { warning: boundedText(result.warning, 1_000) } : {}),
    columns: compactColumns(result.columns),
    ...(statements?.length
      ? {
          statements: statements.map((statement) => statementObservation(statement, htmlBlock, sampleBudget)),
          ...(result.results && result.results.length > OBSERVED_STATEMENTS
            ? { statements_truncated: true as const }
            : {}),
        }
      : { sample_rows: compactRows(result.rows) }),
  }
}
