"use client"

type DagsterTableName =
  | "runs"
  | "run_tags"
  | "event_logs"
  | "asset_keys"
  | "asset_event_tags"
  | "asset_check_executions"
  | "daemon_heartbeats"
  | "bulk_actions"
  | "backfill_tags"
  | "jobs"
  | "instigators"
  | "job_ticks"
  | "dynamic_partitions"
  | "concurrency_limits"
  | "concurrency_slots"
  | "pending_steps"

const TABLE_NAMES: DagsterTableName[] = [
  "runs",
  "run_tags",
  "event_logs",
  "asset_keys",
  "asset_event_tags",
  "asset_check_executions",
  "daemon_heartbeats",
  "bulk_actions",
  "backfill_tags",
  "jobs",
  "instigators",
  "job_ticks",
  "dynamic_partitions",
  "concurrency_limits",
  "concurrency_slots",
  "pending_steps",
]

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}

interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string, rowLimit = 5000): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, readOnly: true, poolLane: "meta" }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function qi(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function qa(values: readonly string[]): string {
  return values.map(q).join(", ")
}

export interface DagsterTableRef {
  schema: string
  name: DagsterTableName
  columns: string[]
}

export interface DagsterDetection {
  detected: boolean
  confidence: number
  schemas: string[]
  tables: Partial<Record<DagsterTableName, DagsterTableRef>>
  missingCore: string[]
  error?: string
}

export interface DagsterOverview {
  runsTotal: number
  eventsTotal: number
  assetsTotal: number
  checksTotal: number
  checksFailed: number
  automationsTotal: number
  daemonHeartbeats: number
  latestRunAt: number | null
  latestEventAt: number | null
  statusCounts: Record<string, number>
}

export interface DagsterRunRow {
  runId: string
  jobName: string
  status: string
  partition: string | null
  partitionSet: string | null
  backfillId: string | null
  createdAt: number | null
  updatedAt: number | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  tags: Record<string, unknown>
}

export interface DagsterAssetRow {
  assetKey: string
  label: string
  lastRunId: string | null
  lastEventAt: number | null
  materializations: number
  observations: number
  failedMaterializations: number
  checks: number
}

export interface DagsterCheckRow {
  assetKey: string
  assetLabel: string
  checkName: string
  partition: string | null
  runId: string | null
  status: string
  evaluatedAt: number | null
}

export interface DagsterAutomationRow {
  id: string
  name: string
  type: string
  status: string
  updatedAt: number | null
  lastTickAt: number | null
  lastTickStatus: string | null
  ticks: DagsterAutomationTick[]
}

export interface DagsterAutomationTick {
  id: string | null
  status: string
  type: string | null
  timestamp: number | null
  updatedAt: number | null
}

export interface DagsterEventRow {
  id: number
  runId: string | null
  eventType: string | null
  timestamp: number | null
  stepKey: string | null
  assetKey: string | null
  assetLabel: string | null
  partition: string | null
}

export interface DagsterFlowEdge {
  source: string
  assetKey: string
  assetLabel: string
  eventType: string | null
  count: number
  lastAt: number | null
}

export interface DagsterSnapshot {
  detection: DagsterDetection
  overview: DagsterOverview
  runs: DagsterRunRow[]
  assets: DagsterAssetRow[]
  checks: DagsterCheckRow[]
  automations: DagsterAutomationRow[]
  events: DagsterEventRow[]
  flows: DagsterFlowEdge[]
  error?: string
}

export async function detectDagsterStorage(connectionId: string): Promise<DagsterDetection> {
  const sql = `
SELECT t.table_schema,
       t.table_name,
       coalesce(array_agg(c.column_name ORDER BY c.ordinal_position)
         FILTER (WHERE c.column_name IS NOT NULL), ARRAY[]::text[]) AS columns
FROM information_schema.tables t
LEFT JOIN information_schema.columns c
  ON c.table_schema = t.table_schema
 AND c.table_name = t.table_name
WHERE t.table_type = 'BASE TABLE'
  AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
  AND t.table_name IN (${qa(TABLE_NAMES)})
GROUP BY t.table_schema, t.table_name
ORDER BY t.table_schema, t.table_name`
  const res = await runQuery(connectionId, sql, 500)
  if (!res.ok) {
    return {
      detected: false,
      confidence: 0,
      schemas: [],
      tables: {},
      missingCore: ["runs", "event_logs", "asset_keys"],
      error: res.error,
    }
  }

  const candidates = res.rows.map((r) => ({
    schema: str(r.table_schema),
    name: str(r.table_name) as DagsterTableName,
    columns: asStringArray(r.columns),
  }))
  const tables: Partial<Record<DagsterTableName, DagsterTableRef>> = {}
  for (const name of TABLE_NAMES) {
    const matches = candidates.filter((c) => c.name === name)
    if (matches.length === 0) continue
    matches.sort((a, b) => tableScore(b.name, b.columns) - tableScore(a.name, a.columns))
    tables[name] = matches[0]
  }

  const hasRuns = hasColumns(tables.runs, ["run_id", "status", "pipeline_name"])
  const hasEvents = hasColumns(tables.event_logs, ["id", "run_id", "event", "dagster_event_type", "timestamp"])
  const hasAssets = hasColumns(tables.asset_keys, ["asset_key"])
  const hasChecks = hasColumns(tables.asset_check_executions, ["asset_key", "check_name", "execution_status"])
  const hasSchedule = hasColumns(tables.instigators, ["selector_id", "status"]) || hasColumns(tables.jobs, ["job_origin_id", "status"])
  const hasHeartbeats = hasColumns(tables.daemon_heartbeats, ["daemon_type", "timestamp"])

  let confidence = 0
  if (hasRuns) confidence += 30
  if (hasEvents) confidence += 30
  if (hasAssets) confidence += 15
  if (hasChecks) confidence += 10
  if (hasSchedule) confidence += 8
  if (hasHeartbeats) confidence += 7
  confidence = Math.min(100, confidence)

  const missingCore = [
    !hasRuns ? "runs" : null,
    !hasEvents ? "event_logs" : null,
    !hasAssets ? "asset_keys" : null,
  ].filter((x): x is string => !!x)
  const schemas = [...new Set(Object.values(tables).map((t) => t?.schema).filter((s): s is string => !!s))]

  return {
    detected: confidence >= 45 || (hasRuns && hasEvents) || (hasEvents && hasAssets),
    confidence,
    schemas,
    tables,
    missingCore,
  }
}

export async function fetchDagsterSnapshot(connectionId: string): Promise<DagsterSnapshot> {
  const detection = await detectDagsterStorage(connectionId)
  if (!detection.detected) {
    return {
      detection,
      overview: emptyOverview(),
      runs: [],
      assets: [],
      checks: [],
      automations: [],
      events: [],
      flows: [],
      error: detection.error,
    }
  }

  const [overview, runs, assets, checks, automations, events, flows] = await Promise.all([
    fetchOverview(connectionId, detection),
    fetchRuns(connectionId, detection),
    fetchAssets(connectionId, detection),
    fetchChecks(connectionId, detection),
    fetchAutomations(connectionId, detection),
    fetchEvents(connectionId, detection),
    fetchFlows(connectionId, detection),
  ])

  return { detection, overview, runs, assets, checks, automations, events, flows }
}

async function fetchOverview(connectionId: string, d: DagsterDetection): Promise<DagsterOverview> {
  const runs = d.tables.runs
  const events = d.tables.event_logs
  const assets = d.tables.asset_keys
  const checks = d.tables.asset_check_executions
  const instigators = d.tables.instigators
  const jobs = d.tables.jobs
  const heartbeats = d.tables.daemon_heartbeats
  const parts = [
    countExpr(runs, "runs_total"),
    countExpr(events, "events_total"),
    countExpr(assets, "assets_total"),
    countExpr(checks, "checks_total"),
    checks ? `(SELECT count(*)::bigint FROM ${qt(checks)} WHERE execution_status ILIKE '%fail%') AS checks_failed` : `0::bigint AS checks_failed`,
    instigators
      ? countExpr(instigators, "automations_total")
      : jobs
        ? countExpr(jobs, "automations_total")
        : `0::bigint AS automations_total`,
    countExpr(heartbeats, "daemon_heartbeats"),
    runs && hasCol(runs, "create_timestamp")
      ? `(SELECT max(create_timestamp) FROM ${qt(runs)}) AS latest_run_at`
      : `NULL::timestamptz AS latest_run_at`,
    events && hasCol(events, "timestamp")
      ? `(SELECT max(timestamp) FROM ${qt(events)}) AS latest_event_at`
      : `NULL::timestamptz AS latest_event_at`,
    runs ? `(SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*)::bigint AS n FROM ${qt(runs)} GROUP BY status) s) AS status_counts` : `'{}'::jsonb AS status_counts`,
  ]
  const res = await runQuery(connectionId, `SELECT ${parts.join(",\n       ")}`, 1)
  if (!res.ok) return emptyOverview()
  const r = res.rows[0] ?? {}
  return {
    runsTotal: num(r.runs_total),
    eventsTotal: num(r.events_total),
    assetsTotal: num(r.assets_total),
    checksTotal: num(r.checks_total),
    checksFailed: num(r.checks_failed),
    automationsTotal: num(r.automations_total),
    daemonHeartbeats: num(r.daemon_heartbeats),
    latestRunAt: epoch(r.latest_run_at),
    latestEventAt: epoch(r.latest_event_at),
    statusCounts: asNumberMap(r.status_counts),
  }
}

async function fetchRuns(connectionId: string, d: DagsterDetection): Promise<DagsterRunRow[]> {
  const runs = d.tables.runs
  if (!runs) return []
  const tags = d.tables.run_tags
  const tagJoin = tags
    ? `LEFT JOIN (
         SELECT run_id, jsonb_object_agg(key, value) AS tags
         FROM ${qt(tags)}
         GROUP BY run_id
       ) tag ON tag.run_id = r.run_id`
    : ""
  const tagsExpr = tags ? "coalesce(tag.tags, '{}'::jsonb)" : "'{}'::jsonb"
  const createdExpr = hasCol(runs, "create_timestamp") ? "r.create_timestamp" : "NULL::timestamptz"
  const updatedExpr = hasCol(runs, "update_timestamp") ? "r.update_timestamp" : createdExpr
  const startAt = hasCol(runs, "start_time") ? `to_timestamp(NULLIF(r.start_time::double precision, 0))` : "NULL::timestamptz"
  const endAt = hasCol(runs, "end_time") ? `to_timestamp(NULLIF(r.end_time::double precision, 0))` : "NULL::timestamptz"
  const orderParts = [
    hasCol(runs, "end_time") ? "r.end_time::double precision" : null,
    hasCol(runs, "start_time") ? "r.start_time::double precision" : null,
    hasCol(runs, "update_timestamp") ? "extract(epoch from r.update_timestamp)" : null,
    hasCol(runs, "create_timestamp") ? "extract(epoch from r.create_timestamp)" : null,
  ].filter((p): p is string => !!p)
  const orderExpr = orderParts.length ? `coalesce(${orderParts.join(", ")})` : "0"
  const sql = `
SELECT r.run_id::text,
       r.pipeline_name::text AS job_name,
       r.status::text,
       ${nullableText(runs, "partition", "r")} AS partition,
       ${nullableText(runs, "partition_set", "r")} AS partition_set,
       ${nullableText(runs, "backfill_id", "r")} AS backfill_id,
       ${createdExpr} AS created_at,
       ${updatedExpr} AS updated_at,
       ${startAt} AS started_at,
       ${endAt} AS ended_at,
       CASE
         WHEN ${endAt} IS NOT NULL AND ${startAt} IS NOT NULL
         THEN round(extract(epoch FROM (${endAt} - ${startAt})) * 1000)::bigint
         ELSE NULL
       END AS duration_ms,
       ${tagsExpr} AS tags
FROM ${qt(runs)} r
${tagJoin}
ORDER BY ${orderExpr} DESC NULLS LAST
LIMIT 120`
  const res = await runQuery(connectionId, sql, 120)
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: str(r.run_id),
    jobName: str(r.job_name) || "(unknown)",
    status: str(r.status) || "UNKNOWN",
    partition: strOrNull(r.partition),
    partitionSet: strOrNull(r.partition_set),
    backfillId: strOrNull(r.backfill_id),
    createdAt: epoch(r.created_at),
    updatedAt: epoch(r.updated_at),
    startedAt: epoch(r.started_at),
    endedAt: epoch(r.ended_at),
    durationMs: numOrNull(r.duration_ms),
    tags: asObject(r.tags),
  }))
}

