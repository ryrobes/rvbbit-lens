"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Settings2,
  Sparkles,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo } from "./instruments"
import type { ExtensionInfo } from "@/lib/db/types"

interface ExtensionsWindowProps {
  activeConnectionId: string | null
  onOpenRvbbitCache: () => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
  { ms: 60_000, label: "1m" },
  { ms: 300_000, label: "5m" },
]

/**
 * Installed Postgres extensions, surfaced as a card grid. The rvbbit
 * extension gets a featured first slot with a brand halo + a direct
 * link into the Rvbbit Cache window; everything else lays out as
 * compact cards with name/version/schema/description.
 */
export function ExtensionsWindow({
  activeConnectionId,
  onOpenRvbbitCache,
}: ExtensionsWindowProps) {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(30_000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    try {
      const res = await fetch(
        `/api/db/extensions?connectionId=${encodeURIComponent(activeConnectionId)}`,
        { cache: "no-store" },
      )
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? "failed")
      setExtensions(body.extensions as ExtensionInfo[])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUpdatedAt(Date.now())
    }
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [reload])

  useEffect(() => {
    if (!activeConnectionId || paused) return
    const id = setInterval(() => void reload(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, paused, intervalMs, reload])

  const rvbbit = extensions.find((e) => isRvbbitExtension(e.name))
  const others = extensions.filter((e) => !isRvbbitExtension(e.name))

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
          <Settings2 className="h-3.5 w-3.5 text-brand-extensions" />
          {loading ? "loading…" : `${extensions.length} extension${extensions.length === 1 ? "" : "s"}`}
        </span>
        {rvbbit ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span className="inline-flex items-center gap-1 text-rvbbit-accent">
              <Sparkles className="h-3 w-3" />
              rvbbit {rvbbit.version}
            </span>
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
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            loading…
          </div>
        ) : extensions.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-[11px] text-chrome-text/55">
            <div>
              <Plug className="mx-auto mb-2 h-6 w-6 text-chrome-text/30" />
              no extensions installed
            </div>
          </div>
        ) : (
          <>
            {rvbbit ? (
              <div className="mb-3">
                <RvbbitExtensionCard
                  extension={rvbbit}
                  onOpenCache={onOpenRvbbitCache}
                />
              </div>
            ) : null}
            {others.length > 0 ? (
              <>
                {rvbbit ? (
                  <div className="mb-2 text-[9px] uppercase tracking-wider text-chrome-text/50">
                    other extensions · {others.length}
                  </div>
                ) : null}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
                  {others.map((e) => (
                    <ExtensionCard key={e.name} extension={e} />
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function isRvbbitExtension(name: string): boolean {
  return name === "rvbbit" || name === "pg_rvbbit"
}

function RvbbitExtensionCard({
  extension,
  onOpenCache,
}: {
  extension: ExtensionInfo
  onOpenCache: () => void
}) {
  return (
    <section
      className="rounded-md border-2 border-rvbbit-accent/40 bg-rvbbit-bg/40 p-3"
      style={{
        boxShadow:
          "0 0 0 1px color-mix(in oklch, var(--rvbbit-accent) 12%, transparent), 0 2px 12px color-mix(in oklch, var(--rvbbit-accent) 18%, transparent)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-rvbbit-accent/40 bg-rvbbit-bg">
          <Sparkles className="h-5 w-5 text-rvbbit-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[13px] font-medium text-foreground">
              {extension.name}
            </span>
            <span className="rounded bg-foreground/[0.08] px-1 font-mono text-[10px] text-chrome-text/75">
              {extension.version}
            </span>
            <span className="font-mono text-[10px] text-chrome-text/55">
              schema: {extension.schema}
            </span>
          </div>
          {extension.description ? (
            <p className="mt-1 text-[11px] leading-snug text-chrome-text/85">
              {extension.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpenCache}
          className="inline-flex shrink-0 items-center gap-1 self-start rounded border border-rvbbit-accent/50 bg-rvbbit-accent/15 px-2 py-1 text-[10px] uppercase tracking-wider text-rvbbit-accent hover:bg-rvbbit-accent/25"
        >
          <Sparkles className="h-3 w-3" />
          Open cache
        </button>
      </div>
    </section>
  )
}

function ExtensionCard({ extension }: { extension: ExtensionInfo }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-chrome-border bg-secondary-background/40 p-2.5">
      <div className="flex items-baseline gap-1.5">
        <Plug className="h-3 w-3 shrink-0 text-brand-extensions" />
        <span className="truncate font-mono text-[12px] font-medium text-foreground">
          {extension.name}
        </span>
        <span className="ml-auto shrink-0 rounded bg-foreground/[0.05] px-1 font-mono text-[9px] text-chrome-text/65">
          {extension.version}
        </span>
      </div>
      <div className="font-mono text-[10px] text-chrome-text/50">
        schema: {extension.schema}
      </div>
      {extension.description ? (
        <p className="line-clamp-3 text-[10px] leading-snug text-chrome-text/75">
          {extension.description}
        </p>
      ) : (
        <p className="text-[10px] italic text-chrome-text/40">no description</p>
      )}
    </section>
  )
}
