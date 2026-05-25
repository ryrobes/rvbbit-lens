"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Cpu,
  Package,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Search,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchCatalog,
  fetchInstalledBackends,
  flagsToStates,
  joinCatalogToInstalled,
  type CatalogDoc,
  type InstalledBackend,
  type JoinedCatalogEntry,
} from "@/lib/rvbbit/capabilities"
import { fetchWarrenAvailability, type WarrenAvailability } from "@/lib/rvbbit/warren"
import { Sparkline } from "./sparkline"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  InstallStateBadgeGroup,
} from "./instruments"

interface CapabilitiesWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  initialTag?: string | null
  onOpenCapability: (catalogId: string) => void
  onOpenWarren?: () => void
}

const REFRESH_OPTIONS_MS = [
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
  { ms: 10_000, label: "10s" },
  { ms: 30_000, label: "30s" },
]

/**
 * The capability catalog browser — front door to the install/discovery
 * layer over `rvbbit.backends`. Reads catalog.json from disk (via the
 * /api/rvbbit/capabilities route) once on mount, polls
 * `rvbbit.backend_health` on the configured interval to keep
 * install-state badges fresh.
 *
 * Cards group by (matching tags + matching search query); clicking a
 * card opens its Capability Detail window.
 */
export function CapabilitiesWindow({
  activeConnectionId,
  hasRvbbit,
  initialTag,
  onOpenCapability,
  onOpenWarren,
}: CapabilitiesWindowProps) {
  const [catalog, setCatalog] = useState<CatalogDoc | null>(null)
  const [installed, setInstalled] = useState<InstalledBackend[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [selectedTags, setSelectedTags] = useState<Set<string>>(
    () => new Set(initialTag ? [initialTag] : []),
  )
  const [search, setSearch] = useState("")
  const [paused, setPaused] = useState(false)
  const [intervalMs, setIntervalMs] = useState(5000)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [warrenAvail, setWarrenAvail] = useState<WarrenAvailability | null>(null)
  const loadingCatalog = catalog == null && catalogError == null

  const loadCatalog = useCallback(async () => {
    const r = await fetchCatalog()
    setCatalog(r.doc)
    setCatalogError(r.error ?? null)
  }, [])

  const pollInstalled = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    const r = await fetchInstalledBackends(activeConnectionId)
    setInstalled(r.backends)
    setInstalledError(r.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, hasRvbbit])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await loadCatalog()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [loadCatalog])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await pollInstalled()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, pollInstalled])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void pollInstalled(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, pollInstalled])

  // ── warren availability (light probe, longer interval) ──
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const probe = async () => {
      const r = await fetchWarrenAvailability(activeConnectionId)
      if (cancelled) return
      setWarrenAvail(r)
    }
    void probe()
    const id = setInterval(() => void probe(), 15_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, hasRvbbit])

  // ── derive ──
  const join = useMemo(() => {
    if (!catalog) return null
    return joinCatalogToInstalled(catalog.capabilities, installed)
  }, [catalog, installed])

  const allTags = useMemo<[string, number][]>(() => {
    if (!catalog) return []
    const counts = new Map<string, number>()
    for (const e of catalog.capabilities) {
      for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [catalog])

  // Tag chip "running counts" — how many *currently visible* entries
  // would match if you toggled this tag. Lets the user see the impact
  // of each chip before clicking.
  const liveTagCounts = useMemo(() => {
    if (!catalog) return new Map<string, number>()
    const m = new Map<string, number>()
    const visibleBeforeTag = filterBySearchOnly(
      catalog.capabilities.map((c) => ({ catalog: c })),
      search,
    )
    for (const e of visibleBeforeTag) {
      for (const t of e.catalog.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return m
  }, [catalog, search])

  const visible = useMemo(() => {
    if (!join) return [] as JoinedCatalogEntry[]
    let v = join.entries
    if (selectedTags.size > 0) {
      v = v.filter((e) => {
        const tags = new Set(e.catalog.tags ?? [])
        for (const t of selectedTags) if (!tags.has(t)) return false
        return true
      })
    }
    if (search.trim().length > 0) {
      v = filterBySearchOnly(v, search) as JoinedCatalogEntry[]
    }
    // sort: installed-and-used first, then registered, then catalog-only.
    return [...v].sort((a, b) => {
      const order = (e: JoinedCatalogEntry) =>
        (e.flags.used ? 0 : e.flags.registered ? 1 : 2) * 1000 -
        (e.installed?.n_calls ?? 0)
      const r = order(a) - order(b)
      if (r !== 0) return r
      return a.catalog.title.localeCompare(b.catalog.title)
    })
  }, [join, selectedTags, search])

  const totalCatalog = catalog?.capabilities.length ?? 0
  const totalRegistered = join?.entries.filter((e) => e.flags.registered).length ?? 0
  const totalUsed = join?.entries.filter((e) => e.flags.used).length ?? 0
  const totalErrors = join?.entries.filter((e) => e.flags.errorSeen).length ?? 0
  const totalExternal = join?.external.length ?? 0

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Package className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension —
          capabilities require it to register backends.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg text-[12px] text-chrome-text">
      {/* live/paused header bar */}
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
          <Package className="h-3.5 w-3.5 text-brand-capability" />
          {loadingCatalog ? "loading…" : `${totalCatalog} packs`}
        </span>
        {!loadingCatalog ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium text-brand-capability">{totalRegistered}</span>{" "}
              registered
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-medium tabular-nums text-rvbbit-accent">
                {fmtCount(totalUsed)}
              </span>{" "}
              in use
            </span>
            {totalErrors > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span className="text-danger">{totalErrors} with errors</span>
              </>
            ) : null}
            {totalExternal > 0 ? (
              <>
                <span className="text-chrome-text/40">·</span>
                <span
                  className="cursor-help text-chrome-text/55"
                  title="Backends installed outside the curated catalog"
                >
                  {totalExternal} external
                </span>
              </>
            ) : null}
            {warrenAvail?.available && onOpenWarren ? (
              <button
                type="button"
                onClick={onOpenWarren}
                className="inline-flex items-center gap-1 rounded-full border border-brand-warren/40 bg-brand-warren/10 px-2 py-0.5 text-[10px] text-brand-warren hover:bg-brand-warren/15"
                title={
                  warrenAvail.readyNodes > 0
                    ? `${warrenAvail.readyNodes} warren node(s) ready — deploys can go remote`
                    : "Warren tables present but no nodes ready"
                }
              >
                <Rocket className="h-3 w-3" />
                {warrenAvail.readyNodes > 0
                  ? `${warrenAvail.readyNodes} warren${warrenAvail.readyNodes === 1 ? "" : "s"} ready`
                  : `${warrenAvail.totalNodes} warren${warrenAvail.totalNodes === 1 ? "" : "s"}`}
              </button>
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
            title={paused ? "Resume polling" : "Pause polling"}
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => {
              void loadCatalog()
              void pollInstalled()
            }}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {catalogError ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{catalogError}</span>
        </div>
      ) : null}
      {installedError ? (
        <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">backend_health: {installedError}</span>
        </div>
      ) : null}

      {/* filter bar */}
      <div className="flex flex-col gap-2 border-b border-chrome-border bg-chrome-bg/20 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/45" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, model, description, operator…"
              className="h-7 w-full rounded border border-chrome-border bg-secondary-background pl-7 pr-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {selectedTags.size > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedTags(new Set())}
              className="inline-flex items-center gap-1 rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[10px] text-chrome-text hover:text-foreground"
            >
              <X className="h-3 w-3" />
              clear {selectedTags.size}
            </button>
          ) : null}
        </div>
        {allTags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {allTags.map(([tag, total]) => {
              const liveCount = liveTagCounts.get(tag) ?? 0
              const active = selectedTags.has(tag)
              const dimmed = !active && liveCount === 0
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setSelectedTags((prev) => {
                      const next = new Set(prev)
                      if (next.has(tag)) next.delete(tag)
                      else next.add(tag)
                      return next
                    })
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition",
                    active
                      ? "border-brand-capability/50 bg-brand-capability/15 text-brand-capability"
                      : "border-chrome-border bg-secondary-background text-chrome-text hover:text-foreground",
                    dimmed ? "opacity-40" : "",
                  )}
                  title={`${tag} — ${total} total, ${liveCount} match current search`}
                >
                  <span>{tag}</span>
                  <span className="font-mono tabular-nums text-chrome-text/55">
                    {liveCount}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/* card grid */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loadingCatalog ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            loading catalog…
          </div>
        ) : visible.length === 0 ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            {totalCatalog === 0 ? "no capabilities in catalog" : "no matches"}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">
            {visible.map((e) => (
              <CapabilityCard
                key={e.catalog.id}
                entry={e}
                onOpen={() => onOpenCapability(e.catalog.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────

function filterBySearchOnly<T extends { catalog: JoinedCatalogEntry["catalog"] }>(
  rows: T[],
  search: string,
): T[] {
  const q = search.trim().toLowerCase()
  if (q.length === 0) return rows
  return rows.filter((r) => {
    const c = r.catalog
    const hay = [
      c.id,
      c.name,
      c.title,
      c.description ?? "",
      c.source_model ?? "",
      c.source_provider ?? "",
      c.backend_name,
      c.runtime_handler,
      ...(c.tags ?? []),
      ...(c.operators ?? []),
    ]
      .join(" ")
      .toLowerCase()
    return hay.includes(q)
  })
}

function CapabilityCard({
  entry,
  onOpen,
}: {
  entry: JoinedCatalogEntry
  onOpen: () => void
}) {
  const { catalog, installed, flags } = entry
  const states = flagsToStates(flags)
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex flex-col rounded-md border border-chrome-border bg-secondary-background/40 p-2.5 text-left transition",
        "hover:border-brand-capability/40 hover:bg-secondary-background/70",
        flags.registered ? "ring-1 ring-brand-capability/20" : "",
      )}
    >
      {/* title row */}
      <div className="flex items-start gap-1.5">
        <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-capability" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground group-hover:text-brand-capability">
            {catalog.title}
          </div>
          <div className="truncate font-mono text-[10px] text-chrome-text/55">
            {catalog.name}
          </div>
        </div>
        <DeviceChip device={catalog.device} />
      </div>

      {/* description */}
      {catalog.description ? (
        <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-chrome-text/75">
          {catalog.description}
        </p>
      ) : null}

      {/* state badges */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <InstallStateBadgeGroup states={states} size="xs" />
      </div>

      {/* facts row */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-chrome-text/55">
        <span
          className="truncate font-mono text-chrome-text/65"
          title={catalog.source_model ?? ""}
        >
          {catalog.source_model ?? "—"}
        </span>
        {catalog.license ? (
          <>
            <span>·</span>
            <span className="font-mono">{catalog.license}</span>
          </>
        ) : null}
        <span>·</span>
        <span>{catalog.runtime_handler}</span>
      </div>

      {/* tags */}
      {catalog.tags && catalog.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {catalog.tags.slice(0, 5).map((t) => (
            <span
              key={t}
              className="rounded bg-foreground/[0.05] px-1 py-px text-[9px] text-chrome-text/60"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {/* installed stats — only when registered */}
      {installed ? <InstalledFooter installed={installed} /> : null}
    </button>
  )
}

function DeviceChip({ device }: { device: string }) {
  const tone =
    device === "cuda"
      ? "bg-warning/10 text-warning ring-warning/30"
      : device === "cpu"
        ? "bg-foreground/[0.05] text-chrome-text/60 ring-chrome-border/40"
        : "bg-brand-capability/10 text-brand-capability ring-brand-capability/30"
  return (
    <span
      title={`device preference: ${device}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wider ring-1",
        tone,
      )}
    >
      <Cpu className="h-2.5 w-2.5" />
      {device}
    </span>
  )
}

function InstalledFooter({ installed }: { installed: import("@/lib/rvbbit/capabilities").InstalledBackend }) {
  const callPoints = installed.n_calls > 0 && installed.first_call_at && installed.last_call_at
    ? buildSparkSeries(installed.first_call_at, installed.last_call_at, installed.n_calls)
    : []
  return (
    <div className="mt-2 border-t border-chrome-border/40 pt-1.5">
      <div className="flex items-center gap-2 text-[10px] text-chrome-text/55">
        <span>
          <span className="font-mono tabular-nums text-foreground">
            {fmtCount(installed.n_calls)}
          </span>{" "}
          calls
        </span>
        {installed.n_errors > 0 ? (
          <span className="text-danger">
            <span className="font-mono tabular-nums">{installed.n_errors}</span> err
          </span>
        ) : null}
        {installed.p95_latency_ms != null ? (
          <span>
            <span className="font-mono tabular-nums text-foreground">
              {fmtMs(installed.p95_latency_ms)}
            </span>{" "}
            p95
          </span>
        ) : null}
        {installed.last_call_at ? (
          <span className="ml-auto" title={new Date(installed.last_call_at).toISOString()}>
            {fmtAgo(installed.last_call_at)}
          </span>
        ) : null}
      </div>
      {callPoints.length > 0 ? (
        <Sparkline
          values={callPoints}
          height={18}
          color="var(--brand-capability)"
          fillOpacity={0.18}
          className="mt-1 opacity-90"
        />
      ) : null}
    </div>
  )
}

/**
 * `rvbbit.backend_health` rolls up at the per-backend level — we don't
 * get a per-call timeseries here. Synthesize a flat sparkline placeholder
 * that visually conveys "yes, this backend has had traffic", spanning
 * first_call_at..last_call_at. Real per-call shape lives in the
 * Specialist Detail window's ScatterStrip.
 */
function buildSparkSeries(firstMs: number, lastMs: number, total: number): number[] {
  const buckets = 14
  const out: number[] = new Array(buckets).fill(0)
  if (total <= 0 || lastMs <= firstMs) return out
  // single bucket if span is tiny
  const per = Math.max(1, Math.round(total / buckets))
  for (let i = 0; i < buckets; i++) out[i] = per
  return out
}
