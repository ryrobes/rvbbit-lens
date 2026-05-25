import "server-only"

import { getPool } from "./pool"

/**
 * Postgres "vital signs" snapshot.
 *
 * One round-trip to the database fires every monitor poll. The
 * counters here are *cumulative* (since stats reset / postmaster
 * start) — the client maintains a ring buffer of recent snapshots
 * and derives per-second rates as deltas between consecutive
 * samples. This keeps the server query cheap and stateless.
 *
 * Anything rvbbit-specific is gated on a single `EXISTS` check
 * against `pg_extension` so the route Just Works on plain Postgres.
 */

export interface PgStatsSnapshot {
  timestamp: string
  database: DatabaseInfo
  cumulative: CumulativeCounters
  activity: ActivitySnapshot
  wal: WalSnapshot | null
  topTables: UserTableRow[]
  locks: LockSnapshot
  rvbbit: RvbbitSnapshot | null
}

export interface DatabaseInfo {
  name: string
  version: string
  size_bytes: number
  size_pretty: string
  started_at: string
  uptime_seconds: number
  current_user: string
  max_connections: number
  shared_buffers: string
}

export interface CumulativeCounters {
  xact_commit: number
  xact_rollback: number
  blks_read: number
  blks_hit: number
  tup_returned: number
  tup_fetched: number
  tup_inserted: number
  tup_updated: number
  tup_deleted: number
  deadlocks: number
  temp_files: number
  temp_bytes: number
  conflicts: number
  blk_read_time: number
  blk_write_time: number
}

export interface ActivityRow {
  pid: number
  state: string | null
  application_name: string | null
  client_addr: string | null
  backend_type: string | null
  wait_event_type: string | null
  wait_event: string | null
  query_start_ms_ago: number | null
  xact_start_ms_ago: number | null
  query_preview: string | null
}

export interface ActivitySnapshot {
  total: number
  active: number
  idle: number
  idle_in_transaction: number
  waiting: number
  by_backend_type: Record<string, number>
  longest_active_ms: number
  rows: ActivityRow[]
}

export interface WalSnapshot {
  wal_records: number
  wal_fpi: number
  wal_bytes: number
}

export interface UserTableRow {
  schema: string
  table: string
  size_bytes: number
  n_live_tup: number
  n_dead_tup: number
  seq_scan: number
  idx_scan: number
  n_tup_ins: number
  n_tup_upd: number
  n_tup_del: number
  last_vacuum: string | null
  last_analyze: string | null
}

export interface LockSnapshot {
  total: number
  waiting: number
  by_mode: Record<string, number>
}

export interface RvbbitOperatorRow {
  operator: string
  model: string
  calls: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  avg_latency_ms: number
}

export interface RvbbitSnapshot {
  total_calls: number
  total_tokens_in: number
  total_tokens_out: number
  total_cost_usd: number
  recent_calls: number   // last 60 seconds
  recent_tokens_in: number
  recent_tokens_out: number
  receipts_total: number
  embedding_cache_total: number
  bitmap_total: number
  specialist_count: number
  operators: RvbbitOperatorRow[]
}

// ── SQL ─────────────────────────────────────────────────────────────

const DB_INFO_SQL = `
SELECT
  d.datname                                          AS name,
  current_setting('server_version')                  AS version,
  pg_database_size(d.datname)::bigint                AS size_bytes,
  pg_size_pretty(pg_database_size(d.datname))        AS size_pretty,
  pg_postmaster_start_time()                         AS started_at,
  extract(epoch from now() - pg_postmaster_start_time())::int8 AS uptime_seconds,
  current_user                                       AS current_user,
  current_setting('max_connections')::int4           AS max_connections,
  current_setting('shared_buffers')                  AS shared_buffers
FROM pg_database d
WHERE d.datname = current_database()
`

const DB_STAT_SQL = `
SELECT
  xact_commit::bigint, xact_rollback::bigint,
  blks_read::bigint, blks_hit::bigint,
  tup_returned::bigint, tup_fetched::bigint,
  tup_inserted::bigint, tup_updated::bigint, tup_deleted::bigint,
  deadlocks::bigint, temp_files::bigint, temp_bytes::bigint,
  conflicts::bigint,
  blk_read_time::float8, blk_write_time::float8
FROM pg_stat_database
WHERE datname = current_database()
`

