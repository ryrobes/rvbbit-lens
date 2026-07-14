"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  FileCode2,
  Loader2,
  FlowArrow,
  Layers,
  Package,
  Play,
  Plug,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { RvbbitLogo } from "./rvbbit-logo"
import { Button } from "@/components/ui/button"
import {
  classifyManifestCapabilityType,
  defaultKnobs,
  fetchCatalog,
  fetchInstalledBackends,
  fetchInstalledRuntimes,
  fetchManifest,
  flagsToStates,
  isExternalBackendManifest,
  isSqlTestManifest,
  isRuntimeManifest,
  joinCatalogToInstalled,
  probeBackend,
  probeRuntime,
  renderManifest,
  runAcceptanceSql,
  type CatalogEntry,
  type AcceptanceRunStep,
  type InstallKnobs,
  type VllmKnobs,
  type InstalledBackend,
  type InstalledRuntime,
  type JoinedCatalogEntry,
  type Manifest,
  type ProbeResult,
  type RenderedArtifacts,
} from "@/lib/rvbbit/capabilities"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  Histogram,
  InstallStateBadgeGroup,
  Metric,
  Panel,
  percentile,
} from "./instruments"
import type { CapabilityDetailPayload } from "@/lib/desktop/types"
import { usePolling } from "@/lib/desktop/use-polling"
import { CodePreview, type CodeLang } from "./code-preview"
import { CapabilityInstallGraph } from "./capability-install-graph"
import { WarrenDeployPanel } from "./warren-deploy-panel"
import { fetchWarrenAvailability, type WarrenAvailability } from "@/lib/rvbbit/warren"
import { McpInstallPanel } from "./mcp-install-panel"
import { listMcpCapabilities, type McpCapability } from "@/lib/rvbbit/mcp"

interface CapabilityDetailWindowProps {
  payload: CapabilityDetailPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSpecialist: (specialistName: string) => void
  onOpenOperator: (operatorName: string) => void
  onOpenWarrenJob: (jobId: string, jobName: string | null) => void
  onOpenHindsightMemory?: () => void
}

type TabKey = "overview" | "generated-sql" | "probe" | "install" | "tests"
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "generated-sql", label: "Generated SQL" },
  { key: "probe", label: "Probe" },
  { key: "install", label: "Install" },
  { key: "tests", label: "Tests" },
]
// MCP capabilities have no model artifacts (no generated SQL / probe / accept
// tests) — they introduce *tools* via the gateway. So they get a focused
// two-tab surface: what it adds, and the keys+install form.
const MCP_TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "install", label: "Install" },
]
const SQL_TEST_TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "generated-sql", label: "Generated SQL" },
  { key: "tests", label: "Tests" },
]
// Hosted (rvbbit.ai) capabilities are catalog-only: no local probe, no install
// knobs, no generated-SQL scaffold. Overview is a value-prop page; Install
// shows the metadata-only SQL.
const MANAGED_TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "install", label: "Install" },
]

