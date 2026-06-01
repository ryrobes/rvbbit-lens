"use client"

import type { InstallKnobs, Manifest } from "./capabilities"

/**
 * Client-side model for the Warren remote-deploy layer.
 *
 * Warren is rvbbit's optional deployment scheduler. Postgres is the
 * control plane; agents (`warren-agent`) run on remote hosts with
 * Docker, poll `rvbbit.warren_jobs` for matching work, deploy the
 * capability sidecar, and register the resulting backend + operator.
 *
 * Spec: /home/ryanr/repos2026/rvbbit/docs/WARREN.md
 * UI contract: /home/ryanr/repos2026/rvbbit/docs/WARREN_UI_CONTRACT.md
 *
 * What this module owns:
 * - Detect whether the connected database carries the warren_* catalog
 *   tables (fetchWarrenAvailability — two-step probe so missing tables
 *   don't raise a SQL error).
 * - Read inventory / nodes / jobs / deployments / metrics / observed
 *   labels for dashboard and placement UI.
 * - Mirror Postgres `@>` containment on label objects so the deploy
 *   panel can show match preview without round-tripping.
 * - Enqueue a deploy via `rvbbit.deploy_capability(manifest, selector)`.
 *
 * Everything else (lifecycle, agent behavior, scheduling rules) lives
 * server-side. The UI is a read-mostly observer plus one queue action.
 */

// ── Shapes ──────────────────────────────────────────────────────────

export type WarrenNodeStatus =
  | "registered"
  | "ready"
  | "busy"
  | "draining"
  | "offline"
  | "error"

export type WarrenJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type WarrenDeploymentStatus =
  | "starting"
  | "running"
  | "stopped"
  | "failed"
  | "removed"

export type WarrenJobKind =
  | "capability"
  | "trained_model"
  | "mcp_server"
  | "compose"
  | "custom"

export interface WarrenAvailability {
  /** `to_regclass('rvbbit.warren_nodes') IS NOT NULL` — warren tables exist. */
  available: boolean
  /** Total registered nodes (any status). */
  totalNodes: number
  /**
   * Nodes that could plausibly claim work *right now*: status IN
   * ('ready','busy') AND fresh heartbeat (<2m). Drives the default
   * install-mode for Capability Detail.
   */
  readyNodes: number
  /** Last-error from the count query (rare; usually means a permission issue). */
  error?: string
}

export interface WarrenNode {
  node_id: string
  name: string
  base_url: string | null
  labels: Record<string, unknown>
  capacity: Record<string, unknown>
  inventory: unknown
  status: WarrenNodeStatus
  version: string | null
  last_heartbeat: number | null
  created_at: number | null
  updated_at: number | null
}

export interface WarrenJob {
  job_id: string
  kind: string
  desired_state: string
  name: string | null
  target_selector: Record<string, unknown>
  status: WarrenJobStatus
  claimed_by: string | null
  claimed_at: number | null
  attempts: number
  endpoint_url: string | null
  backend_name: string | null
  operator_name: string | null
  runtime_name: string | null
  error: string | null
  logs: unknown
  created_at: number | null
  started_at: number | null
  finished_at: number | null
  manifest: unknown
}

export interface WarrenDeployment {
  deployment_id: string
  job_id: string | null
  node_id: string | null
  node_name: string | null
  kind: string
  name: string
  status: WarrenDeploymentStatus
  endpoint_url: string | null
  backend_name: string | null
  operator_name: string | null
  runtime_name: string | null
  manifest: unknown
  compose_project: string | null
  work_dir: string | null
  health: unknown
  error: string | null
  created_at: number | null
  updated_at: number | null
  stopped_at: number | null
}

/**
 * One row from `rvbbit.warren_inventory` — already joined to latest
 * metrics + active deployment. `deployment_*` fields are nullable for
 * nodes with no active deployment.
 */
