"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Rocket,
  Settings,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { InstallKnobs, Manifest } from "@/lib/rvbbit/capabilities"
import {
  deployCapability,
  fetchWarrenInventory,
  fetchWarrenLabelObservations,
  manifestWithKnobs,
  nodeHeartbeatState,
  nodeIsEligible,
  nodeMatchesSelector,
  uniqueNodesFromInventory,
  type NodeHeartbeatState,
  type WarrenInventoryRow,
  type WarrenLabelObservation,
} from "@/lib/rvbbit/warren"
import { fmtAgo } from "./instruments"

interface WarrenDeployPanelProps {
  activeConnectionId: string | null
  manifest: Manifest
  knobs: InstallKnobs
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
  manifest,
  knobs,
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

  // ── derive nodes + match preview ──
  const nodes = useMemo(() => uniqueNodesFromInventory(inventory), [inventory])
  const matching = useMemo(
    () => nodes.filter((n) => nodeMatchesSelector(n.labels, selector)),
    [nodes, selector],
  )
  const eligibleMatching = useMemo(
    () =>
      matching.filter((n) =>
        nodeIsEligible({ status: n.node_status, last_heartbeat: n.last_heartbeat }),
      ),
    [matching],
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
    const final = manifestWithKnobs(manifest, knobs)
    const result = await deployCapability(
      activeConnectionId,
      final,
      selector,
      jobName.trim().length > 0 ? jobName.trim() : null,
    )
    setDeploying(false)
    if (result.error || !result.jobId) {
      setDeployError(result.error ?? "deploy returned no job id")
      return
    }
    setLastEnqueued({ jobId: result.jobId, at: Date.now() })
    onOpenJob(result.jobId, jobName.trim().length > 0 ? jobName.trim() : null)
  }, [activeConnectionId, manifest, knobs, selector, jobName, onOpenJob])

  return (
    <div className="flex h-full min-h-0 flex-col bg-doc-bg text-[12px] text-chrome-text">
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
              <p className="text-[10px] leading-snug text-chrome-text/55">
                Queues a row in <span className="font-mono">rvbbit.warren_jobs</span>;
                a matching warren-agent claims it and registers the backend.
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
}: {
  node: WarrenInventoryRow
  matches: boolean
  selector: Record<string, unknown>
}) {
  const hb = nodeHeartbeatState(node.last_heartbeat)
  const eligible = matches && nodeIsEligible({ status: node.node_status, last_heartbeat: node.last_heartbeat })
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
          <span className="rounded bg-warning/10 px-1 text-[9px] uppercase tracking-wider text-warning">
            {node.gpu_count}×gpu
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
    </div>
  )
}
