import { NextResponse } from "next/server"
import { spawn, spawnSync } from "child_process"
import { promises as fs, constants as fsConstants } from "fs"
import os from "os"
import path from "path"
import yaml from "js-yaml"
import { getConnection } from "@/lib/db/registry"
import { getPool } from "@/lib/db/pool"
import type { ConnectionRecord } from "@/lib/db/types"

export const runtime = "nodejs"

const DEFAULT_CAPABILITY_ROOT = "/usr/share/rvbbit/capabilities"

/**
 * Run the `rvbbit-capability scaffold` CLI against a manifest when a pack
 * needs template files, then write the client's knob-rendered overrides on top
 * of the generated register.sql / operator.sql / compose.yaml /
 * rvbbit.backend.yaml. If the CLI is unavailable and the rendered artifacts are
 * already self-contained (prebuilt image / SQL-only), write them directly.
 *
 * Why the post-write step: the CLI re-renders from the on-disk manifest
 * and doesn't know about per-install knob edits (batch_size, port,
 * device, network). The desktop's Overview tab is the source of truth
 * for those, so we let the CLI do the boilerplate (Dockerfile, main.py,
 * requirements.txt, template fill-ins) and then stamp our knob-aware
 * SQL/YAML over the top so the files on disk match what the user
 * previewed.
 *
 * Body:
 *   {
 *     manifestPath: string,   // catalog manifest_path
 *     outDir: string,         // absolute or local-work-root-relative
 *     force?: boolean,
 *     overrides?: {           // optional per-file overwrites
 *       "register.sql"?: string,
 *       "operator.sql"?: string,
 *       "smoke.sql"?: string,
 *       "compose.yaml"?: string,
 *       "compose.host-ports.yaml"?: string,
 *       "compose.gpu.yaml"?: string,
 *       "rvbbit.backend.yaml"?: string,
 *     }
 *   }
 */

interface ScaffoldBody {
  /** Active Lens connection; used to provision DB-backed runtime sidecars. */
  connectionId?: string | null
  manifestPath?: string
  /** Inline manifest YAML — used when there's no pack file on disk. */
  manifestYaml?: string
  outDir?: string
  force?: boolean
  overrides?: Record<string, string>
}

interface ScaffoldedFile {
  name: string
  size: number
  isOverride: boolean
}

const ALLOWED_OVERRIDES = new Set([
  "register.sql",
  "operator.sql",
  "smoke.sql",
  "compose.yaml",
  "compose.host-ports.yaml",
  "compose.gpu.yaml",
  "rvbbit.backend.yaml",
])

function repoRoot(): string {
  return process.env.RVBBIT_REPO_PATH ?? ""
}

function capabilityRoot(): string {
  if (process.env.RVBBIT_CAPABILITY_ROOT) return process.env.RVBBIT_CAPABILITY_ROOT
  const root = repoRoot()
  return root ? path.join(/*turbopackIgnore: true*/ root, "capabilities") : DEFAULT_CAPABILITY_ROOT
}

function localWorkRoot(): string {
  return path.resolve(
    /*turbopackIgnore: true*/
    process.env.RVBBIT_LOCAL_WORK_ROOT?.trim() ||
      process.env.RVBBIT_LENS_HOME?.trim() ||
      os.homedir(),
  )
}

/** Constrain outDir to the writable local work root. */
function resolveOutDir(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: "outDir is required" }
  }
  const root = localWorkRoot()
  const resolved = path.isAbsolute(raw)
    ? path.resolve(/*turbopackIgnore: true*/ raw)
    : path.resolve(/*turbopackIgnore: true*/ root, raw)
  // Refuse traversal outside the local work root. In packaged Lens this is the
  // /data volume; in direct dev runs it falls back to the user home.
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return {
      ok: false,
      error: `outDir must live under local work root (${root}); got ${resolved}`,
    }
  }
  return { ok: true, path: resolved }
}

function locateCli(): string {
  const explicit = process.env.RVBBIT_CAPABILITY_CLI
  if (explicit) return explicit
  const root = repoRoot()
  if (root) return path.join(/*turbopackIgnore: true*/ root, "capabilities", "tools", "rvbbit-capability")
  const caps = capabilityRoot()
  if (caps) return path.join(/*turbopackIgnore: true*/ caps, "tools", "rvbbit-capability")
  return "rvbbit-capability"
}

function resolveManifestPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw
  const caps = capabilityRoot()
  const stripped = raw.replace(/^capabilities\//, "").replace(/^\/+/, "")
  return path.resolve(/*turbopackIgnore: true*/ caps, stripped)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(/*turbopackIgnore: true*/ p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runScaffoldCli(
  manifestAbs: string,
  outAbs: string,
  force: boolean,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cli = locateCli()
  return new Promise((resolve) => {
    const args = ["scaffold", manifestAbs, outAbs]
    if (force) args.push("--force")
    const child = spawn(/*turbopackIgnore: true*/ cli, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr }),
    )
    child.on("error", (err) =>
      resolve({ ok: false, stdout, stderr: stderr + String(err) }),
    )
  })
}

function composeNeedsSourceBuild(overrides?: Record<string, string>): boolean {
  const compose = overrides?.["compose.yaml"] ?? ""
  return /^(\s*)build\s*:/m.test(compose)
}

function inlineScaffoldAllowed(overrides?: Record<string, string>): boolean {
  if (!overrides || Object.keys(overrides).length === 0) return false
  return !composeNeedsSourceBuild(overrides)
}

function manifestRuntimeTemplate(manifest: Record<string, unknown>): string | null {
  const runtime = asRecord(manifest.runtime)
  return stringValue(runtime?.template)
}

function resolveTemplateDir(template: string): string {
  return path.resolve(/*turbopackIgnore: true*/ capabilityRoot(), "templates", template)
}

async function applyOverrides(
  outAbs: string,
  overrides?: Record<string, string>,
): Promise<
  | { ok: true; overridesApplied: string[] }
  | { ok: false; error: string; overridesApplied: string[] }
