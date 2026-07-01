import { useCallback, useEffect, useState } from "react"
import { Brain, Database, RefreshCw, Plus, Check, Clock, Zap, Users, AlertTriangle, GitBranch, Trash2, X, Plug, FileCode2, Layers } from "@/lib/icons"
import {
  fetchSources,
  fetchSyncRuns,
  fetchPendingGrants,
  fetchProviders,
  fetchSystemLearningBrainStatus,
  defineProvider,
  deleteProvider,
  addQuerySource,
  configureSource,
  setSourceEnabled,
  syncSourceNow,
  syncSystemLearningBrain,
  enrichSource,
  deleteSource,
  approvePendingGrant,
  fetchDocGraph,
  fetchDocRelations,
  enrichDocNow,
  fetchNerStatus,
  type BrainSource,
  type BrainSyncRun,
  type BrainPendingGrant,
  type BrainProvider,
  type BrainGraphRow,
  type BrainRelation,
  type NerStatus,
  type SystemLearningBrainStatus,
} from "@/lib/rvbbit/brain"

const GLINER_CATALOG_ID = "extract/gliner-medium-v2.1"

const SOFT = "color-mix(in oklch, var(--chrome-text) 8%, transparent)"
const SOFTER = "color-mix(in oklch, var(--chrome-text) 4%, transparent)"
const LINE = "color-mix(in oklch, var(--chrome-text) 12%, transparent)"

