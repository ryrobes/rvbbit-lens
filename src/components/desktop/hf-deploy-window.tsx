"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Heart,
  Loader2,
  Lock,
  Search,
  Sparkles,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { defaultKnobs, renderManifest } from "@/lib/rvbbit/capabilities"
import {
  HF_BROWSE_TASKS,
  buildHfManifest,
  fetchHfModel,
  hfOperatorName,
  searchHfModels,
  type HfBrowseTask,
  type HfModelInference,
  type HfSearchHit,
} from "@/lib/rvbbit/hf-models"
import type { HfDeployPayload } from "@/lib/desktop/types"
import { fmtCount } from "./instruments"
import { CapabilityInstallGraph } from "./capability-install-graph"
import { WarrenDeployPanel } from "./warren-deploy-panel"

function fmtParams(n: number | null): string | null {
  if (!n || !Number.isFinite(n)) return null
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B params`
  if (n >= 1e6) return `${Math.round(n / 1e6)}M params`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K params`
  return `${n} params`
}

// Noisy Hub tags we don't want to surface in the model card.
const TAG_NOISE = /^(transformers|pytorch|tf|jax|safetensors|onnx|gguf|region:|license:|autotrain|endpoints_compatible|text-embeddings-inference|has_space|custom_code|doi:|conversational)/i

interface HfDeployWindowProps {
  payload?: HfDeployPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenWarrenJob: (jobId: string, jobName: string | null) => void
}

function isGated(g: boolean | string): boolean {
  return g === true || g === "auto" || g === "manual"
}

/**
 * Deploy any Hugging Face model as an Rvbbit backend — no per-model pack.
 * Browse the Hub (keyless) for safe-to-serve tasks or paste an id, infer
 * the handler + operator signature from Hub metadata, then deploy to a
 * warren node via the synthesized manifest.
 */
