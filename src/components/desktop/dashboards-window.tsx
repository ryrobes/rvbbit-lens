"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react"

import { usePolling } from "@/lib/desktop/use-polling"
import { themeStyleTag } from "@/lib/desktop/assistant"
import { Plus } from "@/lib/icons"
import type { DashboardsPayload, DesktopParamValue } from "@/lib/desktop/types"
import type { QueryResultColumn, SchemaSnapshot } from "@/lib/db/types"
import { injectStatementFilters, type CrossFilter } from "@/lib/desktop/reactive-sql"
import {
  fetchDashboard,
  fetchDashboards,
  runDashboardQuery,
  type DashboardDetail,
  type DashboardRow,
} from "@/lib/rvbbit/dashboards"
import { ContextMenu, type ContextMenuState } from "./context-menu"
import { useWorkspaceActive } from "./workspace-active-context"

interface EmitParamInput {
  sourceWindowId: string
  sourceBlockName: string
  sourceTitle: string
  field: string
  value: unknown
  operator?: "eq" | "in" | "gte" | "lte"
  multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
  cascade?: boolean
}

interface Props {
  payload?: DashboardsPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  /** This desktop window's id — params emitted by the app carry it as source,
   *  and the inbound side excludes own params (narrow siblings, never self). */
  windowId?: string
  /** Standalone: one pinned app, no gallery rail — feels like its own window.
   *  The slug comes from payload.selectedSlug and never changes. */
  standalone?: boolean
  /** Active desktop filter params — linked into the app's queries (see broker). */
  params?: DesktopParamValue[]
  schema?: SchemaSnapshot | null
  /** Publish a filter param onto the workspace (the shell's emitParam). */
  onEmitParam?: (input: EmitParamInput) => void
  onOpenSqlData?: (sql: string, title: string) => void
  onCreateShortcut?: (dashboard: DashboardRow) => void
}

export const DASHBOARD_SELECT_EVENT = "rvbbit-lens:dashboard-select"

// Injected into the sandboxed iframe: defines rvbbitQuery(sql) over a postMessage
// bridge to the parent (lens runs it read-only via /api/db/query). The stored artifact
// HTML follows the same contract it was published against, so it renders unchanged.
function buildSrcdoc(html: string): string {
  // Provide BOTH clients (rvbbitQuery + a cowork.callMcpTool shim) over the same
  // postMessage bridge, so a Cowork-built artifact and a hosted-built one both render here.
  const shim =
    "<script>window.rvbbitQuery=function(sql,opts){return new Promise(function(res,rej){" +
    "var id='q'+Math.random().toString(36).slice(2);" +
    "function h(e){var d=e.data||{};if(d.__rvbbitQ===id){window.removeEventListener('message',h);" +
    "d.error?rej(new Error(d.error)):res(d.result);}}" +
    "window.addEventListener('message',h);parent.postMessage({__rvbbitQ:id,sql:String(sql),opts:opts||{}},'*');" +
    "});};" +
    "window.cowork=window.cowork||{};window.cowork.callMcpTool=async function(tool,args){" +
    "var d=await window.rvbbitQuery((args&&args.sql)||'');return{structuredContent:{rows:(d&&d.rows)||[]}};};" +
    // Archipelago bridge: apps can PUSH filters onto the desktop param shelf
    // (rvbbit.emitFilter) and SUBSCRIBE to desktop params (rvbbit.on('params')).
    // Subscribed apps get pushed updates in place; unsubscribed ones are
    // re-rendered by the host on param changes.
    "window.rvbbit=window.rvbbit||{};window.rvbbit.query=window.rvbbitQuery;" +
    "window.rvbbit.emitFilter=function(f){parent.postMessage({__rvbbitAppEvent:'filter',filter:f||{}},'*');};" +
    "var _ph=[];window.rvbbit.on=function(topic,cb){if(topic!=='params'||typeof cb!=='function')return;" +
    "_ph.push(cb);parent.postMessage({__rvbbitAppEvent:'subscribe',topic:'params'},'*');};" +
    "window.addEventListener('message',function(e){var d=e.data||{};if(d.__rvbbitParams===undefined)return;" +
    "for(var i=0;i<_ph.length;i++){try{_ph[i](d.params||[])}catch(_e){}}});</script>"
  return (
    "<!doctype html><meta charset=utf-8>" +
    "<style>html,body{margin:0;padding:14px;font-family:system-ui,-apple-system,sans-serif;" +
    "background:#15110d;color:#f0e6d8}a{color:#e8b572}</style>" +
    // Pre-materialized desktop theme vars — iframes can't resolve the
    // parent's custom properties, so bake the live values in.
    themeStyleTag() +
    shim +
    html
  )
}

