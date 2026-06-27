"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCode2,
  Play,
  RefreshCw,
  Rocket,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  applyInstallSql,
  isExternalBackendManifest,
  isVllmManifest,
  probeBackend,
  renderSetDefaultEmbedderSql,
  runScaffold,
  setDefaultEmbedder,
  streamComposeUp,
  type ComposeFrame,
  type InstallKnobs,
  type Manifest,
  type ProbeResult,
  type RenderedArtifacts,
  type ScaffoldedFileEntry,
} from "@/lib/rvbbit/capabilities"
import { CodePreview } from "./code-preview"
import { fmtMs } from "./instruments"

interface CapabilityInstallGraphProps {
  activeConnectionId: string | null
  /** On-disk pack manifest path. Omit when deploying an inline manifest. */
  manifestPath?: string
  /** Inline manifest YAML for from-id deploys (no pack on disk). */
  manifestYaml?: string
  manifest: Manifest
  knobs: InstallKnobs
  rendered: RenderedArtifacts
  /** Embedding capabilities may promote their installed backend to canonical `embed`. */
  isEmbeddingCapability?: boolean
  makeDefaultEmbedder?: boolean
  defaultEmbedderActive?: boolean
  onMakeDefaultEmbedderChange?: (value: boolean) => void
  /** Fires after register/smoke so the parent can re-poll backend_health. */
  onInstalledChanged?: () => void
}

function manifestGpuIntent(manifest: Manifest): boolean {
  const gpu = manifest.resources?.gpu
  return gpu?.required === true || Boolean(String(gpu?.placement ?? "").trim())
}

// ── Step state model ────────────────────────────────────────────────

type StepKey = "scaffold" | "build" | "register" | "operator" | "smoke" | "default_embedder"
type StepStatus = "pending" | "running" | "ok" | "failed"

interface StepState {
  status: StepStatus
  startedAt?: number
  endedAt?: number
  /** Short error summary shown on the node face. */
  error?: string
}

interface ScaffoldArtifact {
  outDir: string
  files: ScaffoldedFileEntry[]
  overridesApplied: string[]
  stdout: string
  stderr: string
}

interface BuildArtifact {
  lines: Array<{ stream: "stdout" | "stderr"; text: string }>
  exitCode?: number
}

interface SqlArtifact {
  sql: string
  latencyMs?: number
  lastRow?: Record<string, unknown> | null
  error?: string
}

interface ProbeAttemptArtifact {
  attempt: number
  elapsedMs: number
  latencyMs: number
  ok: boolean
  outputType?: string
  error?: string
}

interface SmokeArtifact extends SqlArtifact {
  probe?: {
    ok: boolean
    latencyMs: number
    outputType?: string
    error?: string
    attempts?: number
    waitedMs?: number
    timeoutMs?: number
  }
  probeAttempts?: ProbeAttemptArtifact[]
  probeWaiting?: boolean
  probeTimeoutMs?: number
}

interface ArtifactsMap {
  scaffold: ScaffoldArtifact | null
  build: BuildArtifact | null
  register: SqlArtifact | null
  operator: SqlArtifact | null
  smoke: SmokeArtifact | null
  default_embedder: SqlArtifact | null
}

const BASE_STEP_ORDER: StepKey[] = ["scaffold", "build", "register", "operator", "smoke"]
const DEFAULT_EMBEDDER_STEP: StepKey = "default_embedder"
const ALL_STEPS: StepKey[] = [...BASE_STEP_ORDER, DEFAULT_EMBEDDER_STEP]

const STEP_LABEL: Record<StepKey, string> = {
  scaffold: "Scaffold",
  build: "Build",
  register: "Register",
  operator: "Operator",
  smoke: "Smoke",
  default_embedder: "Default",
}

const STEP_HINT: Record<StepKey, string> = {
  scaffold: "Write Dockerfile, main.py, SQL files, compose.yaml, and optional compose overlays",
  build: "docker compose up -d --build with selected overlays",
  register: "Apply register.sql → rvbbit.register_backend(…)",
  operator: "Apply operator.sql → rvbbit.create_operator(…)",
  smoke: "Apply smoke.sql, then wait for backend_probe readiness",
  default_embedder: "Set this embedding backend as the system `embed` backend and purge stale cache",
}

function initSteps(): Record<StepKey, StepState> {
  return Object.fromEntries(
    ALL_STEPS.map((k) => [k, { status: "pending" as StepStatus }]),
  ) as Record<StepKey, StepState>
}

function initArtifacts(): ArtifactsMap {
  return {
    scaffold: null,
    build: null,
    register: null,
    operator: null,
    smoke: null,
    default_embedder: null,
  }
}

// ── Layout constants ────────────────────────────────────────────────