const ACTIVITY_SUMMARY_SQL = `
WITH a AS (SELECT * FROM pg_stat_activity)
SELECT
  (SELECT count(*)::int4 FROM a)                                                       AS total,
  (SELECT count(*)::int4 FROM a WHERE state = 'active' AND backend_type = 'client backend') AS active,
  (SELECT count(*)::int4 FROM a WHERE state = 'idle' AND backend_type = 'client backend')   AS idle,
  (SELECT count(*)::int4 FROM a WHERE state = 'idle in transaction' AND backend_type = 'client backend') AS idle_in_transaction,
  (SELECT count(*)::int4 FROM a WHERE wait_event_type IS NOT NULL AND backend_type = 'client backend')   AS waiting,
  (SELECT coalesce(extract(epoch from max(now() - query_start))::float8 * 1000, 0)
   FROM a WHERE state = 'active' AND backend_type = 'client backend')                  AS longest_active_ms,
  (SELECT jsonb_object_agg(backend_type, cnt)
   FROM (SELECT backend_type, count(*)::int4 AS cnt FROM a WHERE backend_type IS NOT NULL GROUP BY backend_type) z) AS by_backend_type
`

const ACTIVITY_ROWS_SQL = `
SELECT
  pid,
  state,
  application_name,
  client_addr::text AS client_addr,
  backend_type,
  wait_event_type,
  wait_event,
  CASE WHEN query_start IS NOT NULL
       THEN (extract(epoch from now() - query_start) * 1000)::int8
       ELSE NULL END AS query_start_ms_ago,
  CASE WHEN xact_start IS NOT NULL
       THEN (extract(epoch from now() - xact_start) * 1000)::int8
       ELSE NULL END AS xact_start_ms_ago,
  left(query, 200) AS query_preview
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND pid <> pg_backend_pid()
ORDER BY
  CASE state WHEN 'active' THEN 0 WHEN 'idle in transaction' THEN 1 WHEN 'idle' THEN 2 ELSE 3 END,
  query_start ASC NULLS LAST
LIMIT 25
`

const WAL_SQL = `
SELECT
  wal_records::bigint   AS wal_records,
  wal_fpi::bigint       AS wal_fpi,
  wal_bytes::float8     AS wal_bytes
FROM pg_stat_wal
`

const TOP_TABLES_SQL = `
SELECT
  s.schemaname                              AS schema,
  s.relname                                 AS "table",
  coalesce(pg_total_relation_size(c.oid), 0)::bigint AS size_bytes,
  coalesce(s.n_live_tup, 0)::bigint         AS n_live_tup,
  coalesce(s.n_dead_tup, 0)::bigint         AS n_dead_tup,
  coalesce(s.seq_scan, 0)::bigint           AS seq_scan,
  coalesce(s.idx_scan, 0)::bigint           AS idx_scan,
  coalesce(s.n_tup_ins, 0)::bigint          AS n_tup_ins,
  coalesce(s.n_tup_upd, 0)::bigint          AS n_tup_upd,
  coalesce(s.n_tup_del, 0)::bigint          AS n_tup_del,
  s.last_vacuum,
  s.last_analyze
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
ORDER BY pg_total_relation_size(c.oid) DESC NULLS LAST
LIMIT 12
`

const LOCKS_SQL = `
SELECT
  (SELECT count(*)::int4 FROM pg_locks)                          AS total,
  (SELECT count(*)::int4 FROM pg_locks WHERE NOT granted)        AS waiting,
  (SELECT jsonb_object_agg(mode, cnt)
   FROM (SELECT mode, count(*)::int4 AS cnt FROM pg_locks GROUP BY mode) z) AS by_mode
`

const RVBBIT_EXISTS_SQL = `
SELECT EXISTS (
  SELECT 1 FROM pg_extension WHERE extname IN ('rvbbit','pg_rvbbit')
) AS has_rvbbit
`

