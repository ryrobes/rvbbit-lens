"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  Activity,
  AlertTriangle,
  ClipboardCopy,
  Database,
  Download,
  Eye,
  FileText,
  KeyRound,
  Layers,
  Lock,
  RefreshCw,
  Shield,
  Table2,
  Wrench,
} from "@/lib/icons"
import type { PostgresAdminPayload } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
import { Gauge } from "./gauge"
import { Sparkline } from "./sparkline"
import { CompositionBar, HBars, Metric, Panel, fmtCount, fmtMs } from "./instruments"
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./context-menu"

type AdminTab = "overview" | "activity" | "indexes" | "permissions" | "objects" | "backup"
type SqlOpener = (title: string, sql: string, run: boolean) => void
type Row = Record<string, unknown>

interface PostgresAdminWindowProps {
  payload?: PostgresAdminPayload
  activeConnectionId: string | null
  onOpenSql: SqlOpener
}

interface QueryResponse<T extends Row> {
  ok?: boolean
  rows?: T[]
  error?: string
  detail?: string
  hint?: string
}

interface OverviewRow extends Row {
  database: string
  database_size: string
  server_version: string
  max_connections: number
  numbackends: number
  xact_commit: number
  xact_rollback: number
  blks_read: number
  blks_hit: number
  deadlocks: number
  temp_files: number
  tables: number
  live_rows: number
  dead_rows: number
  vacuum_attention: number
  indexes: number
  unused_large_indexes: number
  active_sessions: number
  idle_in_txn: number
  waiting: number
  longest_xact_ms: number
  waiting_locks: number
  uptime_ms: number
}

interface ActivityRow extends Row {
  pid: number
  usename: string | null
  datname: string | null
  application_name: string | null
  client_addr: string | null
  state: string | null
  wait_event_type: string | null
  wait_event: string | null
  query_ms: number | null
  xact_ms: number | null
  blockers: unknown
  blocker_count: number
  query: string | null
}

interface IndexRow extends Row {
  schema: string
  table_name: string
  index_name: string
  idx_scan: number
  index_bytes: number
  index_size: string
  indisunique: boolean
  indisprimary: boolean
  seq_scan: number
  table_idx_scan: number
  n_live_tup: number
  n_dead_tup: number
  finding: string
  definition: string
}

interface GrantRow extends Row {
  schema: string
  table_name: string
  grantee: string
  sel: boolean
  ins: boolean
  upd: boolean
  del: boolean
  ref: boolean
  trg: boolean
}

interface MembershipRow extends Row {
  role: string
  member: string
  admin_option: boolean
}

interface RlsRow extends Row {
  schema: string
  table_name: string
  rls_enabled: boolean
  rls_forced: boolean
  policies: number
}

interface ObjectRow extends Row {
  schema: string
  name: string
  kind: string
  relkind: string
  bytes: number
  size: string
  row_estimate: number
  comment: string | null
  regclass: string
}

interface ObjectDetailRow extends Row {
  section: string
  ord: number
  name: string
  detail: string
  extra: string | null
}

const TABS: Array<{ id: AdminTab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "overview", label: "Health", icon: Activity },
  { id: "activity", label: "Locks", icon: Lock },
  { id: "indexes", label: "Indexes", icon: Wrench },
  { id: "permissions", label: "Grants", icon: KeyRound },
  { id: "objects", label: "Objects", icon: Layers },
  { id: "backup", label: "Backup", icon: Download },
]

const OVERVIEW_SQL = `
WITH db AS (
  SELECT current_database() AS database,
         pg_database_size(current_database())::bigint AS database_bytes,
         pg_size_pretty(pg_database_size(current_database())) AS database_size,
         current_setting('server_version') AS server_version,
         current_setting('max_connections')::int AS max_connections,
         pg_postmaster_start_time() AS started_at
),
stat AS (
  SELECT coalesce(numbackends, 0) AS numbackends,
         coalesce(xact_commit, 0)::bigint AS xact_commit,
         coalesce(xact_rollback, 0)::bigint AS xact_rollback,
         coalesce(blks_read, 0)::bigint AS blks_read,
         coalesce(blks_hit, 0)::bigint AS blks_hit,
         coalesce(deadlocks, 0)::bigint AS deadlocks,
         coalesce(temp_files, 0)::bigint AS temp_files,
         coalesce(temp_bytes, 0)::bigint AS temp_bytes
  FROM pg_stat_database
  WHERE datname = current_database()
),
tables AS (
  SELECT count(*)::bigint AS tables,
         coalesce(sum(n_live_tup), 0)::bigint AS live_rows,
         coalesce(sum(n_dead_tup), 0)::bigint AS dead_rows,
         count(*) FILTER (WHERE n_dead_tup > greatest(1000::bigint, (n_live_tup * 0.20)::bigint))::bigint AS vacuum_attention
  FROM pg_stat_user_tables
),
idx AS (
  SELECT count(*)::bigint AS indexes,
         count(*) FILTER (WHERE idx_scan = 0 AND pg_relation_size(indexrelid) > 1024 * 1024)::bigint AS unused_large_indexes,
         coalesce(sum(pg_relation_size(indexrelid)), 0)::bigint AS index_bytes
  FROM pg_stat_user_indexes
),
activity AS (
  SELECT count(*) FILTER (WHERE state = 'active')::bigint AS active_sessions,
         count(*) FILTER (WHERE state = 'idle in transaction')::bigint AS idle_in_txn,
         count(*) FILTER (WHERE wait_event_type IS NOT NULL)::bigint AS waiting,
         coalesce(max(extract(epoch from now() - xact_start) * 1000), 0)::bigint AS longest_xact_ms
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
),
locks AS (
  SELECT count(*)::bigint AS locks,
         count(*) FILTER (WHERE NOT granted)::bigint AS waiting_locks
  FROM pg_locks
)
SELECT db.database,
       db.database_bytes,
       db.database_size,
       db.server_version,
       db.max_connections,
       extract(epoch from now() - db.started_at) * 1000 AS uptime_ms,
       stat.*,
       tables.*,
       idx.*,
       activity.*,
       locks.*
FROM db
CROSS JOIN stat
CROSS JOIN tables
CROSS JOIN idx
CROSS JOIN activity
CROSS JOIN locks;
`

const ACTIVITY_SQL = `
WITH activity AS (
  SELECT pid,
         usename,
         datname,
         application_name,
         client_addr::text AS client_addr,
         state,
         wait_event_type,
         wait_event,
         extract(epoch from now() - query_start) * 1000 AS query_ms,
         extract(epoch from now() - xact_start) * 1000 AS xact_ms,
         pg_blocking_pids(pid) AS blockers,
         left(regexp_replace(coalesce(query, ''), '\\s+', ' ', 'g'), 420) AS query
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
    AND pid <> pg_backend_pid()
)
SELECT *,
       cardinality(blockers) AS blocker_count
FROM activity
ORDER BY blocker_count DESC,
         wait_event_type NULLS LAST,
         xact_ms DESC NULLS LAST,
         query_ms DESC NULLS LAST
LIMIT 120;
`