const NODE_W = 156
const NODE_H = 86
const COL_GAP = 36
const PAD_X = 16
const PAD_Y = 20
const SMOKE_PROBE_TIMEOUT_MS = 120_000
// vLLM loads weights + compiles CUDA graphs on first boot — minutes, not
// seconds — so its readiness probe gets a much longer leash.
const SMOKE_PROBE_TIMEOUT_MS_VLLM = 600_000
const SMOKE_PROBE_INTERVAL_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function probeArtifact(
  probe: ProbeResult,
  attempts: number,
  waitedMs: number,
  timeoutMs: number,
): NonNullable<SmokeArtifact["probe"]> {
  return {
    ok: probe.ok,
    latencyMs: probe.latency_ms,
    outputType: probe.outputType,
    error: probe.error,
    attempts,
    waitedMs,
    timeoutMs,
  }
}

export function CapabilityInstallGraph({
  activeConnectionId,
  manifestPath,
  manifestYaml,
  manifest,
  knobs,
  rendered,
  isEmbeddingCapability = false,
  makeDefaultEmbedder = false,
  defaultEmbedderActive = false,
  onMakeDefaultEmbedderChange,
  onInstalledChanged,
}: CapabilityInstallGraphProps) {
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(initSteps)
  const [artifacts, setArtifacts] = useState<ArtifactsMap>(initArtifacts)
  const [selectedStep, setSelectedStep] = useState<StepKey>("scaffold")
  const [running, setRunning] = useState(false)
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const composeAbortRef = useRef<AbortController | null>(null)
  const gpuIntent = useMemo(() => manifestGpuIntent(manifest), [manifest])
  const externalBackend = useMemo(() => isExternalBackendManifest(manifest), [manifest])
  const stepOrder = useMemo(() => {
    const base = externalBackend
      ? BASE_STEP_ORDER.filter((k) => k !== "scaffold" && k !== "build")
      : BASE_STEP_ORDER
    return isEmbeddingCapability && makeDefaultEmbedder
      ? [...base, DEFAULT_EMBEDDER_STEP]
      : base
  }, [externalBackend, isEmbeddingCapability, makeDefaultEmbedder])
  const effectiveSelectedStep = stepOrder.includes(selectedStep)
    ? selectedStep
    : stepOrder[0] ?? "register"
  const devicePref = (knobs.device || "auto").trim().toLowerCase()
  const autoGpuEligible = !knobs.gpu && (devicePref === "cuda" || (devicePref === "auto" && gpuIntent))

  // ── per-step runners ──
  const setStep = useCallback((key: StepKey, patch: Partial<StepState>) => {
    setSteps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }, [])

  const runScaffoldStep = useCallback(async (): Promise<boolean> => {
    setStep("scaffold", { status: "running", startedAt: Date.now(), error: undefined })
    const result = await runScaffold({
      manifestPath,
      manifestYaml: manifestYaml ?? rendered.manifestYaml,
      outDir: knobs.outputDir,
      force: true,
      overrides: {
        "register.sql": rendered.registerSql,
        "operator.sql": rendered.operatorSql,
        "smoke.sql": rendered.smokeSql,
        "compose.yaml": rendered.composeYaml,
        "compose.host-ports.yaml": rendered.composeHostPortsYaml,
        "compose.gpu.yaml": rendered.composeGpuYaml,
        "rvbbit.backend.yaml": rendered.manifestYaml,
      },
    })
    setArtifacts((a) => ({
      ...a,
      scaffold: {
        outDir: result.outDir ?? knobs.outputDir,
        files: result.files,
        overridesApplied: result.overridesApplied,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    }))
    if (!result.ok) {
      setStep("scaffold", { status: "failed", endedAt: Date.now(), error: result.error })
      return false
    }
    setStep("scaffold", { status: "ok", endedAt: Date.now() })
    return true
  }, [manifestPath, manifestYaml, knobs.outputDir, rendered, setStep])

  const runBuildStep = useCallback(async (): Promise<boolean> => {
    setStep("build", { status: "running", startedAt: Date.now(), error: undefined })
    setArtifacts((a) => ({ ...a, build: { lines: [] } }))
    const abort = new AbortController()
    composeAbortRef.current = abort

    const result = await streamComposeUp(
      {
        outDir: knobs.outputDir,
        device: knobs.device,
        gpu: knobs.gpu,
        gpuIntent,
        publishHostPort: knobs.publishHostPort,
      },
      (frame: ComposeFrame) => {
        if (frame.type === "line") {
          setArtifacts((a) => {
            const prev = a.build ?? { lines: [] }
            const next = {
              ...prev,
              // Cap the tail to keep memory bounded on long builds; the
              // user can still see the head and the tail, with the
              // middle trimmed if needed.
              lines: [...prev.lines, { stream: frame.stream, text: frame.text }].slice(-500),
            }
            return { ...a, build: next }
          })
        }
      },
      abort.signal,
    )
    composeAbortRef.current = null

    setArtifacts((a) => ({
      ...a,
      build: { ...(a.build ?? { lines: [] }), exitCode: result.exitCode },
    }))

    if (result.exitCode !== 0) {
      setStep("build", {
        status: "failed",
        endedAt: Date.now(),
        error: result.error ?? `exit ${result.exitCode}`,
      })
      return false
    }
    setStep("build", { status: "ok", endedAt: Date.now() })
    return true
  }, [gpuIntent, knobs.device, knobs.outputDir, knobs.gpu, knobs.publishHostPort, setStep])

  const runSqlStep = useCallback(
    async (
      key: "register" | "operator",
      sql: string,
    ): Promise<boolean> => {
      if (!activeConnectionId) {
        setStep(key, {
          status: "failed",
          endedAt: Date.now(),
          error: "no active connection",
        })
        return false
      }
      setStep(key, { status: "running", startedAt: Date.now(), error: undefined })
      const result = await applyInstallSql(activeConnectionId, sql)
      setArtifacts((a) => ({
        ...a,
        [key]: {
          sql,
          latencyMs: result.latencyMs,
          lastRow: result.lastRow ?? null,
          error: result.error,
        },
      }))
      if (!result.ok) {
        setStep(key, {
          status: "failed",
          endedAt: Date.now(),
          error: result.error ?? "sql failed",
        })
        return false
      }
      setStep(key, { status: "ok", endedAt: Date.now() })
      onInstalledChanged?.()
      return true
    },
    [activeConnectionId, setStep, onInstalledChanged],
  )

  const runSmokeStep = useCallback(async (): Promise<boolean> => {
    if (!activeConnectionId) {
      setStep("smoke", {
        status: "failed",
        endedAt: Date.now(),
        error: "no active connection",
      })
      return false
    }
    setStep("smoke", { status: "running", startedAt: Date.now(), error: undefined })
    // Two phases inside this step:
    //   (a) apply smoke.sql (the doc-blessed verification script)
    //   (b) confirm health via backend_probe
    // The probe call is what the install-state badge uses, so running
    // it here ensures Capability Detail flips to "healthy" on success.
    const sqlResult = await applyInstallSql(activeConnectionId, rendered.smokeSql)
    // Runtime sidecars do not expose the /predict backend transport, so
    // there is no backend_probe to run — the smoke SQL is the verification.
    const smokeBase: SmokeArtifact = {
      sql: rendered.smokeSql,
      latencyMs: sqlResult.latencyMs,
      lastRow: sqlResult.lastRow ?? null,
      error: sqlResult.ok ? undefined : sqlResult.error,
    }
    setArtifacts((a) => ({
      ...a,
      smoke: smokeBase,
    }))
    if (!sqlResult.ok) {
      setStep("smoke", {
        status: "failed",
        endedAt: Date.now(),
        error: sqlResult.error ?? "smoke failed",
      })
      return false
    }

    const isRuntime = manifest.kind === "runtime_sidecar"
    if (isRuntime || !manifest.backend) {
      setStep("smoke", { status: "ok", endedAt: Date.now() })
      onInstalledChanged?.()
      return true
    }

    // vLLM cold-starts (weight load + CUDA graph capture) can run many
    // minutes; give it a 10-minute leash instead of the default 2.
    const probeTimeoutMs = isVllmManifest(manifest)
      ? SMOKE_PROBE_TIMEOUT_MS_VLLM
      : SMOKE_PROBE_TIMEOUT_MS
    const probeStartedAt = Date.now()
    const probeDeadline = probeStartedAt + probeTimeoutMs
    let attempts: ProbeAttemptArtifact[] = []
    let lastProbe: ProbeResult | null = null

    while (Date.now() <= probeDeadline) {
      const attempt = attempts.length + 1
      const probe = await probeBackend(activeConnectionId, manifest.backend.name, null)
      lastProbe = probe
      const elapsedMs = Date.now() - probeStartedAt
      attempts = [
        ...attempts,
        {
          attempt,
          elapsedMs,
          latencyMs: probe.latency_ms,
          ok: probe.ok,
          outputType: probe.outputType,
          error: probe.error,
        },
      ]
      setArtifacts((a) => ({
        ...a,
        smoke: {
          ...smokeBase,
          probe: probeArtifact(probe, attempt, elapsedMs, probeTimeoutMs),
          probeAttempts: attempts,
          probeWaiting: !probe.ok,
          probeTimeoutMs,
        },
      }))

      if (probe.ok) {
        setStep("smoke", { status: "ok", endedAt: Date.now() })
        onInstalledChanged?.()
        return true
      }

      const waitMs = Math.min(SMOKE_PROBE_INTERVAL_MS, probeDeadline - Date.now())
      if (waitMs <= 0) break
      await sleep(waitMs)
    }

    const waitedMs = Date.now() - probeStartedAt
    const lastError = lastProbe?.error ?? "probe failed"
    const error = `backend_probe did not become ready within ${Math.round(probeTimeoutMs / 1000)}s: ${lastError}`
    setArtifacts((a) => ({
      ...a,
      smoke: {
        ...(a.smoke ?? smokeBase),
        probe: {
          ok: false,
          latencyMs: lastProbe?.latency_ms ?? 0,
          outputType: lastProbe?.outputType,
          error,
          attempts: attempts.length,
          waitedMs,
          timeoutMs: probeTimeoutMs,
        },
        probeAttempts: attempts,
        probeWaiting: false,
        probeTimeoutMs,
      },
    }))
    setStep("smoke", {
      status: "failed",
      endedAt: Date.now(),
      error,
    })
    return false
  }, [activeConnectionId, rendered.smokeSql, manifest, setStep, onInstalledChanged])

  const runDefaultEmbedderStep = useCallback(async (): Promise<boolean> => {
    if (!activeConnectionId) {
      setStep("default_embedder", {
        status: "failed",
        endedAt: Date.now(),
        error: "no active connection",
      })
      return false
    }
    if (!manifest.backend?.name) {
      setStep("default_embedder", {
        status: "failed",
        endedAt: Date.now(),
        error: "manifest has no backend",
      })
      return false
    }
    const sql = renderSetDefaultEmbedderSql(manifest.backend.name, true)
    setStep("default_embedder", { status: "running", startedAt: Date.now(), error: undefined })
    const result = await setDefaultEmbedder(activeConnectionId, manifest.backend.name, true)
    setArtifacts((a) => ({
      ...a,
      default_embedder: {
        sql,
        latencyMs: result.latencyMs,
        lastRow: result.lastRow ?? null,
        error: result.error,
      },
    }))
    if (!result.ok) {
      setStep("default_embedder", {
        status: "failed",
        endedAt: Date.now(),
        error: result.error ?? "default embedder failed",
      })
      return false
    }
    setStep("default_embedder", { status: "ok", endedAt: Date.now() })
    onInstalledChanged?.()
    return true
  }, [activeConnectionId, manifest.backend, setStep, onInstalledChanged])

  // ── Pipeline orchestration ──
  const runFrom = useCallback(
    async (start: StepKey) => {
      setRunning(true)
      setPipelineError(null)
      // reset start + everything downstream
      const startIdx = Math.max(0, stepOrder.indexOf(start))
      setSteps((prev) => {
        const next = { ...prev }
        for (let i = startIdx; i < stepOrder.length; i++) {
          next[stepOrder[i]] = { status: "pending" }
        }
        return next
      })

      const runners: Record<StepKey, () => Promise<boolean>> = {
        scaffold: runScaffoldStep,
        build: runBuildStep,
        register: () => runSqlStep("register", rendered.registerSql),
        operator: () => runSqlStep("operator", rendered.operatorSql),
        smoke: runSmokeStep,
        default_embedder: runDefaultEmbedderStep,
      }

      for (let i = startIdx; i < stepOrder.length; i++) {
        const k = stepOrder[i]
        setSelectedStep(k)
        const ok = await runners[k]()
        if (!ok) {
          setPipelineError(`Pipeline stopped at "${STEP_LABEL[k]}". Click the node to inspect, then Retry or Run from here.`)
          break
        }
      }
      setRunning(false)
    },
    [
      runScaffoldStep,
      runBuildStep,
      runSqlStep,
      runSmokeStep,
      runDefaultEmbedderStep,
      stepOrder,
      rendered.registerSql,
      rendered.operatorSql,
    ],
  )

  const cancel = useCallback(() => {
    composeAbortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    setSteps(initSteps())
    setArtifacts(initArtifacts())
    setPipelineError(null)
    setSelectedStep(stepOrder[0] ?? "register")
  }, [stepOrder])

  // ── Layout calc ──
  const dims = useMemo(() => {
    const width = PAD_X * 2 + stepOrder.length * NODE_W + (stepOrder.length - 1) * COL_GAP
    const height = PAD_Y * 2 + NODE_H
    return { width, height }
  }, [stepOrder])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* control bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Rocket className="h-3.5 w-3.5 text-brand-capability" />
        <span className="text-[11px] uppercase tracking-wider text-chrome-text">
          Install pipeline
        </span>
        <span className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/60">
          {externalBackend ? "external backend" : knobs.outputDir}
        </span>
        {defaultEmbedderActive ? (
          <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-success">
            system embedder
          </span>
        ) : null}
        {knobs.gpu ? (
          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning">
            gpu overlay
          </span>
        ) : autoGpuEligible ? (
          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning">
            gpu auto
          </span>
        ) : null}
        {knobs.publishHostPort ? (
          <span className="rounded-full bg-brand-capability/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-brand-capability">
            host port {knobs.hostPort === 0 ? "auto" : knobs.hostPort}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {isEmbeddingCapability ? (
            <label
              className="mr-1 inline-flex items-center gap-1.5 rounded border border-chrome-border/50 bg-secondary-background/40 px-2 py-1 text-[10px] text-chrome-text/75"
              title="After install, copy this backend into the canonical `embed` backend and purge stale cache"
            >
              <input
                type="checkbox"
                checked={makeDefaultEmbedder}
                onChange={(e) => onMakeDefaultEmbedderChange?.(e.target.checked)}
                disabled={running || defaultEmbedderActive}
                className="h-3 w-3 accent-brand-capability disabled:opacity-50"
              />
              <span>{defaultEmbedderActive ? "default active" : "use as system embedder"}</span>
            </label>
          ) : null}
          {running ? (
            <Button
              size="sm"
              variant="neutral"
              onClick={cancel}
              className="h-6"
              title="Cancels the current docker build; SQL steps can't be cancelled"
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void runFrom(stepOrder[0] ?? "register")}
              className="h-6"
              disabled={!activeConnectionId}
            >
              <Play className="h-3 w-3" />
              Run all
            </Button>
          )}
          <button
            type="button"
            onClick={reset}
            disabled={running}
            title="Reset pipeline state (no files touched on disk)"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* graph */}
      <div className="overflow-auto border-b border-chrome-border">
        <div
          className="relative mx-auto"
          style={{ width: dims.width, height: dims.height }}
        >
          {/* edges (drawn behind nodes) */}
          <svg
            className="pointer-events-none absolute inset-0"
            width={dims.width}
            height={dims.height}
          >
            <defs>
              <marker
                id="install-arrow"
                viewBox="0 0 8 8"
                refX="6"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="var(--chrome-border)" />
              </marker>
            </defs>
            {stepOrder.slice(0, -1).map((k, i) => {
              const x1 = PAD_X + (i + 1) * NODE_W + i * COL_GAP - 2
              const x2 = PAD_X + (i + 1) * (NODE_W + COL_GAP) + 2
              const y = PAD_Y + NODE_H / 2
              const isActive =
                steps[k].status === "ok" &&
                (steps[stepOrder[i + 1]].status === "running" ||
                  steps[stepOrder[i + 1]].status === "ok")
              return (
                <line
                  key={k}
                  x1={x1}
                  x2={x2}
                  y1={y}
                  y2={y}
                  stroke={isActive ? "var(--brand-capability)" : "var(--chrome-border)"}
                  strokeWidth={2}
                  markerEnd="url(#install-arrow)"
                />
              )
            })}
          </svg>

          {/* nodes */}
          {stepOrder.map((k, i) => {
            const left = PAD_X + i * (NODE_W + COL_GAP)
            return (
              <PipelineNode
                key={k}
                left={left}
                top={PAD_Y}
                width={NODE_W}
                height={NODE_H}
                stepKey={k}
                state={steps[k]}
                selected={effectiveSelectedStep === k}
                onSelect={() => setSelectedStep(k)}
              />
            )
          })}
        </div>
      </div>

      {/* pipeline error band */}
      {pipelineError ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="flex-1 break-words">{pipelineError}</span>
          <button
            type="button"
            onClick={() => void runFrom(effectiveSelectedStep)}
            disabled={running}
            className="rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warning hover:bg-warning/25 disabled:opacity-50"
          >
            retry from here
          </button>
          <button
            type="button"
            onClick={() => setPipelineError(null)}
            className="text-warning/70 hover:text-warning"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {/* artifact panel */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ArtifactPanel
          stepKey={effectiveSelectedStep}
          state={steps[effectiveSelectedStep]}
          artifact={artifacts[effectiveSelectedStep]}
          running={running}
          canRun={!!activeConnectionId}
          onRunFromHere={() => void runFrom(effectiveSelectedStep)}
        />
      </div>
    </div>
  )
}

// ── Node ────────────────────────────────────────────────────────────

function PipelineNode({
  left,
  top,
  width,
  height,
  stepKey,
  state,
  selected,
  onSelect,
}: {
  left: number
  top: number
  width: number
  height: number
  stepKey: StepKey
  state: StepState
  selected: boolean
  onSelect: () => void
}) {
  const tone = STATUS_TONE[state.status]
  // Live elapsed timer while running — tick state keeps it ticking; React's
  // purity rule means we can't call Date.now() during render directly.
  const tick = useNowWhile(state.status === "running")
  const duration =
    state.startedAt && state.endedAt
      ? state.endedAt - state.startedAt
      : state.startedAt && state.status === "running"
        ? tick - state.startedAt
        : null

  return (
    <button
      type="button"
      onClick={onSelect}
      title={STEP_HINT[stepKey]}
      className={cn(
        "group absolute flex flex-col rounded-md border-2 bg-secondary-background text-left transition",
        selected ? "ring-2 ring-brand-capability/40" : "",
        tone.border,
      )}
      style={{ left, top, width, height }}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-t-md px-2 py-1 text-[10px] uppercase tracking-wider",
          tone.headerBg,
          tone.headerFg,
        )}
      >
        <StatusGlyph status={state.status} />
        <span className="font-medium">{STEP_LABEL[stepKey]}</span>
        {duration != null ? (
          <span className="ml-auto font-mono tabular-nums text-[9px]">
            {fmtMs(duration)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-2 py-1.5">
        <div className={cn("text-[11px] font-medium", tone.bodyFg)}>
          {STATUS_FACE[state.status]}
        </div>
        {state.error ? (
          <div className="line-clamp-2 text-[10px] leading-tight text-danger">
            {state.error}
          </div>
        ) : (
          <div className="line-clamp-2 text-[10px] leading-tight text-chrome-text/55">
            {STEP_HINT[stepKey]}
          </div>
        )}
      </div>
    </button>
  )
}

/**
 * 200ms-tick clock that only runs when `active` is true. Lets a node
 * face show live elapsed time without violating React's purity rule
 * (which forbids Date.now() during render).
 */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [active])
  return now
}

const STATUS_TONE: Record<
  StepStatus,
  { border: string; headerBg: string; headerFg: string; bodyFg: string }
> = {
  pending: {
    border: "border-chrome-border/50",
    headerBg: "bg-foreground/[0.04]",
    headerFg: "text-chrome-text/65",
    bodyFg: "text-chrome-text/75",
  },
  running: {
    border: "border-rvbbit-accent/60",
    headerBg: "bg-rvbbit-accent/15",
    headerFg: "text-rvbbit-accent",
    bodyFg: "text-foreground",
  },
  ok: {
    border: "border-success/50",
    headerBg: "bg-success/15",
    headerFg: "text-success",
    bodyFg: "text-foreground",
  },
  failed: {
    border: "border-danger/60",
    headerBg: "bg-danger/15",
    headerFg: "text-danger",
    bodyFg: "text-foreground",
  },
}

const STATUS_FACE: Record<StepStatus, string> = {
  pending: "pending",
  running: "running…",
  ok: "ok",
  failed: "failed",
}

function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === "ok") return <CheckCircle2 className="h-3 w-3" />
  if (status === "failed") return <X className="h-3 w-3" />
  if (status === "running")
    return (
      <span className="relative inline-flex h-2 w-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
        <span className="relative inline-block h-2 w-2 rounded-full bg-rvbbit-accent" />
      </span>
    )
  return <Clock className="h-3 w-3" />
}