function StatusDot({ status }: { status: string }) {
  const live = status === "live"
  return (
    <span
      title={live ? "live data dependencies detected" : "stored or static"}
      className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-amber-500/70"}`}
    />
  )
}

function RuntimePill({ runtime }: { runtime?: string | null }) {
  const label = runtime || "html"
  const python = label === "python-fastapi"
  return (
    <span
      title={python ? "Python FastAPI source bundle" : "Hosted HTML live app"}
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        python ? "bg-sky-500/12 text-sky-300" : "bg-emerald-500/10 text-emerald-300"
      }`}
    >
      {python ? "python" : "html"}
    </span>
  )
}

export function DashboardsWindow({ payload, activeConnectionId, hasRvbbit, windowId, standalone, params, schema, onEmitParam, onOpenSqlData, onCreateShortcut }: Props) {
  const workspaceActive = useWorkspaceActive()
  const [rows, setRows] = useState<DashboardRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(payload?.selectedSlug ?? null)
  const [detail, setDetail] = useState<DashboardDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ── Linked filters: desktop params flow INTO the app's queries ──
  // The broker executes every rvbbitQuery server-side anyway, so active filter
  // params are applied by WRAPPING the artifact's SQL (injectStatementFilters —
  // the same machinery grid clicks use), never by editing the artifact. Columns
  // from each run are cached so the output-column wrap has provenance on the
  // next run; a wrapped failure falls back to the untouched SQL.
  const [linkFilters, setLinkFilters] = useState(true)
  const [bridgeNonce, setBridgeNonce] = useState(0)
  const colCacheRef = useRef<Map<string, QueryResultColumn[]>>(new Map())

  const dashFilters = useMemo<CrossFilter[]>(() => {
    if (!linkFilters) return []
    const out: CrossFilter[] = []
    for (const p of params ?? []) {
      // Never self-filter: params this app emitted narrow the SIBLINGS (grid
      // semantics) — excluding them here also breaks any reload feedback loop.
      if (windowId && p.sourceWindowId === windowId) continue
      if (p.cascade === false) continue
      if (p.value === undefined || p.value === null) continue
      if (Array.isArray(p.value) && p.value.length === 0) continue
      out.push({
        sourceSchema: p.sourceSchema,
        sourceTable: p.sourceTable,
        column: p.sourceColumn || p.field,
        value: p.value,
        operator: p.operator,
      })
    }
    return out
  }, [params, linkFilters, windowId])
  const dashFiltersRef = useRef(dashFilters)
  dashFiltersRef.current = dashFilters
  const schemaRef = useRef<SchemaSnapshot | null>(schema ?? null)
  schemaRef.current = schema ?? null
  const onEmitParamRef = useRef(onEmitParam)
  onEmitParamRef.current = onEmitParam
  const dashIdentityRef = useRef<{ slug: string; name: string } | null>(null)
  // Set true when the CURRENT frame subscribes via rvbbit.on('params') — such
  // apps get params pushed in place instead of a full re-render.
  const paramsAwareRef = useRef(false)

  // Param changes re-render the app (fresh srcdoc → the artifact refetches its
  // queries through the broker, which now wraps with the new filters). Skip the
  // mount tick; debounce rapid clicks.
  const filterKey = useMemo(
    () => JSON.stringify(dashFilters.map((f) => [f.sourceSchema, f.sourceTable, f.column, f.operator, f.value])),
    [dashFilters],
  )
  const prevFilterKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevFilterKeyRef.current
    prevFilterKeyRef.current = filterKey
    if (prev === null || prev === filterKey || !selected) return
    const t = setTimeout(() => {
      if (paramsAwareRef.current) {
        // The app listens (rvbbit.on('params')): push in place — its follow-up
        // queries still flow through the wrapping broker.
        iframeRef.current?.contentWindow?.postMessage(
          { __rvbbitParams: true, params: dashFiltersRef.current.map((f) => ({ field: f.column, value: f.value, operator: f.operator ?? "eq" })) },
          "*",
        )
      } else {
        setBridgeNonce((n) => n + 1)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [filterKey, selected])

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchDashboards(activeConnectionId)
    setError(r.error ?? null)
    setRows(r.dashboards)
  }, [activeConnectionId])

  usePolling(reload, 8000, {
    enabled: !!activeConnectionId && hasRvbbit && workspaceActive && !standalone,
    resetKey: activeConnectionId,
  })

  useEffect(() => {
    if (standalone) return
    const onSelect = (event: Event) => {
      const slug = (event as CustomEvent<{ slug?: unknown }>).detail?.slug
      if (typeof slug === "string" && slug.trim()) setSelected(slug)
    }
    window.addEventListener(DASHBOARD_SELECT_EVENT, onSelect)
    return () => window.removeEventListener(DASHBOARD_SELECT_EVENT, onSelect)
  }, [standalone])

  // load the selected live app's html + sources
  useEffect(() => {
    let cancelled = false
    if (!activeConnectionId || !selected) return

    async function loadDetail() {
      setLoadingDetail(true)
      const d = await fetchDashboard(activeConnectionId!, selected!)
      if (cancelled) return
      setDetail(d.dashboard ?? null)
      setLoadingDetail(false)
    }

    void loadDetail()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selected])

  // data-broker: the iframe's rvbbitQuery posts here; run read-only, post the result back.
  // Also the app-event inbox: rvbbit.emitFilter lands as a desktop param, and
  // rvbbit.on('params') subscriptions mark the frame params-aware.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = (e.data ?? {}) as {
        __rvbbitQ?: string
        sql?: string
        __rvbbitAppEvent?: string
        topic?: string
        filter?: { field?: unknown; value?: unknown; operator?: unknown; multiValueAction?: unknown }
      }
      const frame = iframeRef.current
      if (d.__rvbbitAppEvent) {
        if (frame && e.source !== frame.contentWindow) return
        if (d.__rvbbitAppEvent === "subscribe" && d.topic === "params") {
          paramsAwareRef.current = true
          // Sync the late-arriving subscriber with the current filter set.
          frame?.contentWindow?.postMessage(
            { __rvbbitParams: true, params: dashFiltersRef.current.map((f) => ({ field: f.column, value: f.value, operator: f.operator ?? "eq" })) },
            "*",
          )
          return
        }
        if (d.__rvbbitAppEvent === "filter") {
          const emit = onEmitParamRef.current
          const identity = dashIdentityRef.current
          const f = d.filter ?? {}
          const field = typeof f.field === "string" ? f.field.trim() : ""
          if (!emit || !identity || !field || !windowId) return
          const operator = f.operator === "in" || f.operator === "gte" || f.operator === "lte" ? f.operator : "eq"
          const mva = f.multiValueAction
          emit({
            sourceWindowId: windowId,
            sourceBlockName: identity.slug,
            sourceTitle: identity.name,
            field,
            value: f.value,
            operator,
            multiValueAction: mva === "add" || mva === "remove" || mva === "toggle" || mva === "set" || mva === "replace" ? mva : undefined,
            cascade: true,
          })
          return
        }
        return
      }
      if (!d.__rvbbitQ || typeof d.sql !== "string") return
      if (frame && e.source !== frame.contentWindow) return
      if (!activeConnectionId) {
        frame?.contentWindow?.postMessage({ __rvbbitQ: d.__rvbbitQ, error: "no connection" }, "*")
        return
      }
      const original = d.sql
      let effective = original
      const filters = dashFiltersRef.current
      if (filters.length > 0) {
        const cached = colCacheRef.current.get(original)
        try {
          effective = injectStatementFilters(original, filters, schemaRef.current, cached ? [cached] : undefined)
        } catch {
          effective = original
        }
      }
      void (async () => {
        let r = await runDashboardQuery(activeConnectionId, effective)
        // Linked filters must never break a dashboard that worked without them.
        if (!r.ok && effective !== original) r = await runDashboardQuery(activeConnectionId, original)
        if (r.ok && r.columns.length > 0) colCacheRef.current.set(original, r.columns)
        frame?.contentWindow?.postMessage(
          r.ok ? { __rvbbitQ: d.__rvbbitQ, result: r.result } : { __rvbbitQ: d.__rvbbitQ, error: r.error },
          "*",
        )
      })()
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [activeConnectionId, windowId])

  const activeDetail = detail?.slug === selected ? detail : null

  // New frame (app switch or re-render) ⇒ the old rvbbit.on('params')
  // subscription died with it; identity feeds outbound param attribution.
  useEffect(() => {
    paramsAwareRef.current = false
    dashIdentityRef.current = activeDetail ? { slug: activeDetail.slug, name: activeDetail.name } : null
  }, [activeDetail, bridgeNonce])
  const srcdoc = useMemo(() => (activeDetail ? buildSrcdoc(activeDetail.html) : ""), [activeDetail])
  const byTeam = useMemo(() => {
    const m = new Map<string, DashboardRow[]>()
    for (const d of rows) {
      const k = d.team || "—"
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(d)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const queries = (activeDetail?.sources ?? []).filter((s) => s.kind === "query")
  const tables = (activeDetail?.sources ?? []).filter((s) => s.kind === "table")
  const metrics = (activeDetail?.sources ?? []).filter((s) => s.kind === "metric")

  const openDashboardMenu = (event: MouseEvent, dashboard: DashboardRow) => {
    if (!onCreateShortcut) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{
        id: "add-shortcut",
        label: "Add to Desktop",
        icon: Plus,
        onSelect: () => onCreateShortcut(dashboard),
      }],
    })
  }

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center bg-doc-bg text-sm text-chrome-text/55">
        rvbbit extension not detected on this connection.
      </div>
    )
  }

  return (
    <div className="flex h-full bg-doc-bg text-foreground">
      {/* gallery rail (hidden in standalone app windows) */}
      {standalone ? null : (
      <div className="flex w-64 shrink-0 flex-col border-r border-chrome-border">
        <div className="flex items-center justify-between border-b border-chrome-border px-3 py-2 text-[11px] uppercase tracking-wider text-chrome-text/55">
          <span>Dashboards · {rows.length}</span>
          <button onClick={reload} className="hover:text-rvbbit-accent" title="Refresh">↻</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="px-3 py-3 text-xs text-danger">{error}</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-xs text-chrome-text/45">
              No live apps yet. Use <code>live_app_template</code> and <code>create_live_app</code> from the warehouse MCP.
            </div>
          ) : (
            byTeam.map(([team, list]) => (
              <div key={team}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-chrome-text/40">{team}</div>
                {list.map((d) => (
                  <button
                    key={d.slug}
                    onClick={() => setSelected(d.slug)}
                    onContextMenu={(event) => openDashboardMenu(event, d)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 ${
                      selected === d.slug ? "bg-foreground/10 text-rvbbit-accent" : "text-foreground/85"
                    }`}
                  >
                    <StatusDot status={d.status} />
                    <span className="min-w-0 flex-1 truncate" title={d.description ?? d.name}>{d.name}</span>
                    <RuntimePill runtime={d.runtime_kind} />
                    {!!((d.queries ?? 0) + (d.tables ?? 0) + (d.metrics ?? 0)) && (
                      <span className="text-[10px] text-chrome-text/40" title="Detected data edges">
                        {(d.queries ?? 0) + (d.tables ?? 0) + (d.metrics ?? 0)}
                      </span>
                    )}
                    <span className="text-[10px] text-chrome-text/40">v{d.latest_version}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
      )}

      {/* viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!activeDetail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-chrome-text/45">
            {selected && loadingDetail ? "Loading…" : standalone ? "App not found." : "Select a live app to view it."}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-chrome-border px-3 py-1.5 text-[12px]">
              <StatusDot status={activeDetail.status} />
              <span className="font-medium">{activeDetail.name}</span>
              <span className="text-chrome-text/40">/{activeDetail.slug}</span>
              <RuntimePill runtime={activeDetail.runtime_kind} />
              {activeDetail.status !== "live" && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">stored</span>
              )}
              <button
                onClick={() => setLinkFilters((v) => !v)}
                title="Linked filters — apply active desktop filter params to this app's queries (wrapped at the broker; a failing wrap falls back to the app's own SQL)"
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  linkFilters
                    ? dashFilters.length > 0
                      ? "border-rvbbit-accent/60 text-rvbbit-accent"
                      : "border-chrome-border text-chrome-text/60"
                    : "border-chrome-border text-chrome-text/40"
                }`}
              >
                {linkFilters ? (dashFilters.length > 0 ? `⛓ filters · ${dashFilters.length}` : "⛓ filters on") : "filters off"}
              </button>
              {standalone ? (
                <span className="ml-auto" />
              ) : (
                <button
                  onClick={() => setSelected(null)}
                  className="ml-auto text-[11px] text-chrome-text/55 hover:text-rvbbit-accent"
                >
                  ✕ close
                </button>
              )}
            </div>
            <iframe
              key={`${activeDetail.slug}:${bridgeNonce}`}
              ref={iframeRef}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              title={activeDetail.name}
              className="min-h-0 flex-1 border-0 bg-[#15110d]"
            />
            {/* Sources strip — the data edges, explorable */}
            <div className="max-h-44 shrink-0 overflow-auto border-t border-chrome-border bg-foreground/[0.02] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/45">Sources</div>
              {activeDetail.sources.length === 0 ? (
                <div className="text-[11px] text-chrome-text/40">
                  No data edges extracted — a “dead tree” (static), or not crawled yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {queries.map((s, i) => (
                    <div key={`q${i}`} className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80" title={s.base_sql ?? ""}>
                        {s.base_sql}
                      </code>
                      <span className="text-[9px] text-chrome-text/35">{s.source}</span>
                      <button
                        onClick={() => onOpenSqlData?.(s.base_sql ?? "", `${activeDetail.name} — query ${i + 1}`)}
                        className="shrink-0 rounded border border-chrome-border px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:border-rvbbit-accent hover:text-rvbbit-accent"
                      >
                        open SQL ↗
                      </button>
                    </div>
                  ))}
                  {(tables.length > 0 || metrics.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {tables.map((s, i) => (
                        <span key={`t${i}`} className="rounded bg-foreground/8 px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/70">
                          {s.object_ref}
                        </span>
                      ))}
                      {metrics.map((s, i) => (
                        <span key={`m${i}`} className="rounded bg-rvbbit-accent/15 px-1.5 py-0.5 text-[10px] text-rvbbit-accent">
                          metric:{s.object_ref}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
