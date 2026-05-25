"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Boxes,
  Eye,
  Globe,
  Layers,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Sparkline } from "./sparkline"
import {
  bucketCounts,
  fmtAgo,
  fmtCount,
  fmtMs,
  Metric,
  Panel,
  Readout,
} from "./instruments"
import {
  buildArgsFromForm,
  disableToolCaching,
  dropServer,
  fetchCache,
  fetchInvocations,
  fetchResources,
  fetchServers,
  fetchTools,
  mcpCall,
  mcpProbe,
  mcpResource,
  mcpText,
  purgeCache,
  refreshServer,
  schemaType,
  serverStatus,
  setToolCaching,
  type JsonSchema,
  type McpCacheEntry,
  type McpInvocation,
  type McpProbe,
  type McpResource,
  type McpServerOverview,
  type McpTool,
} from "@/lib/rvbbit/mcp"
import type { McpServerDetailPayload } from "@/lib/desktop/types"

interface McpServerDetailWindowProps {
  payload: McpServerDetailPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenQueryLens: (queryId: string) => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

type TabKey = "tools" | "resources" | "invocations" | "cache"
const TABS: { key: TabKey; label: string }[] = [
  { key: "tools", label: "Tools" },
  { key: "resources", label: "Resources" },
  { key: "invocations", label: "Invocations" },
  { key: "cache", label: "Cache" },
]

export function McpServerDetailWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenQueryLens,
}: McpServerDetailWindowProps) {
  const name = payload.serverName
  const [server, setServer] = useState<McpServerOverview | null>(null)
  const [tools, setTools] = useState<McpTool[]>([])
  const [resources, setResources] = useState<McpResource[]>([])
  const [cache, setCache] = useState<McpCacheEntry[]>([])
  const [invocations, setInvocations] = useState<McpInvocation[]>([])
  const [tab, setTab] = useState<TabKey>("tools")
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [probe, setProbe] = useState<McpProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmDrop, setConfirmDrop] = useState(false)
  const [dropped, setDropped] = useState(false)
  const loading = updatedAt === 0

  const reloadStatic = useCallback(async () => {
    if (!activeConnectionId) return
    const [s, t, r, c] = await Promise.all([
      fetchServers(activeConnectionId),
      fetchTools(activeConnectionId, name),
      fetchResources(activeConnectionId, name),
      fetchCache(activeConnectionId, name),
    ])
    setServer(s.rows.find((x) => x.name === name) ?? null)
    setTools(t.rows)
    setResources(r.rows)
    setCache(c.rows)
    setError(s.error ?? t.error ?? r.error ?? c.error ?? null)
  }, [activeConnectionId, name])

  const pollInvocations = useCallback(async () => {
    if (!activeConnectionId) return
    const inv = await fetchInvocations(activeConnectionId, { server: name, limit: 200 })
    setInvocations(inv.rows)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, name])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reloadStatic()
      await pollInvocations()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, reloadStatic, pollInvocations])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void pollInvocations(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, pollInvocations])

  const onProbe = useCallback(async () => {
    if (!activeConnectionId) return
    setProbing(true)
    setProbe(null)
    const r = await mcpProbe(activeConnectionId, name)
    setProbe(r.probe ?? { reachable: false, latencyMs: null, nTools: null, error: r.error ?? null })
    setProbing(false)
  }, [activeConnectionId, name])

  const onRefresh = useCallback(async () => {
    if (!activeConnectionId) return
    setRefreshing(true)
    await refreshServer(activeConnectionId, name)
    setRefreshing(false)
    await reloadStatic()
    await pollInvocations()
  }, [activeConnectionId, name, reloadStatic, pollInvocations])

  const onDrop = useCallback(async () => {
    if (!activeConnectionId) return
    await dropServer(activeConnectionId, name)
    setDropped(true)
    setConfirmDrop(false)
    setServer(null)
    setTools([])
    setResources([])
    setCache([])
  }, [activeConnectionId, name])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text/70">
        No pg_rvbbit extension on this connection.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text">
        Loading {name}…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
            paused ? "bg-foreground/[0.05] text-chrome-text" : "bg-success/10 text-success",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              paused ? "bg-chrome-text" : "animate-pulse bg-success",
            )}
          />
          {paused ? "paused" : "live"}
        </span>
        <Globe className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="font-mono text-[13px] font-medium text-foreground">{name}</span>
        {server ? (
          <>
            <span className="rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/70">
              {server.transport}
            </span>
            <StatusPill server={server} />
          </>
        ) : null}
        {dropped ? (
          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning">
            dropped
          </span>
        ) : null}
        {probe ? (
          <ProbePill probe={probe} />
        ) : probing ? (
          <span className="text-[10px] text-chrome-text/55">probing…</span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="Refresh interval"
            className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {REFRESH_OPTIONS_MS.map((o) => (
              <option key={o.ms} value={o.ms}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume" : "Pause"}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => void onProbe()}
            disabled={probing || dropped}
            title="Probe — actively round-trip the gateway"
            className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-40"
          >
            <Plug className="h-3 w-3" />
            Probe
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing || dropped}
            title="Re-discover tools and resources"
            className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {confirmDrop ? (
            <>
              <button
                type="button"
                onClick={() => void onDrop()}
                className="inline-flex h-6 items-center gap-1 rounded border border-danger/50 bg-danger/15 px-1.5 text-[10px] text-danger hover:bg-danger/25"
              >
                Confirm drop
              </button>
              <button
                type="button"
                onClick={() => setConfirmDrop(false)}
                className="inline-flex h-6 items-center rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/70 hover:text-foreground"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDrop(true)}
              disabled={dropped}
              title="Deregister this server"
              className="inline-flex h-6 items-center gap-1 rounded border border-chrome-border px-1.5 text-[10px] text-chrome-text/70 hover:border-danger/40 hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              Drop
            </button>
          )}
        </div>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-0.5 border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => {
          const badge = countForTab(t.key, tools, resources, invocations, cache)
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "-mb-px flex items-center gap-1 border-b-2 px-3 py-1.5 text-[11px] font-medium transition-colors",
                tab === t.key
                  ? "border-rvbbit-accent text-foreground"
                  : "border-transparent text-chrome-text/60 hover:text-foreground",
              )}
            >
              {t.label}
              {badge != null ? (
                <span className="rounded bg-foreground/10 px-1 font-mono text-[9px] text-chrome-text/65">
                  {fmtCount(badge)}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {dropped ? (
          <div className="grid h-40 place-items-center text-center text-[11px] text-chrome-text/55">
            <div>
              <Trash2 className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
              Server <span className="font-mono">{name}</span> was deregistered.
              <br />
              Audit and cache history are preserved.
            </div>
          </div>
        ) : tab === "tools" ? (
          <ToolsTab
            connId={activeConnectionId}
            server={name}
            tools={tools}
            invocations={invocations}
            onReload={async () => {
              await reloadStatic()
              await pollInvocations()
            }}
          />
        ) : tab === "resources" ? (
          <ResourcesTab connId={activeConnectionId} server={name} resources={resources} />
        ) : tab === "invocations" ? (
          <InvocationsTab invocations={invocations} onOpenQueryLens={onOpenQueryLens} />
        ) : (
          <CacheTab
            connId={activeConnectionId}
            server={name}
            cache={cache}
            onReload={reloadStatic}
          />
        )}
      </div>
    </div>
  )
}

function countForTab(
  key: TabKey,
  tools: McpTool[],
  resources: McpResource[],
  invocations: McpInvocation[],
  cache: McpCacheEntry[],
): number | null {
  if (key === "tools") return tools.length
  if (key === "resources") return resources.length
  if (key === "invocations") return invocations.length
  if (key === "cache") return cache.length
  return null
}

// ── Status / probe pills ────────────────────────────────────────────

function StatusPill({ server }: { server: McpServerOverview }) {
  const status = serverStatus(server)
  const tone =
    status === "active"
      ? "bg-emerald-400/15 text-emerald-400"
      : status === "failing"
        ? "bg-danger/15 text-danger"
        : status === "idle"
          ? "bg-foreground/[0.05] text-chrome-text"
          : "bg-foreground/[0.05] text-chrome-text/65"
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]", tone)}>
      {status}
    </span>
  )
}

