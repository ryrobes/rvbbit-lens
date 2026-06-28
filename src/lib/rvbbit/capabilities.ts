"use client"

/**
 * Client-side model for the rvbbit *capabilities* layer — the install /
 * provenance front-door over `rvbbit.backends` plus runtime-sidecar registries.
 *
 * A capability pack bundles a model + sidecar + SQL generators. The
 * catalog is a static JSON list of packs, the manifests are YAML files
 * with the full install knobs, and installed packs land in
 * `rvbbit.backends` or a runtime registry with source + install_manifest set.
 *
 * Spec: /home/ryanr/repos2026/rvbbit/docs/CAPABILITIES.md
 *
 * What this module owns:
 * - Fetch catalog + individual manifest via the `/api/rvbbit/capabilities`
 *   route (which reads from disk on the server).
 * - Join the catalog to installed-backend rows from `rvbbit.backend_health`
 *   and derive the 7-state badge from the spec.
 * - Probe a registered backend or runtime service.
 * - Render manifest → generated files in TypeScript so the detail
 *   window's knob editor can drive a live preview without shelling
 *   out per keystroke. The TS port mirrors `rvbbit/capabilities/tools/
 *   rvbbit-capability` `render_*` functions verbatim.
 */

// ── Catalog / manifest shapes ───────────────────────────────────────

export interface CatalogEntry {
  id: string
  name: string
  title: string
  description: string | null
  tags: string[]
  /** public rows are shown by default; example/internal rows stay hidden. */
  catalog_visibility: "public" | "example" | "internal"
  /** `hf_backend` (model pack) or `runtime_sidecar` (execution runtime). */
  kind: string
  /** True for operator-runtime capabilities that unlock workflow primitives. */
  system_runtime: boolean
  /** Role hint such as `operator_runtime`. */
  capability_role: string | null
  source_provider: string | null
  source_model: string | null
  source_revision: string | null
  license: string | null
  /** null for runtime sidecars — they register a runtime, not a backend. */
  backend_name: string | null
  backend_transport: string | null
  runtime_template: string
  runtime_handler: string
  runtime_port: number | null
  health_path: string | null
  /** Set for runtime sidecars: runtime catalog name + language. */
  runtime_name: string | null
  runtime_language: string | null
  /** Warren registration path, e.g. `/predict` (backend) or `/run` (runtime). */
  endpoint_path: string | null
  device: string
  resources: ResourceProfile
  gpu_required: boolean
  gpu_placement: string | null
  model_size_bytes: number | null
  vram_required_bytes: number | null
  vram_headroom_pct: number | null
  operators: string[]
  manifest_path: string
  catalog_source: string
  active: boolean
  created_at: number | null
  updated_at: number | null
  acceptance_tests: string[]
  acceptance: ManifestAcceptanceBlock | null
  /**
   * Inline manifest from `rvbbit.capability_catalog.manifest` when the
   * catalog came from the DB (the primary source). Lets the UI skip the
   * disk YAML read for normal deploy/detail flows. Null for catalog.json
   * fallback rows, which still carry `manifest_path`.
   */
  manifest?: Manifest | null
}

export interface ResourceProfile {
  gpu?: {
    required?: boolean
    reserved?: boolean
    placement?: string
    model_size_bytes?: number
    vram_required_bytes?: number
    headroom_pct?: number
    estimate_source?: string
    notes?: string
  }
  [key: string]: unknown
}

/** A runtime-sidecar capability registers an execution runtime, not a model backend. */
export function isRuntimeCapability(c: CatalogEntry): boolean {
  return c.kind === "runtime_sidecar"
}

export interface CatalogDoc {
  schema_version: number
  generated_at?: string
  capabilities: CatalogEntry[]
}

export interface OperatorDef {
  name: string
  description?: string | null
  arg_names: string[]
  arg_types?: string[]
  return_type: string
  parser?: string | null
  shape?: string
  cache_policy?: "memoize" | "always" | "never" | string
  infix_symbol?: string | null
  infix_word?: string | null
  inputs?: Record<string, string>
  steps?: unknown[]
  tests?: unknown
  step_name?: string
}

export interface ManifestSourceBlock {
  provider?: string | null
  model?: string | null
  revision?: string | null
  url?: string | null
}

export interface ManifestRuntimeBlock {
  mode?: string
  image?: string
  image_digest?: string
  pull_policy?: string
  template?: string
  handler?: string
  language?: string
  device?: string
  port?: number
  publish_host_port?: boolean
  host_bind?: string
  host_port?: number
  host_port_env?: string
  health_path?: string
  base_image?: string
  python_version?: string
  env?: Record<string, string>
  extra_requirements?: string[]
  volumes?: Array<{ name?: string; mount?: string }>
  /** Container command — image runtimes pass serving flags here (vLLM). */
  args?: string[]
  /** Compose `ipc:` mode. vLLM wants `host` for shared-memory tensors. */
  ipc?: string
}

export interface ManifestBackendBlock {
  name: string
  endpoint?: string | null
  transport?: string
  batch_size?: number
  max_concurrent?: number
  timeout_ms?: number
  auth_env?: string | null
  description?: string | null
  opts?: Record<string, unknown>
}

export interface ManifestSmokeBlock {
  inputs?: Array<Record<string, string>>
  sql?: string[]
}

export interface ManifestAcceptanceTest {
  name: string
  description?: string | null
  sql: string
}

export interface ManifestAcceptanceBlock {
  target_selector?: Record<string, unknown>
  setup_sql?: string[]
  tests?: ManifestAcceptanceTest[]
  teardown_sql?: string[]
}

/** Runtime-sidecar registration block (vs the `backend` block on model packs). */
export interface ManifestRuntimeRegistrationBlock {
  name: string
  language?: string
  provider?: string | null
  auth_env?: string | null
  endpoint?: string | null
  endpoint_path?: string | null
  set_default?: boolean
  labels?: Record<string, unknown>
}

export interface Manifest {
  api_version: string
  kind: string
  name: string
  title?: string
  description?: string | null
  license?: string | null
  tags?: string[]
  source?: ManifestSourceBlock
  runtime?: ManifestRuntimeBlock
  prebuilt_runtime?: {
    image?: string
    pull_policy?: string
    source?: string
  }
  /** Present on model packs (`kind: hf_backend`); absent on runtime sidecars. */
  backend?: ManifestBackendBlock
  /** Present on runtime sidecars (`kind: runtime_sidecar`). */
  runtime_registration?: ManifestRuntimeRegistrationBlock
  warren?: {
    endpoint_path?: string | null
    container_port?: number | null
    health_path?: string | null
    service_provider?: string | null
    auth_env?: string | null
  }
  resources?: ResourceProfile
  operators?: OperatorDef[]
  smoke?: ManifestSmokeBlock
  [k: string]: unknown
}

export function isRuntimeManifest(m: Manifest): boolean {
  return m.kind === "runtime_sidecar"
}

/** SQL-only catalog test suites have acceptance SQL but no runtime/backend. */
export function isSqlTestManifest(m: Manifest): boolean {
  return m.kind === "sql_test_pack"
}

/** Remote/API-only backend pack: register SQL only, no local Docker sidecar. */
export function isExternalBackendManifest(m: Manifest): boolean {
  const mode = String(m.runtime?.mode ?? "").toLowerCase()
  if (mode === "external" || mode === "remote") return true
  const endpoint = String(m.backend?.endpoint ?? "").trim()
  return (
    !!m.backend &&
    !m.runtime?.template &&
    !m.runtime?.image &&
    /^https?:\/\//i.test(endpoint)
  )
}

// ── Install state ───────────────────────────────────────────────────

/**
 * The states from CAPABILITIES.md § "Install State Model". These aren't
 * mutually exclusive — a healthy, used backend is `registered + used +
 * healthy`. Catalog-only is exclusive; `external` is exclusive.
 */
export type InstallState =
  | "catalog_only"
  | "registered"
  | "used"
  | "error_seen"
  | "healthy"
  | "failing"
  | "deployment_unavailable"
  | "runtime_ready"
  | "runtime_failing"
  | "external"

export interface InstallStateFlags {
  catalogOnly: boolean
  registered: boolean
  used: boolean
  errorSeen: boolean
  /** null = never probed in this session */
  healthy: boolean | null
  /** Warren-served backend is registered but the latest deployment is not callable. */
  deploymentUnavailable: boolean
  /** runtime-sidecar registered with status = 'ready' */
  runtimeReady: boolean
  /** runtime-sidecar registered with status in ('failed','disabled') */
  runtimeFailing: boolean
  external: boolean
}

export interface InstalledBackend {
  name: string
  transport: string
  endpoint_url: string | null
  batch_size: number
  max_concurrent: number
  timeout_ms: number
  auth_header_env: string | null
  transport_opts: Record<string, unknown> | null
  description: string | null
  source_provider: string | null
  source_model: string | null
  source_revision: string | null
  install_manifest: Manifest | null
  deployment_id: string | null
  deployment_status: string | null
  deployment_serving_status: string | null
  deployment_callable: boolean | null
  deployment_error: string | null
  deployment_updated_at: number | null
  n_calls: number
  n_errors: number
  avg_latency_ms: number | null
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  first_call_at: number | null
  last_call_at: number | null
  created_at: number | null
  /** The literal canonical backend row used by rvbbit.embed(...). */
  is_default_embedder: boolean
  /** Backend copied into the canonical `embed` row, if known. */
  default_embedder_source: string | null
  /** True for the installed capability backend currently backing `embed`. */
  is_default_embedder_source: boolean
}

/** A registered execution runtime — e.g. python_runtimes, mcp_gateways, or memory_services. */
export interface InstalledRuntime {
  name: string
  endpoint_url: string | null
  language: string | null
  status: string
  labels: Record<string, unknown> | null
  runtime_source: string | null
  install_manifest: Manifest | null
  health: unknown
  created_at: number | null
  updated_at: number | null
}

