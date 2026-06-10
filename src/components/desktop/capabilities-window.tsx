"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Globe,
  Package,
  Plug,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Search,
  Tag,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  capabilityTypeTone,
  classifyCatalogCapabilityType,
  fetchCatalog,
  fetchInstalledBackends,
  fetchInstalledRuntimes,
  flagsToStates,
  importCapabilityCatalogUrl,
  joinCatalogToInstalled,
  type CatalogDoc,
  type InstalledBackend,
  type InstalledRuntime,
  type JoinedCatalogEntry,
} from "@/lib/rvbbit/capabilities"
import {
  fetchWarrenAvailability,
  fetchWarrenInventory,
  nodeFitsVram,
  nodeIsEligible,
  uniqueNodesFromInventory,
  type WarrenAvailability,
  type WarrenInventoryRow,
} from "@/lib/rvbbit/warren"
import { Sparkline } from "./sparkline"
import { OperatorChips, type OpChip } from "./capability-operators"
import {
  fmtAgo,
  fmtCount,
  fmtMs,
  InstallStateBadgeGroup,
} from "./instruments"
import {
  CapabilityTypeChip,
  CapabilityTypeWash,
  capabilityTypeStyle,
} from "./capability-type-visuals"

interface CapabilitiesWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  initialTag?: string | null
  onOpenCapability: (catalogId: string) => void
  onOpenWarren?: () => void
  onOpenHfDeploy?: () => void
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
  onOpenHfDeploy,
}: CapabilitiesWindowProps) {
  const [catalog, setCatalog] = useState<CatalogDoc | null>(null)
  const [installed, setInstalled] = useState<InstalledBackend[]>([])
  const [runtimes, setRuntimes] = useState<InstalledRuntime[]>([])
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
  const [warrenInventory, setWarrenInventory] = useState<WarrenInventoryRow[]>([])
  const [catalogOrigin, setCatalogOrigin] = useState<"db" | "file" | null>(null)
  const [selectedSources, setSelectedSources] = useState<Set<string>>(() => new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [importUrl, setImportUrl] = useState("")
  const [importSource, setImportSource] = useState("")
  const [importPrune, setImportPrune] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<{
    ok: boolean
    message: string
  } | null>(null)
  const loadingCatalog = catalog == null && catalogError == null

  const loadCatalog = useCallback(async () => {
    const r = await fetchCatalog(activeConnectionId)
    setCatalog(r.doc)
    setCatalogError(r.error ?? null)
    setCatalogOrigin(r.source ?? null)
  }, [activeConnectionId])

  const pollInstalled = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    const [b, rt] = await Promise.all([
      fetchInstalledBackends(activeConnectionId),
      fetchInstalledRuntimes(activeConnectionId),
    ])
    setInstalled(b.backends)
    setRuntimes(rt.runtimes)
    setInstalledError(b.error ?? null)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, hasRvbbit])

  const pollWarrenInventory = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    const inv = await fetchWarrenInventory(activeConnectionId)
    setWarrenInventory(inv.rows)
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
      const [r, inv] = await Promise.all([
        fetchWarrenAvailability(activeConnectionId),
        fetchWarrenInventory(activeConnectionId),
      ])
      if (cancelled) return
      setWarrenAvail(r)
      setWarrenInventory(inv.rows)
    }
    void probe()
    const id = setInterval(() => void probe(), 15_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeConnectionId, hasRvbbit])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit || paused) return
    const id = setInterval(() => void pollWarrenInventory(), intervalMs)
    return () => clearInterval(id)
  }, [activeConnectionId, hasRvbbit, paused, intervalMs, pollWarrenInventory])

  // ── derive ──
  const join = useMemo(() => {
    if (!catalog) return null
    return joinCatalogToInstalled(catalog.capabilities, installed, runtimes)
  }, [catalog, installed, runtimes])

  const allTags = useMemo<[string, number][]>(() => {
    if (!catalog) return []
    const counts = new Map<string, number>()
    for (const e of catalog.capabilities) {
      for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [catalog])

  const allSources = useMemo<[string, number][]>(() => {
    if (!catalog) return []
    const counts = new Map<string, number>()
    for (const e of catalog.capabilities) {
      const source = e.catalog_source || "unknown"
      counts.set(source, (counts.get(source) ?? 0) + 1)
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
      // OR semantics — keep an entry if it carries any of the selected tags.
      v = v.filter((e) => {
        const tags = new Set(e.catalog.tags ?? [])
        for (const t of selectedTags) if (tags.has(t)) return true
        return false
      })
    }
    if (selectedSources.size > 0) {
      v = v.filter((e) => selectedSources.has(e.catalog.catalog_source || "unknown"))
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
  }, [join, selectedTags, selectedSources, search])

  // Heaviest VRAM reservation among the visible packs — the gauge on each
  // card is normalized to this, so the bars read as relative "weight".
  const maxVram = useMemo(
    () => visible.reduce((m, e) => Math.max(m, e.catalog.vram_required_bytes ?? 0), 0),
    [visible],
  )

  const totalCatalog = catalog?.capabilities.length ?? 0
  const totalRegistered = join?.entries.filter((e) => e.flags.registered).length ?? 0
  const totalUsed = join?.entries.filter((e) => e.flags.used).length ?? 0
  const totalErrors = join?.entries.filter((e) => e.flags.errorSeen).length ?? 0
  const totalExternal = join?.external.length ?? 0

  const handleImportCatalog = useCallback(async () => {
    if (!activeConnectionId || importUrl.trim().length === 0) return
    setImporting(true)
    setImportStatus(null)
    const result = await importCapabilityCatalogUrl({
      connectionId: activeConnectionId,
      url: importUrl.trim(),
      catalogSource: importSource.trim() || undefined,
      prune: importPrune,
    })
    setImporting(false)
    if (!result.ok) {
      setImportStatus({
        ok: false,
        message: result.error ?? "catalog import failed",
      })
      return
    }
    setImportStatus({
      ok: true,
      message: `imported ${result.imported ?? 0} pack${(result.imported ?? 0) === 1 ? "" : "s"} into ${result.catalogSource ?? "catalog"}`,
    })
    await loadCatalog()
    await pollInstalled()
  }, [activeConnectionId, importUrl, importSource, importPrune, loadCatalog, pollInstalled])

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
        <div>
          <Package className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
          This connection has no <span className="font-mono">pg_rvbbit</span> extension —
          capabilities require it to register backends.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
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
        {catalogOrigin ? (
          <span
            className="rounded bg-foreground/[0.05] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/60"
            title={catalogOrigin === "db" ? "Browsing rvbbit.capability_catalog" : "Fallback catalog.json"}
          >
            {catalogOrigin}
          </span>
        ) : null}
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
          {onOpenHfDeploy ? (
              <button
                type="button"
                onClick={onOpenHfDeploy}
                className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-2 py-0.5 text-[10px] text-brand-capability hover:bg-brand-capability/15"
                title="Deploy any Hugging Face model by id — no per-model pack needed"
              >
                <Sparkles className="h-3 w-3" />
                Hugging Face
              </button>
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
            {activeConnectionId ? (
              <button
                type="button"
                onClick={() => setImportOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-full border border-brand-capability/40 bg-brand-capability/10 px-2 py-0.5 text-[10px] text-brand-capability hover:bg-brand-capability/15"
                title="Import an external capability catalog URL into rvbbit.capability_catalog"
              >
                <Globe className="h-3 w-3" />
                catalog URL
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
      {importOpen ? (
        <div className="border-b border-chrome-border bg-chrome-bg/25 px-3 py-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[260px] flex-1">
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
                catalog url
              </div>
              <input
                type="url"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://example.com/rvbbit-capability-seed.json"
                className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="w-[210px]">
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
                source label
              </div>
              <input
                type="text"
                value={importSource}
                onChange={(e) => setImportSource(e.target.value)}
                placeholder="url:team-capabilities"
                className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <label className="flex h-7 items-center gap-1.5 rounded border border-chrome-border bg-secondary-background px-2 text-[10px] text-chrome-text">
              <input
                type="checkbox"
                checked={importPrune}
                onChange={(e) => setImportPrune(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-capability"
              />
              prune missing
            </label>
            <button
              type="button"
              onClick={() => void handleImportCatalog()}
              disabled={importing || !activeConnectionId || importUrl.trim().length === 0}
              className="inline-flex h-7 items-center gap-1 rounded border border-brand-capability/45 bg-brand-capability/15 px-2.5 text-[10px] font-medium uppercase tracking-wider text-brand-capability hover:bg-brand-capability/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Plus className="h-3 w-3" />
              {importing ? "importing" : "import"}
            </button>
          </div>
          {importStatus ? (
            <div
              className={cn(
                "mt-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px]",
                importStatus.ok
                  ? "border-success/40 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger",
              )}
            >
              {importStatus.ok ? (
                <CheckCircle2 className="mt-px h-3 w-3 shrink-0" />
              ) : (
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              )}
              <span className="break-words">{importStatus.message}</span>
            </div>
          ) : null}
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
          {allTags.length > 0 ? (
            <TagFilterDropdown
              tags={allTags}
              liveCounts={liveTagCounts}
              selected={selectedTags}
              onToggle={(tag) =>
                setSelectedTags((prev) => {
                  const next = new Set(prev)
                  if (next.has(tag)) next.delete(tag)
                  else next.add(tag)
                  return next
                })
              }
              onClear={() => setSelectedTags(new Set())}
            />
          ) : null}
        </div>
        {allSources.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1 border-t border-chrome-border/35 pt-1.5">
            <span className="mr-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
              sources
            </span>
            {allSources.map(([source, total]) => {
              const active = selectedSources.has(source)
              return (
                <button
                  key={source}
                  type="button"
                  onClick={() =>
                    setSelectedSources((prev) => {
                      const next = new Set(prev)
                      if (next.has(source)) next.delete(source)
                      else next.add(source)
                      return next
                    })
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition",
                    active
                      ? "border-brand-capability/50 bg-brand-capability/15 text-brand-capability"
                      : "border-chrome-border bg-secondary-background text-chrome-text hover:text-foreground",
                  )}
                  title={`${source} — ${total} pack${total === 1 ? "" : "s"}`}
                >
                  <Globe className="h-2.5 w-2.5" />
                  <span className="max-w-[220px] truncate font-mono">{source}</span>
                  <span className="font-mono tabular-nums text-chrome-text/55">
                    {total}
                  </span>
                </button>
              )
            })}
            {selectedSources.size > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedSources(new Set())}
                className="inline-flex items-center gap-1 text-[10px] text-chrome-text/55 hover:text-foreground"
              >
                <X className="h-3 w-3" />
                clear sources
              </button>
            ) : null}
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
                warrenNodes={uniqueNodesFromInventory(warrenInventory)}
                maxVram={maxVram}
                onOpen={() => onOpenCapability(e.catalog.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── tag filter ──────────────────────────────────────────────────────

/**
 * Multi-select tag filter, collapsed into a single control beside the
 * search box so the catalog's long tag list no longer eats a row of
 * wrapping chips. Each row shows how many currently-searched packs carry
 * the tag; click-away or Escape closes.
 */
function TagFilterDropdown({
  tags,
  liveCounts,
  selected,
  onToggle,
  onClear,
}: {
  tags: [string, number][]
  liveCounts: Map<string, number>
  selected: Set<string>
  onToggle: (tag: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  const count = selected.size

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded border px-2 text-[11px] transition",
          count > 0
            ? "border-brand-capability/50 bg-brand-capability/15 text-brand-capability"
            : "border-chrome-border bg-secondary-background text-chrome-text hover:text-foreground",
        )}
        title="Filter by tags"
      >
        <Tag className="h-3 w-3" />
        <span>Tags</span>
        {count > 0 ? (
          <span className="rounded-full bg-brand-capability/25 px-1.5 font-mono text-[10px] tabular-nums">
            {count}
          </span>
        ) : null}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open ? "rotate-180" : "")} />
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-60 overflow-hidden rounded-md border border-chrome-border bg-chrome-bg/95 shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-chrome-border/60 px-2 py-1.5 text-[9px] uppercase tracking-wider text-chrome-text/55">
            <span>{tags.length} tags</span>
            {count > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className="inline-flex items-center gap-1 normal-case tracking-normal text-chrome-text/70 hover:text-foreground"
              >
                <X className="h-3 w-3" />
                clear {count}
              </button>
            ) : null}
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            {tags.map(([tag, total]) => {
              const live = liveCounts.get(tag) ?? 0
              const checked = selected.has(tag)
              const dimmed = !checked && live === 0
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onToggle(tag)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors hover:bg-foreground/[0.06]",
                    dimmed ? "opacity-45" : "",
                  )}
                  title={`${tag} — ${total} total, ${live} match current search`}
                >
                  <span
                    className={cn(
                      "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border",
                      checked
                        ? "border-brand-capability bg-brand-capability text-chrome-bg"
                        : "border-chrome-border",
                    )}
                  >
                    {checked ? <CheckCircle2 className="h-3 w-3" /> : null}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      checked ? "text-brand-capability" : "text-chrome-text",
                    )}
                  >
                    {tag}
                  </span>
                  <span className="font-mono tabular-nums text-chrome-text/45">{live}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
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
      c.backend_name ?? "",
      c.runtime_name ?? "",
      c.catalog_source ?? "",
      c.capability_role ?? "",
      c.system_runtime ? "system runtime operator runtime" : "",
      c.runtime_handler,
      ...(c.acceptance_tests ?? []),
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
  warrenNodes,
  maxVram,
  onOpen,
}: {
  entry: JoinedCatalogEntry
  warrenNodes: WarrenInventoryRow[]
  maxVram: number
  onOpen: () => void
}) {
  const { catalog, installed, installedRuntime, flags } = entry
  const states = flagsToStates(flags)
  const typeTone = capabilityTypeTone(classifyCatalogCapabilityType(catalog))
  // MCP capabilities are a different *kind* of thing from model packs (tools
  // over a gateway, not weights) — give them their own icon, an accent rail,
  // and an MCP-shaped facts row so they read as distinct at a glance, not just
  // via the type chip.
  const isMcp = catalog.kind === "mcp"
  // Installed *and* live — a registered backend that's healthy, in use, or a
  // ready runtime. These get the prominent treatment.
  const active =
    flags.registered && (flags.used || flags.healthy === true || flags.runtimeReady)
  // The SQL operators this pack registers. Prefer the rich inline-manifest
  // defs; fall back to bare names from the catalog row.
  const opDefs = catalog.manifest?.operators ?? []
  const opByName = new Map(opDefs.map((d) => [d.name, d]))
  const opChips: OpChip[] =
    catalog.operators.length > 0
      ? catalog.operators.map((n) => opByName.get(n) ?? { name: n })
      : opDefs
  const testCount = catalog.acceptance_tests.length
  const vramRequired = catalog.vram_required_bytes
  const gpuPlacement = catalog.gpu_placement ?? "single_gpu"
  const eligibleGpuNodes = warrenNodes.filter(
    (n) =>
      (n.gpu_count ?? 0) > 0 &&
      nodeIsEligible(n),
  )
  const fitCount =
    vramRequired == null
      ? 0
      : eligibleGpuNodes.filter((n) => nodeFitsVram(n, vramRequired, gpuPlacement) === "fits").length
  const gpuFit =
    vramRequired == null
      ? null
      : fitCount > 0
        ? "fits"
        : eligibleGpuNodes.length === 0
          ? "no_gpu"
          : "insufficient"
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-md border p-2.5 pl-3.5 text-left transition",
        active
          ? "border-brand-capability/60 bg-brand-capability/[0.07] shadow-[0_0_0_1px_var(--brand-capability)] ring-1 ring-brand-capability/30 hover:bg-brand-capability/[0.1]"
          : flags.registered
            ? "border-chrome-border bg-secondary-background/50 ring-1 ring-brand-capability/15 hover:border-brand-capability/40 hover:bg-secondary-background/70"
            : "border-chrome-border bg-secondary-background/40 hover:border-brand-capability/40 hover:bg-secondary-background/70",
      )}
      style={capabilityTypeStyle(typeTone)}
    >
      <CapabilityTypeWash active={active} registered={flags.registered} />
      {isMcp ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-[var(--cap-type)]/70"
        />
      ) : null}
      <WeightBar bytes={vramRequired} max={maxVram} />

      {/* title row */}
      <div className="flex items-start gap-1.5">
        {isMcp ? (
          <Plug
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            style={{ color: "var(--cap-type)" }}
          />
        ) : (
          <Package
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            style={{ color: "var(--cap-type)" }}
          />
        )}
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
        <CapabilityTypeChip tone={typeTone} />
        <span
          className="rounded-full border border-chrome-border/50 bg-foreground/[0.03] px-1.5 py-px font-mono text-[9px] text-chrome-text/60"
          title={`catalog source: ${catalog.catalog_source}`}
        >
          {catalog.catalog_source}
        </span>
        {testCount > 0 ? (
          <span
            className="rounded-full border border-success/35 bg-success/10 px-1.5 py-px text-[9px] uppercase tracking-wider text-success"
            title={catalog.acceptance_tests.join(", ")}
          >
            {testCount} test{testCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {catalog.system_runtime ? (
          <span
            className="rounded-full border border-brand-capability/40 bg-brand-capability/10 px-1.5 py-px text-[9px] uppercase tracking-wider text-brand-capability"
            title="Operator runtime capability"
          >
            runtime
          </span>
        ) : null}
        {vramRequired != null ? (
          <GpuWeightChip
            bytes={vramRequired}
            required={catalog.gpu_required}
            fit={gpuFit}
            fitCount={fitCount}
          />
        ) : null}
      </div>

      {/* facts row — MCP cards describe a tool surface, not a model artifact */}
      {isMcp ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-chrome-text/55">
          <span className="font-mono text-[var(--cap-type)]">MCP server</span>
          <span>·</span>
          <span>
            {catalog.operators.length} operator{catalog.operators.length === 1 ? "" : "s"}
          </span>
          {catalog.tags.includes("mcp") && catalog.runtime_handler ? (
            <>
              <span>·</span>
              <span className="font-mono">{catalog.runtime_handler}</span>
            </>
          ) : null}
        </div>
      ) : (
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
      )}

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
      {!installed && installedRuntime ? (
        <div className="mt-2 border-t border-chrome-border/40 pt-1.5 text-[10px] text-chrome-text/55">
          runtime{" "}
          <span className="font-mono text-foreground">{installedRuntime.name}</span>{" "}
          <span className="text-chrome-text/45">·</span>{" "}
          <span className="text-success">{installedRuntime.status}</span>
        </div>
      ) : null}

      {/* the SQL operators this pack unlocks — what people shop for */}
      <OperatorChips operators={opChips} />
    </button>
  )
}

/**
 * Slim vertical "weight" gauge on the card's left edge: VRAM reservation
 * normalized to the heaviest visible pack, filling bottom-up. CPU packs
 * (no GPU reservation) show the same bar, greyed and empty — a quick
 * at-a-glance sense of how heavy each capability is to host.
 */
function WeightBar({ bytes, max }: { bytes: number | null; max: number }) {
  const isGpu = bytes != null && bytes > 0
  const ratio = isGpu && max > 0 ? Math.min(1, bytes / max) : 0
  return (
    <div
      className="absolute bottom-1 left-1 top-1 w-[3px] overflow-hidden rounded-full bg-foreground/[0.06]"
      title={
        isGpu
          ? `${fmtBytes(bytes)} VRAM — relative to the heaviest visible pack`
          : "CPU — no GPU reservation"
      }
    >
      <div
        className="absolute inset-x-0 bottom-0 rounded-full"
        style={{
          height: isGpu ? `${Math.max(5, ratio * 100)}%` : "100%",
          background: isGpu ? "var(--brand-capability)" : "var(--chrome-text)",
          opacity: isGpu ? 0.55 : 0.14,
        }}
      />
    </div>
  )
}

function GpuWeightChip({
  bytes,
  required,
  fit,
  fitCount,
}: {
  bytes: number
  required: boolean
  fit: "fits" | "no_gpu" | "insufficient" | null
  fitCount: number
}) {
  const tone =
    fit === "fits"
      ? "border-success/35 bg-success/10 text-success"
      : fit === "insufficient"
        ? "border-danger/35 bg-danger/10 text-danger"
        : fit === "no_gpu"
          ? "border-warning/35 bg-warning/10 text-warning"
          : "border-warning/35 bg-warning/10 text-warning"
  const title =
    fit === "fits"
      ? `${fitCount} ready GPU Warren node${fitCount === 1 ? "" : "s"} can fit this reservation`
      : fit === "insufficient"
        ? "No ready GPU Warren has enough unreserved VRAM"
        : fit === "no_gpu"
          ? "No ready GPU Warren nodes are visible"
          : "Estimated GPU reservation"
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider",
        tone,
      )}
      title={title}
    >
      {required ? "gpu " : "gpu opt "}
      {fmtBytes(bytes)}
    </span>
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

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  const digits = value >= 10 || idx === 0 ? 0 : 1
  return `${value.toFixed(digits)}${units[idx]}`
}
