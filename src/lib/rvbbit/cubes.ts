"use client"

// Data layer for the Cube Studio apps (Catalog, Creator, Inspector). All queries run through
// /api/db/query against the active (rvbbit) connection. Mirrors lib/rvbbit/metrics.ts.
//
// A cube is a wide, reasoned-about, documented join materialized as an accelerated rvbbit table
// (cubes.<name>) — the curated middle of a metrics → cubes → raw discovery gradient. Backend
// surface: cubes() / describe_cube / define_cube / refresh_cube / cube_refresh_policy /
// enrich_cube / set_cube_column_doc / cube_health / propose_cube / promote_cube_to_metric /
// cube_packs_latest / fuzzy_suggest_bindings / apply_cube_pack / define_cube_from_pack /
// drop_cube. See docs/CUBES_PLAN.md.

export type CubeRefreshMode = "auto" | "conservative" | "bulk" | "manual"
export type CubeMetadataProfile = "minimal" | "rich"
export type CubeRefreshVariants = "deferred" | "sync"

export interface CubeSummary {
  name: string
  grain: string | null
  description: string | null
  category: string | null
  version: number
  refreshedAt: string | null // timestamptz text
  rows: number | null
}

export interface CubeColumn {
  name: string
  type: string | null
  doc: string | null
  semantics: string | null
  sourceRef: string | null
  confidence: number | null
  /** NULL = LLM-drafted; 'pack' = curated pack doc; else a human editor. */
  editedBy: string | null
}

export interface CubeRefreshPolicy {
  mode: CubeRefreshMode | string
  queryThreads: number | null
  writerThreads: number | null
  scanChunkRows: number | null
  metadataProfile: CubeMetadataProfile | string | null
  refreshVariants: CubeRefreshVariants | string | null
  refreshIntervalSeconds: number | null
}

export interface CubeAutopilotStatus extends CubeRefreshPolicy {
  recommendedAction: string | null
  rowGroups: number | null
  variantFiles: number | null
  variantsPending: boolean
  dirty: boolean
  cubeDirty: boolean
  sourceAccelDirty: boolean
  sourceDirty: boolean
  sourceCount: number | null
  trackedSourceCount: number | null
  dirtySourceCount: number | null
  sourceSecondsDirty: number | null
  sourceLastWriteAt: string | null
  lastRefreshSeconds: number | null
  secondsSinceRefresh: number | null
}

export interface MaintenanceStatus {
  targetKind: string
  targetName: string
  lifecycleState: string
  maintenanceAction: string
  needsMaintenance: boolean
  reason: string | null
  rowGroups: number | null
  variantFiles: number | null
  variantsPending: boolean
  secondsLag: number | null
  lastMaintainedAt: string | null
  policy: Record<string, unknown>
}

export interface MaintenanceRun {
  targetKind: string
  targetName: string
  lifecycleState: string
  maintenanceAction: string
  executed: boolean
  status: string
  rowsWritten: number | null
  details: Record<string, unknown>
  error: string | null
}

export interface CubeHealth {
  status: string // fresh | dirty | stale | error | missing | unknown
  secondsSinceRefresh: number | null
  rowDelta: number | null
  driftRatio: number | null
  driftRecommendation: string | null
  lastRefreshRows: number | null
  currentRows: number | null
  lastError: string | null
  refreshPolicy: CubeRefreshPolicy | null
  autopilot: CubeAutopilotStatus | null
  maintenance: MaintenanceStatus | null
  raw: Record<string, unknown>
}

export interface CubeDetail {
  name: string
  grain: string | null
  description: string | null
  humanDescription: string | null
  autoDescription: string | null
  category: string | null
  version: number | null
  sql: string
  refreshCron: string | null
  refreshedAt: string | null
  rows: number | null
  enrichedAt: string | null
  sourceTables: string[]
  columns: CubeColumn[]
  sample: Array<Record<string, unknown>>
  health: CubeHealth | null
}

export interface CubePack {
  packKey: string
  provider: string
  canonicalObject: string
  cubeNameSuggest: string | null
  description: string | null
  grain: string | null
  version: number
}