export interface JoinedCatalogEntry {
  catalog: CatalogEntry
  /** Set for `hf_backend` packs joined to rvbbit.backend_health. */
  installed: InstalledBackend | null
  /** Set for `runtime_sidecar` packs joined to a runtime catalog. */
  installedRuntime: InstalledRuntime | null
  flags: InstallStateFlags
}

export interface CatalogJoin {
  entries: JoinedCatalogEntry[]
  /** Installed backends with no matching catalog row — the `external` bucket. */
  external: InstalledBackend[]
  /** Registered runtimes with no matching catalog row. */
  externalRuntimes: InstalledRuntime[]
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

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Semantic capability search (Tier A) — embeds the query and ranks catalog
 * entries by similarity to their def docs (rvbbit.search_capabilities, which
 * reuses the hash-keyed embedding cache; no stored vector). Returns id→score.
 * On any error (e.g. the embed backend is offline) returns an empty map so the
 * caller silently falls back to substring search.
 */
export async function searchCapabilities(
  connectionId: string,
  query: string,
  k = 30,
): Promise<{ scores: Map<string, number>; error?: string }> {
  const q = query.replace(/'/g, "''")
  const kClamped = Math.max(1, Math.min(100, Math.floor(k)))
  const res = await runQuery(
    connectionId,
    `SELECT id, score FROM rvbbit.search_capabilities('${q}', ${kClamped})`,
  )
  if (!res.ok) return { scores: new Map(), error: res.error }
  const scores = new Map<string, number>()
  for (const row of res.rows) {
    const id = String(row.id ?? "")
    if (id) scores.set(id, num(row.score))
  }
  return { scores }
}

function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

function boolOrNull(v: unknown): boolean | null {
  if (v == null) return null
  if (v === true || v === "t" || v === "true" || v === 1 || v === "1") return true
  if (v === false || v === "f" || v === "false" || v === 0 || v === "0") return false
  return null
}

function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ── Catalog fetch (via API route) ───────────────────────────────────

// The DB catalog (`rvbbit.capability_catalog`) is the primary source as of
// 0.60.4; catalog.json (served by the API route) is read-only fallback.
const CAPABILITY_CATALOG_SQL = `SELECT
  id, manifest_path, name, title, description, tags, kind, license,
  coalesce(catalog_entry->>'catalog_visibility', 'public') AS catalog_visibility,
  system_runtime, capability_role,
  source_provider, source_model, source_revision,
  backend_name, backend_transport,
  runtime_name, runtime_language, runtime_template, runtime_handler,
  runtime_port, health_path, endpoint_path, device,
  resource_profile, gpu_required, gpu_placement, model_size_bytes,
  vram_required_bytes, vram_headroom_pct,
  operators, manifest,
  catalog_source, active, created_at, updated_at,
  catalog_entry->'acceptance_tests' AS acceptance_tests,
  catalog_entry->'acceptance' AS acceptance
FROM rvbbit.capability_catalog
WHERE active
  AND coalesce(catalog_entry->>'catalog_visibility', 'public') = 'public'
ORDER BY kind, name`

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function parseAcceptance(v: unknown): ManifestAcceptanceBlock | null {
  const raw = obj(v)
  if (!raw) return null
  const tests = Array.isArray(raw.tests)
    ? raw.tests
        .filter((t): t is Record<string, unknown> => !!obj(t))
        .map((t) => ({
          name: String(t.name ?? ""),
          description: t.description == null ? null : String(t.description),
          sql: String(t.sql ?? ""),
        }))
        .filter((t) => t.name.length > 0 && t.sql.length > 0)
    : []
  return {
    target_selector: obj(raw.target_selector) ?? undefined,
    setup_sql: strArr(raw.setup_sql),
    tests,
    teardown_sql: strArr(raw.teardown_sql),
  }
}

function catalogVisibility(v: unknown): CatalogEntry["catalog_visibility"] {
  return v === "example" || v === "internal" ? v : "public"
}

function resourceProfile(v: unknown): ResourceProfile {
  const raw = obj(v)
  return raw ? (raw as ResourceProfile) : {}
}

function parseCatalogRow(r: Record<string, unknown>): CatalogEntry {
  const manifest = r.manifest
  const acceptance = parseAcceptance(r.acceptance)
  const resources = resourceProfile(r.resource_profile)
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    title: String(r.title ?? r.name ?? ""),
    description: r.description == null ? null : String(r.description),
    tags: strArr(r.tags),
    catalog_visibility: catalogVisibility(r.catalog_visibility),
    kind: String(r.kind ?? ""),
    system_runtime: r.system_runtime === true,
    capability_role: r.capability_role == null ? null : String(r.capability_role),
    source_provider: r.source_provider == null ? null : String(r.source_provider),
    source_model: r.source_model == null ? null : String(r.source_model),
    source_revision: r.source_revision == null ? null : String(r.source_revision),
    license: r.license == null ? null : String(r.license),
    backend_name: r.backend_name == null ? null : String(r.backend_name),
    backend_transport: r.backend_transport == null ? null : String(r.backend_transport),
    runtime_name: r.runtime_name == null ? null : String(r.runtime_name),
    runtime_language: r.runtime_language == null ? null : String(r.runtime_language),
    runtime_template: String(r.runtime_template ?? ""),
    runtime_handler: String(r.runtime_handler ?? ""),
    runtime_port: r.runtime_port == null ? null : Number(r.runtime_port),
    health_path: r.health_path == null ? null : String(r.health_path),
    endpoint_path: r.endpoint_path == null ? null : String(r.endpoint_path),
    device: String(r.device ?? "auto"),
    resources,
    gpu_required: r.gpu_required === true,
    gpu_placement: r.gpu_placement == null ? null : String(r.gpu_placement),
    model_size_bytes: numOrNull(r.model_size_bytes),
    vram_required_bytes: numOrNull(r.vram_required_bytes),
    vram_headroom_pct: numOrNull(r.vram_headroom_pct),
    operators: strArr(r.operators),
    manifest_path: String(r.manifest_path ?? ""),
    catalog_source: String(r.catalog_source ?? "curated"),
    active: r.active !== false,
    created_at: epoch(r.created_at),
    updated_at: epoch(r.updated_at),
    acceptance_tests: strArr(r.acceptance_tests),
    acceptance,
    manifest:
      manifest && typeof manifest === "object"
        ? ({ resources, ...(manifest as Manifest) } as Manifest)
        : null,
  }
}

function normalizeCatalogEntry(e: CatalogEntry | Record<string, unknown>): CatalogEntry {
  const manifest = "manifest" in e ? e.manifest : null
  const acceptance = parseAcceptance((e as Record<string, unknown>).acceptance)
  const resources = resourceProfile(e.resources ?? (e as Record<string, unknown>).resource_profile)
  const gpu = resources.gpu
  return {
    id: String(e.id ?? ""),
    name: String(e.name ?? ""),
    title: String(e.title ?? e.name ?? ""),
    description: e.description == null ? null : String(e.description),
    tags: strArr(e.tags),
    catalog_visibility: catalogVisibility(e.catalog_visibility),
    kind: String(e.kind ?? ""),
    system_runtime: e.system_runtime === true,
    capability_role: e.capability_role == null ? null : String(e.capability_role),
    source_provider: e.source_provider == null ? null : String(e.source_provider),
    source_model: e.source_model == null ? null : String(e.source_model),
    source_revision: e.source_revision == null ? null : String(e.source_revision),
    license: e.license == null ? null : String(e.license),
    backend_name: e.backend_name == null ? null : String(e.backend_name),
    backend_transport: e.backend_transport == null ? null : String(e.backend_transport),
    runtime_name: e.runtime_name == null ? null : String(e.runtime_name),
    runtime_language: e.runtime_language == null ? null : String(e.runtime_language),
    runtime_template: String(e.runtime_template ?? ""),
    runtime_handler: String(e.runtime_handler ?? ""),
    runtime_port: e.runtime_port == null ? null : Number(e.runtime_port),
    health_path: e.health_path == null ? null : String(e.health_path),
    endpoint_path: e.endpoint_path == null ? null : String(e.endpoint_path),
    device: String(e.device ?? "auto"),
    resources,
    gpu_required: e.gpu_required === true || gpu?.required === true,
    gpu_placement:
      e.gpu_placement == null
        ? gpu?.placement == null
          ? null
          : String(gpu.placement)
        : String(e.gpu_placement),
    model_size_bytes: numOrNull(e.model_size_bytes ?? gpu?.model_size_bytes),
    vram_required_bytes: numOrNull(e.vram_required_bytes ?? gpu?.vram_required_bytes),
    vram_headroom_pct: numOrNull(e.vram_headroom_pct ?? gpu?.headroom_pct),
    operators: strArr(e.operators),
    manifest_path: String(e.manifest_path ?? ""),
    catalog_source: String(e.catalog_source ?? "file"),
    active: e.active !== false,
    created_at: epoch(e.created_at),
    updated_at: epoch(e.updated_at),
    acceptance_tests: strArr(e.acceptance_tests),
    acceptance,
    manifest:
      manifest && typeof manifest === "object"
        ? ({ resources, ...(manifest as Manifest) } as Manifest)
        : null,
  }
}

/**
 * Load the capability catalog. When a connection is given, read the DB
 * catalog (`rvbbit.capability_catalog`) — the primary source. Fall back to
 * the static catalog.json (API route) when there's no connection, the table
 * is absent (older extension), or it's empty.
 */
export async function fetchCatalog(connectionId?: string | null): Promise<{
  doc: CatalogDoc | null
  source?: "db" | "file"
  error?: string
}> {
  if (connectionId) {
    const res = await runQuery(connectionId, CAPABILITY_CATALOG_SQL)
    if (res.ok && res.rows.length > 0) {
      return {
        doc: { schema_version: 1, capabilities: res.rows.map(parseCatalogRow) },
        source: "db",
      }
    }
    // res not ok (table missing) or empty → fall through to the JSON file.
  }
  try {
    const res = await fetch("/api/rvbbit/capabilities?action=catalog")
    const body = (await res.json()) as { ok: boolean; doc?: CatalogDoc; error?: string }
    if (!body.ok) return { doc: null, error: body.error ?? "failed to load catalog" }
    return {
      doc: body.doc
        ? {
            ...body.doc,
            capabilities: (body.doc.capabilities ?? [])
              .map(normalizeCatalogEntry)
              .filter((c) => c.catalog_visibility === "public"),
          }
        : null,
      source: "file",
    }
  } catch (e) {
    return { doc: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function fetchManifest(
  manifestPath: string,
): Promise<{ manifest: Manifest | null; error?: string }> {
  try {
    const res = await fetch(
      `/api/rvbbit/capabilities?action=manifest&path=${encodeURIComponent(manifestPath)}`,
    )
    const body = (await res.json()) as {
      ok: boolean
      manifest?: Manifest
      error?: string
    }
    if (!body.ok) return { manifest: null, error: body.error ?? "failed to load manifest" }
    return { manifest: body.manifest ?? null }
  } catch (e) {
    return { manifest: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Installed-backend query (CAPABILITIES.md § "Installed Backend Query") ──

const BACKEND_HEALTH_BASE_SQL = `WITH embed_default AS (
  SELECT coalesce(
    (SELECT nullif(install_manifest #>> '{rvbbit_default_embedder,source_backend}', '')
     FROM rvbbit.backend_health
     WHERE name = 'embed'),
    'embed'
  ) AS source_backend
)
SELECT
  name,
  transport,
  endpoint_url,
  batch_size,
  max_concurrent,
  timeout_ms,
  auth_header_env,
  transport_opts,
  description,
  source_provider,
  source_model,
  source_revision,
  install_manifest,
  n_calls,
  n_errors,
  avg_latency_ms,
  p50_latency_ms,
  p95_latency_ms,
  first_call_at,
  last_call_at,
  created_at,
  NULL::uuid AS deployment_id,
  NULL::text AS deployment_status,
  NULL::text AS deployment_serving_status,
  NULL::boolean AS deployment_callable,
  NULL::text AS deployment_error,
  NULL::timestamptz AS deployment_updated_at,
  (name = 'embed') AS is_default_embedder,
  embed_default.source_backend AS default_embedder_source,
  (name = embed_default.source_backend) AS is_default_embedder_source
FROM rvbbit.backend_health
CROSS JOIN embed_default
ORDER BY name`

const BACKEND_HEALTH_WITH_WARREN_SQL = `WITH embed_default AS (
  SELECT coalesce(
    (SELECT nullif(install_manifest #>> '{rvbbit_default_embedder,source_backend}', '')
     FROM rvbbit.backend_health
     WHERE name = 'embed'),
    'embed'
  ) AS source_backend
)
SELECT
  h.name,
  h.transport,
  h.endpoint_url,
  h.batch_size,
  h.max_concurrent,
  h.timeout_ms,
  h.auth_header_env,
  h.transport_opts,
  h.description,
  h.source_provider,
  h.source_model,
  h.source_revision,
  h.install_manifest,
  h.n_calls,
  h.n_errors,
  h.avg_latency_ms,
  h.p50_latency_ms,
  h.p95_latency_ms,
  h.first_call_at,
  h.last_call_at,
  h.created_at,
  w.deployment_id,
  w.deployment_status,
  w.serving_status AS deployment_serving_status,
  w.callable AS deployment_callable,
  w.deployment_error,
  w.deployment_updated_at,
  (h.name = 'embed') AS is_default_embedder,
  embed_default.source_backend AS default_embedder_source,
  (h.name = embed_default.source_backend) AS is_default_embedder_source
FROM rvbbit.backend_health h
CROSS JOIN embed_default
LEFT JOIN rvbbit.warren_backend_status w
  ON w.name = h.name
ORDER BY h.name`

function parseInstalled(r: Record<string, unknown>): InstalledBackend {
  const opts = r.transport_opts
  const manifest = r.install_manifest
  return {
    name: String(r.name ?? ""),
    transport: String(r.transport ?? ""),
    endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    batch_size: num(r.batch_size),
    max_concurrent: num(r.max_concurrent),
    timeout_ms: num(r.timeout_ms),
    auth_header_env: r.auth_header_env == null ? null : String(r.auth_header_env),
    transport_opts:
      opts && typeof opts === "object" ? (opts as Record<string, unknown>) : null,
    description: r.description == null ? null : String(r.description),
    source_provider: r.source_provider == null ? null : String(r.source_provider),
    source_model: r.source_model == null ? null : String(r.source_model),
    source_revision: r.source_revision == null ? null : String(r.source_revision),
    install_manifest:
      manifest && typeof manifest === "object" ? (manifest as Manifest) : null,
    deployment_id: r.deployment_id == null ? null : String(r.deployment_id),
    deployment_status:
      r.deployment_status == null ? null : String(r.deployment_status),
    deployment_serving_status:
      r.deployment_serving_status == null ? null : String(r.deployment_serving_status),
    deployment_callable: boolOrNull(r.deployment_callable),
    deployment_error: r.deployment_error == null ? null : String(r.deployment_error),
    deployment_updated_at: epoch(r.deployment_updated_at),
    n_calls: num(r.n_calls),
    n_errors: num(r.n_errors),
    avg_latency_ms: r.avg_latency_ms == null ? null : num(r.avg_latency_ms),
    p50_latency_ms: r.p50_latency_ms == null ? null : num(r.p50_latency_ms),
    p95_latency_ms: r.p95_latency_ms == null ? null : num(r.p95_latency_ms),
    first_call_at: epoch(r.first_call_at),
    last_call_at: epoch(r.last_call_at),
    created_at: epoch(r.created_at),
    is_default_embedder: r.is_default_embedder === true || r.is_default_embedder === "t",
    default_embedder_source:
      r.default_embedder_source == null ? null : String(r.default_embedder_source),
    is_default_embedder_source:
      r.is_default_embedder_source === true || r.is_default_embedder_source === "t",
  }
}

export async function fetchInstalledBackends(
  connectionId: string,
): Promise<{ backends: InstalledBackend[]; error?: string }> {
  let res = await runQuery(connectionId, BACKEND_HEALTH_WITH_WARREN_SQL)
  if (!res.ok && /warren_backend_status/i.test(res.error)) {
    res = await runQuery(connectionId, BACKEND_HEALTH_BASE_SQL)
  }
  if (!res.ok) return { backends: [], error: res.error }
  return { backends: res.rows.map(parseInstalled) }
}

// ── Installed-runtime query (CAPABILITIES.md § "Installed Runtime Query") ──

const PYTHON_RUNTIMES_SQL = `SELECT
  name,
  endpoint_url,
  language,
  status,
  labels,
  runtime_source,
  install_manifest,
  health,
  created_at,
  updated_at
FROM rvbbit.python_runtimes
ORDER BY name`

const MCP_GATEWAYS_SQL = `SELECT
  name,
  endpoint_url,
  'mcp' AS language,
  status,
  labels,
  gateway_source AS runtime_source,
  install_manifest,
  health,
  created_at,
  updated_at
FROM rvbbit.mcp_gateways
ORDER BY name`

const MEMORY_SERVICES_SQL = `SELECT
  name,
  endpoint_url,
  'memory' AS language,
  status,
  labels,
  service_source AS runtime_source,
  install_manifest,
  health,
  created_at,
  updated_at
FROM rvbbit.memory_services
ORDER BY name`

function parseRuntime(r: Record<string, unknown>): InstalledRuntime {
  const labels = r.labels
  const manifest = r.install_manifest
  return {
    name: String(r.name ?? ""),
    endpoint_url: r.endpoint_url == null ? null : String(r.endpoint_url),
    language: r.language == null ? null : String(r.language),
    status: String(r.status ?? ""),
    labels: labels && typeof labels === "object" ? (labels as Record<string, unknown>) : null,
    runtime_source: r.runtime_source == null ? null : String(r.runtime_source),
    install_manifest:
      manifest && typeof manifest === "object" ? (manifest as Manifest) : null,
    health: r.health ?? null,
    created_at: epoch(r.created_at),
    updated_at: epoch(r.updated_at),
  }
}

export async function fetchInstalledRuntimes(
  connectionId: string,
): Promise<{ runtimes: InstalledRuntime[]; error?: string }> {
  const [res, mcpRes, memoryRes] = await Promise.all([
    runQuery(connectionId, PYTHON_RUNTIMES_SQL),
    runQuery(connectionId, MCP_GATEWAYS_SQL),
    runQuery(connectionId, MEMORY_SERVICES_SQL),
  ])
  const rows: InstalledRuntime[] = []
  const missing = /relation .* does not exist|does not exist/i
  const errors = [res, mcpRes, memoryRes]
    .flatMap((r) => (r.ok || missing.test(r.error ?? "") ? [] : [r.error]))
    .filter((e): e is string => !!e)
  if (res.ok) rows.push(...res.rows.map(parseRuntime))
  if (mcpRes.ok) rows.push(...mcpRes.rows.map(parseRuntime))
  if (memoryRes.ok) rows.push(...memoryRes.rows.map(parseRuntime))
  return {
    runtimes: rows,
    error: rows.length === 0 && errors.length > 0 ? errors[0] : undefined,
  }
}

// ── 7-state derivation ──────────────────────────────────────────────

/**
 * Build the catalog × installed join. `probes` is an optional per-name
 * map of last-probe results (so a window that has just probed a backend
 * can fold `healthy`/`failing` into the badges without a re-query).
 */
const RUNTIME_READY_STATUS = new Set(["ready"])
const RUNTIME_FAILING_STATUS = new Set(["failed", "disabled"])

export function joinCatalogToInstalled(
  catalog: CatalogEntry[],
  installed: InstalledBackend[],
  runtimes: InstalledRuntime[] = [],
  probes?: Map<string, ProbeResult>,
): CatalogJoin {
  const byName = new Map(installed.map((b) => [b.name, b]))
  const byRuntime = new Map(runtimes.map((r) => [r.name, r]))
  const catalogBackendNames = new Set(
    catalog.map((c) => c.backend_name).filter((n): n is string => !!n),
  )
  const catalogRuntimeNames = new Set(
    catalog.map((c) => c.runtime_name).filter((n): n is string => !!n),
  )

  const entries: JoinedCatalogEntry[] = catalog.map((c) => {
    if (isRuntimeCapability(c)) {
      const rt = c.runtime_name ? byRuntime.get(c.runtime_name) ?? null : null
      const status = rt?.status ?? ""
      const flags: InstallStateFlags = {
        catalogOnly: rt == null,
        registered: rt != null,
        used: false,
        errorSeen: false,
        healthy: null,
        deploymentUnavailable: false,
        runtimeReady: !!rt && RUNTIME_READY_STATUS.has(status),
        runtimeFailing: !!rt && RUNTIME_FAILING_STATUS.has(status),
        external: false,
      }
      return { catalog: c, installed: null, installedRuntime: rt, flags }
    }
    const inst = c.backend_name ? byName.get(c.backend_name) ?? null : null
    const probe = c.backend_name ? probes?.get(c.backend_name) : undefined
    const flags: InstallStateFlags = {
      catalogOnly: inst == null,
      registered: inst != null,
      used: !!inst && inst.n_calls > 0,
      errorSeen: !!inst && inst.n_errors > 0,
      healthy: probe ? probe.ok : null,
      deploymentUnavailable:
        !!inst && inst.deployment_callable === false && inst.deployment_serving_status !== "external",
      runtimeReady: false,
      runtimeFailing: false,
      external: false,
    }
    return { catalog: c, installed: inst, installedRuntime: null, flags }
  })

  const external = installed.filter((b) => !catalogBackendNames.has(b.name))
  const externalRuntimes = runtimes.filter((r) => !catalogRuntimeNames.has(r.name))

  return { entries, external, externalRuntimes }
}

/** Compact label list — fed to the badge primitive in instruments.tsx. */
export function flagsToStates(flags: InstallStateFlags): InstallState[] {
  const out: InstallState[] = []
  if (flags.catalogOnly) out.push("catalog_only")
  if (flags.registered) out.push("registered")
  if (flags.used) out.push("used")
  if (flags.errorSeen) out.push("error_seen")
  if (flags.healthy === true) out.push("healthy")
  if (flags.healthy === false) out.push("failing")
  if (flags.deploymentUnavailable) out.push("deployment_unavailable")
  if (flags.runtimeReady) out.push("runtime_ready")
  if (flags.runtimeFailing) out.push("runtime_failing")
  if (flags.external) out.push("external")
  return out
}

// ── Probe ───────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean
  backend: string
  targetKind?: "backend" | "runtime" | "memory" | "mcp"
  transport?: string
  endpoint?: string
  latency_ms: number
  output?: unknown
  outputType?: string
  outputSize?: number
  error?: string
}

function classifyOutput(v: unknown): { outputType: string; outputSize: number } {
  if (v == null) return { outputType: "null", outputSize: 0 }
  if (Array.isArray(v)) return { outputType: "array", outputSize: v.length }
  if (typeof v === "object")
    return { outputType: "object", outputSize: Object.keys(v as object).length }
  const s = String(v)
  return { outputType: typeof v, outputSize: s.length }
}

export async function probeBackend(
  connectionId: string,
  name: string,
  sample?: Record<string, unknown> | null,
): Promise<ProbeResult> {
  const sql =
    sample == null
      ? `SELECT rvbbit.backend_probe(${sqlLit(name)}) AS r`
      : `SELECT rvbbit.backend_probe_with_input(${sqlLit(name)}, ${sqlLit(JSON.stringify(sample))}::jsonb) AS r`
  const started = Date.now()
  const res = await runQuery(connectionId, sql)
  const fallbackLatency = Date.now() - started
  if (!res.ok) {
    return {
      ok: false,
      backend: name,
      latency_ms: fallbackLatency,
      error: res.error,
    }
  }
  const row = res.rows[0]?.r
  if (!row || typeof row !== "object") {
    return {
      ok: false,
      backend: name,
      latency_ms: fallbackLatency,
      error: "probe returned no row",
    }
  }
  const r = row as Record<string, unknown>
  const cls = classifyOutput(r.output)
  return {
    ok: r.ok === true,
    backend: String(r.backend ?? name),
    transport: r.transport == null ? undefined : String(r.transport),
    endpoint: r.endpoint == null ? undefined : String(r.endpoint),
    latency_ms: r.latency_ms == null ? fallbackLatency : Number(r.latency_ms),
    output: r.output,
    outputType: cls.outputType,
    outputSize: cls.outputSize,
    error: r.error == null ? undefined : String(r.error),
  }
}

function runtimeLanguage(m: Manifest): string {
  return String(m.runtime_registration?.language ?? m.runtime?.language ?? "python").toLowerCase()
}

function runtimeRegistrationName(m: Manifest): string {
  return String(m.runtime_registration?.name ?? m.name)
}

export async function probeRuntime(
  connectionId: string,
  manifest: Manifest,
): Promise<ProbeResult> {
  const name = runtimeRegistrationName(manifest)
  const language = runtimeLanguage(manifest)
  const isMemory = language === "memory" || language === "hindsight" || language === "http_service"
  const provider = String(
    manifest.runtime_registration?.provider ??
      manifest.warren?.service_provider ??
      (isMemory ? "hindsight" : ""),
  ).toLowerCase()
  const targetKind: ProbeResult["targetKind"] =
    language === "mcp" || language === "mcp_gateway" ? "mcp" : isMemory ? "memory" : "runtime"
  let sql: string
  if (isMemory && provider === "hindsight") {
    sql = [
      "SELECT",
      `  rvbbit.hindsight_status(${sqlLit(name)}) AS r,`,
      "  (SELECT endpoint_url FROM rvbbit.memory_services WHERE name = " + sqlLit(name) + ") AS endpoint",
    ].join("\n")
  } else if (isMemory) {
    sql = [
      "SELECT",
      "  jsonb_build_object('status', status, 'provider', provider, 'health', health) AS r,",
      "  endpoint_url AS endpoint",
      "FROM rvbbit.memory_services",
      `WHERE name = ${sqlLit(name)}`,
    ].join("\n")
  } else if (language === "mcp" || language === "mcp_gateway") {
    sql = `SELECT rvbbit.mcp_probe(${sqlLit(name)}) AS r, (SELECT endpoint_url FROM rvbbit.mcp_gateways WHERE name = ${sqlLit(name)}) AS endpoint`
  } else {
    sql = [
      "SELECT",
      "  jsonb_build_object('status', status, 'health', health) AS r,",
      "  endpoint_url AS endpoint",
      "FROM rvbbit.python_runtimes",
      `WHERE name = ${sqlLit(name)}`,
    ].join("\n")
  }

  const started = Date.now()
  const res = await runQuery(connectionId, sql)
  const fallbackLatency = Date.now() - started
  if (!res.ok) {
    return {
      ok: false,
      backend: name,
      targetKind,
      latency_ms: fallbackLatency,
      error: res.error,
    }
  }
  const row = res.rows[0] ?? {}
  const output = row.r
  if (output == null) {
    return {
      ok: false,
      backend: name,
      targetKind,
      latency_ms: fallbackLatency,
      error: "runtime probe returned no row",
    }
  }
  const outputObj = output && typeof output === "object" ? (output as Record<string, unknown>) : null
  const status = String(outputObj?.status ?? outputObj?.reachable ?? "").toLowerCase()
  const cls = classifyOutput(output)
  return {
    ok:
      isMemory && provider === "hindsight"
        ? true
        : status === "ready" || status === "ok" || outputObj?.reachable === true,
    backend: name,
    targetKind,
    transport: language,
    endpoint: row.endpoint == null ? undefined : String(row.endpoint),
    latency_ms: fallbackLatency,
    output,
    outputType: cls.outputType,
    outputSize: cls.outputSize,
  }
}

// ── Install pipeline transport ──────────────────────────────────────

export interface ScaffoldRequest {
  /** Active Lens connection; used by local installs to provision DB-backed runtimes. */
  connectionId?: string | null
  /** On-disk manifest (catalog packs). One of manifestPath/manifestYaml required. */
  manifestPath?: string
  /** Inline manifest YAML (ad-hoc/from-id deploys with no pack on disk). */
  manifestYaml?: string
  outDir: string
  force?: boolean
  overrides?: Record<string, string>
}

export interface ScaffoldedFileEntry {
  name: string
  size: number
  isOverride: boolean
}

export interface ScaffoldResult {
  ok: boolean
  outDir?: string
  files: ScaffoldedFileEntry[]
  overridesApplied: string[]
  stdout: string
  stderr: string
  error?: string
}

export async function runScaffold(req: ScaffoldRequest): Promise<ScaffoldResult> {
  try {
    const res = await fetch("/api/rvbbit/capabilities/scaffold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    })
    const body = (await res.json()) as Partial<ScaffoldResult> & { ok: boolean }
    return {
      ok: body.ok === true,
      outDir: body.outDir,
      files: body.files ?? [],
      overridesApplied: body.overridesApplied ?? [],
      stdout: body.stdout ?? "",
      stderr: body.stderr ?? "",
      error: body.error,
    }
  } catch (e) {
    return {
      ok: false,
      files: [],
      overridesApplied: [],
      stdout: "",
      stderr: "",
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Compose-up streaming frames — the wire shape from the SSE route.
 * `done` is the final frame on a successful close; `error` is the
 * final frame on a child-spawn failure. `line` events arrive as the
 * docker build/run produces output.
 */
export type ComposeFrame =
  | { type: "line"; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; error: string }

/**
 * Stream the docker compose up output. The returned promise resolves
 * with the exit code (or -1 on error). `onFrame` fires for every
 * line/done/error. Aborting the AbortController kills the docker child
 * server-side.
 */
export async function streamComposeUp(
  args: {
    outDir: string
    device?: string
    gpu?: boolean
    gpuIntent?: boolean
    publishHostPort?: boolean
  },
  onFrame: (frame: ComposeFrame) => void,
  signal?: AbortSignal,
): Promise<{ exitCode: number; error?: string }> {
  let res: Response
  try {
    res = await fetch("/api/rvbbit/capabilities/compose-up", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal,
    })
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    return { exitCode: -1, error: err }
  }

  if (!res.ok || !res.body) {
    let err = `compose-up request failed: ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) err = body.error
    } catch {
      /* non-JSON error body */
    }
    return { exitCode: -1, error: err }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let exitCode = -1
  let error: string | undefined

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are separated by "\n\n"; each frame has one or more
      // "data: <json>" lines (we always emit one line per frame).
      let sep: number
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data: ")) continue
          const payload = line.slice("data: ".length)
          try {
            const frame = JSON.parse(payload) as ComposeFrame
            onFrame(frame)
            if (frame.type === "done") exitCode = frame.exitCode
            if (frame.type === "error") error = frame.error
          } catch {
            /* malformed frame — skip */
          }
        }
      }
    }
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      return { exitCode: -1, error: "aborted" }
    }
    error = e instanceof Error ? e.message : String(e)
  }

  return { exitCode, error }
}

// ── SQL apply for the install pipeline ──────────────────────────────

export interface SqlApplyResult {
  ok: boolean
  latencyMs: number
  error?: string
  /** First row of the final statement, when present. */
  lastRow?: Record<string, unknown> | null
}

/**
 * Apply a SQL script (register.sql / operator.sql / smoke.sql) through
 * the existing /api/db/query route. Pipelined statements share a
 * connection on the server side, so the script runs atomically as a
 * single round-trip from this client's perspective.
 */
export async function applyInstallSql(
  connectionId: string,
  sql: string,
): Promise<SqlApplyResult> {
  const started = Date.now()
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 200 }),
    })
    const body = (await res.json()) as {
      ok: boolean
      error?: string
      rows?: Array<Record<string, unknown>>
    }
    const latencyMs = Date.now() - started
    if (!body.ok) return { ok: false, latencyMs, error: body.error }
    const rows = body.rows ?? []
    return { ok: true, latencyMs, lastRow: rows[rows.length - 1] ?? null }
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function renderSetDefaultEmbedderSql(
  backendName: string,
  purgeCache = true,
): string {
  return [
    "-- Promote an installed embedding backend to the system default.",
    "-- This overwrites the canonical `embed` backend row and purges stale `embed` cache entries.",
    "SELECT rvbbit.set_default_embedder(",
    `  backend_name => ${sqlLit(backendName)},`,
    `  purge_cache  => ${purgeCache ? "true" : "false"}`,
    ") AS default_embedder;",
    "",
  ].join("\n")
}

export async function setDefaultEmbedder(
  connectionId: string,
  backendName: string,
  purgeCache = true,
): Promise<SqlApplyResult> {
  return applyInstallSql(connectionId, renderSetDefaultEmbedderSql(backendName, purgeCache))
}

export interface CatalogImportResult {
  ok: boolean
  imported?: number
  catalogSource?: string
  ids?: string[]
  durationMs?: number
  rowCount?: number
  error?: string
  detail?: string
  hint?: string
}

export async function importCapabilityCatalogUrl(args: {
  connectionId: string
  url: string
  catalogSource?: string
  prune?: boolean
}): Promise<CatalogImportResult> {
  try {
    const res = await fetch("/api/rvbbit/capabilities/import-catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    })
    const body = (await res.json()) as CatalogImportResult
    return body
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export interface AcceptanceRunStep {
  kind: "setup" | "test" | "teardown"
  name: string
  description?: string | null
  sql: string
  ok: boolean
  latencyMs: number
  lastRow?: Record<string, unknown> | null
  error?: string
}

export interface AcceptanceRunResult {
  ok: boolean
  startedAt: number
  endedAt: number
  steps: AcceptanceRunStep[]
}

export async function runAcceptanceSql(
  connectionId: string,
  acceptance: ManifestAcceptanceBlock,
  onStep?: (step: AcceptanceRunStep) => void,
): Promise<AcceptanceRunResult> {
  const startedAt = Date.now()
  const steps: AcceptanceRunStep[] = []
  const run = async (
    kind: AcceptanceRunStep["kind"],
    name: string,
    sql: string,
    description?: string | null,
  ): Promise<boolean> => {
    const result = await applyInstallSql(connectionId, sql)
    const step: AcceptanceRunStep = {
      kind,
      name,
      description,
      sql,
      ok: result.ok,
      latencyMs: result.latencyMs,
      lastRow: result.lastRow ?? null,
      error: result.error,
    }
    steps.push(step)
    onStep?.(step)
    return result.ok
  }

  for (const [i, sql] of (acceptance.setup_sql ?? []).entries()) {
    const ok = await run("setup", `setup_${i + 1}`, sql)
    if (!ok) return { ok: false, startedAt, endedAt: Date.now(), steps }
  }
  for (const test of acceptance.tests ?? []) {
    const ok = await run("test", test.name, test.sql, test.description)
    if (!ok) return { ok: false, startedAt, endedAt: Date.now(), steps }
  }
  for (const [i, sql] of (acceptance.teardown_sql ?? []).entries()) {
    const ok = await run("teardown", `teardown_${i + 1}`, sql)
    if (!ok) return { ok: false, startedAt, endedAt: Date.now(), steps }
  }
  return { ok: true, startedAt, endedAt: Date.now(), steps }
}

// ── Knob editor + live render ───────────────────────────────────────

/**
 * vLLM serving levers — only meaningful for `kind: llm_provider` packs
 * whose runtime handler is `vllm_openai`. These map 1:1 onto the
 * vLLM OpenAI server CLI flags and are upserted into `runtime.args`
 * (preserving manifest-fixed flags like `--model` / `--served-model-name`).
 */
export interface VllmKnobs {
  /** --gpu-memory-utilization (0..1). The big GPU-OOM lever. */
  gpuMemoryUtilization: number
  /** --max-model-len. 0 = let vLLM use the model's config default. */
  maxModelLen: number
  /** --tensor-parallel-size. Shard across N GPUs. */
  tensorParallelSize: number
  /** --max-num-seqs. 0 = vLLM default. Caps concurrent sequences. */
  maxNumSeqs: number
  /** --dtype: auto | float16 | bfloat16 | float32. */
  dtype: string
  /** --quantization: none | awq | gptq | fp8 | bitsandbytes. */
  quantization: string
}

/** True when this capability serves an LLM via the vLLM OpenAI image. */
export function isVllmManifest(m: Manifest): boolean {
  return (m.runtime?.handler ?? "").toLowerCase() === "vllm_openai"
}

export type CapabilityTypeKey =
  | "vllm"
  | "llm"
  | "runtime"
  | "embedding"
  | "rerank"
  | "extract"
  | "classify"
  | "forecast"
  | "tabular"
  | "mcp"
  | "specialist"

export interface CapabilityTypeTone {
  key: CapabilityTypeKey
  label: string
  shortLabel: string
  cssVar: string
}

export const CAPABILITY_TYPE_TONES: Record<CapabilityTypeKey, CapabilityTypeTone> = {
  vllm: {
    key: "vllm",
    label: "vLLM LLM",
    shortLabel: "vLLM",
    cssVar: "--cap-type-vllm",
  },
  llm: {
    key: "llm",
    label: "LLM",
    shortLabel: "LLM",
    cssVar: "--cap-type-llm",
  },
  runtime: {
    key: "runtime",
    label: "Runtime",
    shortLabel: "Runtime",
    cssVar: "--cap-type-runtime",
  },
  embedding: {
    key: "embedding",
    label: "Embedding",
    shortLabel: "Embed",
    cssVar: "--cap-type-embedding",
  },
  rerank: {
    key: "rerank",
    label: "Reranker",
    shortLabel: "Rerank",
    cssVar: "--cap-type-rerank",
  },
  extract: {
    key: "extract",
    label: "Extractor",
    shortLabel: "Extract",
    cssVar: "--cap-type-extract",
  },
  classify: {
    key: "classify",
    label: "Classifier",
    shortLabel: "Classify",
    cssVar: "--cap-type-classify",
  },
  forecast: {
    key: "forecast",
    label: "Forecast",
    shortLabel: "Forecast",
    cssVar: "--cap-type-forecast",
  },
  tabular: {
    key: "tabular",
    label: "Data/table",
    shortLabel: "Data",
    cssVar: "--cap-type-tabular",
  },
  mcp: {
    key: "mcp",
    label: "MCP server",
    shortLabel: "MCP",
    cssVar: "--cap-type-mcp",
  },
  specialist: {
    key: "specialist",
    label: "Specialist",
    shortLabel: "Specialist",
    cssVar: "--cap-type-specialist",
  },
}

export function capabilityTypeTone(key: CapabilityTypeKey): CapabilityTypeTone {
  return CAPABILITY_TYPE_TONES[key] ?? CAPABILITY_TYPE_TONES.specialist
}

export function classifyManifestCapabilityType(m: Manifest): CapabilityTypeKey {
  return classifyCapabilityTypeFields({
    kind: m.kind,
    tags: m.tags ?? [],
    runtimeHandler: m.runtime?.handler,
    backendTransport: m.backend?.transport,
    backendName: m.backend?.name,
    runtimeName: m.runtime_registration?.name,
    sourceModel: m.source?.model,
    operators: (m.operators ?? []).map((op) => op.name),
  })
}

export function classifyCatalogCapabilityType(c: CatalogEntry): CapabilityTypeKey {
  if (c.manifest) return classifyManifestCapabilityType(c.manifest)
  return classifyCapabilityTypeFields({
    kind: c.kind,
    tags: c.tags ?? [],
    runtimeHandler: c.runtime_handler,
    backendTransport: c.backend_transport,
    backendName: c.backend_name,
    runtimeName: c.runtime_name,
    sourceModel: c.source_model,
    operators: c.operators ?? [],
  })
}

function classifyCapabilityTypeFields({
  kind,
  tags,
  runtimeHandler,
  backendTransport,
  backendName,
  runtimeName,
  sourceModel,
  operators,
}: {
  kind?: string | null
  tags: string[]
  runtimeHandler?: string | null
  backendTransport?: string | null
  backendName?: string | null
  runtimeName?: string | null
  sourceModel?: string | null
  operators: string[]
}): CapabilityTypeKey {
  const lowerTags = new Set(tags.map((t) => t.toLowerCase()))
  const handler = (runtimeHandler ?? "").toLowerCase()
  const transport = (backendTransport ?? "").toLowerCase()
  const nameBits = [kind, runtimeHandler, backendTransport, backendName, runtimeName, sourceModel, ...operators]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase()
  const hasTag = (...needles: string[]) => needles.some((t) => lowerTags.has(t))
  const hasText = (...needles: string[]) => needles.some((t) => nameBits.includes(t))
  const hasAny = (...needles: string[]) => hasTag(...needles) || hasText(...needles)

  // Strictly the kind='mcp' rows — NOT anything merely tagged 'mcp' (e.g. the
  // MCP gateway *runtime* carries an 'mcp' tag but is a runtime_sidecar).
  if (kind === "mcp") return "mcp"
  if (kind === "sql_test_pack" || hasTag("sql", "acceptance", "test")) return "specialist"
  if (handler === "vllm_openai" || hasAny("vllm")) return "vllm"
  if (kind === "runtime_sidecar") return "runtime"
  if (kind === "llm_provider" || transport === "openai_chat" || hasTag("llm")) return "llm"
  if (handler === "embedding" || transport === "local_embed" || hasAny("embedding", "embed", "retrieval"))
    return "embedding"
  if (hasAny("rerank", "reranker", "cross-encoder", "cross_encoder", "semantic_score"))
    return "rerank"
  if (handler === "time_series_forecast" || hasAny("forecast", "forecasting", "time-series", "time_series"))
    return "forecast"
  if (hasAny("tabular", "table", "tabfpn", "tapas", "contract", "join", "column", "quality", "governance"))
    return "tabular"
  if (hasAny("extract", "extraction", "gliner", "ner", "token-classification", "token_classification", "keyphrase", "pii"))
    return "extract"
  if (
    handler === "sequence_classification" ||
    handler === "zero_shot_classification" ||
    hasAny("classify", "classification", "classifier", "sentiment", "emotion", "nli", "zero-shot", "zero_shot", "security")
  ) {
    return "classify"
  }
  return "specialist"
}

/** vLLM flags this UI owns — stripped before re-applying knob values. */
const VLLM_MANAGED_FLAGS = [
  "--gpu-memory-utilization",
  "--max-model-len",
  "--tensor-parallel-size",
  "--max-num-seqs",
  "--dtype",
  "--quantization",
]

function vllmArgValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

/** Seed the knob editor from the manifest's existing `runtime.args`. */
export function parseVllmKnobs(args: string[]): VllmKnobs {
  const num = (flag: string, fallback: number) => {
    const raw = vllmArgValue(args, flag)
    const n = raw == null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    gpuMemoryUtilization: num("--gpu-memory-utilization", 0.9),
    maxModelLen: num("--max-model-len", 0),
    tensorParallelSize: num("--tensor-parallel-size", 1),
    maxNumSeqs: num("--max-num-seqs", 0),
    dtype: vllmArgValue(args, "--dtype") ?? "auto",
    quantization: vllmArgValue(args, "--quantization") ?? "none",
  }
}

/**
 * Upsert the user's vLLM knobs into a base args list. Manifest-fixed
 * flags (--model, --served-model-name, --host, --port) flow through
 * untouched; the six managed flags are replaced with knob values.
 */
export function applyVllmKnobsToArgs(base: string[], v: VllmKnobs): string[] {
  const out: string[] = []
  for (let i = 0; i < base.length; i++) {
    if (VLLM_MANAGED_FLAGS.includes(base[i])) {
      i++ // skip the flag and its value
      continue
    }
    out.push(base[i])
  }
  out.push("--dtype", v.dtype)
  out.push("--gpu-memory-utilization", String(v.gpuMemoryUtilization))
  out.push("--tensor-parallel-size", String(v.tensorParallelSize))
  if (v.maxModelLen > 0) out.push("--max-model-len", String(v.maxModelLen))
  if (v.maxNumSeqs > 0) out.push("--max-num-seqs", String(v.maxNumSeqs))
  if (v.quantization && v.quantization !== "none")
    out.push("--quantization", v.quantization)
  return out
}

/**
 * The handful of knobs the install wizard exposes. Anything else is
 * inherited from the manifest. Editing a knob doesn't mutate the file —
 * it overrides values inside the render functions.
 */
export interface InstallKnobs {
  model: string
  device: string
  batchSize: number
  maxConcurrent: number
  timeoutMs: number
  publishHostPort: boolean
  hostPort: number
  dockerNetwork: string
  outputDir: string
  gpu: boolean
  /** Present only for vLLM packs; drives `runtime.args`. */
  vllm?: VllmKnobs
}

export function defaultKnobs(manifest: Manifest): InstallKnobs {
  const backend: Partial<ManifestBackendBlock> = manifest.backend ?? {}
  const runtime = manifest.runtime ?? {}
  const opts = backend.opts ?? {}
  const hostPort =
    typeof runtime.host_port === "number" && Number.isFinite(runtime.host_port)
      ? runtime.host_port
      : 0
  return {
    model: manifest.source?.model ?? String(opts.model ?? ""),
    device: runtime.device ?? "auto",
    batchSize: backend.batch_size ?? 32,
    maxConcurrent: backend.max_concurrent ?? 4,
    timeoutMs: backend.timeout_ms ?? 60000,
    publishHostPort: runtime.publish_host_port === true,
    hostPort,
    dockerNetwork: "docker_default",
    outputDir: `.rvbbit/capabilities/${manifest.name}`,
    gpu: false,
    vllm: isVllmManifest(manifest)
      ? parseVllmKnobs(runtime.args ?? [])
      : undefined,
  }
}

/** Apply knobs onto a manifest copy. Pure — never mutates the input. */
function applyKnobs(manifest: Manifest, knobs: InstallKnobs): Manifest {
  const copy: Manifest = JSON.parse(JSON.stringify(manifest)) as Manifest
  const model = knobs.model.trim()
  const modelEditable =
    isExternalBackendManifest(copy) || (copy.backend?.transport ?? "").toLowerCase() === "openai"
  if (modelEditable && model.length > 0) {
    copy.source = { ...(copy.source ?? {}), model }
    if (copy.backend) {
      copy.backend.opts = { ...(copy.backend.opts ?? {}), model }
    }
  }
  // Backend knobs only apply to model packs; runtime sidecars have no backend.
  if (copy.backend) {
    copy.backend.batch_size = knobs.batchSize
    copy.backend.max_concurrent = knobs.maxConcurrent
    copy.backend.timeout_ms = knobs.timeoutMs
  }
  if (!isSqlTestManifest(copy)) {
    copy.runtime = { ...(copy.runtime ?? {}), device: knobs.device }
  }
  // vLLM serving flags are upserted into runtime.args so both the
  // compose `command:` and the rendered manifest reflect the knobs.
  if (knobs.vllm && isVllmManifest(copy)) {
    copy.runtime = copy.runtime ?? {}
    copy.runtime.args = applyVllmKnobsToArgs(copy.runtime.args ?? [], knobs.vllm)
  }
  return copy
}

export interface RenderedArtifacts {
  manifestYaml: string
  registerSql: string
  operatorSql: string
  smokeSql: string
  composeYaml: string
  composeHostPortsYaml: string
  composeGpuYaml: string
}

export function renderManifest(
  manifest: Manifest,
  knobs: InstallKnobs,
): RenderedArtifacts {
  if (isSqlTestManifest(manifest)) {
    return {
      manifestYaml: renderManifestYaml(manifest),
      registerSql: [
        "-- SQL test pack.",
        "-- No backend or runtime is registered; run the catalog acceptance SQL.",
        "",
      ].join("\n"),
      operatorSql: [
        "-- SQL test pack.",
        "-- This pack exercises already-seeded rvbbit SQL/workflow operators.",
        "",
      ].join("\n"),
      smokeSql: [
        "-- SQL test pack smoke placeholder.",
        "-- Use the catalog acceptance tests for executable checks.",
        "",
      ].join("\n"),
      composeYaml: `# ${manifest.name} is SQL-only; no Docker sidecar is generated.\n`,
      composeHostPortsYaml: `# ${manifest.name} is SQL-only; no host port overlay applies.\n`,
      composeGpuYaml: `# ${manifest.name} is SQL-only; no GPU overlay applies.\n`,
    }
  }
  const m = applyKnobs(manifest, knobs)
  const runtime = isRuntimeManifest(m)
  return {
    manifestYaml: renderManifestYaml(m),
    registerSql: runtime ? renderRegisterRuntimeSql(m) : renderRegisterSql(m),
    operatorSql:
      (m.operators?.length ?? 0) > 0
        ? renderOperatorSql(m)
        : runtime
          ? `-- ${m.name} is an execution runtime; it declares no SQL operator wrappers.\n-- Use it from an operator workflow node such as \`kind: ${m.runtime_registration?.language ?? m.runtime?.language ?? "python"}\`.\n`
          : renderOperatorSql(m),
    smokeSql: renderSmokeSql(m),
    composeYaml: renderCompose(m, knobs),
    composeHostPortsYaml: renderHostPortsCompose(m, knobs),
    composeGpuYaml: renderGpuCompose(m),
  }
}

// ── TS port of capabilities/tools/rvbbit-capability render_* ─────────

function sqlLitOrNull(v: unknown): string {
  if (v == null) return "NULL"
  return sqlLit(String(v))
}

function sqlJson(v: unknown): string {
  // stable-key JSON keeps diffs noise-free as the user edits knobs.
  return sqlLit(stableJsonStringify(v)) + "::jsonb"
}

function stableJsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) out[k] = obj[k]
      return out
    }
    return value
  })
}

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(sqlLit).join(",")}]`
}

function backendEndpoint(m: Manifest): string {
  if (m.backend?.endpoint) return m.backend.endpoint
  const service = m.name.replace(/_/g, "-")
  return `http://${service}:${runtimeContainerPort(m)}/predict`
}

