import "server-only"

import { getPool } from "./pool"

export interface MvccExplorerSettings {
  autovacuum: boolean
  trackCounts: boolean
  vacuumThreshold: number
  vacuumScaleFactor: number
  vacuumMaxThreshold: number | null
  insertThreshold: number
  insertScaleFactor: number
  freezeMaxAge: number
  multixactFreezeMaxAge: number
}

export interface MvccExplorerPermissions {
  fullActivity: boolean
  signalBackend: boolean
  pgstattuple: boolean
  pageinspect: boolean
}

export interface MvccExplorerDatabaseAge {
  frozenXid: string
  frozenXidAge: number
  minMultiXid: string
  minMultiXidAge: number
}

export interface MvccExplorerSession {
  pid: number
  backendStart: string
  backendType: string | null
  user: string | null
  database: string | null
  applicationName: string | null
  clientAddr: string | null
  state: string | null
  transactionStart: string | null
  stateChange: string | null
  backendXid: string | null
  backendXidAge: number | null
  backendXmin: string | null
  backendXminAge: number | null
  waitEventType: string | null
  waitEvent: string | null
  query: string | null
}

export interface MvccExplorerReplicationSlot {
  slotName: string
  slotType: string
  plugin: string | null
  database: string | null
  active: boolean
  activePid: number | null
  xmin: string | null
  xminAge: number | null
  catalogXmin: string | null
  catalogXminAge: number | null
  restartLsn: string | null
}

export interface MvccExplorerPreparedTransaction {
  transactionId: string
  transactionAge: number
  gid: string
  preparedAt: string
  owner: string
  database: string
}

export interface MvccExplorerTable {
  oid: string
  schema: string
  name: string
  relationKind: string
  estimatedRows: number
  liveTuples: number
  deadTuples: number
  modifiedSinceAnalyze: number
  insertsSinceVacuum: number
  heapBytesEstimate: number
  pages: number
  allVisiblePages: number
  frozenXid: string
  frozenXidAge: number
  minMultiXid: string
  minMultiXidAge: number
  autovacuumEnabled: boolean
  vacuumTrigger: number
  vacuumPressure: number
  insertTrigger: number
  insertPressure: number
  freezeMaxAge: number
  freezePressure: number
  multixactFreezeMaxAge: number
  multixactFreezePressure: number
  lastVacuum: string | null
  lastAutovacuum: string | null
  lastAnalyze: string | null
  lastAutoanalyze: string | null
  vacuumCount: number
  autovacuumCount: number
  analyzeCount: number
  autoanalyzeCount: number
}

export interface MvccExplorerVacuumWorker {
  pid: number
  database: string
  relationOid: string
  schema: string | null
  table: string | null
  phase: string
  heapBlocksTotal: number
  heapBlocksScanned: number
  heapBlocksVacuumed: number
  indexVacuumCount: number
  maxDeadTupleBytes: number | null
  deadTupleBytes: number | null
  deadItemIds: number | null
  indexesTotal: number | null
  indexesProcessed: number | null
  delayMs: number | null
}

export interface MvccExplorerSnapshot {
  sampledAt: string
  connectionId: string
  connectionLabel: string
  database: string
  currentUser: string
  serverVersion: string
  serverVersionNum: number
  observerPid: number
  statsReset: string | null
  settings: MvccExplorerSettings
  permissions: MvccExplorerPermissions
  databaseAge: MvccExplorerDatabaseAge
  sessions: MvccExplorerSession[]
  replicationSlots: MvccExplorerReplicationSlot[]
  preparedTransactions: MvccExplorerPreparedTransaction[]
  tables: MvccExplorerTable[]
  vacuumWorkers: MvccExplorerVacuumWorker[]
}