/** One canonical field a pack needs bound to a real column. */
export interface PackField {
  name: string
  canonicalNames: string[]
  types: string[]
}

/** A single binding suggestion (fuzzy_suggest_bindings output, per field). */
export interface BindingSuggestion {
  field: string
  bestTable: string | null
  bestColumn: string | null
  confidence: number
  candidates: Array<{ table: string; column: string; score: number }>
}

/** A propose_cube draft (never persisted; the human blesses it). */
export interface ProposeResult {
  name: string
  sql: string
  grain: string | null
  description: string | null
  sourceTables: string[]
  joinRationale: string | null
  confidence: number | null
  candidateTables: string[]
  fkEdges: Array<Record<string, unknown>>
  error: string | null
}

interface Ok {
  ok: true
  rows: Array<Record<string, unknown>>
  columns?: Array<{ name: string }>
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
/** A jsonb literal from a JS object/value. */
function jb(value: unknown): string {
  return `${q(JSON.stringify(value ?? {}))}::jsonb`
}
/** A text[] literal (or NULL) from a JS string array. */
function arr(values: string[] | null | undefined): string {
  if (!values || values.length === 0) return "NULL::text[]"
  return `ARRAY[${values.map((v) => q(v)).join(",")}]::text[]`
}
function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}
function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") return ["true", "t", "1", "yes", "on"].includes(v.toLowerCase())
  return false
}
function asObject(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return typeof v === "object" ? (v as Record<string, unknown>) : {}
}
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p : []
    } catch {
      return []
    }
  }
  return []
}

function asPolicy(v: unknown): CubeRefreshPolicy | null {
  const p = asObject(v)
  if (Object.keys(p).length === 0) return null
  return {
    mode: String(p.mode ?? p.refresh_mode ?? "auto"),
    queryThreads: num(p.query_threads),
    writerThreads: num(p.writer_threads),
    scanChunkRows: num(p.scan_chunk_rows),
    metadataProfile: str(p.metadata_profile),
    refreshVariants: str(p.refresh_variants),
    refreshIntervalSeconds: num(p.refresh_interval_seconds),
  }
}

function asAutopilot(v: unknown): CubeAutopilotStatus | null {
  const p = asObject(v)
  if (Object.keys(p).length === 0) return null
  return {
    mode: String(p.refresh_mode ?? p.mode ?? "auto"),
    queryThreads: num(p.query_threads),
    writerThreads: num(p.writer_threads),
    scanChunkRows: num(p.scan_chunk_rows),
    metadataProfile: str(p.metadata_profile),
    refreshVariants: str(p.refresh_variants),
    refreshIntervalSeconds: num(p.refresh_interval_seconds),
    recommendedAction: str(p.recommended_action),
    rowGroups: num(p.row_groups),
    variantFiles: num(p.variant_files),
    variantsPending: bool(p.variants_pending),
    dirty: bool(p.dirty),
    cubeDirty: bool(p.cube_dirty),
    sourceAccelDirty: bool(p.source_accel_dirty),
    sourceDirty: bool(p.source_dirty),
    sourceCount: num(p.source_count),
    trackedSourceCount: num(p.tracked_source_count),
    dirtySourceCount: num(p.dirty_source_count),
    sourceSecondsDirty: num(p.source_seconds_dirty),
    sourceLastWriteAt: str(p.source_last_write_at),
    lastRefreshSeconds: num(p.last_refresh_seconds),
    secondsSinceRefresh: num(p.seconds_since_refresh),
  }
}

function asMaintenance(v: unknown): MaintenanceStatus | null {
  const m = asObject(v)
  if (Object.keys(m).length === 0) return null
  return {
    targetKind: String(m.target_kind ?? ""),
    targetName: String(m.target_name ?? ""),
    lifecycleState: String(m.lifecycle_state ?? "unknown"),
    maintenanceAction: String(m.maintenance_action ?? "none"),
    needsMaintenance: bool(m.needs_maintenance),
    reason: str(m.reason),
    rowGroups: num(m.row_groups),
    variantFiles: num(m.variant_files),
    variantsPending: bool(m.variants_pending),
    secondsLag: num(m.seconds_lag),
    lastMaintainedAt: str(m.last_maintained_at),
    policy: asObject(m.policy),
  }
}

