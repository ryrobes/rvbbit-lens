import { NextResponse } from "next/server"
import { spawn } from "child_process"
import { promises as fs, constants as fsConstants } from "fs"
import os from "os"
import path from "path"

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

  if (!cliExists) {
    if (!inlineScaffoldAllowed(body.overrides)) {
      const reason = composeNeedsSourceBuild(body.overrides)
        ? "this source-build pack needs Dockerfile/template files"
        : "no rendered scaffold artifacts were provided"
      return NextResponse.json(
        {
          ok: false,
          error:
            `rvbbit-capability CLI not found at ${cli}; ${reason}. ` +
            `Use Warren/catalog deploy for SQL-only deployment, install the CLI, or set ` +
            `RVBBIT_CAPABILITY_CLI / RVBBIT_REPO_PATH / RVBBIT_CAPABILITY_ROOT.`,
        },
        { status: 500 },
      )
    }
    const inline = await writeInlineScaffold(out.path, manifestAbs, body.overrides)
    if (!inline.ok) {
      return NextResponse.json(
        { ok: false, error: inline.error, overridesApplied: inline.overridesApplied },
        { status: 500 },
      )
    }
    result = inline
    overridesApplied = inline.overridesApplied
  } else {
    result = await runScaffoldCli(manifestAbs, out.path, !!body.force)
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
    const applied = await applyOverrides(out.path, body.overrides)
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