async function fetchAssets(connectionId: string, d: DagsterDetection): Promise<DagsterAssetRow[]> {
  const assets = d.tables.asset_keys
  const events = d.tables.event_logs
  if (!assets && !events) return []
  if (assets) {
    const eventAssets = events && hasCol(events, "asset_key") && hasCol(events, "dagster_event_type") && hasCol(events, "timestamp")
    const lastAssetTimestamp = hasCol(assets, "last_materialization_timestamp")
      ? "a.last_materialization_timestamp"
      : hasCol(assets, "create_timestamp")
        ? "a.create_timestamp"
        : "NULL::timestamptz"
    const eventAgg = eventAssets
      ? `LEFT JOIN (
           SELECT asset_key,
                  count(*) FILTER (WHERE dagster_event_type = 'ASSET_MATERIALIZATION')::bigint AS materializations,
                  count(*) FILTER (WHERE dagster_event_type = 'ASSET_OBSERVATION')::bigint AS observations,
                  count(*) FILTER (WHERE dagster_event_type = 'ASSET_FAILED_TO_MATERIALIZE')::bigint AS failed_materializations,
                  max(timestamp) AS last_event_at
           FROM ${qt(events)}
           WHERE asset_key IS NOT NULL
           GROUP BY asset_key
         ) ev ON ev.asset_key = a.asset_key`
      : ""
    const checkAgg = d.tables.asset_check_executions
      ? `LEFT JOIN (
           SELECT asset_key, count(*)::bigint AS checks
           FROM ${qt(d.tables.asset_check_executions)}
           GROUP BY asset_key
         ) chk ON chk.asset_key = a.asset_key`
      : ""
    const lastEventExpr = eventAssets ? `coalesce(ev.last_event_at, ${lastAssetTimestamp})` : lastAssetTimestamp
    const materializationsExpr = eventAssets ? "coalesce(ev.materializations, 0)" : "0"
    const observationsExpr = eventAssets ? "coalesce(ev.observations, 0)" : "0"
    const failedExpr = eventAssets ? "coalesce(ev.failed_materializations, 0)" : "0"
    const checksExpr = d.tables.asset_check_executions ? "coalesce(chk.checks, 0)" : "0"
    const sql = `
SELECT a.asset_key::text,
       ${nullableText(assets, "last_run_id", "a")} AS last_run_id,
       ${lastEventExpr} AS last_event_at,
       ${materializationsExpr}::bigint AS materializations,
       ${observationsExpr}::bigint AS observations,
       ${failedExpr}::bigint AS failed_materializations,
       ${checksExpr}::bigint AS checks
FROM ${qt(assets)} a
${eventAgg}
${checkAgg}
ORDER BY ${lastEventExpr} DESC NULLS LAST
LIMIT 200`
    const res = await runQuery(connectionId, sql, 200)
    if (!res.ok) return []
    return res.rows.map(assetRow)
  }
  if (!hasCol(events!, "asset_key") || !hasCol(events!, "dagster_event_type") || !hasCol(events!, "timestamp")) return []
  const res = await runQuery(
    connectionId,
    `SELECT asset_key::text,
            NULL::text AS last_run_id,
            max(timestamp) AS last_event_at,
            count(*) FILTER (WHERE dagster_event_type = 'ASSET_MATERIALIZATION')::bigint AS materializations,
            count(*) FILTER (WHERE dagster_event_type = 'ASSET_OBSERVATION')::bigint AS observations,
            count(*) FILTER (WHERE dagster_event_type = 'ASSET_FAILED_TO_MATERIALIZE')::bigint AS failed_materializations,
            0::bigint AS checks
     FROM ${qt(events!)}
     WHERE asset_key IS NOT NULL
     GROUP BY asset_key
     ORDER BY max(timestamp) DESC NULLS LAST
     LIMIT 200`,
    200,
  )
  return res.ok ? res.rows.map(assetRow) : []
}