function asMaintenanceRun(v: Record<string, unknown>): MaintenanceRun {
  return {
    targetKind: String(v.target_kind ?? ""),
    targetName: String(v.target_name ?? ""),
    lifecycleState: String(v.lifecycle_state ?? "unknown"),
    maintenanceAction: String(v.maintenance_action ?? "none"),
    executed: bool(v.executed),
    status: String(v.status ?? "unknown"),
    rowsWritten: num(v.rows_written),
    details: asObject(v.details),
    error: str(v.error),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────

export async function listCubes(
  connectionId: string,
): Promise<{ cubes: CubeSummary[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT name, grain, description, category, version, refreshed_at::text AS refreshed_at, rows
     FROM rvbbit.cubes() ORDER BY name`,
  )
  if (!r.ok) return { cubes: [], error: r.error }
  return {
    error: null,
    cubes: r.rows.map((row) => ({
      name: String(row.name),
      grain: str(row.grain),
      description: str(row.description),
      category: str(row.category),
      version: Number(row.version ?? 1),
      refreshedAt: str(row.refreshed_at),
      rows: num(row.rows),
    })),
  }
}

function asHealth(v: unknown): CubeHealth | null {
  const h = asObject(v)
  if (Object.keys(h).length === 0) return null
  const fr = asObject(h.freshness)
  const dr = asObject(h.drift)
  const autopilot = asAutopilot(h.autopilot)
  const maintenance = asMaintenance(h.maintenance)
  return {
    status: String(fr.status ?? h.status ?? "unknown"),
    secondsSinceRefresh: num(fr.seconds_since_refresh) ?? autopilot?.secondsSinceRefresh ?? null,
    rowDelta: num(fr.row_delta),
    driftRatio: num(dr.drift_ratio),
    driftRecommendation: str(dr.recommendation),
    lastRefreshRows: num(fr.last_refresh_rows),
    currentRows: num(fr.current_parquet_rows),
    lastError: str(h.last_error),
    refreshPolicy: asPolicy(h.refresh_policy),
    autopilot,
    maintenance,
    raw: h,
  }
}

function asColumns(v: unknown): CubeColumn[] {
  return asArray(v).map((c) => {
    const o = asObject(c)
    return {
      name: String(o.name ?? ""),
      type: str(o.type),
      doc: str(o.doc),
      semantics: str(o.semantics),
      sourceRef: str(o.source_ref),
      confidence: num(o.confidence),
      editedBy: str(o.edited_by),
    }
  })
}

export async function describeCube(
  connectionId: string,
  name: string,
): Promise<{ cube: CubeDetail | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.describe_cube(${q(name)}) AS d`)
  if (!r.ok) return { cube: null, error: r.error }
  const d = asObject(r.rows[0]?.d)
  if (Object.keys(d).length === 0) return { cube: null, error: null }
  return {
    error: null,
    cube: {
      name: String(d.name ?? name),
      grain: str(d.grain),
      description: str(d.description),
      humanDescription: str(d.human_description),
      autoDescription: str(d.auto_description),
      category: str(d.category),
      version: num(d.version),
      sql: String(d.sql ?? ""),
      refreshCron: str(d.refresh_cron),
      refreshedAt: str(d.refreshed_at),
      rows: num(d.rows),
      enrichedAt: str(d.enriched_at),
      sourceTables: asArray(d.source_tables).map((t) => String(t)),
      columns: asColumns(d.columns),
      sample: asArray(d.sample).map((s) => asObject(s)),
      health: asHealth(d.health),
    },
  }
}

export async function cubeHealth(
  connectionId: string,
  name: string,
): Promise<{ health: CubeHealth | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.cube_health(${q(name)}) AS h`)
  if (!r.ok) return { health: null, error: r.error }
  return { health: asHealth(r.rows[0]?.h), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Versioning — cube_defs is append-versioned; show history + revert
// ─────────────────────────────────────────────────────────────────────────

export interface CubeVersion {
  version: number
  sql: string
  grain: string | null
  description: string | null
  category: string | null
  createdAt: string | null
}

export async function cubeVersions(
  connectionId: string,
  name: string,
): Promise<{ versions: CubeVersion[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT version, sql, grain, description, category, created_at::text AS created_at
     FROM rvbbit.cube_versions(${q(name)})`,
  )
  if (!r.ok) return { versions: [], error: r.error }
  return {
    error: null,
    versions: r.rows.map((row) => ({
      version: Number(row.version),
      sql: String(row.sql ?? ""),
      grain: str(row.grain),
      description: str(row.description),
      category: str(row.category),
      createdAt: str(row.created_at),
    })),
  }
}

/** Roll a cube back to a prior version (appends a new version restoring it). */
export async function revertCube(
  connectionId: string,
  name: string,
  version: number,
): Promise<{ newVersion: number | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.revert_cube(${q(name)}, ${version}) AS v`)
  if (!r.ok) return { newVersion: null, error: r.error }
  return { newVersion: num(r.rows[0]?.v), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Preview (Creator live dry-run — cubes have no params, so a LIMIT-5 of the body)
// ─────────────────────────────────────────────────────────────────────────

export async function previewCubeSql(
  connectionId: string,
  draftSql: string,
  limit = 5,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; error: string | null }> {
  const body = draftSql.trim().replace(/;\s*$/, "")
  if (!body) return { columns: [], rows: [], error: null }
  const r = await run(connectionId, `SELECT * FROM (${body}) AS _preview LIMIT ${Math.max(1, limit)}`, limit)
  if (!r.ok) return { columns: [], rows: [], error: r.error }
  const cols = r.columns?.map((c) => c.name) ?? (r.rows[0] ? Object.keys(r.rows[0]) : [])
  return { columns: cols, rows: r.rows, error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Write — define / refresh / enrich / column docs / promote / delete
// ─────────────────────────────────────────────────────────────────────────

export interface DefineCubeInput {
  name: string
  sql: string
  grain?: string | null
  description?: string | null
  owner?: string | null
  refreshCron?: string | null
  category?: string | null
  labels?: Record<string, unknown>
}

export async function defineCube(
  connectionId: string,
  input: DefineCubeInput,
): Promise<{ version: number | null; error: string | null }> {
  const sql = `SELECT rvbbit.define_cube(
      ${q(input.name)},
      ${q(input.sql)},
      ${input.grain ? q(input.grain) : "NULL"},
      ${input.description ? q(input.description) : "NULL"},
      ${input.owner ? q(input.owner) : "NULL"},
      ${input.refreshCron ? q(input.refreshCron) : "NULL"},
      ${input.category ? q(input.category) : "NULL"},
      ${jb(input.labels ?? {})}
    ) AS version`
  const r = await run(connectionId, sql)
  if (!r.ok) return { version: null, error: r.error }
  return { version: num(r.rows[0]?.version), error: null }
}

export async function refreshCube(
  connectionId: string,
  name: string,
): Promise<{ rows: number | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.refresh_cube(${q(name)}) AS rows`)
  if (!r.ok) return { rows: null, error: r.error }
  return { rows: num(r.rows[0]?.rows), error: null }
}

