// Data layer for the pg_cron-backed Scheduler. All queries run through
// /api/db/query against the active connection. pg_cron's metadata (cron.job,
// cron.job_run_details) lives only in its home database (cron.database_name) —
// so the Scheduler manages jobs from whichever connection has `cron.*` visible.
// When that database also has rvbbit, run cost is rolled up from rvbbit.receipts
// by joining each run's time window.

export interface CronState {
  /** pg_cron extension created in THIS database (cron.* visible here). */
  created: boolean
  /** pg_cron is in pg_available_extensions (installable). */
  available: boolean
  /** shared_preload_libraries contains pg_cron (bgworker running). */
  preloaded: boolean
  /** cron.database_name GUC — where pg_cron reads jobs from (null if not loaded). */
  cronDb: string | null
  thisDb: string
}

export interface CronJob {
  jobid: number
  jobname: string | null
  schedule: string
  command: string
  database: string
  active: boolean
  lastStatus: string | null
  lastStart: number | null
  lastEnd: number | null
}

export interface CronRun {
  runid: number
  status: string
  startTime: number | null
  endTime: number | null
  durationS: number | null
  returnMessage: string | null
  costUsd: number | null
  nCalls: number | null
  tokensIn: number | null
  tokensOut: number | null
}

interface Ok {
  ok: true
  columns?: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface Err {
  ok: false
  error: string
}

async function run(connectionId: string, sql: string): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 500 }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal (the query API has no bind params). */
export function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}
function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true"
}

const STATE_SQL = `SELECT
  EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')                AS created,
  EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron')        AS available,
  (current_setting('shared_preload_libraries') ILIKE '%pg_cron%')          AS preloaded,
  current_setting('cron.database_name', true)                              AS cron_db,
  current_database()                                                       AS this_db`

export async function detectCronState(
  connectionId: string,
): Promise<{ state: CronState | null; error: string | null }> {
  const r = await run(connectionId, STATE_SQL)
  if (!r.ok) return { state: null, error: r.error }
  const row = r.rows[0] ?? {}
  return {
    error: null,
    state: {
      created: bool(row.created),
      available: bool(row.available),
      preloaded: bool(row.preloaded),
      cronDb: row.cron_db == null ? null : String(row.cron_db),
      thisDb: String(row.this_db ?? ""),
    },
  }
}

const JOBS_SQL = `SELECT j.jobid, j.jobname, j.schedule, j.command, j.database, j.active,
       r.status AS last_status, r.start_time AS last_start, r.end_time AS last_end
FROM cron.job j
LEFT JOIN LATERAL (
  SELECT status, start_time, end_time FROM cron.job_run_details d
  WHERE d.jobid = j.jobid ORDER BY start_time DESC LIMIT 1
) r ON true
ORDER BY j.jobname NULLS LAST, j.jobid`

export async function listCronJobs(
  connectionId: string,
): Promise<{ jobs: CronJob[]; error: string | null }> {
  const r = await run(connectionId, JOBS_SQL)
  if (!r.ok) return { jobs: [], error: r.error }
  return {
    error: null,
    jobs: r.rows.map((row) => ({
      jobid: Number(row.jobid),
      jobname: row.jobname == null ? null : String(row.jobname),
      schedule: String(row.schedule ?? ""),
      command: String(row.command ?? ""),
      database: String(row.database ?? ""),
      active: bool(row.active),
      lastStatus: row.last_status == null ? null : String(row.last_status),
      lastStart: epoch(row.last_start),
      lastEnd: epoch(row.last_end),
    })),
  }
}

export async function listCronRuns(
  connectionId: string,
  jobid: number,
  withCost: boolean,
): Promise<{ runs: CronRun[]; error: string | null }> {
  // Cost rollup: receipts whose invocation falls inside the run's window. Only
  // valid when rvbbit.receipts exists in this database (withCost).
  const costSelect = withCost
    ? `, c.cost_usd, c.n_calls, c.tokens_in, c.tokens_out`
    : `, NULL AS cost_usd, NULL AS n_calls, NULL AS tokens_in, NULL AS tokens_out`
  const costJoin = withCost
    ? `LEFT JOIN LATERAL (
         SELECT sum(cost_usd) AS cost_usd, count(*) AS n_calls,
                sum(n_tokens_in) AS tokens_in, sum(n_tokens_out) AS tokens_out
         FROM rvbbit.receipts rc
         WHERE rc.invocation_at >= d.start_time
           AND rc.invocation_at <= coalesce(d.end_time, now())
       ) c ON true`
    : ``
  const sql = `SELECT d.runid, d.status, d.start_time, d.end_time,
       extract(epoch FROM (coalesce(d.end_time, now()) - d.start_time)) AS duration_s,
       left(d.return_message, 240) AS return_message${costSelect}
FROM cron.job_run_details d
${costJoin}
WHERE d.jobid = ${jobid}
ORDER BY d.start_time DESC LIMIT 20`
  const r = await run(connectionId, sql)
  if (!r.ok) return { runs: [], error: r.error }
  return {
    error: null,
    runs: r.rows.map((row) => ({
      runid: Number(row.runid),
      status: String(row.status ?? ""),
      startTime: epoch(row.start_time),
      endTime: epoch(row.end_time),
      durationS: num(row.duration_s),
      returnMessage: row.return_message == null ? null : String(row.return_message),
      costUsd: num(row.cost_usd),
      nCalls: num(row.n_calls),
      tokensIn: num(row.tokens_in),
      tokensOut: num(row.tokens_out),
    })),
  }
}

/** A mutating statement; returns {ok} / error. */
export async function exec(connectionId: string, sql: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, sql)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

export function scheduleSql(name: string, schedule: string, command: string): string {
  return `SELECT cron.schedule(${q(name)}, ${q(schedule)}, ${q(command)})`
}
export function unscheduleSql(jobid: number): string {
  return `SELECT cron.unschedule(${jobid})`
}
export function setActiveSql(jobid: number, active: boolean): string {
  return `SELECT cron.alter_job(job_id := ${jobid}, active := ${active})`
}
export const CREATE_EXTENSION_SQL = `CREATE EXTENSION IF NOT EXISTS pg_cron`

/** Does this job (likely) run the catalog crawl? */
export function isCatalogJob(j: CronJob): boolean {
  return /catalog_crawl/i.test(j.command) || j.jobname === "rvbbit_catalog_refresh"
}
/** Heuristic: does the command call rvbbit semantic operators (so cost is meaningful)? */
export function isSemanticJob(j: CronJob): boolean {
  return /\brvbbit\./i.test(j.command)
}
