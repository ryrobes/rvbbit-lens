import { spawn } from "child_process"
import { promises as fs, constants as fsConstants } from "fs"
import os from "os"
import path from "path"

export const runtime = "nodejs"

/**
 * Spawn `docker compose up -d --build` in the scaffolded outDir and
 * stream stdout/stderr back to the client as a text/event-stream.
 *
 * Frame shape (one per SSE event):
 *   data: {"type":"line","stream":"stdout","text":"..."}
 *   data: {"type":"line","stream":"stderr","text":"..."}
 *   data: {"type":"done","exitCode":0}
 *   data: {"type":"error","error":"..."}
 *
 * The client uses fetch with a body reader (modern SSE-over-POST
 * pattern) and an AbortController to cancel — when the request is
 * aborted we kill the docker compose child.
 *
 * outDir is validated to live under $HOME (single-user trust model);
 * compose.yaml must exist in that directory.
 */

interface ComposeBody {
  outDir?: string
  gpu?: boolean
}

function resolveOutDir(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: "outDir is required" }
  }
  const home = os.homedir()
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(home, raw)
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return {
      ok: false,
      error: `outDir must live under $HOME (${home}); got ${resolved}`,
    }
  }
  return { ok: true, path: resolved }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ComposeBody | null
  if (!body?.outDir) {
    return new Response(
      JSON.stringify({ ok: false, error: "outDir required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )
  }
  const out = resolveOutDir(body.outDir)
  if (!out.ok) {
    return new Response(JSON.stringify({ ok: false, error: out.error }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const composeFile = path.join(out.path, "compose.yaml")
  if (!(await fileExists(composeFile))) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `compose.yaml not found in ${out.path}. Run scaffold first.`,
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  }
  const gpuFile = path.join(out.path, "compose.gpu.yaml")
  const useGpu = !!body.gpu && (await fileExists(gpuFile))

  const args = ["compose", "-f", "compose.yaml"]
  if (useGpu) args.push("-f", "compose.gpu.yaml")
  args.push("up", "-d", "--build")

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawn("docker", args, {
        cwd: out.path,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let lineBufStdout = ""
      let lineBufStderr = ""

      const emitLines = (chunk: string, which: "stdout" | "stderr") => {
        const bufKey = which === "stdout" ? "stdout" : "stderr"
        const carryover = bufKey === "stdout" ? lineBufStdout : lineBufStderr
        const merged = carryover + chunk
        const lines = merged.split(/\r?\n/)
        const last = lines.pop() ?? ""
        if (bufKey === "stdout") lineBufStdout = last
        else lineBufStderr = last
        for (const text of lines) {
          if (text.length === 0) continue
          controller.enqueue(
            encoder.encode(sseFrame({ type: "line", stream: which, text })),
          )
        }
      }

      const flushTail = () => {
        if (lineBufStdout.length > 0) {
          controller.enqueue(
            encoder.encode(
              sseFrame({ type: "line", stream: "stdout", text: lineBufStdout }),
            ),
          )
          lineBufStdout = ""
        }
        if (lineBufStderr.length > 0) {
          controller.enqueue(
            encoder.encode(
              sseFrame({ type: "line", stream: "stderr", text: lineBufStderr }),
            ),
          )
          lineBufStderr = ""
        }
      }

      controller.enqueue(
        encoder.encode(
          sseFrame({
            type: "line",
            stream: "stdout",
            text: `+ docker ${args.join(" ")}`,
          }),
        ),
      )

      child.stdout.on("data", (d: Buffer) => emitLines(d.toString(), "stdout"))
      child.stderr.on("data", (d: Buffer) => emitLines(d.toString(), "stderr"))

      const finish = (payload: unknown) => {
        flushTail()
        try {
          controller.enqueue(encoder.encode(sseFrame(payload)))
        } catch {
          /* controller may already be closed if aborted */
        }
        try {
          controller.close()
        } catch {
          /* idempotent */
        }
      }

      child.on("close", (code) => finish({ type: "done", exitCode: code ?? -1 }))
      child.on("error", (err) =>
        finish({ type: "error", error: err instanceof Error ? err.message : String(err) }),
      )

      // Abort handling — when the client closes the connection, kill
      // the docker child so we don't leave orphan builds running.
      const onAbort = () => {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already exited */
        }
      }
      req.signal.addEventListener("abort", onAbort, { once: true })
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}
