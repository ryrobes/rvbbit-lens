"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  AlertTriangle,
  Box,
  Globe,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { Sparkline } from "./sparkline"
import {
  bucketCounts,
  CompositionBar,
  fmtAgo,
  fmtCount,
  Metric,
  Panel,
  Readout,
  SERIES_COLORS,
} from "./instruments"
import {
  fetchMcpGatewayStatus,
  fetchGhostServers,
  fetchInvocations,
  fetchServers,
  MCP_GATEWAY_CATALOG_ID,
  registerServer,
  serverStatus,
  type GhostServerRow,
  type McpGatewayStatus,
  type McpInvocation,
  type McpServerOverview,
  type RegisterServerInput,
  type ServerStatus,
  type Transport,
} from "@/lib/rvbbit/mcp"

interface McpServersWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenServer: (name: string) => void
  onOpenCapability: (catalogId: string, initialTab?: "overview" | "generated-sql" | "probe" | "install" | "tests") => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

export function McpServersWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenServer,
  onOpenCapability,
}: McpServersWindowProps) {
  const [servers, setServers] = useState<McpServerOverview[]>([])
  const [invocations, setInvocations] = useState<McpInvocation[]>([])
  const [ghosts, setGhosts] = useState<GhostServerRow[]>([])
  const [gateway, setGateway] = useState<McpGatewayStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const loading = updatedAt === 0

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [s, inv, gh] = await Promise.all([
      fetchServers(activeConnectionId),
      fetchInvocations(activeConnectionId, { limit: 300 }),
      fetchGhostServers(activeConnectionId),
    ])
    const gw = await fetchMcpGatewayStatus(activeConnectionId)
    setGateway(gw)
    setError(s.error ?? inv.error ?? gw.error ?? null)
    setServers(s.rows)
    setInvocations(inv.rows)
    setGhosts(gh)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, reload])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, reload])

  const { gMin, gMax, colorOf } = useMemo(() => {
    let gMin = Infinity
    let gMax = -Infinity
    for (const i of invocations) {
      if (i.invocationAt < gMin) gMin = i.invocationAt
      if (i.invocationAt > gMax) gMax = i.invocationAt
    }
    if (!Number.isFinite(gMin)) {
      gMin = 0
      gMax = 1
    }
    const colorOf = new Map<string, string>()
    servers.forEach((s, i) => colorOf.set(s.name, SERIES_COLORS[i % SERIES_COLORS.length]))
    return { gMin, gMax, colorOf }
  }, [invocations, servers])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Globe className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension.
        </div>
      </div>
    )
  }

  const totalCalls = invocations.length
  const totalErrors = invocations.filter((i) => i.error).length
  const totalCacheHits = invocations.filter((i) => i.cacheHit).length
  const reachableCount = servers.filter((s) => serverStatus(s) === "active").length
  const gatewayReady = gateway?.ready === true

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
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
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Globe className="h-3.5 w-3.5 text-rvbbit-accent" />
          {loading ? "loading…" : `${servers.length} servers`}
        </span>
        <GatewayChip gateway={gateway} />
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium text-emerald-400">{reachableCount}</span> active
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium tabular-nums text-foreground">
                {fmtCount(totalCalls)}
              </span>{" "}
              calls logged
            </span>
            {totalErrors > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span className="text-danger">{totalErrors} errors</span>
              </>
            ) : null}
          </>
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
            onClick={() => void reload()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setShowAdd((s) => !s)}
            disabled={!gatewayReady}
            title="Register a new MCP server"
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px]",
              showAdd
                ? "border-rvbbit-accent/50 bg-rvbbit-accent/15 text-rvbbit-accent"
                : "border-chrome-border text-chrome-text/80 hover:border-rvbbit-accent/40 hover:text-foreground",
              !gatewayReady && "cursor-not-allowed opacity-45 hover:border-chrome-border hover:text-chrome-text/80",
            )}
          >
            <Plus className="h-3 w-3" />
            Server
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error}
        </div>
      ) : null}

      <div className="flex-1 space-y-2.5 overflow-auto p-2.5">
        {!gatewayReady ? (
          <McpGatewayRequiredPanel
            gateway={gateway}
            onOpenCapability={() =>
              onOpenCapability(gateway?.catalogId ?? MCP_GATEWAY_CATALOG_ID, "install")
            }
          />
        ) : null}

        {showAdd ? (
          <RegisterForm
            connId={activeConnectionId}
            onDone={async () => {
              setShowAdd(false)
              await reload()
            }}
            onCancel={() => setShowAdd(false)}
          />
        ) : null}

        <FleetPanel
          invocations={invocations}
          totalCalls={totalCalls}
          totalErrors={totalErrors}
          totalCacheHits={totalCacheHits}
          gMin={gMin}
          gMax={gMax}
        />

        <div className="grid grid-cols-2 gap-2.5">
          {servers.map((s) => (
            <ServerCard
              key={s.name}
              server={s}
              calls={invocations.filter((i) => i.server === s.name)}
              gMin={gMin}
              gMax={gMax}
              color={colorOf.get(s.name) ?? "var(--rvbbit-accent)"}
              onOpen={() => onOpenServer(s.name)}
            />
          ))}
        </div>

        {servers.length === 0 && !loading ? (
          <div className="grid h-32 place-items-center text-center text-[11px] text-chrome-text/55">
            <div>
              <Globe className="mx-auto mb-1.5 h-5 w-5 text-chrome-text/30" />
              {gatewayReady ? "No MCP servers registered." : "MCP gateway runtime is not installed."}
              <br />
              {gatewayReady ? (
                <>
                  Click <span className="font-mono text-rvbbit-accent">+ Server</span> above to add one.
                </>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onOpenCapability(gateway?.catalogId ?? MCP_GATEWAY_CATALOG_ID, "install")
                  }
                  className="mt-2 rounded border border-rvbbit-accent/45 bg-rvbbit-bg px-2 py-1 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/15"
                >
                  Open MCP Gateway capability
                </button>
              )}
            </div>
          </div>
        ) : null}

        {ghosts.length > 0 ? <GhostPanel ghosts={ghosts} /> : null}
      </div>
    </div>
  )
}

