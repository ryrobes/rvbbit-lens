"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Database,
  KeyRound,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Table2,
  Users,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { ResultGrid } from "./result-grid"
import { fmtAgo, fmtCount, Metric } from "./instruments"
import type { QueryResult } from "@/lib/db/types"
import type { SystemObjectCategory, SystemObjectsPayload } from "@/lib/desktop/types"

interface SystemObjectsWindowProps {
  payload: SystemObjectsPayload
  activeConnectionId: string | null
}

interface CategoryDef {
  key: SystemObjectCategory
  label: string
  icon: React.ComponentType<{ className?: string }>
  sql: string
  description: string
}

const CATEGORIES: CategoryDef[] = [
  {
    key: "tables",
    label: "Tables",
    icon: Table2,
    sql: TABLES_SQL(),
    description: "Relations from user schemas, with row estimates and on-disk size.",
  },
  {
    key: "indexes",
    label: "Indexes",
    icon: KeyRound,
    sql: INDEXES_SQL(),
    description: "All indexes outside pg_catalog, sorted by on-disk size.",
  },
  {
    key: "extensions",
    label: "Extensions",
    icon: Settings2,
    sql: EXT_SQL(),
    description: "Installed Postgres extensions and their schemas.",
  },
  {
    key: "roles",
    label: "Roles",
    icon: Users,
    sql: ROLES_SQL(),
    description: "Database roles and their privileges.",
  },
  {
    key: "settings",
    label: "Settings",
    icon: Settings2,
    sql: SETTINGS_SQL(),
    description: "Server configuration parameters from pg_settings.",
  },
  {
    key: "activity",
    label: "Activity",
    icon: Activity,
    sql: ACTIVITY_SQL(),
    description: "Live client-backend sessions and their wait states.",
  },
  {
    key: "locks",
    label: "Locks",
    icon: Lock,
    sql: LOCKS_SQL(),
    description: "Lock state across all relations excluding virtualxid noise.",
  },
  {
    key: "stats",
    label: "Stats",
    icon: Database,
    sql: STATS_SQL(),
    description: "Per-database commit/rollback and buffer cache hit ratios.",
  },
]

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

