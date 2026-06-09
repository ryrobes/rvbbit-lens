import { NextResponse } from "next/server"
import { promises as fs } from "fs"
import path from "path"
import yaml from "js-yaml"

export const runtime = "nodejs"

const DEFAULT_CAPABILITY_ROOT = "/usr/share/rvbbit/capabilities"

/**
 * Read-only bridge to packaged capability files. Release images ship these
 * under $RVBBIT_CAPABILITY_ROOT; dev checkouts can point at the rvbbit-sql
 * repo with $RVBBIT_REPO_PATH.
 *
 * GET ?action=catalog
 *   → { ok: true, doc: <catalog.json shape> }
 *
 * GET ?action=manifest&path=capabilities/packs/extract/.../capability.yaml
 *   → { ok: true, manifest: <parsed YAML> }
 *
 * Manifest paths are constrained to the configured capabilities tree so this
 * route can't be coerced into reading arbitrary files.
 */

function capabilityRoot(): string {
  if (process.env.RVBBIT_CAPABILITY_ROOT) {
    return path.resolve(process.env.RVBBIT_CAPABILITY_ROOT)
  }
  if (process.env.RVBBIT_REPO_PATH) {
    return path.resolve(process.env.RVBBIT_REPO_PATH, "capabilities")
  }
  return DEFAULT_CAPABILITY_ROOT
}

async function readCatalog(): Promise<{ ok: true; doc: unknown } | { ok: false; status: number; error: string }> {
  const root = capabilityRoot()
  const file = path.join(root, "catalog.json")
  try {
    const text = await fs.readFile(file, "utf8")
    const doc = JSON.parse(text) as unknown
    return { ok: true, doc }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error:
          `catalog.json not found at ${file}. Set RVBBIT_CAPABILITY_ROOT, ` +
          `set RVBBIT_REPO_PATH to your rvbbit-sql checkout, or rebuild/package the capability catalog.`,
      }
    }
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) }
  }
}

async function readManifest(
  relPath: string,
): Promise<{ ok: true; manifest: unknown } | { ok: false; status: number; error: string }> {
  const capabilitiesRoot = capabilityRoot()

  // Accept the current pack shape (`capabilities/packs/.../capability.yaml`)
  // plus the older `capabilities/manifests/...` fallback. Either way, the
  // read is constrained to the capabilities tree.
  const stripped = relPath.replace(/^capabilities\//, "").replace(/^\/+/, "")
  const resolved = path.resolve(path.join(capabilitiesRoot, stripped))
  if (!resolved.startsWith(capabilitiesRoot + path.sep) && resolved !== capabilitiesRoot) {
    return { ok: false, status: 400, error: "manifest path escapes capabilities root" }
  }

  try {
    const text = await fs.readFile(resolved, "utf8")
    const parsed = yaml.load(text) as unknown
    if (parsed == null || typeof parsed !== "object") {
      return { ok: false, status: 400, error: `manifest at ${relPath} is not an object` }
    }
    return { ok: true, manifest: parsed }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { ok: false, status: 404, error: `manifest not found: ${relPath}` }
    }
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const action = url.searchParams.get("action")

  if (action === "catalog") {
    const r = await readCatalog()
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, doc: r.doc })
  }

  if (action === "manifest") {
    const p = url.searchParams.get("path")
    if (!p) {
      return NextResponse.json({ ok: false, error: "path query param required" }, { status: 400 })
    }
    const r = await readManifest(p)
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, manifest: r.manifest })
  }

  return NextResponse.json(
    { ok: false, error: "unknown action — try ?action=catalog or ?action=manifest&path=…" },
    { status: 400 },
  )
}
