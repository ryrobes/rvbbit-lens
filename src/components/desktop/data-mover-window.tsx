"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ComponentType, ReactNode } from "react"
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  Package,
  Play,
  RefreshCw,
  Upload,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  CURRENT_CONNECTION_URI,
  fetchDataMoverDrivers,
  fetchDataMoverStatus,
  installDataMoverDriver,
  probeDataMoverConnection,
  runDataMoverTransfer,
  type DataMoverTransferRequest,
} from "@/lib/rvbbit/data-mover"
import { Panel } from "./instruments"

interface DataMoverWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  workspaceActive?: boolean
}

type IngestMode = DataMoverTransferRequest["ingest_mode"]
type TransferMode = DataMoverTransferRequest["transfer_mode"]

const DRIVER_OPTIONS = [
  "postgresql",
  "sqlite",
  "duckdb",
  "parquet",
  "s3",
  "bigquery",
  "motherduck",
  "snowflake",
  "flightsql",
]

function stringifyResult(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isDriverRegistry(value: unknown): value is { registry?: Record<string, unknown> } {
  return !!value && typeof value === "object"
}

export function DataMoverWindow({ activeConnectionId, hasRvbbit }: DataMoverWindowProps) {
  const [sourceDriver, setSourceDriver] = useState("postgresql")
  const [sourceUri, setSourceUri] = useState(CURRENT_CONNECTION_URI)
  const [destDriver, setDestDriver] = useState("postgresql")
  const [destUri, setDestUri] = useState(CURRENT_CONNECTION_URI)
  const [destTable, setDestTable] = useState("public.fletch_import")
  const [query, setQuery] = useState("select * from public.my_table limit 1000")
  const [ingestMode, setIngestMode] = useState<IngestMode>("create")
  const [transferMode, setTransferMode] = useState<TransferMode>("batch")
  const [autoInstall, setAutoInstall] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<unknown>(null)
  const [drivers, setDrivers] = useState<unknown>(null)
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  const knownDrivers = useMemo(() => {
    const names = new Set(DRIVER_OPTIONS)
    if (isDriverRegistry(drivers)) {
      for (const key of Object.keys(drivers.registry ?? {})) names.add(key)
    }
    return [...names].sort()
  }, [drivers])

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    setBusy("refresh")
    setError(null)
    const [statusRes, driverRes] = await Promise.all([
      fetchDataMoverStatus(activeConnectionId),
      fetchDataMoverDrivers(activeConnectionId),
    ])
    setBusy(null)
    if (!statusRes.ok) setError(statusRes.error ?? "data mover status failed")
    else setStatus(statusRes.result)
    if (driverRes.ok) setDrivers(driverRes.result)
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [activeConnectionId, hasRvbbit, refresh])

  const probe = useCallback(async (kind: "source" | "destination") => {
    if (!activeConnectionId) return
    setBusy(kind === "source" ? "probe-source" : "probe-dest")
    setError(null)
    const res = await probeDataMoverConnection(
      activeConnectionId,
      kind === "source" ? sourceDriver : destDriver,
      kind === "source" ? sourceUri : destUri,
    )
    setBusy(null)
    if (!res.ok) setError(res.error ?? "probe failed")
    setResult(res.result ?? res)
  }, [activeConnectionId, sourceDriver, sourceUri, destDriver, destUri])

  const installDriver = useCallback(async (driver: string) => {
    if (!activeConnectionId) return
    setBusy(`install-${driver}`)
    setError(null)
    const res = await installDataMoverDriver(activeConnectionId, driver)
    setBusy(null)
    if (!res.ok) setError(res.error ?? "driver install failed")
    setResult(res.result ?? res)
    await refresh()
  }, [activeConnectionId, refresh])

  const runTransfer = useCallback(async (dryRun: boolean) => {
    if (!activeConnectionId) return
    setBusy(dryRun ? "dry-run" : "run")
    setError(null)
    const res = await runDataMoverTransfer(activeConnectionId, {
      source: { driver: sourceDriver, uri: sourceUri },
      destination: { driver: destDriver, uri: destUri },
      dest_table: destTable,
      query,
      ingest_mode: ingestMode,
      transfer_mode: transferMode,
      dry_run: dryRun,
      auto_install_drivers: autoInstall,
    })
    setBusy(null)
    if (!res.ok) setError(res.error ?? "transfer failed")
    setResult(res.result ?? res)
  }, [
    activeConnectionId,
    sourceDriver,
    sourceUri,
    destDriver,
    destUri,
    destTable,
    query,
    ingestMode,
    transferMode,
    autoInstall,
  ])

  if (!hasRvbbit) {
    return <Centered icon={Database}>This connection has no <span className="font-mono">pg_rvbbit</span> extension.</Centered>
  }
  if (!activeConnectionId) {
    return <Centered icon={Database}>No active connection.</Centered>
  }

  return (
    <div className="flex h-full flex-col bg-background text-chrome-text">
      <header className="flex items-center gap-2 border-b border-chrome-border px-3 py-2">
        <Database className="h-4 w-4 text-rvbbit-accent" />
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-foreground">Data Mover</div>
          <div className="truncate text-[10px] text-chrome-text/55">Fletch ADBC import/export runtime</div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy === "refresh"}
          className="ml-auto inline-flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[11px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy === "refresh" && "animate-spin")} />
          Refresh
        </button>
      </header>

      {error ? (
        <div className="flex items-start gap-2 border-b border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-danger/70 hover:text-danger">x</button>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,480px)_1fr] gap-3 overflow-auto p-3">
        <div className="flex min-h-0 flex-col gap-3">
          <Panel icon={Upload} title="Source">
            <EndpointForm
              drivers={knownDrivers}
              driver={sourceDriver}
              uri={sourceUri}
              onDriver={setSourceDriver}
              onUri={setSourceUri}
            />
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void probe("source")} busy={busy === "probe-source"} icon={Check}>Probe</Button>
              <Button onClick={() => void installDriver(sourceDriver)} busy={busy === `install-${sourceDriver}`} icon={Package}>Install driver</Button>
            </div>
          </Panel>

          <Panel icon={Download} title="Destination">
            <EndpointForm
              drivers={knownDrivers}
              driver={destDriver}
              uri={destUri}
              onDriver={setDestDriver}
              onUri={setDestUri}
            />
            <label className="mt-2 block text-[10px] uppercase tracking-wide text-chrome-text/65">
              Destination table
              <input
                value={destTable}
                onChange={(e) => setDestTable(e.target.value)}
                className="mt-1 w-full rounded border border-chrome-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-rvbbit-accent/60"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void probe("destination")} busy={busy === "probe-dest"} icon={Check}>Probe</Button>
              <Button onClick={() => void installDriver(destDriver)} busy={busy === `install-${destDriver}`} icon={Package}>Install driver</Button>
            </div>
          </Panel>

          <Panel icon={Play} title="Options">
            <div className="grid grid-cols-2 gap-2">
              <Select label="Ingest" value={ingestMode} onChange={(v) => setIngestMode(v as IngestMode)} options={["create", "append", "replace"]} />
              <Select label="Mode" value={transferMode} onChange={(v) => setTransferMode(v as TransferMode)} options={["batch", "streaming"]} />
            </div>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-chrome-text">
              <input type="checkbox" checked={autoInstall} onChange={(e) => setAutoInstall(e.target.checked)} />
              Auto-install missing drivers during transfer
            </label>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => void runTransfer(true)} busy={busy === "dry-run"} icon={Check}>Dry run</Button>
              <Button primary onClick={() => void runTransfer(false)} busy={busy === "run"} icon={Play}>Run</Button>
            </div>
          </Panel>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel icon={Database} title="Query" className="min-h-[260px]">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              className="h-52 w-full resize-none rounded border border-chrome-border bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-rvbbit-accent/60"
            />
          </Panel>

          <Panel icon={Package} title="Runtime">
            <pre className="max-h-44 overflow-auto rounded bg-black/20 p-2 text-[10.5px] leading-relaxed text-chrome-text/80">
              {stringifyResult(status || drivers) || "No runtime response yet."}
            </pre>
          </Panel>

          <Panel icon={Check} title="Result" className="min-h-0 flex-1">
            <pre className="max-h-[420px] overflow-auto rounded bg-black/25 p-2 text-[10.5px] leading-relaxed text-chrome-text/85">
              {stringifyResult(result) || "No transfer output yet."}
            </pre>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function EndpointForm({
  drivers,
  driver,
  uri,
  onDriver,
  onUri,
}: {
  drivers: string[]
  driver: string
  uri: string
  onDriver: (v: string) => void
  onUri: (v: string) => void
}) {
  return (
    <div className="grid gap-2">
      <Select label="Driver" value={driver} onChange={onDriver} options={drivers} />
      <label className="block text-[10px] uppercase tracking-wide text-chrome-text/65">
        URI
        <input
          value={uri}
          onChange={(e) => onUri(e.target.value)}
          className="mt-1 w-full rounded border border-chrome-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:border-rvbbit-accent/60"
        />
      </label>
    </div>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <label className="block text-[10px] uppercase tracking-wide text-chrome-text/65">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-chrome-border bg-background px-2 py-1.5 text-[11px] text-foreground outline-none focus:border-rvbbit-accent/60"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </label>
  )
}

function Button({
  children,
  onClick,
  busy,
  primary,
  icon: Icon,
}: {
  children: ReactNode
  onClick: () => void
  busy?: boolean
  primary?: boolean
  icon: ComponentType<{ className?: string }>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-medium disabled:opacity-50",
        primary
          ? "border-rvbbit-accent/50 bg-rvbbit-accent/15 text-rvbbit-accent hover:bg-rvbbit-accent/25"
          : "border-chrome-border bg-secondary-background text-foreground hover:bg-foreground/[0.06]",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", busy && "animate-pulse")} />
      {children}
    </button>
  )
}

function Centered({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text">
      <div>
        <Icon className="mx-auto mb-2 h-8 w-8 text-chrome-text/35" />
        {children}
      </div>
    </div>
  )
}
