import "server-only"

import { getPool } from "./pool"

export interface LockExplorerSession {
  pid: number
  leaderPid: number | null
  backendStart: string
  backendType: string | null
  user: string | null
  database: string | null
  applicationName: string | null
  clientAddr: string | null
  state: string | null
  queryStart: string | null
  transactionStart: string | null
  stateChange: string | null
  waitEventType: string | null
  waitEvent: string | null
  backendXid: string | null
  backendXmin: string | null
  query: string | null
}

export interface LockExplorerLock {
  lockType: string
  databaseOid: string | null
  databaseName: string | null
  relationOid: string | null
  schemaName: string | null
  relationName: string | null
  relationKind: string | null
  page: string | null
  tuple: string | null
  virtualXid: string | null
  transactionId: string | null
  classId: string | null
  objectId: string | null
  objectSubId: string | null
  virtualTransaction: string
  pid: number | null
  mode: string
  granted: boolean
  fastPath: boolean
  waitStart: string | null
}

export interface LockExplorerEdge {
  waiterPid: number
  blockerPid: number
}

export interface LockExplorerPreparedTransaction {
  transactionId: string
  gid: string
  preparedAt: string
  owner: string
  database: string
}

export interface LockExplorerPermissions {
  fullActivity: boolean
  signalBackend: boolean
}

export interface LockExplorerSnapshot {
  sampledAt: string
  connectionId: string
  connectionLabel: string
  database: string
  currentUser: string
  serverVersion: string
  serverVersionNum: number
  observerPid: number
  permissions: LockExplorerPermissions
  deadlocks: number
  statsReset: string | null
  sessions: LockExplorerSession[]
  locks: LockExplorerLock[]
  edges: LockExplorerEdge[]
  preparedTransactions: LockExplorerPreparedTransaction[]
}

interface MetaRow {
  observer_pid: number
  database: string
  current_user_name: string
  server_version: string
  server_version_num: number | string
  full_activity: boolean
  signal_backend: boolean
  deadlocks: number | string | null
  stats_reset: Date | string | null
}

interface SessionRow {
  pid: number
  leader_pid: number | null
  backend_start: string
  backend_type: string | null
  usename: string | null
  datname: string | null
  application_name: string | null
  client_addr: string | null
  state: string | null
  query_start: Date | string | null
  xact_start: Date | string | null
  state_change: Date | string | null
  wait_event_type: string | null
  wait_event: string | null
  backend_xid: string | null
  backend_xmin: string | null
  query: string | null
}

interface LockRow {
  locktype: string
  database_oid: string | null
  database_name: string | null
  relation_oid: string | null
  schema_name: string | null
  relation_name: string | null
  relation_kind: string | null
  page: string | null
  tuple: string | null
  virtualxid: string | null
  transactionid: string | null
  classid: string | null
  objid: string | null
  objsubid: string | null
  virtualtransaction: string
  pid: number | null
  mode: string
  granted: boolean
  fastpath: boolean
  waitstart: Date | string | null
}

interface EdgeRow {
  waiter_pid: number
  blocker_pid: number
}