const INDEX_SQL = `
WITH idx AS (
  SELECT s.schemaname AS schema,
         s.relname AS table_name,
         s.indexrelname AS index_name,
         s.idx_scan::bigint AS idx_scan,
         s.idx_tup_read::bigint AS idx_tup_read,
         s.idx_tup_fetch::bigint AS idx_tup_fetch,
         pg_relation_size(s.indexrelid)::bigint AS index_bytes,
         pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
         i.indisunique,
         i.indisprimary,
         pg_get_indexdef(s.indexrelid) AS definition
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
),
tbl AS (
  SELECT schemaname AS schema,
         relname AS table_name,
         seq_scan::bigint AS seq_scan,
         idx_scan::bigint AS table_idx_scan,
         n_live_tup::bigint AS n_live_tup,
         n_dead_tup::bigint AS n_dead_tup,
         pg_total_relation_size(relid)::bigint AS table_bytes
  FROM pg_stat_user_tables
),
scored AS (
  SELECT idx.*,
         tbl.seq_scan,
         tbl.table_idx_scan,
         tbl.n_live_tup,
         tbl.n_dead_tup,
         tbl.table_bytes,
         CASE
           WHEN idx.idx_scan = 0 AND NOT idx.indisprimary AND NOT idx.indisunique AND idx.index_bytes > 1024 * 1024 THEN 'unused'
           WHEN tbl.seq_scan > greatest(tbl.table_idx_scan * 2, 50) AND tbl.n_live_tup > 10000 THEN 'seq-scan pressure'
           WHEN tbl.n_dead_tup > greatest(1000::bigint, (tbl.n_live_tup * 0.20)::bigint) THEN 'vacuum debt'
           WHEN idx.idx_scan < 10 AND idx.index_bytes > 50 * 1024 * 1024 AND NOT idx.indisprimary THEN 'large low-use'
           ELSE 'watch'
         END AS finding
  FROM idx
  JOIN tbl USING (schema, table_name)
)
SELECT *
FROM scored
ORDER BY CASE finding
           WHEN 'unused' THEN 1
           WHEN 'seq-scan pressure' THEN 2
           WHEN 'vacuum debt' THEN 3
           WHEN 'large low-use' THEN 4
           ELSE 5
         END,
         index_bytes DESC
LIMIT 250;
`

const GRANTS_SQL = `
SELECT table_schema AS schema,
       table_name,
       grantee,
       bool_or(privilege_type = 'SELECT') AS sel,
       bool_or(privilege_type = 'INSERT') AS ins,
       bool_or(privilege_type = 'UPDATE') AS upd,
       bool_or(privilege_type = 'DELETE') AS del,
       bool_or(privilege_type = 'REFERENCES') AS ref,
       bool_or(privilege_type = 'TRIGGER') AS trg
FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
LIMIT 500;
`

const MEMBERSHIP_SQL = `
SELECT role.rolname AS role,
       member.rolname AS member,
       am.admin_option
FROM pg_auth_members am
JOIN pg_roles role ON role.oid = am.roleid
JOIN pg_roles member ON member.oid = am.member
ORDER BY role.rolname, member.rolname
LIMIT 300;
`