export function CapabilityDetailWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenSpecialist,
  onOpenOperator,
  onOpenWarrenJob,
  onOpenHindsightMemory,
}: CapabilityDetailWindowProps) {
  const [catalog, setCatalog] = useState<CatalogEntry | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [installed, setInstalled] = useState<InstalledBackend | null>(null)
  const [installedRuntime, setInstalledRuntime] = useState<InstalledRuntime | null>(null)
  const [knobs, setKnobs] = useState<InstallKnobs | null>(null)
  const [mcpCap, setMcpCap] = useState<McpCapability | null>(null)
  const [tab, setTab] = useState<TabKey>(payload.initialTab ?? "overview")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [warrenAvail, setWarrenAvail] = useState<WarrenAvailability | null>(null)
  const [makeDefaultEmbedder, setMakeDefaultEmbedder] = useState(false)
  /**
   * When `null`, the install pathway is chosen by warren availability:
   *   readyNodes > 0 ⇒ "warren", else "local".
   * As soon as the user toggles, we lock to their choice for the life
   * of the window so a node going offline doesn't yank them mid-task.
   */
  const [installMode, setInstallMode] = useState<"warren" | "local" | null>(null)
  const loading = catalog == null || manifest == null

  // ── load catalog entry + manifest on mount / when id changes ──
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const cat = await fetchCatalog(activeConnectionId)
      if (cancelled) return
      const entry =
        cat.doc?.capabilities.find((c) => c.id === payload.catalogId) ?? null
      if (!entry) {
        setLoadError(cat.error ?? `no catalog entry for ${payload.catalogId}`)
        return
      }
      setCatalog(entry)
      // DB catalog rows carry the manifest inline; only fall back to the
      // disk YAML read for catalog.json (file-source) entries.
      let m: Manifest | null = entry.manifest ?? null
      if (!m) {
        const loaded = await fetchManifest(entry.manifest_path)
        if (cancelled) return
        if (loaded.error || !loaded.manifest) {
          setLoadError(loaded.error ?? "manifest load failed")
          return
        }
        m = loaded.manifest
      }
      if (entry.resources && Object.keys(entry.resources).length > 0) {
        m = { ...m, resources: m.resources ?? entry.resources }
      }
      setManifest(m)
      setKnobs(defaultKnobs(m))
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [payload.catalogId, activeConnectionId])

  // ── MCP capabilities: load the install-time shape (keys + surface) ──
  // Reuses the exact catalog query the MCP servers window uses, so the
  // declared-secret list and tool/resource counts match one-for-one.
  const isMcp = catalog?.kind === "mcp"
  const isManaged = catalog?.kind === "managed"
  useEffect(() => {
    if (!activeConnectionId || !isMcp || !catalog) return
    let cancelled = false
    const run = async () => {
      const r = await listMcpCapabilities(activeConnectionId)
      if (cancelled) return
      setMcpCap(r.caps.find((c) => c.id === catalog.id) ?? null)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, isMcp, catalog])

  // ── poll installed-backend row to keep the join fresh ──
  const pollInstalled = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit || !catalog) return
    const [b, rt] = await Promise.all([
      fetchInstalledBackends(activeConnectionId),
      fetchInstalledRuntimes(activeConnectionId),
    ])
    const join = joinCatalogToInstalled([catalog], b.backends, rt.runtimes)
    setInstalled(join.entries[0]?.installed ?? null)
    setInstalledRuntime(join.entries[0]?.installedRuntime ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, hasRvbbit, catalog])

  usePolling(pollInstalled, 5000, {
    enabled: !!activeConnectionId && hasRvbbit,
    resetKey: activeConnectionId,
  })

  // ── poll warren availability so the Install tab can default-route ──
  const probeWarren = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchWarrenAvailability(activeConnectionId)
    setWarrenAvail(r)
  }, [activeConnectionId])
  usePolling(probeWarren, 10_000, {
    enabled: !!activeConnectionId && hasRvbbit,
    resetKey: activeConnectionId,
  })

  const externalBackend = !!manifest && isExternalBackendManifest(manifest)
  const isSqlTest = !!manifest && isSqlTestManifest(manifest)
  const activeTab: TabKey =
    isSqlTest && (tab === "probe" || tab === "install") ? "tests" : tab

  /** Effective install mode — explicit user choice wins, else availability decides. */
  const effectiveInstallMode: "warren" | "local" =
    installMode ??
    (!externalBackend && warrenAvail?.available && warrenAvail.readyNodes > 0 ? "warren" : "local")

  // ── live render (the Bret Victor lever) ──
  const rendered: RenderedArtifacts | null = useMemo(() => {
    // MCP manifests have no model artifacts to render (and renderManifest
    // assumes the model shape) — the MCP branch never reads `rendered`.
    if (!manifest || !knobs || manifest.kind === "mcp") return null
    return renderManifest(manifest, knobs)
  }, [manifest, knobs])

  const isEmbeddingCapability = useMemo(
    () => !!manifest && classifyManifestCapabilityType(manifest) === "embedding",
    [manifest],
  )
  const defaultEmbedderActive = installed?.is_default_embedder_source === true
  const isHindsight = useMemo(() => {
    if (!catalog || !manifest) return false
    const tags = new Set([...(catalog.tags ?? []), ...(manifest.tags ?? [])].map((tag) => String(tag).toLowerCase()))
    return (
      catalog.id === "memory/hindsight-slim" ||
      manifest.name === "hindsight_slim" ||
      tags.has("hindsight")
    )
  }, [catalog, manifest])

  const join: JoinedCatalogEntry | null = useMemo(() => {
    if (!catalog) return null
    const j = joinCatalogToInstalled(
      [catalog],
      installed ? [installed] : [],
      installedRuntime ? [installedRuntime] : [],
    )
    return j.entries[0] ?? null
  }, [catalog, installed, installedRuntime])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text/70">
        No pg_rvbbit extension on this connection.
      </div>
    )
  }
  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-danger">
        <div>
          <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
          {loadError}
        </div>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-chrome-text">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3 w-3 animate-pulse" />
          Loading {payload.catalogId}…
        </span>
      </div>
    )
  }

  const states = join ? flagsToStates(join.flags) : []

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Package className="h-4 w-4 text-brand-capability" />
        <span className="text-[13px] font-medium text-foreground">{catalog!.title}</span>
        <span className="font-mono text-[10px] text-chrome-text/55">{catalog!.name}</span>
        {catalog!.license ? (
          <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/65">
            {catalog!.license}
          </span>
        ) : null}
        {catalog!.vram_required_bytes != null ? (
          <span
            className="rounded bg-warning/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-warning"
            title={catalog!.gpu_required ? "GPU reservation required" : "GPU reservation when targeting a GPU Warren"}
          >
            gpu {fmtBytes(catalog!.vram_required_bytes)}
          </span>
        ) : null}
        <InstallStateBadgeGroup states={states} size="xs" />
        {join?.installed && catalog!.backend_name ? (
          <button
            type="button"
            onClick={() => onOpenSpecialist(catalog!.backend_name!)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-specialists/40 bg-brand-specialists/10 px-2 py-0.5 text-[10px] text-brand-specialists hover:bg-brand-specialists/15"
            title="Open the registered backend in the Specialist Detail window"
          >
            <Brain className="h-3 w-3" />
            backend
          </button>
        ) : null}
        {join?.installedRuntime ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-2 py-0.5 text-[10px] text-brand-capability"
            title={`Execution runtime ${join.installedRuntime.name} — status ${join.installedRuntime.status}`}
          >
            <FileCode2 className="h-3 w-3" />
            runtime · {join.installedRuntime.status}
          </span>
        ) : null}
        {isHindsight && onOpenHindsightMemory ? (
          <button
            type="button"
            onClick={onOpenHindsightMemory}
            className="inline-flex items-center gap-1 rounded-full border border-brand-specialists/40 bg-brand-specialists/10 px-2 py-0.5 text-[10px] text-brand-specialists hover:bg-brand-specialists/15"
            title="Open Hindsight Memory"
          >
            <Brain className="h-3 w-3" />
            memory
          </button>
        ) : null}
        {catalog!.operators.map((opName) => (
          <button
            key={opName}
            type="button"
            onClick={() => onOpenOperator(opName)}
            className="inline-flex items-center gap-1 rounded-full border border-brand-operators/40 bg-brand-operators/10 px-2 py-0.5 text-[10px] text-brand-operators hover:bg-brand-operators/15"
            title={`Open rvbbit.${opName} in Operator Flow`}
          >
            <FlowArrow className="h-3 w-3" />
            {opName}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void pollInstalled()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* tab bar */}
      <div className="flex items-center gap-px border-b border-chrome-border bg-chrome-bg/20 px-2">
        {(isMcp ? MCP_TABS : isManaged ? MANAGED_TABS : isSqlTest ? SQL_TEST_TABS : TABS).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "border-b-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition",
              activeTab === t.key
                ? "border-brand-capability text-brand-capability"
                : "border-transparent text-chrome-text/65 hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isMcp ? (
          activeTab === "install" ? (
            <div className="h-full overflow-auto p-3">
              {mcpCap ? (
                <McpInstallPanel
                  connId={activeConnectionId}
                  cap={mcpCap}
                  onInstalled={() => void pollInstalled()}
                />
              ) : (
                <div className="grid h-full place-items-center text-[11px] text-chrome-text/60">
                  loading capability…
                </div>
              )}
            </div>
          ) : (
            <McpOverviewTab catalog={catalog!} manifest={manifest!} cap={mcpCap} />
          )
        ) : isManaged ? (
          activeTab === "install" ? (
            <ManagedInstallTab
              manifest={manifest!}
              rendered={rendered}
              activeConnectionId={activeConnectionId}
              onInstalled={() => void pollInstalled()}
            />
          ) : (
            <ManagedOverviewTab catalog={catalog!} manifest={manifest!} />
          )
        ) : (
          <>
        {activeTab === "overview" ? (
          <OverviewTab
            catalog={catalog!}
            manifest={manifest!}
            installed={installed}
            knobs={knobs!}
            onChangeKnobs={setKnobs}
          />
        ) : null}
        {activeTab === "generated-sql" ? (
          <GeneratedSqlTab rendered={rendered!} />
        ) : null}
        {activeTab === "probe" && !isSqlTest ? (
          <ProbeTab
            activeConnectionId={activeConnectionId}
            manifest={manifest!}
            registered={!!installed || !!installedRuntime}
          />
        ) : null}
        {activeTab === "install" && !isSqlTest ? (
          <InstallTabDispatcher
            mode={effectiveInstallMode}
            warrenAvail={warrenAvail}
            setMode={setInstallMode}
            activeConnectionId={activeConnectionId}
            catalogId={catalog!.catalog_source === "file" ? null : catalog!.id}
            manifestPath={catalog!.manifest_path}
            manifest={manifest!}
            knobs={knobs!}
            rendered={rendered!}
            isEmbeddingCapability={isEmbeddingCapability}
            makeDefaultEmbedder={makeDefaultEmbedder && !defaultEmbedderActive}
            defaultEmbedderActive={defaultEmbedderActive}
            onMakeDefaultEmbedderChange={setMakeDefaultEmbedder}
            onInstalledChanged={() => void pollInstalled()}
            onOpenWarrenJob={onOpenWarrenJob}
            acceptance={catalog!.acceptance}
          />
        ) : null}
        {activeTab === "tests" ? (
          <AcceptanceTestsTab
            activeConnectionId={activeConnectionId}
            catalog={catalog!}
          />
        ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// ── MCP overview tab ─────────────────────────────────────────────────
// An MCP capability introduces *tools* (→ operators) and *resources*
// (→ tables-as-functions) over the gateway. This pane shows what it adds and
// what it needs, mirroring how a Warren specialist's overview reads — but
// sourced from the MCP manifest's tool/resource surface, not a model card.

interface McpManifestView {
  description?: string
  tools?: Array<{ name?: string; description?: string }>
  resources?: Array<{ name?: string; uri?: string; description?: string }>
  connection?: { command?: string; args?: string[]; transport?: string }
  surface?: { n_tools?: number; n_resources?: number }
}

function McpFact({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-chrome-border bg-chrome-bg/40 px-2.5 py-1.5">
      <div className="font-mono text-[15px] leading-none text-foreground">{value}</div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-chrome-text/55">{label}</div>
    </div>
  )
}

function McpOverviewTab({
  catalog,
  manifest,
  cap,
}: {
  catalog: CatalogEntry
  manifest: Manifest
  cap: McpCapability | null
}) {
  const m = manifest as unknown as McpManifestView
  const tools = m.tools ?? []
  const resources = m.resources ?? []
  const conn = m.connection ?? {}
  const description = catalog.description ?? m.description ?? null
  const cmdline = [conn.command, ...(conn.args ?? [])].filter(Boolean).join(" ")
  const secrets = cap?.secrets ?? []

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      {description ? (
        <p className="text-[12px] leading-relaxed text-chrome-text/85">{description}</p>
      ) : null}

      <div className="grid grid-cols-4 gap-1.5">
        <McpFact label="tools" value={tools.length || cap?.nTools || 0} />
        <McpFact label="tables" value={resources.length || cap?.nResources || 0} />
        <McpFact label="operators" value={catalog.operators.length} />
        <McpFact label="keys" value={secrets.length} />
      </div>

      {conn.transport || cmdline ? (
        <div className="rounded border border-chrome-border bg-chrome-bg/30 px-2.5 py-1.5">
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/50">connection</div>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-chrome-text/75">
            {conn.transport ? (
              <span className="rounded bg-foreground/[0.06] px-1 py-px uppercase">{conn.transport}</span>
            ) : null}
            {cmdline ? <span className="truncate">{cmdline}</span> : null}
          </div>
        </div>
      ) : null}

      {tools.length > 0 ? (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text/50">
            <FlowArrow className="h-3 w-3" /> tools → operators
          </div>
          <div className="space-y-1">
            {tools.map((t, i) => (
              <div
                key={t.name ?? i}
                className="rounded border border-chrome-border bg-chrome-bg/30 px-2 py-1"
              >
                <div className="font-mono text-[11px] text-foreground">{t.name}</div>
                {t.description ? (
                  <div className="mt-0.5 line-clamp-2 text-[10px] text-chrome-text/60">{t.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {resources.length > 0 ? (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text/50">
            <Layers className="h-3 w-3" /> resources → tables
          </div>
          <div className="space-y-1">
            {resources.map((r, i) => (
              <div
                key={r.name ?? r.uri ?? i}
                className="rounded border border-chrome-border bg-chrome-bg/30 px-2 py-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-foreground">{r.name ?? r.uri}</span>
                  {r.uri && r.name ? (
                    <span className="truncate font-mono text-[9px] text-chrome-text/45">{r.uri}</span>
                  ) : null}
                </div>
                {r.description ? (
                  <div className="mt-0.5 line-clamp-2 text-[10px] text-chrome-text/60">{r.description}</div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {secrets.length > 0 ? (
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text/50">
            <Plug className="h-3 w-3" /> required keys
          </div>
          <div className="space-y-1">
            {secrets.map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between rounded border border-chrome-border bg-chrome-bg/30 px-2 py-1 text-[10px]"
              >
                <span className="font-mono text-chrome-text/80">
                  {s.label}
                  {s.required ? <span className="text-danger"> *</span> : null}
                </span>
                {s.link ? (
                  <a href={s.link} target="_blank" rel="noreferrer" className="text-rvbbit-accent hover:underline">
                    get a key →
                  </a>
                ) : (
                  <span className="text-chrome-text/45">{s.help || "secret"}</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 text-[9px] leading-snug text-chrome-text/45">
            Provide these in the <span className="text-chrome-text/70">Install</span> tab — they go to the
            gateway&apos;s encrypted store, never Postgres.
          </div>
        </div>
      ) : null}

      {catalog.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {catalog.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-chrome-border bg-foreground/[0.04] px-1.5 py-px text-[9px] text-chrome-text/60"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── Overview tab ────────────────────────────────────────────────────

// ── Managed (rvbbit.ai hosted) render mode ──────────────────────────────
// Hosted capabilities are catalog-only: no local install knobs, no probe.
// The overview is a value-prop page; copy is data-driven from manifest.managed.

function ManagedSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-chrome-text/50">
      {children}
    </div>
  )
}

function ManagedFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wider text-chrome-text/40">{label}</div>
      <div className={cn("truncate text-chrome-text/80", mono && "font-mono")} title={value}>
        {value}
      </div>
    </div>
  )
}

function ManagedOverviewTab({
  catalog,
  manifest,
}: {
  catalog: CatalogEntry
  manifest: Manifest
}) {
  const managed = manifest.managed
  if (!managed) return null
  const gold = "var(--cap-type-managed, #d4a017)"
  const operators = manifest.operators ?? []
  const price = managed.pricing?.monthly_usd
  const comingSoon = managed.status === "coming_soon"
  const hasTiers = (managed.pricing?.tiers?.length ?? 0) > 0

  return (
    <div className="h-full overflow-auto">
      {/* hero */}
      <div
        className="border-b border-chrome-border/60 p-4"
        style={{
          background: `linear-gradient(180deg, color-mix(in oklch, ${gold} 8%, transparent), transparent)`,
        }}
      >
        <div className="flex items-center gap-2">
          <RvbbitLogo className="h-3.5 w-auto" style={{ color: gold }} />
          <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: gold }}>
            rvbbit Cloud · hosted
          </span>
          {comingSoon ? (
            <span className="rounded-full border border-chrome-border/60 px-1.5 py-px text-[9px] text-chrome-text/60">
              coming soon
            </span>
          ) : null}
        </div>
        <h2 className="mt-1 text-[16px] font-semibold text-foreground">{catalog.title}</h2>
        {managed.tagline ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-chrome-text/75">{managed.tagline}</p>
        ) : catalog.description ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-chrome-text/75">{catalog.description}</p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {managed.verified?.tests ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              style={{
                color: gold,
                background: `color-mix(in oklch, ${gold} 12%, transparent)`,
                border: `1px solid color-mix(in oklch, ${gold} 40%, transparent)`,
              }}
              title={`Semantic Tests battery · ${managed.verified.regime ?? ""} · ${managed.verified.battery_date ?? ""}${managed.verified.note ? ` · ${managed.verified.note}` : ""}`}
            >
              <CheckCircle2 className="h-3 w-3" /> verified {managed.verified.passed}/{managed.verified.tests}
            </span>
          ) : null}
          {price && !comingSoon ? (
            hasTiers ? (
              <span className="text-[12px] font-semibold" style={{ color: gold }}>
                {managed.pricing?.tiers?.some((t) => t.monthly_usd === 0)
                  ? `Free tier · paid from $${price}/mo`
                  : `from $${price}/mo`}
              </span>
            ) : managed.pricing?.checkout_url ? (
              <a
                href={managed.pricing.checkout_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded px-3 py-1 text-[12px] font-semibold hover:brightness-110"
                style={{ background: gold, color: "#1a1400" }}
              >
                Subscribe · ${price}/mo
              </a>
            ) : (
              <span className="text-[12px] font-semibold" style={{ color: gold }}>
                ${price}/mo
              </span>
            )
          ) : null}
          {managed.pricing?.note ? (
            <span className="text-[10px] text-chrome-text/55">{managed.pricing.note}</span>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 p-4">
        {hasTiers ? (
          <div>
            <ManagedSectionTitle>Plans · pick a lane count</ManagedSectionTitle>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {managed.pricing!.tiers!.map((tier) => {
                const isContact = tier.monthly_usd == null && !tier.checkout_url
                const href = isContact
                  ? tier.contact_email
                    ? `mailto:${tier.contact_email}?subject=${encodeURIComponent(`${catalog.title} — custom plan`)}`
                    : undefined
                  : tier.checkout_url
                return (
                  <a
                    key={tier.name}
                    href={href}
                    target={isContact ? undefined : "_blank"}
                    rel="noreferrer"
                    className={cn(
                      "flex flex-col gap-0.5 rounded-md border p-2 transition",
                      href ? "hover:brightness-125" : "pointer-events-none opacity-70",
                    )}
                    style={{ borderColor: `color-mix(in oklch, ${gold} 30%, transparent)` }}
                  >
                    <span className="text-[11px] font-medium text-foreground">{tier.name}</span>
                    <span className="text-[13px] font-semibold" style={{ color: gold }}>
                      {isContact ? "Email us" : tier.monthly_usd === 0 ? "Free" : `$${tier.monthly_usd}`}
                      {isContact || tier.monthly_usd === 0 ? "" : <span className="text-[9px] text-chrome-text/50">/mo</span>}
                    </span>
                    <span className="text-[10px] text-chrome-text/55">
                      {tier.lanes == null
                        ? isContact
                          ? "more lanes · custom"
                          : ""
                        : `${tier.lanes} lane${tier.lanes === 1 ? "" : "s"}`}
                    </span>
                  </a>
                )
              })}
            </div>
            <p className="mt-1 text-[9px] leading-snug text-chrome-text/45">
              Same install at every tier — your key carries the lane count, so nothing tier-specific to configure.
              A lane = one operation in flight.
            </p>
          </div>
        ) : null}

        {managed.free_tier ? (
          <div
            className="rounded-md border p-2.5"
            style={{
              borderColor: `color-mix(in oklch, ${gold} 35%, transparent)`,
              background: `color-mix(in oklch, ${gold} 6%, transparent)`,
            }}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: gold }}>
              <RvbbitLogo className="h-2.5 w-auto" /> Free tier
            </div>
            <p className="mt-1 text-[11px] leading-snug text-chrome-text/80">{managed.free_tier.note}</p>
            {managed.free_tier.cta_url ? (
              <a
                href={managed.free_tier.cta_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] hover:brightness-125"
                style={{ borderColor: `color-mix(in oklch, ${gold} 50%, transparent)`, color: gold }}
              >
                Try it free
              </a>
            ) : null}
          </div>
        ) : null}

        {(managed.value_props ?? []).length > 0 ? (
          <div>
            <ManagedSectionTitle>Why hosted</ManagedSectionTitle>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {managed.value_props!.map((vp) => (
                <div
                  key={vp.title}
                  className="rounded border border-chrome-border/50 bg-foreground/[0.02] p-2"
                >
                  <div className="flex items-center gap-1 text-[11px] font-medium text-foreground">
                    <CheckCircle2 className="h-3 w-3 shrink-0" style={{ color: gold }} /> {vp.title}
                  </div>
                  {vp.detail ? (
                    <p className="mt-0.5 text-[10px] leading-snug text-chrome-text/65">{vp.detail}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {(managed.highlights ?? []).length > 0 ? (
          <ul className="space-y-1">
            {managed.highlights!.map((h, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-chrome-text/80">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" style={{ color: gold }} /> {h}
              </li>
            ))}
          </ul>
        ) : null}

        {operators.length > 0 ? (
          <div>
            <ManagedSectionTitle>Operators ({operators.length})</ManagedSectionTitle>
            <div className="flex flex-wrap gap-1">
              {operators.map((op) => (
                <span
                  key={op.name}
                  className="rounded border border-brand-operators/30 bg-brand-operators/5 px-1.5 py-0.5 font-mono text-[10px] text-brand-operators"
                  title={op.description ?? undefined}
                >
                  {op.name}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {(managed.models ?? []).length > 0 ? (
          <div>
            <ManagedSectionTitle>Models</ManagedSectionTitle>
            <div className="space-y-1">
              {managed.models!.map((mdl) => (
                <div key={mdl.slot} className="flex items-baseline gap-2 text-[10px]">
                  <span className="w-20 shrink-0 uppercase tracking-wider text-chrome-text/45">
                    {mdl.slot}
                  </span>
                  <span className="min-w-0 truncate font-mono text-chrome-text/80">
                    {mdl.model}
                    {mdl.version ? ` · ${mdl.version}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {(managed.privacy ?? []).length > 0 ? (
          <div className="rounded-md border border-chrome-border/50 bg-foreground/[0.015] p-2.5">
            <ManagedSectionTitle>Privacy</ManagedSectionTitle>
            <ul className="space-y-1">
              {managed.privacy!.map((claim, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-chrome-text/80">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" style={{ color: gold }} />
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 border-t border-chrome-border/40 pt-3 text-[10px] sm:grid-cols-4">
          <ManagedFact label="vendor" value={managed.vendor} />
          <ManagedFact label="entitlement" value={managed.entitlement} />
          <ManagedFact label="key env" value={managed.key_env} mono />
          <ManagedFact label="endpoint" value={managed.endpoint?.base_url ?? "—"} mono />
        </div>
        <p className="text-[10px] leading-snug text-chrome-text/50">
          Hosted by rvbbit — we run the models, you run SQL. Install writes catalog metadata and registers a
          backend at the rvbbit endpoint; set your subscriber key in the{" "}
          <span className="font-mono">{managed.key_env}</span> environment variable on this Postgres host.
          See the <span className="font-medium">Install</span> tab.
        </p>
      </div>
    </div>
  )
}

function ManagedInstallTab({
  manifest,
  rendered,
  activeConnectionId,
  onInstalled,
}: {
  manifest: Manifest
  rendered: RenderedArtifacts | null
  activeConnectionId: string | null
  onInstalled: () => void
}) {
  const managed = manifest.managed
  const gold = "var(--cap-type-managed, #d4a017)"
  const sql = rendered?.registerSql ?? (managed?.install?.sql ?? []).join("\n")
  const keyEnv = managed?.key_env ?? "RVBBIT_KEY"
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [keySet, setKeySet] = useState<boolean | null>(null)

  // Is the key already stored? (rvbbit.list_secrets is admin-gated; on older
  // extensions without the secrets table this just stays unknown.)
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    const nameEsc = keyEnv.replace(/'/g, "''")
    fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: activeConnectionId,
        sql: `SELECT count(*)::int AS n FROM rvbbit.list_secrets() WHERE name = '${nameEsc}'`,
        rowLimit: 1,
      }),
    })
      .then((r) => r.json())
      .then((b: { ok: boolean; rows?: { n: number }[] }) => {
        if (!cancelled && b.ok) setKeySet(Number(b.rows?.[0]?.n ?? 0) > 0)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, keyEnv])

  const saveKey = async () => {
    if (!activeConnectionId || !key.trim() || saving) return
    setSaving(true)
    setSaveResult(null)
    const nameEsc = keyEnv.replace(/'/g, "''")
    const valEsc = key.trim().replace(/'/g, "''")
    const sql = `SELECT rvbbit.set_secret('${nameEsc}', '${valEsc}'); SELECT rvbbit.reload_backends();`
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, sql, rowLimit: 5, readOnly: false }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (body.ok) {
        setSaveResult({ ok: true, msg: "Key saved and backends reloaded." })
        setKeySet(true)
        setKey("")
      } else {
        setSaveResult({ ok: false, msg: body.error ?? "save failed" })
      }
    } catch (e) {
      setSaveResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
    setSaving(false)
  }

  const install = async () => {
    if (!activeConnectionId || running) return
    setRunning(true)
    setResult(null)
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, sql, rowLimit: 50, readOnly: false }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (body.ok) {
        setResult({ ok: true, msg: "Installed — backend registered and operators created." })
        onInstalled()
      } else {
        setResult({ ok: false, msg: body.error ?? "install failed" })
      }
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
    setRunning(false)
  }

  return (
    <div className="h-full space-y-3 overflow-auto p-3">
      {/* step 1 — install */}
      <div>
        <div className="mb-1 text-[11px] font-medium text-foreground">1 · Install (metadata only)</div>
        <p className="text-[11px] leading-snug text-chrome-text/70">
          Registers a backend at the rvbbit endpoint and creates the operator wrappers. No models run locally;
          nothing is downloaded.
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void install()}
            disabled={running || !activeConnectionId}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1 text-[11px] font-semibold",
              running || !activeConnectionId ? "opacity-50" : "hover:brightness-110",
            )}
            style={{ background: gold, color: "#1a1400" }}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RvbbitLogo className="h-2.5 w-auto" />}
            {running ? "Installing…" : "Install"}
          </button>
          {result ? (
            <span
              className="text-[10px]"
              style={{ color: result.ok ? "var(--viz-positive, #4ade80)" : undefined }}
            >
              <span className={cn(!result.ok && "text-danger/80")}>{result.msg}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* step 2 — key */}
      <div className="border-t border-chrome-border/40 pt-2.5">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-foreground">
          2 · Set your subscriber key
          {keySet ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px]"
              style={{ color: gold, background: `color-mix(in oklch, ${gold} 12%, transparent)` }}
            >
              <CheckCircle2 className="h-2.5 w-2.5" /> key set
            </span>
          ) : null}
        </div>
        <p className="text-[11px] leading-snug text-chrome-text/70">
          After subscribing, paste your key — it&apos;s stored in the database and used to authenticate this
          backend. Reloads take effect immediately. A host{" "}
          <span className="font-mono text-chrome-text/90">{keyEnv}</span> environment variable, if set, takes
          precedence.
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            type="password"
            placeholder="paste subscriber key (rvb_…)"
            className="flex-1 rounded border border-chrome-border/60 bg-chrome-bg/30 px-2 py-1 font-mono text-[10px] text-foreground placeholder:text-chrome-text/35 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={saving || !key.trim() || !activeConnectionId}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold",
              saving || !key.trim() || !activeConnectionId ? "opacity-50" : "hover:brightness-110",
            )}
            style={{ background: gold, color: "#1a1400" }}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {saving ? "Saving…" : "Save key"}
          </button>
        </div>
        {saveResult ? (
          <div
            className="mt-1 text-[10px]"
            style={{ color: saveResult.ok ? "var(--viz-positive, #4ade80)" : undefined }}
          >
            <span className={cn(!saveResult.ok && "text-danger/80")}>{saveResult.msg}</span>
          </div>
        ) : null}
        <p className="mt-1 text-[9px] leading-snug text-chrome-text/45">
          Stored in rvbbit.secrets (superuser-gated, not browsable). Keys are plaintext at rest in this
          release; use a host env var if you need it kept out of the database.
        </p>
      </div>

      {/* the SQL */}
      <div className="border-t border-chrome-border/40 pt-2.5">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/50">install SQL</div>
        <pre className="overflow-auto whitespace-pre-wrap rounded border border-chrome-border/60 bg-chrome-bg/40 p-2 font-mono text-[10px] leading-relaxed text-chrome-text/85">
          {sql}
        </pre>
      </div>
    </div>
  )
}

function OverviewTab({
  catalog,
  manifest,
  installed,
  knobs,
  onChangeKnobs,
}: {
  catalog: CatalogEntry
  manifest: Manifest
  installed: InstalledBackend | null
  knobs: InstallKnobs
  onChangeKnobs: (next: InstallKnobs) => void
}) {
  const source = manifest.source ?? {}
  const runtime = manifest.runtime ?? {}
  const externalInstall = isExternalBackendManifest(manifest)
  const modelEditable =
    externalInstall ||
    (manifest.backend?.transport ?? "").toLowerCase() === "openai"

  const reset = () => onChangeKnobs(defaultKnobs(manifest))
  const knobsDirty =
    JSON.stringify(knobs) !== JSON.stringify(defaultKnobs(manifest))

  return (
    <div className="grid h-full grid-cols-2 gap-0 overflow-hidden">
      {/* left — manifest spec sheet */}
      <div className="space-y-2.5 overflow-auto border-r border-chrome-border p-3">
        {catalog.description ? (
          <p className="text-[12px] leading-snug text-foreground/85">
            {catalog.description}
          </p>
        ) : null}

        {manifest.managed ? (
          <Panel icon={RvbbitLogo} title="rvbbit Cloud — hosted">
            <div className="space-y-1.5">
              <KV k="vendor" v={manifest.managed.vendor} mono />
              <KV k="status" v={manifest.managed.status ?? "available"} mono />
              <KV k="entitlement" v={manifest.managed.entitlement} mono />
              <KV k="key env" v={manifest.managed.key_env} mono />
              {manifest.managed.verified?.tests ? (
                <div
                  className="flex flex-wrap items-center gap-1.5 text-[11px]"
                  style={{ color: "var(--cap-type-managed, #d4a017)" }}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  verified {manifest.managed.verified.passed}/{manifest.managed.verified.tests}
                  {manifest.managed.verified.regime ? (
                    <span className="text-chrome-text/50">· {manifest.managed.verified.regime}</span>
                  ) : null}
                  {manifest.managed.verified.battery_date ? (
                    <span className="text-chrome-text/40">· {manifest.managed.verified.battery_date}</span>
                  ) : null}
                </div>
              ) : null}
              {(manifest.managed.models ?? []).map((mdl) => (
                <KV
                  key={mdl.slot}
                  k={mdl.slot}
                  v={`${mdl.model}${mdl.version ? ` · ${mdl.version}` : ""}`}
                  mono
                />
              ))}
              {manifest.managed.pricing?.monthly_usd ? (
                manifest.managed.pricing.checkout_url ? (
                  <a
                    href={manifest.managed.pricing.checkout_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium hover:brightness-125"
                    style={{
                      background: "color-mix(in oklch, var(--cap-type-managed, #d4a017) 25%, transparent)",
                      color: "var(--cap-type-managed, #d4a017)",
                      border: "1px solid color-mix(in oklch, var(--cap-type-managed, #d4a017) 55%, transparent)",
                    }}
                  >
                    Subscribe · ${manifest.managed.pricing.monthly_usd}/mo
                  </a>
                ) : (
                  <div className="text-[11px] text-chrome-text/75">
                    ${manifest.managed.pricing.monthly_usd}/mo
                  </div>
                )
              ) : manifest.managed.status === "coming_soon" ? (
                <div className="text-[11px] text-chrome-text/60">
                  coming soon
                  {manifest.managed.pricing?.note ? ` · ${manifest.managed.pricing.note}` : ""}
                </div>
              ) : null}
              <p className="pt-1 text-[10px] leading-snug text-chrome-text/55">
                Hosted by rvbbit. Install writes metadata only — set your subscriber key in the{" "}
                <span className="font-mono">{manifest.managed.key_env}</span> environment variable
                on this Postgres host.
              </p>
            </div>
          </Panel>
        ) : null}

        <Panel icon={Sparkles} title="Source">
          <div className="space-y-1.5">
            <KV k="catalog" v={catalog.catalog_source} mono />
            <KV k="provider" v={source.provider ?? "—"} mono />
            <KV
              k="model"
              v={
                source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-capability hover:underline"
                  >
                    {source.model ?? "—"}
                  </a>
                ) : (
                  source.model ?? "—"
                )
              }
              mono
            />
            <KV k="revision" v={source.revision ?? "(latest)"} mono />
            {catalog.updated_at ? <KV k="updated" v={fmtAgo(catalog.updated_at)} mono /> : null}
          </div>
        </Panel>

        <Panel icon={Layers} title="Runtime">
          <div className="space-y-1.5">
            <KV k="template" v={runtime.template ?? "—"} mono />
            <KV k="handler" v={runtime.handler ?? "—"} mono />
            <div className="grid grid-cols-3 gap-2 pt-0.5">
              <Metric label="manifest device" value={runtime.device ?? "—"} />
              <Metric label="tags" value={(catalog.tags ?? []).length} />
              <Metric label="operators" value={(manifest.operators ?? []).length} />
            </div>
            {runtime.extra_requirements && runtime.extra_requirements.length > 0 ? (
              <div className="pt-0.5">
                <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/50">
                  extra requirements
                </div>
                <div className="flex flex-wrap gap-1">
                  {runtime.extra_requirements.map((r) => (
                    <span
                      key={r}
                      className="rounded bg-foreground/[0.05] px-1.5 py-px font-mono text-[10px] text-chrome-text/75"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel icon={FlowArrow} title="Operators">
          {(manifest.operators ?? []).length === 0 ? (
            <p className="text-[11px] text-chrome-text/55">
              This pack registers a backend but defines no operators.
            </p>
          ) : (
            <div className="space-y-2">
              {(manifest.operators ?? []).map((op) => (
                <div
                  key={op.name}
                  className="rounded border border-chrome-border/40 bg-foreground/[0.025] p-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-brand-operators">
                      rvbbit.{op.name}
                    </span>
                    <span className="font-mono text-[9px] text-chrome-text/55">
                      → {op.return_type}
                      {op.parser ? ` · ${op.parser}` : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {(op.arg_names ?? []).map((n, i) => (
                      <span
                        key={n}
                        className="font-mono text-[10px] text-chrome-text/70"
                      >
                        {n}
                        <span className="text-chrome-text/40">
                          {": "}
                          {(op.arg_types ?? [])[i] ?? "text"}
                        </span>
                      </span>
                    ))}
                  </div>
                  {op.description ? (
                    <p className="mt-1 text-[10px] leading-snug text-chrome-text/65">
                      {op.description}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Panel>

        {catalog.acceptance_tests.length > 0 ? (
          <Panel icon={CheckCircle2} title="Acceptance">
            <div className="space-y-1.5">
              {catalog.acceptance_tests.map((name) => (
                <div
                  key={name}
                  className="rounded border border-success/30 bg-success/5 px-2 py-1"
                >
                  <span className="font-mono text-[11px] text-success">{name}</span>
                </div>
              ))}
              <p className="text-[10px] leading-snug text-chrome-text/55">
                These SQL checks run against the deployed capability and the
                database surfaces it registers.
              </p>
            </div>
          </Panel>
        ) : null}

        {installed ? (
          <Panel icon={Activity} title="Live usage">
            <div className="grid grid-cols-3 gap-2">
              <Metric label="calls" value={fmtCount(installed.n_calls)} />
              <Metric
                label="errors"
                value={installed.n_errors}
                tone={installed.n_errors > 0 ? "danger" : undefined}
              />
              <Metric
                label="p95"
                value={
                  installed.p95_latency_ms == null
                    ? "—"
                    : fmtMs(installed.p95_latency_ms)
                }
              />
              <Metric
                label="endpoint"
                value={installed.endpoint_url ?? "—"}
              />
              <Metric
                label="last call"
                value={
                  installed.last_call_at ? fmtAgo(installed.last_call_at) : "—"
                }
              />
              <Metric
                label="installed"
                value={installed.created_at ? fmtAgo(installed.created_at) : "—"}
              />
            </div>
          </Panel>
        ) : null}
      </div>

      {/* right — install knobs (the Bret Victor lever) */}
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <Settings className="h-3.5 w-3.5 text-brand-capability" />
          <span className="text-[11px] uppercase tracking-wider text-chrome-text">
            Install knobs
          </span>
          {knobsDirty ? (
            <span
              className="ml-1 rounded-full bg-brand-capability/15 px-1.5 py-px text-[9px] uppercase tracking-wider text-brand-capability"
              title="Knobs differ from the manifest defaults — Generated SQL and Compose previews are using these overrides"
            >
              edited
            </span>
          ) : null}
          {knobsDirty ? (
            <button
              type="button"
              onClick={reset}
              className="ml-auto inline-flex items-center gap-1 text-[10px] text-chrome-text/55 hover:text-foreground"
            >
              <X className="h-3 w-3" />
              reset
            </button>
          ) : null}
        </div>
        <div className="space-y-2 overflow-auto p-3">
          <p className="text-[11px] leading-snug text-chrome-text/70">
            Edits apply only to the previewed install plan — no files are written
            and no SQL is executed. Switch to{" "}
            <span className="font-mono text-foreground/80">Generated SQL</span>{" "}
            to see the rendered output update live.
          </p>

          {knobs.vllm ? (
            <VllmKnobsSection
              vllm={knobs.vllm}
              onChange={(next) => onChangeKnobs({ ...knobs, vllm: next })}
            />
          ) : null}

          {modelEditable ? (
            <TextKnob
              label="Model"
              value={knobs.model}
              onChange={(v) => onChangeKnobs({ ...knobs, model: v })}
              help={`Manifest default: ${source.model ?? "(unset)"}`}
            />
          ) : null}

          {!externalInstall ? (
            <Knob
              label="Device"
              value={knobs.device}
              onChange={(v) => onChangeKnobs({ ...knobs, device: v })}
              options={["auto", "cpu", "cuda"]}
              help={`Manifest preference is ${runtime.device ?? "auto"}`}
            />
          ) : null}
          <NumberKnob
            label="Batch size"
            value={knobs.batchSize}
            onChange={(v) => onChangeKnobs({ ...knobs, batchSize: v })}
            min={1}
            max={1024}
            step={1}
            help={`Manifest default: ${manifest.backend?.batch_size ?? 32}`}
          />
          <NumberKnob
            label="Max concurrent"
            value={knobs.maxConcurrent}
            onChange={(v) => onChangeKnobs({ ...knobs, maxConcurrent: v })}
            min={1}
            max={64}
            step={1}
            help={`Manifest default: ${manifest.backend?.max_concurrent ?? 4}`}
          />
          <NumberKnob
            label="Timeout (ms)"
            value={knobs.timeoutMs}
            onChange={(v) => onChangeKnobs({ ...knobs, timeoutMs: v })}
            min={1000}
            max={600000}
            step={1000}
            help={`Manifest default: ${manifest.backend?.timeout_ms ?? 60000}`}
          />
          {!externalInstall ? (
            <>
              <label className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={knobs.publishHostPort}
                  onChange={(e) =>
                    onChangeKnobs({ ...knobs, publishHostPort: e.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-brand-capability"
                />
                <span className="text-[11px] text-foreground">
                  Publish host port overlay
                  {runtime.host_bind ? (
                    <span className="ml-1 font-mono text-chrome-text/55">
                      ({runtime.host_bind})
                    </span>
                  ) : null}
                </span>
              </label>
              <NumberKnob
                label="Host port"
                value={knobs.hostPort}
                onChange={(v) => onChangeKnobs({ ...knobs, hostPort: v })}
                min={0}
                max={65535}
                step={1}
                help={
                  runtime.host_bind
                    ? `Only used by compose.host-ports.yaml; binds ${runtime.host_bind}`
                    : "Only used by compose.host-ports.yaml; 0 lets Docker choose a free host port"
                }
              />
              <TextKnob
                label="Docker network"
                value={knobs.dockerNetwork}
                onChange={(v) => onChangeKnobs({ ...knobs, dockerNetwork: v })}
                help="Compose attaches the sidecar to this network so Postgres can reach it"
              />
              <TextKnob
                label="Output directory"
                value={knobs.outputDir}
                onChange={(v) => onChangeKnobs({ ...knobs, outputDir: v })}
                help="Where scaffold writes register.sql / operator.sql / compose.yaml / Dockerfile / main.py"
              />
              <label className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={knobs.gpu}
                  onChange={(e) =>
                    onChangeKnobs({ ...knobs, gpu: e.target.checked })
                  }
                  className="h-3.5 w-3.5 accent-brand-capability"
                />
                <span className="text-[11px] text-foreground">
                  Force GPU overlay (auto can enable it)
                </span>
              </label>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Knob({
  label,
  value,
  onChange,
  options,
  help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  help?: string
}) {
  return (
    <div>
      <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
        {label}
      </div>
      <div className="inline-flex overflow-hidden rounded border border-chrome-border bg-secondary-background">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "px-2 py-1 text-[11px] font-mono",
              value === opt
                ? "bg-brand-capability/15 text-brand-capability"
                : "text-chrome-text hover:text-foreground",
            )}
          >
            {opt}
          </button>
        ))}
      </div>
      {help ? (
        <div className="mt-0.5 text-[10px] text-chrome-text/45">{help}</div>
      ) : null}
    </div>
  )
}

function NumberKnob({
  label,
  value,
  onChange,
  min,
  max,
  step,
  help,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  help?: string
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[9px] uppercase tracking-wider text-chrome-text/55">
        <span>{label}</span>
        <span className="font-mono text-[11px] tabular-nums normal-case tracking-normal text-foreground">
          {value}
        </span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full accent-brand-capability"
      />
      {help ? (
        <div className="mt-0.5 text-[10px] text-chrome-text/45">{help}</div>
      ) : null}
    </div>
  )
}

/**
 * vLLM serving knobs — the generic batch/concurrency knobs don't map to
 * how a vLLM server is configured, so for `vllm_openai` packs we surface
 * the actual CLI flags (GPU memory, context length, parallelism, dtype,
 * quantization) that drive `runtime.args`.
 */
function VllmKnobsSection({
  vllm,
  onChange,
}: {
  vllm: VllmKnobs
  onChange: (next: VllmKnobs) => void
}) {
  const set = <K extends keyof VllmKnobs>(key: K, value: VllmKnobs[K]) =>
    onChange({ ...vllm, [key]: value })
  return (
    <div className="space-y-2 rounded border border-brand-capability/25 bg-brand-capability/[0.04] p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-capability">
          vLLM serving
        </span>
        <span className="text-[10px] text-chrome-text/45">→ runtime.args</span>
      </div>
      <NumberKnob
        label="GPU memory utilization"
        value={vllm.gpuMemoryUtilization}
        onChange={(v) => set("gpuMemoryUtilization", v)}
        min={0.3}
        max={0.98}
        step={0.02}
        help="--gpu-memory-utilization · fraction of VRAM vLLM may claim. Lower this first on GPU-OOM."
      />
      <NumberKnob
        label="Max model length"
        value={vllm.maxModelLen}
        onChange={(v) => set("maxModelLen", v)}
        min={0}
        max={131072}
        step={1024}
        help={
          vllm.maxModelLen === 0
            ? "--max-model-len · 0 = use the model's config default"
            : "--max-model-len · context window; smaller ⇒ less KV-cache VRAM"
        }
      />
      <NumberKnob
        label="Max concurrent sequences"
        value={vllm.maxNumSeqs}
        onChange={(v) => set("maxNumSeqs", v)}
        min={0}
        max={512}
        step={8}
        help={
          vllm.maxNumSeqs === 0
            ? "--max-num-seqs · 0 = vLLM default"
            : "--max-num-seqs · cap on in-flight sequences"
        }
      />
      <NumberKnob
        label="Tensor parallel size"
        value={vllm.tensorParallelSize}
        onChange={(v) => set("tensorParallelSize", v)}
        min={1}
        max={8}
        step={1}
        help="--tensor-parallel-size · shard the model across N GPUs"
      />
      <Knob
        label="dtype"
        value={vllm.dtype}
        onChange={(v) => set("dtype", v)}
        options={["auto", "float16", "bfloat16", "float32"]}
        help="--dtype · weight/activation precision"
      />
      <Knob
        label="Quantization"
        value={vllm.quantization}
        onChange={(v) => set("quantization", v)}
        options={["none", "awq", "gptq", "fp8", "bitsandbytes"]}
        help="--quantization · none keeps full precision (flag omitted)"
      />
    </div>
  )
}

function TextKnob({
  label,
  value,
  onChange,
  help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  help?: string
}) {
  return (
    <div>
      <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
        {label}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
      />
      {help ? (
        <div className="mt-0.5 text-[10px] text-chrome-text/45">{help}</div>
      ) : null}
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-[10px] uppercase tracking-wider text-chrome-text/50">
        {k}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px] text-foreground",
          mono ? "font-mono" : "",
        )}
      >
        {v}
      </span>
    </div>
  )
}

// ── Generated SQL tab ───────────────────────────────────────────────

function GeneratedSqlTab({ rendered }: { rendered: RenderedArtifacts }) {
  const files: { name: string; lang: CodeLang; body: string }[] = [
    { name: "rvbbit.backend.yaml", lang: "yaml", body: rendered.manifestYaml },
    { name: "register.sql", lang: "sql", body: rendered.registerSql },
    { name: "operator.sql", lang: "sql", body: rendered.operatorSql },
    { name: "smoke.sql", lang: "sql", body: rendered.smokeSql },
    { name: "compose.yaml", lang: "yaml", body: rendered.composeYaml },
    { name: "compose.host-ports.yaml", lang: "yaml", body: rendered.composeHostPortsYaml },
    { name: "compose.gpu.yaml", lang: "yaml", body: rendered.composeGpuYaml },
  ]
  const [active, setActive] = useState(files[0].name)
  const activeFile = files.find((f) => f.name === active) ?? files[0]

  return (
    <div className="grid h-full grid-cols-[180px_minmax(0,1fr)] overflow-hidden">
      {/* file list */}
      <aside className="overflow-auto border-r border-chrome-border bg-chrome-bg/20 py-2">
        {files.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => setActive(f.name)}
            className={cn(
              "flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] transition",
              active === f.name
                ? "bg-brand-capability/15 text-brand-capability"
                : "text-chrome-text hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            <FileCode2 className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{f.name}</span>
            <span className="ml-auto font-mono text-[9px] tabular-nums text-chrome-text/50">
              {byteLabel(f.body)}
            </span>
          </button>
        ))}
        <div className="mx-3 my-2 rounded border border-dashed border-chrome-border/40 p-2 text-[10px] leading-snug text-chrome-text/55">
          Edits in Overview &middot; <span className="font-mono">Install knobs</span>{" "}
          re-render these previews live.
        </div>
      </aside>

      {/* preview */}
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <FileCode2 className="h-3.5 w-3.5 text-brand-capability" />
          <span className="font-mono text-[11px] text-foreground">
            {activeFile.name}
          </span>
          <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
            {activeFile.lang}
          </span>
          <span className="ml-1 font-mono text-[9px] text-chrome-text/55">
            {lineLabel(activeFile.body)}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => copyToClipboard(activeFile.body)}
              className="grid h-6 px-2 place-items-center rounded text-[10px] uppercase tracking-wider text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
              title="Copy to clipboard"
            >
              copy
            </button>
          </div>
        </div>
        <CodePreview
          code={activeFile.body}
          lang={activeFile.lang}
          className="min-h-0 flex-1"
        />
      </div>
    </div>
  )
}

function byteLabel(s: string): string {
  const n = new TextEncoder().encode(s).length
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} kB`
}

function lineLabel(s: string): string {
  const n = s.split("\n").length
  return `${n} lines`
}

async function copyToClipboard(s: string) {
  try {
    await navigator.clipboard.writeText(s)
  } catch {
    // best-effort
  }
}

// ── Probe tab ───────────────────────────────────────────────────────

interface HistoryEntry {
  at: number
  result: ProbeResult
  input: Record<string, unknown> | null
}

function ProbeTab({
  activeConnectionId,
  manifest,
  registered,
}: {
  activeConnectionId: string | null
  manifest: Manifest
  registered: boolean
}) {
  const sampleInputs = manifest.smoke?.inputs?.[0] ?? null
  const fieldNames = useMemo(() => {
    const set = new Set<string>()
    for (const op of manifest.operators ?? []) {
      for (const k of Object.keys(op.inputs ?? {})) set.add(k)
      // also include arg_names with the templated placeholder form
      for (const n of op.arg_names ?? []) set.add(n)
    }
    if (sampleInputs) for (const k of Object.keys(sampleInputs)) set.add(k)
    return [...set]
  }, [manifest, sampleInputs])

  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    for (const k of fieldNames) seed[k] = sampleInputs?.[k] ?? ""
    return seed
  })
  const [useCustomInput, setUseCustomInput] = useState(false)
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const isRuntime = isRuntimeManifest(manifest) || !manifest.backend
  const probeName = manifest.backend?.name ?? manifest.runtime_registration?.name ?? manifest.name
  const runtimeLanguage = String(manifest.runtime_registration?.language ?? manifest.runtime?.language ?? "").toLowerCase()
  const runtimeProvider = String(manifest.runtime_registration?.provider ?? manifest.warren?.service_provider ?? "").toLowerCase()
  const isMcpRuntime = runtimeLanguage === "mcp" || runtimeLanguage === "mcp_gateway"
  const isMemoryRuntime =
    runtimeProvider === "hindsight" ||
    runtimeLanguage === "memory" ||
    runtimeLanguage === "hindsight"
  const probeTarget = isRuntime
    ? isMcpRuntime
      ? "MCP gateway"
      : isMemoryRuntime
      ? "memory service"
      : "runtime"
    : "backend"
  const supportsCustomInput = !isRuntime

  const runOnce = useCallback(async () => {
    if (!activeConnectionId) return
    setRunning(true)
    const filled = supportsCustomInput && useCustomInput
      ? Object.fromEntries(
          Object.entries(inputs).filter(([, v]) => v.length > 0),
        )
      : null
    const result = isRuntime
      ? await probeRuntime(activeConnectionId, manifest)
      : await probeBackend(activeConnectionId, probeName, filled)
    setHistory((prev) => [
      ...prev,
      { at: Date.now(), result, input: filled },
    ])
    setRunning(false)
  }, [activeConnectionId, isRuntime, manifest, probeName, inputs, supportsCustomInput, useCustomInput])

  const okLatencies = history.filter((h) => h.result.ok).map((h) => h.result.latency_ms)
  const sorted = [...okLatencies].sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)
  const okCount = okLatencies.length
  const errCount = history.length - okCount

  if (!registered) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text">
        <div className="max-w-md space-y-2">
          <Plug className="mx-auto h-6 w-6 text-chrome-text/40" />
          <div className="text-foreground">
            {isRuntime ? "Runtime not registered yet" : "Backend not registered yet"}
          </div>
          <p className="text-[11px] leading-snug text-chrome-text/65">
            Probing targets the {probeTarget}{" "}
            <span className="font-mono">{probeName}</span>. Run the install
            pipeline first or apply the generated SQL manually.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)] overflow-hidden">
      {/* left — input form */}
      <aside className="flex h-full flex-col overflow-hidden border-r border-chrome-border">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <Play className="h-3.5 w-3.5 text-brand-capability" />
          <span className="text-[11px] uppercase tracking-wider text-chrome-text">
            Probe input
          </span>
        </div>
        <div className="space-y-2 overflow-auto p-3">
          <p className="text-[10px] leading-snug text-chrome-text/65">
            <span className="text-warning">Active call:</span> runs the model
            or runtime through the same path your operators use.
            {isRuntime ? "" : " Each click is one billable round-trip."}
          </p>
          {supportsCustomInput ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={useCustomInput}
                onChange={(e) => setUseCustomInput(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-capability"
              />
              <span className="text-[11px] text-foreground">
                Use custom input
              </span>
            </label>
          ) : null}
          <div className="text-[10px] text-chrome-text/55">
            {supportsCustomInput
              ? useCustomInput
                ? "Sends backend_probe_with_input(name, jsonb)."
                : "Sends backend_probe(name) — handler-default sample input."
              : probeTarget === "memory service"
                ? "Sends rvbbit.hindsight_status(service_name)."
                : "Reads the registered runtime health/status row."}
          </div>
          {supportsCustomInput && useCustomInput ? (
            <div className="space-y-1.5">
              {fieldNames.length === 0 ? (
                <p className="text-[10px] italic text-chrome-text/45">
                  No input fields derived from the manifest. Probing with an
                  empty object.
                </p>
              ) : (
                fieldNames.map((field) => (
                  <div key={field}>
                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
                      {field}
                    </div>
                    <textarea
                      value={inputs[field] ?? ""}
                      onChange={(e) =>
                        setInputs((prev) => ({
                          ...prev,
                          [field]: e.target.value,
                        }))
                      }
                      rows={2}
                      className="w-full resize-y rounded border border-chrome-border bg-secondary-background p-1.5 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                ))
              )}
            </div>
          ) : null}
          <Button
            size="sm"
            onClick={() => void runOnce()}
            disabled={running || !activeConnectionId}
            className="mt-2 w-full"
          >
            <Play className="h-3 w-3" />
            {running ? "Probing…" : "Run probe"}
          </Button>
          {history.length > 0 ? (
            <button
              type="button"
              onClick={() => setHistory([])}
              className="inline-flex items-center gap-1 text-[10px] text-chrome-text/55 hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              clear {history.length} runs
            </button>
          ) : null}
        </div>
      </aside>

      {/* right — accumulating REPL with histogram */}
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {/* hero — running latency stats */}
        <div className="border-b border-chrome-border p-3">
          <Panel
            icon={Activity}
            title="Recent probe latencies"
            right={
              <span>
                {okCount} ok
                {errCount > 0 ? (
                  <span className="ml-1 text-danger">· {errCount} err</span>
                ) : null}
              </span>
            }
          >
            {okLatencies.length === 0 ? (
              <p className="text-[11px] text-chrome-text/55">
                Run a probe to populate the histogram.
              </p>
            ) : (
              <>
                <div className="mb-1 grid grid-cols-3 gap-3 text-[10px] text-chrome-text/65">
                  <span>
                    <span className="font-mono tabular-nums text-foreground">
                      {fmtMs(p50)}
                    </span>{" "}
                    p50
                  </span>
                  <span>
                    <span className="font-mono tabular-nums text-warning">
                      {fmtMs(p95)}
                    </span>{" "}
                    p95
                  </span>
                  <span>
                    <span className="font-mono tabular-nums text-foreground">
                      {fmtMs(Math.max(...okLatencies))}
                    </span>{" "}
                    max
                  </span>
                </div>
                <Histogram
                  values={okLatencies}
                  height={56}
                  markers={[
                    { value: p50, label: "p50" },
                    { value: p95, label: "p95", color: "var(--warning)" },
                  ]}
                  barColor="var(--brand-capability)"
                />
              </>
            )}
          </Panel>
        </div>

        {/* per-call timeline */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {history.length === 0 ? (
            <div className="grid h-full place-items-center text-[11px] text-chrome-text/45">
              No probes run yet — output and full JSON appear here as you go.
            </div>
          ) : (
            <div className="space-y-1.5">
              {[...history].reverse().map((h, i) => (
                <ProbeRow key={history.length - i} entry={h} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProbeRow({ entry }: { entry: HistoryEntry }) {
  const [expanded, setExpanded] = useState(false)
  const r = entry.result
  return (
    <div
      className={cn(
        "rounded border bg-secondary-background/40",
        r.ok ? "border-chrome-border/60" : "border-danger/40",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider",
            r.ok
              ? "bg-success/15 text-success"
              : "bg-danger/15 text-danger",
          )}
        >
          {r.ok ? <CheckCircle2 className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
          {r.ok ? "ok" : "fail"}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-chrome-text/65">
          {new Date(entry.at).toLocaleTimeString([], { hour12: false })}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground">
          {fmtMs(r.latency_ms)}
        </span>
        {r.ok ? (
          <span className="text-[10px] text-chrome-text/55">
            output: <span className="font-mono">{r.outputType}</span>
            {(r.outputSize ?? 0) > 0 ? (
              <span className="font-mono text-chrome-text/45">[{r.outputSize}]</span>
            ) : null}
          </span>
        ) : (
          <span className="truncate text-[10px] text-danger">{r.error}</span>
        )}
        <span className="ml-auto text-[10px] text-chrome-text/45">
          {expanded ? "hide" : "show"} json
        </span>
      </button>
      {expanded ? (
        <pre className="max-h-64 overflow-auto border-t border-chrome-border/40 bg-doc-bg p-2 font-mono text-[10px] leading-relaxed text-foreground/85">
          {JSON.stringify(
            {
              input: entry.input ?? "(default)",
              ...r,
            },
            null,
            2,
          )}
        </pre>
      ) : null}
    </div>
  )
}

// ── Acceptance tests tab ────────────────────────────────────────────

function AcceptanceTestsTab({
  activeConnectionId,
  catalog,
}: {
  activeConnectionId: string | null
  catalog: CatalogEntry
}) {
  const acceptance = catalog.acceptance
  type AcceptanceDefinition = {
    kind: AcceptanceRunStep["kind"]
    name: string
    description?: string | null
    sql: string
  }
  const definitions = useMemo(() => {
    if (!acceptance) return [] as AcceptanceDefinition[]
    return [
      ...(acceptance.setup_sql ?? []).map((sql, i) => ({
        kind: "setup" as const,
        name: `setup_${i + 1}`,
        description: null,
        sql,
      })),
      ...(acceptance.tests ?? []).map((t) => ({
        kind: "test" as const,
        name: t.name,
        description: t.description,
        sql: t.sql,
      })),
      ...(acceptance.teardown_sql ?? []).map((sql, i) => ({
        kind: "teardown" as const,
        name: `teardown_${i + 1}`,
        description: null,
        sql,
      })),
    ] satisfies AcceptanceDefinition[]
  }, [acceptance])
  const [selected, setSelected] = useState(0)
  const [running, setRunning] = useState(false)
  const [runSteps, setRunSteps] = useState<AcceptanceRunStep[]>([])
  const [lastOk, setLastOk] = useState<boolean | null>(null)
  const selectedIndex = Math.min(selected, Math.max(0, definitions.length - 1))
  const selectedDef = definitions[selectedIndex]
  const failedRun = runSteps.find((s) => !s.ok)
  const failedIndex = failedRun
    ? definitions.findIndex(
        (d) => d.kind === failedRun.kind && d.name === failedRun.name,
      )
    : -1
  const selectedRun = selectedDef
    ? runSteps.find((s) => s.kind === selectedDef.kind && s.name === selectedDef.name)
    : undefined
  const selectedSkipped =
    lastOk === false && !selectedRun && failedIndex >= 0 && selectedIndex > failedIndex

  const runAll = useCallback(async () => {
    if (!activeConnectionId || !acceptance || running) return
    setRunning(true)
    setRunSteps([])
    setLastOk(null)
    const result = await runAcceptanceSql(activeConnectionId, acceptance, (step) => {
      setRunSteps((prev) => [...prev, step])
    })
    setLastOk(result.ok)
    setRunning(false)
  }, [activeConnectionId, acceptance, running])

  if (!acceptance || definitions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/65">
        <div>
          <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-chrome-text/35" />
          This catalog entry has no acceptance SQL.
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full grid-cols-[280px_minmax(0,1fr)] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r border-chrome-border">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          <span className="text-[11px] uppercase tracking-wider text-chrome-text">
            Pack tests
          </span>
          <span className="ml-auto font-mono text-[10px] text-chrome-text/55">
            {definitions.length}
          </span>
        </div>
        <div className="space-y-2 border-b border-chrome-border/40 p-3">
          <Button
            size="sm"
            onClick={() => void runAll()}
            disabled={running || !activeConnectionId}
            className="w-full"
          >
            <Play className="h-3 w-3" />
            {running ? "Running…" : "Run acceptance SQL"}
          </Button>
          {acceptance.target_selector ? (
            <pre className="overflow-auto rounded border border-chrome-border/40 bg-secondary-background p-2 font-mono text-[10px] text-foreground/80">
              {JSON.stringify(acceptance.target_selector)}
            </pre>
          ) : null}
          {lastOk != null ? (
            <div
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                lastOk
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger",
              )}
            >
              <div className="flex items-center gap-1.5">
                {lastOk ? <CheckCircle2 className="h-3 w-3" /> : <X className="h-3 w-3" />}
                {lastOk ? "all tests passed" : `failed at ${failedRun?.name ?? "step"}`}
              </div>
              {!lastOk && failedRun?.error ? (
                <div className="mt-1 line-clamp-2 font-mono text-[10px] leading-snug text-danger/85">
                  {failedRun.error}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {definitions.map((def, i) => {
            const run = runSteps.find((s) => s.kind === def.kind && s.name === def.name)
            const active = i === selected
            const skipped = lastOk === false && !run && failedIndex >= 0 && i > failedIndex
            return (
              <button
                key={`${def.kind}:${def.name}`}
                type="button"
                onClick={() => setSelected(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition",
                  active
                    ? "bg-success/10 text-success"
                    : "text-chrome-text hover:bg-foreground/[0.04] hover:text-foreground",
                )}
              >
                <StatusDot
                  ok={run?.ok}
                  running={running && !run && runSteps.length === i}
                  skipped={skipped}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{def.name}</div>
                  <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">
                    {def.kind}
                  </div>
                </div>
                {run ? (
                  <span className="font-mono text-[9px] tabular-nums text-chrome-text/55">
                    {fmtMs(run.latencyMs)}
                  </span>
                ) : skipped ? (
                  <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
                    skipped
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </aside>
      <div className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
          <FileCode2 className="h-3.5 w-3.5 text-success" />
          <span className="font-mono text-[11px] text-foreground">
            {selectedDef?.name ?? "test"}
          </span>
          <span className="rounded bg-foreground/[0.05] px-1 text-[9px] uppercase tracking-wider text-chrome-text/55">
            sql
          </span>
          {selectedRun || selectedSkipped ? (
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider",
                selectedRun
                  ? selectedRun.ok
                    ? "bg-success/15 text-success"
                    : "bg-danger/15 text-danger"
                  : "bg-chrome-border/60 text-chrome-text/60",
              )}
            >
              {selectedRun ? (selectedRun.ok ? "passed" : "failed") : "skipped"}
            </span>
          ) : null}
        </div>
        {selectedDef?.description ? (
          <div className="border-b border-chrome-border/40 px-3 py-1.5 text-[11px] text-chrome-text/70">
            {selectedDef.description}
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(120px,0.45fr)]">
          <CodePreview code={selectedDef?.sql ?? ""} lang="sql" className="min-h-0" />
          <div className="min-h-0 overflow-auto border-t border-chrome-border bg-secondary-background/30 p-2">
            {!selectedRun && selectedSkipped ? (
              <div className="grid h-full place-items-center px-6 text-center text-[11px] text-chrome-text/55">
                <div className="max-w-md">
                  Skipped because{" "}
                  <span className="font-mono text-danger">{failedRun?.name ?? "an earlier step"}</span>{" "}
                  failed. Select that step for the error, then rerun the acceptance SQL.
                </div>
              </div>
            ) : !selectedRun ? (
              <div className="grid h-full place-items-center text-[11px] text-chrome-text/45">
                Run tests to see output for this step.
              </div>
            ) : selectedRun.error ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-danger">
                {selectedRun.error}
              </pre>
            ) : (
              <CodePreview
                code={JSON.stringify(selectedRun.lastRow ?? { ok: true }, null, 2)}
                lang="json"
                className="max-h-full rounded border border-chrome-border/40"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusDot({
  ok,
  running,
  skipped,
}: {
  ok: boolean | undefined
  running: boolean
  skipped?: boolean
}) {
  if (running) {
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-rvbbit-accent opacity-75" />
        <span className="relative inline-block h-2 w-2 rounded-full bg-rvbbit-accent" />
      </span>
    )
  }
  if (ok === true) return <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
  if (ok === false) return <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
  if (skipped) return <span className="h-2 w-2 shrink-0 rounded-full bg-chrome-text/30" />
  return <span className="h-2 w-2 shrink-0 rounded-full bg-chrome-border" />
}

// ── Install tab dispatcher ──────────────────────────────────────────

function InstallTabDispatcher({
  mode,
  warrenAvail,
  setMode,
  activeConnectionId,
  catalogId,
  manifestPath,
  manifest,
  knobs,
  rendered,
  isEmbeddingCapability,
  makeDefaultEmbedder,
  defaultEmbedderActive,
  onMakeDefaultEmbedderChange,
  onInstalledChanged,
  onOpenWarrenJob,
  acceptance,
}: {
  mode: "warren" | "local"
  warrenAvail: WarrenAvailability | null
  setMode: (m: "warren" | "local") => void
  activeConnectionId: string | null
  catalogId: string | null
  manifestPath: string
  manifest: Manifest
  knobs: InstallKnobs
  rendered: RenderedArtifacts
  isEmbeddingCapability: boolean
  makeDefaultEmbedder: boolean
  defaultEmbedderActive: boolean
  onMakeDefaultEmbedderChange: (value: boolean) => void
  onInstalledChanged: () => void
  onOpenWarrenJob: (jobId: string, jobName: string | null) => void
  acceptance: CatalogEntry["acceptance"]
}) {
  // No warren tables on this DB → never show the toggle; only local
  // install. Preserves the pre-Phase-3 UX exactly.
  const warrenAvailable = warrenAvail?.available === true && !isExternalBackendManifest(manifest)
  const readyCount = warrenAvail?.readyNodes ?? 0
  const showToggle = warrenAvailable

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showToggle ? (
        <div className="flex items-center gap-1 border-b border-chrome-border/40 bg-chrome-bg/30 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">
            install via
          </span>
          <ModeChip
            active={mode === "warren"}
            onClick={() => setMode("warren")}
            label="Warren"
            color="brand-warren"
            disabled={readyCount === 0}
            hint={
              readyCount > 0
                ? `${readyCount} of ${warrenAvail?.totalNodes ?? 0} warren node(s) ready`
                : warrenAvail?.totalNodes
                  ? `${warrenAvail.totalNodes} warren node(s) registered, none ready`
                  : "no warren nodes registered"
            }
          />
          <ModeChip
            active={mode === "local"}
            onClick={() => setMode("local")}
            label="Local"
            color="brand-capability"
            hint="scaffold + docker compose up on this machine"
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "warren" && warrenAvailable ? (
          <WarrenDeployPanel
            activeConnectionId={activeConnectionId}
            catalogId={catalogId}
            manifest={manifest}
            knobs={knobs}
            acceptance={acceptance}
            onUseLocalInstead={() => setMode("local")}
            onOpenJob={onOpenWarrenJob}
          />
        ) : (
          <CapabilityInstallGraph
            activeConnectionId={activeConnectionId}
            manifestPath={manifestPath}
            manifestYaml={rendered.manifestYaml}
            manifest={manifest}
            knobs={knobs}
            rendered={rendered}
            isEmbeddingCapability={isEmbeddingCapability}
            makeDefaultEmbedder={makeDefaultEmbedder}
            defaultEmbedderActive={defaultEmbedderActive}
            onMakeDefaultEmbedderChange={onMakeDefaultEmbedderChange}
            onInstalledChanged={onInstalledChanged}
          />
        )}
      </div>
    </div>
  )
}

function ModeChip({
  active,
  onClick,
  label,
  color,
  disabled,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  color: "brand-warren" | "brand-capability"
  disabled?: boolean
  hint?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition disabled:opacity-40",
        active
          ? color === "brand-warren"
            ? "bg-brand-warren/15 text-brand-warren ring-1 ring-brand-warren/30"
            : "bg-brand-capability/15 text-brand-capability ring-1 ring-brand-capability/30"
          : "text-chrome-text hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B"
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}