function pickInstallManifest(m: Manifest): Record<string, unknown> {
  const keep = [
    "api_version",
    "kind",
    "name",
    "title",
    "description",
    "license",
    "tags",
    "source",
    "runtime",
    "runtime_registration",
    "backend",
    "operators",
    "warren",
    "system_runtime",
    "capability_role",
  ]
  const out: Record<string, unknown> = {}
  for (const k of keep) {
    if (k in m) out[k] = (m as Record<string, unknown>)[k]
  }
  return out
}

function runtimeContainerPort(m: Manifest): number {
  return Number(m.warren?.container_port ?? m.runtime?.port ?? 8080)
}

function runtimeEndpointPath(m: Manifest): string {
  const raw = m.warren?.endpoint_path ?? m.runtime_registration?.endpoint_path ?? "/run"
  const path = String(raw || "/")
  return path.startsWith("/") ? path : `/${path}`
}

function runtimeHealthPath(m: Manifest): string {
  const raw = m.warren?.health_path ?? m.runtime?.health_path ?? "/health"
  const path = String(raw || "/health")
  return path.startsWith("/") ? path : `/${path}`
}

/**
 * Runtime-sidecar register SQL — mirrors `render_register_sql`'s
 * `runtime_sidecar` branch in capabilities/tools/rvbbit-capability.
 */
