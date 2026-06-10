/**
 * Data layer for the Alerts cockpit — reads rvbbit.alert_* (rules, per-entity
 * state, queue, firing events, sweep heartbeats) and drives the sweep/worker/
 * kill-switch. Mirrors the metrics.ts shape: a `run()` POST to /api/db/query,
 * `q()`/`jb()` literal builders, and `{ data, error }`-style returns (no throws).
 */

interface Ok {
  ok: true
  columns: { name: string }[]
  rows: Record<string, unknown>[]
}
interface Err {
  ok: false
  error: string
}

async function run(connectionId: string, sql: string, rowLimit = 5000): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal (the query API has no bind params). */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}
function obj(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {}
}

// ── types ───────────────────────────────────────────────────────────────────

export interface AlertRule {
  name: string
  conditionSpec: Record<string, unknown> // { kind, query, threshold?, compare? }
  firePolicy: Record<string, unknown> // { consecutive_n?, cooldown_secs? }
  actionSpec: Record<string, unknown> // { operator, server?, tool?, args?, sql?, spec? }
  cardinality: string
  fanOutCap: number
  description: string | null
  enabled: boolean
  muted: boolean
  cadenceTier: string
  createdMs: number | null
  breaching: number
  entities: number
  pending: number
  lastFiredMs: number | null
}

export interface AlertEntity {
  entityKey: string
  lastStatus: string | null
  score: number | null
  consecutive: number
  changedMs: number | null
  firedMs: number | null
}

export interface AlertEvent {
  ruleName: string
  entityKey: string
  transition: string
  status: string
  actionOutput: Record<string, unknown> | null
  error: string | null
  tsMs: number | null
}

export interface AlertSweepRun {
  sweepId: number
  tier: string
  startedMs: number | null
  finishedMs: number | null
  rulesEvaluated: number
  transitions: number
  enqueued: number
  errors: number
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function fetchAlertRules(
  connectionId: string,
): Promise<{ rules: AlertRule[]; enabled: boolean; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT c.name, c.condition_spec, c.fire_policy, c.action_spec, c.cardinality, c.fan_out_cap,
            c.description, c.enabled, c.muted, c.cadence_tier,
            extract(epoch FROM c.created_at) * 1000 AS created_ms,
            (SELECT count(*) FROM rvbbit.alert_state s WHERE s.rule_name = c.name AND s.last_status = 'fail') AS breaching,
            (SELECT count(*) FROM rvbbit.alert_state s WHERE s.rule_name = c.name) AS entities,
            (SELECT count(*) FROM rvbbit.alert_queue qq WHERE qq.rule_name = c.name AND qq.status = 'pending') AS pending,
            (SELECT extract(epoch FROM max(s.last_fired_at)) * 1000 FROM rvbbit.alert_state s WHERE s.rule_name = c.name) AS last_fired_ms,
            rvbbit.alerts_enabled() AS alerts_on
       FROM rvbbit.alert_catalog c
      ORDER BY c.name`,
  )
  if (!r.ok) return { rules: [], enabled: true, error: r.error }
  const rules: AlertRule[] = r.rows.map((row) => ({
    name: String(row.name),
    conditionSpec: obj(row.condition_spec),
    firePolicy: obj(row.fire_policy),
    actionSpec: obj(row.action_spec),
    cardinality: String(row.cardinality ?? "per_entity"),
    fanOutCap: Number(row.fan_out_cap ?? 100),
    description: str(row.description),
    enabled: row.enabled === true || row.enabled === "t",
    muted: row.muted === true || row.muted === "t",
    cadenceTier: String(row.cadence_tier ?? "normal"),
    createdMs: num(row.created_ms),
    breaching: Number(row.breaching ?? 0),
    entities: Number(row.entities ?? 0),
    pending: Number(row.pending ?? 0),
    lastFiredMs: num(row.last_fired_ms),
  }))
  const enabled = r.rows.length > 0 ? r.rows[0].alerts_on === true || r.rows[0].alerts_on === "t" : true
  return { rules, enabled, error: null }
}

export async function fetchAlertState(
  connectionId: string,
  rule: string,
): Promise<{ entities: AlertEntity[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT entity_key, last_status, score, consecutive,
            extract(epoch FROM last_changed_at) * 1000 AS changed_ms,
            extract(epoch FROM last_fired_at) * 1000 AS fired_ms
       FROM rvbbit.alert_state
      WHERE rule_name = ${q(rule)}
      ORDER BY (score IS NULL), score DESC NULLS LAST, entity_key`,
  )
  if (!r.ok) return { entities: [], error: r.error }
  return {
    entities: r.rows.map((row) => ({
      entityKey: String(row.entity_key ?? ""),
      lastStatus: str(row.last_status),
      score: num(row.score),
      consecutive: Number(row.consecutive ?? 0),
      changedMs: num(row.changed_ms),
      firedMs: num(row.fired_ms),
    })),
    error: null,
  }
}