// ── Artifact panel ──────────────────────────────────────────────────

function ArtifactPanel({
  stepKey,
  state,
  artifact,
  running,
  canRun,
  onRunFromHere,
}: {
  stepKey: StepKey
  state: StepState
  artifact:
    | ScaffoldArtifact
    | BuildArtifact
    | SqlArtifact
    | SmokeArtifact
    | null
  running: boolean
  canRun: boolean
  onRunFromHere: () => void
}) {
  const titleRight =
    state.status !== "pending" && !running ? (
      <button
        type="button"
        onClick={onRunFromHere}
        disabled={!canRun}
        className="inline-flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-chrome-text hover:text-foreground disabled:opacity-50"
        title={
          state.status === "failed"
            ? "Retry this step"
            : "Re-run this step and everything downstream"
        }
      >
        <RefreshCw className="h-3 w-3" />
        {state.status === "failed" ? "retry" : "run from here"}
      </button>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-chrome-text/70">
          {STEP_LABEL[stepKey]} · artifact
        </span>
        <div className="ml-auto flex items-center gap-1.5">{titleRight}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {stepKey === "scaffold" ? (
          <ScaffoldPanel artifact={artifact as ScaffoldArtifact | null} state={state} />
        ) : null}
        {stepKey === "build" ? (
          <BuildPanel artifact={artifact as BuildArtifact | null} state={state} />
        ) : null}
        {stepKey === "register" || stepKey === "operator" || stepKey === "default_embedder" ? (
          <SqlPanel artifact={artifact as SqlArtifact | null} state={state} />
        ) : null}
        {stepKey === "smoke" ? (
          <SmokePanel artifact={artifact as SmokeArtifact | null} state={state} />
        ) : null}
      </div>
    </div>
  )
}