const RLS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       count(p.*)::bigint AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
GROUP BY n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY c.relrowsecurity DESC, policies DESC, n.nspname, c.relname
LIMIT 300;
`

const OBJECTS_SQL = `
SELECT n.nspname AS schema,
       c.relname AS name,
       c.relkind,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'p' THEN 'partitioned table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized view'
         WHEN 'f' THEN 'foreign table'
         WHEN 'i' THEN 'index'
         WHEN 'S' THEN 'sequence'
         ELSE c.relkind::text
       END AS kind,
       pg_total_relation_size(c.oid)::bigint AS bytes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       c.reltuples::bigint AS row_estimate,
       obj_description(c.oid, 'pg_class') AS comment,
       format('%I.%I', n.nspname, c.relname) AS regclass
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'i', 'S')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY bytes DESC NULLS LAST, n.nspname, c.relname
LIMIT 400;
`

export function PostgresAdminWindow({
  payload,
  activeConnectionId,
  onOpenSql,
}: PostgresAdminWindowProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>(payload?.initialTab ?? "overview")
  const [overview, setOverview] = useState<OverviewRow | null>(null)
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [indexes, setIndexes] = useState<IndexRow[]>([])
  const [grants, setGrants] = useState<GrantRow[]>([])
  const [memberships, setMemberships] = useState<MembershipRow[]>([])
  const [rls, setRls] = useState<RlsRow[]>([])
  const [objects, setObjects] = useState<ObjectRow[]>([])
  const [selectedObject, setSelectedObject] = useState<ObjectRow | null>(null)
  const [objectDetails, setObjectDetails] = useState<ObjectDetailRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const runQuery = useCallback(
    async <T extends Row>(sql: string, rowLimit = 500): Promise<T[]> => {
      if (!activeConnectionId) return []
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          sql,
          rowLimit,
          readOnly: true,
          poolLane: "meta",
          statementTimeout: 12000,
        }),
      })
      const json = (await res.json().catch(() => null)) as QueryResponse<T> | null
      if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.error || json?.detail || `query failed (${res.status})`)
      }
      return json.rows ?? []
    },
    [activeConnectionId],
  )

  const load = useCallback(
    async (tab: AdminTab = activeTab) => {
      if (!activeConnectionId) return
      setLoading(true)
      setError(null)
      try {
        if (tab === "overview") {
          const rows = await runQuery<OverviewRow>(OVERVIEW_SQL, 1)
          setOverview(rows[0] ?? null)
        } else if (tab === "activity") {
          setActivity(await runQuery<ActivityRow>(ACTIVITY_SQL, 140))
        } else if (tab === "indexes") {
          setIndexes(await runQuery<IndexRow>(INDEX_SQL, 250))
        } else if (tab === "permissions") {
          const [grantRows, membershipRows, rlsRows] = await Promise.all([
            runQuery<GrantRow>(GRANTS_SQL, 500),
            runQuery<MembershipRow>(MEMBERSHIP_SQL, 300),
            runQuery<RlsRow>(RLS_SQL, 300),
          ])
          setGrants(grantRows)
          setMemberships(membershipRows)
          setRls(rlsRows)
        } else if (tab === "objects") {
          const rows = await runQuery<ObjectRow>(OBJECTS_SQL, 400)
          setObjects(rows)
          setSelectedObject((current) => {
            if (current && rows.some((r) => r.regclass === current.regclass)) return current
            return rows[0] ?? null
          })
        } else if (tab === "backup") {
          const rows = await runQuery<OverviewRow>(OVERVIEW_SQL, 1)
          setOverview(rows[0] ?? null)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [activeConnectionId, activeTab, runQuery],
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load(activeTab)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [activeTab, load])

  useEffect(() => {
    if (!activeConnectionId || activeTab !== "objects" || !selectedObject) {
      const timeout = window.setTimeout(() => setObjectDetails([]), 0)
      return () => window.clearTimeout(timeout)
    }
    const object = selectedObject
    let cancelled = false
    async function loadDetails() {
      try {
        const rows = await runQuery<ObjectDetailRow>(objectDetailSql(object.regclass), 300)
        if (!cancelled) setObjectDetails(rows)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void loadDetails()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, activeTab, runQuery, selectedObject])

  const commandTabs: AdminTab[] = ["activity", "indexes", "permissions", "backup"]

  if (!activeConnectionId) {
    return (
      <CenteredState
        icon={Database}
        title="No active connection"
        detail="Open or select a Postgres connection to use the admin cockpit."
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-chrome-border/70 bg-secondary-background/55 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-rvbbit-accent/35 bg-rvbbit-accent/10">
            <Shield className="h-4 w-4 text-rvbbit-accent" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold leading-tight">Postgres Admin</h2>
              {overview?.database ? (
                <span className="font-mono text-[10px] text-chrome-text/60">{overview.database}</span>
              ) : null}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-chrome-text/50">
              Read-only catalog view / reviewed SQL actions
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {commandTabs.map((tab) => {
              const def = TABS.find((t) => t.id === tab)!
              const Icon = def.icon
              return (
                <button
                  key={tab}
                  type="button"
                  title={def.label}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[11px] transition",
                    activeTab === tab
                      ? "border-rvbbit-accent/60 bg-rvbbit-accent/15 text-foreground"
                      : "border-chrome-border/60 bg-secondary-background/50 text-chrome-text hover:border-rvbbit-accent/35 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {def.label}
                </button>
              )
            })}
            <button
              type="button"
              title="Refresh"
              onClick={() => void load(activeTab)}
              className="grid h-7 w-7 place-items-center rounded-sm border border-chrome-border/60 bg-secondary-background/60 text-chrome-text hover:border-rvbbit-accent/40 hover:text-foreground"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>
        </div>
        <div className="mt-2 flex gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border px-2.5 text-[11px]",
                  activeTab === tab.id
                    ? "border-rvbbit-accent/55 bg-rvbbit-accent/12 text-foreground"
                    : "border-transparent text-chrome-text/70 hover:border-chrome-border hover:bg-secondary-background/40 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            )
          })}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {activeTab === "overview" ? <OverviewTab row={overview} loading={loading} onOpenSql={onOpenSql} /> : null}
        {activeTab === "activity" ? <ActivityTab rows={activity} loading={loading} onOpenSql={onOpenSql} /> : null}
        {activeTab === "indexes" ? <IndexesTab rows={indexes} loading={loading} onOpenSql={onOpenSql} /> : null}
        {activeTab === "permissions" ? (
          <PermissionsTab
            grants={grants}
            memberships={memberships}
            rls={rls}
            loading={loading}
            onOpenSql={onOpenSql}
          />
        ) : null}
        {activeTab === "objects" ? (
          <ObjectsTab
            rows={objects}
            selected={selectedObject}
            details={objectDetails}
            loading={loading}
            onSelect={setSelectedObject}
            onOpenSql={onOpenSql}
          />
        ) : null}
        {activeTab === "backup" ? (
          <BackupTab overview={overview} copied={copied} onCopied={setCopied} onOpenSql={onOpenSql} />
        ) : null}
      </main>
    </div>
  )
}

function OverviewTab({
  row,
  loading,
  onOpenSql,
}: {
  row: OverviewRow | null
  loading: boolean
  onOpenSql: SqlOpener
}) {
  if (!row && loading) return <LoadingGrid />
  if (!row) return <EmptyPanel title="No health sample" />

  const hits = numberOf(row.blks_hit)
  const reads = numberOf(row.blks_read)
  const cacheHit = hits + reads > 0 ? hits / (hits + reads) : 1
  const commits = numberOf(row.xact_commit)
  const rollbacks = numberOf(row.xact_rollback)
  const rollbackRatio = commits + rollbacks > 0 ? rollbacks / (commits + rollbacks) : 0
  const deadRows = numberOf(row.dead_rows)
  const liveRows = numberOf(row.live_rows)
  const deadRatio = liveRows + deadRows > 0 ? deadRows / (liveRows + deadRows) : 0
  const connectionRatio = ratio(numberOf(row.numbackends), numberOf(row.max_connections))
  const waitRatio = ratio(numberOf(row.waiting), Math.max(1, numberOf(row.numbackends)))
  const score = clamp(
    100 - (1 - cacheHit) * 32 - rollbackRatio * 22 - deadRatio * 24 - connectionRatio * 18 - waitRatio * 18 - numberOf(row.waiting_locks) * 6,
    0,
    100,
  )
  const spark = [
    100 - rollbackRatio * 80,
    cacheHit * 100,
    100 - deadRatio * 100,
    100 - connectionRatio * 100,
    100 - waitRatio * 100,
    score,
  ]

  return (
    <div className="space-y-3">
      <section className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel icon={Activity} title="Health">
          <div className="grid gap-3 md:grid-cols-[180px_1fr]">
            <div className="rounded-md border border-chrome-border/50 bg-background/35 p-3">
              <div className="font-mono text-4xl leading-none tabular-nums text-foreground">
                {Math.round(score)}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-chrome-text/55">health score</div>
              <Gauge value={score} max={100} goodHigh className="mt-3" reading={`${Math.round(score)}%`} />
              <Sparkline values={spark} height={34} color="var(--rvbbit-accent)" className="mt-3" yMin={0} yMax={100} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Gauge value={cacheHit} max={1} goodHigh label="cache hit" reading={percent(cacheHit)} />
              <Gauge value={connectionRatio} max={1} label="connections" reading={`${numberOf(row.numbackends)} / ${numberOf(row.max_connections)}`} />
              <Gauge value={deadRatio} max={1} label="dead tuples" reading={percent(deadRatio)} />
              <Gauge value={rollbackRatio} max={1} label="rollback ratio" reading={percent(rollbackRatio)} />
            </div>
          </div>
        </Panel>

        <Panel icon={Database} title="Database">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric label="database" value={stringOf(row.database)} />
            <Metric label="size" value={stringOf(row.database_size)} />
            <Metric label="server" value={stringOf(row.server_version).split(" ")[0] ?? "postgres"} />
            <Metric label="tables" value={fmtCount(numberOf(row.tables))} />
            <Metric label="indexes" value={fmtCount(numberOf(row.indexes))} />
            <Metric label="uptime" value={fmtMs(numberOf(row.uptime_ms))} />
          </div>
          <CompositionBar
            className="mt-3"
            height={12}
            segments={[
              { label: "active", value: numberOf(row.active_sessions), color: "var(--rvbbit-accent)" },
              { label: "waiting", value: numberOf(row.waiting), color: "var(--warning)" },
              { label: "idle in transaction", value: numberOf(row.idle_in_txn), color: "var(--danger)" },
            ]}
          />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <Metric label="active" value={fmtCount(numberOf(row.active_sessions))} />
            <Metric label="waiting" value={fmtCount(numberOf(row.waiting))} tone={numberOf(row.waiting) > 0 ? "warning" : undefined} />
            <Metric label="idle txn" value={fmtCount(numberOf(row.idle_in_txn))} tone={numberOf(row.idle_in_txn) > 0 ? "danger" : undefined} />
          </div>
        </Panel>
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <Panel icon={Table2} title="Table Pressure">
          <HBars
            rows={[
              { label: "live rows", value: liveRows, valueLabel: fmtCount(liveRows), color: "var(--rvbbit-accent)" },
              { label: "dead rows", value: deadRows, valueLabel: fmtCount(deadRows), color: deadRatio > 0.2 ? "var(--danger)" : "var(--warning)" },
              { label: "vacuum attention", value: numberOf(row.vacuum_attention), valueLabel: fmtCount(numberOf(row.vacuum_attention)), color: "var(--warning)" },
            ]}
          />
        </Panel>
        <Panel icon={Wrench} title="Index Signals">
          <HBars
            rows={[
              { label: "total indexes", value: numberOf(row.indexes), valueLabel: fmtCount(numberOf(row.indexes)), color: "var(--rvbbit-accent)" },
              { label: "unused large", value: numberOf(row.unused_large_indexes), valueLabel: fmtCount(numberOf(row.unused_large_indexes)), color: numberOf(row.unused_large_indexes) ? "var(--warning)" : "var(--success)" },
            ]}
          />
        </Panel>
        <Panel icon={Shield} title="Quick SQL">
          <div className="grid gap-2">
            <ActionButton
              icon={Eye}
              label="Open health probe"
              onClick={() => onOpenSql("Postgres health probe", OVERVIEW_SQL.trim(), true)}
            />
            <ActionButton
              icon={FileText}
              label="Open catalog inventory"
              onClick={() => onOpenSql("Catalog inventory", OBJECTS_SQL.trim(), true)}
            />
          </div>
        </Panel>
      </section>
    </div>
  )
}

function ActivityTab({
  rows,
  loading,
  onOpenSql,
}: {
  rows: ActivityRow[]
  loading: boolean
  onOpenSql: SqlOpener
}) {
  const stateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const key = stringOf(row.state || row.wait_event_type || "unknown")
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [rows])
  const maxAge = Math.max(1, ...rows.map((row) => Math.max(numberOf(row.query_ms), numberOf(row.xact_ms))))
  const blocked = rows.filter((row) => numberOf(row.blocker_count) > 0)
  const waiting = rows.filter((row) => row.wait_event_type)

  if (loading && rows.length === 0) return <LoadingGrid />

  return (
    <div className="space-y-3">
      <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel icon={Lock} title="Session Composition">
          <CompositionBar
            height={14}
            segments={stateCounts.map(([state, value], index) => ({
              label: state,
              value,
              color: stateColor(state, index),
            }))}
          />
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Metric label="sessions" value={fmtCount(rows.length)} />
            <Metric label="blocked" value={fmtCount(blocked.length)} tone={blocked.length ? "danger" : undefined} />
            <Metric label="waiting" value={fmtCount(waiting.length)} tone={waiting.length ? "warning" : undefined} />
          </div>
        </Panel>
        <Panel icon={Activity} title="Longest Work">
          <HBars
            max={maxAge}
            rows={rows.slice(0, 10).map((row) => {
              const age = Math.max(numberOf(row.query_ms), numberOf(row.xact_ms))
              return {
                label: `pid ${numberOf(row.pid)}`,
                value: age,
                valueLabel: fmtMs(age),
                sub: row.state ?? undefined,
                color: numberOf(row.blocker_count) > 0 ? "var(--danger)" : row.wait_event_type ? "var(--warning)" : "var(--rvbbit-accent)",
                title: stringOf(row.query),
              }
            })}
          />
        </Panel>
      </section>

      <Panel
        icon={Database}
        title="Activity"
        right={<ActionButton compact icon={Eye} label="SQL" onClick={() => onOpenSql("Activity and locks", ACTIVITY_SQL.trim(), true)} />}
      >
        {rows.length === 0 ? (
          <EmptyInline label="No client sessions" />
        ) : (
          <div className="space-y-1">
            {rows.map((row) => (
              <div
                key={numberOf(row.pid)}
                className={cn(
                  "grid gap-2 rounded-sm border px-2 py-2 text-[11px] md:grid-cols-[96px_1fr_180px]",
                  numberOf(row.blocker_count) > 0
                    ? "border-danger/40 bg-danger/8"
                    : row.wait_event_type
                      ? "border-warning/40 bg-warning/8"
                      : "border-chrome-border/45 bg-background/25",
                )}
              >
                <div className="min-w-0">
                  <div className="font-mono text-foreground">pid {numberOf(row.pid)}</div>
                  <div className="truncate text-chrome-text/55">{stringOf(row.usename) || "unknown"}</div>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-foreground">{stringOf(row.state) || "unknown"}</span>
                    {row.wait_event_type ? <span className="text-warning">{stringOf(row.wait_event_type)}:{stringOf(row.wait_event)}</span> : null}
                    {numberOf(row.blocker_count) > 0 ? <span className="text-danger">blocked by {blockerLabel(row.blockers)}</span> : null}
                    <span className="text-chrome-text/50">{stringOf(row.application_name) || "app unknown"}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-chrome-text/70">{stringOf(row.query) || "no query text"}</div>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <span className="mr-auto font-mono text-[10px] text-chrome-text/65">{fmtMs(Math.max(numberOf(row.query_ms), numberOf(row.xact_ms)))}</span>
                  <ActionButton compact icon={AlertTriangle} label="Cancel" onClick={() => onOpenSql(`Cancel pid ${numberOf(row.pid)}`, `SELECT pg_cancel_backend(${numberOf(row.pid)});`, false)} />
                  <ActionButton compact icon={Wrench} label="Terminate" onClick={() => onOpenSql(`Terminate pid ${numberOf(row.pid)}`, `SELECT pg_terminate_backend(${numberOf(row.pid)});`, false)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function IndexesTab({
  rows,
  loading,
  onOpenSql,
}: {
  rows: IndexRow[]
  loading: boolean
  onOpenSql: SqlOpener
}) {
  const totals = useMemo(() => {
    const byFinding = new Map<string, number>()
    for (const row of rows) byFinding.set(row.finding, (byFinding.get(row.finding) ?? 0) + 1)
    return Array.from(byFinding.entries()).sort((a, b) => b[1] - a[1])
  }, [rows])
  if (loading && rows.length === 0) return <LoadingGrid />

  return (
    <div className="space-y-3">
      <section className="grid gap-3 xl:grid-cols-[0.7fr_1.3fr]">
        <Panel icon={Wrench} title="Findings">
          <CompositionBar
            height={14}
            segments={totals.map(([finding, value], index) => ({
              label: finding,
              value,
              color: findingColor(finding, index),
            }))}
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            {totals.map(([finding, value]) => (
              <Metric key={finding} label={finding} value={fmtCount(value)} tone={finding === "unused" ? "warning" : undefined} />
            ))}
          </div>
        </Panel>
        <Panel icon={Table2} title="Largest Indexes">
          <HBars
            rows={rows.slice(0, 12).map((row) => ({
              label: `${row.schema}.${row.index_name}`,
              value: numberOf(row.index_bytes),
              valueLabel: stringOf(row.index_size),
              sub: fmtCount(numberOf(row.idx_scan)),
              color: findingColor(row.finding),
              title: row.definition,
            }))}
          />
        </Panel>
      </section>

      <Panel
        icon={Shield}
        title="Advisor"
        right={<ActionButton compact icon={Eye} label="SQL" onClick={() => onOpenSql("Index advisor", INDEX_SQL.trim(), true)} />}
      >
        {rows.length === 0 ? (
          <EmptyInline label="No user indexes found" />
        ) : (
          <div className="space-y-1">
            {rows.map((row) => {
              const qTable = qualified(row.schema, row.table_name)
              const qIndex = qualified(row.schema, row.index_name)
              const canDrop = row.finding === "unused" && !truthy(row.indisprimary) && !truthy(row.indisunique)
              return (
                <div key={`${row.schema}.${row.index_name}`} className="grid gap-2 rounded-sm border border-chrome-border/45 bg-background/25 px-2 py-2 text-[11px] xl:grid-cols-[1fr_150px_220px]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-foreground">{qIndex}</span>
                      <Badge tone={row.finding === "unused" ? "warning" : row.finding === "vacuum debt" ? "danger" : "neutral"}>{row.finding}</Badge>
                      {truthy(row.indisprimary) ? <Badge>primary</Badge> : null}
                      {truthy(row.indisunique) ? <Badge>unique</Badge> : null}
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-chrome-text/60">{row.definition}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Metric label="size" value={stringOf(row.index_size)} />
                    <Metric label="scans" value={fmtCount(numberOf(row.idx_scan))} />
                    <Metric label="seq" value={fmtCount(numberOf(row.seq_scan))} />
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <ActionButton compact icon={Wrench} label="Reindex" onClick={() => onOpenSql(`Reindex ${row.index_name}`, `REINDEX INDEX CONCURRENTLY ${qIndex};`, false)} />
                    <ActionButton compact icon={Activity} label="Vacuum" onClick={() => onOpenSql(`Vacuum ${row.table_name}`, `VACUUM (VERBOSE, ANALYZE) ${qTable};`, false)} />
                    {canDrop ? (
                      <ActionButton compact icon={AlertTriangle} label="Drop" onClick={() => onOpenSql(`Drop ${row.index_name}`, `DROP INDEX CONCURRENTLY ${qIndex};`, false)} />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}

function PermissionsTab({
  grants,
  memberships,
  rls,
  loading,
  onOpenSql,
}: {
  grants: GrantRow[]
  memberships: MembershipRow[]
  rls: RlsRow[]
  loading: boolean
  onOpenSql: SqlOpener
}) {
  const roles = useMemo(() => Array.from(new Set(grants.map((row) => row.grantee))).sort().slice(0, 12), [grants])
  const objects = useMemo(() => {
    const names = new Set(grants.map((row) => `${row.schema}.${row.table_name}`))
    return Array.from(names).sort().slice(0, 28)
  }, [grants])
  const grantMap = useMemo(() => {
    const map = new Map<string, GrantRow>()
    for (const row of grants) map.set(`${row.schema}.${row.table_name}:${row.grantee}`, row)
    return map
  }, [grants])
  const rlsEnabled = rls.filter((row) => truthy(row.rls_enabled)).length
  if (loading && grants.length === 0 && memberships.length === 0) return <LoadingGrid />

  return (
    <div className="space-y-3">
      <section className="grid gap-3 xl:grid-cols-[1.3fr_0.7fr]">
        <Panel icon={KeyRound} title="Grant Matrix">
          {roles.length === 0 || objects.length === 0 ? (
            <EmptyInline label="No table grants visible" />
          ) : (
            <div className="overflow-auto">
              <div
                className="grid min-w-[720px] gap-px text-[10px]"
                style={{ gridTemplateColumns: `180px repeat(${roles.length}, minmax(42px, 1fr))` }}
              >
                <div className="sticky left-0 z-10 bg-secondary-background/90 px-1 py-1 text-chrome-text/60">object</div>
                {roles.map((role) => (
                  <div key={role} className="truncate px-1 py-1 font-mono text-chrome-text/70" title={role}>{role}</div>
                ))}
                {objects.map((objectName) => (
                  <PermissionRow key={objectName} objectName={objectName} roles={roles} grantMap={grantMap} />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel icon={Shield} title="Role Surface">
          <div className="grid grid-cols-3 gap-3">
            <Metric label="grants" value={fmtCount(grants.length)} />
            <Metric label="memberships" value={fmtCount(memberships.length)} />
            <Metric label="rls tables" value={fmtCount(rlsEnabled)} tone={rlsEnabled ? undefined : "muted"} />
          </div>
          <div className="mt-3 space-y-1">
            {memberships.slice(0, 10).map((row) => (
              <div key={`${row.role}:${row.member}`} className="flex items-center gap-2 rounded-sm border border-chrome-border/45 bg-background/25 px-2 py-1 text-[11px]">
                <span className="truncate font-mono text-foreground">{row.member}</span>
                <span className="text-chrome-text/45">in</span>
                <span className="truncate font-mono text-rvbbit-accent">{row.role}</span>
                {truthy(row.admin_option) ? <Badge tone="warning">admin</Badge> : null}
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel
          icon={Lock}
          title="Row Level Security"
          right={<ActionButton compact icon={Eye} label="SQL" onClick={() => onOpenSql("Permissions and RLS", `${GRANTS_SQL.trim()}\n\n${RLS_SQL.trim()}`, true)} />}
        >
          <HBars
            rows={rls.slice(0, 12).map((row) => ({
              label: `${row.schema}.${row.table_name}`,
              value: Math.max(1, numberOf(row.policies)),
              valueLabel: `${numberOf(row.policies)} policies`,
              sub: truthy(row.rls_enabled) ? "on" : "off",
              color: truthy(row.rls_enabled) ? "var(--rvbbit-accent)" : "var(--chrome-border)",
              muted: !truthy(row.rls_enabled),
            }))}
          />
        </Panel>
        <Panel icon={FileText} title="Templates">
          <div className="grid gap-2 sm:grid-cols-2">
            <ActionButton icon={KeyRound} label="Grant read template" onClick={() => onOpenSql("Grant read template", "GRANT SELECT ON TABLE \"schema\".\"table\" TO \"role\";", false)} />
            <ActionButton icon={AlertTriangle} label="Revoke template" onClick={() => onOpenSql("Revoke template", "REVOKE ALL PRIVILEGES ON TABLE \"schema\".\"table\" FROM \"role\";", false)} />
            <ActionButton icon={Lock} label="Enable RLS template" onClick={() => onOpenSql("Enable RLS template", "ALTER TABLE \"schema\".\"table\" ENABLE ROW LEVEL SECURITY;", false)} />
            <ActionButton icon={Shield} label="Policy template" onClick={() => onOpenSql("RLS policy template", "CREATE POLICY policy_name ON \"schema\".\"table\" FOR SELECT TO \"role\" USING (true);", false)} />
          </div>
        </Panel>
      </section>
    </div>
  )
}

function PermissionRow({
  objectName,
  roles,
  grantMap,
}: {
  objectName: string
  roles: string[]
  grantMap: Map<string, GrantRow>
}) {
  return (
    <>
      <div className="sticky left-0 z-10 truncate border-t border-chrome-border/25 bg-secondary-background/95 px-1 py-1.5 font-mono text-foreground" title={objectName}>{objectName}</div>
      {roles.map((role) => {
        const row = grantMap.get(`${objectName}:${role}`)
        const weight = row ? [row.sel, row.ins, row.upd, row.del, row.ref, row.trg].filter(truthy).length : 0
        return (
          <div
            key={role}
            title={row ? grantLetters(row) : "no grant"}
            className="border-t border-chrome-border/25 px-1 py-1"
          >
            <div
              className="h-4 rounded-[2px] border"
              style={{
                background: weight ? `color-mix(in oklch, var(--rvbbit-accent) ${Math.min(100, 18 + weight * 12)}%, transparent)` : "transparent",
                borderColor: weight ? "color-mix(in oklch, var(--rvbbit-accent) 45%, transparent)" : "var(--chrome-border)",
              }}
            />
          </div>
        )
      })}
    </>
  )
}

function ObjectsTab({
  rows,
  selected,
  details,
  loading,
  onSelect,
  onOpenSql,
}: {
  rows: ObjectRow[]
  selected: ObjectRow | null
  details: ObjectDetailRow[]
  loading: boolean
  onSelect: (row: ObjectRow) => void
  onOpenSql: SqlOpener
}) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const byKind = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of rows) map.set(row.kind, (map.get(row.kind) ?? 0) + 1)
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [rows])
  if (loading && rows.length === 0) return <LoadingGrid />

  return (
    <div className="grid min-h-[520px] gap-3 xl:grid-cols-[360px_1fr]">
      <Panel icon={Layers} title="Objects">
        <CompositionBar
          height={12}
          segments={byKind.map(([kind, value], index) => ({
            label: kind,
            value,
            color: stateColor(kind, index),
          }))}
        />
        <div className="mt-3 max-h-[calc(100vh-250px)] space-y-1 overflow-auto pr-1">
          {rows.map((row) => (
            <button
              key={row.regclass}
              type="button"
              onClick={() => onSelect(row)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: objectActionItems(row, onOpenSql),
                })
              }}
              className={cn(
                "grid w-full grid-cols-[1fr_auto] gap-2 rounded-sm border px-2 py-2 text-left text-[11px]",
                selected?.regclass === row.regclass
                  ? "border-rvbbit-accent/55 bg-rvbbit-accent/10"
                  : "border-chrome-border/45 bg-background/25 hover:border-rvbbit-accent/35",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-foreground">{row.regclass}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-chrome-text/55">
                  <span>{row.kind}</span>
                  <span>-</span>
                  <span>{row.size}</span>
                </span>
              </span>
              <span className="font-mono text-[10px] text-chrome-text/60">{fmtCount(Math.max(0, numberOf(row.row_estimate)))}</span>
            </button>
          ))}
        </div>
        <ContextMenu state={menu} onClose={() => setMenu(null)} />
      </Panel>

      <Panel
        icon={FileText}
        title="Inspector"
        right={selected ? (
          <div className="flex gap-1">
            <ActionButton compact icon={Eye} label="DDL" onClick={() => onOpenSql(`DDL ${selected.regclass}`, objectDdlSql(selected.regclass), true)} />
            {isPreviewableObject(selected) ? (
              <ActionButton compact icon={Table2} label="Preview" onClick={() => onOpenSql(`Preview ${selected.regclass}`, `SELECT *\nFROM ${selected.regclass}\nLIMIT 200;`, true)} />
            ) : null}
          </div>
        ) : null}
      >
        {!selected ? (
          <EmptyInline label="Select an object" />
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 rounded-md border border-chrome-border/45 bg-background/25 p-3 md:grid-cols-4">
              <Metric label="object" value={<span className="truncate">{selected.regclass}</span>} />
              <Metric label="kind" value={selected.kind} />
              <Metric label="size" value={selected.size} />
              <Metric label="rows est" value={fmtCount(Math.max(0, numberOf(selected.row_estimate)))} />
            </div>
            {selected.comment ? (
              <div className="rounded-sm border border-chrome-border/45 bg-background/25 px-2 py-2 text-[12px] text-chrome-text">
                {selected.comment}
              </div>
            ) : null}
            <div className="space-y-1">
              {details.map((detail, index) => (
                <div key={`${detail.section}:${detail.name}:${index}`} className="grid gap-2 rounded-sm border border-chrome-border/45 bg-background/25 px-2 py-2 text-[11px] md:grid-cols-[92px_180px_1fr]">
                  <Badge>{detail.section}</Badge>
                  <span className="truncate font-mono text-foreground" title={detail.name}>{detail.name}</span>
                  <span className="min-w-0 truncate font-mono text-chrome-text/70" title={`${detail.detail} ${detail.extra ?? ""}`}>
                    {detail.detail}{detail.extra ? ` - ${detail.extra}` : ""}
                  </span>
                </div>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <ActionButton icon={Activity} label="Analyze template" onClick={() => onOpenSql(`Analyze ${selected.regclass}`, `ANALYZE VERBOSE ${selected.regclass};`, false)} />
              <ActionButton icon={FileText} label="Comment template" onClick={() => onOpenSql(`Comment ${selected.regclass}`, `COMMENT ON ${objectCommentKind(selected.relkind)} ${selected.regclass} IS '...';`, false)} />
              <ActionButton icon={Wrench} label="Stats SQL" onClick={() => onOpenSql(`Stats ${selected.regclass}`, objectStatsSql(selected.regclass), true)} />
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}

function objectActionItems(row: ObjectRow, onOpenSql: SqlOpener): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: "ddl",
      label: "Inspect DDL",
      icon: FileText,
      onSelect: () => onOpenSql(`DDL ${row.regclass}`, objectDdlSql(row.regclass), true),
    },
    {
      id: "stats",
      label: "Open stats SQL",
      icon: Activity,
      onSelect: () => onOpenSql(`Stats ${row.regclass}`, objectStatsSql(row.regclass), true),
    },
    {
      id: "copy",
      label: "Copy qualified name",
      icon: ClipboardCopy,
      onSelect: () => void navigator.clipboard?.writeText(row.regclass),
    },
  ]
  if (isPreviewableObject(row)) {
    items.splice(1, 0, {
      id: "preview",
      label: "Preview 200 rows",
      icon: Table2,
      onSelect: () => onOpenSql(`Preview ${row.regclass}`, `SELECT *\nFROM ${row.regclass}\nLIMIT 200;`, true),
    })
  }
  items.push(
    {
      id: "analyze",
      label: "Generate ANALYZE",
      icon: Wrench,
      separatorBefore: true,
      onSelect: () => onOpenSql(`Analyze ${row.regclass}`, `ANALYZE VERBOSE ${row.regclass};`, false),
    },
    {
      id: "comment",
      label: "Generate COMMENT",
      icon: FileText,
      onSelect: () => onOpenSql(`Comment ${row.regclass}`, `COMMENT ON ${objectCommentKind(row.relkind)} ${row.regclass} IS '...';`, false),
    },
  )
  return items
}

function isPreviewableObject(row: Pick<ObjectRow, "relkind">): boolean {
  return row.relkind === "r" || row.relkind === "p" || row.relkind === "v" || row.relkind === "m" || row.relkind === "f"
}

function BackupTab({
  overview,
  copied,
  onCopied,
  onOpenSql,
}: {
  overview: OverviewRow | null
  copied: string | null
  onCopied: (value: string | null) => void
  onOpenSql: SqlOpener
}) {
  const [format, setFormat] = useState<"custom" | "plain">("custom")
  const [scope, setScope] = useState<"database" | "schema" | "table">("database")
  const [schema, setSchema] = useState("public")
  const [table, setTable] = useState("")
  const qTable = table.trim() ? qualified(schema.trim() || "public", table.trim()) : qualified(schema.trim() || "public", "table")
  const dumpCommand = buildDumpCommand({ format, scope, schema, table })
  const restoreCommand = format === "custom"
    ? `pg_restore --clean --if-exists --dbname "$DATABASE_URL" backup.dump`
    : `psql "$DATABASE_URL" --file backup.sql`
  const exportSql = `COPY (SELECT * FROM ${qTable}) TO STDOUT WITH CSV HEADER;`

  const copy = useCallback(
    async (key: string, text: string) => {
      await navigator.clipboard?.writeText(text)
      onCopied(key)
      window.setTimeout(() => onCopied(null), 1200)
    },
    [onCopied],
  )

  return (
    <div className="space-y-3">
      <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel icon={Download} title="Plan">
          <div className="grid gap-3">
            <Segmented
              label="format"
              value={format}
              options={[
                { value: "custom", label: "Custom" },
                { value: "plain", label: "Plain SQL" },
              ]}
              onChange={(v) => setFormat(v as "custom" | "plain")}
            />
            <Segmented
              label="scope"
              value={scope}
              options={[
                { value: "database", label: "Database" },
                { value: "schema", label: "Schema" },
                { value: "table", label: "Table" },
              ]}
              onChange={(v) => setScope(v as "database" | "schema" | "table")}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[10px] uppercase tracking-wider text-chrome-text/60">
                Schema
                <input
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  className="mt-1 h-8 w-full rounded-sm border border-chrome-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-rvbbit-accent/60"
                />
              </label>
              <label className="text-[10px] uppercase tracking-wider text-chrome-text/60">
                Table
                <input
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                  className="mt-1 h-8 w-full rounded-sm border border-chrome-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-rvbbit-accent/60"
                />
              </label>
            </div>
          </div>
        </Panel>
        <Panel icon={Database} title="Snapshot Size">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="database" value={overview?.database ?? "current"} />
            <Metric label="size" value={overview?.database_size ?? "unknown"} />
            <Metric label="tables" value={fmtCount(numberOf(overview?.tables))} />
            <Metric label="rows est" value={fmtCount(numberOf(overview?.live_rows))} />
          </div>
          <Sparkline
            className="mt-4"
            values={[
              numberOf(overview?.tables),
              numberOf(overview?.indexes),
              numberOf(overview?.live_rows),
              numberOf(overview?.dead_rows),
              numberOf(overview?.unused_large_indexes),
            ]}
            height={48}
            color="var(--rvbbit-accent)"
          />
        </Panel>
      </section>

      <Panel icon={FileText} title="Commands">
        <div className="grid gap-2">
          <CommandBlock title="dump" value={dumpCommand} copied={copied === "dump"} onCopy={() => void copy("dump", dumpCommand)} />
          <CommandBlock title="restore" value={restoreCommand} copied={copied === "restore"} onCopy={() => void copy("restore", restoreCommand)} />
          <CommandBlock title="table csv" value={exportSql} copied={copied === "export"} onCopy={() => void copy("export", exportSql)} />
        </div>
      </Panel>

      <Panel icon={Shield} title="Verification">
        <div className="grid gap-2 sm:grid-cols-3">
          <ActionButton icon={Eye} label="Backup manifest SQL" onClick={() => onOpenSql("Backup manifest", backupManifestSql(), true)} />
          <ActionButton icon={Table2} label="Table estimate SQL" onClick={() => onOpenSql("Table estimates", tableEstimateSql(), true)} />
          <ActionButton icon={Download} label="Open export SQL" onClick={() => onOpenSql(`Export ${qTable}`, exportSql, false)} />
        </div>
      </Panel>
    </div>
  )
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/60">{label}</div>
      <div className="inline-flex rounded-sm border border-chrome-border/65 bg-background/45 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 px-2.5 text-[11px]",
              value === option.value ? "rounded-[2px] bg-rvbbit-accent/18 text-foreground" : "text-chrome-text hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function CommandBlock({
  title,
  value,
  copied,
  onCopy,
}: {
  title: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-sm border border-chrome-border/50 bg-background/35">
      <div className="flex items-center border-b border-chrome-border/35 px-2 py-1">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/60">{title}</span>
        <button
          type="button"
          onClick={onCopy}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-sm border border-chrome-border/60 px-2 text-[10px] text-chrome-text hover:text-foreground"
        >
          <ClipboardCopy className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-auto px-2 py-2 font-mono text-[11px] leading-relaxed text-foreground">{value}</pre>
    </div>
  )
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  compact = false,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-sm border border-chrome-border/60 bg-secondary-background/60 text-chrome-text transition hover:border-rvbbit-accent/45 hover:text-foreground",
        compact ? "h-6 px-1.5 text-[10px]" : "h-8 px-2.5 text-[11px]",
      )}
    >
      <Icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      <span className="truncate">{label}</span>
    </button>
  )
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode
  tone?: "neutral" | "warning" | "danger"
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[3px] border px-1.5 font-mono text-[9px] uppercase tracking-wider",
        tone === "danger"
          ? "border-danger/45 bg-danger/10 text-danger"
          : tone === "warning"
            ? "border-warning/45 bg-warning/10 text-warning"
            : "border-chrome-border/55 bg-secondary-background/55 text-chrome-text/70",
      )}
    >
      {children}
    </span>
  )
}

function CenteredState({
  icon: Icon,
  title,
  detail,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
}) {
  return (
    <div className="grid h-full place-items-center bg-background p-6 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-md border border-rvbbit-accent/35 bg-rvbbit-accent/10">
          <Icon className="h-6 w-6 text-rvbbit-accent" />
        </div>
        <div className="mt-3 text-sm font-semibold">{title}</div>
        <div className="mt-1 max-w-sm text-sm text-chrome-text">{detail}</div>
      </div>
    </div>
  )
}

function LoadingGrid() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="h-28 animate-pulse rounded-md border border-chrome-border/40 bg-secondary-background/35" />
      ))}
    </div>
  )
}

function EmptyPanel({ title }: { title: string }) {
  return <div className="rounded-md border border-chrome-border/50 bg-secondary-background/35 p-6 text-sm text-chrome-text">{title}</div>
}

function EmptyInline({ label }: { label: string }) {
  return <div className="rounded-sm border border-chrome-border/40 bg-background/25 px-3 py-4 text-sm text-chrome-text">{label}</div>
}

function numberOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function stringOf(value: unknown): string {
  if (value == null) return ""
  if (Array.isArray(value)) return value.join(", ")
  return String(value)
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === "1" || value === 1
}

function ratio(value: number, max: number): number {
  return max <= 0 ? 0 : clamp(value / max, 0, 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function percent(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

function blockerLabel(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ")
  const raw = stringOf(value)
  return raw || "unknown"
}

function grantLetters(row: GrantRow): string {
  const grants = [
    truthy(row.sel) ? "SELECT" : null,
    truthy(row.ins) ? "INSERT" : null,
    truthy(row.upd) ? "UPDATE" : null,
    truthy(row.del) ? "DELETE" : null,
    truthy(row.ref) ? "REFERENCES" : null,
    truthy(row.trg) ? "TRIGGER" : null,
  ].filter(Boolean)
  return grants.length ? grants.join(", ") : "no grant"
}

function stateColor(state: string, index = 0): string {
  const key = state.toLowerCase()
  if (key.includes("active")) return "var(--rvbbit-accent)"
  if (key.includes("idle in transaction")) return "var(--danger)"
  if (key.includes("wait") || key.includes("lock")) return "var(--warning)"
  if (key.includes("idle")) return "color-mix(in oklch, var(--chrome-text) 42%, transparent)"
  const colors = ["oklch(70% 0.15 205)", "oklch(72% 0.14 130)", "oklch(73% 0.14 300)", "oklch(74% 0.12 55)"]
  return colors[index % colors.length]
}

function findingColor(finding: string, index = 0): string {
  if (finding === "unused") return "var(--warning)"
  if (finding === "vacuum debt") return "var(--danger)"
  if (finding === "seq-scan pressure") return "oklch(72% 0.17 205)"
  if (finding === "large low-use") return "oklch(76% 0.14 55)"
  return stateColor(finding, index)
}

function objectDetailSql(regclass: string): string {
  const lit = sqlLiteral(regclass)
  return `