export async function fetchAlertEvents(
  connectionId: string,
  rule: string | null,
  limit = 50,
): Promise<{ events: AlertEvent[]; error: string | null }> {
  const where = rule ? `WHERE rule_name = ${q(rule)}` : ""
  const r = await run(
    connectionId,
    `SELECT rule_name, entity_key, transition, status, action_output, error,
            extract(epoch FROM ts) * 1000 AS ts_ms
       FROM rvbbit.alert_events
       ${where}
      ORDER BY ts DESC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
  )
  if (!r.ok) return { events: [], error: r.error }
  return {
    events: r.rows.map((row) => ({
      ruleName: String(row.rule_name),
      entityKey: String(row.entity_key ?? ""),
      transition: String(row.transition ?? ""),
      status: String(row.status ?? ""),
      actionOutput: row.action_output == null ? null : obj(row.action_output),
      error: str(row.error),
      tsMs: num(row.ts_ms),
    })),
    error: null,
  }
}

export async function fetchAlertSweepRuns(
  connectionId: string,
  limit = 40,
): Promise<{ sweeps: AlertSweepRun[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT sweep_id, tier,
            extract(epoch FROM started_at) * 1000 AS started_ms,
            extract(epoch FROM finished_at) * 1000 AS finished_ms,
            rules_evaluated, transitions, enqueued, errors
       FROM rvbbit.alert_sweep_runs
      ORDER BY started_at DESC
      LIMIT ${Math.max(1, Math.floor(limit))}`,
  )
  if (!r.ok) return { sweeps: [], error: r.error }
  return {
    sweeps: r.rows.map((row) => ({
      sweepId: Number(row.sweep_id),
      tier: String(row.tier ?? ""),
      startedMs: num(row.started_ms),
      finishedMs: num(row.finished_ms),
      rulesEvaluated: Number(row.rules_evaluated ?? 0),
      transitions: Number(row.transitions ?? 0),
      enqueued: Number(row.enqueued ?? 0),
      errors: Number(row.errors ?? 0),
    })),
    error: null,
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

export async function runSweep(
  connectionId: string,
  tier: string,
): Promise<{ summary: Record<string, unknown> | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.alert_sweep(${q(tier)}) AS j`)
  if (!r.ok) return { summary: null, error: r.error }
  return { summary: obj(r.rows[0]?.j), error: null }
}

export async function runWorker(connectionId: string, max = 50): Promise<string | null> {
  const r = await run(connectionId, `SELECT rvbbit.alert_worker_tick(${Math.max(1, Math.floor(max))})::text AS j`)
  return r.ok ? null : r.error
}

export async function setAlertsEnabled(connectionId: string, on: boolean): Promise<string | null> {
  const r = await run(connectionId, `SELECT rvbbit.set_alerts_enabled(${on ? "true" : "false"})`)
  return r.ok ? null : r.error
}

export async function setRuleEnabled(connectionId: string, rule: string, on: boolean): Promise<string | null> {
  const fn = on ? "enable_alert" : "disable_alert"
  const r = await run(connectionId, `SELECT rvbbit.${fn}(${q(rule)})`)
  return r.ok ? null : r.error
}

export async function muteRule(
  connectionId: string,
  rule: string,
  durationMinutes: number | null,
): Promise<string | null> {
  const arg = durationMinutes == null ? "" : `, interval '${Math.max(1, Math.floor(durationMinutes))} minutes'`
  const r = await run(connectionId, `SELECT rvbbit.mute_alert(${q(rule)}${arg})`)
  return r.ok ? null : r.error
}

export async function unmuteRule(connectionId: string, rule: string): Promise<string | null> {
  const r = await run(connectionId, `SELECT rvbbit.unmute_alert(${q(rule)})`)
  return r.ok ? null : r.error
}

/** Delete a rule and everything keyed to it. */
export async function deleteRule(connectionId: string, rule: string): Promise<string | null> {
  const r = await run(connectionId, `SELECT rvbbit.delete_alert(${q(rule)})`)
  return r.ok ? null : r.error
}

export interface MetricObsPreview {
  status: string | null
  dataAsOf: string | null
  value: unknown
  verdict: unknown
}

/** Latest materialized observation for a metric — what a metric-ref condition reads. */
export async function previewMetricObservation(
  connectionId: string,
  metric: string,
): Promise<{ obs: MetricObsPreview | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT status, data_as_of::text AS data_as_of, value, verdict
     FROM rvbbit.metric_observations WHERE metric_name = ${q(metric)}
     ORDER BY data_as_of DESC NULLS LAST, observed_at DESC LIMIT 1`,
  )
  if (!r.ok) return { obs: null, error: r.error }
  const row = r.rows[0]
  if (!row) return { obs: null, error: null }
  return {
    obs: {
      status: str(row.status),
      dataAsOf: str(row.data_as_of),
      value: row.value,
      verdict: row.verdict,
    },
    error: null,
  }
}

/** A row from a live condition-query preview (which entities + score/status). */
export interface PreviewRow {
  entityKey: string
  score: number | null
  status: string | null
}

/** Run a condition query read-only to preview its (entity_key, score/status) rows
 *  — the observable feedback while authoring a rule. */
export async function previewCondition(
  connectionId: string,
  query: string,
): Promise<{ rows: PreviewRow[]; error: string | null }> {
  const trimmed = query.trim().replace(/;+\s*$/, "")
  if (!trimmed) return { rows: [], error: null }
  const r = await run(connectionId, `SELECT to_jsonb(q) AS j FROM (${trimmed}) q LIMIT 500`, 500)
  if (!r.ok) return { rows: [], error: r.error }
  return {
    rows: r.rows.map((row) => {
      const j = obj(row.j)
      return {
        entityKey: j.entity_key == null ? "" : String(j.entity_key),
        score: j.score == null ? null : Number(j.score),
        status: j.status == null ? null : String(j.status),
      }
    }),
    error: null,
  }
}

/** Preview a boolean-expression condition: wraps the query in the same
 *  CASE-over-columns the sweep uses, so a non-boolean expr surfaces as an error
 *  (the validation). Each row's status is the expr verdict. */
export async function previewExprCondition(
  connectionId: string,
  query: string,
  expr: string,
): Promise<{ rows: PreviewRow[]; error: string | null }> {
  const trimmed = query.trim().replace(/;+\s*$/, "")
  const e = expr.trim()
  if (!trimmed || !e) return { rows: [], error: null }
  const wrapped = `SELECT q2.*, CASE WHEN (${e}) THEN 'fail' ELSE 'pass' END AS _alert_status FROM (${trimmed}) q2`
  const r = await run(connectionId, `SELECT to_jsonb(q) AS j FROM (${wrapped}) q LIMIT 500`, 500)
  if (!r.ok) return { rows: [], error: r.error }
  return {
    rows: r.rows.map((row) => {
      const j = obj(row.j)
      return {
        entityKey: j.entity_key == null ? "" : String(j.entity_key),
        score: j.score == null ? null : Number(j.score),
        status: j._alert_status == null ? null : String(j._alert_status),
      }
    }),
    error: null,
  }
}

/** The output column names of a condition query — exactly what an expr can
 *  reference (the SELECT's aliases, not the underlying table columns). Reads the
 *  result metadata so it works even when the query returns zero rows. */
export async function fetchExprColumns(
  connectionId: string,
  query: string,
): Promise<{ columns: string[]; error: string | null }> {
  const trimmed = query.trim().replace(/;+\s*$/, "")
  if (!trimmed) return { columns: [], error: null }
  const r = await run(connectionId, `SELECT * FROM (${trimmed}) q LIMIT 1`, 1)
  if (!r.ok) return { columns: [], error: r.error }
  return { columns: r.columns.map((c) => c.name), error: null }
}

export interface AlertDraft {
  name: string
  description: string
  conditionSpec: Record<string, unknown>
  firePolicy: Record<string, unknown>
  actionSpec: Record<string, unknown>
  cardinality: string
  fanOutCap: number
  cadenceTier: string
}

/** Author (or re-version) a rule via rvbbit.define_alert. */
export async function createAlert(connectionId: string, d: AlertDraft): Promise<string | null> {
  const lit = (v: unknown) => `'${JSON.stringify(v ?? {}).replace(/'/g, "''")}'::jsonb`
  const r = await run(
    connectionId,
    `SELECT rvbbit.define_alert(${q(d.name)}, ${lit(d.conditionSpec)}, ${lit(d.actionSpec)}, ` +
      `p_fire_policy => ${lit(d.firePolicy)}, p_cardinality => ${q(d.cardinality)}, ` +
      `p_fan_out_cap => ${Math.max(1, Math.floor(d.fanOutCap))}, p_cadence => ${q(d.cadenceTier)}, ` +
      `p_description => ${d.description.trim() ? q(d.description.trim()) : "NULL"})`,
  )
  return r.ok ? null : r.error
}

/** Re-define a rule with a new scalar threshold (a new immutable version). */
export async function commitThreshold(connectionId: string, rule: AlertRule, threshold: number): Promise<string | null> {
  const cond = { ...rule.conditionSpec, threshold }
  const condLit = `'${JSON.stringify(cond).replace(/'/g, "''")}'::jsonb`
  const actLit = `'${JSON.stringify(rule.actionSpec).replace(/'/g, "''")}'::jsonb`
  const fpLit = `'${JSON.stringify(rule.firePolicy).replace(/'/g, "''")}'::jsonb`
  const r = await run(
    connectionId,
    `SELECT rvbbit.define_alert(${q(rule.name)}, ${condLit}, ${actLit}, p_fire_policy => ${fpLit}, ` +
      `p_cardinality => ${q(rule.cardinality)}, p_fan_out_cap => ${rule.fanOutCap}, ` +
      `p_cadence => ${q(rule.cadenceTier)}, p_description => ${rule.description ? q(rule.description) : "NULL"})`,
  )
  return r.ok ? null : r.error
}