interface MetaRow {
  observer_pid: number
  database: string
  current_user_name: string
  server_version: string
  server_version_num: number | string
  full_activity: boolean
  signal_backend: boolean
  has_pgstattuple: boolean
  has_pageinspect: boolean
  stats_reset: Date | string | null
  autovacuum: boolean
  track_counts: boolean
  vacuum_threshold: number | string
  vacuum_scale_factor: number | string
  vacuum_max_threshold: number | string | null
  insert_threshold: number | string
  insert_scale_factor: number | string
  freeze_max_age: number | string
  multixact_freeze_max_age: number | string
  datfrozenxid: string
  datfrozenxid_age: number | string
  datminmxid: string
  datminmxid_age: number | string
}

interface SessionRow {
  pid: number
  backend_start: string
  backend_type: string | null
  usename: string | null
  datname: string | null
  application_name: string | null
  client_addr: string | null
  state: string | null
  xact_start: Date | string | null
  state_change: Date | string | null
  backend_xid: string | null
  backend_xid_age: number | string | null
  backend_xmin: string | null
  backend_xmin_age: number | string | null
  wait_event_type: string | null
  wait_event: string | null
  query: string | null
}

interface SlotRow {
  slot_name: string
  slot_type: string
  plugin: string | null
  database: string | null
  active: boolean
  active_pid: number | null
  xmin: string | null
  xmin_age: number | string | null
  catalog_xmin: string | null
  catalog_xmin_age: number | string | null
  restart_lsn: string | null
}

interface PreparedRow {
  transaction_id: string
  transaction_age: number | string
  gid: string
  prepared_at: Date | string
  owner: string
  database: string
}

interface TableRow {
  oid: string
  schema_name: string
  relation_name: string
  relation_kind: string
  estimated_rows: number | string
  live_tuples: number | string
  dead_tuples: number | string
  modified_since_analyze: number | string
  inserts_since_vacuum: number | string
  heap_bytes_estimate: number | string
  pages: number | string
  all_visible_pages: number | string
  frozen_xid: string
  frozen_xid_age: number | string
  min_multi_xid: string
  min_multi_xid_age: number | string
  autovacuum_enabled: boolean
  vacuum_trigger: number | string
  vacuum_pressure: number | string
  insert_trigger: number | string
  insert_pressure: number | string
  freeze_max_age: number | string
  freeze_pressure: number | string
  multixact_freeze_max_age: number | string
  multixact_freeze_pressure: number | string
  last_vacuum: Date | string | null
  last_autovacuum: Date | string | null
  last_analyze: Date | string | null
  last_autoanalyze: Date | string | null
  vacuum_count: number | string
  autovacuum_count: number | string
  analyze_count: number | string
  autoanalyze_count: number | string
}

interface WorkerRow {
  pid: number
  datname: string
  relid: string
  schema_name: string | null
  relation_name: string | null
  phase: string
  heap_blks_total: number | string
  heap_blks_scanned: number | string
  heap_blks_vacuumed: number | string
  index_vacuum_count: number | string
  max_dead_tuple_bytes: number | string | null
  dead_tuple_bytes: number | string | null
  num_dead_item_ids: number | string | null
  indexes_total: number | string | null
  indexes_processed: number | string | null
  delay_time: number | string | null
}

const META_SQL = `
SELECT pg_backend_pid() AS observer_pid,
       current_database() AS database,
       current_user AS current_user_name,
       current_setting('server_version') AS server_version,
       current_setting('server_version_num')::int AS server_version_num,
       (
         coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
         OR pg_has_role(current_user, 'pg_monitor', 'MEMBER')
         OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
       ) AS full_activity,
       (
         coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
         OR pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')
       ) AS signal_backend,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') AS has_pgstattuple,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pageinspect') AS has_pageinspect,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
       current_setting('autovacuum')::boolean AS autovacuum,
       current_setting('track_counts')::boolean AS track_counts,
       current_setting('autovacuum_vacuum_threshold')::double precision AS vacuum_threshold,
       current_setting('autovacuum_vacuum_scale_factor')::double precision AS vacuum_scale_factor,
       nullif(current_setting('autovacuum_vacuum_max_threshold', true), '')::double precision AS vacuum_max_threshold,
       current_setting('autovacuum_vacuum_insert_threshold')::double precision AS insert_threshold,
       current_setting('autovacuum_vacuum_insert_scale_factor')::double precision AS insert_scale_factor,
       current_setting('autovacuum_freeze_max_age')::double precision AS freeze_max_age,
       current_setting('autovacuum_multixact_freeze_max_age')::double precision AS multixact_freeze_max_age,
       d.datfrozenxid::text AS datfrozenxid,
       age(d.datfrozenxid)::bigint AS datfrozenxid_age,
       d.datminmxid::text AS datminmxid,
       mxid_age(d.datminmxid)::bigint AS datminmxid_age
FROM pg_database d
WHERE d.datname = current_database()
`