WITH obj AS (
  SELECT to_regclass(${lit}) AS oid
),
cols AS (
  SELECT 'column' AS section,
         a.attnum::int AS ord,
         a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS detail,
         concat_ws(' ', CASE WHEN a.attnotnull THEN 'not null' END, CASE WHEN d.adbin IS NOT NULL THEN 'default ' || pg_get_expr(d.adbin, d.adrelid) END) AS extra
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = (SELECT oid FROM obj)
    AND a.attnum > 0
    AND NOT a.attisdropped
),
idx AS (
  SELECT 'index' AS section,
         (1000 + row_number() OVER (ORDER BY c.relname))::int AS ord,
         c.relname AS name,
         pg_get_indexdef(i.indexrelid) AS detail,
         concat_ws(' ', CASE WHEN i.indisprimary THEN 'primary' END, CASE WHEN i.indisunique THEN 'unique' END) AS extra
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = (SELECT oid FROM obj)
),
cons AS (
  SELECT 'constraint' AS section,
         (2000 + row_number() OVER (ORDER BY conname))::int AS ord,
         conname AS name,
         pg_get_constraintdef(oid, true) AS detail,
         contype::text AS extra
  FROM pg_constraint
  WHERE conrelid = (SELECT oid FROM obj)
),
trig AS (
  SELECT 'trigger' AS section,
         (3000 + row_number() OVER (ORDER BY tgname))::int AS ord,
         tgname AS name,
         pg_get_triggerdef(oid, true) AS detail,
         CASE WHEN tgenabled = 'O' THEN 'enabled' ELSE 'disabled' END AS extra
  FROM pg_trigger
  WHERE tgrelid = (SELECT oid FROM obj)
    AND NOT tgisinternal
)
SELECT *
FROM (
  SELECT * FROM cols
  UNION ALL SELECT * FROM idx
  UNION ALL SELECT * FROM cons
  UNION ALL SELECT * FROM trig
) x
ORDER BY ord;
`.trim()
}

function objectDdlSql(regclass: string): string {
  const lit = sqlLiteral(regclass)
  return `