export async function maintainCube(
  connectionId: string,
  name: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<{ runs: MaintenanceRun[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT *
     FROM rvbbit.maintain_cube(
       ${q(name)},
       p_dry_run => ${opts.dryRun ? "true" : "false"},
       p_force => ${opts.force ? "true" : "false"}
     )`,
    50,
  )
  if (!r.ok) return { runs: [], error: r.error }
  return { runs: r.rows.map(asMaintenanceRun), error: null }
}

export interface CubeRefreshPolicyInput {
  mode: CubeRefreshMode | string
  queryThreads?: number | null
  writerThreads?: number | null
  scanChunkRows?: number | null
  metadataProfile?: CubeMetadataProfile | string | null
  refreshVariants?: CubeRefreshVariants | string | null
  refreshIntervalSeconds?: number | null
  note?: string | null
}

function intArg(v: number | null | undefined): string {
  return v != null && Number.isFinite(v) ? String(Math.floor(v)) : "NULL"
}

export async function setCubeRefreshPolicy(
  connectionId: string,
  name: string,
  input: CubeRefreshPolicyInput,
): Promise<{ policy: CubeRefreshPolicy | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.set_cube_refresh_policy(
        ${q(name)},
        p_mode => ${q(input.mode || "auto")},
        p_query_threads => ${intArg(input.queryThreads)},
        p_writer_threads => ${intArg(input.writerThreads)},
        p_scan_chunk_rows => ${intArg(input.scanChunkRows)},
        p_metadata_profile => ${input.metadataProfile ? q(input.metadataProfile) : "NULL"},
        p_refresh_variants => ${input.refreshVariants ? q(input.refreshVariants) : "NULL"},
        p_note => ${input.note ? q(input.note) : "NULL"},
        p_refresh_interval_seconds => ${intArg(input.refreshIntervalSeconds)}
      ) AS policy`,
  )
  if (!r.ok) return { policy: null, error: r.error }
  return { policy: asPolicy(r.rows[0]?.policy), error: null }
}

export async function enrichCube(
  connectionId: string,
  name: string,
  sampleRows = 12,
  overwriteEdited = false,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.enrich_cube(${q(name)}, ${Math.max(1, sampleRows)}, ${overwriteEdited}) AS r`,
  )
  if (!r.ok) return { result: null, error: r.error }
  return { result: asObject(r.rows[0]?.r), error: null }
}

export async function setCubeColumnDoc(
  connectionId: string,
  cube: string,
  column: string,
  opts: { doc?: string | null; semantics?: string | null; sourceRef?: string | null; editor?: string },
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.set_cube_column_doc(
        ${q(cube)}, ${q(column)},
        ${opts.doc != null ? q(opts.doc) : "NULL"},
        ${opts.semantics != null ? q(opts.semantics) : "NULL"},
        ${opts.sourceRef != null ? q(opts.sourceRef) : "NULL"},
        ${q(opts.editor ?? "human")})`,
  )
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

export async function promoteCubeToMetric(
  connectionId: string,
  cube: string,
  metric: string,
  opts: { description?: string | null; owner?: string | null; grain?: string | null } = {},
): Promise<{ version: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.promote_cube_to_metric(
        ${q(cube)}, ${q(metric)},
        ${opts.description ? q(opts.description) : "NULL"},
        ${opts.owner ? q(opts.owner) : "NULL"},
        ${opts.grain ? q(opts.grain) : "NULL"}) AS version`,
  )
  if (!r.ok) return { version: null, error: r.error }
  return { version: num(r.rows[0]?.version), error: null }
}

export async function deleteCube(
  connectionId: string,
  name: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.drop_cube(${q(name)})`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

// ─────────────────────────────────────────────────────────────────────────
// Propose (agent-drafted → human-blessed)
// ─────────────────────────────────────────────────────────────────────────

export async function proposeCube(
  connectionId: string,
  subject: string,
  seedTables?: string[] | null,
  schema?: string | null,
): Promise<{ draft: ProposeResult | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.propose_cube(${q(subject)}, ${arr(seedTables)}, ${schema ? q(schema) : "NULL"}) AS d`,
  )
  if (!r.ok) return { draft: null, error: r.error }
  const d = asObject(r.rows[0]?.d)
  if (Object.keys(d).length === 0) return { draft: null, error: "no draft" }
  return {
    error: null,
    draft: {
      name: String(d.name ?? ""),
      sql: String(d.sql ?? ""),
      grain: str(d.grain),
      description: str(d.description),
      sourceTables: asArray(d.source_tables).map((t) => String(t)),
      joinRationale: str(d.join_rationale),
      confidence: num(d.confidence),
      candidateTables: asArray(d.candidate_tables).map((t) => String(t)),
      fkEdges: asArray(d.fk_edges).map((e) => asObject(e)),
      error: str(d.error),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cube packs (parameterized templates for known SaaS schemas)
// ─────────────────────────────────────────────────────────────────────────

export async function listCubePacks(
  connectionId: string,
): Promise<{ packs: CubePack[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT pack_key, saas_provider, canonical_object, cube_name_suggest, description, grain, version
     FROM rvbbit.cube_packs_latest ORDER BY pack_key`,
  )
  if (!r.ok) return { packs: [], error: r.error }
  return {
    error: null,
    packs: r.rows.map((row) => ({
      packKey: String(row.pack_key),
      provider: String(row.saas_provider),
      canonicalObject: String(row.canonical_object),
      cubeNameSuggest: str(row.cube_name_suggest),
      description: str(row.description),
      grain: str(row.grain),
      version: Number(row.version ?? 1),
    })),
  }
}

export interface PackDetail {
  fields: PackField[]
  template: string
  /** every {{ placeholder }} the template needs bound, in first-seen order. */
  placeholders: string[]
}

/** The template + the fields/placeholders a pack needs bound (Creator's From-Pack mode). */
export async function fetchPackDetail(
  connectionId: string,
  packKey: string,
): Promise<{ detail: PackDetail | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT canonical_fields, canonical_sql_template
     FROM rvbbit.cube_packs_latest WHERE pack_key = ${q(packKey)}`,
  )
  if (!r.ok) return { detail: null, error: r.error }
  const row = r.rows[0]
  if (!row) return { detail: null, error: null }
  const template = String(row.canonical_sql_template ?? "")
  const placeholders = Array.from(
    new Set([...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1])),
  )
  return {
    error: null,
    detail: {
      template,
      placeholders,
      fields: asArray(row.canonical_fields).map((f) => {
        const o = asObject(f)
        return {
          name: String(o.name ?? ""),
          canonicalNames: asArray(o.canonical_names).map((x) => String(x)),
          types: asArray(o.types).map((x) => String(x)),
        }
      }),
    },
  }
}

export async function suggestBindings(
  connectionId: string,
  packKey: string,
  schema?: string | null,
): Promise<{ suggestions: BindingSuggestion[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.fuzzy_suggest_bindings(${q(packKey)}, ${schema ? q(schema) : "NULL"}) AS s`,
  )
  if (!r.ok) return { suggestions: [], error: r.error }
  const s = asObject(r.rows[0]?.s)
  const out: BindingSuggestion[] = Object.entries(s).map(([field, v]) => {
    const o = asObject(v)
    const best = asObject(o.best_match)
    return {
      field,
      bestTable: str(best.table),
      bestColumn: str(best.column),
      confidence: num(o.confidence) ?? 0,
      candidates: asArray(o.candidates).map((c) => {
        const co = asObject(c)
        return { table: String(co.table ?? ""), column: String(co.column ?? ""), score: num(co.score) ?? 0 }
      }),
    }
  })
  return { suggestions: out, error: null }
}

