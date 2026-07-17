import "server-only"

/**
 * System Health — the maintenance X-ray for an rvbbit database.
 *
 * Surfaces the metadata-weight problems that are invisible in bits and
 * pieces: delete_log tombstone accrual (live tombstones only die via
 * rebuild/DROP — autovacuum cannot touch them), time-travel generation
 * buildup on refresh-in-place tables, append-only catalog snapshot
 * history, the orphaned-file reap backlog, and whether the maintenance
 * cron jobs are even installed.
 *
 * Every probe self-degrades (Promise.allSettled): a plain-Postgres
 * connection gets the vacuum section and nothing rvbbit-specific.
 */

import { getPool } from "./pool"

export interface MetaTableSize {
  name: string
  bytes: number
  rows: number
}

export interface TombstoneRow {
  oid: number
  schema: string | null
  table: string | null
  dropped: boolean
  tombstones: number
  /** reltuples estimate of the live table (null when dropped). */
  liveRows: number | null
}

export interface GenerationRow {
  oid: number
  schema: string | null
  table: string | null
  dropped: boolean
  generations: number
  newestAt: string | null
}

export interface VacuumRow {
  schema: string
  table: string
  dead: number
  live: number
  lastAutovacuum: string | null
  autovacuumCount: number
}

export interface CronJobRow {
  jobname: string
  schedule: string
  active: boolean
}

export interface SystemHealth {
  connectionId: string
  generatedAt: string
  hasRvbbit: boolean
  dbSizeBytes: number
  /** The rvbbit exhaust tables, largest first. */
  metaTables: MetaTableSize[]
  deleteLog: { totalRows: number; bytes: number; top: TombstoneRow[] } | null
  generations: { total: number; top: GenerationRow[] } | null
  catalog: {
    runs: number
    snapshotRows: number
    snapshotBytes: number
    oldestRunAt: string | null
    newestRunAt: string | null
  } | null
  orphaned: { backlog: number; erroring: number; oldestQueuedAt: string | null } | null
  vacuum: { top: VacuumRow[]; running: number }
  /** cron.* lives only in the pg_cron home database — on the app database
   *  this reads as readable=false, which is itself a finding. */
  cron: { readable: boolean; home: string | null; jobs: CronJobRow[] }
  /** Availability of the remedy functions on this extension version. */
  fns: Record<string, boolean>
}

// The known exhaust tables, in rough size order on churny deployments.
const META_TABLES = [
  "delete_log",
  "catalog_snapshots",
  "route_decisions",
  "route_executions",
  "embedding_cache",
  "kg_evidence",
  "kg_nodes",
  "generations",
  "row_groups",
  "cost_events",
  "receipts",
  "operator_test_runs",
]

const REMEDY_FNS: Record<string, string> = {
  rebuild_acceleration: "rvbbit.rebuild_acceleration(regclass,boolean)",
  reap_generations: "rvbbit.reap_generations(regclass,integer)",
  reap_orphaned_files: "rvbbit.reap_orphaned_files(interval,integer)",
  prune_delete_log: "rvbbit.prune_delete_log(integer)",
  install_maintenance_jobs: "rvbbit.install_maintenance_jobs(text,text,bigint)",
  maintenance_mode: "rvbbit.maintenance_mode(boolean)",
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}

