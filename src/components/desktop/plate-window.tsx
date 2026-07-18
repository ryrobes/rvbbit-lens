"use client"

/**
 * Plates — the second app species (rvbbit-sql/docs/KIT_PLATES_PLAN.md).
 * Server renders sanitized HTML from rvbbit.plates rows; this window mounts
 * it, delegates the vocabulary's events (rv-action forms, rv-open-sql,
 * rv-emit), and hydrates islands into REAL lens components via portals.
 * Plates trigger, never think: all logic already happened in SQL.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { VegaEmbed } from "react-vega"
import { vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import { Layers, Loader2, RefreshCw } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { ResultGrid } from "./result-grid"
import type { QueryResultColumn } from "@/lib/db/types"

interface PlateIsland {
  id: string
  kind: "grid" | "chart" | "metric"
  query: string
  props: Record<string, string>
  columns: QueryResultColumn[]
  rows: Array<Record<string, unknown>>
}

interface PlateActionMeta {
  confirm: boolean
  description: string
  args: Array<{ name: string; type: string; required: boolean }>
}

interface RenderedPlate {
  ok: boolean
  error?: string
  plateId: string
  title: string
  description: string | null
  html: string
  islands: PlateIsland[]
  actions: Record<string, PlateActionMeta>
}

function MetricIsland({ island }: { island: PlateIsland }) {
  const row = island.rows[0] ?? {}
  const valueCol = island.props.value ?? island.columns[0]?.name ?? ""
  const labelCol = island.props.label
  const label = labelCol ? String(row[labelCol] ?? "") : island.props.title ?? valueCol
  const raw = row[valueCol]
  const value =
    typeof raw === "number" ? raw.toLocaleString() : String(raw ?? "—")
  return (
    <div className="plate-metric">
      <div className="plate-metric-value">
        {value}
        {island.props.unit ? <span>{island.props.unit}</span> : null}
      </div>
      <div className="plate-metric-label">{label}</div>
    </div>
  )
}

function ChartIsland({ island }: { island: PlateIsland }) {
  const spec = useMemo(() => {
    const x = island.props.x ?? island.columns[0]?.name ?? "x"
    const y = island.props.y ?? island.columns[1]?.name ?? "y"
    const mark = (island.props.mark ?? "bar") as "bar" | "line" | "area"
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      width: "container" as const,
      height: 220,
      background: "transparent",
      data: { values: island.rows },
      mark: { type: mark, tooltip: true },
      encoding: {
        x: { field: x, type: "nominal" as const, sort: null, axis: { title: null } },
        y: { field: y, type: "quantitative" as const, axis: { title: null } },
      },
      config: vegaConfigFromTheme(),
    }
  }, [island])
  return (
    <div className="plate-chart">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <VegaEmbed spec={spec as any} options={{ actions: false, renderer: "canvas" }} style={{ width: "100%" }} />
    </div>
  )
}

export function PlateWindow({
  plateId,
  activeConnectionId,
  onOpenSql,
  onEmitParam,
}: {
  plateId: string
  activeConnectionId: string | null
  onOpenSql: (title: string, sql: string, run: boolean) => void
  onEmitParam?: (field: string, value: unknown) => void
}) {
  const [plate, setPlate] = useState<RenderedPlate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/plate/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, plateId }),
      })
      const body = (await res.json()) as RenderedPlate
      if (!body.ok) throw new Error(body.error ?? "render failed")
      setPlate(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId, plateId])

  useEffect(() => void refresh(), [refresh])

  // Islands render as React-owned nodes in a staging area, then relocate
  // into their placeholder hosts before paint. (Portals targeting nodes
  // inside a dangerouslySetInnerHTML subtree proved unreliable; physically
  // moving the React-owned element is robust — React keeps updating the
  // node wherever it lives, and re-renders re-adopt it idempotently.)
  useLayoutEffect(() => {
    if (!plate || !containerRef.current) return
    for (const island of plate.islands) {
      const host = containerRef.current.querySelector(`[data-rv-island="${island.id}"]`)
      const stage = stageRefs.current[island.id]
      if (host && stage && stage.parentElement !== host) host.appendChild(stage)
    }
  })

  // Event delegation for the vocabulary.
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[rv-open-sql],[rv-emit]")
      if (!target) return
      const sql = target.getAttribute("rv-open-sql")
      if (sql) {
        e.preventDefault()
        onOpenSql(target.getAttribute("rv-open-sql-title") ?? `${plate?.title ?? "plate"} — SQL`, sql, false)
        return
      }
      const emit = target.getAttribute("rv-emit")
      if (emit && onEmitParam) {
        e.preventDefault()
        onEmitParam(emit, target.getAttribute("rv-value") ?? "")
      }
    },
    [onOpenSql, onEmitParam, plate?.title],
  )

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      const form = (e.target as HTMLElement).closest("form[rv-action]") as HTMLFormElement | null
      if (!form || !activeConnectionId || !plate) return
      e.preventDefault()
      const actionName = form.getAttribute("rv-action") ?? ""
      const meta = plate.actions[actionName]
      if (!meta) {
        setActionNote(`action ${actionName} is not declared`)
        return
      }
      const args: Record<string, unknown> = {}
      new FormData(form).forEach((v, k) => {
        args[k] = typeof v === "string" ? v : ""
      })
      if (meta.confirm && !window.confirm(meta.description || `Run ${actionName}?`)) return
      setActionNote(null)
      const res = await fetch("/api/plate/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, plateId, action: actionName, args }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) {
        setActionNote(body.error ?? "action failed")
        return
      }
      form.reset()
      void refresh()
    },
    [activeConnectionId, plate, plateId, refresh],
  )

  if (!activeConnectionId) {
    return <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">connect to a database first</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[12px]">
        <Layers className="h-3.5 w-3.5 text-main" />
        <span className="font-medium text-foreground">{plate?.title ?? plateId}</span>
        {plate?.description ? (
          <span className="truncate text-chrome-text/50">{plate.description}</span>
        ) : null}
        <div className="flex-1" />
        {actionNote ? <span className="truncate text-[11px] text-warning">{actionNote}</span> : null}
        <button
          type="button"
          onClick={() => void refresh()}
          title="Re-render"
          className="text-chrome-text/50 hover:text-foreground"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-[12px] text-destructive">{error}</div>
        ) : plate ? (
          <>
            <div
              ref={containerRef}
              className="plate-body"
              onClick={onClick}
              onSubmit={onSubmit}
              // Server-side sanitized (allowlist, double pass, values escaped).
              dangerouslySetInnerHTML={{ __html: plate.html }}
            />
            {plate.islands.map((island) => (
              <div
                key={island.id}
                ref={(el) => {
                  stageRefs.current[island.id] = el
                }}
                style={{ display: "contents" }}
              >
                {island.kind === "grid" ? (
                  <div className="plate-grid-island">
                    <ResultGrid columns={island.columns} rows={island.rows} />
                  </div>
                ) : island.kind === "chart" ? (
                  <ChartIsland island={island} />
                ) : (
                  <MetricIsland island={island} />
                )}
              </div>
            ))}
          </>
        ) : (
          <div className="grid h-full place-items-center">
            <Loader2 className="h-5 w-5 animate-spin text-chrome-text/40" />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Plates browser (the shelf) ──────────────────────────────────────────

export function PlatesWindow({
  activeConnectionId,
  onOpenPlate,
}: {
  activeConnectionId: string | null
  onOpenPlate: (plateId: string, title: string) => void
}) {
  const [plates, setPlates] = useState<
    Array<{ plate_id: string; kit: string | null; title: string; description: string | null }>
  >([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!activeConnectionId) return
      try {
        const res = await fetch("/api/plate/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: activeConnectionId }),
        })
        const body = (await res.json()) as { ok: boolean; plates?: typeof plates; error?: string }
        if (cancelled) return
        if (!body.ok) setError(body.error ?? "failed to list plates")
        else setPlates(body.plates ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Layers className="h-3.5 w-3.5 text-main" />
        <span className="font-medium text-foreground">Plates</span>
        <span className="text-chrome-text/45">surfaces shipped as rows — they travel with the database</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="p-4 text-chrome-text/50">loading…</div>
        ) : error ? (
          <div className="p-4 text-destructive">{error}</div>
        ) : plates.length === 0 ? (
          <div className="p-4 leading-relaxed text-chrome-text/55">
            No plates installed. Kits ship them; so can you:{" "}
            <code className="text-main/80">SELECT rvbbit.upsert_plate(…)</code>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {plates.map((p) => (
              <button
                key={p.plate_id}
                type="button"
                onClick={() => onOpenPlate(p.plate_id, p.title)}
                className={cn(
                  "flex items-baseline gap-2 rounded-md border border-chrome-border/50 bg-chrome-bg/25 px-2.5 py-1.5 text-left",
                  "hover:border-main/40 hover:bg-chrome-bg/40",
                )}
              >
                <span className="font-medium text-foreground">{p.title}</span>
                <span className="font-mono text-[10px] text-chrome-text/40">{p.plate_id}</span>
                {p.kit ? (
                  <span className="rounded-full border border-main/30 px-1.5 text-[9px] uppercase tracking-wide text-main/70">
                    {p.kit}
                  </span>
                ) : null}
                <span className="ml-auto truncate text-[11px] text-chrome-text/50">{p.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