export interface WarrenInventoryRow {
  node_id: string
  node_name: string
  base_url: string | null
  labels: Record<string, unknown>
  capacity: Record<string, unknown>
  node_status: WarrenNodeStatus
  version: string | null
  last_heartbeat: number | null
  latest_metrics_at: number | null
  cpu_pct: number | null
  load1: number | null
  mem_used_bytes: number | null
  mem_total_bytes: number | null
  gpu_count: number | null
  gpu_util_pct: number | null
  gpu_mem_used_bytes: number | null
  gpu_mem_total_bytes: number | null
  gpu_names: string[]
  vram_usable_ratio: number | null
  gpu_mem_usable_bytes: number | null
  single_gpu_mem_usable_bytes: number | null
  gpu_provisioned_bytes: number | null
  gpu_available_bytes: number | null
  deployment_id: string | null
  kind: string | null
  deployment_name: string | null
  deployment_status: WarrenDeploymentStatus | null
  endpoint_url: string | null
  backend_name: string | null
  operator_name: string | null
  runtime_name: string | null
  health: unknown
  error: string | null
  deployment_updated_at: number | null
}

export interface WarrenLabelObservation {
  key: string
  values: unknown[]
}

// ── Heartbeat staleness — UI policy from the contract doc ──────────

export type NodeHeartbeatState = "unknown" | "fresh" | "stale" | "offline"

export function nodeHeartbeatState(lastHeartbeatMs: number | null): NodeHeartbeatState {
  if (lastHeartbeatMs == null) return "unknown"
  const ageMs = Date.now() - lastHeartbeatMs
  if (ageMs < 30_000) return "fresh"
  if (ageMs < 120_000) return "stale"
  return "offline"
}

/**
 * A node is *eligible* to claim work when its status admits it AND
 * the heartbeat hasn't gone stale. The job queue itself does not
 * enforce heartbeat freshness — the doc treats this as UI policy, so
 * the deploy panel uses this to show truthful match counts even when
 * the underlying status row hasn't been re-marked offline.
 */
export function nodeIsEligible(node: { status: WarrenNodeStatus; last_heartbeat: number | null }): boolean {
  if (node.status !== "ready" && node.status !== "busy") return false
  const hb = nodeHeartbeatState(node.last_heartbeat)
  return hb === "fresh" || hb === "stale"
}

// ── Label-subset match (mirrors Postgres @>) ────────────────────────

/**
 * Mirrors `warren_nodes.labels @> warren_jobs.target_selector` for the
 * shallow-key/primitive-value label model. Lets the deploy panel
 * compute match counts in render without a round-trip.
 *
 * Postgres `@>` for jsonb supports nested containment; we don't, since
 * the warren v0 label shape is `{key: scalar}`. If nested labels show
 * up later, switch this to a recursive containment check.
 */
export function nodeMatchesSelector(
  labels: Record<string, unknown>,
  selector: Record<string, unknown>,
): boolean {
  for (const [k, v] of Object.entries(selector)) {
    if (!(k in labels)) return false
    if (!shallowEqualJsonValue(labels[k], v)) return false
  }
  return true
}

function shallowEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

// ── Manifest + knob helpers (used by deploy) ────────────────────────

/**
 * Apply the user's install knobs onto a manifest copy. Lifted out so
 * the WarrenDeployPanel can submit a manifest reflecting the user's
 * Overview-tab edits without leaking through `capabilities.ts`'s
 * private rendering helpers.
 */
export function manifestWithKnobs(manifest: Manifest, knobs: InstallKnobs): Manifest {
  const copy: Manifest = JSON.parse(JSON.stringify(manifest)) as Manifest
  if (copy.backend) {
    copy.backend.batch_size = knobs.batchSize
    copy.backend.max_concurrent = knobs.maxConcurrent
    copy.backend.timeout_ms = knobs.timeoutMs
  }
  copy.runtime = { ...(copy.runtime ?? {}), device: knobs.device }
  return copy
}

// ── /api/db/query helper (same shape as sibling modules) ────────────