export async function loadSystemHealth(connectionId: string): Promise<SystemHealth> {
  const { pool } = await getPool(connectionId, undefined, "meta")
  const client = await pool.connect()
  try {
    const q = (sql: string) =>
      client.query(sql).then(
        (r) => ({ ok: true as const, rows: r.rows as Array<Record<string, unknown>> }),
        () => ({ ok: false as const, rows: [] as Array<Record<string, unknown>> }),
      )

    const [ext, dbSize, meta, dlTotal, dlTop, gens, cat, orph, vac, vacRunning, cron, cronHome, fns] =
      await Promise.all([
        q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_rvbbit'`),
        q(`SELECT pg_database_size(current_database())::int8 AS b`),
        q(`SELECT c.relname AS name,
                  pg_total_relation_size(c.oid)::int8 AS bytes,
                  GREATEST(c.reltuples, 0)::int8 AS rows
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'rvbbit'
              AND c.relname = ANY(ARRAY[${META_TABLES.map((t) => `'${t}'`).join(",")}])
            ORDER BY pg_total_relation_size(c.oid) DESC`),
        q(`SELECT count(*)::int8 AS rows FROM rvbbit.delete_log`),
        q(`SELECT dl.table_oid::int8 AS oid,
                  n.nspname AS schema, c.relname AS table,
                  (c.oid IS NULL) AS dropped,
                  count(*)::int8 AS tombstones,
                  GREATEST(c.reltuples, 0)::int8 AS live_rows
             FROM rvbbit.delete_log dl
             LEFT JOIN pg_class c ON c.oid = dl.table_oid
             LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
            GROUP BY dl.table_oid, n.nspname, c.relname, c.oid, c.reltuples
            ORDER BY count(*) DESC
            LIMIT 15`),
        q(`SELECT g.table_oid::int8 AS oid,
                  n.nspname AS schema, c.relname AS table,
                  (c.oid IS NULL) AS dropped,
                  count(*)::int4 AS generations,
                  max(g.committed_at)::text AS newest_at
             FROM rvbbit.generations g
             LEFT JOIN pg_class c ON c.oid = g.table_oid
             LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
            GROUP BY g.table_oid, n.nspname, c.relname, c.oid
            ORDER BY count(*) DESC
            LIMIT 15`),
        q(`SELECT (SELECT count(*)::int4 FROM rvbbit.catalog_runs) AS runs,
                  (SELECT count(*)::int8 FROM rvbbit.catalog_snapshots) AS snapshot_rows,
                  (SELECT pg_total_relation_size('rvbbit.catalog_snapshots')::int8) AS snapshot_bytes,
                  (SELECT min(finished_at)::text FROM rvbbit.catalog_runs) AS oldest_run,
                  (SELECT max(finished_at)::text FROM rvbbit.catalog_runs) AS newest_run`),
        q(`SELECT count(*)::int8 AS backlog,
                  count(*) FILTER (WHERE attempts > 0 AND last_error IS NOT NULL)::int8 AS erroring,
                  min(queued_at)::text AS oldest
             FROM rvbbit.orphaned_files`),
        q(`SELECT schemaname AS schema, relname AS table,
                  n_dead_tup::int8 AS dead, n_live_tup::int8 AS live,
                  last_autovacuum::text AS last_av, autovacuum_count::int8 AS av_count
             FROM pg_stat_user_tables
            ORDER BY n_dead_tup DESC
            LIMIT 10`),
        q(`SELECT count(*)::int4 AS n FROM pg_stat_progress_vacuum`),
        q(`SELECT jobname, schedule, active FROM cron.job ORDER BY jobname`),
        q(`SELECT setting AS home FROM pg_settings WHERE name = 'cron.database_name'`),
        q(
          `SELECT ${Object.entries(REMEDY_FNS)
            .map(([k, sig]) => `(to_regprocedure('${sig}') IS NOT NULL) AS ${k}`)
            .join(", ")}`,
        ),
      ])

    const hasRvbbit = ext.ok && ext.rows.length > 0
    const fnRow = fns.ok ? (fns.rows[0] ?? {}) : {}

    return {
      connectionId,
      generatedAt: new Date().toISOString(),
      hasRvbbit,
      dbSizeBytes: dbSize.ok ? num(dbSize.rows[0]?.b) : 0,
      metaTables: meta.rows.map((r) => ({
        name: String(r.name),
        bytes: num(r.bytes),
        rows: num(r.rows),
      })),
      deleteLog: dlTotal.ok
        ? {
            totalRows: num(dlTotal.rows[0]?.rows),
            bytes: num(meta.rows.find((r) => r.name === "delete_log")?.bytes),
            top: dlTop.rows.map((r) => ({
              oid: num(r.oid),
              schema: str(r.schema),
              table: str(r.table),
              dropped: r.dropped === true,
              tombstones: num(r.tombstones),
              liveRows: r.dropped === true ? null : num(r.live_rows),
            })),
          }
        : null,
      generations: gens.ok
        ? {
            total: gens.rows.reduce((a, r) => a + num(r.generations), 0),
            top: gens.rows.map((r) => ({
              oid: num(r.oid),
              schema: str(r.schema),
              table: str(r.table),
              dropped: r.dropped === true,
              generations: num(r.generations),
              newestAt: str(r.newest_at),
            })),
          }
        : null,
      catalog: cat.ok
        ? {
            runs: num(cat.rows[0]?.runs),
            snapshotRows: num(cat.rows[0]?.snapshot_rows),
            snapshotBytes: num(cat.rows[0]?.snapshot_bytes),
            oldestRunAt: str(cat.rows[0]?.oldest_run),
            newestRunAt: str(cat.rows[0]?.newest_run),
          }
        : null,
      orphaned: orph.ok
        ? {
            backlog: num(orph.rows[0]?.backlog),
            erroring: num(orph.rows[0]?.erroring),
            oldestQueuedAt: str(orph.rows[0]?.oldest),
          }
        : null,
      vacuum: {
        top: vac.rows.map((r) => ({
          schema: String(r.schema),
          table: String(r.table),
          dead: num(r.dead),
          live: num(r.live),
          lastAutovacuum: str(r.last_av),
          autovacuumCount: num(r.av_count),
        })),
        running: vacRunning.ok ? num(vacRunning.rows[0]?.n) : 0,
      },
      cron: {
        readable: cron.ok,
        home: cronHome.ok ? str(cronHome.rows[0]?.home) : null,
        jobs: cron.rows.map((r) => ({
          jobname: String(r.jobname),
          schedule: String(r.schedule),
          active: r.active === true || r.active === "t",
        })),
      },
      fns: Object.fromEntries(Object.keys(REMEDY_FNS).map((k) => [k, fnRow[k] === true])),
    }
  } finally {
    client.release()
  }
}

