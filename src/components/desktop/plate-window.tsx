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
import type { DesktopParamValue } from "@/lib/desktop/types"

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
  kit: string | null
  html: string
  islands: PlateIsland[]
  actions: Record<string, PlateActionMeta>
  /** Resolved param values; the keys tell us which rv-emit fields this
   *  plate consumes itself (param loop-back → re-render). */
  params?: Record<string, unknown>
  /** Params declared from_bus: true — subscribed to the desktop param bus. */
  busFields?: string[]
}

/** Fired after any plate action mutates data. Plates in the same kit
 *  refresh themselves; the shelf re-evaluates its gates. Same-browser
 *  only — cross-client reactivity would be LISTEN/NOTIFY, later. */
const PLATE_DATA_EVENT = "rvbbit:plate-data-changed"

interface PlateDataDetail {
  plateId: string
  kit: string | null
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

function ChartIsland({
  island,
  onEmit,
}: {
  island: PlateIsland
  onEmit?: (field: string, value: unknown) => void
}) {
  const emitField = island.props["rv-emit"]
  const spec = useMemo(() => {
    const x = island.props.x ?? island.columns[0]?.name ?? "x"
    const y = island.props.y ?? island.columns[1]?.name ?? "y"
    const mark = (island.props.mark ?? "bar") as "bar" | "line" | "area"
    // Selection-as-a-column, chart edition: when the query ships a `sel`
    // column and something is active, dim the rest.
    const hasActive = island.rows.some((r) => r.sel === "active")
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      width: "container" as const,
      height: 220,
      background: "transparent",
      data: { values: island.rows },
      mark: { type: mark, tooltip: true, ...(emitField ? { cursor: "pointer" } : {}) },
      encoding: {
        x: { field: x, type: "nominal" as const, sort: null, axis: { title: null } },
        y: { field: y, type: "quantitative" as const, axis: { title: null } },
        ...(hasActive
          ? { opacity: { condition: { test: "datum.sel === 'active'", value: 1 }, value: 0.35 } }
          : {}),
      },
      config: vegaConfigFromTheme(),
    }
  }, [island, emitField])
  const handleEmbed = useCallback(
    (res: { view: { addEventListener: (type: string, h: (e: unknown, item: unknown) => void) => void } }) => {
      if (!emitField || !onEmit) return
      res.view.addEventListener("click", (_event: unknown, item: unknown) => {
        const datum =
          item && typeof item === "object" && "datum" in item
            ? (item as { datum?: unknown }).datum
            : null
        if (!datum || typeof datum !== "object" || Array.isArray(datum)) return
        const value = (datum as Record<string, unknown>)[emitField]
        if (value !== undefined) onEmit(emitField, value)
      })
    },
    [emitField, onEmit],
  )
  return (
    <div className="plate-chart">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <VegaEmbed spec={spec as any} options={{ actions: false, renderer: "canvas" }} style={{ width: "100%" }} onEmbed={handleEmbed} />
    </div>
  )
}

