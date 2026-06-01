"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  FileCode2,
  Play,
  Rocket,
  Settings,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  runAcceptanceSql,
  type AcceptanceRunStep,
  type InstallKnobs,
  type Manifest,
  type ManifestAcceptanceBlock,
} from "@/lib/rvbbit/capabilities"
import {
  deployCapability,
  deployCatalogCapability,
  fetchWarrenJob,
  fetchWarrenInventory,
  fetchWarrenLabelObservations,
  manifestWithKnobs,
  nodeHeartbeatState,
  nodeFitsVram,
  nodeIsEligible,
  nodeMatchesSelector,
  uniqueNodesFromInventory,
  type NodeHeartbeatState,
  type WarrenInventoryRow,
  type WarrenLabelObservation,
  type WarrenJobStatus,
} from "@/lib/rvbbit/warren"
import { fmtAgo, fmtMs } from "./instruments"

interface WarrenDeployPanelProps {
  activeConnectionId: string | null
  /**
   * Catalog id for the preferred DB deploy path
   * (`rvbbit.deploy_catalog_capability`). When present, the server reads
   * the published manifest from `rvbbit.capability_catalog`; the local
   * `manifest`/knob overrides are not sent. Absent ⇒ ad-hoc manifest deploy.
   */
  catalogId?: string | null
  manifest: Manifest
  knobs: InstallKnobs
  acceptance?: ManifestAcceptanceBlock | null
  /** Switch the Install tab back to the local CapabilityInstallGraph. */
  onUseLocalInstead?: () => void
  /** After enqueue, open the live job tracker. */
  onOpenJob: (jobId: string, jobName: string | null) => void
}

/**
 * Deploy a capability against a remote Warren node. The user picks a
 * target-selector (label subset) from observed warren-node labels; the
 * preview shows which nodes match RIGHT NOW. Submitting calls
 * `rvbbit.deploy_capability(manifest, selector)` and auto-opens the
 * Job Detail window for the returned job id.
 *
 * Lives inside the Capability Detail Install tab. The local install
 * pipeline is still available via `onUseLocalInstead`.
 */