const SESSIONS_SQL = `
SELECT pid,
       to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
       backend_type,
       usename,
       datname,
       application_name,
       client_addr::text AS client_addr,
       state,
       xact_start,
       state_change,
       backend_xid::text AS backend_xid,
       CASE WHEN backend_xid IS NULL THEN NULL ELSE age(backend_xid)::bigint END AS backend_xid_age,
       backend_xmin::text AS backend_xmin,
       CASE WHEN backend_xmin IS NULL THEN NULL ELSE age(backend_xmin)::bigint END AS backend_xmin_age,
       wait_event_type,
       wait_event,
       left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 2000) AS query
FROM pg_stat_activity
WHERE pid <> $1
  AND backend_type = 'client backend'
ORDER BY backend_xmin_age DESC NULLS LAST, xact_start ASC NULLS LAST, pid
`

const SLOTS_SQL = `
SELECT slot_name,
       slot_type,
       plugin,
       database,
       active,
       active_pid,
       xmin::text AS xmin,
       CASE WHEN xmin IS NULL THEN NULL ELSE age(xmin)::bigint END AS xmin_age,
       catalog_xmin::text AS catalog_xmin,
       CASE WHEN catalog_xmin IS NULL THEN NULL ELSE age(catalog_xmin)::bigint END AS catalog_xmin_age,
       restart_lsn::text AS restart_lsn
FROM pg_replication_slots
ORDER BY greatest(coalesce(age(xmin), 0), coalesce(age(catalog_xmin), 0)) DESC, slot_name
`

const PREPARED_SQL = `
SELECT transaction::text AS transaction_id,
       age(transaction)::bigint AS transaction_age,
       gid,
       prepared AS prepared_at,
       owner,
       database
FROM pg_prepared_xacts
ORDER BY transaction_age DESC, prepared
`