export function PlateWindow({
  plateId,
  activeConnectionId,
  onOpenSql,
  onEmitParam,
  busParams,
}: {
  plateId: string
  activeConnectionId: string | null
  onOpenSql: (title: string, sql: string, run: boolean) => void
  onEmitParam?: (field: string, value: unknown) => void
  busParams?: DesktopParamValue[]
}) {
  const [plate, setPlate] = useState<RenderedPlate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [localParams, setLocalParams] = useState<Record<string, unknown>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const emitRef = useRef<((field: string, value: unknown) => void) | null>(null)

  // Bus subscription: values for this plate's from_bus params, from ANY
  // window's cascading eq emits. Serialized so refresh only re-fires when
  // the fields THIS plate declared actually change on the bus.
  const busFields = plate?.busFields
  const busKey = useMemo(() => {
    if (!busFields?.length || !busParams?.length) return "[]"
    const pairs: Array<[string, unknown]> = []
    for (const f of [...busFields].sort()) {
      const hit = busParams.find((p) => p.field === f && p.cascade !== false && p.operator === "eq")
      if (hit) pairs.push([f, hit.value])
    }
    return JSON.stringify(pairs)
  }, [busFields, busParams])

  const refresh = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    setError(null)
    try {
      const busValues = Object.fromEntries(JSON.parse(busKey) as Array<[string, unknown]>)
      const res = await fetch("/api/plate/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          plateId,
          params: { ...busValues, ...localParams },
        }),
      })
      const body = (await res.json()) as RenderedPlate
      if (!body.ok) throw new Error(body.error ?? "render failed")
      setPlate(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId, plateId, localParams, busKey])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  // Reactivity: when a sibling plate's action mutates data, refresh.
  // Kit is the sharing scope — plates in one kit are presumed to look at
  // the same tables (kit-less plates form their own bucket).
  useEffect(() => {
    const onData = (e: Event) => {
      const detail = (e as CustomEvent<PlateDataDetail>).detail
      if (!detail || detail.plateId === plateId) return
      if ((detail.kit ?? null) !== (plate?.kit ?? null)) return
      void refresh()
    }
    window.addEventListener(PLATE_DATA_EVENT, onData)
    return () => window.removeEventListener(PLATE_DATA_EVENT, onData)
  }, [plateId, plate?.kit, refresh])

  // The plate HTML is applied IMPERATIVELY, never via dangerouslySetInnerHTML.
  // React must not own these children: our island relocation mutates the
  // subtree, so React's innerHTML revalidation re-applied the whole body on
  // unrelated commits (e.g. the focus bump when you mousedown an unfocused
  // window) — replacing the mousedown target mid-click makes the browser
  // suppress the click entirely, which surfaced as "first click only
  // focuses, second click works". The applied string is tracked ON the
  // element so remounts (error → recovery) re-apply correctly.
  useLayoutEffect(() => {
    const el = containerRef.current as
      | (HTMLDivElement & { __rvHtml?: string; __rvChangeBound?: boolean })
      | null
    if (!el || !plate) return
    if (el.__rvHtml !== plate.html) {
      el.__rvHtml = plate.html
      el.innerHTML = plate.html
    }
    // Param controls (select / slider / datepicker / search / checkbox with
    // rv-emit) speak through the native change event — bound once here since
    // these children live outside React. Values are coerced by control type.
    if (!el.__rvChangeBound) {
      el.__rvChangeBound = true
      el.addEventListener("change", (ev) => {
        const t = ev.target as HTMLElement | null
        const field = t?.getAttribute?.("rv-emit")
        if (!t || !field) return
        let value: unknown
        if (t instanceof HTMLSelectElement) value = t.value
        else if (t instanceof HTMLInputElement) {
          if (t.type === "checkbox") value = t.checked ? (t.getAttribute("rv-value") ?? "true") : ""
          else if (t.type === "range" || t.type === "number") value = t.value === "" ? "" : Number(t.value)
          else value = t.value
        } else return
        emitRef.current?.(field, value)
      })
    }
    // Islands render as React-owned nodes in a staging area, then relocate
    // into their placeholder hosts before paint. (Portals targeting nodes
    // inside an innerHTML subtree proved unreliable; physically moving the
    // React-owned element is robust — React keeps updating the node
    // wherever it lives, and re-renders re-adopt it idempotently.)
    for (const island of plate.islands) {
      const host = el.querySelector(`[data-rv-island="${island.id}"]`)
      const stage = stageRefs.current[island.id]
      if (host && stage && stage.parentElement !== host) host.appendChild(stage)
    }
  })

  // The one emit path — rv-emit buttons and chart-mark clicks both land
  // here. from_bus fields ride the bus round-trip (its eq toggle gives
  // click-again-to-unselect for free); local declared params get the same
  // toggle semantics here before re-render.
  const handleEmit = useCallback(
    (field: string, value: unknown) => {
      const fromBus = plate?.busFields?.includes(field)
      if (!fromBus && plate?.params && Object.prototype.hasOwnProperty.call(plate.params, field)) {
        setLocalParams((prev) => {
          if (field in prev && String(prev[field]) === String(value)) {
            const next = { ...prev }
            delete next[field]
            return next
          }
          return { ...prev, [field]: value }
        })
      }
      onEmitParam?.(field, value)
    },
    [plate, onEmitParam],
  )

  useEffect(() => {
    emitRef.current = handleEmit
  }, [handleEmit])

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
      if (emit) {
        // Form controls emit on change, not click — a click on a select must
        // open its dropdown, not fire the param.
        const tag = target.tagName
        if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return
        e.preventDefault()
        handleEmit(emit, target.getAttribute("rv-value") ?? "")
      }
    },
    [onOpenSql, handleEmit, plate],
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
      window.dispatchEvent(
        new CustomEvent<PlateDataDetail>(PLATE_DATA_EVENT, {
          detail: { plateId, kit: plate.kit ?? null },
        }),
      )
      void refresh()
    },
    [activeConnectionId, plate, plateId, refresh],
  )

  if (!activeConnectionId) {
    return <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">connect to a database first</div>
  }

  return (
    <div className="flex h-full flex-col">
      {/* Title + icon live in the window title bar right above — the strip
          carries only what the bar doesn't: description, notes, re-render. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[12px]">
        <span className="truncate text-chrome-text/50">{plate?.description ?? plateId}</span>
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
            {/* Children applied imperatively in the layout effect above —
                server-side sanitized (allowlist, double pass, values escaped). */}
            <div ref={containerRef} className="plate-body" onClick={onClick} onSubmit={onSubmit} />
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
                  <ChartIsland island={island} onEmit={handleEmit} />
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
    Array<{
      plate_id: string
      kit: string | null
      module: string | null
      title: string
      description: string | null
      gated: boolean
      violations: number
      gate_detail: string
    }>
  >([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

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
  }, [activeConnectionId, reloadTick])

  // Gates flip when plate actions change the data — re-list on the same
  // event the plate windows use to refresh themselves.
  useEffect(() => {
    const onData = () => setReloadTick((t) => t + 1)
    window.addEventListener(PLATE_DATA_EVENT, onData)
    return () => window.removeEventListener(PLATE_DATA_EVENT, onData)
  }, [])

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
                disabled={p.gated}
                onClick={() => onOpenPlate(p.plate_id, p.title)}
                title={
                  p.gated
                    ? `module “${p.module}” gated: ${p.violations} contract violation(s)` +
                      (p.gate_detail ? ` — ${p.gate_detail}` : "") +
                      " — open the kit's switchboard"
                    : undefined
                }
                className={cn(
                  "flex items-baseline gap-2 rounded-md border border-chrome-border/50 bg-chrome-bg/25 px-2.5 py-1.5 text-left",
                  p.gated
                    ? "cursor-not-allowed opacity-45"
                    : "hover:border-main/40 hover:bg-chrome-bg/40",
                )}
              >
                <span className="font-medium text-foreground">{p.title}</span>
                <span className="font-mono text-[10px] text-chrome-text/40">{p.plate_id}</span>
                {p.kit ? (
                  <span className="rounded-full border border-main/30 px-1.5 text-[9px] uppercase tracking-wide text-main/70">
                    {p.kit}
                  </span>
                ) : null}
                {p.gated ? (
                  <span className="rounded-full border border-warning/40 px-1.5 text-[9px] uppercase tracking-wide text-warning">
                    gated · {p.violations}
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
