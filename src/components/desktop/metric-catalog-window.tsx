"use client"

// ▦ Metric Catalog — a browsable table of every defined metric. This is the
// "directory" surface for the Metrics apps: search/sort across all metrics and
// dispatch to the Inspector (open a metric) or the Creator (new / edit). It is
// intentionally a styled HTML <table> (sticky header, dense rows) rather than a
// generic ResultGrid so we can wire row clicks + an inline edit affordance.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Pencil, Plus, RefreshCw, Search } from "@/lib/icons"
import { listMetrics, type MetricSummary } from "@/lib/rvbbit/metrics"
import { StatusNote, fmtTime } from "./metric-shared"

interface MetricCatalogWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenInspector: (name: string) => void
  onOpenCreator: (name?: string) => void
}

type SortField = "name" | "version" | "owner" | "createdAt"
type SortDir = "asc" | "desc"

export function MetricCatalogWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenInspector,
  onOpenCreator,
}: MetricCatalogWindowProps) {
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [sortField, setSortField] = useState<SortField>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    setError(null)
    try {
      const { metrics: rows, error: err } = await listMetrics(activeConnectionId)
      if (err) {
        setError(err)
        setMetrics([])
      } else {
        setMetrics(rows)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMetrics([])
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

  // Defer the initial / connection-change load to a microtask so we don't call
  // setState synchronously inside the effect body (cascading-render lint rule).
  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      if (!cancelled) void reload()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [reload])

  const toggleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
        return prev
      }
      // New field: default to descending for time, ascending for text/number.
      setSortDir(field === "createdAt" ? "desc" : "asc")
      return field
    })
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return metrics
    return metrics.filter((m) => {
      return (
        m.name.toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q) ||
        (m.owner ?? "").toLowerCase().includes(q)
      )
    })
  }, [metrics, search])

  const sorted = useMemo(() => {
    const rows = filtered.slice()
    const dir = sortDir === "asc" ? 1 : -1
    rows.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case "version":
          cmp = a.version - b.version
          break
        case "owner":
          cmp = (a.owner ?? "").localeCompare(b.owner ?? "")
          break
        case "createdAt": {
          // Sort null timestamps to the end (not as epoch 0).
          const at = a.createdAt ?? Number.MAX_SAFE_INTEGER
          const bt = b.createdAt ?? Number.MAX_SAFE_INTEGER
          cmp = at - bt
          break
        }
        case "name":
        default:
          cmp = a.name.localeCompare(b.name)
          break
      }
      if (cmp === 0 && sortField !== "name") cmp = a.name.localeCompare(b.name)
      return cmp * dir
    })
    return rows
  }, [filtered, sortField, sortDir])

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  const arrow = (field: SortField) =>
    sortField === field ? (sortDir === "asc" ? " ▲" : " ▼") : ""

  return (
    <div className="flex h-full min-h-0 flex-col text-foreground">
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px]">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--syntax-keyword)" }}>
          Metrics
        </span>
        <span className="tabular-nums text-chrome-text/60">{metrics.length}</span>

        <div className="relative ml-1 flex-1 max-w-[280px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / description / owner…"
            className="h-7 w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] pl-7 pr-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"
          />
        </div>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          title="Refresh"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-chrome-border/60 text-chrome-text/70 transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          onClick={() => onOpenCreator()}
          title="Create a new metric"
          className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[11px] text-main transition-colors hover:bg-main/25"
        >
          <Plus className="h-3 w-3" /> New metric
        </button>
      </div>

      {error ? (
        <StatusNote state="error" message={error} className="border-b border-danger/30" />
      ) : null}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && metrics.length === 0 ? (
          <StatusNote state="loading" message="Loading metrics…" />
        ) : sorted.length === 0 && metrics.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <StatusNote state="empty" message="No metrics yet — create one." />
            <button
              type="button"
              onClick={() => onOpenCreator()}
              className="ml-3 inline-flex h-7 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[11px] text-main transition-colors hover:bg-main/25"
            >
              <Plus className="h-3 w-3" /> New metric
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <StatusNote state="empty" message={`No metrics match "${search}".`} />
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-chrome-bg text-[10px] uppercase tracking-wider text-chrome-text/60">
              <tr className="border-b border-chrome-border/60">
                <Th onClick={() => toggleSort("name")} className="text-left">
                  Name{arrow("name")}
                </Th>
                <Th onClick={() => toggleSort("version")} className="text-right">
                  Ver{arrow("version")}
                </Th>
                <th className="px-2 py-1 text-left font-normal">Grain</th>
                <Th onClick={() => toggleSort("owner")} className="text-left">
                  Owner{arrow("owner")}
                </Th>
                <Th onClick={() => toggleSort("createdAt")} className="text-right">
                  Updated{arrow("createdAt")}
                </Th>
                <th className="px-2 py-1 text-left font-normal">Description</th>
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => (
                <tr
                  key={m.name}
                  onClick={() => onOpenInspector(m.name)}
                  title={`Open ${m.name} in the inspector`}
                  className="group cursor-pointer border-b border-chrome-border/20 hover:bg-foreground/[0.04]"
                >
                  <td className="px-3 py-1 font-mono text-foreground">{m.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-chrome-text/70">
                    v{m.version}
                  </td>
                  <td className="px-2 py-1 text-chrome-text/70">
                    {m.grain ?? <span className="text-chrome-text/30">—</span>}
                  </td>
                  <td className="px-2 py-1 text-chrome-text/70">
                    {m.owner ?? <span className="text-chrome-text/30">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-chrome-text/60">
                    {fmtTime(m.createdAt)}
                  </td>
                  <td className="max-w-[280px] px-2 py-1 text-chrome-text/60">
                    <span className="block truncate" title={m.description ?? undefined}>
                      {m.description ?? <span className="text-chrome-text/30">—</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      title="Edit this metric"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenCreator(m.name)
                      }}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[3px] text-chrome-text/40 opacity-0 transition-opacity hover:bg-foreground/[0.08] hover:text-foreground group-hover:opacity-100"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Th({
  onClick,
  className,
  children,
}: {
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <th className={`px-2 py-1 font-normal first:pl-3 ${className ?? ""}`}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center uppercase tracking-wider text-chrome-text/60 transition-colors hover:text-foreground"
      >
        {children}
      </button>
    </th>
  )
}