function ProbePill({ probe }: { probe: McpProbe }) {
  if (probe.reachable) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        reachable · {probe.latencyMs ?? "?"}ms · {probe.nTools ?? 0} tools
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger"
      title={probe.error ?? undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-danger" />
      unreachable{probe.error ? ` · ${probe.error.slice(0, 60)}` : ""}
    </span>
  )
}

// ── Tools tab ───────────────────────────────────────────────────────

function ToolsTab({
  connId,
  server,
  tools,
  invocations,
  onReload,
}: {
  connId: string | null
  server: string
  tools: McpTool[]
  invocations: McpInvocation[]
  onReload: () => Promise<void>
}) {
  if (tools.length === 0) {
    return (
      <div className="grid h-40 place-items-center text-center text-[11px] text-chrome-text/55">
        <div>
          <Boxes className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
          No tools discovered yet.
          <br />
          Click <span className="font-mono text-rvbbit-accent">Refresh</span> in the header to run{" "}
          <span className="font-mono">tools/list</span>.
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2 p-2.5">
      {tools.map((t) => (
        <ToolRow
          key={t.name}
          connId={connId}
          server={server}
          tool={t}
          invocations={invocations.filter((i) => i.tool === t.name)}
          onReload={onReload}
        />
      ))}
    </div>
  )
}

function ToolRow({
  connId,
  server,
  tool,
  invocations,
  onReload,
}: {
  connId: string | null
  server: string
  tool: McpTool
  invocations: McpInvocation[]
  onReload: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-md border border-chrome-border bg-secondary-background">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-foreground/[0.03]"
      >
        <Wand2 className="h-3 w-3 text-rvbbit-accent" />
        <span className="font-mono text-[12px] font-medium text-foreground">{tool.name}</span>
        {tool.cacheable ? (
          <span className="rounded bg-rvbbit-accent/15 px-1 text-[9px] uppercase tracking-wide text-rvbbit-accent">
            cache {tool.ttlSeconds ? `${tool.ttlSeconds}s` : "∞"}
          </span>
        ) : null}
        <span className="truncate text-[10px] text-chrome-text/55">
          {tool.description ?? "(no description)"}
        </span>
        <div className="flex-1" />
        <span className="text-[10px] tabular-nums text-chrome-text/55">
          {tool.nCalls > 0
            ? `${fmtCount(tool.nCalls)} calls · ${fmtMs(tool.avgLatencyMs)} avg`
            : "no calls"}
        </span>
        {tool.nErrors > 0 ? (
          <span className="text-[10px] tabular-nums text-danger">
            {fmtCount(tool.nErrors)} err
          </span>
        ) : null}
        <span className="text-[9px] text-chrome-text/35">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded ? (
        <div className="border-t border-chrome-border/50 px-2.5 py-2">
          <ToolExpansion
            connId={connId}
            server={server}
            tool={tool}
            invocations={invocations}
            onReload={onReload}
          />
        </div>
      ) : null}
    </div>
  )
}

