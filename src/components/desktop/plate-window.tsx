"use client"

/**
 * Plates — the second app species (rvbbit-sql/docs/KIT_PLATES_PLAN.md).
 * Server renders sanitized HTML from rvbbit.plates rows; this window mounts
 * it, delegates the vocabulary's events (rv-action forms, rv-open-sql,
 * rv-emit), and hydrates islands into REAL lens components via portals.
 * Plates trigger, never think: all logic already happened in SQL.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { VegaEmbed } from "react-vega"
import { vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import { Layers, Loader2, RefreshCw } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { ResultGrid } from "./result-grid"
import type { QueryResultColumn } from "@/lib/db/types"
import type { DesktopParamValue } from "@/lib/desktop/types"

interface PlateIsland {
  id: string
  kind: "grid" | "chart" | "metric" | "board"
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
  /** Extra kits whose data events also refresh this plate. */
  listens?: string[]
}

/** Fired after any plate action mutates data. Plates in the same kit
 *  refresh themselves; the shelf re-evaluates its gates. Same-browser
 *  only — cross-client reactivity would be LISTEN/NOTIFY, later. */
const PLATE_DATA_EVENT = "rvbbit:plate-data-changed"

interface PlateDataDetail {
  plateId: string
  kit: string | null
}

/** Kanban board island: one column per distinct group-by value (SQL
 *  ORDER BY = column order; a row with a NULL/empty id is an empty-column
 *  placeholder from a LEFT JOIN). Dragging a card to another column fires
 *  the named plate action with args {id, to} — the ONLY write path, same
 *  wall as forms. No action attr = read-only board. */