async function fetchChecks(connectionId: string, d: DagsterDetection): Promise<DagsterCheckRow[]> {
  const checks = d.tables.asset_check_executions
  if (!checks) return []
  const evaluatedExpr = hasCol(checks, "evaluation_event_timestamp")
    ? "evaluation_event_timestamp"
    : hasCol(checks, "create_timestamp")
      ? "create_timestamp"
      : "NULL::timestamptz"
  const evaluatedOrder = hasCol(checks, "evaluation_event_timestamp")
    ? "evaluation_event_timestamp"
    : hasCol(checks, "create_timestamp")
      ? "create_timestamp"
      : "asset_key"
  const sql = `
SELECT asset_key::text,
       check_name::text,
       ${nullableText(checks, "partition")} AS partition,
       ${nullableText(checks, "run_id")} AS run_id,
       execution_status::text AS status,
       ${evaluatedExpr} AS evaluated_at
FROM ${qt(checks)}
ORDER BY ${evaluatedOrder} DESC NULLS LAST
LIMIT 200`
  const res = await runQuery(connectionId, sql, 200)
  if (!res.ok) return []
  return res.rows.map((r) => {
    const assetKey = str(r.asset_key)
    return {
      assetKey,
      assetLabel: formatAssetKey(assetKey),
      checkName: str(r.check_name),
      partition: strOrNull(r.partition),
      runId: strOrNull(r.run_id),
      status: str(r.status) || "UNKNOWN",
      evaluatedAt: epoch(r.evaluated_at),
    }
  })
}

