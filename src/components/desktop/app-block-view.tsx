"use client"

import { useEffect, useMemo, useRef } from "react"

import { Button } from "@/components/ui/button"
import { FileCode2, Play, RefreshCw, Table2 } from "@/lib/icons"
import type { DesktopColumnDragPayload, DesktopColumnRef } from "@/lib/desktop/types"
import {
  htmlBlockQueryResults,
  type HtmlBlockQuery,
  type HtmlBlockQueryResult,
  type HtmlBlockSpec,
} from "@/lib/desktop/app-block"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"
import { setActiveColumnDragSource, writeColumnDragPayload } from "@/lib/desktop/column-drag"
import { cn } from "@/lib/utils"
import type { QueryResult } from "@/lib/db/types"

export interface AppBlockColumnDragSource {
  parentWindowId: string
  parentBlockName: string
  parentTitle: string
  parentSql: string
  relationKey: string
}

export interface AppBlockFilterInput {
  queryId?: string
  field: string
  value: unknown
  operator?: "eq" | "in" | "gte" | "lte"
  targetQueryId?: string
}

interface AppBlockViewProps {
  spec: HtmlBlockSpec | null | undefined
  result: QueryResult | null
  running: boolean
  error?: string | null
  activeConnectionId: string | null
  columnDragSource: AppBlockColumnDragSource | null
  onRun: () => void
  onRunSql: (sql: string) => Promise<QueryResult>
  onEmitFilter: (input: AppBlockFilterInput) => void
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

function resultPayload(entry: HtmlBlockQueryResult) {
  const r = entry.result
  return {
    queryId: entry.query.id,
    sql: entry.query.sql,
    columns: r?.columns ?? [],
    rows: r?.rows ?? [],
    rowCount: r?.rowCount ?? 0,
    truncated: r?.truncated ?? false,
    command: r?.command,
  }
}

function buildSrcdoc(spec: HtmlBlockSpec, entries: HtmlBlockQueryResult[]): string {
  const results: Record<string, ReturnType<typeof resultPayload>> = {}
  for (const entry of entries) results[entry.query.id] = resultPayload(entry)
  const boot = {
    title: spec.title,
    queries: spec.queries.map((q) => ({ id: q.id, title: q.title, role: q.role, sql: q.sql })),
    results,
  }
  const shim = `<script>
(function(){
  var boot = ${scriptJson(boot)};
  function clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function resolveLocal(ref){
    var queryId = typeof ref === "string" ? ref : ref && (ref.queryId || ref.id);
    if (queryId && boot.results[queryId]) return clone(boot.results[queryId]);
    return null;
  }
  window.rvbbitQuery = function(ref, opts){
    var local = resolveLocal(ref);
    if (local) return Promise.resolve(local);
    return new Promise(function(resolve, reject){
      var id = "appq" + Math.random().toString(36).slice(2);
      function onMessage(event){
        var data = event.data || {};
        if (data.__rvbbitAppQ !== id) return;
        window.removeEventListener("message", onMessage);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      }
      window.addEventListener("message", onMessage);
      parent.postMessage({ __rvbbitAppQ: id, ref: ref, opts: opts || {} }, "*");
    });
  };
  window.rvbbit = window.rvbbit || {};
  window.rvbbit.query = window.rvbbitQuery;
  window.rvbbit.queries = boot.queries;
  window.rvbbit.emitFilter = function(filter){
    parent.postMessage({ __rvbbitAppEvent: "filter", filter: filter || {} }, "*");
  };
})();</script>`
  const html = spec.html.trim()
  if (/<!doctype\b|<html[\s>]/i.test(html)) {
    if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${shim}`)
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${shim}</head>`)
    return html.replace(/<html([^>]*)>/i, `<html$1>${shim}`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${shim}${html}</body></html>`
}

function columnsFor(entry: HtmlBlockQueryResult): DesktopColumnRef[] {
  return (entry.result?.columns ?? []).map((c) => ({
    name: c.name,
    type: c.dataTypeName,
    dataTypeId: c.dataTypeId,
    role: c.dataTypeId && [20, 21, 23, 700, 701, 1700].includes(c.dataTypeId) ? "metric" : "dimension",
  }))
}

function queryLabel(query: HtmlBlockQuery): string {
  return query.title || query.id
}

export function AppBlockView({
  spec,
  result,
  running,
  error,
  activeConnectionId,
  columnDragSource,
  onRun,
  onRunSql,
  onEmitFilter,
}: AppBlockViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const entries = useMemo(() => htmlBlockQueryResults(spec, result), [spec, result])
  const srcDoc = useMemo(() => (spec ? buildSrcdoc(spec, entries) : ""), [spec, entries])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = (event.data ?? {}) as {
        __rvbbitAppQ?: string
        __rvbbitAppEvent?: string
        ref?: unknown
        filter?: Record<string, unknown>
      }
      if (data.__rvbbitAppEvent === "filter") {
        const f = data.filter ?? {}
        const field = typeof f.field === "string" ? f.field : ""
        if (!field) return
        const op = f.operator === "in" || f.operator === "gte" || f.operator === "lte" ? f.operator : "eq"
        onEmitFilter({
          queryId: typeof f.queryId === "string" ? f.queryId : typeof f.query === "string" ? f.query : undefined,
          field,
          value: f.value,
          operator: op,
          targetQueryId: typeof f.targetQueryId === "string" ? f.targetQueryId : undefined,
        })
        return
      }
      if (!data.__rvbbitAppQ) return
      if (!activeConnectionId) {
        frame.contentWindow?.postMessage({ __rvbbitAppQ: data.__rvbbitAppQ, error: "no connection" }, "*")
        return
      }
      const ref = data.ref
      const sql =
        typeof ref === "string"
          ? ref
          : ref && typeof ref === "object" && typeof (ref as { sql?: unknown }).sql === "string"
            ? String((ref as { sql: string }).sql)
            : ""
      if (!sql.trim()) {
        frame.contentWindow?.postMessage({ __rvbbitAppQ: data.__rvbbitAppQ, error: "unknown query" }, "*")
        return
      }
      onRunSql(sql)
        .then((r) => frame.contentWindow?.postMessage({ __rvbbitAppQ: data.__rvbbitAppQ, result: r }, "*"))
        .catch((e) => frame.contentWindow?.postMessage({ __rvbbitAppQ: data.__rvbbitAppQ, error: e instanceof Error ? e.message : String(e) }, "*"))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [activeConnectionId, onEmitFilter, onRunSql])

  if (!spec) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg text-[12px] text-chrome-text/55">
        <div className="rounded-md border border-chrome-border bg-chrome-bg/35 px-3 py-2">
          No HTML Block revision yet.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 bg-doc-bg">
      <div className="min-w-0 flex-1">
        <iframe
          ref={iframeRef}
          title={spec.title}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="h-full w-full border-0 bg-background"
        />
      </div>
      <aside className="flex w-64 shrink-0 flex-col border-l border-chrome-border bg-chrome-bg/45">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-chrome-border px-2">
          <span className="truncate text-[11px] font-medium text-foreground">{spec.title}</span>
          <Button size="sm" variant="ghost" onClick={onRun} disabled={running} title="Run HTML Block queries">
            {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {error ? (
          <div className="border-b border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
            {error}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {entries.map((entry) => {
            const cols = columnsFor(entry)
            const hasRows = !!entry.result
            return (
              <section key={entry.query.id} className="mb-3">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-chrome-text">
                  <Table2 className="h-3 w-3" />
                  <span className="min-w-0 flex-1 truncate">{queryLabel(entry.query)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-chrome-text/55">
                    {hasRows ? entry.result?.rowCount ?? 0 : "-"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {cols.length > 0 ? cols.map((col) => {
                    const payload: DesktopColumnDragPayload = {
                      kind: "rvbbit-lens.desktop.column",
                      parentWindowId: columnDragSource?.parentWindowId ?? "",
                      parentBlockName: columnDragSource?.parentBlockName ?? "",
                      parentTitle: `${columnDragSource?.parentTitle ?? spec.title} · ${queryLabel(entry.query)}`,
                      parentSql: entry.query.sql,
                      relationKey: `${columnDragSource?.relationKey ?? "html-block"}:${entry.query.id}`,
                      columns: [col],
                      sourceColumns: cols,
                    }
                    return (
                      <button
                        key={col.name}
                        type="button"
                        draggable={!!columnDragSource}
                        onDragStart={(event) => {
                          if (!columnDragSource) return
                          writeColumnDragPayload(event.dataTransfer, payload)
                          setActiveColumnDragSource({
                            parentWindowId: payload.parentWindowId,
                            parentBlockName: payload.parentBlockName,
                            relationKey: payload.relationKey,
                            columns: payload.columns,
                          })
                          attachDragGhost(event.dataTransfer, {
                            variant: "column",
                            label: col.name,
                            sublabel: col.role,
                          })
                        }}
                        onDragEnd={() => setActiveColumnDragSource(null)}
                        className={cn(
                          "inline-flex max-w-full items-center gap-1 rounded border border-chrome-border/70 bg-background px-1.5 py-0.5 text-[10px] text-chrome-text hover:border-main/45 hover:text-foreground",
                          columnDragSource && "cursor-grab active:cursor-grabbing",
                        )}
                        title={col.name}
                      >
                        <FileCode2 className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{col.name}</span>
                      </button>
                    )
                  }) : (
                    <span className="text-[10px] text-chrome-text/40">
                      {hasRows ? "No columns" : "Run for fields"}
                    </span>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