> {
  const overridesApplied: string[] = []
  if (!overrides) return { ok: true, overridesApplied }

  for (const [name, content] of Object.entries(overrides)) {
    if (!ALLOWED_OVERRIDES.has(name)) continue
    if (typeof content !== "string") continue
    const target = path.join(/*turbopackIgnore: true*/ outAbs, name)
    try {
      await fs.writeFile(/*turbopackIgnore: true*/ target, content, "utf8")
      overridesApplied.push(name)
    } catch (e) {
      return {
        ok: false,
        error: `failed to write override ${name}: ${e instanceof Error ? e.message : String(e)}`,
        overridesApplied,
      }
    }
  }
  return { ok: true, overridesApplied }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function isIdentifierLike(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function pgIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function dsnWithDatabase(dsn: string, database: string): string {
  try {
    const url = new URL(dsn)
    url.pathname = `/${database}`
    return url.toString()
  } catch {
    const [base, query] = dsn.split("?", 2)
    const schemeIdx = base.indexOf("://")
    if (schemeIdx < 0) return dsn
    const afterScheme = schemeIdx + 3
    const slash = base.lastIndexOf("/")
    const nextBase = slash >= afterScheme ? `${base.slice(0, slash)}/${database}` : `${base}/${database}`
    return query ? `${nextBase}?${query}` : nextBase
  }
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function dockerCommand(args: string[]): { command: string; args: string[] } {
  const docker = process.env.RVBBIT_DOCKER_BIN?.trim() || "docker"
  if (!envFlag("RVBBIT_DOCKER_SUDO")) return { command: docker, args }
  return { command: "sudo", args: ["-n", docker, ...args] }
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0"
}

function resolveComposeVariable(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/)
  if (!match) return trimmed
  return process.env[match[1]]?.trim() || match[2]?.trim() || ""
}

function composeNetworkName(compose?: string): string | null {
  if (!compose) return process.env.RVBBIT_DOCKER_NETWORK?.trim() || null
  const doc = asRecord(yaml.load(compose))
  const networks = asRecord(doc?.networks)
  const rvbbit = asRecord(networks?.rvbbit)
  const rawName = stringValue(rvbbit?.name)
  const resolved = rawName ? resolveComposeVariable(rawName) : ""
  return resolved || process.env.RVBBIT_DOCKER_NETWORK?.trim() || null
}

function dockerPublishedPortTarget(
  network: string | null,
  hostPort: number,
): { host: string; port: number } | null {
  if (!network || !Number.isFinite(hostPort) || hostPort <= 0) return null
  const docker = dockerCommand([
    "ps",
    "--filter",
    `network=${network}`,
    "--format",
    "{{.Names}}\t{{.Ports}}",
  ])
  const result = spawnSync(/*turbopackIgnore: true*/ docker.command, docker.args, {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.status !== 0) return null
  for (const line of result.stdout.split(/\r?\n/)) {
    const [name, ports = ""] = line.split("\t")
    if (!name || !ports) continue
    const portRe = /(?:(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):)?(\d+)->(\d+)\/tcp/g
    let match: RegExpExecArray | null
    while ((match = portRe.exec(ports)) !== null) {
      if (Number(match[1]) === hostPort) {
        return { host: name.trim(), port: Number(match[2]) }
      }
    }
  }
  return null
}

function envRuntimeDsn(database: string): string | null {
  const raw =
    process.env.RVBBIT_CAPABILITY_RUNTIME_DSN?.trim() ||
    process.env.WARREN_RUNTIME_DSN?.trim() ||
    process.env.RVBBIT_DSN?.trim() ||
    ""
  return raw ? dsnWithDatabase(raw, database) : null
}

function encodeDsnPart(value: string): string {
  return encodeURIComponent(value)
}

function connectionStringRuntimeDsn(
  dsn: string,
  database: string,
  network: string | null,
): string {
  try {
    const url = new URL(dsn)
    url.pathname = `/${database}`
    if (isLoopbackHost(url.hostname)) {
      const mapped = dockerPublishedPortTarget(network, Number(url.port || 5432))
      if (mapped) {
        url.hostname = mapped.host
        url.port = String(mapped.port)
      }
    }
    return url.toString()
  } catch {
    return dsnWithDatabase(dsn, database)
  }
}

function connectionRuntimeDsn(
  record: ConnectionRecord,
  database: string,
  network: string | null,
): string {
  if (record.connectionString?.trim()) {
    return connectionStringRuntimeDsn(record.connectionString.trim(), database, network)
  }
  let host = process.env.RVBBIT_CAPABILITY_DB_HOST?.trim() || record.host || "localhost"
  let port = process.env.RVBBIT_CAPABILITY_DB_PORT?.trim() || String(record.port || 5432)
  if (!process.env.RVBBIT_CAPABILITY_DB_HOST?.trim() && isLoopbackHost(host)) {
    const mapped = dockerPublishedPortTarget(network, Number(port))
    if (mapped) {
      host = mapped.host
      port = String(mapped.port)
    }
  }
  const user = encodeDsnPart(record.user || "postgres")
  const password = record.password == null ? "" : `:${encodeDsnPart(record.password)}`
  return `postgresql://${user}${password}@${host}:${port}/${encodeDsnPart(database)}`
}

interface PostgresProvisionSpec {
  mode: "schema"
  schema: string
  create: boolean
  extensions: string[]
  urlEnv: string
  schemaEnv: string
  url?: string
}

function postgresProvisionSpec(manifest: Record<string, unknown>): PostgresProvisionSpec | null {
  const warren = asRecord(manifest.warren)
  const pg = asRecord(warren?.postgres_database)
  if (!pg) return null
  const mode = stringValue(pg.mode) ?? stringValue(pg.scope) ?? "database"
  if (mode !== "schema") return null
  const schema = stringValue(pg.schema) ?? "hindsight"
  const urlEnv = stringValue(pg.url_env) ?? "HINDSIGHT_API_DATABASE_URL"
  const schemaEnv = stringValue(pg.schema_env) ?? "HINDSIGHT_API_DATABASE_SCHEMA"
  if (!isIdentifierLike(schema)) throw new Error("warren.postgres_database.schema must be identifier-like")
  if (!isIdentifierLike(urlEnv)) throw new Error("warren.postgres_database.url_env must be environment-variable-like")
  if (!isIdentifierLike(schemaEnv)) throw new Error("warren.postgres_database.schema_env must be environment-variable-like")
  return {
    mode: "schema",
    schema,
    create: boolValue(pg.create, true),
    extensions: stringArray(pg.extensions),
    urlEnv,
    schemaEnv,
    url: stringValue(pg.url) ?? undefined,
  }
}

async function readManifestObject(
  manifestAbs: string,
  overrides?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const text = overrides?.["rvbbit.backend.yaml"] ?? await fs.readFile(/*turbopackIgnore: true*/ manifestAbs, "utf8")
  const parsed = yaml.load(text)
  const obj = asRecord(parsed)
  if (!obj) throw new Error("capability manifest is not an object")
  return obj
}

function patchComposeEnv(compose: string, envs: Record<string, string>): string {
  const doc = asRecord(yaml.load(compose))
  const services = asRecord(doc?.services)
  if (!doc || !services) return compose
  const serviceName = Object.keys(services)[0]
  const service = serviceName ? asRecord(services[serviceName]) : null
  if (!service) return compose

  const currentEnv = service.environment
  if (Array.isArray(currentEnv)) {
    const next = new Map<string, string>()
    for (const entry of currentEnv) {
      if (typeof entry !== "string") continue
      const idx = entry.indexOf("=")
      if (idx >= 0) next.set(entry.slice(0, idx), entry.slice(idx + 1))
    }
    for (const [key, value] of Object.entries(envs)) next.set(key, value)
    service.environment = Array.from(next.entries()).map(([key, value]) => `${key}=${value}`)
  } else {
    const env = asRecord(currentEnv) ?? {}
    for (const [key, value] of Object.entries(envs)) env[key] = value
    service.environment = env
  }

  return yaml.dump(doc, { lineWidth: -1, noRefs: true, sortKeys: false })
}

async function prepareLocalPostgresRuntime(
  manifestAbs: string,
  connectionId: string | null | undefined,
  overrides?: Record<string, string>,
): Promise<{ overrides?: Record<string, string>; stdout: string }> {
  const manifest = await readManifestObject(manifestAbs, overrides)
  const spec = postgresProvisionSpec(manifest)
  if (!spec) return { overrides, stdout: "" }
  if (!connectionId) {
    throw new Error("this capability provisions Postgres storage; active connectionId is required")
  }

  const [{ pool }, record] = await Promise.all([
    getPool(connectionId, undefined, "meta"),
    getConnection(connectionId),
  ])
  if (!record) throw new Error(`Unknown connection: ${connectionId}`)

  let database = ""
  const client = await pool.connect()
  try {
    const dbResult = await client.query<{ database: string }>("SELECT current_database() AS database")
    database = dbResult.rows[0]?.database ?? record.database
    if (spec.create) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${pgIdent(spec.schema)}`)
    }
    for (const ext of spec.extensions) {
      if (!isIdentifierLike(ext)) {
        throw new Error("warren.postgres_database.extensions entries must be identifier-like")
      }
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${pgIdent(ext)}`)
    }
  } finally {
    client.release()
  }

  const network = composeNetworkName(overrides?.["compose.yaml"])
  const databaseUrl = spec.url ?? envRuntimeDsn(database) ?? connectionRuntimeDsn(record, database, network)
  const envs: Record<string, string> = {
    [spec.urlEnv]: databaseUrl,
    [spec.schemaEnv]: spec.schema,
  }
  const nextOverrides = { ...(overrides ?? {}) }
  if (nextOverrides["compose.yaml"]) {
    nextOverrides["compose.yaml"] = patchComposeEnv(nextOverrides["compose.yaml"], envs)
  }
  return {
    overrides: nextOverrides,
    stdout:
      `prepared Postgres schema ${database}.${spec.schema} for local runtime; ` +
      `injected ${spec.urlEnv} and ${spec.schemaEnv}\n`,
  }
}

async function writeInlineScaffold(
  outAbs: string,
  manifestAbs: string,
  overrides?: Record<string, string>,
): Promise<
  | { ok: true; overridesApplied: string[]; stdout: string; stderr: string }
  | { ok: false; error: string; overridesApplied: string[] }
> {
  await fs.mkdir(/*turbopackIgnore: true*/ outAbs, { recursive: true })
  try {
    await fs.copyFile(
      /*turbopackIgnore: true*/ manifestAbs,
      /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ outAbs, "capability.yaml"),
    )
  } catch {
    /* best-effort: rvbbit.backend.yaml is written from overrides below */
  }

  const applied = await applyOverrides(outAbs, overrides)
  if (!applied.ok) return applied

  const readme = [
    "# Rvbbit capability install bundle",
    "",
    "Generated from Lens without the rvbbit-capability CLI because the rendered artifacts are self-contained.",
    "Source-build packs still require the CLI templates; image/API/SQL-only packs do not.",
    "",
    "## Run",
    "",
    "```bash",
    "docker compose up -d",
    "```",
    "",
    "## Register",
    "",
    "```bash",
    "psql \"$RVBBIT_DSN\" -f register.sql",
    "psql \"$RVBBIT_DSN\" -f operator.sql",
    "psql \"$RVBBIT_DSN\" -f smoke.sql",
    "```",
    "",
  ].join("\n")
  await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ outAbs, "README.md"), readme, "utf8")

  return {
    ok: true,
    overridesApplied: applied.overridesApplied,
    stdout: "wrote inline scaffold from rendered artifacts\n",
    stderr: "",
  }
}

