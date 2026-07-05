"use client"

// Data layer for the Temporal Mirror (Postgres -> rvbbit sync). All queries run
// through /api/db/query against the active (rvbbit) connection. A job is a JSON
// spec stored server-side in rvbbit.sync_jobs; rvbbit.run_sync() executes it and
// logs per-table rows to rvbbit.sync_runs (visible mid-run).

export interface SyncServer {
  name: string
  host: string
  port: number
  dbname: string
  user: string
  password: string
  fetch_size?: number
}

export interface SyncSpec {
  server: SyncServer
  remote_schema: string
  fdw_schema: string
  dest_schema: string
  /** Empty array => whole-schema mode. */
  tables: string[]
}

export interface SyncJob {
  jobName: string
  enabled: boolean
  spec: SyncSpec
  lastRunAt: number | null
}

export interface SyncRun {
  runId: string | null
  sourceTable: string | null
  destTable: string | null
  action: string | null
  generation: number | null
  rowsLoaded: number | null
  elapsedMs: number | null
  error: string | null
  startedAt: number | null
}

interface Ok {
  ok: true
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
      body: JSON.stringify({ connectionId, sql, rowLimit: 1000 }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal (the query API has no bind params). */
function q(s: string): string {
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

export function emptySpec(): SyncSpec {
  return {
    server: { name: "", host: "", port: 5432, dbname: "", user: "", password: "", fetch_size: 10000 },
    remote_schema: "public",
    fdw_schema: "rvbbit_fdw",
    dest_schema: "mirror",
    tables: [],
  }
}

export async function listSyncJobs(connectionId: string): Promise<{ jobs: SyncJob[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT job_name, enabled, spec, extract(epoch FROM last_run_at)*1000 AS last_run
     FROM rvbbit.sync_jobs ORDER BY job_name`,
  )
  if (!r.ok) return { jobs: [], error: r.error }
  return {
    error: null,
    jobs: r.rows.map((row) => ({
      jobName: String(row.job_name),
      enabled: row.enabled === true || row.enabled === "t",
      spec: (typeof row.spec === "string" ? safeJson(row.spec) : row.spec) as SyncSpec,
      lastRunAt: num(row.last_run),
    })),
  }
}

/** The exact DDL that creates/updates a sync job — the single source of truth
 *  shared by upsertSyncJob() and the editor's copy-pasteable SQL preview, so the
 *  shown SQL is always what actually runs. `pretty` formats the spec JSON over
 *  multiple lines for the human-readable preview (functionally identical jsonb). */
export function buildUpsertSyncSql(jobName: string, spec: SyncSpec, enabled = true, pretty = false): string {
  const json = pretty ? JSON.stringify(spec, null, 2) : JSON.stringify(spec)
  return `INSERT INTO rvbbit.sync_jobs (job_name, enabled, spec)
VALUES (${q(jobName)}, ${enabled}, ${q(json)}::jsonb)
ON CONFLICT (job_name) DO UPDATE
  SET enabled = EXCLUDED.enabled, spec = EXCLUDED.spec, updated_at = now();`
}

export async function upsertSyncJob(
  connectionId: string,
  jobName: string,
  spec: SyncSpec,
  enabled = true,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, buildUpsertSyncSql(jobName, spec, enabled))
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

export async function deleteSyncJob(connectionId: string, jobName: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `DELETE FROM rvbbit.sync_jobs WHERE job_name = ${q(jobName)}`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

/** Fire the job now (ad-hoc). run_sync is a PROCEDURE, so it must be CALLed. */
export async function runSyncJob(connectionId: string, jobName: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `CALL rvbbit.run_sync(${q(jobName)})`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

export async function listSyncRuns(
  connectionId: string,
  jobName: string,
  limit = 60,
): Promise<{ runs: SyncRun[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT run_id::text AS run_id, source_table, dest_table, action, generation, rows_loaded, elapsed_ms, error,
            extract(epoch FROM started_at)*1000 AS started
     FROM rvbbit.sync_runs WHERE job_name = ${q(jobName)}
     ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  )
  if (!r.ok) return { runs: [], error: r.error }
  return {
    error: null,
    runs: r.rows.map((row) => ({
      runId: row.run_id == null ? null : String(row.run_id),
      sourceTable: row.source_table == null ? null : String(row.source_table),
      destTable: row.dest_table == null ? null : String(row.dest_table),
      action: row.action == null ? null : String(row.action),
      generation: num(row.generation),
      rowsLoaded: num(row.rows_loaded),
      elapsedMs: num(row.elapsed_ms),
      error: row.error == null ? null : String(row.error),
      startedAt: epoch(row.started),
    })),
  }
}

/** The cron-friendly command the Scheduler schedules. */
export const RUN_SYNC_COMMAND = "CALL rvbbit.run_sync();"

// ── Overview / observability ───────────────────────────────────────────────
// A single read-model over sync_lock + sync_runs + sync_jobs (+ pg_stat_activity)
// powering the Temporal Mirror overview dashboard. Everything is DERIVED from the
// per-table rows run_sync already commits (no new tables) — so the dashboard sees
// progress mid-sweep. Note: run_id is allocated once per CALL, so a "sweep" spans
// every job in one invocation; per-job stats group by (run_id, job_name).

function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true"
}
function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}
function numArr(v: unknown): number[] {
  const a = typeof v === "string" ? safeJson(v) : v
  return Array.isArray(a) ? a.map((x) => Number(x)).filter((n) => Number.isFinite(n)) : []
}

export interface SyncLiveStatus {
  hasLock: boolean
  running: boolean        // lock held AND its backend is alive
  staleLock: boolean      // lock held but backend gone (likely a crashed run)
  pid: number | null
  backendState: string | null
  lastHeartbeatAt: number | null
  sweepStartAt: number | null    // start of the most-recent sweep
  lastActivityAt: number | null  // last table committed in that sweep
}
export interface SyncSweep {
  runId: string
  startedAt: number | null
  wallMs: number | null
  jobs: number
  tables: number
  errors: number
  imports: number    // # jobs that re-imported (action='import') this sweep
  importMs: number   // total IMPORT FOREIGN SCHEMA time across those jobs
  rowsLoaded: number
}
export interface SyncJobStat {
  jobName: string
  enabled: boolean
  lastRunAt: number | null
  tablesSynced: number | null
  errors: number | null
  rowsLoaded: number | null
  reImported: boolean         // did the last sweep re-import (vs skip on unchanged schema)
  importMs: number | null     // IMPORT FOREIGN SCHEMA time in that sweep (0/null = skipped)
  provisionError: boolean     // last sweep failed in provisioning (fdw setup/import) — NOT a skip
  lastDurMs: number | null    // wall span of the last sweep pass (includes the import row when re-imported)
  trend: number[]             // recent sweep-span durations (ms), oldest→newest
}
export interface SyncLiveJob { jobName: string; tablesDone: number; tablesTotal: number | null; pct: number | null }
export interface SyncSlowTable { jobName: string; sourceTable: string | null; rowsLoaded: number | null; elapsedMs: number | null; startedAt: number | null }
export interface SyncErrorRow { jobName: string; sourceTable: string | null; action: string | null; error: string | null; startedAt: number | null }
export interface SyncOverview {
  status: SyncLiveStatus
  sweeps: SyncSweep[]
  jobStats: SyncJobStat[]
  liveJobs: SyncLiveJob[]
  slowTables: SyncSlowTable[]
  errors: SyncErrorRow[]
}

const STATUS_SQL = `
WITH lk AS (
  SELECT l.pid, l.acquired_at, (a.pid IS NOT NULL) AS alive, a.state
  FROM rvbbit.sync_lock l LEFT JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.id = 1
), anchor AS (
  SELECT min(started_at) AS sweep_start, max(started_at) AS last_activity
  FROM rvbbit.sync_runs
  WHERE run_id = (SELECT run_id FROM rvbbit.sync_runs ORDER BY started_at DESC LIMIT 1)
)
SELECT EXISTS(SELECT 1 FROM lk) AS has_lock,
       (SELECT alive FROM lk) AS alive,
       (SELECT pid FROM lk) AS pid,
       (SELECT state FROM lk) AS state,
       extract(epoch FROM (SELECT acquired_at FROM lk))*1000 AS heartbeat_ms,
       extract(epoch FROM (SELECT sweep_start FROM anchor))*1000 AS sweep_start_ms,
       extract(epoch FROM (SELECT last_activity FROM anchor))*1000 AS last_activity_ms`

const SWEEPS_SQL = `
SELECT run_id::text AS run_id,
       extract(epoch FROM min(started_at))*1000 AS started_ms,
       extract(epoch FROM (max(started_at + make_interval(secs => coalesce(elapsed_ms,0)/1000.0)) - min(started_at)))*1000 AS wall_ms,
       count(DISTINCT job_name) AS jobs,
       count(*) FILTER (WHERE action NOT IN ('error','import')) AS tables,
       count(*) FILTER (WHERE action = 'error') AS errors,
       count(*) FILTER (WHERE action = 'import') AS imports,
       coalesce(sum(elapsed_ms) FILTER (WHERE action = 'import'),0) AS import_ms,
       coalesce(sum(rows_loaded) FILTER (WHERE action NOT IN ('import')),0) AS rows_loaded
FROM rvbbit.sync_runs GROUP BY run_id ORDER BY min(started_at) DESC LIMIT 20`

const JOBSTATS_SQL = `
WITH per_job_sweep AS (
  SELECT job_name, run_id, min(started_at) AS job_start,
         max(started_at + make_interval(secs => coalesce(elapsed_ms,0)/1000.0)) AS job_end,
         count(*) FILTER (WHERE action NOT IN ('error','import')) AS tables_synced,
         count(*) FILTER (WHERE action = 'error') AS errors,
         bool_or(action = 'import') AS reimported,
         coalesce(sum(elapsed_ms) FILTER (WHERE action = 'import'),0) AS import_ms,
         coalesce(sum(rows_loaded) FILTER (WHERE action NOT IN ('import')),0) AS rows_loaded,
         bool_or(action = 'error' AND source_table IS NULL) AS provision_error
  FROM rvbbit.sync_runs GROUP BY job_name, run_id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY job_name ORDER BY job_start DESC) AS rn FROM per_job_sweep
)
SELECT j.job_name, j.enabled,
       extract(epoch FROM j.last_run_at)*1000 AS last_run_ms,
       r.tables_synced, r.errors, r.rows_loaded, r.reimported, r.import_ms, r.provision_error,
       extract(epoch FROM (r.job_end - r.job_start))*1000 AS last_dur_ms,
       coalesce((SELECT jsonb_agg(round(extract(epoch FROM (job_end-job_start))*1000) ORDER BY job_start)
                 FROM ranked rr WHERE rr.job_name=j.job_name AND rr.rn<=12), '[]'::jsonb) AS trend
FROM rvbbit.sync_jobs j
LEFT JOIN ranked r ON r.job_name=j.job_name AND r.rn=1
ORDER BY j.job_name`

// active_run must be the run the LIVE lock-holder is appending — NOT merely the
// newest committed row. run_id is per-CALL and a fresh sweep writes its first row
// only AFTER fdw_setup + IMPORT FOREIGN SCHEMA, so "newest row" still belongs to
// the PREVIOUS sweep during the import phase. The lock's acquired_at is heartbeated
// right after each table commits, so the live sweep's latest committed table ends
// ≈ acquired_at; a prior sweep's rows end well before it. Gate on that proximity:
// during a fresh sweep's first import this returns NO rows (→ "importing", not
// stale 100%); it flips to the new run the instant its first table commits.
const LIVEJOBS_SQL = `
WITH live AS (
  SELECT l.pid, l.acquired_at FROM rvbbit.sync_lock l
  JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.id=1
),
active_run AS (
  SELECT sr.run_id FROM rvbbit.sync_runs sr, live
  WHERE sr.started_at + make_interval(secs => coalesce(sr.elapsed_ms,0)/1000.0) >= live.acquired_at - interval '5 seconds'
  ORDER BY sr.started_at DESC LIMIT 1
)
SELECT j.job_name,
       count(sr.*) FILTER (WHERE sr.action NOT IN ('error','import')) AS tables_done,
       CASE WHEN jsonb_array_length(coalesce(j.spec->'tables','[]'::jsonb)) > 0
            THEN jsonb_array_length(j.spec->'tables')
            ELSE (SELECT count(*) FROM pg_foreign_table ft JOIN pg_class c ON c.oid=ft.ftrelid
                  JOIN pg_namespace ns ON ns.oid=c.relnamespace
                  WHERE ns.nspname = coalesce(j.spec->>'fdw_schema','rvbbit_fdw')) END AS tables_total
FROM active_run ar JOIN rvbbit.sync_runs sr ON sr.run_id=ar.run_id
JOIN rvbbit.sync_jobs j ON j.job_name=sr.job_name GROUP BY j.job_name, j.spec ORDER BY j.job_name`

const SLOW_SQL = `
SELECT job_name, source_table, rows_loaded, elapsed_ms, extract(epoch FROM started_at)*1000 AS started_ms
FROM rvbbit.sync_runs WHERE action NOT IN ('error','import') AND elapsed_ms IS NOT NULL
ORDER BY elapsed_ms DESC NULLS LAST LIMIT 8`

const ERRORS_SQL = `
SELECT job_name, source_table, action, error, extract(epoch FROM started_at)*1000 AS started_ms
FROM rvbbit.sync_runs WHERE action='error' ORDER BY started_at DESC LIMIT 10`

/** Assemble the whole overview read-model in one parallel round of queries. */
export async function fetchSyncOverview(
  connectionId: string,
): Promise<{ overview: SyncOverview | null; error: string | null }> {
  const [st, sw, js, lj, sl, er] = await Promise.all([
    run(connectionId, STATUS_SQL),
    run(connectionId, SWEEPS_SQL),
    run(connectionId, JOBSTATS_SQL),
    run(connectionId, LIVEJOBS_SQL),
    run(connectionId, SLOW_SQL),
    run(connectionId, ERRORS_SQL),
  ])
  const failed = [st, sw, js, lj, sl, er].find((r) => !r.ok)
  if (failed && !failed.ok) return { overview: null, error: failed.error }

  const srow = (st as Ok).rows[0] ?? {}
  const hasLock = bool(srow.has_lock)
  const alive = bool(srow.alive)

  const overview: SyncOverview = {
    status: {
      hasLock,
      running: hasLock && alive,
      staleLock: hasLock && !alive,
      pid: num(srow.pid),
      backendState: srow.state == null ? null : String(srow.state),
      lastHeartbeatAt: num(srow.heartbeat_ms),
      sweepStartAt: num(srow.sweep_start_ms),
      lastActivityAt: num(srow.last_activity_ms),
    },
    sweeps: (sw as Ok).rows.map((r) => ({
      runId: String(r.run_id),
      startedAt: num(r.started_ms),
      wallMs: num(r.wall_ms),
      jobs: Number(r.jobs) || 0,
      tables: Number(r.tables) || 0,
      errors: Number(r.errors) || 0,
      imports: Number(r.imports) || 0,
      importMs: Number(r.import_ms) || 0,
      rowsLoaded: Number(r.rows_loaded) || 0,
    })),
    jobStats: (js as Ok).rows.map((r) => ({
      jobName: String(r.job_name),
      enabled: bool(r.enabled),
      lastRunAt: num(r.last_run_ms),
      tablesSynced: num(r.tables_synced),
      errors: num(r.errors),
      rowsLoaded: num(r.rows_loaded),
      reImported: bool(r.reimported),
      importMs: num(r.import_ms),
      provisionError: bool(r.provision_error),
      lastDurMs: num(r.last_dur_ms),
      trend: numArr(r.trend),
    })),
    liveJobs: (lj as Ok).rows.map((r) => {
      const done = Number(r.tables_done) || 0
      const total = num(r.tables_total)
      return { jobName: String(r.job_name), tablesDone: done, tablesTotal: total, pct: total && total > 0 ? Math.round((100 * done) / total) : null }
    }),
    slowTables: (sl as Ok).rows.map((r) => ({
      jobName: String(r.job_name),
      sourceTable: r.source_table == null ? null : String(r.source_table),
      rowsLoaded: num(r.rows_loaded),
      elapsedMs: num(r.elapsed_ms),
      startedAt: num(r.started_ms),
    })),
    errors: (er as Ok).rows.map((r) => ({
      jobName: String(r.job_name),
      sourceTable: r.source_table == null ? null : String(r.source_table),
      action: r.action == null ? null : String(r.action),
      error: r.error == null ? null : String(r.error),
      startedAt: num(r.started_ms),
    })),
  }
  return { overview, error: null }
}
