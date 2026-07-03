"use client"

/**
 * Client-side model for rvbbit's SQL-native training surface — the tables and
 * functions documented in docs/RVBBIT_ROUTE_TRAINING_UI.md. Read-side helpers
 * mirror the routing.ts conventions; write-side helpers wrap the curated
 * function API (`route_create_profile`, `route_train_query`, `route_profile_rebuild`,
 * `route_activate_profile`, `route_retire_profile`, `route_training_delete_query`)
 * plus the documented ordinary-SQL escape hatches (enable/disable toggle).
 *
 * Source of truth: a single Postgres connection. All mutations are sent as
 * regular SELECT … FROM rvbbit.xxx(…) statements through /api/db/query.
 */

import { ENGINES, normalizeCandidate, type EngineId } from "./routing"

// ── Row types ───────────────────────────────────────────────────────

export type EngineMs = Record<EngineId, number | null>

export interface ProfileRow {
  name: string
  active: boolean
  createdAt: string | null
  updatedAt: string | null
  entries: number
  points: number
  avgConfidence: number | null
  candidateMix: Partial<Record<EngineId, number>>
  generatedBy: string | null
  importedFromName: string | null
  rejectedCount: number
  trainingQueries: number
}

export interface ProfileEntryRow {
  shapeKey: string
  shapeFamily: string
  choice: string
  confidence: number
  reason: string
  observations: number
  engineTimes: EngineMs
}

export interface RejectedShape {
  shapeKey: string
  reason: string
  candidate: string | null
  engineTimes: EngineMs
  raw: Record<string, unknown>
}

export interface TrainingQueryRow {
  id: number
  profileName: string
  label: string | null
  enabled: boolean
  queryHash: string
  shapeKey: string
  shapeFamily: string
  querySql: string
  features: Record<string, unknown>
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  runs: number
  lastFinishedAt: string | null
}

export interface TrainingSummaryRow {
  trainingQueryId: number
  candidate: string
  okRuns: number
  errorRuns: number
  medianMs: number | null
  firstSeen: string | null
  lastSeen: string | null
  lastValidationStatus: string
  lastError: string | null
}

export interface TrainingRunRow {
  id: number
  trainingQueryId: number
  profileName: string
  startedAt: string | null
  finishedAt: string | null
  status: string
  repeats: number
  candidates: string[]
  settings: Record<string, unknown>
  summary: Record<string, unknown> | null
}

export interface TrainingResultRow {
  id: number
  runId: number
  trainingQueryId: number
  observedAt: string | null
  candidate: string
  repeatIdx: number
  elapsedMs: number | null
  rowsReturned: number | null
  resultDigest: string | null
  status: string
  validationStatus: string
  error: string | null
  routeDoc: Record<string, unknown> | null
}

// ── Query plumbing ──────────────────────────────────────────────────