// ─── Remediation script generation ──────────────────────────────────
//
// Scripts are REVIEWABLE artifacts: one statement per line, ordered by
// impact, with the numbers that justified each line in a trailing
// comment. The lens SQL window runs multi-statement scripts serially,
// which is exactly right for rebuilds — no giant wrapping transaction.

export type MaintenanceScriptKind =
  | "rebuild"
  | "reap-generations"
  | "snapshots-retention"
  | "orphaned-files"
  | "vacuum-metadata"
  | "install-jobs"

export interface MaintenanceScriptParams {
  schemaLike?: string
  minTombstones?: number
  minGenerations?: number
  keepDays?: number
  keepRuns?: number
  limit?: number
}

function qident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}
function qlit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
function fmtCount(n: number): string {
  return n.toLocaleString("en-US")
}

const REVIEW_HEADER = (title: string) =>
  `-- RVBBIT maintenance · ${title}
-- Generated by System Health. REVIEW before running.
-- Statements run one at a time in this window — safe to stop midway.
`

export async function buildMaintenanceScript(
  connectionId: string,
  kind: MaintenanceScriptKind,
  p: MaintenanceScriptParams,
): Promise<{ sql: string; statements: number }> {
  const { pool } = await getPool(connectionId, undefined, "meta")
  const client = await pool.connect()
  try {
    const schemaLike = p.schemaLike?.trim() || "%"
    const limit = Math.min(Math.max(p.limit ?? 500, 1), 5000)

    if (kind === "rebuild") {
      const minTombstones = Math.max(p.minTombstones ?? 1_000_000, 1)
      const res = await client.query(
        `SELECT n.nspname AS schema, c.relname AS table, count(*)::int8 AS tombstones
           FROM rvbbit.delete_log dl
           JOIN pg_class c ON c.oid = dl.table_oid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname LIKE $1
          GROUP BY n.nspname, c.relname
         HAVING count(*) >= $2
          ORDER BY count(*) DESC
          LIMIT $3`,
        [schemaLike, minTombstones, limit],
      )
      const lines = res.rows.length
        ? res.rows.map(
            (r) =>
              `SELECT rvbbit.rebuild_acceleration('${qident(String(r.schema))}.${qident(String(r.table))}'::regclass, true);  -- ${fmtCount(Number(r.tombstones))} tombstones`,
          )
        : ["-- (no tables matched the filter — nothing to rebuild)"]
      const sql = `${REVIEW_HEADER(`rebuild ${res.rows.length} tables (schema LIKE ${qlit(schemaLike)}, tombstones >= ${fmtCount(minTombstones)})`)}
-- Rebuild rewrites each table's accelerated storage into a fresh generation
-- and clears its delete_log tombstones — the ONLY way live tombstones die.
-- Run in a quiet window: pause churny refresh crons first, and rebuild
-- serially (never two at once — rebuild takes no advisory lock).
--
-- SELECT rvbbit.maintenance_mode(true);   -- optional: pause background machinery

${lines.join("\n")}

-- SELECT rvbbit.maintenance_mode(false);  -- if paused above
-- Reclaim delete_log space for reuse:
VACUUM (ANALYZE) rvbbit.delete_log;
-- To hand disk back to the OS (ACCESS EXCLUSIVE lock — quiet window only):
-- VACUUM FULL rvbbit.delete_log;
`
      return { sql, statements: lines.length + 1 }
    }

    if (kind === "reap-generations") {
      const keepDays = Math.max(p.keepDays ?? 7, 1)
      const minGenerations = Math.max(p.minGenerations ?? 20, 2)
      const res = await client.query(
        `SELECT n.nspname AS schema, c.relname AS table, count(*)::int4 AS generations
           FROM rvbbit.generations g
           JOIN pg_class c ON c.oid = g.table_oid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname LIKE $1
          GROUP BY n.nspname, c.relname
         HAVING count(*) >= $2
          ORDER BY count(*) DESC
          LIMIT $3`,
        [schemaLike, minGenerations, limit],
      )
      const lines = res.rows.length
        ? res.rows.map(
            (r) =>
              `SELECT rvbbit.reap_generations('${qident(String(r.schema))}.${qident(String(r.table))}'::regclass, ${keepDays});  -- ${fmtCount(Number(r.generations))} generations`,
          )
        : ["-- (no tables matched the filter — nothing to reap)"]
      const sql = `${REVIEW_HEADER(`trim time-travel history on ${res.rows.length} tables (keep ${keepDays} days; schema LIKE ${qlit(schemaLike)}, generations >= ${minGenerations})`)}
-- Old generations = old parquet on disk. Derived tables (cubes, ETL
-- refresh-in-place targets) rarely need deep AS-OF history.

${lines.join("\n")}

-- Reaped generations queue their files for deletion — unlink them now:
SELECT rvbbit.reap_orphaned_files(interval '0', 100000);
`
      return { sql, statements: lines.length + 1 }
    }

    if (kind === "snapshots-retention") {
      const keepRuns = Math.max(p.keepRuns ?? 15, 2)
      const sql = `${REVIEW_HEADER(`catalog snapshot retention (keep newest ${keepRuns} runs)`)}
-- catalog_snapshots is append-only crawl history. Drift needs the latest
-- two OK runs; the Finder's drift/history windows read a modest tail.
-- Everything older is pure weight.

DELETE FROM rvbbit.catalog_snapshots
 WHERE run_id NOT IN (
   SELECT run_id FROM rvbbit.catalog_runs
    ORDER BY finished_at DESC NULLS LAST
    LIMIT ${keepRuns});

VACUUM (ANALYZE) rvbbit.catalog_snapshots;
-- To hand disk back to the OS (ACCESS EXCLUSIVE lock — quiet window only):
-- VACUUM FULL rvbbit.catalog_snapshots;
`
      return { sql, statements: 3 }
    }

    if (kind === "orphaned-files") {
      const sql = `${REVIEW_HEADER("reap orphaned accelerator files")}
-- Files queued by reaps/compactions that still exist on disk. Reaping
-- unlinks them; rows clear as files are removed.

SELECT rvbbit.reap_orphaned_files(interval '1 hour', 100000);
`
      return { sql, statements: 1 }
    }

    if (kind === "vacuum-metadata") {
      const lines = META_TABLES.map((t) => `VACUUM (ANALYZE) rvbbit.${t};`)
      const sql = `${REVIEW_HEADER("vacuum the rvbbit metadata tables")}
${lines.join("\n")}

-- VACUUM FULL variants reclaim disk for the OS but take ACCESS EXCLUSIVE:
${META_TABLES.map((t) => `-- VACUUM FULL rvbbit.${t};`).join("\n")}
`
      return { sql, statements: lines.length }
    }

    // install-jobs — cron.* is only callable in pg_cron's home database.
    // The home is a server-wide GUC readable from anywhere, so build the
    // right script for where the user actually is instead of letting
    // install_maintenance_jobs() bounce with pg_cron_not_home_db.
    const info = await client.query<{ db: string; cron_home: string | null }>(
      `SELECT current_database() AS db,
              (SELECT setting FROM pg_settings WHERE name = 'cron.database_name') AS cron_home`,
    )
    const db = String(info.rows[0]?.db ?? "")
    const cronHome = info.rows[0]?.cron_home ?? null

    if (cronHome && cronHome !== db) {
      const sql = `${REVIEW_HEADER("install the metadata maintenance cron jobs (cross-database)")}
-- pg_cron's home database is ${qlit(cronHome)} — cron.* is ONLY callable there.
--
--   >>> RUN THIS SCRIPT CONNECTED TO THE ${qlit(cronHome)} DATABASE <<<
--
-- (In Data Rabbit: switch to / add a connection for ${qlit(cronHome)} on this
--  server, open a SQL window there, and paste this. Or: psql -d ${cronHome})
-- The jobs it schedules will EXECUTE in ${qlit(db)} — that part is correct.
--
-- Symptom decoder:
--   "schema cron does not exist"  -> you're still connected to ${qlit(db)}; switch.
--   "can only be created in ..."  -> wrong database for the extension; switch.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule_in_database('rvbbit-maintain', '*/15 * * * *', 'SELECT rvbbit.maintain();', ${qlit(db)});
SELECT cron.schedule_in_database('rvbbit-storage-maintain', '0 * * * *', 'SELECT rvbbit.maintain(storage_tables => 2);', ${qlit(db)});

-- Runnable right now in ${qlit(db)} (one manual maintenance pass, no cron):
-- SELECT rvbbit.maintain();
`
      return { sql, statements: 2 }
    }

    const sql = `${REVIEW_HEADER("install the metadata maintenance cron jobs")}
-- Schedules the recurring vacuum/prune machinery (defaults: maintenance
-- every 15 min, storage sweep hourly).

SELECT rvbbit.install_maintenance_jobs();
`
    return { sql, statements: 1 }
  } finally {
    client.release()
  }
}