function ToolExpansion({
  connId,
  server,
  tool,
  invocations,
  onReload,
}: {
  connId: string | null
  server: string
  tool: McpTool
  invocations: McpInvocation[]
  onReload: () => Promise<void>
}) {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
          Test
        </div>
        <ToolTester connId={connId} server={server} tool={tool} onComplete={onReload} />
      </div>
      <div className="space-y-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-chrome-text/45">
            <span>Cache + stats</span>
          </div>
          <CacheControls connId={connId} server={server} tool={tool} onReload={onReload} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-chrome-text/45">
            <span>Input schema</span>
            <button
              type="button"
              onClick={() => setShowRaw((s) => !s)}
              className="text-[9px] text-chrome-text/60 hover:text-foreground"
            >
              {showRaw ? "hide raw" : "show raw"}
            </button>
          </div>
          {showRaw ? (
            <pre className="max-h-40 overflow-auto rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[9px] leading-snug text-chrome-text/80">
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          ) : (
            <SchemaSummary schema={tool.inputSchema} />
          )}
        </div>
        {invocations.length > 0 ? (
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
              Recent calls
            </div>
            <Sparkline
              values={bucketCounts(
                invocations.map((i) => i.invocationAt),
                28,
                Math.min(...invocations.map((i) => i.invocationAt)),
                Math.max(...invocations.map((i) => i.invocationAt)),
              )}
              height={20}
              color="var(--rvbbit-accent)"
              fillOpacity={0.2}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SchemaSummary({ schema }: { schema: JsonSchema | null }) {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return <p className="text-[10px] text-chrome-text/45">no inputs</p>
  }
  const required = new Set(schema.required ?? [])
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(schema.properties).map(([k, p]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded bg-foreground/[0.05] px-1 py-px font-mono text-[9px] text-chrome-text/80"
          title={p.description ?? ""}
        >
          <span>{k}</span>
          <span className="text-chrome-text/45">{schemaType(p)}</span>
          {required.has(k) ? <span className="text-rvbbit-accent">*</span> : null}
        </span>
      ))}
    </div>
  )
}