interface QueryOk {
  ok: true
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 5000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true"
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ── Engine timing helpers (same column shape as profile_summary) ────

function engineMsFromColumns(r: Record<string, unknown>): EngineMs {
  return {
    rvbbit_native: numOrNull(r.native_ms),
    duck_vector: numOrNull(r.duck_ms),
    duck_vortex: numOrNull(r.duck_vortex_ms),
    duck_hive: numOrNull(r.duck_hive_ms),
    datafusion_vector: numOrNull(r.datafusion_ms),
    datafusion_vortex: numOrNull(r.datafusion_vortex_ms),
    datafusion_hive: numOrNull(r.datafusion_hive_ms),
    gpu_gqe: numOrNull(r.gpu_gqe_ms),
    pg_rowstore: numOrNull(r.pg_ms),
  }
}

// ── Profiles ────────────────────────────────────────────────────────

export async function fetchProfiles(connectionId: string): Promise<{
  rows: ProfileRow[]
  error?: string
}> {
  const sql = `
    WITH entries AS (
      SELECT profile_name, count(*) AS entries, avg(confidence) AS avg_conf
      FROM rvbbit.route_profile_entries
      GROUP BY profile_name
    ),
    mix AS (
      SELECT profile_name, choice, count(*) AS n
      FROM rvbbit.route_profile_entries
      GROUP BY profile_name, choice
    ),
    points AS (
      SELECT profile_name, count(*) AS n
      FROM rvbbit.route_profile_points
      GROUP BY profile_name
    ),
    queries AS (
      SELECT profile_name, count(*) AS n
      FROM rvbbit.route_training_queries
      GROUP BY profile_name
    )
    SELECT
      p.name, p.active, p.created_at, p.updated_at,
      p.profile->>'generated_by' AS generated_by,
      p.profile->>'imported_from_name' AS imported_from_name,
      coalesce(jsonb_typeof(p.profile->'rejected'), 'null') AS rejected_type,
      CASE WHEN jsonb_typeof(p.profile->'rejected') = 'object'
           THEN (SELECT count(*) FROM jsonb_object_keys(p.profile->'rejected'))
           ELSE 0 END AS rejected_count,
      coalesce(e.entries, 0) AS entries,
      coalesce(e.avg_conf, 0) AS avg_conf,
      coalesce(pts.n, 0) AS points,
      coalesce(q.n, 0) AS queries,
      (
        SELECT jsonb_object_agg(choice, n)
        FROM mix m WHERE m.profile_name = p.name
      ) AS candidate_mix
    FROM rvbbit.route_profiles p
    LEFT JOIN entries e ON e.profile_name = p.name
    LEFT JOIN points  pts ON pts.profile_name = p.name
    LEFT JOIN queries q   ON q.profile_name = p.name
    ORDER BY p.active DESC, p.updated_at DESC NULLS LAST, p.name
  `
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => {
      const mixRaw = asObject(r.candidate_mix)
      const mix: Partial<Record<EngineId, number>> = {}
      for (const [k, v] of Object.entries(mixRaw)) {
        const cand = normalizeCandidate(k) as EngineId
        mix[cand] = (mix[cand] ?? 0) + Number(v)
      }
      return {
        name: String(r.name ?? ""),
        active: bool(r.active),
        createdAt: r.created_at ? String(r.created_at) : null,
        updatedAt: r.updated_at ? String(r.updated_at) : null,
        entries: num(r.entries),
        points: num(r.points),
        avgConfidence: numOrNull(r.avg_conf),
        candidateMix: mix,
        generatedBy: r.generated_by ? String(r.generated_by) : null,
        importedFromName: r.imported_from_name ? String(r.imported_from_name) : null,
        rejectedCount: num(r.rejected_count),
        trainingQueries: num(r.queries),
      }
    }),
  }
}