function BoardIsland({
  island,
  runAction,
  onEmit,
  onOpenPlate,
}: {
  island: PlateIsland
  runAction: (action: string, args: Record<string, unknown>) => Promise<boolean>
  onEmit?: (field: string, value: unknown, opts?: { toggle?: boolean }) => void
  onOpenPlate?: (plateId: string, title?: string) => void
}) {
  const p = island.props
  const groupBy = p["group-by"] ?? island.columns[0]?.name ?? ""
  const labelCol = p["group-label"] ?? groupBy
  const idCol = p.id ?? "id"
  const action = p.action ?? ""
  // Double-click on a card: rv-emit publishes the card's id (an edit plate
  // subscribes via a from_bus param), rv-open="plate:<id>" then opens it.
  const emitField = p["rv-emit"] ?? ""
  const openTarget = p["rv-open"] ?? ""
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const groups: Array<{ key: string; label: string; cards: Array<Record<string, unknown>> }> = []
  const byKey = new Map<string, (typeof groups)[number]>()
  for (const row of island.rows) {
    const key = row[groupBy] == null ? "" : String(row[groupBy])
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: row[labelCol] == null ? key : String(row[labelCol]), cards: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    if (row[idCol] != null && String(row[idCol]) !== "") g.cards.push(row)
  }

  const cell = (row: Record<string, unknown>, col?: string) =>
    col && row[col] != null ? String(row[col]) : ""

  return (
    <div className="plate-board" data-busy={busy || undefined}>
      {groups.map((g) => (
        <div
          key={g.key}
          className={`plate-board-col${dropKey === g.key ? " drop" : ""}`}
          onDragOver={(e) => {
            if (!action) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setDropKey(g.key)
          }}
          onDragLeave={() => setDropKey((cur) => (cur === g.key ? null : cur))}
          onDrop={(e) => {
            e.preventDefault()
            setDropKey(null)
            if (!action || busy) return
            try {
              const { id, from } = JSON.parse(e.dataTransfer.getData("text/plain")) as { id: string; from: string }
              if (!id || from === g.key) return
              setBusy(true)
              void runAction(action, { id, to: g.key }).finally(() => setBusy(false))
            } catch {
              // foreign drag payload — ignore
            }
          }}
        >
          <h4>
            {g.label} <span>{g.cards.length}</span>
          </h4>
          {g.cards.map((row) => {
            const id = String(row[idCol])
            return (
              <div
                key={id}
                className={`plate-card plate-board-chip ${cell(row, p.tone)}`}
                draggable={!!action && !busy}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", JSON.stringify({ id, from: g.key }))
                  e.dataTransfer.effectAllowed = "move"
                }}
                onDoubleClick={() => {
                  if (emitField && onEmit) onEmit(emitField, id)
                  if (openTarget.startsWith("plate:") && onOpenPlate) onOpenPlate(openTarget.slice(6))
                }}
              >
                {p.title ? <div className="plate-card-title">{cell(row, p.title)}</div> : null}
                {p.value ? <div className="plate-card-value">{cell(row, p.value)}</div> : null}
                {p.note ? <div className="plate-card-note">{cell(row, p.note)}</div> : null}
              </div>
            )
          })}
          {g.cards.length === 0 ? <div className="plate-empty">—</div> : null}
        </div>
      ))}
    </div>
  )
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
  onEmit?: (field: string, value: unknown, opts?: { toggle?: boolean }) => void
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
        if (value !== undefined) onEmit(emitField, value, { toggle: true })
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
  onOpenPlate,
  onOpenApp,
  onEmitParam,
  busParams,
}: {
  plateId: string
  activeConnectionId: string | null
  onOpenSql: (title: string, sql: string, run: boolean) => void
  onOpenPlate?: (plateId: string, title?: string) => void
  /** rv-open="app:<id>?k=v" — native desktop apps (e.g. the Fitting Room). */
  onOpenApp?: (appId: string, params: Record<string, string>) => void
  onEmitParam?: (field: string, value: unknown) => void
  busParams?: DesktopParamValue[]
}) {
  const [plate, setPlate] = useState<RenderedPlate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionNote, setActionNote] = useState<string | null>(null)
  const [localParams, setLocalParams] = useState<Record<string, unknown>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [islandHosts, setIslandHosts] = useState<Record<string, HTMLElement>>({})
  const emitRef = useRef<((field: string, value: unknown, opts?: { toggle?: boolean }) => void) | null>(null)

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
  // the same tables (kit-less plates form their own bucket). A plate may
  // additionally LISTEN to other kits (foundation-kit overlays).
  useEffect(() => {
    const onData = (e: Event) => {
      const detail = (e as CustomEvent<PlateDataDetail>).detail
      if (!detail) return
      if (detail.plateId === plateId) {
        // An event naming THIS plate always refreshes it when broadcast by
        // someone else (assistant upserts, capture pre-render). Our own
        // post-action broadcast is the one case to skip — the action path
        // already called refresh().
        if (!(e as CustomEvent<PlateDataDetail & { self?: boolean }>).detail.self) void refresh()
        return
      }
      const sameKit = (detail.kit ?? null) === (plate?.kit ?? null)
      const listening = detail.kit != null && (plate?.listens ?? []).includes(detail.kit)
      if (!sameKit && !listening) return
      void refresh()
    }
    window.addEventListener(PLATE_DATA_EVENT, onData)
    return () => window.removeEventListener(PLATE_DATA_EVENT, onData)
  }, [plateId, plate?.kit, plate?.listens, refresh])

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
      // Preserve the active control across the swap (live search would
      // otherwise lose focus + in-flight keystrokes on every refetch).
      // TEXT-ENTRY controls only: restoring .value onto a radio/checkbox
      // rewrites its IDENTITY (querySelector finds the first radio of the
      // field — the "All" one — and stamps the previous selection's value
      // onto it, so clicking All then emits the old value forever).
      const PRESERVE_TYPES = new Set(["search", "text", "number", "date", "time", "datetime-local", "range"])
      const active = document.activeElement as HTMLInputElement | null
      const activeField =
        active &&
        el.contains(active) &&
        active instanceof HTMLInputElement &&
        PRESERVE_TYPES.has(active.type) &&
        active.getAttribute("rv-emit")
          ? active.getAttribute("rv-emit")
          : null
      const activeValue = activeField ? active!.value : null
      const caret = activeField && active instanceof HTMLInputElement && (active.type === "search" || active.type === "text")
        ? active.selectionStart
        : null
      el.__rvHtml = plate.html
      el.innerHTML = plate.html
      if (activeField) {
        const again = el.querySelector<HTMLInputElement>(`input[rv-emit="${CSS.escape(activeField)}"]`)
        if (again) {
          if (activeValue != null) again.value = activeValue
          again.focus()
          if (caret != null) { try { again.setSelectionRange(caret, caret) } catch { /* type doesn't support selection */ } }
        }
      }
    }
    // Render-pass-complete signal (fires whether or not the DOM changed) —
    // the visual self-check capture awaits this so it screenshots the
    // CURRENT template, and a no-change render resolves instantly instead
    // of timing out.
    window.dispatchEvent(
      new CustomEvent("rvbbit:plate-rendered", { detail: { plateId } }),
    )
    // Param controls (select / slider / datepicker / search / checkbox with
    // rv-emit) speak through the native change event — bound once here since
    // these children live outside React. Values are coerced by control type.
    if (!el.__rvChangeBound) {
      el.__rvChangeBound = true
      // rv-live inputs emit while typing, debounced — the value is read at
      // fire time from the node the events landed on (still correct even if
      // a refetch replaced it in the DOM meanwhile).
      el.addEventListener("input", (ev) => {
        const t = ev.target as (HTMLInputElement & { __rvTimer?: number }) | null
        if (!t || !(t instanceof HTMLInputElement) || t.getAttribute("rv-live") == null) return
        if (!t.isConnected) return
        const field = t.getAttribute("rv-emit")
        if (!field) return
        window.clearTimeout(t.__rvTimer)
        t.__rvTimer = window.setTimeout(() => emitRef.current?.(field, t.value), 400)
      })
      el.addEventListener("change", (ev) => {
        const t = ev.target as HTMLElement | null
        const field = t?.getAttribute?.("rv-emit")
        if (!t || !field) return
        // A refetch can swap the DOM under a focused control; the detached
        // node then fires a stray change on blur — ignore it.
        if (!t.isConnected) return
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
    // Islands mount via PORTALS into the placeholder hosts (measure-then-
    // render: hosts exist only after innerHTML is applied, so they're
    // collected here and the portals render on the follow-up pass). The
    // earlier relocation pattern moved React-owned nodes into the hosts,
    // but React unmounts a node via its TRACKED parent — when tabs removed
    // an island, removeChild threw on the foreign parent and took the whole
    // tree down. Portals unmount cleanly from their own containers, and
    // since the HTML is imperatively owned, nothing rewrites the hosts
    // behind React's back (the failure that ruled portals out originally).
    const next: Record<string, HTMLElement> = {}
    for (const island of plate.islands) {
      const host = el.querySelector(`[data-rv-island="${island.id}"]`)
      if (host) next[island.id] = host as HTMLElement
    }
    setIslandHosts((prev) => {
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      const same = prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])
      return same ? prev : next
    })
  }, [plate])

  // The one emit path — rv-emit buttons and chart-mark clicks both land
  // here. from_bus fields ride the bus round-trip (its eq toggle gives
  // click-again-to-unselect for free); local declared params get the same
  // toggle semantics here before re-render.
  const handleEmit = useCallback(
    (field: string, value: unknown, opts?: { toggle?: boolean }) => {
      const fromBus = plate?.busFields?.includes(field)
      if (!fromBus && plate?.params && Object.prototype.hasOwnProperty.call(plate.params, field)) {
        setLocalParams((prev) => {
          // Click-again-to-unselect is a CLICK gesture (chips, chart marks).
          // Change-driven controls just set — a re-emitted identical value
          // (e.g. the spurious change fired when a refetch swaps out the
          // focused input) must not undo the filter.
          if (opts?.toggle && field in prev && String(prev[field]) === String(value)) {
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
      const target = (e.target as HTMLElement).closest<HTMLElement>("[rv-open-sql],[rv-open],[rv-emit]")
      if (!target) return
      const sql = target.getAttribute("rv-open-sql")
      if (sql) {
        e.preventDefault()
        onOpenSql(target.getAttribute("rv-open-sql-title") ?? `${plate?.title ?? "plate"} — SQL`, sql, false)
        return
      }
      const open = target.getAttribute("rv-open")
      if (open) {
        e.preventDefault()
        // Desktop verbs. plate: opens a sibling plate; app: opens a native
        // desktop app with query-ish params (app:fitting?kit=field-kit).
        if (open.startsWith("plate:") && onOpenPlate) {
          onOpenPlate(open.slice(6), target.getAttribute("rv-open-title") ?? undefined)
        } else if (open.startsWith("app:") && onOpenApp) {
          const rest = open.slice(4)
          const q = rest.indexOf("?")
          const appId = q >= 0 ? rest.slice(0, q) : rest
          const params: Record<string, string> = {}
          if (q >= 0) {
            for (const pair of rest.slice(q + 1).split("&")) {
              const eq = pair.indexOf("=")
              if (eq > 0) params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
            }
          }
          onOpenApp(appId, params)
        }
        return
      }
      const emit = target.getAttribute("rv-emit")
      if (emit) {
        // Form controls emit on change, not click — a click on a select must
        // open its dropdown, not fire the param.
        const tag = target.tagName
        if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return
        e.preventDefault()
        const confirmText = target.getAttribute("rv-confirm")
        if (confirmText && !window.confirm(confirmText)) return
        handleEmit(emit, target.getAttribute("rv-value") ?? "", { toggle: true })
      }
    },
    [onOpenSql, onOpenPlate, onOpenApp, handleEmit, plate],
  )

  /** Shared write path: forms and interactive islands both land here.
   *  Returns true on success so callers can reset local state. */
  const runAction = useCallback(
    async (actionName: string, args: Record<string, unknown>): Promise<boolean> => {
      if (!activeConnectionId || !plate) return false
      const meta = plate.actions[actionName]
      if (!meta) {
        setActionNote(`action ${actionName} is not declared`)
        return false
      }
      if (meta.confirm && !window.confirm(meta.description || `Run ${actionName}?`)) return false
      setActionNote(null)
      const res = await fetch("/api/plate/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, plateId, action: actionName, args }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) {
        setActionNote(body.error ?? "action failed")
        return false
      }
      window.dispatchEvent(
        new CustomEvent<PlateDataDetail & { self: boolean }>(PLATE_DATA_EVENT, {
          detail: { plateId, kit: plate.kit ?? null, self: true },
        }),
      )
      void refresh()
      return true
    },
    [activeConnectionId, plate, plateId, refresh],
  )

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      const form = (e.target as HTMLElement).closest("form[rv-action]") as HTMLFormElement | null
      if (!form || !activeConnectionId || !plate) return
      e.preventDefault()
      const actionName = form.getAttribute("rv-action") ?? ""
      const args: Record<string, unknown> = {}
      // Include the clicked submit button so per-row buttons can carry an
      // arg (name/value on the submitter is excluded from plain FormData).
      const submitter = (e.nativeEvent as SubmitEvent).submitter
      const fd = submitter && submitter.getAttribute("name") ? new FormData(form, submitter) : new FormData(form)
      fd.forEach((v, k) => {
        args[k] = typeof v === "string" ? v : ""
      })
      if (await runAction(actionName, args)) form.reset()
    },
    [activeConnectionId, plate, runAction],
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
            {plate.islands.map((island) => {
              const host = islandHosts[island.id]
              if (!host || !host.isConnected) return null
              return createPortal(
                island.kind === "grid" ? (
                  <div className="plate-grid-island">
                    <ResultGrid columns={island.columns} rows={island.rows} />
                  </div>
                ) : island.kind === "chart" ? (
                  <ChartIsland island={island} onEmit={handleEmit} />
                ) : island.kind === "board" ? (
                  <BoardIsland island={island} runAction={runAction} onEmit={handleEmit} onOpenPlate={onOpenPlate} />
                ) : (
                  <MetricIsland island={island} />
                ),
                host,
                island.id,
              )
            })}
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

interface ShelfPlate {
  plate_id: string
  kit: string | null
  module: string | null
  title: string
  description: string | null
  gated: boolean
  violations: number
  gate_detail: string
  requires_role: string | null
  locked: boolean
}

interface ShelfKitMeta {
  kit: string
  version: string | null
  title: string | null
  description: string | null
}

interface ShelfAvailableKit {
  catalog_id: string
  name: string
  title: string | null
  description: string | null
  version: string | null
  ready: boolean
  blockers: string[]
}

export function PlatesWindow({
  activeConnectionId,
  onOpenPlate,
}: {
  activeConnectionId: string | null
  onOpenPlate: (plateId: string, title: string) => void
}) {
  const [plates, setPlates] = useState<ShelfPlate[]>([])
  const [kits, setKits] = useState<Record<string, ShelfKitMeta>>({})
  const [available, setAvailable] = useState<ShelfAvailableKit[]>([])
  const [installing, setInstalling] = useState<string | null>(null)
  const [installNote, setInstallNote] = useState<string | null>(null)
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
        const body = (await res.json()) as {
          ok: boolean
          plates?: ShelfPlate[]
          kits?: Record<string, ShelfKitMeta>
          available?: ShelfAvailableKit[]
          error?: string
        }
        if (cancelled) return
        if (!body.ok) setError(body.error ?? "failed to list plates")
        else {
          setPlates(body.plates ?? [])
          setKits(body.kits ?? {})
          setAvailable(body.available ?? [])
        }
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

  const installKit = useCallback(
    async (catalogId: string) => {
      if (!activeConnectionId || installing) return
      setInstalling(catalogId)
      setInstallNote(null)
      try {
        const res = await fetch("/api/kit/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId: activeConnectionId, catalogId }),
        })
        const body = (await res.json()) as {
          ok: boolean
          kit?: string
          selftestFailures?: Array<{ item: string; detail: string }>
          error?: string
        }
        if (!body.ok) {
          setInstallNote(body.error ?? "install failed")
        } else if ((body.selftestFailures?.length ?? 0) > 0) {
          const f = body.selftestFailures![0]
          setInstallNote(`set up, but self-test flagged ${body.selftestFailures!.length} item(s): ${f.item} — ${f.detail}`)
        } else {
          setInstallNote(`${body.kit} is set up — self-test clean`)
        }
        setReloadTick((t) => t + 1)
      } catch (e) {
        setInstallNote(e instanceof Error ? e.message : String(e))
      } finally {
        setInstalling(null)
      }
    },
    [activeConnectionId, installing],
  )

  // Shelf order: named kits alphabetically, then the kit-less standalones.
  const groups = useMemo(() => {
    const byKit = new Map<string, ShelfPlate[]>()
    for (const p of plates) {
      const key = p.kit ?? ""
      const list = byKit.get(key) ?? []
      list.push(p)
      byKit.set(key, list)
    }
    const keys = [...byKit.keys()].sort((a, b) => {
      if (a === "") return 1
      if (b === "") return -1
      return a.localeCompare(b)
    })
    return keys.map((key) => ({
      key,
      meta: key ? kits[key] : undefined,
      plates: (byKit.get(key) ?? []).slice().sort((a, b) => a.plate_id.localeCompare(b.plate_id)),
    }))
  }, [plates, kits])

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
        <div className="flex-1" />
        {installNote ? <span className="max-w-[46%] truncate text-[11px] text-main/80" title={installNote}>{installNote}</span> : null}
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
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.key || "·standalone"}>
                <div className="mb-1.5 flex items-baseline gap-2 px-1">
                  <span
                    className={cn(
                      "text-[10px] font-semibold uppercase tracking-wider",
                      g.key ? "text-main/75" : "text-chrome-text/45",
                    )}
                  >
                    {g.key ? (g.meta?.title ?? g.key) : "standalone"}
                  </span>
                  {g.meta?.version ? (
                    <span className="font-mono text-[9px] text-chrome-text/40">v{g.meta.version}</span>
                  ) : null}
                  <span className="text-[9px] text-chrome-text/35">
                    {g.plates.length} {g.plates.length === 1 ? "plate" : "plates"}
                  </span>
                  <div className="h-px flex-1 self-center bg-chrome-border/40" />
                </div>
                {g.meta?.description ? (
                  <div className="mb-1.5 truncate px-1 text-[10.5px] text-chrome-text/40">{g.meta.description}</div>
                ) : null}
                <div className="flex flex-col gap-1">
                  {g.plates.map((p) => (
                    <button
                      key={p.plate_id}
                      type="button"
                      disabled={p.gated || p.locked}
                      onClick={() => onOpenPlate(p.plate_id, p.title)}
                      title={
                        p.locked
                          ? `requires role ${p.requires_role} — ask your admin (rvbbit.grant_kit / GRANT ${p.requires_role})`
                          : p.gated
                            ? `module “${p.module}” gated: ${p.violations} contract violation(s)` +
                              (p.gate_detail ? ` — ${p.gate_detail}` : "") +
                              " — open the kit's switchboard"
                            : undefined
                      }
                      className={cn(
                        "rounded-md border border-chrome-border/50 bg-chrome-bg/25 px-2.5 py-1.5 text-left",
                        p.gated || p.locked
                          ? "cursor-not-allowed opacity-45"
                          : "hover:border-main/40 hover:bg-chrome-bg/40",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-foreground">{p.title}</span>
                        {p.module ? (
                          <span className="shrink-0 rounded-full border border-chrome-border px-1.5 text-[9px] uppercase tracking-wide text-chrome-text/55">
                            {p.module}
                          </span>
                        ) : null}
                        {p.gated ? (
                          <span className="shrink-0 rounded-full border border-warning/40 px-1.5 text-[9px] uppercase tracking-wide text-warning">
                            gated · {p.violations}
                          </span>
                        ) : null}
                        {p.locked ? (
                          <span className="shrink-0 rounded-full border border-chrome-border px-1.5 text-[9px] uppercase tracking-wide text-chrome-text/55">
                            🔒 {p.requires_role}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-chrome-text/35">
                          {p.plate_id}
                        </span>
                      </div>
                      {p.description ? (
                        <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-chrome-text/50">
                          {p.description}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {available.length > 0 ? (
              <section>
                <div className="mb-1.5 flex items-baseline gap-2 px-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-chrome-text/45">
                    shipped kits — run setup to activate
                  </span>
                  <span className="text-[9px] text-chrome-text/35">from the capability catalog</span>
                  <div className="h-px flex-1 self-center bg-chrome-border/40" />
                </div>
                <div className="flex flex-col gap-1">
                  {available.map((k) => (
                    <div
                      key={k.catalog_id}
                      className="flex items-center gap-2 rounded-md border border-dashed border-chrome-border/60 bg-chrome-bg/15 px-2.5 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-foreground/90">{k.title ?? k.name}</span>
                          {k.version ? (
                            <span className="shrink-0 font-mono text-[9px] text-chrome-text/40">v{k.version}</span>
                          ) : null}
                          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-chrome-text/35">{k.catalog_id}</span>
                        </div>
                        {k.description ? (
                          <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-chrome-text/50">{k.description}</div>
                        ) : null}
                      </div>
                      {k.ready ? (
                        <button
                          type="button"
                          disabled={installing != null}
                          onClick={() => void installKit(k.catalog_id)}
                          className="shrink-0 rounded-md border border-main/40 px-2.5 py-1 text-[11px] text-main hover:bg-main/10 disabled:opacity-50"
                        >
                          {installing === k.catalog_id ? "setting up…" : "Set up"}
                        </button>
                      ) : (
                        <span
                          className="shrink-0 rounded-md border border-warning/40 px-2.5 py-1 text-[11px] text-warning/90"
                          title={`Set up unlocks once its capability is installed. Missing: ${k.blockers.join(", ")}`}
                        >
                          needs {k.blockers[0] ?? "requirements"}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