const RVBBIT_TOTALS_SQL = `
SELECT
  count(*)::bigint                                  AS receipts_total,
  coalesce(sum(n_tokens_in), 0)::bigint             AS total_tokens_in,
  coalesce(sum(n_tokens_out), 0)::bigint            AS total_tokens_out,
  coalesce(sum(cost_usd), 0)::float8                AS total_cost_usd,
  count(*) FILTER (WHERE invocation_at > now() - interval '60 seconds')::bigint
                                                    AS recent_calls,
  coalesce(sum(n_tokens_in) FILTER (WHERE invocation_at > now() - interval '60 seconds'), 0)::bigint
                                                    AS recent_tokens_in,
  coalesce(sum(n_tokens_out) FILTER (WHERE invocation_at > now() - interval '60 seconds'), 0)::bigint
                                                    AS recent_tokens_out
FROM rvbbit.receipts
`

const RVBBIT_OPERATORS_SQL = `
SELECT
  operator,
  model,
  count(*)::bigint                                  AS calls,
  coalesce(sum(n_tokens_in), 0)::bigint             AS tokens_in,
  coalesce(sum(n_tokens_out), 0)::bigint            AS tokens_out,
  coalesce(sum(cost_usd), 0)::float8                AS cost_usd,
  coalesce(avg(latency_ms), 0)::float8              AS avg_latency_ms
FROM rvbbit.receipts
GROUP BY operator, model
ORDER BY calls DESC
LIMIT 12
`

const RVBBIT_CARDS_SQL = `
SELECT
  (SELECT count(*) FROM rvbbit.embedding_cache)::bigint AS embedding_cache_total,
  (SELECT count(*) FROM rvbbit.semantic_bitmaps)::bigint AS bitmap_total,
  (SELECT count(*) FROM rvbbit.backends)::int4          AS specialist_count
`

// ── Executor ────────────────────────────────────────────────────────