export async function fetchProfileEntriesByName(
  connectionId: string,
  profileName: string,
): Promise<ProfileEntryRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT shape_key, shape_family, choice, confidence, observations, reason,
            native_ms, duck_ms, duck_vortex_ms, duck_hive_ms,
            datafusion_ms, datafusion_vortex_ms, datafusion_hive_ms, gpu_gqe_ms, pg_ms
     FROM rvbbit.route_profile_summary
     WHERE profile_name = ${sqlStr(profileName)}
     ORDER BY confidence DESC NULLS LAST, observations DESC`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    shapeKey: String(r.shape_key ?? ""),
    shapeFamily: String(r.shape_family ?? ""),
    choice: normalizeCandidate(String(r.choice ?? "")),
    confidence: num(r.confidence),
    reason: String(r.reason ?? ""),
    observations: num(r.observations),
    engineTimes: engineMsFromColumns(r),
  }))
}

export async function fetchRejectedShapes(
  connectionId: string,
  profileName: string,
): Promise<RejectedShape[]> {
  const res = await runQuery(
    connectionId,
    `SELECT rej.key AS shape_key, rej.value AS rejection
     FROM rvbbit.route_profiles rp
     CROSS JOIN LATERAL jsonb_each(coalesce(rp.profile->'rejected', '{}'::jsonb)) AS rej
     WHERE rp.name = ${sqlStr(profileName)}
     ORDER BY rej.key`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    const raw = asObject(r.rejection)
    const cands = asObject(raw.candidate_medians ?? raw.medians)
    const engineTimes: EngineMs = {
      rvbbit_native: numOrNull(cands.rvbbit_native ?? cands.native),
      duck_vector: numOrNull(cands.duck_vector ?? cands.duck),
      duck_vortex: numOrNull(cands.duck_vortex),
      duck_hive: numOrNull(cands.duck_hive),
      datafusion_vector: numOrNull(cands.datafusion_vector ?? cands.datafusion),
      datafusion_vortex: numOrNull(cands.datafusion_vortex ?? cands.df_vortex ?? cands.vortex),
      datafusion_hive: numOrNull(cands.datafusion_hive ?? cands.df_hive),
      gpu_gqe: numOrNull(cands.gpu_gqe ?? cands.gqe ?? cands.gpu),
      pg_rowstore: numOrNull(cands.pg_rowstore ?? cands.pg_heap ?? cands.pg),
    }
    return {
      shapeKey: String(r.shape_key ?? ""),
      reason: typeof raw.reason === "string" ? (raw.reason as string) : "",
      candidate:
        typeof raw.candidate === "string" ? normalizeCandidate(raw.candidate as string) : null,
      engineTimes,
      raw,
    }
  })
}

// ── Training queries ────────────────────────────────────────────────

export async function fetchTrainingQueries(
  connectionId: string,
  profileName: string,
): Promise<TrainingQueryRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT tq.id, tq.profile_name, tq.label, tq.enabled, tq.query_hash,
            tq.shape_key, tq.shape_family, tq.query_sql, tq.features::text AS features_text,
            tq.created_by, tq.created_at, tq.updated_at,
            count(DISTINCT r.id) AS runs,
            max(r.finished_at) AS last_finished_at
     FROM rvbbit.route_training_queries tq
     LEFT JOIN rvbbit.route_training_runs r ON r.training_query_id = tq.id
     WHERE tq.profile_name = ${sqlStr(profileName)}
     GROUP BY tq.id, tq.profile_name, tq.label, tq.enabled, tq.query_hash,
              tq.shape_key, tq.shape_family, tq.query_sql, tq.features,
              tq.created_by, tq.created_at, tq.updated_at
     ORDER BY tq.updated_at DESC NULLS LAST, tq.id DESC`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    let features: Record<string, unknown> = {}
    try {
      features = r.features_text ? JSON.parse(String(r.features_text)) : {}
    } catch {
      /* ignore */
    }
    return {
      id: num(r.id),
      profileName: String(r.profile_name ?? ""),
      label: r.label ? String(r.label) : null,
      enabled: bool(r.enabled),
      queryHash: String(r.query_hash ?? ""),
      shapeKey: String(r.shape_key ?? ""),
      shapeFamily: String(r.shape_family ?? ""),
      querySql: String(r.query_sql ?? ""),
      features,
      createdBy: r.created_by ? String(r.created_by) : null,
      createdAt: r.created_at ? String(r.created_at) : null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
      runs: num(r.runs),
      lastFinishedAt: r.last_finished_at ? String(r.last_finished_at) : null,
    }
  })
}

export async function fetchTrainingSummary(
  connectionId: string,
  profileName: string,
): Promise<TrainingSummaryRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT training_query_id, candidate, ok_runs, error_runs, median_ms,
            first_seen, last_seen, last_validation_status, last_error
     FROM rvbbit.route_training_summary
     WHERE profile_name = ${sqlStr(profileName)}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    trainingQueryId: num(r.training_query_id),
    candidate: normalizeCandidate(String(r.candidate ?? "")),
    okRuns: num(r.ok_runs),
    errorRuns: num(r.error_runs),
    medianMs: numOrNull(r.median_ms),
    firstSeen: r.first_seen ? String(r.first_seen) : null,
    lastSeen: r.last_seen ? String(r.last_seen) : null,
    lastValidationStatus: String(r.last_validation_status ?? ""),
    lastError: r.last_error ? String(r.last_error) : null,
  }))
}

