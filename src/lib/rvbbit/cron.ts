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
  /** cron.database_name GUC — where pg_cron reads jobs from (defaults to postgres). */
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

// `database` runs the statement against a sibling db on the same server (reusing
// this connection's creds) — used to reach pg_cron's home db (cron.database_name)
// while the user stays connected to their working db.
async function run(connectionId: string, sql: string, database?: string): Promise<Ok | Err> {
  try {
    const targetDatabase = cleanDbName(database) ?? undefined
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 500, database: targetDatabase }),
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
function cleanDbName(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}
function cronHomeDb(v: unknown): string {
  return cleanDbName(v) ?? "postgres"
}

const STATE_SQL = `SELECT
  EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron')                AS created,
  EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='pg_cron')        AS available,
  (coalesce(current_setting('shared_preload_libraries', true), '') ILIKE '%pg_cron%') AS preloaded,
  current_setting('cron.database_name', true)                              AS cron_db,
  current_database()                                                       AS this_db`

export async function detectCronState(
  connectionId: string,
): Promise<{ state: CronState | null; error: string | null }> {
  // Probe the ACTIVE db: cron_db (the home), this_db (working), and the global
  // available/preloaded flags are all valid from anywhere.
  const r = await run(connectionId, STATE_SQL)
  if (!r.ok) return { state: null, error: r.error }
  const row = r.rows[0] ?? {}
  const cronDb = cronHomeDb(row.cron_db)
  const thisDb = cronHomeDb(row.this_db)
  // `created` (the extension) lives in pg_cron's HOME db. If that differs from the
  // working db, check there — otherwise the working db would always look "not set up".
  let created = bool(row.created)
  let error: string | null = null
  if (cronDb !== thisDb) {
    const hr = await run(
      connectionId,
      "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') AS created",
      cronDb,
    )
    if (hr.ok) created = bool(hr.rows[0]?.created)
    else error = `Could not inspect pg_cron home database "${cronDb}": ${hr.error}`
  }
  return {
    error,
    state: { created, available: bool(row.available), preloaded: bool(row.preloaded), cronDb, thisDb },
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
  homeDb?: string | null,
): Promise<{ jobs: CronJob[]; error: string | null }> {
  // cron.job lives only in the home db; route there. Each job's `database` column
  // shows the db it actually runs in (its schedule_in_database target).
  const targetDb = cronHomeDb(homeDb)
  const r = await run(connectionId, JOBS_SQL, targetDb)
  if (!r.ok) return { jobs: [], error: `Could not read cron.job in "${targetDb}": ${r.error}` }
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
  homeDb?: string | null,
): Promise<{ runs: CronRun[]; error: string | null }> {
  // cron.job_run_details lives in the home db (route there). Per-run cost was a
  // single-query join to rvbbit.receipts when cron + rvbbit co-located; with the
  // home db ('postgres') decoupled from the target db, receipts live elsewhere, so
  // cost is omitted here (cross-db per-run cost attribution is a follow-up).
  const sql = `SELECT d.runid, d.status, d.start_time, d.end_time,
       extract(epoch FROM (coalesce(d.end_time, now()) - d.start_time)) AS duration_s,
       left(d.return_message, 240) AS return_message,
       NULL AS cost_usd, NULL AS n_calls, NULL AS tokens_in, NULL AS tokens_out
FROM cron.job_run_details d
WHERE d.jobid = ${jobid}
ORDER BY d.start_time DESC LIMIT 20`
  const targetDb = cronHomeDb(homeDb)
  const r = await run(connectionId, sql, targetDb)
  if (!r.ok) return { runs: [], error: `Could not read cron.job_run_details in "${targetDb}": ${r.error}` }
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

/** A mutating statement; returns {ok} / error. `database` routes it to a sibling db
 *  (the pg_cron home) so cron.* CRUD runs where the cron schema lives. */
export async function exec(
  connectionId: string,
  sql: string,
  database?: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, sql, cronHomeDb(database))
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

/** Start a command on a dedicated, statement_timeout-disabled connection and
 *  return as soon as it has launched (fire-and-forget) — for long jobs that must
 *  run for hours without the pool's 30-min timeout killing them or tying up a
 *  pool slot. Watch progress out-of-band (e.g. rvbbit.catalog_crawl_progress). */
export async function runDetached(
  connectionId: string,
  sql: string,
  database?: string,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const targetDatabase = cleanDbName(database) ?? undefined
    const res = await fetch("/api/db/run-detached", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, database: targetDatabase }),
    })
    const j = (await res.json()) as { ok: boolean; error?: string }
    return j.ok ? { ok: true, error: null } : { ok: false, error: j.error ?? "failed to start" }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Schedule a job in pg_cron's home db that RUNS in `targetDb` (where rvbbit lives).
 *  Uses cron.schedule_in_database so the home db ('postgres') need not have rvbbit. */
