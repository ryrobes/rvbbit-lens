"use client"

/**
 * Client-side model for the rvbbit *capabilities* layer — the install /
 * provenance front-door over `rvbbit.backends`.
 *
 * A capability pack bundles a model + sidecar + SQL generators. The
 * catalog is a static JSON list of packs, the manifests are YAML files
 * with the full install knobs, and installed packs land in
 * `rvbbit.backends` with `source_*` + `install_manifest` set.
 *
 * Spec: /home/ryanr/repos2026/rvbbit/docs/CAPABILITIES.md
 *
 * What this module owns:
 * - Fetch catalog + individual manifest via the `/api/rvbbit/capabilities`
 *   route (which reads from disk on the server).
 * - Join the catalog to installed-backend rows from `rvbbit.backend_health`
 *   and derive the 7-state badge from the spec.
 * - Probe a registered backend (default and custom-input variants).
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
  kind: string
  source_provider: string | null
  source_model: string | null
  source_revision: string | null
  license: string | null
  backend_name: string
  backend_transport: string
  runtime_template: string
  runtime_handler: string
  device: string
  operators: string[]
  manifest_path: string
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
  template?: string
  handler?: string
  device?: string
  base_image?: string
  env?: Record<string, string>
  extra_requirements?: string[]
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
  backend: ManifestBackendBlock
  operators?: OperatorDef[]
  smoke?: ManifestSmokeBlock
  [k: string]: unknown
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
  | "external"

export interface InstallStateFlags {
  catalogOnly: boolean
  registered: boolean
  used: boolean
  errorSeen: boolean
  /** null = never probed in this session */
  healthy: boolean | null
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
  n_calls: number
  n_errors: number
  avg_latency_ms: number | null
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  first_call_at: number | null
  last_call_at: number | null
  created_at: number | null
}

export interface JoinedCatalogEntry {
  catalog: CatalogEntry
  installed: InstalledBackend | null
  flags: InstallStateFlags
}

export interface CatalogJoin {
  entries: JoinedCatalogEntry[]
  /** Installed backends with no matching catalog row — the `external` bucket. */
  external: InstalledBackend[]
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

function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}

function sqlLit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

// ── Catalog fetch (via API route) ───────────────────────────────────

export async function fetchCatalog(): Promise<{
  doc: CatalogDoc | null
  error?: string
}> {
  try {
    const res = await fetch("/api/rvbbit/capabilities?action=catalog")
    const body = (await res.json()) as { ok: boolean; doc?: CatalogDoc; error?: string }
    if (!body.ok) return { doc: null, error: body.error ?? "failed to load catalog" }
    return { doc: body.doc ?? null }
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

const BACKEND_HEALTH_SQL = `SELECT
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
  created_at
FROM rvbbit.backend_health
ORDER BY name`

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
    n_calls: num(r.n_calls),
    n_errors: num(r.n_errors),
    avg_latency_ms: r.avg_latency_ms == null ? null : num(r.avg_latency_ms),
    p50_latency_ms: r.p50_latency_ms == null ? null : num(r.p50_latency_ms),
    p95_latency_ms: r.p95_latency_ms == null ? null : num(r.p95_latency_ms),
    first_call_at: epoch(r.first_call_at),
    last_call_at: epoch(r.last_call_at),
    created_at: epoch(r.created_at),
  }
}

export async function fetchInstalledBackends(
  connectionId: string,
): Promise<{ backends: InstalledBackend[]; error?: string }> {
  const res = await runQuery(connectionId, BACKEND_HEALTH_SQL)
  if (!res.ok) return { backends: [], error: res.error }
  return { backends: res.rows.map(parseInstalled) }
}

// ── 7-state derivation ──────────────────────────────────────────────

/**
 * Build the catalog × installed join. `probes` is an optional per-name
 * map of last-probe results (so a window that has just probed a backend
 * can fold `healthy`/`failing` into the badges without a re-query).
 */
export function joinCatalogToInstalled(
  catalog: CatalogEntry[],
  installed: InstalledBackend[],
  probes?: Map<string, ProbeResult>,
): CatalogJoin {
  const byName = new Map(installed.map((b) => [b.name, b]))
  const catalogNames = new Set(catalog.map((c) => c.backend_name))

  const entries: JoinedCatalogEntry[] = catalog.map((c) => {
    const inst = byName.get(c.backend_name) ?? null
    const probe = probes?.get(c.backend_name)
    const flags: InstallStateFlags = {
      catalogOnly: inst == null,
      registered: inst != null,
      used: !!inst && inst.n_calls > 0,
      errorSeen: !!inst && inst.n_errors > 0,
      healthy: probe ? probe.ok : null,
      external: false,
    }
    return { catalog: c, installed: inst, flags }
  })

  const external = installed.filter((b) => !catalogNames.has(b.name))

  return { entries, external }
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
  if (flags.external) out.push("external")
  return out
}