export async function fetchTrainingRuns(
  connectionId: string,
  profileName: string,
  trainingQueryId: number,
): Promise<TrainingRunRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT id, training_query_id, profile_name, started_at, finished_at, status,
            repeats, candidates, settings::text AS settings_text, summary::text AS summary_text
     FROM rvbbit.route_training_runs
     WHERE profile_name = ${sqlStr(profileName)}
       AND training_query_id = ${trainingQueryId}
     ORDER BY started_at DESC
     LIMIT 25`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    let settings: Record<string, unknown> = {}
    let summary: Record<string, unknown> | null = null
    try {
      if (r.settings_text) settings = JSON.parse(String(r.settings_text))
    } catch { /* ignore */ }
    try {
      if (r.summary_text) summary = JSON.parse(String(r.summary_text))
    } catch { /* ignore */ }
    const candidatesRaw = r.candidates
    const candidates =
      Array.isArray(candidatesRaw)
        ? candidatesRaw.map((c) => normalizeCandidate(String(c)))
        : []
    return {
      id: num(r.id),
      trainingQueryId: num(r.training_query_id),
      profileName: String(r.profile_name ?? ""),
      startedAt: r.started_at ? String(r.started_at) : null,
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      status: String(r.status ?? ""),
      repeats: num(r.repeats),
      candidates,
      settings,
      summary,
    }
  })
}

export async function fetchTrainingResults(
  connectionId: string,
  runId: number,
): Promise<TrainingResultRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT id, run_id, training_query_id, observed_at, candidate, repeat_idx,
            elapsed_ms, rows_returned, result_digest, status, validation_status, error,
            route_doc::text AS route_doc_text
     FROM rvbbit.route_training_results
     WHERE run_id = ${runId}
     ORDER BY candidate, repeat_idx`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    let routeDoc: Record<string, unknown> | null = null
    try {
      if (r.route_doc_text) routeDoc = JSON.parse(String(r.route_doc_text))
    } catch { /* ignore */ }
    return {
      id: num(r.id),
      runId: num(r.run_id),
      trainingQueryId: num(r.training_query_id),
      observedAt: r.observed_at ? String(r.observed_at) : null,
      candidate: normalizeCandidate(String(r.candidate ?? "")),
      repeatIdx: num(r.repeat_idx),
      elapsedMs: numOrNull(r.elapsed_ms),
      rowsReturned: numOrNull(r.rows_returned),
      resultDigest: r.result_digest ? String(r.result_digest) : null,
      status: String(r.status ?? ""),
      validationStatus: String(r.validation_status ?? ""),
      error: r.error ? String(r.error) : null,
      routeDoc,
    }
  })
}

// ── Mutations ───────────────────────────────────────────────────────

interface MutationOk<T> {
  ok: true
  data: T
}
interface MutationErr {
  ok: false
  error: string
}
export type MutationResult<T> = MutationOk<T> | MutationErr

export async function createProfile(
  connectionId: string,
  name: string,
  activate: boolean,
): Promise<MutationResult<Record<string, unknown>>> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_create_profile(${sqlStr(name)}, ${activate}) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: asObject(res.rows[0]?.r) }
}

export async function activateProfile(
  connectionId: string,
  name: string,
): Promise<MutationResult<Record<string, unknown>>> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_activate_profile(${sqlStr(name)}) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: asObject(res.rows[0]?.r) }
}

export async function retireProfile(
  connectionId: string,
  name: string,
): Promise<MutationResult<Record<string, unknown>>> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_retire_profile(${sqlStr(name)}) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: asObject(res.rows[0]?.r) }
}

export interface RebuildResult {
  profile: string
  active: boolean
  entries: number
  rejected: number
  points: number
}

export async function rebuildProfile(
  connectionId: string,
  name: string,
  minGainPct: number,
  activate: boolean,
): Promise<MutationResult<RebuildResult>> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_profile_rebuild(${sqlStr(name)}, ${minGainPct}, ${activate}) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  const obj = asObject(res.rows[0]?.r)
  return {
    ok: true,
    data: {
      profile: String(obj.profile ?? name),
      active: bool(obj.active),
      entries: num(obj.entries),
      rejected: num(obj.rejected),
      points: num(obj.points),
    },
  }
}

export interface TrainQueryArgs {
  profileName: string
  sql: string
  label: string | null
  repeats: number
  minGainPct: number
  activate: boolean
  /** "all" | "all+pg" | comma-separated candidate list. */
  candidates: string
}

export interface TrainCandidateResult {
  candidate: string
  runs: number
  okRuns: number
  errorRuns: number
  skippedRuns: number
  medianMs: number | null
  lastValidationStatus: string
  lastError: string | null
}

export interface TrainResult {
  profile: string
  trainingQueryId: number
  runId: number
  results: TrainCandidateResult[]
  rebuild: RebuildResult | null
}