function ago(ms: number | null): string {
  if (!ms) return "never"
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function fmtCount(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat("en", { notation: "compact" }).format(n) : "0"
}

// ── Sources admin: configure remote stores, sync, view runs, approve grants ────
export function SourcesPanel({
  conn,
  onOpenCapability,
}: {
  conn: string | null
  onOpenCapability?: (catalogId: string, tab?: string) => void
}) {
  const [sources, setSources] = useState<BrainSource[]>([])
  const [runs, setRuns] = useState<BrainSyncRun[]>([])
  const [grants, setGrants] = useState<BrainPendingGrant[]>([])
  const [providers, setProviders] = useState<BrainProvider[]>([])
  const [ner, setNer] = useState<NerStatus | null>(null)
  const [learning, setLearning] = useState<SystemLearningBrainStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [learningBusy, setLearningBusy] = useState(false)
  const [enrichBusy, setEnrichBusy] = useState<number | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ sourceId: number; purge: boolean } | null>(null)

  // add-source form
  const [label, setLabel] = useState("")
  const [endpoint, setEndpoint] = useState("http://rvbbit-gdrive-connector:8080/sync")
  const [folders, setFolders] = useState("")
  const [credsRef, setCredsRef] = useState("GDRIVE_SA_KEY")

  const reload = useCallback(async () => {
    if (!conn) return
    const [s, r, g, p, n, l] = await Promise.all([
      fetchSources(conn), fetchSyncRuns(conn), fetchPendingGrants(conn), fetchProviders(conn), fetchNerStatus(conn), fetchSystemLearningBrainStatus(conn),
    ])
    setError(s.error ?? r.error ?? g.error ?? p.error ?? l.error ?? null)
    setSources(s.sources)
    setRuns(r.runs)
    setGrants(g.grants)
    setProviders(p.providers)
    setNer(n)
    setLearning(l)
  }, [conn])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [reload])

  const addSource = useCallback(async () => {
    if (!conn || !label.trim()) return
    const r = await configureSource(conn, {
      label: label.trim(),
      kind: "gdrive",
      endpoint: endpoint.trim(),
      folders: folders.split(/[\s,]+/).map((f) => f.trim()).filter(Boolean),
      credsRef: credsRef.trim() || null,
    })
    if (r.error) setToast({ ok: false, msg: r.error })
    else {
      setToast({ ok: true, msg: `source “${label.trim()}” saved` })
      setLabel("")
      setFolders("")
    }
    void reload()
  }, [conn, label, endpoint, folders, credsRef, reload])

  const syncNow = useCallback(
    async (s: BrainSource) => {
      if (!conn) return
      setBusy(s.sourceId)
      setToast(null)
      const r = await syncSourceNow(conn, s.sourceId)
      setBusy(null)
      if (r.error || !r.result || r.result.error) {
        setToast({ ok: false, msg: r.error ?? String(r.result?.error ?? "sync failed") })
      } else {
        const x = r.result
        const detail = x.provider != null ? `fetched ${x.fetched ?? 0}` : `extracted ${x.extracted ?? 0}`
        setToast({
          ok: true,
          msg: `${s.label}: +${x.added ?? 0} ~${x.changed ?? 0} −${x.removed ?? 0} (${detail})`,
        })
      }
      void reload()
    },
    [conn, reload],
  )

  const enrichNow = useCallback(
    async (s: BrainSource, force: boolean) => {
      if (!conn) return
      setEnrichBusy(s.sourceId)
      setToast(null)
      const r = await enrichSource(conn, s.sourceId, { force })
      setEnrichBusy(null)
      if (r.error || !r.result) {
        setToast({ ok: false, msg: r.error ?? "enrich failed" })
      } else {
        const x = r.result
        const skipped = x.skip_triples === true ? " · NER+edges" : " · full"
        setToast({ ok: true, msg: `${s.label}: enriched ${x.enriched_docs ?? 0} doc${x.enriched_docs === 1 ? "" : "s"}${skipped}${x.errors ? ` · ${x.errors} err` : ""}` })
      }
      void reload()
    },
    [conn, reload],
  )

  const removeSource = useCallback(
    async (sourceId: number, purge: boolean) => {
      if (!conn) return
      setConfirmDel(null)
      const r = await deleteSource(conn, sourceId, purge)
      setToast(r.error ? { ok: false, msg: r.error } : { ok: true, msg: purge ? "source + docs deleted" : "source deleted, docs archived" })
      void reload()
    },
    [conn, reload],
  )

  const syncLearningNow = useCallback(async () => {
    if (!conn) return
    setLearningBusy(true)
    setToast(null)
    const r = await syncSystemLearningBrain(conn)
    setLearningBusy(false)
    if (!r.ok) {
      setToast({ ok: false, msg: r.error ?? "system learning sync failed" })
    } else {
      setToast({
        ok: true,
        msg: `system learning: +${fmtCount(r.added)} ~${fmtCount(r.changed)} skip ${fmtCount(r.skipped)}`,
      })
    }
    void reload()
  }, [conn, reload])

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-3 text-sm" style={{ color: "var(--chrome-text)" }}>
      {error && <div className="text-xs" style={{ color: "var(--danger)" }}>{error}</div>}
      {toast && (
        <div
          className="text-[11px] px-2 py-1 rounded flex items-center gap-1.5"
          style={{
            background: toast.ok ? "color-mix(in oklch, var(--success) 16%, transparent)" : "color-mix(in oklch, var(--danger) 16%, transparent)",
            color: toast.ok ? "var(--success)" : "var(--danger)",
          }}
        >
          {toast.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
          {toast.msg}
        </div>
      )}

      <SystemLearningStrip status={learning} busy={learningBusy} onSync={() => void syncLearningNow()} />

      {/* enrichment / NER capability status */}
      {ner && (
        <div className="rounded p-2 flex items-center gap-2 text-[11px]" style={{ background: SOFTER }}>
          <GitBranch size={12} className="opacity-70" />
          {ner.installed ? (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)" }} />
              Entity extraction (GLiNER NER) is active — enrichment tags comprehensive entities per chunk, alongside relations.
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} />
                NER not installed — enrichment captures relationships only, not full entity coverage.
              </span>
              <button
                onClick={() => onOpenCapability?.(ner.catalogId || GLINER_CATALOG_ID, "install")}
                className="ml-auto px-2 py-0.5 rounded"
                style={{ background: "color-mix(in oklch, var(--chrome-text) 14%, transparent)" }}
                title="Open the GLiNER capability (deploy on a local CPU or a remote GPU warren node)"
              >
                Install GLiNER →
              </button>
            </>
          )}
        </div>
      )}

      {/* add source */}
      <div className="rounded p-2 flex flex-col gap-1.5" style={{ background: SOFTER }}>
        <div className="flex items-center gap-1 text-[11px] opacity-70">
          <Plus size={12} /> Add a remote source (Google Drive docs or folders)
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (e.g. hr_drive)"
            className="px-1.5 py-0.5 rounded outline-none" style={{ background: SOFT, width: 150 }} />
          <input value={credsRef} onChange={(e) => setCredsRef(e.target.value)} placeholder="creds env var"
            className="px-1.5 py-0.5 rounded outline-none" style={{ background: SOFT, width: 130 }} title="env var name holding the service-account key (on the connector)" />
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="connector endpoint"
            className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT, minWidth: 200 }} />
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <input value={folders} onChange={(e) => setFolders(e.target.value)} placeholder="Drive doc/folder URLs or IDs (comma separated)"
            className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }}
            title="Paste one Google Doc or Drive folder URL/ID, or a comma-separated list mixing docs and folders." />
          <button onClick={() => void addSource()} disabled={!label.trim()}
            className="px-2 py-0.5 rounded disabled:opacity-40" style={{ background: "color-mix(in oklch, var(--chrome-text) 14%, transparent)" }}>
            Save
          </button>
        </div>
      </div>

      {/* providers & query sources (MCP / SQL-backed document types) */}
      <ProvidersSection conn={conn} providers={providers} reload={reload} setToast={setToast} />

      {/* sources */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1 text-[11px] opacity-70">
          <Database size={12} /> Sources
        </div>
        {sources.length === 0 && <div className="text-xs opacity-50">No sources configured yet.</div>}
        {sources.map((s) => (
          <div key={s.sourceId} className="rounded p-2 flex flex-col gap-1.5 text-[11px]" style={{ background: SOFTER }}>
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{ background: s.enabled ? "var(--success)" : "color-mix(in oklch, var(--chrome-text) 40%, transparent)" }} />
              <div className="flex flex-col">
                <span className="font-medium flex items-center gap-1">
                  {s.label}
                  {s.provider ? (
                    <span className="px-1 rounded inline-flex items-center gap-0.5 opacity-80"
                      style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)" }}
                      title={`MCP / query source · provider “${s.provider}”`}>
                      <Plug size={9} /> {s.provider}
                    </span>
                  ) : (
                    <span className="opacity-40">· {s.kind}</span>
                  )}
                </span>
                <span className="opacity-50">
                  {s.provider
                    ? `query · global · ${s.docs} docs · synced ${ago(s.lastSyncedMs)}`
                    : `${s.folders.length} Drive location${s.folders.length === 1 ? "" : "s"} · ${s.docs} docs · synced ${ago(s.lastSyncedMs)}`}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => void (conn && setSourceEnabled(conn, s.sourceId, !s.enabled).then(reload))}
                  className="opacity-60 hover:opacity-100" title={s.enabled ? "disable (skip nightly)" : "enable"}>
                  {s.enabled ? "on" : "off"}
                </button>
                <button onClick={() => void syncNow(s)} disabled={busy === s.sourceId || enrichBusy === s.sourceId}
                  className="px-1.5 py-0.5 rounded flex items-center gap-1 disabled:opacity-40"
                  style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)" }}
                  title={s.provider ? "Index this MCP/query set: fetch items → ingest + embed" : "Sync from the connector"}>
                  <Zap size={11} className={busy === s.sourceId ? "animate-pulse" : ""} />
                  {busy === s.sourceId ? "syncing…" : s.provider ? "Index" : "Sync now"}
                </button>
                <button onClick={(e) => void enrichNow(s, e.shiftKey)} disabled={enrichBusy === s.sourceId || busy === s.sourceId}
                  className="px-1.5 py-0.5 rounded flex items-center gap-1 disabled:opacity-40"
                  style={{ background: "color-mix(in oklch, var(--chrome-text) 12%, transparent)" }}
                  title={"Bulk-enrich this set into the knowledge graph (entities + structured edges). Shift-click to force re-enrich every doc."}>
                  <GitBranch size={11} className={enrichBusy === s.sourceId ? "animate-pulse" : ""} />
                  {enrichBusy === s.sourceId ? "enriching…" : "Enrich"}
                </button>
                <button onClick={() => setConfirmDel(confirmDel?.sourceId === s.sourceId ? null : { sourceId: s.sourceId, purge: true })}
                  className="opacity-50 hover:opacity-100" style={{ color: "var(--danger)" }} title="delete source">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {confirmDel?.sourceId === s.sourceId && (
              <div className="flex items-center gap-2 pl-3.5" style={{ color: "var(--danger)" }}>
                <span>Delete “{s.label}”?</span>
                <label className="flex items-center gap-1 opacity-90 cursor-pointer">
                  <input type="checkbox" checked={confirmDel.purge}
                    onChange={(e) => setConfirmDel({ sourceId: s.sourceId, purge: e.target.checked })} />
                  also purge its {s.docs} doc{s.docs === 1 ? "" : "s"}
                </label>
                <button onClick={() => void removeSource(s.sourceId, confirmDel.purge)}
                  className="px-1.5 py-0.5 rounded" style={{ background: "color-mix(in oklch, var(--danger) 22%, transparent)" }}>
                  {confirmDel.purge ? "Delete + purge" : "Delete (keep docs)"}
                </button>
                <button onClick={() => setConfirmDel(null)} className="opacity-60 hover:opacity-100 flex items-center gap-0.5">
                  <X size={11} /> cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* pending grants */}
      {grants.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1 text-[11px] opacity-70">
            <Users size={12} /> Pending grants (group / domain / link shares — approve to grant)
          </div>
          {grants.map((g, i) => (
            <PendingGrantRow key={i} conn={conn} g={g} onDone={reload} setToast={setToast} />
          ))}
        </div>
      )}

      {/* recent runs */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 text-[11px] opacity-70">
          <Clock size={12} /> Recent sync runs
        </div>
        <div className="rounded overflow-hidden" style={{ border: `1px solid ${LINE}` }}>
          {runs.length === 0 && <div className="text-xs opacity-50 p-2">No runs yet.</div>}
          {runs.map((r) => (
            <div key={r.runId} className="flex items-center gap-3 px-2 py-1 text-[10px]" style={{ borderTop: `1px solid ${LINE}` }}>
              <span className="opacity-60 w-16">{r.finishedMs == null ? "running…" : ago(r.startedMs)}</span>
              <span className="opacity-40">{r.trigger}</span>
              <span style={{ color: "var(--success)" }}>+{r.added}</span>
              <span className="opacity-70">~{r.changed}</span>
              <span style={{ color: "var(--danger)" }}>−{r.removed}</span>
              <span className="opacity-40">skip {r.skipped}</span>
              {r.errors > 0 && <span style={{ color: "var(--danger)" }}>err {r.errors}</span>}
              <span className="ml-auto opacity-40">{r.elapsedSec == null ? "" : `${Math.round(r.elapsedSec)}s`}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SystemLearningStrip({
  status,
  busy,
  onSync,
}: {
  status: SystemLearningBrainStatus | null
  busy: boolean
  onSync: () => void
}) {
  const installed = !!status?.installed && !!status.sourceId
  const ready = installed && status.enabled && status.docs > 0
  const groups = status?.groups ?? []
  const examples = status?.examples ?? []
  const groupLine = groups.length
    ? groups
        .slice(0, 5)
        .map((g) => `${g.objectType.replace(/_/g, " ")} ${fmtCount(g.items)}`)
        .join(" · ")
    : "no learned artifacts indexed yet"

  return (
    <div className="rounded p-2 flex flex-col gap-2 text-[11px]" style={{ background: SOFTER, border: `1px solid ${LINE}` }}>
      <div className="flex items-start gap-2">
        <Brain size={14} className="mt-0.5 opacity-80" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-medium">RVBBIT System Learning</span>
            <span
              className="px-1.5 py-0.5 rounded font-mono text-[9px] uppercase"
              style={{
                background: ready
                  ? "color-mix(in oklch, var(--success) 16%, transparent)"
                  : installed
                    ? "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)"
                    : "color-mix(in oklch, var(--warning) 16%, transparent)",
                color: ready ? "var(--success)" : installed ? "var(--rvbbit-accent, var(--chrome-text))" : "var(--warning)",
              }}
              title={status?.error ?? undefined}
            >
              {!status ? "checking" : ready ? "agent ready" : installed ? "needs sync" : "missing"}
            </span>
            <span className="ml-auto opacity-50 tabular-nums">
              {status ? `${fmtCount(status.indexedItems)} items · ${fmtCount(status.docs)} docs` : "—"}
            </span>
          </div>
          <div className="mt-0.5 truncate opacity-55" title={groupLine}>
            {groupLine}
          </div>
        </div>
        <button
          onClick={onSync}
          disabled={!installed || busy}
          className="px-1.5 py-0.5 rounded flex items-center gap-1 disabled:opacity-40"
          style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)" }}
          title={installed ? "Sync learned workload, routing, acceleration, and operator artifacts into Brain" : "Run rvbbit.migrate() to install system learning"}
        >
          <RefreshCw size={11} className={busy ? "animate-pulse" : ""} />
          {busy ? "syncing..." : "Sync"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-6">
        {groups.length === 0 ? (
          <span className="opacity-45">Agent search will include this source after the first sync.</span>
        ) : (
          groups.slice(0, 8).map((g) => (
            <span key={g.objectType} className="rounded px-1.5 py-0.5 tabular-nums" style={{ background: SOFT }}>
              {g.objectType.replace(/_/g, " ")} <span className="opacity-55">{fmtCount(g.items)}</span>
            </span>
          ))
        )}
      </div>
      {examples.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-1.5 pl-6">
          {examples.slice(0, 4).map((example) => {
            const handle = systemLearningExampleHandle(example)
            return (
              <div
                key={example.uri}
                className="min-w-0 rounded px-2 py-1"
                style={{ background: SOFT, border: `1px solid ${LINE}` }}
                title={`${example.title}${handle ? ` · ${handle}` : ""}`}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 rounded px-1 py-0.5 font-mono text-[8px] uppercase opacity-65" style={{ background: SOFTER }}>
                    {example.objectType.replace(/_/g, " ")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/85">
                    {example.title}
                  </span>
                </div>
                {handle ? <div className="mt-0.5 truncate font-mono text-[9px] opacity-45">{handle}</div> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function systemLearningExampleHandle(example: SystemLearningBrainStatus["examples"][number]): string {
  if (example.tableName && example.columnName) return `${example.tableName}.${example.columnName}`
  if (example.tableName) return example.tableName
  if (example.operatorName) return `rvbbit.${example.operatorName}`
  if (example.layout) return example.layout
  if (example.shapeKey) return example.shapeKey
  if (example.engine) return example.engine
  return example.status ?? ""
}

// ── Providers: MCP/SQL-backed document types + instantiate them as query sources ──
const LIST_EXAMPLE = `SELECT 'linear:'||(r->>'id')                         AS uri,
       (r->>'identifier')||' · '||(r->>'title')      AS title,
       (r->>'updatedAt')                             AS content_hash,
       (r->>'updatedAt')::timestamptz                AS occurred_at,
       concat_ws(E'\\n\\n', r->>'title', r->>'description',
                 'Status: '||(r->>'state'))          AS body
  FROM rvbbit.mcp_rows('Linear','list_issues','{}'::jsonb) r`

function ProvidersSection({
  conn, providers, reload, setToast,
}: {
  conn: string | null
  providers: BrainProvider[]
  reload: () => void
  setToast: (t: { ok: boolean; msg: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState("")
  const [label, setLabel] = useState("")
  const [listSql, setListSql] = useState("")
  const [itemSql, setItemSql] = useState("")
  const [icon, setIcon] = useState("")
  const [docType, setDocType] = useState("")
  const [edgeMap, setEdgeMap] = useState("")
  const [editing, setEditing] = useState(false)

  const resetForm = () => {
    setProvider(""); setLabel(""); setListSql(""); setItemSql(""); setIcon(""); setDocType(""); setEdgeMap(""); setEditing(false); setOpen(false)
  }
  const loadInto = (p: BrainProvider) => {
    setProvider(p.provider); setLabel(p.label); setListSql(p.listSql); setItemSql(p.itemSql ?? "")
    setIcon(p.icon ?? ""); setDocType(p.docType === "document" ? "" : p.docType); setEdgeMap(p.edgeCount > 0 ? p.edgeMap : ""); setEditing(true); setOpen(true)
  }
  const save = async () => {
    if (!conn || !provider.trim() || !label.trim() || !listSql.trim()) return
    if (edgeMap.trim()) {
      try { JSON.parse(edgeMap) } catch { setToast({ ok: false, msg: "edge map is not valid JSON" }); return }
    }
    const err = await defineProvider(conn, {
      provider: provider.trim(), label: label.trim(), listSql, itemSql: itemSql.trim() || null, icon: icon.trim() || null,
      edgeMap: edgeMap.trim() || null, docType: docType.trim() || null,
    })
    setToast(err ? { ok: false, msg: err } : { ok: true, msg: `provider “${label.trim()}” saved` })
    if (!err) resetForm()
    reload()
  }
  const remove = async (p: string) => {
    if (!conn) return
    const err = await deleteProvider(conn, p)
    setToast(err ? { ok: false, msg: err } : { ok: true, msg: "provider deleted" })
    reload()
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 text-[11px] opacity-70">
        <Plug size={12} /> Document providers <span className="opacity-50">(MCP / query — Linear, JIRA, …)</span>
        <button onClick={() => { if (open && !editing) resetForm(); else { setEditing(false); setProvider(""); setLabel(""); setListSql(""); setItemSql(""); setIcon(""); setOpen(true) } }}
          className="ml-auto opacity-60 hover:opacity-100 flex items-center gap-0.5">
          <Plus size={11} /> New provider
        </button>
      </div>

      {providers.length === 0 && !open && (
        <div className="text-[10px] opacity-50">
          Define a provider whose “scrape” is a SQL query (e.g. <code>rvbbit.mcp_rows(&apos;Linear&apos;,&apos;list_issues&apos;,…)</code>),
          then add it as a source. Its items become first-class, searchable, KG-linked documents.
        </div>
      )}

      {providers.map((p) => (
        <ProviderCard key={p.provider} conn={conn} p={p} onEdit={() => loadInto(p)} onDelete={() => void remove(p.provider)}
          reload={reload} setToast={setToast} />
      ))}

      {open && (
        <div className="rounded p-2 flex flex-col gap-1.5 text-[11px]" style={{ background: SOFTER, border: `1px solid ${LINE}` }}>
          <div className="flex items-center gap-1.5">
            <input value={provider} onChange={(e) => setProvider(e.target.value)} disabled={editing}
              placeholder="id (e.g. linear-issues)" className="px-1.5 py-0.5 rounded outline-none disabled:opacity-50"
              style={{ background: SOFT, width: 150 }} />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (e.g. Linear Issues)"
              className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }} />
            <input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="icon"
              className="px-1.5 py-0.5 rounded outline-none" style={{ background: SOFT, width: 70 }} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] opacity-50 w-14">doc type</span>
            <input value={docType} onChange={(e) => setDocType(e.target.value)} list="brain-doc-types"
              placeholder="document (default) — or ticket, meeting, pr, …"
              title="The type every doc from this provider's sources is tagged with. Custom is fine — keep it low-cardinality so it's a useful filter facet."
              className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }} />
            <datalist id="brain-doc-types">
              {["document", "ticket", "meeting", "transcript", "pr", "issue", "message", "table", "record"].map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="flex items-center gap-1 text-[10px] opacity-50">
            <FileCode2 size={10} /> list SQL → columns: <code>uri, title, content_hash, occurred_at</code> (+ <code>body</code> if single-phase)
          </div>
          <textarea value={listSql} onChange={(e) => setListSql(e.target.value)} placeholder={LIST_EXAMPLE} rows={6}
            className="px-1.5 py-1 rounded outline-none font-mono text-[10px] leading-snug resize-y" style={{ background: SOFT }} />
          <div className="flex items-center gap-1 text-[10px] opacity-50">
            <FileCode2 size={10} /> item SQL <span className="opacity-70">(optional — two-phase list→get)</span>: <code>$1</code> = uri → <code>body, title, occurred_at</code>
          </div>
          <textarea value={itemSql} onChange={(e) => setItemSql(e.target.value)} rows={2}
            placeholder="leave blank if list SQL already returns body"
            className="px-1.5 py-1 rounded outline-none font-mono text-[10px] leading-snug resize-y" style={{ background: SOFT }} />
          <div className="flex items-center gap-1 text-[10px] opacity-50">
            <GitBranch size={10} /> edge map <span className="opacity-70">(optional)</span>: deterministic KG edges from a <code>props</code> column —
            <code>[{"{"}&quot;predicate&quot;,&quot;kind&quot;,&quot;path&quot;{"}"}]</code> where path is a JSONPath
          </div>
          <textarea value={edgeMap} onChange={(e) => setEdgeMap(e.target.value)} rows={3}
            placeholder={'[{"predicate":"in_project","kind":"project","path":"$.project.name"},\n {"predicate":"assigned_to","kind":"person","path":"$.assignee.name"}]'}
            className="px-1.5 py-1 rounded outline-none font-mono text-[10px] leading-snug resize-y" style={{ background: SOFT }} />
          <div className="flex items-center gap-2">
            <button onClick={() => void save()} disabled={!provider.trim() || !label.trim() || !listSql.trim()}
              className="px-2 py-0.5 rounded disabled:opacity-40" style={{ background: "color-mix(in oklch, var(--chrome-text) 14%, transparent)" }}>
              {editing ? "Update provider" : "Save provider"}
            </button>
            <button onClick={resetForm} className="opacity-60 hover:opacity-100 flex items-center gap-0.5"><X size={11} /> cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderCard({
  conn, p, onEdit, onDelete, reload, setToast,
}: {
  conn: string | null
  p: BrainProvider
  onEdit: () => void
  onDelete: () => void
  reload: () => void
  setToast: (t: { ok: boolean; msg: string } | null) => void
}) {
  const [label, setLabel] = useState("")
  const [adding, setAdding] = useState(false)
  const add = async () => {
    if (!conn || !label.trim()) return
    setAdding(true)
    const r = await addQuerySource(conn, { label: label.trim(), provider: p.provider })
    setAdding(false)
    setToast(r.error ? { ok: false, msg: r.error } : { ok: true, msg: `source “${label.trim()}” added — hit Sync now` })
    if (!r.error) setLabel("")
    reload()
  }
  return (
    <div className="rounded p-2 flex flex-col gap-1.5 text-[11px]" style={{ background: SOFTER }}>
      <div className="flex items-center gap-2">
        <Layers size={12} className="opacity-60 shrink-0" />
        <div className="flex flex-col">
          <span className="font-medium flex items-center gap-1">
            {p.label} <span className="opacity-40">· {p.provider}</span>
            <span className="px-1 rounded opacity-80" style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 14%, transparent)" }}>
              {p.docType}
            </span>
          </span>
          <span className="opacity-50">
            {p.itemSql ? "two-phase (list→get)" : "single-phase"} · {p.sources} source{p.sources === 1 ? "" : "s"}
            {p.edgeCount > 0 ? ` · ${p.edgeCount} edge${p.edgeCount === 1 ? "" : "s"}` : ""}
            {p.description ? ` · ${p.description}` : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onEdit} className="opacity-60 hover:opacity-100">edit</button>
          <button onClick={onDelete} disabled={p.sources > 0} title={p.sources > 0 ? "remove its sources first" : "delete provider"}
            className="opacity-50 hover:opacity-100 disabled:opacity-20" style={{ color: "var(--danger)" }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5 pl-5">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="new source label (e.g. Linear · ENG)"
          onKeyDown={(e) => { if (e.key === "Enter") void add() }}
          className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }} />
        <button onClick={() => void add()} disabled={!label.trim() || adding}
          className="px-2 py-0.5 rounded flex items-center gap-1 disabled:opacity-40"
          style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)" }}>
          <Plus size={11} /> {adding ? "adding…" : "Add source"}
        </button>
      </div>
    </div>
  )
}

function PendingGrantRow({
  conn, g, onDone, setToast,
}: {
  conn: string | null
  g: BrainPendingGrant
  onDone: () => void
  setToast: (t: { ok: boolean; msg: string }) => void
}) {
  const [emails, setEmails] = useState("")
  return (
    <div className="rounded p-2 flex items-center gap-2 text-[11px]" style={{ background: SOFTER }}>
      <span className="px-1 rounded" style={{ background: "color-mix(in oklch, var(--warning) 20%, transparent)", color: "var(--warning)" }}>
        {g.grantKind}
      </span>
      <span className="opacity-70">{g.grantValue || "(any)"}</span>
      <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="emails to grant…"
        className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }} />
      <button
        onClick={async () => {
          if (!conn) return
          const err = await approvePendingGrant(conn, {
            sourceId: g.sourceId, folderId: g.folderId, grantKind: g.grantKind, grantValue: g.grantValue,
            emails: emails.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
          })
          setToast(err ? { ok: false, msg: err } : { ok: true, msg: "granted" })
          onDone()
        }}
        className="px-1.5 py-0.5 rounded" style={{ background: "color-mix(in oklch, var(--chrome-text) 14%, transparent)" }}>
        Approve
      </button>
    </div>
  )
}

// ── Doc graph: ACL-aware related entities + documents (in the doc detail) ──────
export function DocGraph({
  conn, email, docId, onOpenDoc,
}: {
  conn: string | null
  email: string
  docId: number
  onOpenDoc?: (docId: number) => void
}) {
  const [rows, setRows] = useState<BrainGraphRow[]>([])
  const [rels, setRels] = useState<BrainRelation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = useCallback(async () => {
    if (!conn || !email) {
      setRows([])
      setRels([])
      setLoaded(true)
      return
    }
    const [g, rl] = await Promise.all([fetchDocGraph(conn, email, docId), fetchDocRelations(conn, email, docId)])
    setRows(g.rows)
    setRels(rl.rels)
    setLoaded(true)
  }, [conn, email, docId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [reload])

  const entities = rows.filter((r) => r.relType === "entity")
  const related = rows.filter((r) => r.relType === "related_doc")
  // group entities by kind for a typed view
  const byKind = new Map<string, string[]>()
  for (const e of entities) {
    const arr = byKind.get(e.kind) ?? []
    arr.push(e.label)
    byKind.set(e.kind, arr)
  }
  const kinds = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)

  return (
    <div className="flex flex-col gap-1.5 mt-1 p-2 rounded" style={{ background: SOFTER }}>
      <div className="flex items-center gap-1 text-[11px] opacity-70">
        <GitBranch size={11} /> Knowledge graph
        <button
          onClick={async () => {
            if (!conn) return
            setEnriching(true)
            setEnrichMsg(null)
            const r = await enrichDocNow(conn, docId)
            setEnriching(false)
            if (r.error || !r.result) {
              setEnrichMsg({ ok: false, text: r.error ?? "enrich failed" })
            } else {
              const x = r.result
              const parts = [
                x.relations != null ? `${x.relations} rel` : null,
                x.ner_entities != null ? `${x.ner_entities} ner` : null,
                x.structured ? `${x.structured} edges` : null,
              ].filter(Boolean)
              setEnrichMsg({ ok: true, text: `enriched · ${parts.join(" · ") || "no entities found"}` })
            }
            void reload()
          }}
          className="ml-auto opacity-60 hover:opacity-100 flex items-center gap-1"
          title="(Re)extract entities, relations, structured edges, and wikilinks for this doc"
        >
          <RefreshCw size={10} className={enriching ? "animate-pulse" : ""} /> {enriching ? "enriching…" : "enrich"}
        </button>
      </div>
      {enrichMsg && (
        <div className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
          style={{ background: enrichMsg.ok ? "color-mix(in oklch, var(--success) 16%, transparent)" : "color-mix(in oklch, var(--danger) 16%, transparent)",
                   color: enrichMsg.ok ? "var(--success)" : "var(--danger)" }}>
          {enrichMsg.ok ? <Check size={10} /> : <AlertTriangle size={10} />} {enrichMsg.text}
          {enrichMsg.ok && !email && <span className="opacity-70">— set a “View as” identity to see the graph</span>}
        </div>
      )}

      {!email ? (
        <span className="text-[10px] opacity-50">Set a “View as” identity to see the graph.</span>
      ) : loaded && rows.length === 0 && rels.length === 0 ? (
        <span className="text-[10px] opacity-50">Not enriched yet — hit “enrich”, or wait for the nightly pass.</span>
      ) : (
        <>
          {/* typed relationships (the edges) */}
          {rels.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] opacity-50">Relationships</span>
              <div className="flex flex-col gap-0.5 max-h-44 overflow-auto">
                {rels.map((r, i) => (
                  <div key={i} className="text-[10px] flex items-center gap-1 flex-wrap">
                    <span className="px-1 rounded" style={{ background: SOFT }}>{r.subject}</span>
                    <span className="opacity-50">{r.predicate.replace(/_/g, " ")}</span>
                    <span className="px-1 rounded" style={{ background: SOFT }}>{r.object}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* entities grouped by type */}
          {kinds.length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              <span className="text-[10px] opacity-50">Entities</span>
              {kinds.map(([kind, labels]) => (
                <div key={kind} className="flex flex-wrap items-baseline gap-1">
                  <span className="text-[9px] uppercase tracking-wide opacity-40 w-20 shrink-0">{kind}</span>
                  {labels.map((l, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: SOFT }}>{l}</span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* related documents (shared-entity graph walk) */}
          {related.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1">
              <span className="text-[10px] opacity-50">Related documents</span>
              {related.map((r, i) => (
                <button
                  key={i}
                  onClick={() => r.docId != null && onOpenDoc?.(r.docId)}
                  className="text-[10px] text-left opacity-80 hover:opacity-100 flex items-center gap-1.5"
                >
                  <span className="truncate">{r.label}</span>
                  <span className="opacity-40">· {r.weight} shared</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