WITH obj AS (
  SELECT c.oid,
         n.nspname AS schema,
         c.relname AS name,
         c.relkind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = to_regclass(${lit})
)
SELECT schema,
       name,
       relkind,
       CASE
         WHEN relkind IN ('v', 'm') THEN pg_get_viewdef(oid, true)
         WHEN relkind = 'i' THEN pg_get_indexdef(oid)
         WHEN relkind = 'S' THEN 'sequence: ' || format('%I.%I', schema, name)
         ELSE 'Use pg_dump --schema-only --table=' || format('%I.%I', schema, name) || ' for exact CREATE TABLE DDL'
       END AS ddl_or_probe
FROM obj;
`.trim()
}

function objectStatsSql(regclass: string): string {
  const lit = sqlLiteral(regclass)
  return `
SELECT n.nspname AS schema,
       c.relname AS object,
       c.relkind,
       pg_size_pretty(pg_relation_size(c.oid)) AS relation_size,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint AS row_estimate,
       s.seq_scan,
       s.idx_scan,
       s.n_live_tup,
       s.n_dead_tup,
       s.last_vacuum,
       s.last_autovacuum,
       s.last_analyze,
       s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.oid = to_regclass(${lit});
`.trim()
}

function objectCommentKind(relkind: string): string {
  if (relkind === "v") return "VIEW"
  if (relkind === "m") return "MATERIALIZED VIEW"
  if (relkind === "i") return "INDEX"
  if (relkind === "S") return "SEQUENCE"
  return "TABLE"
}

function buildDumpCommand({
  format,
  scope,
  schema,
  table,
}: {
  format: "custom" | "plain"
  scope: "database" | "schema" | "table"
  schema: string
  table: string
}): string {
  const parts = ["pg_dump"]
  parts.push(format === "custom" ? "--format=custom --file=backup.dump" : "--format=plain --file=backup.sql")
  if (scope === "schema") parts.push(`--schema=${shellQuote(schema || "public")}`)
  if (scope === "table") parts.push(`--table=${shellQuote(`${schema || "public"}.${table || "table"}`)}`)
  parts.push('"$DATABASE_URL"')
  return parts.join(" ")
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

function backupManifestSql(): string {
  return `
SELECT current_database() AS database,
       now() AS captured_at,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       current_setting('server_version') AS server_version;

SELECT schemaname,
       relname AS table_name,
       n_live_tup,
       n_dead_tup,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 100;
`.trim()
}

function tableEstimateSql(): string {
  return `
SELECT schemaname,
       relname AS table_name,
       n_live_tup AS live_rows,
       n_dead_tup AS dead_rows,
       last_vacuum,
       last_autovacuum,
       last_analyze,
       last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC
LIMIT 200;
`.trim()
}
