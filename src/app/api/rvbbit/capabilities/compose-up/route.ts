import { spawn, spawnSync } from "child_process"
import { accessSync, constants as fsConstants, mkdirSync, promises as fs } from "fs"
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
 * outDir is validated to live under the writable local work root;
 * compose.yaml must exist in that directory.
 */

interface ComposeBody {
  outDir?: string
  device?: string
  gpu?: boolean
  gpuIntent?: boolean
  publishHostPort?: boolean
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

interface DockerInvocation {
  command: string
  args: string[]
  display: string
  env: NodeJS.ProcessEnv
}

const DEFAULT_NETWORK_CANDIDATES = ["rvbbit_uber", "rvbbit_release", "docker_default"]

interface CommandSpec {
  command: string
  args: string[]
}

function dockerConfigHasPermissionProblem(configDir: string): boolean {
  try {
    accessSync(path.join(configDir, "config.json"), fsConstants.R_OK)
    return false
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return false
    return code === "EACCES" || code === "EPERM"
  }
}

function dockerBin(): string {
  return process.env.RVBBIT_DOCKER_BIN?.trim() || "docker"
}

function wrapSudo(command: string, args: string[]): CommandSpec {
  if (!envFlag("RVBBIT_DOCKER_SUDO")) return { command, args }
  return { command: "sudo", args: ["-n", command, ...args] }
}

function dockerCommand(args: string[]): CommandSpec {
  return wrapSudo(dockerBin(), args)
}

function dockerNetworkExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const docker = dockerCommand(["network", "inspect", trimmed])
  const result = spawnSync(docker.command, docker.args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return result.status === 0
}

function currentContainerNetworks(env: NodeJS.ProcessEnv): string[] {
  const container = env.RVBBIT_LENS_CONTAINER_NAME?.trim() || env.HOSTNAME?.trim()
  if (!container) return []
  const docker = dockerCommand([
    "inspect",
    "--format",
    "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}",
    container,
  ])
  const result = spawnSync(
    docker.command,
    docker.args,
    {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  if (result.status !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !["bridge", "host", "none"].includes(line))
}

function resolveDockerNetwork(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.RVBBIT_DOCKER_NETWORK?.trim()
  if (explicit) return explicit

  const current = currentContainerNetworks(env)
  const candidates = [...current, ...DEFAULT_NETWORK_CANDIDATES]
  for (const candidate of candidates) {
    if (dockerNetworkExists(candidate, env)) return candidate
  }
  return current[0] ?? null
}

function commandOutput(command: string, args: string[], env: NodeJS.ProcessEnv): { ok: boolean; text: string } {
  const invocation = wrapSudo(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  return {
    ok: result.status === 0,
    text: result.stdout?.trim() || result.stderr?.trim() || result.error?.message || "",
  }
}

function hostHasGpu(env: NodeJS.ProcessEnv): boolean {
  const smi = spawnSync("nvidia-smi", ["-L"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (smi.status === 0 && smi.stdout.trim().length > 0) return true

  // Packaged Lens often talks to the host Docker daemon through the socket
  // without having the GPU mounted into the Lens container itself. In that
  // shape, Docker's configured runtimes are the cheap host-side signal.
  const dockerInfo = commandOutput(
    dockerBin(),
    ["info", "--format", "{{json .Runtimes}} {{json .DefaultRuntime}}"],
    env,
  )
  return dockerInfo.ok && dockerInfo.text.toLowerCase().includes("nvidia")
}

function normalizeDevice(device?: string): string {
  return (device?.trim() || "auto").toLowerCase()
}

function resolveGpuOverlay(
  body: ComposeBody,
  hasGpuFile: boolean,
  env: NodeJS.ProcessEnv,
): { useGpu: boolean; message: string | null } {
  const device = normalizeDevice(body.device)
  if (!hasGpuFile) {
    if (body.gpu === true || device === "cuda" || (device === "auto" && body.gpuIntent === true)) {
      return { useGpu: false, message: "gpu overlay skipped: compose.gpu.yaml is missing" }
    }
    return { useGpu: false, message: null }
  }
  if (body.gpu === true) {
    return { useGpu: true, message: "gpu overlay enabled: requested by installer" }
  }
  if (device === "cpu") {
    return { useGpu: false, message: null }
  }

  const wantsGpu = device === "cuda" || (device === "auto" && body.gpuIntent === true)
  if (!wantsGpu) return { useGpu: false, message: null }

  if (!hostHasGpu(env)) {
    return {
      useGpu: false,
      message:
        "gpu overlay skipped: capability is GPU-capable but no NVIDIA GPU/runtime was detected",
    }
  }
  return {
    useGpu: true,
    message:
      device === "cuda"
        ? "gpu overlay enabled: manifest requested cuda and host GPU was detected"
        : "gpu overlay enabled: device=auto, GPU-capable manifest, and host GPU was detected",
  }
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const candidate = env.DOCKER_CONFIG?.trim() || (env.HOME ? path.join(env.HOME, ".docker") : "")
  if (candidate && dockerConfigHasPermissionProblem(candidate)) {
    const clean = path.join(os.tmpdir(), "rvbbit-empty-docker-config")
    mkdirSync(clean, { recursive: true })
    env.DOCKER_CONFIG = clean
  }
  const resolvedNetwork = resolveDockerNetwork(env)
  if (resolvedNetwork) env.RVBBIT_DOCKER_NETWORK = resolvedNetwork
  return env
}

function commandWorks(command: string, args: string[], env: NodeJS.ProcessEnv): { ok: boolean; error: string } {
  const invocation = wrapSudo(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status === 0) return { ok: true, error: "" }
  return {
    ok: false,
    error: result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`,
  }
}

function dockerComposeInvocation(args: string[]): DockerInvocation {
  const dockerBinName = dockerBin()
  const dockerComposeBin = process.env.RVBBIT_DOCKER_COMPOSE_BIN?.trim() || "docker-compose"
  const env = dockerEnv()
  const plugin = commandWorks(dockerBinName, ["compose", "version"], env)
  if (plugin.ok) {
    const dockerArgs = ["compose", ...args]
    if (envFlag("RVBBIT_DOCKER_SUDO")) {
      const sudoArgs = ["-n", dockerBinName, ...dockerArgs]
      return {
        command: "sudo",
        args: sudoArgs,
        display: `sudo ${sudoArgs.join(" ")}`,
        env,
      }
    }
    return {
      command: dockerBinName,
      args: dockerArgs,
      display: `${dockerBinName} ${dockerArgs.join(" ")}`,
      env,
    }
  }

  const standalone = commandWorks(dockerComposeBin, ["version"], env)
  if (!standalone.ok) {
    throw new Error(
      `Docker Compose is required for local capability installs, but neither ` +
        `\`${dockerBinName} compose\` nor \`${dockerComposeBin}\` is usable. ` +
        `\`${dockerBinName} compose version\` failed: ${plugin.error}; ` +
        `\`${dockerComposeBin} version\` failed: ${standalone.error}`,
    )
  }

  if (envFlag("RVBBIT_DOCKER_SUDO")) {
    const sudoArgs = ["-n", dockerComposeBin, ...args]
    return {
      command: "sudo",
      args: sudoArgs,
      display: `sudo ${sudoArgs.join(" ")}`,
      env,
    }
  }
  return {
    command: dockerComposeBin,
    args,
    display: `${dockerComposeBin} ${args.join(" ")}`,
    env,
  }
}

function localWorkRoot(): string {
  return path.resolve(
    process.env.RVBBIT_LOCAL_WORK_ROOT?.trim() ||
      process.env.RVBBIT_LENS_HOME?.trim() ||
      os.homedir(),
  )
}

function resolveOutDir(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: "outDir is required" }
  }
  const root = localWorkRoot()
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return {
      ok: false,
      error: `outDir must live under local work root (${root}); got ${resolved}`,
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
  const dockerEnvForDecision = dockerEnv()
  const gpuDecision = resolveGpuOverlay(body, await fileExists(gpuFile), dockerEnvForDecision)
  const hostPortsFile = path.join(out.path, "compose.host-ports.yaml")
  const useHostPorts = !!body.publishHostPort
  if (useHostPorts && !(await fileExists(hostPortsFile))) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `compose.host-ports.yaml not found in ${out.path}. Run scaffold first.`,
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  }

  const args = ["-f", "compose.yaml"]
  if (useHostPorts) args.push("-f", "compose.host-ports.yaml")
  if (gpuDecision.useGpu) args.push("-f", "compose.gpu.yaml")
  args.push("up", "-d", "--build")

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let docker: DockerInvocation
      try {
        docker = dockerComposeInvocation(args)
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            sseFrame({ type: "error", error: e instanceof Error ? e.message : String(e) }),
          ),
        )
        controller.close()
        return
      }
      const network = docker.env.RVBBIT_DOCKER_NETWORK?.trim()
      if (network && !dockerNetworkExists(network, docker.env)) {
        controller.enqueue(
          encoder.encode(
            sseFrame({
              type: "error",
              error:
                `Docker network '${network}' was selected for the capability sidecar, ` +
                `but it does not exist. Set RVBBIT_DOCKER_NETWORK to the Postgres/Lens ` +
                `compose network, or create that Docker network before running build.`,
            }),
          ),
        )
        controller.close()
        return
      }
      const child = spawn(docker.command, docker.args, {
        cwd: out.path,
        env: docker.env,
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
            text: `+ ${docker.display}`,
          }),
        ),
      )
      if (gpuDecision.message) {
        controller.enqueue(
          encoder.encode(
            sseFrame({
              type: "line",
              stream: "stdout",
              text: gpuDecision.message,
            }),
          ),
        )
      }

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
