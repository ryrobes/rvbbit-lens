"use client"

/**
 * Semantic Tests — client fetchers over the operator test battery.
 *
 * Operators carry embedded test cases (rvbbit.operators.tests, run via
 * rvbbit.run_tests / run_all_tests — engine built-ins). The logged layer
 * (rvbbit.operator_test_runs + run_tests_log(tag)) is the drift timeline:
 * append-only results stamped with a free-form backend_tag (which
 * model/version answered), so pass-rate changes attribute to exactly one
 * regime change. This window is a rendering of those tables, per house
 * religion. `available:false` = warehouse predates the runs table.
 */

export interface OperatorTestSummary {
  operator: string
  n_tests: number
  /** oldest→newest across recent runs */
  trend: { run: number; ok: number; total: number }[]
}

export interface TestRun {
  run_id: number
  ts: string
  tag: string
  ok: number
  total: number
  ops: number
}

export interface TestFailure {
  operator: string
  test_name: string | null
  actual: string | null
  expected: string | null
  description: string | null
  error: string | null
}

export interface SemanticTestsState {
  available: boolean
  operators: OperatorTestSummary[]
  runs: TestRun[]
  error?: string
}

async function runQuery(
  connectionId: string,
  sql: string,
  readOnly = true,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 500, readOnly }),
    })
    return (await res.json()) as
      | { ok: true; rows: Record<string, unknown>[] }
      | { ok: false; error: string }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

const esc = (s: string) => s.replace(/'/g, "''")

export async function fetchSemanticTests(connectionId: string): Promise<SemanticTestsState> {
  const probe = await runQuery(
    connectionId,
    "SELECT to_regclass('rvbbit.operator_test_runs') IS NOT NULL AS has_runs",
  )
  if (!probe.ok) return { available: false, operators: [], runs: [], error: probe.error }
  if (!probe.rows[0]?.has_runs) return { available: false, operators: [], runs: [] }

  const opsQ = runQuery(
    connectionId,
    `WITH ops AS (
       SELECT name, jsonb_array_length(tests) AS n_tests
       FROM rvbbit.operators
       WHERE tests IS NOT NULL AND jsonb_array_length(tests) > 0
     ),
     recent AS (
       SELECT DISTINCT run_id FROM rvbbit.operator_test_runs
       ORDER BY run_id DESC LIMIT 12
     ),
     per_run AS (
       SELECT operator, run_id,
              count(*) FILTER (WHERE passed) AS ok, count(*) AS total
       FROM rvbbit.operator_test_runs
       WHERE run_id IN (SELECT run_id FROM recent)
       GROUP BY 1, 2
     )
     SELECT o.name AS operator, o.n_tests,
            coalesce((SELECT jsonb_agg(jsonb_build_object('run', pr.run_id, 'ok', pr.ok, 'total', pr.total) ORDER BY pr.run_id)
               FROM per_run pr WHERE pr.operator = o.name), '[]'::jsonb) AS trend
     FROM ops o ORDER BY o.name`,
  )
  const runsQ = runQuery(
    connectionId,
    `SELECT run_id, min(ts) AS ts, coalesce(max(backend_tag), '') AS tag,
            count(*) FILTER (WHERE passed) AS ok, count(*) AS total,
            count(DISTINCT operator) AS ops
     FROM rvbbit.operator_test_runs
     GROUP BY run_id ORDER BY run_id DESC LIMIT 20`,
  )
  const [opsR, runsR] = await Promise.all([opsQ, runsQ])
  const operators: OperatorTestSummary[] = opsR.ok
    ? opsR.rows.map((r) => ({
        operator: String(r.operator),
        n_tests: Number(r.n_tests ?? 0),
        trend:
          typeof r.trend === "string"
            ? (JSON.parse(r.trend) as OperatorTestSummary["trend"])
            : ((r.trend ?? []) as OperatorTestSummary["trend"]),
      }))
    : []
  const runs: TestRun[] = runsR.ok
    ? runsR.rows.map((r) => ({
        run_id: Number(r.run_id),
        ts: String(r.ts ?? ""),
        tag: String(r.tag ?? ""),
        ok: Number(r.ok ?? 0),
        total: Number(r.total ?? 0),
        ops: Number(r.ops ?? 0),
      }))
    : []
  return { available: true, operators, runs, error: opsR.ok ? undefined : opsR.error }
}

export async function fetchFailures(
  connectionId: string,
  runId: number,
): Promise<TestFailure[]> {
  const r = await runQuery(
    connectionId,
    `SELECT operator, test_name, left(coalesce(actual,''), 160) AS actual,
            left(coalesce(expected,''), 120) AS expected,
            description, left(coalesce(error,''), 200) AS error
     FROM rvbbit.operator_test_runs
     WHERE run_id = ${Math.floor(runId)} AND NOT passed
     ORDER BY operator, test_name`,
  )
  return r.ok ? (r.rows as unknown as TestFailure[]) : []
}

/** Kick a full logged battery. Writes rows, so readOnly:false. Can take a
 * minute or two on first-run (uncached) batteries — callers show progress. */
export async function runBattery(
  connectionId: string,
  tag: string,
): Promise<{ ok: boolean; run_id?: number; passed?: number; tests?: number; error?: string }> {
  const r = await runQuery(
    connectionId,
    `SELECT run_id, operators, tests, passed FROM rvbbit.run_tests_log(nullif('${esc(tag)}', ''))`,
    false,
  )
  if (!r.ok) return { ok: false, error: r.error }
  const row = r.rows[0] ?? {}
  return {
    ok: true,
    run_id: Number(row.run_id),
    passed: Number(row.passed ?? 0),
    tests: Number(row.tests ?? 0),
  }
}