function renderRegisterRuntimeSql(m: Manifest): string {
  const reg = m.runtime_registration ?? { name: m.name }
  const runtime = m.runtime ?? {}
  const language = reg.language ?? runtime.language ?? "python"
  const endpointPath = runtimeEndpointPath(m)
  const service = m.name.replace(/_/g, "-")
  const containerHost = `rvbbit-${service.replace(/^-+|-+$/g, "")}`
  const endpoint = reg.endpoint ?? `http://${containerHost}:${runtimeContainerPort(m)}${endpointPath}`
  const labels = reg.labels ?? {
    language,
    capability_kind: "runtime_sidecar",
  }
  const isMcp = language === "mcp" || language === "mcp_gateway"
  const isMemory = language === "memory" || language === "hindsight" || language === "http_service"
  const registerFn = isMcp
    ? "rvbbit.register_mcp_gateway"
    : isMemory
      ? "rvbbit.register_memory_service"
      : "rvbbit.register_python_runtime"
  const nameArg = isMcp ? "gateway_name" : isMemory ? "service_name" : "runtime_name"
  const statusArg = isMcp ? "gateway_status" : isMemory ? "service_status" : "runtime_status"
  const labelsArg = isMcp ? "gateway_labels" : isMemory ? "service_labels" : "runtime_labels"
  const sourceArg = isMcp ? "gateway_source" : isMemory ? "service_source" : "runtime_source"
  const providerArgs = isMemory
    ? [
        `  service_provider => ${sqlLit(reg.provider ?? m.warren?.service_provider ?? "hindsight")},`,
        `  auth_header_env   => ${sqlLitOrNull(reg.auth_env ?? m.warren?.auth_env)},`,
      ]
    : []
  return [
    "-- Generated by rvbbit-lens capabilities renderer (TS port).",
    `-- Runtime capability: ${m.name}`,
    `SELECT ${registerFn}(`,
    `  ${nameArg}     => ${sqlLit(reg.name)},`,
    `  endpoint_url     => ${sqlLit(endpoint)},`,
    ...providerArgs,
    `  ${statusArg}  => 'ready',`,
    `  ${labelsArg}  => ${sqlJson(labels)},`,
    `  ${sourceArg}  => 'capability',`,
    `  install_manifest => ${sqlJson(pickInstallManifest(m))},`,
    `  set_default     => ${reg.set_default === false ? "false" : "true"}`,
    ");",
    "",
  ].join("\n")
}