function EmptyArtifact({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center p-4 text-[11px] text-chrome-text/45">
      {label}
    </div>
  )
}

function ScaffoldPanel({
  artifact,
  state,
}: {
  artifact: ScaffoldArtifact | null
  state: StepState
}) {
  if (!artifact) {
    return (
      <EmptyArtifact
        label={
          state.status === "pending"
            ? "Run scaffold to write the install bundle to disk."
            : "no artifact"
        }
      />
    )
  }
  return (
    <div className="space-y-3 p-3">
      <div className="rounded border border-chrome-border bg-secondary-background/40 p-2">
        <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/50">
          output directory
        </div>
        <div className="break-all font-mono text-[11px] text-foreground">
          {artifact.outDir}
        </div>
      </div>
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wider text-chrome-text/55">
          <span>
            <span className="font-mono tabular-nums text-foreground">
              {artifact.files.length}
            </span>{" "}
            files written
          </span>
          {artifact.overridesApplied.length > 0 ? (
            <span className="normal-case tracking-normal text-brand-capability/85">
              {artifact.overridesApplied.length} knob override
              {artifact.overridesApplied.length === 1 ? "" : "s"} stamped
            </span>
          ) : null}
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-0.5 pr-2 text-left font-medium">file</th>
              <th className="py-0.5 pr-2 text-left font-medium">source</th>
              <th className="py-0.5 text-right font-medium">size</th>
            </tr>
          </thead>
          <tbody>
            {artifact.files.map((f) => (
              <tr key={f.name} className="border-t border-chrome-border/30">
                <td className="py-0.5 pr-2 font-mono text-foreground">{f.name}</td>
                <td className="py-0.5 pr-2 text-[10px]">
                  {f.isOverride ? (
                    <span className="rounded bg-brand-capability/15 px-1 text-brand-capability">
                      knob override
                    </span>
                  ) : (
                    <span className="text-chrome-text/55">cli template</span>
                  )}
                </td>
                <td className="py-0.5 text-right font-mono tabular-nums text-chrome-text/70">
                  {f.size} B
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {artifact.stderr.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-chrome-text/55 hover:text-foreground">
            cli stderr ({artifact.stderr.length} bytes)
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded border border-chrome-border/40 bg-doc-bg p-2 font-mono text-[10px] text-chrome-text/75">
            {artifact.stderr}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function BuildPanel({
  artifact,
  state,
}: {
  artifact: BuildArtifact | null
  state: StepState
}) {
  const ref = useRef<HTMLDivElement>(null)
  // auto-scroll the tail while building.
  useEffect(() => {
    if (state.status !== "running") return
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [artifact?.lines.length, state.status])

  if (!artifact || artifact.lines.length === 0) {
    return (
      <EmptyArtifact
        label={
          state.status === "pending"
            ? "Run build to start `docker compose up -d --build`."
            : "no output yet"
        }
      />
    )
  }
  return (
    <div className="flex h-full flex-col">
      <div ref={ref} className="min-h-0 flex-1 overflow-auto p-2">
        <pre className="font-mono text-[10px] leading-snug">
          {artifact.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                l.stream === "stderr" ? "text-warning" : "text-foreground/85",
              )}
            >
              {l.text}
            </div>
          ))}
        </pre>
      </div>
      {artifact.exitCode != null ? (
        <div
          className={cn(
            "border-t border-chrome-border bg-chrome-bg/30 px-3 py-1 text-[10px]",
            artifact.exitCode === 0 ? "text-success" : "text-danger",
          )}
        >
          docker exited with code{" "}
          <span className="font-mono tabular-nums">{artifact.exitCode}</span>
        </div>
      ) : null}
    </div>
  )
}

function SqlPanel({
  artifact,
  state,
}: {
  artifact: SqlArtifact | null
  state: StepState
}) {
  if (!artifact) {
    return (
      <EmptyArtifact
        label={
          state.status === "pending"
            ? "Run to apply this SQL against the active connection."
            : "no artifact"
        }
      />
    )
  }
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_320px] overflow-hidden">
      <div className="flex h-full min-w-0 flex-col overflow-hidden border-r border-chrome-border">
        <div className="flex items-center gap-2 border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1">
          <FileCode2 className="h-3 w-3 text-chrome-text/55" />
          <span className="font-mono text-[10px] text-chrome-text/70">
            applied sql
          </span>
        </div>
        <CodePreview code={artifact.sql} lang="sql" className="min-h-0 flex-1" />
      </div>
      <aside className="flex h-full flex-col overflow-auto bg-chrome-bg/10 p-3 text-[11px]">
        {artifact.error ? (
          <div className="rounded border border-danger/40 bg-danger/10 p-2 text-danger">
            <div className="mb-0.5 text-[9px] uppercase tracking-wider opacity-75">
              error
            </div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10px]">
              {artifact.error}
            </pre>
          </div>
        ) : (
          <div className="rounded border border-success/40 bg-success/10 p-2 text-success">
            <div className="mb-0.5 flex items-center justify-between text-[9px] uppercase tracking-wider opacity-75">
              <span>applied</span>
              {artifact.latencyMs != null ? (
                <span className="font-mono tabular-nums">
                  {fmtMs(artifact.latencyMs)}
                </span>
              ) : null}
            </div>
            <div className="text-[10px]">SQL ran without errors.</div>
          </div>
        )}
        {artifact.lastRow ? (
          <div className="mt-3">
            <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
              last row
            </div>
            <pre className="overflow-auto rounded border border-chrome-border/40 bg-doc-bg p-2 font-mono text-[10px] text-foreground/85">
              {JSON.stringify(artifact.lastRow, null, 2)}
            </pre>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

function SmokePanel({
  artifact,
  state,
}: {
  artifact: SmokeArtifact | null
  state: StepState
}) {
  if (!artifact) {
    return (
      <EmptyArtifact
        label={
          state.status === "pending"
            ? "Run smoke to apply smoke.sql, then wait for backend_probe readiness."
            : "no artifact"
        }
      />
    )
  }
  const probe = artifact.probe
  const attemptCount = probe?.attempts ?? artifact.probeAttempts?.length ?? 0
  const recentAttempts = (artifact.probeAttempts ?? []).slice(-5)
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_320px] overflow-hidden">
      <div className="flex h-full min-w-0 flex-col overflow-hidden border-r border-chrome-border">
        <div className="flex items-center gap-2 border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1">
          <FileCode2 className="h-3 w-3 text-chrome-text/55" />
          <span className="font-mono text-[10px] text-chrome-text/70">
            smoke.sql
          </span>
        </div>
        <CodePreview code={artifact.sql} lang="sql" className="min-h-0 flex-1" />
      </div>
      <aside className="flex h-full flex-col gap-3 overflow-auto bg-chrome-bg/10 p-3 text-[11px]">
        <div
          className={cn(
            "rounded border p-2",
            artifact.error
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-success/40 bg-success/10 text-success",
          )}
        >
          <div className="mb-0.5 flex items-center justify-between text-[9px] uppercase tracking-wider opacity-75">
            <span>smoke.sql</span>
            {artifact.latencyMs != null ? (
              <span className="font-mono tabular-nums">
                {fmtMs(artifact.latencyMs)}
              </span>
            ) : null}
          </div>
          {artifact.error ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[10px]">
              {artifact.error}
            </pre>
          ) : (
            <div className="text-[10px]">Smoke script applied cleanly.</div>
          )}
        </div>
        {probe ? (
          <div
            className={cn(
              "rounded border p-2",
              artifact.probeWaiting
                ? "border-rvbbit-accent/40 bg-rvbbit-accent/10 text-rvbbit-accent"
                : probe.ok
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger",
            )}
          >
            <div className="mb-0.5 flex items-center justify-between text-[9px] uppercase tracking-wider opacity-75">
              <span>backend_probe</span>
              <span className="font-mono tabular-nums">
                {attemptCount > 0 ? `try ${attemptCount} · ` : ""}
                {fmtMs(probe.latencyMs)}
              </span>
            </div>
            {artifact.probeWaiting ? (
              <div className="space-y-1 text-[10px]">
                <div>
                  Waiting for the backend to accept requests
                  {probe.waitedMs != null && probe.timeoutMs != null
                    ? ` · ${fmtMs(probe.waitedMs)} / ${fmtMs(probe.timeoutMs)}`
                    : ""}
                </div>
                {probe.error ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10px] opacity-85">
                    {probe.error}
                  </pre>
                ) : null}
              </div>
            ) : probe.ok ? (
              <div className="text-[10px]">
                Round-trip ok
                {attemptCount > 1 ? ` after ${attemptCount} tries` : ""} · output type{" "}
                <span className="font-mono">{probe.outputType ?? "?"}</span>
              </div>
            ) : (
              <div className="space-y-1">
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px]">
                  {probe.error ?? "probe failed"}
                </pre>
                {probe.waitedMs != null ? (
                  <div className="text-[10px] opacity-80">
                    Waited {fmtMs(probe.waitedMs)} across {attemptCount || 1} tries.
                  </div>
                ) : null}
              </div>
            )}
            {recentAttempts.length > 1 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[9px] uppercase tracking-wider opacity-75 hover:opacity-100">
                  recent tries
                </summary>
                <div className="mt-1 space-y-1">
                  {recentAttempts.map((attempt) => (
                    <div
                      key={attempt.attempt}
                      className="rounded border border-current/20 bg-doc-bg/45 p-1 font-mono text-[9px] text-chrome-text"
                    >
                      #{attempt.attempt} · {fmtMs(attempt.elapsedMs)} ·{" "}
                      {attempt.ok ? "ok" : attempt.error ?? "failed"}
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
        {artifact.lastRow ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-chrome-text/55 hover:text-foreground">
              last row
            </summary>
            <pre className="mt-1 overflow-auto rounded border border-chrome-border/40 bg-doc-bg p-2 font-mono text-[10px] text-foreground/85">
              {JSON.stringify(artifact.lastRow, null, 2)}
            </pre>
          </details>
        ) : null}
      </aside>
    </div>
  )
}