export function SystemObjectsWindow({ payload, activeConnectionId }: SystemObjectsWindowProps) {
  const [active, setActive] = useState<SystemObjectCategory>(
    payload.initialCategory ?? "tables",
  )
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(10_000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0

  const def = useMemo(() => CATEGORIES.find((c) => c.key === active)!, [active])

  const run = useCallback(async () => {
    if (!activeConnectionId) return
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, sql: def.sql, rowLimit: 2000 }),
      })
      const body = await res.json()
      if (body.ok === false) {
        setError(body.error)
        setResult(null)
      } else {
        setResult(body as QueryResult)
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUpdatedAt(Date.now())
    }
  }, [activeConnectionId, def.sql])

  // Re-run when the active category changes — and reset polling clock
  // so the new tab feels fresh. setState is deferred via queueMicrotask
  // to satisfy the React-purity lint and avoid a synchronous cascade.
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setResult(null)
      setUpdatedAt(0)
    })
    const r = async () => {
      if (cancelled) return
      await run()
    }
    void r()
    return () => {
      cancelled = true
    }
  }, [active, run])

  // Live polling. Activity/Locks/Stats are the views where the data
  // actually shifts under the user; the rest still poll but you'll
  // mostly see the same rows.
  useEffect(() => {
    if (!activeConnectionId || paused) return
    const id = setInterval(() => void run(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, paused, intervalMs, run])

  const summary = useMemo(
    () => deriveCategorySummary(active, result?.rows ?? []),
    [active, result],
  )

  return (
    <div className="flex h-full bg-doc-bg text-[12px] text-chrome-text">
      {/* sidebar */}
      <aside className="flex w-44 shrink-0 flex-col border-r border-chrome-border bg-chrome-bg/30">
        <div className="border-b border-chrome-border/40 px-3 py-2 text-[9px] uppercase tracking-wider text-chrome-text/55">
          <Layers className="mr-1 inline h-3 w-3 text-brand-system-objects" />
          system objects
        </div>
        {CATEGORIES.map((c) => {
          const Icon = c.icon
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setActive(c.key)}
              className={cn(
                "flex items-center gap-2 border-b border-chrome-border/30 px-3 py-2 text-left text-xs transition-colors hover:bg-foreground/[0.04]",
                active === c.key
                  ? "border-l-2 border-l-brand-system-objects bg-foreground/[0.05] text-foreground"
                  : "text-chrome-text",
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5",
                  active === c.key ? "text-brand-system-objects" : "",
                )}
              />
              {c.label}
            </button>
          )
        })}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* live header */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
              paused ? "bg-foreground/[0.05] text-chrome-text" : "bg-success/10 text-success",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                paused ? "bg-chrome-text" : "animate-pulse bg-success",
              )}
            />
            {paused ? "paused" : "live"}
          </span>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <def.icon className="h-3.5 w-3.5 text-brand-system-objects" />
            {def.label}
          </span>
          {result ? (
            <>
              <span className="text-chrome-text/40">·</span>
              <span>
                <span className="font-mono tabular-nums text-foreground">
                  {fmtCount(result.rows.length)}
                </span>{" "}
                rows
              </span>
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            {updatedAt > 0 ? (
              <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
            ) : null}
            <select
              value={intervalMs}
              onChange={(e) => setIntervalMs(Number(e.target.value))}
              title="Refresh interval"
              className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              {REFRESH_OPTIONS_MS.map((o) => (
                <option key={o.ms} value={o.ms}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              title={paused ? "Resume" : "Pause"}
              className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
            >
              {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => void run()}
              title="Reload"
              className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* per-category summary strip */}
        <div className="border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1.5">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-1.5">
            {summary.length > 0 ? (
              summary.map((m) => (
                <Metric
                  key={m.label}
                  label={m.label}
                  value={m.value}
                  tone={m.tone}
                />
              ))
            ) : (
              <span className="text-[10px] italic text-chrome-text/45">
                {def.description}
              </span>
            )}
            {summary.length > 0 ? (
              <span className="ml-auto max-w-[420px] text-right text-[10px] italic text-chrome-text/45">
                {def.description}
              </span>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {result ? (
            <ResultGrid columns={result.columns} rows={result.rows} />
          ) : loading ? (
            <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
              loading {def.label.toLowerCase()}…
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

// ── Per-category summary derivation ─────────────────────────────────

interface SummaryMetric {
  label: string
  value: React.ReactNode
  tone?: "danger" | "warning" | "muted"
}

function deriveCategorySummary(
  category: SystemObjectCategory,
  rows: Array<Record<string, unknown>>,
): SummaryMetric[] {
  if (rows.length === 0) return []
  switch (category) {
    case "tables": {
      const bySize = rows.reduce((s, r) => s + (Number(r.bytes) || 0), 0)
      const byKind = countBy(rows, (r) => String(r.kind ?? "table"))
      return [
        { label: "tables", value: fmtCount(byKind.get("table") ?? 0) },
        ...maybeMetric("views", byKind.get("view")),
        ...maybeMetric("matviews", byKind.get("matview")),
        ...maybeMetric("partitions", byKind.get("partition")),
        { label: "total size", value: fmtBytes(bySize) },
      ]
    }
    case "indexes": {
      const bySize = rows.reduce((s, r) => s + (Number(r.bytes) || 0), 0)
      const unique = rows.filter((r) => r.is_unique === true || r.is_unique === "t").length
      const primary = rows.filter((r) => r.is_pk === true || r.is_pk === "t").length
      return [
        { label: "indexes", value: fmtCount(rows.length) },
        { label: "unique", value: String(unique) },
        { label: "primary keys", value: String(primary) },
        { label: "total size", value: fmtBytes(bySize) },
      ]
    }
    case "extensions":
      return [
        { label: "installed", value: fmtCount(rows.length) },
        ...maybeMetric(
          "schemas",
          new Set(rows.map((r) => String(r.schema ?? ""))).size,
        ),
      ]
    case "roles": {
      const supers = rows.filter((r) => r.super === true || r.super === "t").length
      const canLogin = rows.filter((r) => r.can_login === true || r.can_login === "t").length
      const replication = rows.filter(
        (r) => r.replication === true || r.replication === "t",
      ).length
      return [
        { label: "roles", value: fmtCount(rows.length) },
        { label: "can login", value: String(canLogin) },
        { label: "superusers", value: String(supers), tone: supers > 1 ? "warning" : undefined },
        { label: "replication", value: String(replication) },
      ]
    }
    case "settings": {
      const byCat = new Set(rows.map((r) => String(r.category ?? "")))
      return [
        { label: "settings", value: fmtCount(rows.length) },
        { label: "categories", value: String(byCat.size) },
      ]
    }
    case "activity": {
      const byState = countBy(rows, (r) => String(r.state ?? "?"))
      const waiting = rows.filter((r) => r.wait_event_type != null).length
      return [
        { label: "sessions", value: fmtCount(rows.length) },
        { label: "active", value: String(byState.get("active") ?? 0) },
        { label: "idle", value: String((byState.get("idle") ?? 0) + (byState.get("idle in transaction") ?? 0)) },
        {
          label: "waiting",
          value: String(waiting),
          tone: waiting > 0 ? "warning" : undefined,
        },
      ]
    }
    case "locks": {
      const ungranted = rows.filter(
        (r) => r.granted === false || r.granted === "f",
      ).length
      const distinctPids = new Set(rows.map((r) => r.pid)).size
      return [
        { label: "locks", value: fmtCount(rows.length) },
        { label: "backends", value: String(distinctPids) },
        {
          label: "ungranted",
          value: String(ungranted),
          tone: ungranted > 0 ? "danger" : undefined,
        },
      ]
    }
    case "stats": {
      let blksRead = 0
      let blksHit = 0
      let commits = 0
      let rollbacks = 0
      let deadlocks = 0
      for (const r of rows) {
        blksRead += Number(r.blks_read) || 0
        blksHit += Number(r.blks_hit) || 0
        commits += Number(r.xact_commit) || 0
        rollbacks += Number(r.xact_rollback) || 0
        deadlocks += Number(r.deadlocks) || 0
      }
      const totalBlk = blksRead + blksHit
      const hit = totalBlk > 0 ? blksHit / totalBlk : 0
      return [
        { label: "databases", value: String(rows.length) },
        {
          label: "cache hit",
          value: `${(hit * 100).toFixed(2)}%`,
          tone: hit < 0.95 && totalBlk > 1000 ? "warning" : undefined,
        },
        { label: "commits", value: fmtCount(commits) },
        {
          label: "rollbacks",
          value: fmtCount(rollbacks),
          tone: rollbacks > commits * 0.1 ? "warning" : "muted",
        },
        {
          label: "deadlocks",
          value: String(deadlocks),
          tone: deadlocks > 0 ? "danger" : undefined,
        },
      ]
    }
  }
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const item of items) {
    const k = keyFn(item)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

function maybeMetric(label: string, value: number | undefined): SummaryMetric[] {
  if (!value || value === 0) return []
  return [{ label, value: String(value) }]
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// ── Catalog queries — kept short and explicit. ─────────────────────────

function TABLES_SQL(): string {
  // `bytes` powers the summary strip; `size` is the human-readable
  // column shown in the grid.
  return `SELECT n.nspname AS schema,
       c.relname  AS name,
       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'matview' WHEN 'p' THEN 'partition'
            WHEN 'f' THEN 'foreign' END AS kind,
       c.reltuples::bigint AS row_estimate,
       pg_total_relation_size(c.oid) AS bytes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
       obj_description(c.oid, 'pg_class')           AS comment
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','v','m','p','f')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC NULLS LAST`
}

function INDEXES_SQL(): string {
  return `SELECT n.nspname AS schema,
       t.relname  AS table,
       i.relname  AS index,
       am.amname  AS method,
       pg_relation_size(i.oid) AS bytes,
       pg_size_pretty(pg_relation_size(i.oid)) AS size,
       ix.indisunique AS is_unique,
       ix.indisprimary AS is_pk
FROM pg_index ix
JOIN pg_class i  ON i.oid = ix.indexrelid
JOIN pg_class t  ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = i.relam
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY pg_relation_size(i.oid) DESC NULLS LAST`
}

function EXT_SQL(): string {
  return `SELECT extname AS name, extversion AS version,
       n.nspname AS schema,
       d.description AS description
FROM pg_extension e
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass
ORDER BY extname`
}

function ROLES_SQL(): string {
  return `SELECT rolname AS name,
       rolsuper AS super,
       rolcreatedb AS create_db,
       rolcreaterole AS create_role,
       rolcanlogin AS can_login,
       rolreplication AS replication,
       rolbypassrls AS bypass_rls,
       rolconnlimit AS conn_limit
FROM pg_roles
ORDER BY rolname`
}

function SETTINGS_SQL(): string {
  return `SELECT name, setting, unit, category, short_desc
FROM pg_settings
WHERE category NOT LIKE 'File Locations%'
ORDER BY category, name`
}

function ACTIVITY_SQL(): string {
  return `SELECT pid, usename, datname, application_name,
       state, wait_event_type, wait_event,
       backend_start, xact_start, query_start,
       left(query, 240) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
ORDER BY xact_start NULLS LAST`
}

function LOCKS_SQL(): string {
  return `SELECT l.locktype, l.relation::regclass AS relation,
       l.mode, l.granted, l.pid, a.usename, a.application_name,
       left(a.query, 200) AS query
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype != 'virtualxid'
ORDER BY l.granted, l.pid`
}

function STATS_SQL(): string {
  return `SELECT datname AS database,
       numbackends, xact_commit, xact_rollback,
       blks_read, blks_hit,
       tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
       deadlocks, temp_files, temp_bytes
FROM pg_stat_database
ORDER BY xact_commit DESC NULLS LAST`
}