function ToolTester({
  connId,
  server,
  tool,
  onComplete,
}: {
  connId: string | null
  server: string
  tool: McpTool
  onComplete: () => Promise<void>
}) {
  const properties = tool.inputSchema?.properties ?? {}
  const required = new Set(tool.inputSchema?.required ?? [])
  const propKeys = Object.keys(properties)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(propKeys.map((k) => [k, ""])),
  )
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{
    output: unknown
    text: string
    latencyMs: number
    isError: boolean
    error?: string
  } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const run = async () => {
    if (!connId) return
    const { args, errors } = buildArgsFromForm(tool.inputSchema, values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setRunning(true)
    setResult(null)
    const res = await mcpCall(connId, server, tool.name, args)
    const envelope = res.envelope
    const text = envelope ? mcpText(envelope) : ""
    setResult({
      output: envelope,
      text,
      latencyMs: res.latencyMs,
      isError: !!envelope?.isError,
      error: res.error,
    })
    setRunning(false)
    if (!res.error) await onComplete()
  }

  return (
    <div className="space-y-1.5">
      {propKeys.length === 0 ? (
        <p className="text-[10px] text-chrome-text/55">No arguments — run it as-is.</p>
      ) : (
        propKeys.map((k) => (
          <div key={k}>
            <label className="block">
              <span className="mb-0.5 flex items-center gap-1 font-mono text-[9px] text-chrome-text/65">
                {k}
                <span className="text-chrome-text/40">{schemaType(properties[k])}</span>
                {required.has(k) ? <span className="text-rvbbit-accent">*</span> : null}
                {properties[k]?.description ? (
                  <span className="ml-auto truncate text-[9px] normal-case text-chrome-text/45">
                    {properties[k].description}
                  </span>
                ) : null}
              </span>
              <input
                value={values[k] ?? ""}
                onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                placeholder={
                  schemaType(properties[k]) === "string"
                    ? ""
                    : schemaType(properties[k]) === "integer"
                      ? "0"
                      : schemaType(properties[k]) === "boolean"
                        ? "true / false"
                        : "JSON…"
                }
                className={cn(
                  "h-7 w-full rounded border bg-doc-bg px-2 font-mono text-[11px] text-foreground outline-none focus:border-main/60",
                  fieldErrors[k] ? "border-danger/60" : "border-chrome-border",
                )}
              />
              {fieldErrors[k] ? (
                <span className="mt-0.5 block text-[9px] text-danger">{fieldErrors[k]}</span>
              ) : null}
            </label>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={running || !connId}
        className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
      >
        <Play className="h-3 w-3" />
        {running ? "Calling…" : "Run"}
      </button>
      {result ? (
        <div className="mt-1 space-y-1">
          {result.error ? (
            <div className="flex items-start gap-1.5 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span className="break-words font-mono">{result.error}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[10px] text-chrome-text/55">
              <span
                className={cn(
                  "rounded-full px-1.5",
                  result.isError ? "bg-danger/15 text-danger" : "bg-emerald-400/15 text-emerald-400",
                )}
              >
                {result.isError ? "tool error" : "ok"}
              </span>
              <span className="font-mono tabular-nums">{result.latencyMs}ms</span>
            </div>
          )}
          {result.text ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] leading-snug text-foreground">
              {result.text}
            </pre>
          ) : result.output != null && !result.error ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] leading-snug text-chrome-text/80">
              {JSON.stringify(result.output, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CacheControls({
  connId,
  server,
  tool,
  onReload,
}: {
  connId: string | null
  server: string
  tool: McpTool
  onReload: () => Promise<void>
}) {
  const [ttlText, setTtlText] = useState(tool.ttlSeconds != null ? String(tool.ttlSeconds) : "")
  const [busy, setBusy] = useState(false)
  const setOn = async () => {
    if (!connId) return
    setBusy(true)
    const ttl = ttlText.trim() === "" ? null : Number(ttlText)
    await setToolCaching(connId, server, tool.name, ttl)
    setBusy(false)
    await onReload()
  }
  const setOff = async () => {
    if (!connId) return
    setBusy(true)
    await disableToolCaching(connId, server, tool.name)
    setBusy(false)
    await onReload()
  }
  const purge = async () => {
    if (!connId) return
    setBusy(true)
    await purgeCache(connId, server, tool.name)
    setBusy(false)
    await onReload()
  }
  return (
    <div className="rounded border border-chrome-border bg-doc-bg p-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        <Metric label="calls" value={fmtCount(tool.nCalls)} />
        <Metric label="avg latency" value={fmtMs(tool.avgLatencyMs)} />
        <Metric
          label="cached entries"
          value={String(tool.nCached)}
          tone={tool.nCached > 0 ? undefined : "muted"}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap items-end gap-2">
        <label className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            TTL seconds (blank = forever)
          </span>
          <input
            value={ttlText}
            onChange={(e) => setTtlText(e.target.value)}
            placeholder="300"
            className="h-6 w-24 rounded border border-chrome-border bg-secondary-background px-1.5 font-mono text-[11px] text-foreground outline-none focus:border-main/60"
          />
        </label>
        {tool.cacheable ? (
          <>
            <button
              type="button"
              onClick={() => void setOn()}
              disabled={busy}
              className="rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:border-rvbbit-accent/40 hover:text-foreground"
            >
              Update TTL
            </button>
            <button
              type="button"
              onClick={() => void setOff()}
              disabled={busy}
              className="rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:border-danger/40 hover:text-danger"
            >
              Disable cache
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void setOn()}
            disabled={busy}
            className="rounded border border-rvbbit-accent/40 bg-rvbbit-bg px-1.5 py-0.5 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/15"
          >
            Enable cache
          </button>
        )}
        {tool.nCached > 0 ? (
          <button
            type="button"
            onClick={() => void purge()}
            disabled={busy}
            className="rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:border-danger/40 hover:text-danger"
          >
            Purge ({tool.nCached})
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Resources tab ───────────────────────────────────────────────────

function ResourcesTab({
  connId,
  server,
  resources,
}: {
  connId: string | null
  server: string
  resources: McpResource[]
}) {
  const [reading, setReading] = useState<string | null>(null)
  const [output, setOutput] = useState<{ uri: string; data: unknown; error?: string } | null>(null)

  const read = async (uri: string) => {
    if (!connId) return
    setReading(uri)
    const res = await mcpResource(connId, server, uri)
    setOutput({ uri, data: res.data, error: res.error })
    setReading(null)
  }

  if (resources.length === 0) {
    return (
      <div className="grid h-32 place-items-center text-center text-[11px] text-chrome-text/55">
        <div>
          <Layers className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
          This server exposes no resources, or none have been discovered.
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2 p-2.5">
      {resources.map((r) => (
        <div
          key={r.uri}
          className="rounded-md border border-chrome-border bg-secondary-background p-2.5"
        >
          <div className="flex items-center gap-2">
            <Layers className="h-3 w-3 text-rvbbit-accent" />
            <span className="truncate font-mono text-[11px] text-foreground" title={r.uri}>
              {r.uri}
            </span>
            {r.mimeType ? (
              <span className="rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/65">
                {r.mimeType}
              </span>
            ) : null}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void read(r.uri)}
              disabled={reading === r.uri}
              className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/40 bg-rvbbit-bg px-1.5 py-0.5 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
            >
              <Play className="h-3 w-3" />
              {reading === r.uri ? "Reading…" : "Read"}
            </button>
          </div>
          {(r.name || r.description) && (
            <div className="mt-1 text-[10px] text-chrome-text/55">
              {r.name ? <span className="text-foreground">{r.name}</span> : null}
              {r.name && r.description ? " · " : ""}
              {r.description}
            </div>
          )}
          {output && output.uri === r.uri ? (
            <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] leading-snug text-chrome-text/85">
              {output.error ?? JSON.stringify(output.data, null, 2)}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ── Invocations tab ─────────────────────────────────────────────────

function InvocationsTab({
  invocations,
  onOpenQueryLens,
}: {
  invocations: McpInvocation[]
  onOpenQueryLens: (queryId: string) => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)

  if (invocations.length === 0) {
    return (
      <div className="grid h-32 place-items-center text-center text-[11px] text-chrome-text/55">
        <div>
          <Activity className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
          No invocations recorded for this server.
        </div>
      </div>
    )
  }
  return (
    <div className="p-2.5">
      <Panel
        icon={Activity}
        title="Audit log"
        right={<span>{invocations.length} most recent</span>}
      >
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-1 pr-2 text-left font-medium">time</th>
              <th className="py-1 pr-2 text-left font-medium">tool</th>
              <th className="py-1 pr-2 text-left font-medium">args</th>
              <th className="py-1 pr-2 text-right font-medium">latency</th>
              <th className="py-1 pr-2 text-left font-medium">cache</th>
              <th className="py-1 pr-2 text-left font-medium">error</th>
              <th className="py-1 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {invocations.map((r) => (
              <>
                <tr
                  key={r.id}
                  className="cursor-pointer border-t border-chrome-border/30 align-top hover:bg-foreground/[0.03]"
                  onClick={() => setExpanded((e) => (e === r.id ? null : r.id))}
                >
                  <td className="py-0.5 pr-2 font-mono tabular-nums text-chrome-text/70">
                    {new Date(r.invocationAt).toLocaleTimeString([], { hour12: false })}
                  </td>
                  <td className="py-0.5 pr-2 font-mono text-rvbbit-accent">{r.tool}</td>
                  <td className="max-w-[260px] truncate py-0.5 pr-2 font-mono text-[10px] text-chrome-text/70">
                    {r.args ? JSON.stringify(r.args) : "—"}
                  </td>
                  <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-foreground">
                    {r.latencyMs}ms
                  </td>
                  <td className="py-0.5 pr-2 font-mono text-[10px] text-chrome-text/60">
                    {r.cacheHit ? "hit" : "miss"}
                  </td>
                  <td
                    className={cn(
                      "max-w-[200px] truncate py-0.5 pr-2 font-mono text-[10px]",
                      r.error ? "text-danger" : "text-chrome-text/45",
                    )}
                    title={r.error ?? ""}
                  >
                    {r.error ?? "—"}
                  </td>
                  <td className="py-0.5 text-right">
                    {r.queryId ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenQueryLens(r.queryId!)
                        }}
                        title="Open this query_id in Query Lens"
                        className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
                      >
                        <Eye className="h-2.5 w-2.5" />
                        lens
                      </button>
                    ) : null}
                  </td>
                </tr>
                {expanded === r.id ? (
                  <tr key={`${r.id}-x`} className="bg-foreground/[0.02]">
                    <td colSpan={7} className="px-2 py-1.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
                            args
                          </div>
                          <pre className="max-h-40 overflow-auto rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] text-chrome-text/85">
                            {JSON.stringify(r.args, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
                            output
                          </div>
                          <pre className="max-h-40 overflow-auto rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] text-chrome-text/85">
                            {JSON.stringify(r.output, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

// ── Cache tab ───────────────────────────────────────────────────────

function CacheTab({
  connId,
  server,
  cache,
  onReload,
}: {
  connId: string | null
  server: string
  cache: McpCacheEntry[]
  onReload: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const purgeAll = async () => {
    if (!connId) return
    setBusy(true)
    await purgeCache(connId, server)
    setBusy(false)
    await onReload()
  }
  const purgeTool = async (tool: string) => {
    if (!connId) return
    setBusy(true)
    await purgeCache(connId, server, tool)
    setBusy(false)
    await onReload()
  }
  const totalBytes = cache.reduce((s, c) => s + c.outputBytes, 0)
  const expiredCount = cache.filter((c) => c.expired).length

  if (cache.length === 0) {
    return (
      <div className="grid h-32 place-items-center text-center text-[11px] text-chrome-text/55">
        <div>
          <Sparkles className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
          No cached results.
          <br />
          Enable caching on a tool to start memoizing identical-args calls.
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2.5 p-2.5">
      <Panel
        icon={Zap}
        title="Cache contents"
        right={
          <button
            type="button"
            onClick={() => void purgeAll()}
            disabled={busy}
            className="rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] hover:border-danger/40 hover:text-danger"
          >
            Purge all ({cache.length})
          </button>
        }
      >
        <div className="mb-2 flex gap-6">
          <Readout value={fmtCount(cache.length)} unit="entries" accent />
          <Metric label="total size" value={fmtBytes(totalBytes)} />
          <Metric
            label="expired"
            value={`${expiredCount}`}
            tone={expiredCount > 0 ? "warning" : undefined}
          />
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            <tr>
              <th className="py-1 pr-2 text-left font-medium">tool</th>
              <th className="py-1 pr-2 text-left font-medium">args</th>
              <th className="py-1 pr-2 text-left font-medium">cached</th>
              <th className="py-1 pr-2 text-right font-medium">size</th>
              <th className="py-1 text-left font-medium">state</th>
            </tr>
          </thead>
          <tbody>
            {cache.map((c) => (
              <tr key={c.argsHash} className="border-t border-chrome-border/30 align-top">
                <td className="py-0.5 pr-2 font-mono text-rvbbit-accent">
                  <button
                    type="button"
                    onClick={() => void purgeTool(c.tool)}
                    className="hover:text-foreground"
                    title="purge this tool's cache"
                  >
                    {c.tool}
                  </button>
                </td>
                <td
                  className="max-w-[280px] truncate py-0.5 pr-2 font-mono text-[10px] text-chrome-text/70"
                  title={JSON.stringify(c.args, null, 2)}
                >
                  {c.args ? JSON.stringify(c.args) : "—"}
                </td>
                <td className="py-0.5 pr-2 font-mono tabular-nums text-chrome-text/70">
                  {fmtAgo(new Date(c.cachedAt).getTime())}
                </td>
                <td className="py-0.5 pr-2 text-right font-mono tabular-nums text-foreground">
                  {fmtBytes(c.outputBytes)}
                </td>
                <td className="py-0.5 font-mono text-[10px]">
                  {c.expired ? (
                    <span className="text-warning">expired</span>
                  ) : c.ttlSeconds != null ? (
                    <span className="text-chrome-text/55">ttl {c.ttlSeconds}s</span>
                  ) : (
                    <span className="text-chrome-text/55">forever</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const u = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}