const TABLES_SQL = `
WITH relations AS (
  SELECT c.oid,
         n.nspname AS schema_name,
         c.relname AS relation_name,
         c.relkind::text AS relation_kind,
         greatest(c.reltuples, 0)::double precision AS estimated_rows,
         greatest(c.relpages, 0)::bigint AS pages,
         greatest(c.relallvisible, 0)::bigint AS all_visible_pages,
         c.relfrozenxid,
         c.relminmxid,
         s.n_live_tup::bigint AS live_tuples,
         s.n_dead_tup::bigint AS dead_tuples,
         s.n_mod_since_analyze::bigint AS modified_since_analyze,
         coalesce((to_jsonb(s)->>'n_ins_since_vacuum')::bigint, 0) AS inserts_since_vacuum,
         s.last_vacuum,
         s.last_autovacuum,
         s.last_analyze,
         s.last_autoanalyze,
         s.vacuum_count::bigint AS vacuum_count,
         s.autovacuum_count::bigint AS autovacuum_count,
         s.analyze_count::bigint AS analyze_count,
         s.autoanalyze_count::bigint AS autoanalyze_count,
         opts.autovacuum_enabled,
         opts.vacuum_threshold,
         opts.vacuum_scale_factor,
         opts.vacuum_insert_threshold,
         opts.vacuum_insert_scale_factor,
         opts.freeze_max_age,
         opts.multixact_freeze_max_age
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid AND c.relkind IN ('r', 'm')
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL (
    SELECT max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_enabled=%') AS autovacuum_enabled,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_vacuum_threshold=%') AS vacuum_threshold,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_vacuum_scale_factor=%') AS vacuum_scale_factor,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_vacuum_insert_threshold=%') AS vacuum_insert_threshold,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_vacuum_insert_scale_factor=%') AS vacuum_insert_scale_factor,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_freeze_max_age=%') AS freeze_max_age,
           max(split_part(option, '=', 2)) FILTER (WHERE option LIKE 'autovacuum_multixact_freeze_max_age=%') AS multixact_freeze_max_age
    FROM unnest(coalesce(c.reloptions, ARRAY[]::text[])) AS options(option)
  ) opts ON true
), effective AS (
  SELECT r.*,
         current_setting('autovacuum')::boolean
           AND coalesce(lower(r.autovacuum_enabled) NOT IN ('false', 'off', '0'), true) AS autovacuum_enabled_effective,
         coalesce(r.vacuum_threshold::double precision, current_setting('autovacuum_vacuum_threshold')::double precision) AS threshold_base,
         coalesce(r.vacuum_scale_factor::double precision, current_setting('autovacuum_vacuum_scale_factor')::double precision) AS threshold_scale,
         coalesce(r.vacuum_insert_threshold::double precision, current_setting('autovacuum_vacuum_insert_threshold')::double precision) AS insert_base,
         coalesce(r.vacuum_insert_scale_factor::double precision, current_setting('autovacuum_vacuum_insert_scale_factor')::double precision) AS insert_scale,
         coalesce(r.freeze_max_age::double precision, current_setting('autovacuum_freeze_max_age')::double precision) AS freeze_age_effective,
         coalesce(r.multixact_freeze_max_age::double precision, current_setting('autovacuum_multixact_freeze_max_age')::double precision) AS multixact_age_effective
  FROM relations r
), pressure AS (
  SELECT e.*,
         CASE
           WHEN nullif(current_setting('autovacuum_vacuum_max_threshold', true), '')::double precision > 0
             THEN least(e.threshold_base + e.threshold_scale * e.estimated_rows,
                        current_setting('autovacuum_vacuum_max_threshold', true)::double precision)
           ELSE e.threshold_base + e.threshold_scale * e.estimated_rows
         END AS vacuum_trigger,
         CASE WHEN e.insert_base < 0 THEN 0 ELSE e.insert_base + e.insert_scale * e.estimated_rows END AS insert_trigger
  FROM effective e
)
SELECT p.oid::text AS oid,
       p.schema_name,
       p.relation_name,
       p.relation_kind,
       p.estimated_rows,
       p.live_tuples,
       p.dead_tuples,
       p.modified_since_analyze,
       p.inserts_since_vacuum,
       (p.pages * current_setting('block_size')::bigint)::bigint AS heap_bytes_estimate,
       p.pages,
       p.all_visible_pages,
       p.relfrozenxid::text AS frozen_xid,
       age(p.relfrozenxid)::bigint AS frozen_xid_age,
       p.relminmxid::text AS min_multi_xid,
       mxid_age(p.relminmxid)::bigint AS min_multi_xid_age,
       p.autovacuum_enabled_effective AS autovacuum_enabled,
       greatest(p.vacuum_trigger, 1) AS vacuum_trigger,
       p.dead_tuples / greatest(p.vacuum_trigger, 1) AS vacuum_pressure,
       greatest(p.insert_trigger, 1) AS insert_trigger,
       CASE WHEN p.insert_trigger <= 0 THEN 0 ELSE p.inserts_since_vacuum / p.insert_trigger END AS insert_pressure,
       p.freeze_age_effective AS freeze_max_age,
       age(p.relfrozenxid)::double precision / greatest(p.freeze_age_effective, 1) AS freeze_pressure,
       p.multixact_age_effective AS multixact_freeze_max_age,
       mxid_age(p.relminmxid)::double precision / greatest(p.multixact_age_effective, 1) AS multixact_freeze_pressure,
       p.last_vacuum,
       p.last_autovacuum,
       p.last_analyze,
       p.last_autoanalyze,
       p.vacuum_count,
       p.autovacuum_count,
       p.analyze_count,
       p.autoanalyze_count
FROM pressure p
ORDER BY greatest(
           p.dead_tuples / greatest(p.vacuum_trigger, 1),
           age(p.relfrozenxid)::double precision / greatest(p.freeze_age_effective, 1),
           mxid_age(p.relminmxid)::double precision / greatest(p.multixact_age_effective, 1)
         ) DESC,
         p.pages DESC
LIMIT 400
`

