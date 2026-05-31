import { NextResponse } from "next/server"
import { spawn } from "child_process"
import { promises as fs, constants as fsConstants } from "fs"
import os from "os"
import path from "path"

export const runtime = "nodejs"

/**
 * Run the `rvbbit-capability scaffold` CLI against a manifest, then
 * write the client's knob-rendered overrides on top of the generated
 * register.sql / operator.sql / compose.yaml / rvbbit.backend.yaml.
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
 *     outDir: string,         // absolute or $HOME-relative
 *     force?: boolean,
 *     overrides?: {           // optional per-file overwrites
 *       "register.sql"?: string,
 *       "operator.sql"?: string,
 *       "smoke.sql"?: string,
 *       "compose.yaml"?: string,
 *       "compose.gpu.yaml"?: string,
 *       "rvbbit.backend.yaml"?: string,
 *     }
 *   }
 */

interface ScaffoldBody {
  manifestPath?: string
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
  "compose.gpu.yaml",
  "rvbbit.backend.yaml",
])

function repoRoot(): string {
  return (
    process.env.RVBBIT_REPO_PATH ??
    path.join(/*turbopackIgnore: true*/ os.homedir(), "repos2026", "rvbbit-sql")
  )
}

/** Constrain outDir to under $HOME (single-user trust model). */
function resolveOutDir(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: "outDir is required" }
  }
  const home = os.homedir()
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw)
  // Refuse traversal outside $HOME — a footgun rather than a security
  // boundary, given this is a local single-user app. Catches typos like
  // "/etc/rvbbit" that would otherwise silently land outside the user's
  // tree.
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return {
      ok: false,
      error: `outDir must live under $HOME (${home}); got ${resolved}`,
    }
  }
  return { ok: true, path: resolved }
}

function locateCli(): string {
  const explicit = process.env.RVBBIT_CAPABILITY_CLI
  if (explicit) return explicit
  return path.join(repoRoot(), "capabilities", "tools", "rvbbit-capability")
}

function resolveManifestPath(raw: string): string {
  if (path.isAbsolute(raw)) return raw
  // catalog entries store paths as "capabilities/manifests/..." relative to
  // the repo root. Resolve against RVBBIT_REPO_PATH for absolute disk reads.
  return path.resolve(repoRoot(), raw)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK)
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
    const child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] })
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

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ScaffoldBody | null
  if (!body?.manifestPath || !body?.outDir) {
    return NextResponse.json(
      { ok: false, error: "manifestPath and outDir required" },
      { status: 400 },
    )
  }
  const out = resolveOutDir(body.outDir)
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: 400 })

  const manifestAbs = resolveManifestPath(body.manifestPath)
  if (!(await fileExists(manifestAbs))) {
    return NextResponse.json(
      { ok: false, error: `manifest not found at ${manifestAbs}` },
      { status: 404 },
    )
  }

  const cli = locateCli()
  if (!(await fileExists(cli))) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `rvbbit-capability CLI not found at ${cli}. Set RVBBIT_REPO_PATH ` +
          `or RVBBIT_CAPABILITY_CLI to point at it.`,
      },
      { status: 500 },
    )
  }

  const result = await runScaffoldCli(manifestAbs, out.path, !!body.force)
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "scaffold failed", stdout: result.stdout, stderr: result.stderr },
      { status: 500 },
    )
  }

  // Stamp client-rendered overrides over the CLI output. Each override
  // must be a name from the allowlist — no path traversal possible since
  // we never honor anything but a flat basename.
  const overridesApplied: string[] = []
  if (body.overrides) {
    for (const [name, content] of Object.entries(body.overrides)) {
      if (!ALLOWED_OVERRIDES.has(name)) continue
      if (typeof content !== "string") continue
      const target = path.join(out.path, name)
      try {
        await fs.writeFile(target, content, "utf8")
        overridesApplied.push(name)
      } catch (e) {
        return NextResponse.json(
          {
            ok: false,
            error: `failed to write override ${name}: ${e instanceof Error ? e.message : String(e)}`,
            overridesApplied,
          },
          { status: 500 },
        )
      }
    }
  }

  // List the resulting directory so the UI can show what got written.
  let files: ScaffoldedFile[] = []
  try {
    const entries = await fs.readdir(out.path)
    files = await Promise.all(
      entries.map(async (name) => {
        const stat = await fs.stat(path.join(out.path, name))
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

  return NextResponse.json({
    ok: true,
    outDir: out.path,
    files,
    overridesApplied,
    stdout: result.stdout,
    stderr: result.stderr,
  })
}