export function HfDeployWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenWarrenJob,
}: HfDeployWindowProps) {
  // ── browse ──
  const [task, setTask] = useState<HfBrowseTask>(HF_BROWSE_TASKS[0])
  const [search, setSearch] = useState("")
  const [hits, setHits] = useState<HfSearchHit[]>([])
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  // ── paste id ──
  const [idInput, setIdInput] = useState(payload?.modelId ?? "")

  // ── selection + inference ──
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inference, setInference] = useState<HfModelInference | null>(null)
  const [inferLoading, setInferLoading] = useState(false)
  const [inferError, setInferError] = useState<string | null>(null)

  // ── deploy options ──
  const [device, setDevice] = useState("auto")
  const [nameOverride, setNameOverride] = useState("")
  const [target, setTarget] = useState<"local" | "warren">("local")

  const runInspect = useCallback(async (id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return
    setSelectedId(trimmed)
    setInference(null)
    setInferError(null)
    setNameOverride("")
    setInferLoading(true)
    const r = await fetchHfModel(trimmed)
    setInferLoading(false)
    if ("error" in r) {
      setInferError(r.error)
      return
    }
    setInference(r)
    if (r.signature) setNameOverride(hfOperatorName(r))
  }, [])

  // Inspect a pre-seeded model id once on open.
  const seeded = useRef(false)
  useEffect(() => {
    if (!seeded.current && payload?.modelId) {
      seeded.current = true
      void runInspect(payload.modelId)
    }
  }, [payload?.modelId, runInspect])

  // Debounced browse on task / search change.
  useEffect(() => {
    let stale = false
    const handle = setTimeout(async () => {
      setBrowsing(true)
      setBrowseError(null)
      const r = await searchHfModels({
        pipelineTags: task.pipelineTags,
        search: search.trim() || undefined,
        sort: "downloads",
        limit: 30,
      })
      if (stale) return
      setBrowsing(false)
      if ("error" in r) {
        setBrowseError(r.error)
        setHits([])
        return
      }
      setHits(r)
    }, 280)
    return () => {
      stale = true
      clearTimeout(handle)
    }
  }, [task, search])

  const manifest = useMemo(
    () =>
      inference
        ? buildHfManifest(inference, {
            device,
            nameOverride: nameOverride.trim() || undefined,
          })
        : null,
    [inference, device, nameOverride],
  )
  const knobs = useMemo(() => (manifest ? defaultKnobs(manifest) : null), [manifest])
  const rendered = useMemo(
    () => (manifest && knobs ? renderManifest(manifest, knobs) : null),
    [manifest, knobs],
  )

  return (
    <div className="flex h-full min-h-0">
      {/* ── left: picker ── */}
      <div className="flex w-[340px] shrink-0 flex-col border-r border-chrome-border">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-2">
          <Sparkles className="h-4 w-4 text-brand-capability" />
          <span className="text-[12px] font-semibold text-foreground">
            Hugging Face
          </span>
          <span className="text-[10px] text-chrome-text/45">browse · keyless</span>
        </div>

        {/* paste id */}
        <div className="border-b border-chrome-border/60 p-2.5">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
            Paste a model id
          </div>
          <div className="flex gap-1.5">
            <input
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runInspect(idInput)
              }}
              placeholder="BAAI/bge-small-en-v1.5"
              className="h-7 min-w-0 flex-1 rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => void runInspect(idInput)}
              className="shrink-0 rounded border border-chrome-border bg-brand-capability/15 px-2 text-[11px] text-brand-capability hover:bg-brand-capability/25"
            >
              Inspect
            </button>
          </div>
        </div>

        {/* task tabs */}
        <div className="flex flex-wrap gap-1 border-b border-chrome-border/60 p-2">
          {HF_BROWSE_TASKS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTask(t)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                t.key === task.key
                  ? "bg-brand-capability/15 text-brand-capability"
                  : "text-chrome-text/60 hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* search */}
        <div className="relative border-b border-chrome-border/60 p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${task.label.toLowerCase()} models…`}
            className="h-7 w-full rounded border border-chrome-border bg-secondary-background pl-6 pr-2 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* results */}
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {browsing ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-chrome-text/50">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching the Hub…
            </div>
          ) : browseError ? (
            <div className="px-2 py-3 text-[11px] text-destructive">{browseError}</div>
          ) : hits.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-chrome-text/45">
              No models found.
            </div>
          ) : (
            hits.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => void runInspect(h.id)}
                className={cn(
                  "group flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left",
                  selectedId === h.id
                    ? "bg-brand-capability/15"
                    : "hover:bg-chrome-bg/40",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                    {h.id}
                  </span>
                  {isGated(h.gated) ? (
                    <Lock className="h-3 w-3 shrink-0 text-warning" />
                  ) : null}
                </div>
                <div className="flex items-center gap-3 text-[9px] text-chrome-text/45">
                  <span className="inline-flex items-center gap-0.5">
                    <Download className="h-2.5 w-2.5" /> {fmtCount(h.downloads)}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Heart className="h-2.5 w-2.5" /> {fmtCount(h.likes)}
                  </span>
                  {h.library ? (
                    <span className="truncate">{h.library}</span>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── right: inference + deploy ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedId ? (
          <Placeholder />
        ) : inferLoading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-chrome-text/50">
            <Loader2 className="h-4 w-4 animate-spin" /> Inferring {selectedId}…
          </div>
        ) : inferError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <div className="text-[12px] text-foreground">Couldn&apos;t inspect {selectedId}</div>
            <div className="max-w-md text-[11px] text-chrome-text/55">{inferError}</div>
          </div>
        ) : inference && !inference.supported ? (
          <UnsupportedCard inference={inference} />
        ) : inference && manifest && knobs && rendered ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="max-h-[52%] shrink-0 overflow-auto">
              <InferenceHeader
                inference={inference}
                nameOverride={nameOverride}
                onNameChange={setNameOverride}
                device={device}
                onDeviceChange={setDevice}
              />
            </div>
            {/* deploy-target toggle */}
            <div className="flex shrink-0 items-center gap-1 border-b border-chrome-border bg-chrome-bg/20 px-3 py-1.5">
              <span className="mr-1 text-[10px] uppercase tracking-wider text-chrome-text/45">
                Deploy to
              </span>
              <TargetChip active={target === "local"} onClick={() => setTarget("local")} label="Local" hint="scaffold + docker compose up on this machine" />
              <TargetChip active={target === "warren"} onClick={() => setTarget("warren")} label="Warren" hint="queue a remote warren-agent deploy" />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {!hasRvbbit ? (
                <div className="grid h-full place-items-center p-6 text-center text-[11px] text-chrome-text/50">
                  Connect to an rvbbit database to deploy.
                </div>
              ) : target === "warren" ? (
                <WarrenDeployPanel
                  activeConnectionId={activeConnectionId}
                  catalogId={null}
                  manifest={manifest}
                  knobs={knobs}
                  acceptance={null}
                  onUseLocalInstead={() => setTarget("local")}
                  onOpenJob={onOpenWarrenJob}
                />
              ) : (
                <CapabilityInstallGraph
                  activeConnectionId={activeConnectionId}
                  manifestYaml={rendered.manifestYaml}
                  manifest={manifest}
                  knobs={knobs}
                  rendered={rendered}
                />
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TargetChip({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "rounded px-2 py-0.5 text-[11px]",
        active
          ? "bg-brand-capability/15 text-brand-capability"
          : "text-chrome-text/60 hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
}

function Placeholder() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Sparkles className="h-6 w-6 text-brand-capability/50" />
      <div className="text-[12px] text-foreground">Deploy any Hugging Face model</div>
      <div className="max-w-sm text-[11px] leading-snug text-chrome-text/55">
        Pick a model on the left (or paste an id). We read the Hub metadata,
        infer the serving handler + operator signature, then deploy it to a
        warren node — no per-model pack required.
      </div>
    </div>
  )
}

function UnsupportedCard({ inference }: { inference: HfModelInference }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="h-5 w-5 text-warning" />
      <div className="font-mono text-[12px] text-foreground">{inference.id}</div>
      <div className="text-[11px] uppercase tracking-wider text-chrome-text/45">
        Not servable by the generic backend
      </div>
      <div className="max-w-md text-[11px] leading-snug text-chrome-text/60">
        {inference.reason}
      </div>
      {inference.pipelineTag ? (
        <div className="text-[10px] text-chrome-text/40">
          pipeline_tag: <span className="font-mono">{inference.pipelineTag}</span>
        </div>
      ) : null}
    </div>
  )
}

function InferenceHeader({
  inference,
  nameOverride,
  onNameChange,
  device,
  onDeviceChange,
}: {
  inference: HfModelInference
  nameOverride: string
  onNameChange: (v: string) => void
  device: string
  onDeviceChange: (v: string) => void
}) {
  const sig = inference.signature!
  return (
    <div className="border-b border-chrome-border bg-chrome-bg/30 p-3">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span className="font-mono text-[12px] text-foreground">{inference.id}</span>
        <span className="rounded-full bg-brand-capability/15 px-2 py-px text-[10px] text-brand-capability">
          {inference.task}
        </span>
        {inference.isCrossEncoder ? (
          <span className="rounded-full bg-chart-4/15 px-2 py-px text-[10px] text-chart-4">
            cross-encoder
          </span>
        ) : null}
        {inference.sequenceMode ? (
          <span className="rounded-full bg-secondary-background px-2 py-px text-[10px] text-chrome-text/70">
            {inference.sequenceMode}
          </span>
        ) : null}
        {inference.maxLength ? (
          <span className="ml-auto text-[10px] text-chrome-text/45">
            ctx {inference.maxLength.toLocaleString()}
          </span>
        ) : null}
      </div>

      {/* description */}
      {inference.card.description ? (
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/70">
          {inference.card.description}
        </p>
      ) : null}

      {/* stats row */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-chrome-text/50">
        {fmtParams(inference.card.params) ? (
          <span className="text-chrome-text/70">{fmtParams(inference.card.params)}</span>
        ) : null}
        <span className="inline-flex items-center gap-0.5">
          <Download className="h-2.5 w-2.5" /> {fmtCount(inference.card.downloads)}
        </span>
        <span className="inline-flex items-center gap-0.5">
          <Heart className="h-2.5 w-2.5" /> {fmtCount(inference.card.likes)}
        </span>
        {inference.card.license ? <span>· {inference.card.license}</span> : null}
        {inference.card.languages.length ? (
          <span>· {inference.card.languages.slice(0, 4).join(", ")}</span>
        ) : null}
        {inference.card.lastModified ? (
          <span>· updated {inference.card.lastModified.slice(0, 10)}</span>
        ) : null}
        {inference.gated ? (
          <span className="inline-flex items-center gap-0.5 text-warning">
            <Lock className="h-2.5 w-2.5" /> gated
          </span>
        ) : null}
      </div>

      {/* curated tags */}
      {(() => {
        const tags = inference.card.tags.filter((t) => !TAG_NOISE.test(t)).slice(0, 7)
        return tags.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="rounded bg-secondary-background px-1.5 py-px text-[9px] text-chrome-text/60"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null
      })()}

      {/* operator signature */}
      <div className="mt-2 flex items-center gap-1 font-mono text-[11px]">
        <span className="text-brand-capability">rvbbit.{nameOverride || inference.id}</span>
        <span className="text-chrome-text/50">(</span>
        {sig.argNames.map((a, i) => (
          <span key={a} className="text-chrome-text/80">
            {a}
            <span className="text-chrome-text/40"> {sig.argTypes[i]}</span>
            {i < sig.argNames.length - 1 ? <span className="text-chrome-text/50">, </span> : null}
          </span>
        ))}
        <span className="text-chrome-text/50">) → </span>
        <span className="text-chrome-text/80">{sig.returnType}</span>
      </div>

      {/* labels */}
      {inference.labels && inference.labels.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {inference.labels.slice(0, 12).map((l) => (
            <span
              key={l}
              className="rounded bg-secondary-background px-1.5 py-px text-[9px] text-chrome-text/70"
            >
              {l}
            </span>
          ))}
          {inference.labels.length > 12 ? (
            <span className="px-1 text-[9px] text-chrome-text/40">
              +{inference.labels.length - 12}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* notes */}
      {inference.notes.length ? (
        <ul className="mt-1.5 space-y-0.5">
          {inference.notes.map((n) => (
            <li key={n} className="text-[10px] leading-snug text-chrome-text/55">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}

      {/* name + device */}
      <div className="mt-2.5 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
            Operator / backend name
          </div>
          <input
            value={nameOverride}
            onChange={(e) => onNameChange(e.target.value)}
            className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
            Device
          </div>
          <div className="inline-flex overflow-hidden rounded border border-chrome-border bg-secondary-background">
            {["auto", "cpu", "cuda"].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onDeviceChange(d)}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono",
                  device === d
                    ? "bg-brand-capability/15 text-brand-capability"
                    : "text-chrome-text hover:text-foreground",
                )}
              >
                {d === "cuda" ? <Cpu className="h-3 w-3" /> : null}
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