const WORKERS_SQL = `
SELECT p.pid,
       p.datname,
       p.relid::text AS relid,
       n.nspname AS schema_name,
       c.relname AS relation_name,
       p.phase,
       p.heap_blks_total,
       p.heap_blks_scanned,
       p.heap_blks_vacuumed,
       p.index_vacuum_count,
       (to_jsonb(p)->>'max_dead_tuple_bytes')::bigint AS max_dead_tuple_bytes,
       (to_jsonb(p)->>'dead_tuple_bytes')::bigint AS dead_tuple_bytes,
       coalesce((to_jsonb(p)->>'num_dead_item_ids')::bigint, (to_jsonb(p)->>'num_dead_tuples')::bigint) AS num_dead_item_ids,
       (to_jsonb(p)->>'indexes_total')::bigint AS indexes_total,
       (to_jsonb(p)->>'indexes_processed')::bigint AS indexes_processed,
       (to_jsonb(p)->>'delay_time')::double precision AS delay_time
FROM pg_stat_progress_vacuum p
LEFT JOIN pg_class c ON c.oid = p.relid
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
ORDER BY p.pid
`

export async function fetchMvccExplorerSnapshot(connectionId: string): Promise<MvccExplorerSnapshot> {
  const { pool, record } = await getPool(connectionId, undefined, "observer")
  const client = await pool.connect()
  try {
    const metaResult = await client.query<MetaRow>(META_SQL)
    const meta = metaResult.rows[0]
    if (!meta) throw new Error("Postgres did not return MVCC snapshot metadata")

    const observerPid = Number(meta.observer_pid)
    const sessionsResult = await client.query<SessionRow>(SESSIONS_SQL, [observerPid])
    const slotsResult = await client.query<SlotRow>(SLOTS_SQL)
    const preparedResult = await client.query<PreparedRow>(PREPARED_SQL)
    const tablesResult = await client.query<TableRow>(TABLES_SQL)
    const workersResult = await client.query<WorkerRow>(WORKERS_SQL)

    return {
      sampledAt: new Date().toISOString(),
      connectionId,
      connectionLabel: record.label,
      database: meta.database,
      currentUser: meta.current_user_name,
      serverVersion: meta.server_version,
      serverVersionNum: Number(meta.server_version_num),
      observerPid,
      statsReset: iso(meta.stats_reset),
      settings: {
        autovacuum: Boolean(meta.autovacuum),
        trackCounts: Boolean(meta.track_counts),
        vacuumThreshold: number(meta.vacuum_threshold),
        vacuumScaleFactor: number(meta.vacuum_scale_factor),
        vacuumMaxThreshold: nullableNumber(meta.vacuum_max_threshold),
        insertThreshold: number(meta.insert_threshold),
        insertScaleFactor: number(meta.insert_scale_factor),
        freezeMaxAge: number(meta.freeze_max_age),
        multixactFreezeMaxAge: number(meta.multixact_freeze_max_age),
      },
      permissions: {
        fullActivity: Boolean(meta.full_activity),
        signalBackend: Boolean(meta.signal_backend),
        pgstattuple: Boolean(meta.has_pgstattuple),
        pageinspect: Boolean(meta.has_pageinspect),
      },
      databaseAge: {
        frozenXid: meta.datfrozenxid,
        frozenXidAge: number(meta.datfrozenxid_age),
        minMultiXid: meta.datminmxid,
        minMultiXidAge: number(meta.datminmxid_age),
      },
      sessions: sessionsResult.rows.map((row) => ({
        pid: Number(row.pid),
        backendStart: row.backend_start,
        backendType: row.backend_type,
        user: row.usename,
        database: row.datname,
        applicationName: row.application_name,
        clientAddr: row.client_addr,
        state: row.state,
        transactionStart: iso(row.xact_start),
        stateChange: iso(row.state_change),
        backendXid: row.backend_xid,
        backendXidAge: nullableNumber(row.backend_xid_age),
        backendXmin: row.backend_xmin,
        backendXminAge: nullableNumber(row.backend_xmin_age),
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        query: row.query || null,
      })),
      replicationSlots: slotsResult.rows.map((row) => ({
        slotName: row.slot_name,
        slotType: row.slot_type,
        plugin: row.plugin,
        database: row.database,
        active: Boolean(row.active),
        activePid: row.active_pid == null ? null : Number(row.active_pid),
        xmin: row.xmin,
        xminAge: nullableNumber(row.xmin_age),
        catalogXmin: row.catalog_xmin,
        catalogXminAge: nullableNumber(row.catalog_xmin_age),
        restartLsn: row.restart_lsn,
      })),
      preparedTransactions: preparedResult.rows.map((row) => ({
        transactionId: row.transaction_id,
        transactionAge: number(row.transaction_age),
        gid: row.gid,
        preparedAt: iso(row.prepared_at) ?? new Date(0).toISOString(),
        owner: row.owner,
        database: row.database,
      })),
      tables: tablesResult.rows.map((row) => ({
        oid: row.oid,
        schema: row.schema_name,
        name: row.relation_name,
        relationKind: row.relation_kind,
        estimatedRows: number(row.estimated_rows),
        liveTuples: number(row.live_tuples),
        deadTuples: number(row.dead_tuples),
        modifiedSinceAnalyze: number(row.modified_since_analyze),
        insertsSinceVacuum: number(row.inserts_since_vacuum),
        heapBytesEstimate: number(row.heap_bytes_estimate),
        pages: number(row.pages),
        allVisiblePages: number(row.all_visible_pages),
        frozenXid: row.frozen_xid,
        frozenXidAge: number(row.frozen_xid_age),
        minMultiXid: row.min_multi_xid,
        minMultiXidAge: number(row.min_multi_xid_age),
        autovacuumEnabled: Boolean(row.autovacuum_enabled),
        vacuumTrigger: number(row.vacuum_trigger),
        vacuumPressure: number(row.vacuum_pressure),
        insertTrigger: number(row.insert_trigger),
        insertPressure: number(row.insert_pressure),
        freezeMaxAge: number(row.freeze_max_age),
        freezePressure: number(row.freeze_pressure),
        multixactFreezeMaxAge: number(row.multixact_freeze_max_age),
        multixactFreezePressure: number(row.multixact_freeze_pressure),
        lastVacuum: iso(row.last_vacuum),
        lastAutovacuum: iso(row.last_autovacuum),
        lastAnalyze: iso(row.last_analyze),
        lastAutoanalyze: iso(row.last_autoanalyze),
        vacuumCount: number(row.vacuum_count),
        autovacuumCount: number(row.autovacuum_count),
        analyzeCount: number(row.analyze_count),
        autoanalyzeCount: number(row.autoanalyze_count),
      })),
      vacuumWorkers: workersResult.rows.map((row) => ({
        pid: Number(row.pid),
        database: row.datname,
        relationOid: row.relid,
        schema: row.schema_name,
        table: row.relation_name,
        phase: row.phase,
        heapBlocksTotal: number(row.heap_blks_total),
        heapBlocksScanned: number(row.heap_blks_scanned),
        heapBlocksVacuumed: number(row.heap_blks_vacuumed),
        indexVacuumCount: number(row.index_vacuum_count),
        maxDeadTupleBytes: nullableNumber(row.max_dead_tuple_bytes),
        deadTupleBytes: nullableNumber(row.dead_tuple_bytes),
        deadItemIds: nullableNumber(row.num_dead_item_ids),
        indexesTotal: nullableNumber(row.indexes_total),
        indexesProcessed: nullableNumber(row.indexes_processed),
        delayMs: nullableNumber(row.delay_time),
      })),
    }
  } finally {
    client.release()
  }
}

function number(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
