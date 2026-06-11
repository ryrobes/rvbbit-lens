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
      spec: (typeof row.spec === "string" ? JSON.parse(row.spec) : row.spec) as SyncSpec,
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