interface QueryOk {
  ok: true
  columns: { name: string }[]
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

function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Availability probe ──────────────────────────────────────────────

/**
 * Two-step detection: first verify the catalog tables exist (cheap,
 * one regclass lookup), then count nodes. Avoids raising a SQL error
 * on databases that have rvbbit but not the warren extension version.
 */
export async function fetchWarrenAvailability(
  connectionId: string,
): Promise<WarrenAvailability> {
  const probe = await runQuery(
    connectionId,
    "SELECT to_regclass('rvbbit.warren_nodes') IS NOT NULL AS has_tables",
  )
  if (!probe.ok) return { available: false, totalNodes: 0, readyNodes: 0, error: probe.error }
  const has = probe.rows[0]?.has_tables
  const exists = has === true || has === "t"
  if (!exists) return { available: false, totalNodes: 0, readyNodes: 0 }

  const counts = await runQuery(
    connectionId,
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (
         WHERE status IN ('ready','busy')
           AND last_heartbeat IS NOT NULL
           AND now() - last_heartbeat < interval '2 minutes'
       )::int AS ready
     FROM rvbbit.warren_nodes`,
  )
  if (!counts.ok) return { available: true, totalNodes: 0, readyNodes: 0, error: counts.error }
  const r = counts.rows[0] ?? {}
  return {
    available: true,
    totalNodes: num(r.total),
    readyNodes: num(r.ready),
  }
}

// ── Inventory / nodes ───────────────────────────────────────────────

function parseInventoryRow(r: Record<string, unknown>): WarrenInventoryRow {
  return {
    node_id: String(r.node_id ?? ""),
    node_name: String(r.node_name ?? ""),
    base_url: r.base_url == null ? null : String(r.base_url),
    labels: jsonObj(r.labels),
    capacity: jsonObj(r.capacity),
    node_status: String(r.node_status ?? "registered") as WarrenNodeStatus,
    version: r.version == null ? null : String(r.version),
    last_heartbeat: epoch(r.last_heartbeat),
    latest_metrics_at: epoch(r.latest_metrics_at),
    cpu_pct: r.cpu_pct == null ? null : Number(r.cpu_pct),
    load1: r.load1 == null ? null : Number(r.load1),
    mem_used_bytes: r.mem_used_bytes == null ? null : Number(r.mem_used_bytes),
    mem_total_bytes: r.mem_total_bytes == null ? null : Number(r.mem_total_bytes),
    gpu_count: r.gpu_count == null ? null : Number(r.gpu_count),
    gpu_util_pct: r.gpu_util_pct == null ? null : Number(r.gpu_util_pct),
    gpu_mem_used_bytes: r.gpu_mem_used_bytes == null ? null : Number(r.gpu_mem_used_bytes),
    gpu_mem_total_bytes:
      r.gpu_mem_total_bytes == null ? null : Number(r.gpu_mem_total_bytes),
    gpu_names: strArr(r.gpu_names),
    vram_usable_ratio: numOrNull(r.vram_usable_ratio),
    gpu_mem_usable_bytes: numOrNull(r.gpu_mem_usable_bytes),
    single_gpu_mem_usable_bytes: numOrNull(r.single_gpu_mem_usable_bytes),
    gpu_provisioned_bytes: numOrNull(r.gpu_provisioned_bytes),
    gpu_available_bytes: numOrNull(r.gpu_available_bytes),
    deployment_id: r.deployment_id == null ? null : String(r.deployment_id),
    kind: r.kind == null ? null : String(r.kind),
    deployment_name: r.deployment_name == null ? null : String(r.deployment_name),
    deployment_status:
      r.deployment_status == null
        ? null
        : (String(r.deployment_status) as WarrenDeploymentStatus),
    endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    backend_name: r.backend_name == null ? null : String(r.backend_name),
    operator_name: r.operator_name == null ? null : String(r.operator_name),
    runtime_name: r.runtime_name == null ? null : String(r.runtime_name),
    health: r.health ?? null,
    error: r.error == null ? null : String(r.error),
    deployment_updated_at: epoch(r.deployment_updated_at),
  }
}

export async function fetchWarrenInventory(
  connectionId: string,
): Promise<{ rows: WarrenInventoryRow[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT * FROM rvbbit.warren_inventory ORDER BY node_name, deployment_name NULLS FIRST",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return { rows: res.rows.map(parseInventoryRow) }
}

function parseNode(r: Record<string, unknown>): WarrenNode {
  return {
    node_id: String(r.node_id ?? ""),
    name: String(r.name ?? ""),
    base_url: r.base_url == null ? null : String(r.base_url),
    labels: jsonObj(r.labels),
    capacity: jsonObj(r.capacity),
    inventory: r.inventory ?? null,
    status: String(r.status ?? "registered") as WarrenNodeStatus,
    version: r.version == null ? null : String(r.version),
    last_heartbeat: epoch(r.last_heartbeat),
    created_at: epoch(r.created_at),
    updated_at: epoch(r.updated_at),
  }
}

export async function fetchWarrenNodes(
  connectionId: string,
): Promise<{ nodes: WarrenNode[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT node_id, name, base_url, labels, capacity, inventory,
            status, version, last_heartbeat, created_at, updated_at
     FROM rvbbit.warren_nodes
     ORDER BY name`,
  )
  if (!res.ok) return { nodes: [], error: res.error }
  return { nodes: res.rows.map(parseNode) }
}

// ── Jobs ────────────────────────────────────────────────────────────

const JOB_COLS = `job_id, kind, desired_state, name, target_selector,
       status, claimed_by, claimed_at, attempts,
       endpoint_url, backend_name, operator_name, runtime_name,
       error, logs, created_at, started_at, finished_at, manifest`

function parseJob(r: Record<string, unknown>): WarrenJob {
  return {
    job_id: String(r.job_id ?? ""),
    kind: String(r.kind ?? ""),
    desired_state: String(r.desired_state ?? "running"),
    name: r.name == null ? null : String(r.name),
    target_selector: jsonObj(r.target_selector),
    status: String(r.status ?? "queued") as WarrenJobStatus,
    claimed_by: r.claimed_by == null ? null : String(r.claimed_by),
    claimed_at: epoch(r.claimed_at),
    attempts: num(r.attempts),
    endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    backend_name: r.backend_name == null ? null : String(r.backend_name),
    operator_name: r.operator_name == null ? null : String(r.operator_name),
    runtime_name: r.runtime_name == null ? null : String(r.runtime_name),
    error: r.error == null ? null : String(r.error),
    logs: r.logs ?? null,
    created_at: epoch(r.created_at),
    started_at: epoch(r.started_at),
    finished_at: epoch(r.finished_at),
    manifest: r.manifest ?? null,
  }
}

export async function fetchWarrenJobs(
  connectionId: string,
  opts: { limit?: number; status?: WarrenJobStatus[] } = {},
): Promise<{ jobs: WarrenJob[]; error?: string }> {
  const limit = opts.limit ?? 200
  const where =
    opts.status && opts.status.length > 0
      ? `WHERE status IN (${opts.status.map(sqlLit).join(",")})`
      : ""
  const res = await runQuery(
    connectionId,
    `SELECT ${JOB_COLS}
     FROM rvbbit.warren_jobs
     ${where}
     ORDER BY created_at DESC
     LIMIT ${Number(limit)}`,
  )
  if (!res.ok) return { jobs: [], error: res.error }
  return { jobs: res.rows.map(parseJob) }
}

export async function fetchWarrenJob(
  connectionId: string,
  jobId: string,
): Promise<{ job: WarrenJob | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${JOB_COLS} FROM rvbbit.warren_jobs WHERE job_id = ${sqlLit(jobId)}::uuid LIMIT 1`,
  )
  if (!res.ok) return { job: null, error: res.error }
  if (res.rows.length === 0) return { job: null }
  return { job: parseJob(res.rows[0]) }
}

// ── Deployments ─────────────────────────────────────────────────────

const DEPLOYMENT_COLS = `deployment_id, job_id, node_id, node_name, kind, name, status,
       endpoint_url, backend_name, operator_name, runtime_name, manifest,
       compose_project, work_dir, health, error,
       created_at, updated_at, stopped_at`

function parseDeployment(r: Record<string, unknown>): WarrenDeployment {
  return {
    deployment_id: String(r.deployment_id ?? ""),
    job_id: r.job_id == null ? null : String(r.job_id),
    node_id: r.node_id == null ? null : String(r.node_id),
    node_name: r.node_name == null ? null : String(r.node_name),
    kind: String(r.kind ?? ""),
    name: String(r.name ?? ""),
    status: String(r.status ?? "starting") as WarrenDeploymentStatus,
    endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    backend_name: r.backend_name == null ? null : String(r.backend_name),
    operator_name: r.operator_name == null ? null : String(r.operator_name),
    runtime_name: r.runtime_name == null ? null : String(r.runtime_name),
    manifest: r.manifest ?? null,
    compose_project: r.compose_project == null ? null : String(r.compose_project),
    work_dir: r.work_dir == null ? null : String(r.work_dir),
    health: r.health ?? null,
    error: r.error == null ? null : String(r.error),
    created_at: epoch(r.created_at),
    updated_at: epoch(r.updated_at),
    stopped_at: epoch(r.stopped_at),
  }
}

export async function fetchWarrenDeployments(
  connectionId: string,
  opts: { limit?: number } = {},
): Promise<{ deployments: WarrenDeployment[]; error?: string }> {
  const limit = opts.limit ?? 200
  const res = await runQuery(
    connectionId,
    `SELECT ${DEPLOYMENT_COLS}
     FROM rvbbit.warren_deployments
     ORDER BY updated_at DESC
     LIMIT ${Number(limit)}`,
  )
  if (!res.ok) return { deployments: [], error: res.error }
  return { deployments: res.rows.map(parseDeployment) }
}

/**
 * Find the most-recent deployment whose registered backend matches the
 * given name. Used to surface a "from warren · gpu-1" chip on the
 * Specialist Detail header.
 */
export async function fetchWarrenDeploymentByBackend(
  connectionId: string,
  backendName: string,
): Promise<{ deployment: WarrenDeployment | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT ${DEPLOYMENT_COLS}
     FROM rvbbit.warren_deployments
     WHERE backend_name = ${sqlLit(backendName)}
     ORDER BY updated_at DESC
     LIMIT 1`,
  )
  if (!res.ok) return { deployment: null, error: res.error }
  if (res.rows.length === 0) return { deployment: null }
  return { deployment: parseDeployment(res.rows[0]) }
}