interface PreparedRow {
  transaction_id: string
  gid: string
  prepared_at: Date | string
  owner: string
  database: string
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
       coalesce((SELECT deadlocks::bigint FROM pg_stat_database WHERE datname = current_database()), 0) AS deadlocks,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
`

const SESSIONS_SQL = `
SELECT pid,
       leader_pid,
       to_char(
         backend_start AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS backend_start,
       backend_type,
       usename,
       datname,
       application_name,
       client_addr::text AS client_addr,
       state,
       query_start,
       xact_start,
       state_change,
       wait_event_type,
       wait_event,
       backend_xid::text AS backend_xid,
       backend_xmin::text AS backend_xmin,
       left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 2000) AS query
FROM pg_stat_activity
WHERE pid <> $1
ORDER BY xact_start ASC NULLS LAST, query_start ASC NULLS LAST, pid
`

function locksSql(hasWaitStart: boolean): string {
  return `
WITH current_db AS (
  SELECT oid FROM pg_database WHERE datname = current_database()
)
SELECT l.locktype,
       l.database::text AS database_oid,
       d.datname AS database_name,
       l.relation::text AS relation_oid,
       n.nspname AS schema_name,
       c.relname AS relation_name,
       c.relkind::text AS relation_kind,
       l.page::text AS page,
       l.tuple::text AS tuple,
       l.virtualxid::text AS virtualxid,
       l.transactionid::text AS transactionid,
       l.classid::text AS classid,
       l.objid::text AS objid,
       l.objsubid::text AS objsubid,
       l.virtualtransaction,
       l.pid,
       l.mode,
       l.granted,
       l.fastpath,
       ${hasWaitStart ? "l.waitstart" : "NULL::timestamptz"} AS waitstart
FROM pg_locks l
LEFT JOIN pg_database d ON d.oid = l.database
LEFT JOIN current_db cd ON true
LEFT JOIN pg_class c ON l.database = cd.oid AND c.oid = l.relation
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE l.pid IS NULL OR l.pid <> $1
ORDER BY l.granted, ${hasWaitStart ? "l.waitstart" : "l.pid"} NULLS LAST, l.pid NULLS LAST, l.locktype, l.mode
`
}

const EDGES_SQL = `
SELECT DISTINCT waiters.pid::int AS waiter_pid,
       blockers.blocker_pid::int AS blocker_pid
FROM unnest($1::int[]) AS waiters(pid)
CROSS JOIN LATERAL unnest(pg_blocking_pids(waiters.pid)) AS blockers(blocker_pid)
ORDER BY waiter_pid, blocker_pid
`

const PREPARED_SQL = `
SELECT transaction::text AS transaction_id,
       gid,
       prepared AS prepared_at,
       owner,
       database
FROM pg_prepared_xacts
ORDER BY prepared
`

export async function fetchLockExplorerSnapshot(connectionId: string): Promise<LockExplorerSnapshot> {
  const { pool, record } = await getPool(connectionId, undefined, "observer")
  const client = await pool.connect()
  try {
    const metaResult = await client.query<MetaRow>(META_SQL)
    const meta = metaResult.rows[0]
    if (!meta) throw new Error("Postgres did not return lock snapshot metadata")

    const observerPid = Number(meta.observer_pid)
    const serverVersionNum = Number(meta.server_version_num)
    const sessionsResult = await client.query<SessionRow>(SESSIONS_SQL, [observerPid])
    const locksResult = await client.query<LockRow>(locksSql(serverVersionNum >= 140000), [observerPid])
    const waitingPids = Array.from(new Set(
      locksResult.rows
        .filter((row) => !row.granted && row.pid != null)
        .map((row) => Number(row.pid)),
    ))
    const edgesResult = waitingPids.length > 0
      ? await client.query<EdgeRow>(EDGES_SQL, [waitingPids])
      : { rows: [] as EdgeRow[] }
    const preparedResult = await client.query<PreparedRow>(PREPARED_SQL)

    return {
      sampledAt: new Date().toISOString(),
      connectionId,
      connectionLabel: record.label,
      database: meta.database,
      currentUser: meta.current_user_name,
      serverVersion: meta.server_version,
      serverVersionNum,
      observerPid,
      permissions: {
        fullActivity: Boolean(meta.full_activity),
        signalBackend: Boolean(meta.signal_backend),
      },
      deadlocks: Number(meta.deadlocks ?? 0),
      statsReset: iso(meta.stats_reset),
      sessions: sessionsResult.rows.map((row) => ({
        pid: Number(row.pid),
        leaderPid: row.leader_pid == null ? null : Number(row.leader_pid),
        backendStart: row.backend_start,
        backendType: row.backend_type,
        user: row.usename,
        database: row.datname,
        applicationName: row.application_name,
        clientAddr: row.client_addr,
        state: row.state,
        queryStart: iso(row.query_start),
        transactionStart: iso(row.xact_start),
        stateChange: iso(row.state_change),
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        backendXid: row.backend_xid,
        backendXmin: row.backend_xmin,
        query: row.query || null,
      })),
      locks: locksResult.rows.map((row) => ({
        lockType: row.locktype,
        databaseOid: row.database_oid,
        databaseName: row.database_name,
        relationOid: row.relation_oid,
        schemaName: row.schema_name,
        relationName: row.relation_name,
        relationKind: row.relation_kind,
        page: row.page,
        tuple: row.tuple,
        virtualXid: row.virtualxid,
        transactionId: row.transactionid,
        classId: row.classid,
        objectId: row.objid,
        objectSubId: row.objsubid,
        virtualTransaction: row.virtualtransaction,
        pid: row.pid == null ? null : Number(row.pid),
        mode: row.mode,
        granted: Boolean(row.granted),
        fastPath: Boolean(row.fastpath),
        waitStart: iso(row.waitstart),
      })),
      edges: edgesResult.rows.map((row) => ({
        waiterPid: Number(row.waiter_pid),
        blockerPid: Number(row.blocker_pid),
      })),
      preparedTransactions: preparedResult.rows.map((row) => ({
        transactionId: row.transaction_id,
        gid: row.gid,
        preparedAt: iso(row.prepared_at) ?? new Date(0).toISOString(),
        owner: row.owner,
        database: row.database,
      })),
    }
  } finally {
    client.release()
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}