function GatewayChip({ gateway }: { gateway: McpGatewayStatus | null }) {
  const ready = gateway?.ready === true
  const installed = gateway?.installed === true
  const label = ready ? "gateway ready" : installed ? `gateway ${gateway.status ?? "unknown"}` : "gateway missing"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
        ready
          ? "bg-success/10 text-success"
          : installed
            ? "bg-warning/15 text-warning"
            : "bg-danger/10 text-danger",
      )}
      title={gateway?.endpointUrl ?? gateway?.error ?? undefined}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ready ? "bg-success" : installed ? "bg-warning" : "bg-danger",
        )}
      />
      {label}
    </span>
  )
}

function McpGatewayRequiredPanel({
  gateway,
  onOpenCapability,
}: {
  gateway: McpGatewayStatus | null
  onOpenCapability: () => void
}) {
  const installed = gateway?.installed === true
  return (
    <Panel
      icon={AlertTriangle}
      title="MCP gateway runtime"
      right={
        <button
          type="button"
          onClick={onOpenCapability}
          className="rounded border border-rvbbit-accent/45 bg-rvbbit-bg px-2 py-0.5 text-[10px] text-rvbbit-accent hover:bg-rvbbit-accent/15"
        >
          {installed ? "Open runtime" : "Install runtime"}
        </button>
      }
    >
      <div className="flex items-start gap-2 text-[11px] text-chrome-text/70">
        <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rvbbit-accent" />
        <div className="min-w-0">
          <div className="text-foreground">
            {installed
              ? `Gateway ${gateway?.name ?? "runtime"} is ${gateway?.status ?? "not ready"}.`
              : "Install the MCP Gateway capability before refreshing tools or running MCP calls."}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-chrome-text/50">
            {gateway?.endpointUrl ?? gateway?.error ?? MCP_GATEWAY_CATALOG_ID}
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── Fleet panel ─────────────────────────────────────────────────────

function FleetPanel({
  invocations,
  totalCalls,
  totalErrors,
  totalCacheHits,
  gMin,
  gMax,
}: {
  invocations: McpInvocation[]
  totalCalls: number
  totalErrors: number
  totalCacheHits: number
  gMin: number
  gMax: number
}) {
  const series = useMemo(
    () => bucketCounts(invocations.map((i) => i.invocationAt), 48, gMin, gMax),
    [invocations, gMin, gMax],
  )
  const byTool = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of invocations) m.set(i.tool, (m.get(i.tool) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [invocations])
  const segments = byTool.slice(0, 8).map(([tool, n], idx) => ({
    label: tool,
    value: n,
    color: SERIES_COLORS[idx % SERIES_COLORS.length],
  }))
  const hitRate = totalCalls > 0 ? (totalCacheHits / totalCalls) * 100 : 0

  return (
    <Panel icon={Activity} title="Fleet activity" right={<span>{fmtCount(totalCalls)} calls</span>}>
      <div className="flex gap-4">
        <div className="flex shrink-0 flex-col justify-between gap-2">
          <Readout value={fmtCount(totalCalls)} unit="calls" label="tool invocations" accent />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <Metric
              label="errors"
              value={fmtCount(totalErrors)}
              tone={totalErrors > 0 ? "danger" : undefined}
            />
            <Metric label="cache hits" value={`${hitRate.toFixed(0)}%`} />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/50">
            calls over the audit log
          </div>
          <Sparkline values={series} height={40} color="var(--rvbbit-accent)" fillOpacity={0.16} />
          {segments.length > 0 ? (
            <>
              <div className="mt-2">
                <CompositionBar segments={segments} height={9} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {segments.map((s) => (
                  <span key={s.label} className="inline-flex items-center gap-1 text-[9px]">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{ background: s.color }}
                    />
                    <span className="font-mono text-chrome-text/80">{s.label}</span>
                    <span className="font-mono tabular-nums text-chrome-text/45">
                      {Math.round((s.value / Math.max(1, totalCalls)) * 100)}%
                    </span>
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

// ── Server card ─────────────────────────────────────────────────────

function ServerCard({
  server,
  calls,
  gMin,
  gMax,
  color,
  onOpen,
}: {
  server: McpServerOverview
  calls: McpInvocation[]
  gMin: number
  gMax: number
  color: string
  onOpen: () => void
}) {
  const status = serverStatus(server)
  const series = useMemo(
    () => bucketCounts(calls.map((c) => c.invocationAt), 36, gMin, gMax),
    [calls, gMin, gMax],
  )
  const errors = calls.filter((c) => c.error).length
  const hits = calls.filter((c) => c.cacheHit).length
  const avgMs =
    calls.length > 0 ? calls.reduce((s, c) => s + c.latencyMs, 0) / calls.length : 0
  const endpoint = server.transport === "stdio" ? server.command : server.url

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-md border border-chrome-border bg-secondary-background p-2.5 text-left transition-colors hover:border-rvbbit-accent/50"
    >
      {/* header */}
      <div className="flex items-center gap-1.5">
        <StatusDot status={status} />
        <span className="truncate font-mono text-[12px] font-medium text-foreground">
          {server.name}
        </span>
        <span className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] uppercase tracking-wide text-chrome-text/65">
          {server.transport}
        </span>
        <div className="flex-1" />
        {endpoint ? (
          <span className="max-w-[50%] truncate font-mono text-[9px] text-chrome-text/45">
            {endpoint}
          </span>
        ) : null}
      </div>

      {/* metrics */}
      <div className="grid grid-cols-3 gap-2">
        <Metric label="tools" value={String(server.nTools)} />
        <Metric label="resources" value={String(server.nResources)} />
        <Metric
          label="calls"
          value={fmtCount(calls.length || server.totalCalls)}
        />
      </div>

      {/* activity strip */}
      {calls.length > 0 ? (
        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
            recent activity
          </div>
          <Sparkline values={series} height={24} color={color} fillOpacity={0.2} />
        </div>
      ) : (
        <div className="grid h-[36px] place-items-center rounded bg-doc-bg/60 text-[10px] text-chrome-text/45">
          {server.totalCalls > 0
            ? `${fmtCount(server.totalCalls)} historical calls`
            : "no calls recorded yet"}
        </div>
      )}

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-chrome-border/50 pt-1.5 text-[10px] tabular-nums text-chrome-text/55">
        {errors > 0 ? (
          <span className="text-danger">{errors} err</span>
        ) : server.totalErrors > 0 ? (
          <span className="text-warning">{server.totalErrors} historical err</span>
        ) : (
          <span className="text-emerald-400/80">no errors</span>
        )}
        <span className="text-chrome-text/30">·</span>
        <span>{calls.length > 0 ? `${Math.round(avgMs)}ms avg` : "—"}</span>
        {hits > 0 ? (
          <>
            <span className="text-chrome-text/30">·</span>
            <span>{hits} cache hits</span>
          </>
        ) : null}
        <div className="flex-1" />
        <span>
          {server.lastCallAt ? fmtAgo(new Date(server.lastCallAt).getTime()) : "never"}
        </span>
      </div>
    </button>
  )
}

function StatusDot({ status }: { status: ServerStatus }) {
  const color =
    status === "active"
      ? "bg-emerald-400"
      : status === "failing"
        ? "bg-danger"
        : status === "idle"
          ? "bg-chrome-text/60"
          : "bg-chrome-text/30"
  return (
    <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} title={status} />
  )
}

// ── Ghost activity ──────────────────────────────────────────────────

function GhostPanel({ ghosts }: { ghosts: GhostServerRow[] }) {
  return (
    <Panel
      icon={Box}
      title="Dropped servers"
      right={<span>{ghosts.length} seen in the log</span>}
    >
      <p className="mb-2 text-[10px] text-chrome-text/55">
        Audit rows from servers no longer registered — the audit log survives{" "}
        <span className="font-mono">drop_mcp_server</span>.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {ghosts.slice(0, 80).map((g) => {
          const bad = g.nErrors > 0
          return (
            <span
              key={g.server}
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                bad
                  ? "border-danger/40 bg-danger/10 text-danger"
                  : "border-chrome-border bg-doc-bg/60 text-chrome-text/70",
              )}
              title={`${g.nCalls} call${g.nCalls === 1 ? "" : "s"}${g.lastCallAt ? ` · last ${fmtAgo(new Date(g.lastCallAt).getTime())}` : ""}`}
            >
              {bad ? <AlertTriangle className="h-2.5 w-2.5" /> : null}
              {g.server}
              <span className="tabular-nums opacity-60">{g.nCalls}</span>
            </span>
          )
        })}
        {ghosts.length > 80 ? (
          <span className="text-[10px] text-chrome-text/45">+{ghosts.length - 80} more</span>
        ) : null}
      </div>
    </Panel>
  )
}

// ── Register form ───────────────────────────────────────────────────

function RegisterForm({
  connId,
  onDone,
  onCancel,
}: {
  connId: string | null
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<Transport>("stdio")
  const [command, setCommand] = useState("")
  const [args, setArgs] = useState("")
  const [envText, setEnvText] = useState("")
  const [url, setUrl] = useState("")
  const [authEnv, setAuthEnv] = useState("")
  const [timeoutMs, setTimeoutMs] = useState("30000")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!connId || !name.trim()) return
    let env: Record<string, string> | undefined
    if (envText.trim()) {
      const obj: Record<string, string> = {}
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=")
        if (eq < 0) continue
        const k = line.slice(0, eq).trim()
        const v = line.slice(eq + 1).trim()
        if (k) obj[k] = v
      }
      if (Object.keys(obj).length > 0) env = obj
    }
    const input: RegisterServerInput = {
      name: name.trim(),
      transport,
      timeoutMs: Number(timeoutMs) || null,
      description: description.trim() || undefined,
    }
    if (transport === "stdio") {
      input.command = command.trim() || undefined
      const argTokens = args.split(/\s+/).filter(Boolean)
      if (argTokens.length > 0) input.args = argTokens
      if (env) input.env = env
    } else {
      input.url = url.trim() || undefined
      input.authHeaderEnv = authEnv.trim() || undefined
    }
    setBusy(true)
    setErr(null)
    const res = await registerServer(connId, input)
    setBusy(false)
    if (res.error) setErr(res.error)
    else await onDone()
  }

  return (
    <Panel
      icon={Plus}
      title="Register a server"
      right={
        <button
          type="button"
          onClick={onCancel}
          className="grid h-5 w-5 place-items-center rounded text-chrome-text/55 hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="server name">
          <input
            value={name}
            onChange={(e) =>
              setName(e.target.value.replace(/[^a-z0-9_-]/gi, "_").toLowerCase())
            }
            placeholder="github"
            className={inputCls}
          />
        </Field>
        <Field label="transport">
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            className={inputCls}
          >
            <option value="stdio">stdio (subprocess)</option>
            <option value="http">http (remote)</option>
          </select>
        </Field>

        {transport === "stdio" ? (
          <>
            <Field label="command">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx, python, /usr/bin/foo"
                className={inputCls}
              />
            </Field>
            <Field label="args (space-separated)">
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-github"
                className={inputCls}
              />
            </Field>
            <Field label="env vars (KEY=value, one per line)" wide>
              <textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                rows={2}
                placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}"
                className={areaCls}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="url" wide>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/mcp"
                className={inputCls}
              />
            </Field>
            <Field label="auth header env var">
              <input
                value={authEnv}
                onChange={(e) => setAuthEnv(e.target.value)}
                placeholder="MY_API_TOKEN"
                className={inputCls}
              />
            </Field>
          </>
        )}

        <Field label="timeout (ms)">
          <input
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="description" wide>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional notes"
            className={inputCls}
          />
        </Field>
      </div>

      {err ? (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words font-mono">{err}</span>
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
        >
          <Layers className="h-3 w-3" />
          {busy ? "Registering…" : "Register server"}
        </button>
        <span className="text-[10px] text-chrome-text/55">
          Then click the server card → <span className="text-foreground">Refresh</span> to discover its tools.
        </span>
      </div>
    </Panel>
  )
}

function Field({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={cn("block", wide ? "col-span-2" : "")}>
      <span className="mb-0.5 block text-[10px] text-chrome-text/60">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  "h-7 w-full rounded border border-chrome-border bg-doc-bg px-2 font-mono text-[11px] text-foreground outline-none focus:border-main/60"
const areaCls =
  "w-full rounded border border-chrome-border bg-doc-bg px-2 py-1 font-mono text-[11px] leading-snug text-foreground outline-none focus:border-main/60"