export async function applyCubePack(
  connectionId: string,
  packKey: string,
  bindings: Record<string, string>,
): Promise<{ status: string; resolvedSql: string | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.apply_cube_pack(${q(packKey)}, ${jb(bindings)}) AS r`)
  if (!r.ok) return { status: "error", resolvedSql: null, error: r.error }
  const o = asObject(r.rows[0]?.r)
  return {
    status: String(o.status ?? "error"),
    resolvedSql: str(o.resolved_sql),
    error: o.status === "ok" ? null : str(o.error),
  }
}

export async function defineCubeFromPack(
  connectionId: string,
  packKey: string,
  bindings: Record<string, string>,
  cubeName: string,
  opts: { grain?: string | null; description?: string | null } = {},
): Promise<{ version: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.define_cube_from_pack(
        ${q(packKey)}, ${jb(bindings)}, ${q(cubeName)},
        ${opts.grain ? q(opts.grain) : "NULL"},
        ${opts.description ? q(opts.description) : "NULL"}) AS version`,
  )
  if (!r.ok) return { version: null, error: r.error }
  return { version: num(r.rows[0]?.version), error: null }
}

// ─────────────────────────────────────────────────────────────────────────
// Proposals (agent-drafted cubes awaiting human review/promotion)
// ─────────────────────────────────────────────────────────────────────────