async function fetchAutomations(connectionId: string, d: DagsterDetection): Promise<DagsterAutomationRow[]> {
  const instigators = d.tables.instigators
  const jobs = d.tables.jobs
  const ticks = d.tables.job_ticks
  const base = instigators ?? jobs
  if (!base) return []
  const idCol = instigators ? "selector_id" : "job_origin_id"
  const typeCol = instigators ? "instigator_type" : "job_type"
  const bodyCol = instigators ? "instigator_body" : "job_body"
  const bodyExpr = hasCol(base, bodyCol) ? `b.${qi(bodyCol)}` : "NULL::text"
  const selectorExpr = hasCol(base, "selector_id") ? `b.${qi("selector_id")}::text` : `b.${qi(idCol)}::text`
  const nameExpr = `coalesce(
         ${bodyNameExpr(bodyExpr)},
         nullif(regexp_replace(${selectorExpr}, '^.*[/:|]', ''), ''),
         b.${qi(idCol)}::text
       )`
  const statusExpr = hasCol(base, "status") ? "b.status::text" : "'UNKNOWN'::text"
  const updatedExpr = hasCol(base, "update_timestamp")
    ? "b.update_timestamp"
    : hasCol(base, "create_timestamp")
      ? "b.create_timestamp"
      : "NULL::timestamptz"
  const updatedOrder = hasCol(base, "update_timestamp")
    ? "b.update_timestamp"
    : hasCol(base, "create_timestamp")
      ? "b.create_timestamp"
      : `b.${qi(idCol)}`
  const tickPredicate = ticks ? automationTickPredicate(ticks, base, idCol) : null
  const canReadTicks = !!ticks && !!tickPredicate && hasCol(ticks, "timestamp") && hasCol(ticks, "status")
  const tickIdExpr = ticks && hasCol(ticks, "id") ? "jt.id::text" : "NULL::text"
  const tickTypeExpr = ticks && hasCol(ticks, "type") ? "jt.type::text" : "NULL::text"
  const tickUpdatedExpr = ticks && hasCol(ticks, "update_timestamp") ? "jt.update_timestamp" : "NULL::timestamptz"
  const tickJoin = canReadTicks
    ? `LEFT JOIN LATERAL (
         SELECT max(recent.tick_ts) AS last_tick_at,
                (array_agg(recent.tick_status ORDER BY recent.tick_ts DESC NULLS LAST))[1] AS last_tick_status,
                coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'id', recent.tick_id,
                      'status', recent.tick_status,
                      'type', recent.tick_type,
                      'timestamp', recent.tick_ts,
                      'updatedAt', recent.tick_updated_at
                    )
                    ORDER BY recent.tick_ts ASC NULLS LAST
                  ),
                  '[]'::jsonb
                ) AS tick_history
         FROM (
           SELECT ${tickIdExpr} AS tick_id,
                  jt.status::text AS tick_status,
                  ${tickTypeExpr} AS tick_type,
                  jt.timestamp AS tick_ts,
                  ${tickUpdatedExpr} AS tick_updated_at
           FROM ${qt(ticks)}
           WHERE ${tickPredicate}
           ORDER BY jt.timestamp DESC NULLS LAST
           LIMIT 24
         ) recent
       ) tick ON true`
    : ""
  const lastTickAt = canReadTicks ? "tick.last_tick_at" : "NULL::timestamptz"
  const lastTickStatus = canReadTicks ? "tick.last_tick_status::text" : "NULL::text"
  const tickHistory = canReadTicks ? "coalesce(tick.tick_history, '[]'::jsonb)" : "'[]'::jsonb"
  const sql = `
SELECT b.${qi(idCol)}::text AS id,
       ${nameExpr} AS name,
       ${hasCol(base, typeCol) ? `b.${qi(typeCol)}::text` : "'automation'::text"} AS type,
       ${statusExpr} AS status,
       ${updatedExpr} AS updated_at,
       ${lastTickAt} AS last_tick_at,
       ${lastTickStatus} AS last_tick_status,
       ${tickHistory} AS tick_history
FROM ${qt(base)} b
${tickJoin}
ORDER BY ${updatedOrder} DESC NULLS LAST
LIMIT 120`
  const res = await runQuery(connectionId, sql, 120)
  if (!res.ok) return []
  return res.rows.map((r) => ({
    id: str(r.id),
    name: str(r.name) || str(r.id) || "(unknown automation)",
    type: str(r.type) || "automation",
    status: str(r.status) || "UNKNOWN",
    updatedAt: epoch(r.updated_at),
    lastTickAt: epoch(r.last_tick_at),
    lastTickStatus: strOrNull(r.last_tick_status),
    ticks: asAutomationTicks(r.tick_history),
  }))
}