function renderRegisterSql(m: Manifest): string {
  const backend = m.backend
  if (!backend) return renderRegisterRuntimeSql(m)
  const source = m.source ?? {}
  const opts: Record<string, unknown> = { ...(backend.opts ?? {}) }
  if (source.model && !("model" in opts)) opts.model = source.model
  if (source.revision && !("revision" in opts)) opts.revision = source.revision

  const description =
    backend.description ?? m.description ?? m.title ?? m.name

  return [
    "-- Generated by rvbbit-lens capabilities renderer (TS port).",
    `-- Capability: ${m.name}`,
    "SELECT rvbbit.register_backend(",
    `  backend_name             => ${sqlLit(backend.name)},`,
    `  backend_endpoint         => ${sqlLit(backendEndpoint(m))},`,
    `  backend_transport        => ${sqlLit(backend.transport ?? "rvbbit")},`,
    `  backend_batch_size       => ${backend.batch_size ?? 32},`,
    `  backend_max_concur       => ${backend.max_concurrent ?? 4},`,
    `  backend_timeout_ms       => ${backend.timeout_ms ?? 60000},`,
    `  backend_auth_env         => ${sqlLitOrNull(backend.auth_env)},`,
    `  backend_opts             => ${sqlJson(opts)},`,
    `  backend_description      => ${sqlLitOrNull(description)},`,
    `  backend_source_provider  => ${sqlLitOrNull(source.provider)},`,
    `  backend_source_model     => ${sqlLitOrNull(source.model)},`,
    `  backend_source_revision  => ${sqlLitOrNull(source.revision)},`,
    `  backend_install_manifest => ${sqlJson(pickInstallManifest(m))}`,
    ");",
    "SELECT rvbbit.reload_backends();",
    "",
  ].join("\n")
}

