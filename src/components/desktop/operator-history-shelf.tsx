"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, Clock, RefreshCw, Search, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount, fmtMs } from "./instruments"
import {
  fetchReceiptCount,
  fetchReceiptsPage,
  type OperatorReceipt,
  type ReceiptPageOpts,
  type ReceiptStatusFilter,
} from "@/lib/rvbbit/operators"

const COLLAPSE_KEY = "rvbbit-lens:op-history-collapsed"
const PAGE_SIZE = 50

const WINDOWS: { label: string; hours: number | null }[] = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "all", hours: null },
]

/**
 * Collapsible "Executions" shelf at the foot of the operator builder — a
 * filterable, searchable, keyset-paginated grid of every past run (cost,
 * time, status, truncated I/O). Selecting a row hands the full receipt up
 * so the graph can replay it read-only.
 */
export function OperatorHistoryShelf({
  connectionId,
  operatorName,
  enabled,
  activeReceiptId,
  refreshSignal = 0,
  onSelect,
}: {
  connectionId: string | null
  operatorName: string
  enabled: boolean
  activeReceiptId: string | null
  /** Bump to force a reload (e.g. after a fresh run). */
  refreshSignal?: number
  onSelect: (r: OperatorReceipt) => void
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(COLLAPSE_KEY) === "1"
  })
  const [status, setStatus] = useState<ReceiptStatusFilter>("all")
  const [windowHours, setWindowHours] = useState<number | null>(24)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")

  const [rows, setRows] = useState<OperatorReceipt[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      if (typeof window !== "undefined") {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0")
      }
      return next
    })
  }, [])

  // debounce the search box
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput), 250)
    return () => window.clearTimeout(id)
  }, [searchInput])

  const filterOpts = useMemo<ReceiptPageOpts>(
    () => ({ status, windowHours, search, limit: PAGE_SIZE }),
    [status, windowHours, search],
  )

  // (Re)load page 1 + the total whenever the operator or a filter changes.
  // Skipped while collapsed so a parked shelf does no work.
  const reload = useCallback(async () => {
    if (!connectionId || !operatorName || !enabled) {
      setRows([])
      setCount(0)
      setCursor(null)
      return
    }
    setLoading(true)
    setError(null)
    const [page, total] = await Promise.all([
      fetchReceiptsPage(connectionId, operatorName, filterOpts),
      fetchReceiptCount(connectionId, operatorName, filterOpts),
    ])
    setLoading(false)
    if (page.error) {
      setError(page.error)
      return
    }
    setRows(page.receipts)
    setCursor(page.nextCursor)
    setCount(total)
  }, [connectionId, operatorName, enabled, filterOpts])

  useEffect(() => {
    if (collapsed) return
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
    // refreshSignal is an intentional reload trigger (e.g. after a run).
  }, [collapsed, reload, refreshSignal])

  const loadMore = useCallback(async () => {
    if (!connectionId || !operatorName || !cursor || loading) return
    setLoading(true)
    const page = await fetchReceiptsPage(connectionId, operatorName, {
      ...filterOpts,
      before: cursor,
    })
    setLoading(false)
    if (page.error) {
      setError(page.error)
      return
    }
    setRows((prev) => [...prev, ...page.receipts])
    setCursor(page.nextCursor)
  }, [connectionId, operatorName, cursor, loading, filterOpts])

  const headerCount = enabled
    ? `${fmtCount(count)} run${count === 1 ? "" : "s"}`
    : "save to record runs"

  return (
    <div className="flex shrink-0 flex-col border-t border-chrome-border bg-chrome-bg/40">
      {/* header bar — always visible */}
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-chrome-text/80 hover:text-foreground"
          title={collapsed ? "Expand executions" : "Collapse executions"}
        >
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", collapsed ? "-rotate-90" : "")}
          />
          <Clock className="h-3.5 w-3.5 text-brand-operators" />
          Executions
          <span className="font-mono text-[10px] tabular-nums text-chrome-text/45">
            {headerCount}
          </span>
        </button>

        {!collapsed && enabled ? (
          <div className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-chrome-text/45" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="search inputs / output…"
                className="h-6 w-44 rounded border border-chrome-border bg-secondary-background pl-6 pr-2 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="flex rounded border border-chrome-border">
              {(["all", "ok", "error"] as ReceiptStatusFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={cn(
                    "px-1.5 py-0.5 text-[10px] capitalize",
                    status === s
                      ? "bg-main/20 text-foreground"
                      : "text-chrome-text/60 hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <select
              value={windowHours ?? ""}
              onChange={(e) =>
                setWindowHours(e.target.value === "" ? null : Number(e.target.value))
              }
              title="Time window"
              className="h-6 rounded border border-chrome-border bg-secondary-background px-1 text-[10px] text-foreground outline-none"
            >
              {WINDOWS.map((w) => (
                <option key={w.label} value={w.hours ?? ""}>
                  {w.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void reload()}
              title="Reload"
              className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RefreshCw className={cn("h-3 w-3", loading ? "animate-spin" : "")} />
            </button>
          </div>
        ) : null}
      </div>

      {/* grid body */}
      {!collapsed ? (
        <div className="h-56 overflow-auto border-t border-chrome-border/50">
          {!enabled ? (
            <div className="grid h-full place-items-center text-[11px] text-chrome-text/50">
              Save the operator to start recording executions.
            </div>
          ) : error ? (
            <div className="flex items-start gap-1.5 px-3 py-2 text-[11px] text-danger">
              <X className="mt-px h-3 w-3 shrink-0" />
              {error}
            </div>
          ) : rows.length === 0 ? (
            <div className="grid h-full place-items-center text-[11px] text-chrome-text/50">
              {loading ? "loading…" : "no runs match these filters"}
            </div>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-10 bg-chrome-bg/95 text-[9px] uppercase tracking-wider text-chrome-text/45 backdrop-blur">
                <tr className="text-left">
                  <Th className="w-[2px] pl-2" />
                  <Th>when</Th>
                  <Th className="text-right">latency</Th>
                  <Th className="text-right">cost</Th>
                  <Th className="text-right">tokens</Th>
                  <Th>inputs</Th>
                  <Th>output</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isError = !!r.error
                  const active = r.receipt_id === activeReceiptId
                  return (
                    <tr
                      key={r.receipt_id}
                      onClick={() => onSelect(r)}
                      className={cn(
                        "cursor-pointer border-t border-chrome-border/30 transition-colors",
                        active
                          ? "bg-main/15"
                          : "hover:bg-foreground/[0.04]",
                      )}
                    >
                      <td className="pl-2">
                        <span
                          className={cn(
                            "block h-1.5 w-1.5 rounded-full",
                            isError ? "bg-danger" : "bg-success",
                          )}
                        />
                      </td>
                      <td
                        className="whitespace-nowrap py-1 pr-2 text-chrome-text/70"
                        title={r.invocation_at}
                      >
                        {fmtAgo(new Date(r.invocation_at).getTime())}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/80">
                        {fmtMs(r.latency_ms)}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/70">
                        {r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : "—"}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right font-mono tabular-nums text-chrome-text/60">
                        {r.n_tokens_in}
                        <span className="text-chrome-text/35">→</span>
                        {r.n_tokens_out}
                      </td>
                      <td className="max-w-[220px] truncate py-1 pr-2 font-mono text-[10px] text-chrome-text/60">
                        {summarizeInputs(r.inputs)}
                      </td>
                      <td
                        className={cn(
                          "max-w-[280px] truncate py-1 pr-2 text-[10px]",
                          isError ? "text-danger/80" : "text-chrome-text/75",
                        )}
                      >
                        {isError ? r.error : r.output ?? "—"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {enabled && cursor ? (
            <div className="flex justify-center border-t border-chrome-border/30 py-1.5">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loading}
                className="rounded border border-chrome-border px-2 py-0.5 text-[10px] text-chrome-text/75 hover:text-foreground disabled:opacity-50"
              >
                {loading ? "loading…" : `load more (${fmtCount(rows.length)} of ${fmtCount(count)})`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("py-1 pr-2 font-medium", className)}>{children}</th>
}

function summarizeInputs(inputs: Record<string, unknown> | null): string {
  if (!inputs) return "—"
  const parts = Object.entries(inputs).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v)
    return `${k}=${val}`
  })
  return parts.join("  ") || "—"
}