async function fetchEvents(connectionId: string, d: DagsterDetection): Promise<DagsterEventRow[]> {
  const events = d.tables.event_logs
  if (!events) return []
  const sql = `
SELECT id::bigint,
       ${nullableText(events, "run_id")} AS run_id,
       ${nullableText(events, "dagster_event_type")} AS event_type,
       timestamp,
       ${nullableText(events, "step_key")} AS step_key,
       ${nullableText(events, "asset_key")} AS asset_key,
       ${nullableText(events, "partition")} AS partition
FROM ${qt(events)}
ORDER BY id DESC
LIMIT 220`
  const res = await runQuery(connectionId, sql, 220)
  if (!res.ok) return []
  return res.rows.map((r) => {
    const assetKey = strOrNull(r.asset_key)
    return {
      id: num(r.id),
      runId: strOrNull(r.run_id),
      eventType: strOrNull(r.event_type),
      timestamp: epoch(r.timestamp),
      stepKey: strOrNull(r.step_key),
      assetKey,
      assetLabel: assetKey ? formatAssetKey(assetKey) : null,
      partition: strOrNull(r.partition),
    }
  })
}

async function fetchFlows(connectionId: string, d: DagsterDetection): Promise<DagsterFlowEdge[]> {
  const events = d.tables.event_logs
  if (!events) return []
  if (!hasCol(events, "asset_key") || !hasCol(events, "dagster_event_type") || !hasCol(events, "timestamp")) return []
  const runs = d.tables.runs
  const join = runs ? `LEFT JOIN ${qt(runs)} r ON r.run_id = e.run_id` : ""
  const source = runs ? "coalesce(r.pipeline_name, '(unknown job)')" : "coalesce(e.run_id, '(unknown run)')"
  const sql = `
SELECT ${source}::text AS source,
       e.asset_key::text,
       e.dagster_event_type::text AS event_type,
       count(*)::bigint AS count,
       max(e.timestamp) AS last_at
FROM ${qt(events)} e
${join}
WHERE e.asset_key IS NOT NULL
  AND e.dagster_event_type IN ('ASSET_MATERIALIZATION', 'ASSET_OBSERVATION', 'ASSET_CHECK_EVALUATION', 'ASSET_FAILED_TO_MATERIALIZE')
GROUP BY 1, 2, 3
ORDER BY max(e.timestamp) DESC NULLS LAST
LIMIT 160`
  const res = await runQuery(connectionId, sql, 160)
  if (!res.ok) return []
  return res.rows.map((r) => {
    const assetKey = str(r.asset_key)
    return {
      source: str(r.source) || "(unknown)",
      assetKey,
      assetLabel: formatAssetKey(assetKey),
      eventType: strOrNull(r.event_type),
      count: num(r.count),
      lastAt: epoch(r.last_at),
    }
  })
}