async function writeTemplateScaffold(
  outAbs: string,
  manifestAbs: string,
  manifest: Record<string, unknown>,
  force: boolean,
  overrides?: Record<string, string>,
): Promise<
  | { ok: true; overridesApplied: string[]; stdout: string; stderr: string }
  | { ok: false; error: string; overridesApplied: string[] }
> {
  const template = manifestRuntimeTemplate(manifest)
  if (!template) {
    return {
      ok: false,
      error: "source-build manifest does not declare runtime.template",
      overridesApplied: [],
    }
  }
  const templateDir = resolveTemplateDir(template)
  if (!(await fileExists(templateDir))) {
    return {
      ok: false,
      error: `runtime template not found at ${templateDir}`,
      overridesApplied: [],
    }
  }

  await fs.mkdir(/*turbopackIgnore: true*/ outAbs, { recursive: true })
  await fs.cp(/*turbopackIgnore: true*/ templateDir, /*turbopackIgnore: true*/ outAbs, {
    recursive: true,
    force,
    errorOnExist: !force,
  })
  await fs.copyFile(
    /*turbopackIgnore: true*/ manifestAbs,
    /*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ outAbs, "capability.yaml"),
  )

  const applied = await applyOverrides(outAbs, overrides)
  if (!applied.ok) return applied

  const readme = [
    "# Rvbbit capability install bundle",
    "",
    `Generated from Lens by copying packaged runtime template \`${template}\`.`,
    "No rvbbit-capability CLI was required.",
    "",
    "## Run",
    "",
    "```bash",
    "docker compose up -d --build",
    "```",
    "",
    "## Register",
    "",
    "```bash",
    "psql \"$RVBBIT_DSN\" -f register.sql",
    "psql \"$RVBBIT_DSN\" -f operator.sql",
    "psql \"$RVBBIT_DSN\" -f smoke.sql",
    "```",
    "",
  ].join("\n")
  await fs.writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ outAbs, "README.md"), readme, "utf8")

  return {
    ok: true,
    overridesApplied: applied.overridesApplied,
    stdout: `copied packaged runtime template ${template}; wrote rendered scaffold artifacts\n`,
    stderr: "",
  }
}

async function listScaffoldFiles(outAbs: string, overridesApplied: string[]): Promise<ScaffoldedFile[]> {
  let files: ScaffoldedFile[] = []
  try {
    const entries = await fs.readdir(/*turbopackIgnore: true*/ outAbs)
    files = await Promise.all(
      entries.map(async (name) => {
        const stat = await fs.stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ outAbs, name))
        return {
          name,
          size: stat.size,
          isOverride: overridesApplied.includes(name),
        }
      }),
    )
    files.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    /* best-effort listing */
  }
  return files
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ScaffoldBody | null
  if (!body?.outDir || (!body?.manifestPath && !body?.manifestYaml)) {
    return NextResponse.json(
      { ok: false, error: "outDir and one of manifestPath/manifestYaml required" },
      { status: 400 },
    )
  }
  const out = resolveOutDir(body.outDir)
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: 400 })

  // Resolve the source manifest the CLI scaffolds from. For inline YAML
  // (from-id deploys with no pack on disk) we drop it in a temp file so
  // the CLI can render the template against it exactly like a real pack.
  let manifestAbs: string
  if (body.manifestYaml && body.manifestYaml.trim().length > 0) {
    try {
      const dir = await fs.mkdtemp(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ os.tmpdir(), "rvbbit-hf-"))
      manifestAbs = path.join(/*turbopackIgnore: true*/ dir, "capability.yaml")
      await fs.writeFile(/*turbopackIgnore: true*/ manifestAbs, body.manifestYaml, "utf8")
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `failed to stage inline manifest: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      )
    }
  } else if (body.manifestPath) {
    manifestAbs = resolveManifestPath(body.manifestPath)
    if (!(await fileExists(manifestAbs))) {
      return NextResponse.json(
        { ok: false, error: `manifest not found at ${manifestAbs}` },
        { status: 404 },
      )
    }
  } else {
    return NextResponse.json(
      { ok: false, error: "manifestPath or manifestYaml required" },
      { status: 400 },
    )
  }

  const cli = locateCli()
  const cliExists = await fileExists(cli)
  let result: { ok: boolean; stdout: string; stderr: string }
  let overridesApplied: string[] = []
  let overrides = body.overrides
  let prepareStdout = ""

  try {
    const prepared = await prepareLocalPostgresRuntime(manifestAbs, body.connectionId, overrides)
    overrides = prepared.overrides
    prepareStdout = prepared.stdout
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `failed to prepare local Postgres runtime: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    )
  }

  if (!cliExists) {
    if (!inlineScaffoldAllowed(overrides)) {
      if (composeNeedsSourceBuild(overrides)) {
        const manifestObj = await readManifestObject(manifestAbs, overrides)
        const templated = await writeTemplateScaffold(out.path, manifestAbs, manifestObj, !!body.force, overrides)
        if (templated.ok) {
          result = { ...templated, stdout: prepareStdout + templated.stdout }
          overridesApplied = templated.overridesApplied
        } else {
          return NextResponse.json(
            {
              ok: false,
              error:
                `rvbbit-capability CLI not found at ${cli}; ${templated.error}. ` +
                `Use Warren/catalog deploy for SQL-backed deployment, install the CLI, or set ` +
                `RVBBIT_CAPABILITY_CLI / RVBBIT_REPO_PATH / RVBBIT_CAPABILITY_ROOT.`,
              overridesApplied: templated.overridesApplied,
            },
            { status: 500 },
          )
        }
      } else {
        return NextResponse.json(
          {
            ok: false,
            error:
              `rvbbit-capability CLI not found at ${cli}; no rendered scaffold artifacts were provided. ` +
              `Use Warren/catalog deploy for SQL-backed deployment, install the CLI, or set ` +
              `RVBBIT_CAPABILITY_CLI / RVBBIT_REPO_PATH / RVBBIT_CAPABILITY_ROOT.`,
          },
          { status: 500 },
        )
      }
    } else {
      const inline = await writeInlineScaffold(out.path, manifestAbs, overrides)
      if (!inline.ok) {
        return NextResponse.json(
          { ok: false, error: inline.error, overridesApplied: inline.overridesApplied },
          { status: 500 },
        )
      }
      result = { ...inline, stdout: prepareStdout + inline.stdout }
      overridesApplied = inline.overridesApplied
    }
  } else {
    result = await runScaffoldCli(manifestAbs, out.path, !!body.force)
    result.stdout = prepareStdout + result.stdout
  }

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "scaffold failed", stdout: result.stdout, stderr: result.stderr },
      { status: 500 },
    )
  }

  // Stamp client-rendered overrides over the CLI output. Each override
  // must be a name from the allowlist — no path traversal possible since
  // we never honor anything but a flat basename.
  if (cliExists) {
    const applied = await applyOverrides(out.path, overrides)
    if (!applied.ok) {
      return NextResponse.json(
        { ok: false, error: applied.error, overridesApplied: applied.overridesApplied },
        { status: 500 },
      )
    }
    overridesApplied = applied.overridesApplied
  }

  // List the resulting directory so the UI can show what got written.
  const files = await listScaffoldFiles(out.path, overridesApplied)

  return NextResponse.json({
    ok: true,
    outDir: out.path,
    files,
    overridesApplied,
    stdout: result.stdout,
    stderr: result.stderr,
  })
}