export interface CubeProposal {
  proposalId: number
  kind: string // 'cube' | 'metric'
  status: string // pending | accepted | rejected | superseded
  name: string | null
  subject: string | null
  sql: string
  grain: string | null
  description: string | null
  sourceTables: string[]
  joinRationale: string | null
  confidence: number | null
  /** metric proposals only: default {param} values + an optional KPI assertion. */
  params: Record<string, unknown>
  checkSql: string | null
  category: string | null
  subcategory: string | null
  proposedBy: string | null
  proposedVia: string | null
  resultName: string | null
  notes: string | null
  createdAt: string | null
  reviewedAt: string | null
}

export async function listProposals(
  connectionId: string,
  status?: string | null,
  kind?: string | null,
): Promise<{ proposals: CubeProposal[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT proposal_id, kind, status, name, subject, sql, grain, description, source_tables,
            join_rationale, confidence, params, check_sql, category, subcategory, proposed_by,
            proposed_via, result_name, notes,
            created_at::text AS created_at, reviewed_at::text AS reviewed_at
     FROM rvbbit.proposals(${status ? q(status) : "NULL"}, ${kind ? q(kind) : "NULL"})`,
  )
  if (!r.ok) return { proposals: [], error: r.error }
  return {
    error: null,
    proposals: r.rows.map((row) => ({
      proposalId: Number(row.proposal_id),
      kind: String(row.kind ?? "cube"),
      status: String(row.status ?? "pending"),
      name: str(row.name),
      subject: str(row.subject),
      sql: String(row.sql ?? ""),
      grain: str(row.grain),
      description: str(row.description),
      sourceTables: asArray(row.source_tables).map((t) => String(t)),
      joinRationale: str(row.join_rationale),
      confidence: num(row.confidence),
      params: asObject(row.params),
      checkSql: str(row.check_sql),
      category: str(row.category),
      subcategory: str(row.subcategory),
      proposedBy: str(row.proposed_by),
      proposedVia: str(row.proposed_via),
      resultName: str(row.result_name),
      notes: str(row.notes),
      createdAt: str(row.created_at),
      reviewedAt: str(row.reviewed_at),
    })),
  }
}

export async function acceptProposal(
  connectionId: string,
  id: number,
  opts: { name?: string | null; sql?: string | null; grain?: string | null; description?: string | null; enrich?: boolean } = {},
): Promise<{ name: string | null; kind: string | null; version: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.accept_proposal(
        ${id},
        ${opts.name ? q(opts.name) : "NULL"},
        ${opts.sql ? q(opts.sql) : "NULL"},
        ${opts.grain ? q(opts.grain) : "NULL"},
        ${opts.description ? q(opts.description) : "NULL"},
        ${opts.enrich ? "true" : "false"}) AS r`,
  )
  if (!r.ok) return { name: null, kind: null, version: null, error: r.error }
  const o = asObject(r.rows[0]?.r)
  return { name: str(o.name), kind: str(o.kind), version: num(o.version), error: null }
}