// ── Probe ───────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean
  backend: string
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

// ── Install pipeline transport ──────────────────────────────────────

export interface ScaffoldRequest {
  manifestPath: string
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
  args: { outDir: string; gpu?: boolean },
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

// ── Knob editor + live render ───────────────────────────────────────

/**
 * The handful of knobs the install wizard exposes. Anything else is
 * inherited from the manifest. Editing a knob doesn't mutate the file —
 * it overrides values inside the render functions.
 */
export interface InstallKnobs {
  device: string
  batchSize: number
  maxConcurrent: number
  timeoutMs: number
  hostPort: number
  dockerNetwork: string
  outputDir: string
  gpu: boolean
}

export function defaultKnobs(manifest: Manifest): InstallKnobs {
  const backend = manifest.backend
  const runtime = manifest.runtime ?? {}
  return {
    device: runtime.device ?? "auto",
    batchSize: backend.batch_size ?? 32,
    maxConcurrent: backend.max_concurrent ?? 4,
    timeoutMs: backend.timeout_ms ?? 60000,
    hostPort: 8080,
    dockerNetwork: "docker_default",
    outputDir: `.rvbbit/capabilities/${manifest.name}`,
    gpu: false,
  }
}

/** Apply knobs onto a manifest copy. Pure — never mutates the input. */
function applyKnobs(manifest: Manifest, knobs: InstallKnobs): Manifest {
  const copy: Manifest = JSON.parse(JSON.stringify(manifest)) as Manifest
  copy.backend.batch_size = knobs.batchSize
  copy.backend.max_concurrent = knobs.maxConcurrent
  copy.backend.timeout_ms = knobs.timeoutMs
  copy.runtime = { ...(copy.runtime ?? {}), device: knobs.device }
  return copy
}

export interface RenderedArtifacts {
  manifestYaml: string
  registerSql: string
  operatorSql: string
  smokeSql: string
  composeYaml: string
  composeGpuYaml: string
}

export function renderManifest(
  manifest: Manifest,
  knobs: InstallKnobs,
): RenderedArtifacts {
  const m = applyKnobs(manifest, knobs)
  return {
    manifestYaml: renderManifestYaml(m),
    registerSql: renderRegisterSql(m),
    operatorSql: renderOperatorSql(m),
    smokeSql: renderSmokeSql(m),
    composeYaml: renderCompose(m, knobs),
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
  if (m.backend.endpoint) return m.backend.endpoint
  const service = m.name.replace(/_/g, "-")
  return `http://${service}:8080/predict`
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
    "backend",
    "operators",
  ]
  const out: Record<string, unknown> = {}
  for (const k of keep) {
    if (k in m) out[k] = (m as Record<string, unknown>)[k]
  }
  return out
}

function renderRegisterSql(m: Manifest): string {
  const backend = m.backend
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
    name: op.step_name ?? m.backend.name,
    kind: "specialist",
    specialist: m.backend.name,
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
      `  op_steps       => ${sqlJson(steps)}`,
      ");",
    )
  }
  chunks.push("")
  return chunks.join("\n")
}

function renderSmokeSql(m: Manifest): string {
  const lines = [
    "-- Generated smoke checks. Run after register.sql/operator.sql.",
    `SELECT jsonb_pretty(rvbbit.backend_probe(${sqlLit(m.backend.name)}));`,
  ]
  const smoke = m.smoke ?? {}
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
  const service = m.name.replace(/_/g, "-")
  const source = m.source ?? {}
  const runtime = m.runtime ?? {}
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
  return `services:
  ${service}:
    build: .
    container_name: rvbbit-${service}
    ports:
      - "\${RVBBIT_CAPABILITY_PORT:-${knobs.hostPort}}:8080"
    environment:
${envLines}
    volumes:
      - hf_cache:/root/.cache/huggingface
    networks:
      - rvbbit
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/health').read()"]
      interval: 10s
      timeout: 5s
      retries: 60

networks:
  rvbbit:
    name: \${RVBBIT_DOCKER_NETWORK:-${knobs.dockerNetwork}}
    external: true

volumes:
  hf_cache:
`
}

function renderGpuCompose(m: Manifest): string {
  const service = m.name.replace(/_/g, "-")
  return `services:
  ${service}:
    gpus: all
    environment:
      RVBBIT_CAPABILITY_DEVICE: "cuda"
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
  // anything that would confuse YAML scalar parsing, quote it.
  if (/[:#&*!|>'"%@`\n]/.test(s) || /^[?\-]/.test(s) || /^\s|\s$/.test(s)) {
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