function defaultStep(m: Manifest, op: OperatorDef): unknown {
  return {
    name: op.step_name ?? m.backend?.name ?? m.name,
    kind: "specialist",
    specialist: m.backend?.name ?? m.name,
    inputs:
      op.inputs ??
      Object.fromEntries(op.arg_names.map((name) => [name, `{{ inputs.${name} }}`])),
  }
}

function renderOperatorSql(m: Manifest): string {
  const chunks: string[] = [
    "-- Generated by rvbbit-lens capabilities renderer (TS port).",
    `-- Operators for capability: ${m.name}`,
  ]
  for (const op of m.operators ?? []) {
    const steps = op.steps ?? [defaultStep(m, op)]
    const argTypes = op.arg_types ?? op.arg_names.map(() => "text")
    chunks.push(
      "",
      "SELECT rvbbit.create_operator(",
      `  op_name        => ${sqlLit(op.name)},`,
      `  op_arg_names   => ${sqlTextArray(op.arg_names)},`,
      `  op_arg_types   => ${sqlTextArray(argTypes)},`,
      `  op_return_type => ${sqlLit(op.return_type)},`,
      `  op_parser      => ${sqlLitOrNull(op.parser)},`,
      `  op_shape       => ${sqlLit(op.shape ?? "scalar")},`,
      `  op_description => ${sqlLitOrNull(op.description ?? m.description ?? null)},`,
      `  op_tests       => ${op.tests ? sqlJson(op.tests) : "NULL"},`,
      `  op_infix_symbol => ${sqlLitOrNull(op.infix_symbol)},`,
      `  op_infix_word   => ${sqlLitOrNull(op.infix_word)},`,
      `  op_steps       => ${sqlJson(steps)}`,
      ");",
    )
    if (op.cache_policy) {
      chunks.push(
        "UPDATE rvbbit.operators",
        `SET cache_policy = ${sqlLit(op.cache_policy)}`,
        `WHERE name = ${sqlLit(op.name)};`,
      )
    }
  }
  chunks.push("")
  return chunks.join("\n")
}