function tableScore(name: DagsterTableName, columns: string[]): number {
  const required: Partial<Record<DagsterTableName, string[]>> = {
    runs: ["run_id", "status", "pipeline_name"],
    run_tags: ["run_id", "key", "value"],
    event_logs: ["id", "run_id", "event", "dagster_event_type", "timestamp"],
    asset_keys: ["asset_key"],
    asset_check_executions: ["asset_key", "check_name", "execution_status"],
    daemon_heartbeats: ["daemon_type", "timestamp"],
    jobs: ["job_origin_id", "status", "job_type"],
    instigators: ["selector_id", "status", "instigator_type"],
    job_ticks: ["selector_id", "status", "timestamp"],
  }
  return (required[name] ?? ["id"]).filter((c) => columns.includes(c)).length
}

function hasColumns(ref: DagsterTableRef | undefined, cols: string[]): boolean {
  if (!ref) return false
  return cols.every((c) => ref.columns.includes(c))
}

function hasCol(ref: DagsterTableRef, col: string): boolean {
  return ref.columns.includes(col)
}

function nullableText(ref: DagsterTableRef, col: string, alias?: string): string {
  if (!hasCol(ref, col)) return "NULL::text"
  return `${alias ? `${alias}.` : ""}${qi(col)}::text`
}