// ── Observed labels (for selector builder) ──────────────────────────

export async function fetchWarrenLabelObservations(
  connectionId: string,
): Promise<{ observations: WarrenLabelObservation[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT key, jsonb_agg(DISTINCT value) AS values
     FROM rvbbit.warren_nodes n
     CROSS JOIN LATERAL jsonb_each(n.labels)
     GROUP BY key
     ORDER BY key`,
  )
  if (!res.ok) return { observations: [], error: res.error }
  return {
    observations: res.rows.map((r) => ({
      key: String(r.key ?? ""),
      values: Array.isArray(r.values) ? (r.values as unknown[]) : [],
    })),
  }
}

// ── Deploy action ───────────────────────────────────────────────────

/**
 * Enqueue a capability deployment job. Returns the job_id when the SQL
 * function succeeds — the UI then opens a job detail window to track
 * status.
 *
 * The manifest is passed through as jsonb; knob overrides should be
 * applied before calling (see `manifestWithKnobs`).
 */
export async function deployCapability(
  connectionId: string,
  manifest: Manifest,
  targetSelector: Record<string, unknown>,
  jobName?: string | null,
): Promise<{ jobId: string | null; error?: string }> {
  const manifestSql = sqlLit(JSON.stringify(manifest)) + "::jsonb"
  const selectorSql = sqlLit(JSON.stringify(targetSelector)) + "::jsonb"
  const jobNameSql = jobName == null || jobName === "" ? "NULL" : sqlLit(jobName)
  const sql = `SELECT rvbbit.deploy_capability(
      capability_manifest => ${manifestSql},
      target_selector => ${selectorSql},
      job_name => ${jobNameSql}
    ) AS job_id`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { jobId: null, error: res.error }
  const id = res.rows[0]?.job_id
  if (id == null) return { jobId: null, error: "deploy_capability returned no job id" }
  return { jobId: String(id) }
}

/**
 * Preferred deploy path (0.60.4+): queue by catalog id. The server reads
 * the manifest from `rvbbit.capability_catalog` and stamps the queued job
 * with the known backend_name / runtime_name / first operator_name, so the
 * UI shows intent before Warren claims it. Returns the queued job_id.
 */
export async function deployCatalogCapability(
  connectionId: string,
  catalogId: string,
  targetSelector: Record<string, unknown>,
  jobName?: string | null,
): Promise<{ jobId: string | null; error?: string }> {
  const selectorSql = sqlLit(JSON.stringify(targetSelector)) + "::jsonb"
  const jobNameSql = jobName == null || jobName === "" ? "NULL" : sqlLit(jobName)
  const sql = `SELECT rvbbit.deploy_catalog_capability(
      catalog_id => ${sqlLit(catalogId)},
      target_selector => ${selectorSql},
      job_name => ${jobNameSql}
    ) AS job_id`
  const res = await runQuery(connectionId, sql)
  if (!res.ok) return { jobId: null, error: res.error }
  const id = res.rows[0]?.job_id
  if (id == null) return { jobId: null, error: "deploy_catalog_capability returned no job id" }
  return { jobId: String(id) }
}

// ── Convenience: enumerate inventory nodes (one row per node) ───────

/**
 * Collapse the inventory view down to one row per node. Useful for the
 * deploy panel's "matching nodes" preview where we want node metadata
 * but not the deployment-expansion that warren_inventory ships with.
 */
export function uniqueNodesFromInventory(
  rows: WarrenInventoryRow[],
): WarrenInventoryRow[] {
  const seen = new Set<string>()
  const out: WarrenInventoryRow[] = []
  for (const r of rows) {
    if (seen.has(r.node_id)) continue
    seen.add(r.node_id)
    out.push(r)
  }
  return out
}

export type WarrenGpuFit = "not_required" | "fits" | "insufficient" | "no_gpu" | "unknown"

export function nodeAvailableVramBytes(node: WarrenInventoryRow): number | null {
  if (node.gpu_available_bytes != null) return node.gpu_available_bytes
  if (node.gpu_mem_total_bytes != null && node.gpu_mem_total_bytes > 0) {
    return Math.floor(node.gpu_mem_total_bytes * 0.9)
  }
  return null
}

export function nodeFitsVram(
  node: WarrenInventoryRow,
  vramRequiredBytes: number | null | undefined,
  placement = "single_gpu",
): WarrenGpuFit {
  if (vramRequiredBytes == null || vramRequiredBytes <= 0) return "not_required"
  if ((node.gpu_count ?? 0) <= 0) return "no_gpu"
  const available = nodeAvailableVramBytes(node)
  if (available == null) return "unknown"
  if (available < vramRequiredBytes) return "insufficient"
  if (placement === "single_gpu") {
    const singleGpuUsable =
      node.single_gpu_mem_usable_bytes ??
      (node.gpu_mem_total_bytes != null && (node.gpu_count ?? 0) > 0
        ? Math.floor((node.gpu_mem_total_bytes / Math.max(1, node.gpu_count ?? 1)) * 0.9)
        : null)
    if (singleGpuUsable == null) return "unknown"
    if (singleGpuUsable < vramRequiredBytes) return "insufficient"
  }
  return "fits"
}