export async function trainQuery(
  connectionId: string,
  args: TrainQueryArgs,
): Promise<MutationResult<TrainResult>> {
  const labelArg =
    args.label && args.label.trim().length > 0
      ? `, label => ${sqlStr(args.label.trim())}`
      : ""
  const sql = `SELECT rvbbit.route_train_query(
      profile_name => ${sqlStr(args.profileName)},
      query => ${sqlStr(args.sql)},
      repeats => ${Math.max(1, Math.min(100, Math.floor(args.repeats)))},
      min_gain_pct => ${args.minGainPct},
      activate => ${args.activate},
      candidates => ${sqlStr(args.candidates)}${labelArg}
    ) AS r`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { ok: false, error: res.error }
  const obj = asObject(res.rows[0]?.r)
  const resultsRaw = Array.isArray(obj.results) ? obj.results : []
  const results: TrainCandidateResult[] = resultsRaw.map((r) => {
    const o = asObject(r)
    return {
      candidate: normalizeCandidate(String(o.candidate ?? "")),
      runs: num(o.runs),
      okRuns: num(o.ok_runs),
      errorRuns: num(o.error_runs),
      skippedRuns: num(o.skipped_runs),
      medianMs: numOrNull(o.median_ms),
      lastValidationStatus: String(o.last_validation_status ?? ""),
      lastError: o.last_error ? String(o.last_error) : null,
    }
  })
  const rb = obj.rebuild ? asObject(obj.rebuild) : null
  const rebuild: RebuildResult | null = rb
    ? {
        profile: String(rb.profile ?? args.profileName),
        active: bool(rb.active),
        entries: num(rb.entries),
        rejected: num(rb.rejected),
        points: num(rb.points),
      }
    : null
  return {
    ok: true,
    data: {
      profile: String(obj.profile ?? args.profileName),
      trainingQueryId: num(obj.training_query_id),
      runId: num(obj.run_id),
      results,
      rebuild,
    },
  }
}

export async function setTrainingEnabled(
  connectionId: string,
  profileName: string,
  trainingQueryId: number,
  enabled: boolean,
): Promise<MutationResult<{ updated: number }>> {
  const res = await runQuery(
    connectionId,
    `WITH upd AS (
       UPDATE rvbbit.route_training_queries
       SET enabled = ${enabled}, updated_at = now()
       WHERE profile_name = ${sqlStr(profileName)}
         AND id = ${trainingQueryId}
       RETURNING 1
     )
     SELECT count(*)::int AS updated FROM upd`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: { updated: num(res.rows[0]?.updated) } }
}

export async function deleteTrainingQuery(
  connectionId: string,
  profileName: string,
  trainingQueryId: number,
  rebuild: boolean,
): Promise<MutationResult<{ deleted: number; rebuild: RebuildResult | null }>> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.route_training_delete_query(
       ${sqlStr(profileName)}, ${trainingQueryId}, rebuild => ${rebuild}
     ) AS r`,
  )
  if (!res.ok) return { ok: false, error: res.error }
  const obj = asObject(res.rows[0]?.r)
  const rb = obj.rebuild ? asObject(obj.rebuild) : null
  return {
    ok: true,
    data: {
      deleted: num(obj.deleted),
      rebuild: rb
        ? {
            profile: String(rb.profile ?? profileName),
            active: bool(rb.active),
            entries: num(rb.entries),
            rejected: num(rb.rejected),
            points: num(rb.points),
          }
        : null,
    },
  }
}

// ── Candidate selection helpers ─────────────────────────────────────

/** All non-native engines, used for the candidate multi-select default. */
export const NON_NATIVE_ENGINE_IDS: EngineId[] = ENGINES.filter(
  (e) => e.id !== "rvbbit_native",
).map((e) => e.id)

/**
 * Build the `candidates` argument for `route_train_query` from a selected
 * subset. Native is always implicit — the function adds it back for the
 * correctness baseline — but it's clearer to include it explicitly when the
 * user toggled it on. "all" is shorthand for every documented candidate.
 */
export function candidatesArg(selected: EngineId[]): string {
  const set = new Set(selected)
  // If every documented candidate is selected, use "all".
  if (ENGINES.every((e) => set.has(e.id))) return "all"
  // Otherwise, join the (possibly partial) explicit list.
  // Native is always added back by the SQL function; sending it makes the
  // user's intent visible in the run's settings JSON.
  return Array.from(set).join(",")
}

export function parseCandidatesArg(arg: string): EngineId[] {
  const a = arg.trim().toLowerCase()
  if (!a || a === "all") return ENGINES.map((e) => e.id)
  return a
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => normalizeCandidate(tok) as EngineId)
    .filter((id): id is EngineId => ENGINES.some((e) => e.id === id))
}