export async function fetchPgStats(connectionId: string): Promise<PgStatsSnapshot> {
  const { pool } = await getPool(connectionId)

  // Most queries hit shared-memory views (microseconds); they run in
  // parallel across separate pooled connections. WAL stats require
  // PG14+; we treat absence as null.
  const [dbInfo, dbStat, summary, rows, wal, tables, locks, rvbbitExt] = await Promise.all([
    pool.query(DB_INFO_SQL),
    pool.query(DB_STAT_SQL),
    pool.query(ACTIVITY_SUMMARY_SQL),
    pool.query(ACTIVITY_ROWS_SQL),
    pool.query(WAL_SQL).catch(() => null),
    pool.query(TOP_TABLES_SQL),
    pool.query(LOCKS_SQL),
    pool.query(RVBBIT_EXISTS_SQL),
  ])

  const hasRvbbit = !!rvbbitExt.rows[0]?.has_rvbbit
  let rvbbit: RvbbitSnapshot | null = null
  if (hasRvbbit) {
    try {
      const [totals, operators, cards] = await Promise.all([
        pool.query(RVBBIT_TOTALS_SQL),
        pool.query(RVBBIT_OPERATORS_SQL),
        pool.query(RVBBIT_CARDS_SQL),
      ])
      const t = totals.rows[0] ?? {}
      const c = cards.rows[0] ?? {}
      rvbbit = {
        total_calls: Number(t.receipts_total ?? 0),
        total_tokens_in: Number(t.total_tokens_in ?? 0),
        total_tokens_out: Number(t.total_tokens_out ?? 0),
        total_cost_usd: Number(t.total_cost_usd ?? 0),
        recent_calls: Number(t.recent_calls ?? 0),
        recent_tokens_in: Number(t.recent_tokens_in ?? 0),
        recent_tokens_out: Number(t.recent_tokens_out ?? 0),
        receipts_total: Number(t.receipts_total ?? 0),
        embedding_cache_total: Number(c.embedding_cache_total ?? 0),
        bitmap_total: Number(c.bitmap_total ?? 0),
        specialist_count: Number(c.specialist_count ?? 0),
        operators: operators.rows.map((r) => ({
          operator: String(r.operator),
          model: String(r.model),
          calls: Number(r.calls),
          tokens_in: Number(r.tokens_in),
          tokens_out: Number(r.tokens_out),
          cost_usd: Number(r.cost_usd),
          avg_latency_ms: Number(r.avg_latency_ms),
        })),
      }
    } catch {
      // rvbbit schema may exist but tables not yet seeded — degrade silently
      rvbbit = null
    }
  }

  const dbRow = dbInfo.rows[0]
  const statRow = dbStat.rows[0] ?? {}
  const sum = summary.rows[0] ?? {}
  const lock = locks.rows[0] ?? {}
  const walRow = wal?.rows[0]

  return {
    timestamp: new Date().toISOString(),
    database: {
      name: String(dbRow.name),
      version: String(dbRow.version),
      size_bytes: Number(dbRow.size_bytes ?? 0),
      size_pretty: String(dbRow.size_pretty),
      started_at: String(dbRow.started_at),
      uptime_seconds: Number(dbRow.uptime_seconds ?? 0),
      current_user: String(dbRow.current_user),
      max_connections: Number(dbRow.max_connections),
      shared_buffers: String(dbRow.shared_buffers),
    },
    cumulative: {
      xact_commit: Number(statRow.xact_commit ?? 0),
      xact_rollback: Number(statRow.xact_rollback ?? 0),
      blks_read: Number(statRow.blks_read ?? 0),
      blks_hit: Number(statRow.blks_hit ?? 0),
      tup_returned: Number(statRow.tup_returned ?? 0),
      tup_fetched: Number(statRow.tup_fetched ?? 0),
      tup_inserted: Number(statRow.tup_inserted ?? 0),
      tup_updated: Number(statRow.tup_updated ?? 0),
      tup_deleted: Number(statRow.tup_deleted ?? 0),
      deadlocks: Number(statRow.deadlocks ?? 0),
      temp_files: Number(statRow.temp_files ?? 0),
      temp_bytes: Number(statRow.temp_bytes ?? 0),
      conflicts: Number(statRow.conflicts ?? 0),
      blk_read_time: Number(statRow.blk_read_time ?? 0),
      blk_write_time: Number(statRow.blk_write_time ?? 0),
    },
    activity: {
      total: Number(sum.total ?? 0),
      active: Number(sum.active ?? 0),
      idle: Number(sum.idle ?? 0),
      idle_in_transaction: Number(sum.idle_in_transaction ?? 0),
      waiting: Number(sum.waiting ?? 0),
      longest_active_ms: Number(sum.longest_active_ms ?? 0),
      by_backend_type: (sum.by_backend_type ?? {}) as Record<string, number>,
      rows: rows.rows.map((r) => ({
        pid: Number(r.pid),
        state: r.state ?? null,
        application_name: r.application_name ?? null,
        client_addr: r.client_addr ?? null,
        backend_type: r.backend_type ?? null,
        wait_event_type: r.wait_event_type ?? null,
        wait_event: r.wait_event ?? null,
        query_start_ms_ago: r.query_start_ms_ago == null ? null : Number(r.query_start_ms_ago),
        xact_start_ms_ago: r.xact_start_ms_ago == null ? null : Number(r.xact_start_ms_ago),
        query_preview: r.query_preview ?? null,
      })),
    },
    wal: walRow
      ? {
          wal_records: Number(walRow.wal_records ?? 0),
          wal_fpi: Number(walRow.wal_fpi ?? 0),
          wal_bytes: Number(walRow.wal_bytes ?? 0),
        }
      : null,
    topTables: tables.rows.map((r) => ({
      schema: String(r.schema),
      table: String(r.table),
      size_bytes: Number(r.size_bytes ?? 0),
      n_live_tup: Number(r.n_live_tup ?? 0),
      n_dead_tup: Number(r.n_dead_tup ?? 0),
      seq_scan: Number(r.seq_scan ?? 0),
      idx_scan: Number(r.idx_scan ?? 0),
      n_tup_ins: Number(r.n_tup_ins ?? 0),
      n_tup_upd: Number(r.n_tup_upd ?? 0),
      n_tup_del: Number(r.n_tup_del ?? 0),
      last_vacuum: r.last_vacuum ? new Date(r.last_vacuum).toISOString() : null,
      last_analyze: r.last_analyze ? new Date(r.last_analyze).toISOString() : null,
    })),
    locks: {
      total: Number(lock.total ?? 0),
      waiting: Number(lock.waiting ?? 0),
      by_mode: (lock.by_mode ?? {}) as Record<string, number>,
    },
    rvbbit,
  }
}
