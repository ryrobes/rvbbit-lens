"use client"

// ▦ Cube Catalog — a browsable table of every defined cube (the curated subject-area tables).
// The "directory" surface for the Cube Studio: search/sort across cubes and dispatch to the
// Inspector (open) or the Creator (new / edit). Mirrors metric-catalog-window.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Pencil, Plus, RefreshCw, Search } from "@/lib/icons"
import { listCubes, type CubeSummary } from "@/lib/rvbbit/cubes"
import { StatusNote, fmtTime } from "./cube-shared"

interface CubeCatalogWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenInspector: (name: string) => void
  onOpenCreator: (name?: string) => void
}

type SortField = "name" | "version" | "category" | "rows" | "refreshedAt"
type SortDir = "asc" | "desc"

export function CubeCatalogWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenInspector,
  onOpenCreator,
}: CubeCatalogWindowProps) {
  const [cubes, setCubes] = useState<CubeSummary[]>([])
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
      const { cubes: rows, error: err } = await listCubes(activeConnectionId)
      if (err) {
        setError(err)
        setCubes([])
      } else {
        setCubes(rows)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCubes([])
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

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
      setSortDir(field === "refreshedAt" || field === "rows" ? "desc" : "asc")
      return field
    })
  }, [])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return cubes
    return cubes.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        (c.description ?? "").toLowerCase().includes(term) ||
        (c.category ?? "").toLowerCase().includes(term) ||
        (c.grain ?? "").toLowerCase().includes(term),
    )
  }, [cubes, search])

  const sorted = useMemo(() => {
    const rows = filtered.slice()
    const dir = sortDir === "asc" ? 1 : -1
    rows.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case "version":
          cmp = a.version - b.version
          break
        case "category":
          cmp = (a.category ?? "").localeCompare(b.category ?? "")
          break
        case "rows":
          cmp = (a.rows ?? 0) - (b.rows ?? 0)
          break
        case "refreshedAt":
          cmp = (a.refreshedAt ?? "").localeCompare(b.refreshedAt ?? "")
          break
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

  const arrow = (field: SortField) => (sortField === field ? (sortDir === "asc" ? " ▲" : " ▼") : "")

  return (
    <div className="flex h-full min-h-0 flex-col text-foreground">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px]">
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--syntax-keyword)" }}>
          Cubes
        </span>
        <span className="tabular-nums text-chrome-text/60">{cubes.length}</span>

        <div className="relative ml-1 max-w-[280px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / description / category…"
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
          title="Create a new cube"
          className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[11px] text-main transition-colors hover:bg-main/25"
        >
          <Plus className="h-3 w-3" /> New cube
        </button>
      </div>

      {error ? <StatusNote state="error" message={error} className="border-b border-danger/30" /> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && cubes.length === 0 ? (
          <StatusNote state="loading" message="Loading cubes…" />
        ) : sorted.length === 0 && cubes.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <StatusNote state="empty" message="No cubes yet — create one or draft from a subject / pack." />
            <button
              type="button"
              onClick={() => onOpenCreator()}
              className="ml-3 inline-flex h-7 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[11px] text-main transition-colors hover:bg-main/25"
            >
              <Plus className="h-3 w-3" /> New cube
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <StatusNote state="empty" message={`No cubes match "${search}".`} />
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
                <Th onClick={() => toggleSort("category")} className="text-left">
                  Category{arrow("category")}
                </Th>
                <Th onClick={() => toggleSort("rows")} className="text-right">
                  Rows{arrow("rows")}
                </Th>
                <Th onClick={() => toggleSort("refreshedAt")} className="text-right">
                  Refreshed{arrow("refreshedAt")}
                </Th>
                <th className="px-2 py-1 text-left font-normal">Description</th>
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr
                  key={c.name}
                  onClick={() => onOpenInspector(c.name)}
                  title={`Open ${c.name} in the inspector`}
                  className="group cursor-pointer border-b border-chrome-border/20 hover:bg-foreground/[0.04]"
                >
                  <td className="px-3 py-1 font-mono text-foreground">{c.name}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-chrome-text/70">v{c.version}</td>
                  <td className="px-2 py-1 text-chrome-text/70">
                    {c.grain ?? <span className="text-chrome-text/30">—</span>}
                  </td>
                  <td className="px-2 py-1 text-chrome-text/70">
                    {c.category ?? <span className="text-chrome-text/30">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-chrome-text/60">
                    {c.rows == null ? <span className="text-chrome-text/30">—</span> : c.rows.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-chrome-text/60">
                    {c.refreshedAt ? fmtTime(Date.parse(c.refreshedAt)) : <span className="text-chrome-text/30">—</span>}
                  </td>
                  <td className="max-w-[280px] px-2 py-1 text-chrome-text/60">
                    <span className="block truncate" title={c.description ?? undefined}>
                      {c.description ?? <span className="text-chrome-text/30">—</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      title="Edit this cube"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpenCreator(c.name)
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