export function WarrenDeployPanel({
  activeConnectionId,
  catalogId,
  manifest,
  knobs,
  acceptance,
  onUseLocalInstead,
  onOpenJob,
}: WarrenDeployPanelProps) {
  const [inventory, setInventory] = useState<WarrenInventoryRow[]>([])
  const [observations, setObservations] = useState<WarrenLabelObservation[]>([])
  const [selector, setSelector] = useState<Record<string, unknown>>({})
  const [jobName, setJobName] = useState("")
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  /** Most recent successful enqueue — kept visible after the auto-open. */
  const [lastEnqueued, setLastEnqueued] = useState<{
    jobId: string
    at: number
  } | null>(null)
  const [lastJobStatus, setLastJobStatus] = useState<WarrenJobStatus | null>(null)
  const [acceptanceSteps, setAcceptanceSteps] = useState<AcceptanceRunStep[]>([])
  const [acceptanceRunning, setAcceptanceRunning] = useState(false)
  const [acceptanceOk, setAcceptanceOk] = useState<boolean | null>(null)
  const hasAcceptance = (acceptance?.tests?.length ?? 0) > 0

  // ── poll inventory + label observations ──
  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [inv, obs] = await Promise.all([
      fetchWarrenInventory(activeConnectionId),
      fetchWarrenLabelObservations(activeConnectionId),
    ])
    setInventory(inv.rows)
    setObservations(obs.observations)
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    if (!activeConnectionId) return () => { cancelled = true }
    const id = setInterval(() => void reload(), 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, reload])

  useEffect(() => {
    if (!activeConnectionId || !lastEnqueued) return
    let cancelled = false
    const poll = async () => {
      const r = await fetchWarrenJob(activeConnectionId, lastEnqueued.jobId)
      if (cancelled) return
      setLastJobStatus(r.job?.status ?? null)
    }
    void poll()
    const id = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, lastEnqueued])

  // ── derive nodes + match preview ──
  const nodes = useMemo(() => uniqueNodesFromInventory(inventory), [inventory])
  const matching = useMemo(
    () => nodes.filter((n) => nodeMatchesSelector(n.labels, selector)),
    [nodes, selector],
  )
  const vramRequired = manifest.resources?.gpu?.vram_required_bytes ?? null
  const gpuPlacement = manifest.resources?.gpu?.placement ?? "single_gpu"
  const gpuReservationWanted =
    manifest.resources?.gpu?.required === true || selector.gpu === true
  const eligibleMatching = useMemo(
    () =>
      matching.filter((n) =>
        nodeIsEligible(n) &&
        (!gpuReservationWanted ||
          vramRequired == null ||
          nodeFitsVram(n, vramRequired, gpuPlacement) === "fits"),
      ),
    [matching, gpuReservationWanted, vramRequired, gpuPlacement],
  )
  const selectorIsEmpty = Object.keys(selector).length === 0

  // ── selector toggle ──
  const toggleSelector = useCallback((key: string, value: unknown) => {
    setSelector((prev) => {
      const next = { ...prev }
      if (key in next && shallowEqual(next[key], value)) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }, [])

  const clearSelector = useCallback(() => setSelector({}), [])

  const handleDeploy = useCallback(async () => {
    if (!activeConnectionId) return
    setDeploying(true)
    setDeployError(null)
    const trimmedName = jobName.trim().length > 0 ? jobName.trim() : null
    // Preferred path: queue by catalog id — the server uses the published
    // manifest and stamps the job with backend/runtime/operator intent. The
    // manifest+knobs path is the ad-hoc escape hatch for catalog-less packs.
    const result = catalogId
      ? await deployCatalogCapability(activeConnectionId, catalogId, selector, trimmedName)
      : await deployCapability(activeConnectionId, manifestWithKnobs(manifest, knobs), selector, trimmedName)
    setDeploying(false)
    if (result.error || !result.jobId) {
      setDeployError(result.error ?? "deploy returned no job id")
      return
    }
    setLastEnqueued({ jobId: result.jobId, at: Date.now() })
    setLastJobStatus("queued")
    setAcceptanceSteps([])
    setAcceptanceOk(null)
    onOpenJob(result.jobId, trimmedName)
  }, [activeConnectionId, catalogId, manifest, knobs, selector, jobName, onOpenJob])

  const runAcceptance = useCallback(async () => {
    if (!activeConnectionId || !acceptance || acceptanceRunning) return
    setAcceptanceSteps([])
    setAcceptanceOk(null)
    setAcceptanceRunning(true)
    const result = await runAcceptanceSql(activeConnectionId, acceptance, (step) => {
      setAcceptanceSteps((prev) => [...prev, step])
    })
    setAcceptanceOk(result.ok)
    setAcceptanceRunning(false)
  }, [activeConnectionId, acceptance, acceptanceRunning])

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px] text-chrome-text">
      {/* mode hint */}
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Rocket className="h-3.5 w-3.5 text-brand-warren" />
        <span className="text-[11px] uppercase tracking-wider text-chrome-text">
          Deploy via Warren
        </span>
        <span className="text-[10px] text-chrome-text/55">
          A remote warren-agent scaffolds + builds + registers — no local docker.
        </span>
        {onUseLocalInstead ? (
          <button
            type="button"
            onClick={onUseLocalInstead}
            className="ml-auto rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[10px] text-chrome-text hover:text-foreground"
          >
            Use local install instead
          </button>
        ) : null}
      </div>

      <WarrenFlowStrip
        targetOk={eligibleMatching.length > 0}
        queued={lastEnqueued != null}
        jobStatus={lastJobStatus}
        hasAcceptance={hasAcceptance}
        acceptanceRunning={acceptanceRunning}
        acceptanceOk={acceptanceOk}
      />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-0 overflow-hidden">
        {/* left — selector builder */}
        <div className="flex h-full flex-col overflow-hidden border-r border-chrome-border">
          <div className="flex items-center gap-2 border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1">
            <Settings className="h-3 w-3 text-brand-warren" />
            <span className="text-[10px] uppercase tracking-wider text-chrome-text/65">
              target selector
            </span>
            {!selectorIsEmpty ? (
              <button
                type="button"
                onClick={clearSelector}
                className="ml-auto inline-flex items-center gap-1 text-[10px] text-chrome-text/55 hover:text-foreground"
              >
                <X className="h-3 w-3" />
                clear
              </button>
            ) : null}
          </div>
          <div className="space-y-3 overflow-auto p-3">
            <p className="text-[11px] leading-snug text-chrome-text/70">
              Toggle chips to build a label filter. Postgres matches with{" "}
              <span className="font-mono text-foreground/85">labels @&gt; selector</span>{" "}
              — every selector key must be present on a node with an equal
              value. An empty selector matches any ready node.
            </p>

            {observations.length === 0 ? (
              <div className="rounded border border-chrome-border/40 bg-secondary-background/30 p-3 text-[11px] text-chrome-text/55">
                No labels observed yet. Register at least one warren node to
                populate selector options.
              </div>
            ) : (
              <div className="space-y-2">
                {observations.map((obs) => (
                  <LabelKeyRow
                    key={obs.key}
                    observation={obs}
                    selectedValue={selector[obs.key]}
                    onToggle={(v) => toggleSelector(obs.key, v)}
                  />
                ))}
              </div>
            )}

            <div>
              <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
                selector preview
              </div>
              <pre className="overflow-auto rounded border border-chrome-border/40 bg-doc-bg p-2 font-mono text-[11px] text-foreground/85">
                {JSON.stringify(selector)}
              </pre>
            </div>

            <div>
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
                job name <span className="normal-case tracking-normal">(optional)</span>
              </div>
              <input
                type="text"
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                placeholder={manifest.name}
                className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="space-y-1.5 border-t border-chrome-border/40 pt-3">
              <Button
                size="sm"
                onClick={() => void handleDeploy()}
                disabled={
                  deploying ||
                  !activeConnectionId ||
                  (nodes.length > 0 && eligibleMatching.length === 0)
                }
                className="w-full"
                title={
                  eligibleMatching.length > 1
                    ? `One of the ${eligibleMatching.length} eligible nodes will claim the job (first poller wins)`
                    : undefined
                }
              >
                <Rocket className="h-3 w-3" />
                {deploying
                  ? "queueing…"
                  : nodes.length === 0
                    ? "queue (no warrens online)"
                    : eligibleMatching.length === 0
                      ? "no eligible nodes match selector"
                      : eligibleMatching.length === 1
                        ? `Queue deploy → ${eligibleMatching[0].node_name}`
                        : `Queue deploy · ${eligibleMatching.length} eligible nodes`}
              </Button>
              {deployError ? (
                <div className="flex items-start gap-1.5 rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  <span className="break-words">{deployError}</span>
                </div>
              ) : null}
              {lastEnqueued ? (
                <div className="flex items-center gap-1.5 rounded border border-success/40 bg-success/10 px-2 py-1.5 text-[11px] text-success">
                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                  <span className="flex-1 break-words">
                    queued · job{" "}
                    <span className="font-mono text-[10px]">
                      {lastEnqueued.jobId.slice(0, 8)}…
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenJob(lastEnqueued.jobId, null)}
                    className="rounded border border-success/40 bg-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider hover:bg-success/25"
                  >
                    open
                  </button>
                </div>
              ) : null}
              {hasAcceptance ? (
                <div className="space-y-1.5 rounded border border-chrome-border/50 bg-secondary-background/35 p-2">
                  <div className="flex items-center gap-1.5">
                    <FileCode2 className="h-3 w-3 text-success" />
                    <span className="text-[10px] uppercase tracking-wider text-chrome-text/60">
                      acceptance tests
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-chrome-text/50">
                      {acceptance?.tests?.length ?? 0}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="neutral"
                    onClick={() => void runAcceptance()}
                    disabled={!activeConnectionId || acceptanceRunning}
                    className="h-6 w-full"
                    title="Runs the pack acceptance SQL from rvbbit.capability_catalog"
                  >
                    <Play className="h-3 w-3" />
                    {acceptanceRunning ? "running tests…" : "Run acceptance SQL"}
                  </Button>
                  {acceptanceOk != null ? (
                    <div
                      className={cn(
                        "rounded px-2 py-1 text-[10px]",
                        acceptanceOk
                          ? "bg-success/10 text-success"
                          : "bg-danger/10 text-danger",
                      )}
                    >
                      {acceptanceOk ? "all tests passed" : "test failed"}
                    </div>
                  ) : null}
                  {acceptanceSteps.length > 0 ? (
                    <div className="max-h-24 space-y-1 overflow-auto">
                      {acceptanceSteps.map((step) => (
                        <div
                          key={`${step.kind}:${step.name}`}
                          className="flex items-center gap-1.5 rounded bg-foreground/[0.03] px-1.5 py-0.5 text-[10px]"
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              step.ok ? "bg-success" : "bg-danger",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">
                            {step.name}
                          </span>
                          <span className="font-mono tabular-nums text-chrome-text/45">
                            {fmtMs(step.latencyMs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p className="text-[10px] leading-snug text-chrome-text/55">
                Queues a row in <span className="font-mono">rvbbit.warren_jobs</span>;
                a matching warren-agent claims it and registers the backend or runtime.
                Knob overrides from the Overview tab are baked into the
                submitted manifest.
              </p>
            </div>
          </div>
        </div>

        {/* right — matching nodes preview */}
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-chrome-border/40 bg-chrome-bg/20 px-3 py-1">
            <Cpu className="h-3 w-3 text-brand-warren" />
            <span className="text-[10px] uppercase tracking-wider text-chrome-text/65">
              matching nodes
            </span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-foreground">
              {matching.length}
              <span className="text-chrome-text/45"> of {nodes.length}</span>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {nodes.length === 0 ? (
              <div className="grid h-full place-items-center text-[11px] text-chrome-text/45">
                No warren nodes registered.
              </div>
            ) : (
              <div className="space-y-1.5">
                {nodes.map((n) => (
                  <NodeMatchCard
                    key={n.node_id}
                    node={n}
                    matches={nodeMatchesSelector(n.labels, selector)}
                    selector={selector}
                    vramRequired={gpuReservationWanted ? vramRequired : null}
                    gpuPlacement={gpuPlacement}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function WarrenFlowStrip({
  targetOk,
  queued,
  jobStatus,
  hasAcceptance,
  acceptanceRunning,
  acceptanceOk,
}: {
  targetOk: boolean
  queued: boolean
  jobStatus: WarrenJobStatus | null
  hasAcceptance: boolean
  acceptanceRunning: boolean
  acceptanceOk: boolean | null
}) {
  const jobDone = jobStatus === "completed"
  const jobFailed = jobStatus === "failed" || jobStatus === "cancelled"
  const testsState =
    !hasAcceptance
      ? "skipped"
      : acceptanceRunning
        ? "running"
        : acceptanceOk === true
          ? "ok"
          : acceptanceOk === false
            ? "failed"
            : "pending"
  const nodes: Array<{
    key: string
    label: string
    detail: string
    state: "pending" | "running" | "ok" | "failed" | "skipped"
  }> = [
    {
      key: "target",
      label: "Target",
      detail: targetOk ? "eligible Warren" : "no match",
      state: targetOk ? "ok" : "failed",
    },
    {
      key: "queue",
      label: "Queue",
      detail: queued ? "job created" : "waiting",
      state: queued ? "ok" : "pending",
    },
    {
      key: "warren",
      label: "Warren",
      detail: jobStatus ?? "not claimed",
      state: jobFailed ? "failed" : jobDone ? "ok" : jobStatus === "running" ? "running" : "pending",
    },
    {
      key: "tests",
      label: "Tests",
      detail: !hasAcceptance
        ? "none"
        : acceptanceOk === true
          ? "passed"
          : acceptanceOk === false
            ? "failed"
            : "acceptance SQL",
      state: testsState,
    },
  ]

  return (
    <div className="border-b border-chrome-border/50 bg-doc-bg px-3 py-2">
      <div className="grid grid-cols-4 gap-2">
        {nodes.map((node, i) => (
          <div key={node.key} className="flex items-center gap-2">
            <div
              className={cn(
                "min-w-0 flex-1 rounded-md border px-2 py-1.5",
                flowTone(node.state),
              )}
            >
              <div className="flex items-center gap-1.5">
                <FlowGlyph state={node.state} />
                <span className="text-[10px] font-medium uppercase tracking-wider">
                  {node.label}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] opacity-75">
                {node.detail}
              </div>
            </div>
            {i < nodes.length - 1 ? (
              <div className="h-px w-5 shrink-0 bg-chrome-border/70" />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

function flowTone(state: "pending" | "running" | "ok" | "failed" | "skipped"): string {
  if (state === "ok") return "border-success/40 bg-success/10 text-success"
  if (state === "running") return "border-rvbbit-accent/40 bg-rvbbit-accent/10 text-rvbbit-accent"
  if (state === "failed") return "border-danger/40 bg-danger/10 text-danger"
  if (state === "skipped") return "border-chrome-border/40 bg-foreground/[0.03] text-chrome-text/50"
  return "border-chrome-border/50 bg-secondary-background/45 text-chrome-text/65"
}

function FlowGlyph({
  state,
}: {
  state: "pending" | "running" | "ok" | "failed" | "skipped"
}) {
  if (state === "ok") return <CheckCircle2 className="h-3 w-3" />
  if (state === "failed") return <X className="h-3 w-3" />
  if (state === "running") {
    return (
      <span className="relative inline-flex h-2 w-2">
        <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
        <span className="relative inline-block h-2 w-2 rounded-full bg-rvbbit-accent" />
      </span>
    )
  }
  return <Clock className="h-3 w-3" />
}

// ── helpers ─────────────────────────────────────────────────────────

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function LabelKeyRow({
  observation,
  selectedValue,
  onToggle,
}: {
  observation: WarrenLabelObservation
  selectedValue: unknown
  onToggle: (v: unknown) => void
}) {
  return (
    <div>
      <div className="mb-0.5 font-mono text-[10px] text-chrome-text/65">
        {observation.key}
      </div>
      <div className="flex flex-wrap gap-1">
        {observation.values.map((v, i) => {
          const isActive = shallowEqual(selectedValue, v)
          const label = typeof v === "string" ? v : JSON.stringify(v)
          return (
            <button
              key={i}
              type="button"
              onClick={() => onToggle(v)}
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[10px] transition",
                isActive
                  ? "border-brand-warren/50 bg-brand-warren/15 text-brand-warren"
                  : "border-chrome-border bg-secondary-background text-chrome-text hover:text-foreground",
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const HEARTBEAT_TONE: Record<NodeHeartbeatState, string> = {
  unknown: "bg-foreground/[0.05] text-chrome-text/60 ring-chrome-border/40",
  fresh: "bg-success/15 text-success ring-success/30",
  stale: "bg-warning/15 text-warning ring-warning/30",
  offline: "bg-danger/15 text-danger ring-danger/30",
}

function NodeMatchCard({
  node,
  matches,
  selector,
  vramRequired,
  gpuPlacement,
}: {
  node: WarrenInventoryRow
  matches: boolean
  selector: Record<string, unknown>
  vramRequired: number | null
  gpuPlacement: string
}) {
  const hb = nodeHeartbeatState(node.last_heartbeat)
  const vramFit = nodeFitsVram(node, vramRequired, gpuPlacement)
  const eligible =
    matches &&
    nodeIsEligible(node) &&
    (vramFit === "not_required" || vramFit === "fits")
  const missingKeys = Object.keys(selector).filter(
    (k) => !(k in node.labels) || !shallowEqual(node.labels[k], selector[k]),
  )

  return (
    <div
      className={cn(
        "rounded border bg-secondary-background/40 p-2",
        matches ? "border-brand-warren/40" : "border-chrome-border/40 opacity-60",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            eligible ? "bg-success" : matches ? "bg-warning" : "bg-chrome-text/40",
          )}
        />
        <span className="font-mono text-[11px] text-foreground">{node.node_name}</span>
        <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/65">
          {node.node_status}
        </span>
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider ring-1",
            HEARTBEAT_TONE[hb],
          )}
          title={
            node.last_heartbeat
              ? `last heartbeat ${fmtAgo(node.last_heartbeat)}`
              : "no heartbeat yet"
          }
        >
          {hb}
        </span>
        {node.gpu_count != null && node.gpu_count > 0 ? (
          <span
            className="rounded bg-warning/10 px-1 text-[9px] uppercase tracking-wider text-warning"
            title={node.gpu_names.length > 0 ? node.gpu_names.join(", ") : undefined}
          >
            {node.gpu_count}×gpu
          </span>
        ) : null}
        {vramRequired != null ? (
          <span
            className={cn(
              "rounded px-1 text-[9px] uppercase tracking-wider",
              vramFit === "fits"
                ? "bg-success/10 text-success"
                : vramFit === "insufficient"
                  ? "bg-danger/10 text-danger"
                  : "bg-warning/10 text-warning",
            )}
            title={
              node.gpu_available_bytes != null
                ? `${fmtVram(node.gpu_available_bytes)} available`
                : undefined
            }
          >
            {vramFit === "fits" ? "fits" : vramFit === "insufficient" ? "low vram" : "no gpu"}
          </span>
        ) : null}
        {node.version ? (
          <span className="ml-auto font-mono text-[9px] text-chrome-text/45">
            {node.version}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {Object.entries(node.labels).map(([k, v]) => {
          const inSelector = k in selector
          const valEqual = inSelector && shallowEqual(selector[k], v)
          const label = `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
          return (
            <span
              key={k}
              className={cn(
                "rounded px-1 py-px font-mono text-[9px]",
                inSelector && valEqual
                  ? "bg-brand-warren/15 text-brand-warren"
                  : inSelector
                    ? "bg-danger/15 text-danger line-through"
                    : "bg-foreground/[0.04] text-chrome-text/55",
              )}
            >
              {label}
            </span>
          )
        })}
      </div>
      {!matches && missingKeys.length > 0 ? (
        <div className="mt-1 text-[9px] text-chrome-text/55">
          missing: <span className="font-mono">{missingKeys.join(", ")}</span>
        </div>
      ) : null}
      {matches && vramRequired != null ? (
        <div className="mt-1 text-[9px] text-chrome-text/55">
          vram: <span className="font-mono">{fmtVram(vramRequired)}</span>
          {node.gpu_available_bytes != null ? (
            <>
              {" "}
              needs · <span className="font-mono">{fmtVram(node.gpu_available_bytes)}</span> free
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function fmtVram(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B"
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}