export function scheduleSql(name: string, schedule: string, command: string, targetDb: string): string {
  return `SELECT cron.schedule_in_database(${q(name)}, ${q(schedule)}, ${q(command)}, ${q(targetDb)})`
}
export function unscheduleSql(jobid: number): string {
  return `SELECT cron.unschedule(${jobid})`
}

/** Install the four alert pg_cron jobs (3 sweep tiers + the action worker) in one
 *  statement, consistent with the home-db→target-db model the tray uses. The job
 *  names match isAlertJob() so they're recognised once created. */
export function alertsInstallSql(targetDb: string): string {
  const sched = (name: string, schedule: string, cmd: string) =>
    `cron.schedule_in_database(${q(name)}, ${q(schedule)}, ${q(cmd)}, ${q(targetDb)})`
  return (
    "SELECT " +
    [
      sched("rvbbit_alert_sweep_fast", "* * * * *", "SELECT rvbbit.alert_sweep('fast')"),
      sched("rvbbit_alert_sweep_normal", "*/15 * * * *", "SELECT rvbbit.alert_sweep('normal')"),
      sched("rvbbit_alert_sweep_slow", "0 * * * *", "SELECT rvbbit.alert_sweep('slow')"),
      sched("rvbbit_alert_worker", "* * * * *", "SELECT rvbbit.alert_worker_tick(50)"),
    ].join(",\n       ")
  )
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
/** Does this job run the OLAP autopilot heartbeat? */
export function isAccelTickJob(j: CronJob): boolean {
  return /accel_tick/i.test(j.command) || j.jobname === "rvbbit_accel_tick" || j.jobname === "rvbbit_olap_autopilot"
}
/** Does this job run the temporal-mirror sync? */
export function isSyncJob(j: CronJob): boolean {
  return /run_sync/i.test(j.command) || j.jobname === "rvbbit_sync"
}
/** Does this job run an alert sweep or the alert action worker? */
export function isAlertJob(j: CronJob): boolean {
  return /rvbbit\.(alert_sweep|alert_worker_tick)\b/i.test(j.command) || /^rvbbit_alert_/.test(j.jobname ?? "")
}
/** Does this job materialize all metrics (timestamped snapshot)? */
export function isMetricsJob(j: CronJob): boolean {
  return /materialize_all_metrics/i.test(j.command) || j.jobname === "rvbbit_materialize_all"
}
/** Does this job refresh all cubes (reload + acceleration rebuild)? */
export function isCubesJob(j: CronJob): boolean {
  return /refresh_all_cubes/i.test(j.command) || j.jobname === "rvbbit_refresh_cubes"
}
/** Does this job run the adaptive-routing auto-optimizer (benchmark hot shapes, pin wins)? */
export function isRouteOptimizeJob(j: CronJob): boolean {
  return /route_optimize_auto/i.test(j.command) || j.jobname === "rvbbit_route_optimize"
}
/** Default command for the nightly route auto-optimizer: top-20 hot shapes, 600s budget, 3 samples. */
export const ROUTE_OPTIMIZE_COMMAND = "SELECT rvbbit.route_optimize_auto(20, 600, 3)"
/** Does this job sync the document brain's remote sources (Google Drive, etc.)? */
export function isBrainSyncJob(j: CronJob): boolean {
  return /brain_sync_sources/i.test(j.command) || j.jobname === "rvbbit_brain_sync"
}
/** Default command for the nightly brain job: scan configured sources, re-ingest changed docs,
 *  then enrich the backlog into the knowledge graph (entities/relations/wikilinks). */
export const BRAIN_SYNC_COMMAND = "SELECT rvbbit.brain_nightly()"