function renderSmokeSql(m: Manifest): string {
  const smoke = m.smoke ?? {}
  // Runtime sidecars have no /predict backend to probe; their smoke is the
  // manifest's own SQL (typically a runtime catalog status check).
  if (isRuntimeManifest(m) || !m.backend) {
    const lines = ["-- Generated runtime smoke check."]
    for (const s of smoke.sql ?? []) lines.push(s)
    if ((smoke.sql ?? []).length === 0 && m.runtime_registration?.name) {
      const language = m.runtime_registration.language ?? m.runtime?.language
      const table =
        language === "mcp" || language === "mcp_gateway"
          ? "rvbbit.mcp_gateways"
          : language === "memory" || language === "hindsight" || language === "http_service"
            ? "rvbbit.memory_services"
            : "rvbbit.python_runtimes"
      lines.push(`SELECT name, endpoint_url, status FROM ${table} WHERE name = ${sqlLit(m.runtime_registration.name)};`)
    }
    lines.push("")
    return lines.join("\n")
  }
  const lines = [
    "-- Generated smoke checks. Run after register.sql/operator.sql.",
    `SELECT jsonb_pretty(rvbbit.backend_probe(${sqlLit(m.backend.name)}));`,
  ]
  for (const s of smoke.sql ?? []) lines.push(s)
  const operators = m.operators ?? []
  if (operators.length > 0 && smoke.inputs && smoke.inputs.length > 0) {
    const first = smoke.inputs[0]
    for (const op of operators) {
      const args = op.arg_names.map((n) => first[n] ?? "")
      const argSql = args.map((v) => sqlLit(String(v))).join(", ")
      lines.push(`SELECT rvbbit.${op.name}(${argSql});`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

function renderCompose(m: Manifest, knobs: InstallKnobs): string {
  if (isExternalBackendManifest(m)) {
    return `# ${m.name} is an external/API-backed capability.
# No Docker sidecar is generated; register.sql installs the backend endpoint directly.
`
  }
  const service = m.name.replace(/_/g, "-")
  const source = m.source ?? {}
  const runtime = m.runtime ?? {}
  const containerPort = runtimeContainerPort(m)
  const healthPath = runtimeHealthPath(m)
  const env: Record<string, string> = { ...(runtime.env ?? {}) }
  if (!("RVBBIT_CAPABILITY_MODEL" in env))
    env.RVBBIT_CAPABILITY_MODEL = source.model ?? ""
  if (!("RVBBIT_CAPABILITY_REVISION" in env))
    env.RVBBIT_CAPABILITY_REVISION = source.revision ?? ""
  if (!("RVBBIT_CAPABILITY_HANDLER" in env))
    env.RVBBIT_CAPABILITY_HANDLER = runtime.handler ?? "custom"
  if (!("RVBBIT_CAPABILITY_DEVICE" in env))
    env.RVBBIT_CAPABILITY_DEVICE = knobs.device ?? runtime.device ?? "auto"
  const envLines = Object.keys(env)
    .sort()
    .map((k) => `      ${k}: ${JSON.stringify(env[k])}`)
    .join("\n")
  const volumeSpecs = runtime.volumes ?? [{ name: "hf_cache", mount: "/root/.cache/huggingface" }]
  const volumeMounts = volumeSpecs
    .filter((spec) => spec.name && spec.mount)
    .map((spec) => `      - ${spec.name}:${spec.mount}`)
    .join("\n")
  const volumeDefs = volumeSpecs
    .filter((spec) => spec.name && spec.mount)
    .map((spec) => `  ${spec.name}:`)
    .join("\n")
  const sourceLines = renderRuntimeSource(runtime)
  const commandBlock = renderCommandBlock(runtime.args)
  const ipcLine = runtime.ipc ? `    ipc: ${JSON.stringify(runtime.ipc)}\n` : ""
  return `services:
  ${service}:
${sourceLines}    container_name: rvbbit-${service}
${ipcLine}    expose:
      - "${containerPort}"
${commandBlock}    environment:
${envLines}
    volumes:
${volumeMounts}
    networks:
      - rvbbit
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:${containerPort}${healthPath}').read()"]
      interval: 10s
      timeout: 5s
      retries: 60

networks:
  rvbbit:
    name: \${RVBBIT_DOCKER_NETWORK:-${knobs.dockerNetwork}}
    external: true

volumes:
${volumeDefs}
`
}

/**
 * Render a compose `command:` list from runtime args. Empty string when
 * there are none, so non-image packs (build:.) are unaffected. Without
 * this the lens-stamped compose.yaml would clobber the CLI-rendered
 * command and leave vLLM with no `--model`.
 */
function renderCommandBlock(args?: string[]): string {
  if (!args || args.length === 0) return ""
  const lines = args.map((a) => `      - ${JSON.stringify(String(a))}`).join("\n")
  return `    command:\n${lines}\n`
}

function runtimeImage(runtime: ManifestRuntimeBlock): string | null {
  const image = String(runtime.image ?? "").trim()
  if (!image) return null
  const digest = String(runtime.image_digest ?? "").trim()
  if (digest && !image.includes("@")) return `${image}@${digest}`
  return image
}

function renderRuntimeSource(runtime: ManifestRuntimeBlock): string {
  const image = runtimeImage(runtime)
  if (image) {
    const pullPolicy = runtime.pull_policy ?? "missing"
    return `    image: ${JSON.stringify(image)}\n    pull_policy: ${JSON.stringify(pullPolicy)}\n`
  }
  return "    build: .\n"
}

function renderHostPortsCompose(m: Manifest, knobs: InstallKnobs): string {
  if (isExternalBackendManifest(m)) {
    return `# ${m.name} is external/API-backed; no host port overlay applies.
`
  }
  const service = m.name.replace(/_/g, "-")
  const containerPort = runtimeContainerPort(m)
  const hostBind = String(m.runtime?.host_bind ?? "").trim()
  const hostPrefix = hostBind ? `${hostBind}:` : ""
  const hostPortEnv = String(m.runtime?.host_port_env ?? "RVBBIT_CAPABILITY_PORT").trim()
  const safeHostPortEnv = /^[A-Za-z_][A-Za-z0-9_]*$/.test(hostPortEnv)
    ? hostPortEnv
    : "RVBBIT_CAPABILITY_PORT"
  return `services:
  ${service}:
    container_name: rvbbit-${service}
    ports:
      - "${hostPrefix}\${${safeHostPortEnv}:-${knobs.hostPort}}:${containerPort}"
`
}

function renderGpuCompose(m: Manifest): string {
  if (isExternalBackendManifest(m)) {
    return `# ${m.name} is external/API-backed; no GPU overlay applies.
`
  }
  const service = m.name.replace(/_/g, "-")
  // Request the GPU via deploy.resources (honoured across all Docker Compose
  // versions); the newer top-level `gpus: all` is silently ignored by older
  // compose, leaving the container with no GPU ("0 active drivers / No CUDA
  // runtime") — vLLM then fails device inference. Pin NVIDIA_DRIVER_CAPABILITIES
  // so images that don't set it (e.g. vllm/vllm-openai) still get CUDA mounted.
  return `services:
  ${service}:
    environment:
      RVBBIT_CAPABILITY_DEVICE: "cuda"
      NVIDIA_VISIBLE_DEVICES: "all"
      NVIDIA_DRIVER_CAPABILITIES: "all"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
`
}

// Minimal hand-rolled YAML emit. The full js-yaml runs server-side; on
// the client we only need to serialise back to YAML for the preview pane,
// and the manifest shape is shallow enough that a few rules suffice.
function renderManifestYaml(m: Manifest): string {
  return emitYaml(pickInstallManifest(m), 0).trimEnd() + "\n"
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function quoteScalar(s: string): string {
  if (s === "") return '""'
  // Reserved-word and special-char guard. If the value contains
  // anything that would confuse YAML scalar parsing, quote it. The flow
  // indicators {}[], matter for template values like "{{ inputs.text }}",
  // which YAML would otherwise read as a flow mapping.
  if (/[:#&*!|>'"%@`{}[\],\n]/.test(s) || /^[?\-]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s)
  }
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s)
  if (/^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s)
  return s
}

function emitScalar(v: unknown): string {
  if (v == null) return "null"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null"
  return quoteScalar(String(v))
}

function emitYaml(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    return value
      .map((item) => {
        if (isPlainObject(item)) {
          const keys = Object.keys(item)
          if (keys.length === 0) return `${pad}- {}`
          const first = keys[0]
          const firstVal = item[first]
          const headRendered = isPlainObject(firstVal) || Array.isArray(firstVal)
            ? `${pad}- ${first}:\n${emitYaml(firstVal, indent + 2)}`
            : `${pad}- ${first}: ${emitScalar(firstVal)}`
          const rest = keys
            .slice(1)
            .map((k) => {
              const val = item[k]
              if (isPlainObject(val) || (Array.isArray(val) && val.length > 0)) {
                return `${pad}  ${k}:\n${emitYaml(val, indent + 2)}`
              }
              return `${pad}  ${k}: ${emitScalar(val)}`
            })
            .join("\n")
          return rest ? `${headRendered}\n${rest}` : headRendered
        }
        return `${pad}- ${emitScalar(item)}`
      })
      .join("\n")
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}{}`
    return keys
      .map((k) => {
        const v = value[k]
        if (isPlainObject(v)) {
          const inner = emitYaml(v, indent + 1)
          return Object.keys(v).length === 0
            ? `${pad}${k}: {}`
            : `${pad}${k}:\n${inner}`
        }
        if (Array.isArray(v)) {
          if (v.length === 0) return `${pad}${k}: []`
          // Inline short scalar arrays like [a, b, c]
          if (v.every((x) => x == null || typeof x !== "object")) {
            return `${pad}${k}: [${v.map((x) => emitScalar(x)).join(", ")}]`
          }
          return `${pad}${k}:\n${emitYaml(v, indent + 1)}`
        }
        return `${pad}${k}: ${emitScalar(v)}`
      })
      .join("\n")
  }
  return `${pad}${emitScalar(value)}`
}