export async function rejectProposal(
  connectionId: string,
  id: number,
  note?: string | null,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.reject_proposal(${id}, ${note ? q(note) : "NULL"})`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

/** Persist edits to a PENDING proposal in place (without accepting). */
export async function refineProposal(
  connectionId: string,
  id: number,
  edits: {
    name?: string | null
    sql?: string | null
    grain?: string | null
    description?: string | null
    checkSql?: string | null
    confidence?: number | null
    category?: string | null
    subcategory?: string | null
  },
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.refine_proposal(
        ${id},
        ${edits.name ? q(edits.name) : "NULL"},
        ${edits.sql ? q(edits.sql) : "NULL"},
        ${edits.grain ? q(edits.grain) : "NULL"},
        ${edits.description ? q(edits.description) : "NULL"},
        NULL,
        ${edits.checkSql ? q(edits.checkSql) : "NULL"},
        NULL,
        ${edits.confidence != null ? edits.confidence : "NULL"},
        ${edits.category ? q(edits.category) : "NULL"},
        ${edits.subcategory ? q(edits.subcategory) : "NULL"})`,
  )
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

/** Retract a PENDING proposal (status → withdrawn). */
export async function withdrawProposal(
  connectionId: string,
  id: number,
  reason?: string | null,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.withdraw_proposal(${id}, ${reason ? q(reason) : "NULL"})`)
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error }
}

// ─────────────────────────────────────────────────────────────────────────
// Warehouse Recommendations — activity-mined candidates + proposal quality
// ─────────────────────────────────────────────────────────────────────────

/** A recurring table-set employees query that has no cube yet (rvbbit.discovery_candidates). */
export interface DiscoveryCandidate {
  tables: string[]
  queryCount: number
  users: number
  covered: boolean
  alreadyProposed: boolean
}

export async function discoveryCandidates(
  connectionId: string,
  opts: { days?: number; minQueries?: number; limit?: number } = {},
): Promise<{ candidates: DiscoveryCandidate[]; error: string | null }> {
  const days = opts.days ?? 14
  const minQ = opts.minQueries ?? 3
  const limit = opts.limit ?? 20
  const r = await run(
    connectionId,
    `SELECT tables, query_count, users, covered, already_proposed
     FROM rvbbit.discovery_candidates(${days}, ${minQ}, ${limit})`,
  )
  if (!r.ok) return { candidates: [], error: r.error }
  return {
    error: null,
    candidates: r.rows.map((row) => ({
      tables: asArray(row.tables).map((t) => String(t)),
      queryCount: num(row.query_count) ?? 0,
      users: num(row.users) ?? 0,
      covered: row.covered === true || row.covered === "t",
      alreadyProposed: row.already_proposed === true || row.already_proposed === "t",
    })),
  }
}

/** Propose a cube for one mined table-set on demand → returns the new proposal. */
export async function proposeDiscovery(
  connectionId: string,
  tables: string[],
): Promise<{ name: string | null; proposalId: number | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.propose_discovery(${arr(tables)}, 'lens') AS d`)
  if (!r.ok) return { name: null, proposalId: null, error: r.error }
  const d = asObject(r.rows[0]?.d)
  return { name: str(d.name), proposalId: num(d.proposal_id), error: null }
}

