"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { usePolling } from "@/lib/desktop/use-polling"
import {
  fetchDashboard,
  fetchDashboards,
  runDashboardQuery,
  type DashboardDetail,
  type DashboardRow,
} from "@/lib/rvbbit/dashboards"
import { useWorkspaceActive } from "./workspace-active-context"

interface Props {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSqlData?: (sql: string, title: string) => void
}

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
    "var d=await window.rvbbitQuery((args&&args.sql)||'');return{structuredContent:{rows:(d&&d.rows)||[]}};};</script>"
  return (
    "<!doctype html><meta charset=utf-8>" +
    "<style>html,body{margin:0;padding:14px;font-family:system-ui,-apple-system,sans-serif;" +
    "background:#15110d;color:#f0e6d8}a{color:#e8b572}</style>" +
    shim +
    html
  )
}

function StatusDot({ status }: { status: string }) {
  const live = status === "live"
  return (
    <span
      title={live ? "live (catalog-linked)" : "static — no live data / inspectability"}
      className={`inline-block h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400" : "bg-amber-500/70"}`}
    />
  )
}

export function DashboardsWindow({ activeConnectionId, hasRvbbit, onOpenSqlData }: Props) {
  const workspaceActive = useWorkspaceActive()
  const [rows, setRows] = useState<DashboardRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<DashboardDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchDashboards(activeConnectionId)
    setError(r.error ?? null)
    setRows(r.dashboards)
  }, [activeConnectionId])

  usePolling(reload, 8000, {
    enabled: !!activeConnectionId && hasRvbbit && workspaceActive,
    resetKey: activeConnectionId,
  })

  // load the selected dashboard's html + sources
  useEffect(() => {
    let cancelled = false
    if (!activeConnectionId || !selected) {
      setDetail(null)
      return
    }
    setLoadingDetail(true)
    fetchDashboard(activeConnectionId, selected).then((d) => {
      if (cancelled) return
      setDetail(d.dashboard ?? null)
      setLoadingDetail(false)
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selected])

  // data-broker: the iframe's rvbbitQuery posts here; run read-only, post the result back
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = (e.data ?? {}) as { __rvbbitQ?: string; sql?: string }
      if (!d.__rvbbitQ || typeof d.sql !== "string") return
      const frame = iframeRef.current
      if (frame && e.source !== frame.contentWindow) return
      if (!activeConnectionId) {
        frame?.contentWindow?.postMessage({ __rvbbitQ: d.__rvbbitQ, error: "no connection" }, "*")
        return
      }
      runDashboardQuery(activeConnectionId, d.sql).then((r) => {
        frame?.contentWindow?.postMessage(
          r.ok ? { __rvbbitQ: d.__rvbbitQ, result: r.result } : { __rvbbitQ: d.__rvbbitQ, error: r.error },
          "*",
        )
      })
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [activeConnectionId])

  const srcdoc = useMemo(() => (detail ? buildSrcdoc(detail.html) : ""), [detail])
  const byTeam = useMemo(() => {
    const m = new Map<string, DashboardRow[]>()
    for (const d of rows) {
      const k = d.team || "—"
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(d)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  const queries = (detail?.sources ?? []).filter((s) => s.kind === "query")
  const tables = (detail?.sources ?? []).filter((s) => s.kind === "table")
  const metrics = (detail?.sources ?? []).filter((s) => s.kind === "metric")

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center bg-doc-bg text-sm text-chrome-text/55">
        rvbbit extension not detected on this connection.
      </div>
    )
  }

  return (
    <div className="flex h-full bg-doc-bg text-foreground">
      {/* gallery rail */}
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
              No dashboards yet. Publish one from Claude (Cowork) with <code>publish_dashboard</code>.
            </div>
          ) : (
            byTeam.map(([team, list]) => (
              <div key={team}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-chrome-text/40">{team}</div>
                {list.map((d) => (
                  <button
                    key={d.slug}
                    onClick={() => setSelected(d.slug)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-foreground/5 ${
                      selected === d.slug ? "bg-foreground/10 text-rvbbit-accent" : "text-foreground/85"
                    }`}
                  >
                    <StatusDot status={d.status} />
                    <span className="min-w-0 flex-1 truncate" title={d.description ?? d.name}>{d.name}</span>
                    <span className="text-[10px] text-chrome-text/40">v{d.latest_version}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-chrome-text/45">
            {loadingDetail ? "Loading…" : "Select a dashboard to view it live."}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-chrome-border px-3 py-1.5 text-[12px]">
              <StatusDot status={detail.status} />
              <span className="font-medium">{detail.name}</span>
              <span className="text-chrome-text/40">/{detail.slug}</span>
              {detail.status !== "live" && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">static</span>
              )}
              <button
                onClick={() => setSelected(null)}
                className="ml-auto text-[11px] text-chrome-text/55 hover:text-rvbbit-accent"
              >
                ✕ close
              </button>
            </div>
            <iframe
              key={detail.slug}
              ref={iframeRef}
              srcDoc={srcdoc}
              sandbox="allow-scripts"
              title={detail.name}
              className="min-h-0 flex-1 border-0 bg-[#15110d]"
            />
            {/* Sources strip — the data edges, explorable */}
            <div className="max-h-44 shrink-0 overflow-auto border-t border-chrome-border bg-foreground/[0.02] px-3 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/45">Sources</div>
              {detail.sources.length === 0 ? (
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
                        onClick={() => onOpenSqlData?.(s.base_sql ?? "", `${detail.name} — query ${i + 1}`)}
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
    </div>
  )
}