function bodyNameExpr(bodyExpr: string): string {
  const keys = ["instigator_name", "schedule_name", "sensor_name", "job_name", "name"]
  return `coalesce(${keys.map((key) => `nullif(substring(${bodyExpr} FROM ${q(`"${key}"[[:space:]]*:[[:space:]]*"([^"]+)"`)}), '')`).join(", ")})`
}

function automationTickPredicate(ticks: DagsterTableRef, base: DagsterTableRef, idCol: string): string | null {
  const terms: string[] = []
  if (hasCol(ticks, "selector_id") && hasCol(base, "selector_id")) {
    terms.push(`jt.${qi("selector_id")} = b.${qi("selector_id")}`)
  }
  if (hasCol(ticks, "selector_id") && !hasCol(base, "selector_id")) {
    terms.push(`jt.${qi("selector_id")} = b.${qi(idCol)}`)
  }
  if (hasCol(ticks, "job_origin_id") && hasCol(base, "job_origin_id")) {
    terms.push(`jt.${qi("job_origin_id")} = b.${qi("job_origin_id")}`)
  }
  if (hasCol(ticks, "job_origin_id") && !hasCol(base, "job_origin_id")) {
    terms.push(`jt.${qi("job_origin_id")} = b.${qi(idCol)}`)
  }
  return terms.length ? terms.join(" OR ") : null
}

function qt(ref: DagsterTableRef): string {
  return `${qi(ref.schema)}.${qi(ref.name)}`
}

function countExpr(ref: DagsterTableRef | undefined, alias: string): string {
  return ref ? `(SELECT count(*)::bigint FROM ${qt(ref)}) AS ${alias}` : `0::bigint AS ${alias}`
}

function assetRow(r: Record<string, unknown>): DagsterAssetRow {
  const assetKey = str(r.asset_key)
  return {
    assetKey,
    label: formatAssetKey(assetKey),
    lastRunId: strOrNull(r.last_run_id),
    lastEventAt: epoch(r.last_event_at),
    materializations: num(r.materializations),
    observations: num(r.observations),
    failedMaterializations: num(r.failed_materializations),
    checks: num(r.checks),
  }
}

export function formatAssetKey(raw: string): string {
  if (!raw) return "(unknown asset)"
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((p) => String(p)).join("/")
    if (typeof parsed === "string") return parsed
  } catch {
    // fall through
  }
  return raw.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "")
}

function emptyOverview(): DagsterOverview {
  return {
    runsTotal: 0,
    eventsTotal: 0,
    assetsTotal: 0,
    checksTotal: 0,
    checksFailed: 0,
    automationsTotal: 0,
    daemonHeartbeats: 0,
    latestRunAt: null,
    latestEventAt: null,
    statusCounts: {},
  }
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === "string") {
    return value
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter(Boolean)
  }
  return []
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function asAutomationTicks(value: unknown): DagsterAutomationTick[] {
  return asArray(value).map((item) => {
    const obj = asObject(item)
    return {
      id: strOrNull(obj.id),
      status: str(obj.status) || "UNKNOWN",
      type: strOrNull(obj.type),
      timestamp: epoch(obj.timestamp),
      updatedAt: epoch(obj.updatedAt),
    }
  })
}

function asNumberMap(value: unknown): Record<string, number> {
  const obj = asObject(value)
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = num(v)
  return out
}

function epoch(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000
    return Number.isFinite(ms) ? ms : null
  }
  const t = new Date(String(value)).getTime()
  return Number.isFinite(t) ? t : null
}

function num(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string {
  return value == null ? "" : String(value)
}

function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value)
}