export interface ProposalQualityRow {
  kind: string
  proposedBy: string
  total: number
  accepted: number
  rejected: number
  pending: number
  acceptRate: number | null
}

export async function proposalQuality(
  connectionId: string,
): Promise<{ rows: ProposalQualityRow[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT kind, proposed_by, total, accepted, rejected, pending, accept_rate
     FROM rvbbit.proposal_quality ORDER BY total DESC`,
  )
  if (!r.ok) return { rows: [], error: r.error }
  return {
    error: null,
    rows: r.rows.map((row) => ({
      kind: String(row.kind),
      proposedBy: String(row.proposed_by ?? "?"),
      total: num(row.total) ?? 0,
      accepted: num(row.accepted) ?? 0,
      rejected: num(row.rejected) ?? 0,
      pending: num(row.pending) ?? 0,
      acceptRate: num(row.accept_rate),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Discovery helper — list base tables (for the Creator's seed-table picker)
// ─────────────────────────────────────────────────────────────────────────

export async function listBaseTables(
  connectionId: string,
  schema?: string | null,
): Promise<{ tables: string[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT table_schema || '.' || table_name AS t
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog','information_schema','rvbbit','cubes')
       ${schema ? `AND table_schema = ${q(schema)}` : ""}
     ORDER BY table_schema, table_name`,
  )
  if (!r.ok) return { tables: [], error: r.error }
  return { tables: r.rows.map((row) => String(row.t)), error: null }
}
