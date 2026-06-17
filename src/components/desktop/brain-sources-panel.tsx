import { useCallback, useEffect, useState } from "react"
import { Database, RefreshCw, Plus, Check, Clock, Zap, Users, AlertTriangle, GitBranch, Trash2, X } from "@/lib/icons"
import {
  fetchSources,
  fetchSyncRuns,
  fetchPendingGrants,
  configureSource,
  setSourceEnabled,
  syncSourceNow,
  deleteSource,
  approvePendingGrant,
  fetchDocGraph,
  fetchDocRelations,
  enrichDocNow,
  type BrainSource,
  type BrainSyncRun,
  type BrainPendingGrant,
  type BrainGraphRow,
  type BrainRelation,
} from "@/lib/rvbbit/brain"

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

// ── Sources admin: configure remote stores, sync, view runs, approve grants ────
export function SourcesPanel({ conn }: { conn: string | null }) {
  const [sources, setSources] = useState<BrainSource[]>([])
  const [runs, setRuns] = useState<BrainSyncRun[]>([])
  const [grants, setGrants] = useState<BrainPendingGrant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ sourceId: number; purge: boolean } | null>(null)

  // add-source form
  const [label, setLabel] = useState("")
  const [endpoint, setEndpoint] = useState("http://rvbbit-gdrive-connector:8080/sync")
  const [folders, setFolders] = useState("")
  const [credsRef, setCredsRef] = useState("GDRIVE_SA_KEY")

  const reload = useCallback(async () => {
    if (!conn) return
    const [s, r, g] = await Promise.all([fetchSources(conn), fetchSyncRuns(conn), fetchPendingGrants(conn)])
    setError(s.error ?? r.error ?? g.error ?? null)
    setSources(s.sources)
    setRuns(r.runs)
    setGrants(g.grants)
  }, [conn])

  useEffect(() => {
    void reload()
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
        setToast({
          ok: true,
          msg: `${s.label}: +${x.added ?? 0} ~${x.changed ?? 0} −${x.removed ?? 0} (extracted ${x.extracted ?? 0})`,
        })
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

      {/* add source */}
      <div className="rounded p-2 flex flex-col gap-1.5" style={{ background: SOFTER }}>
        <div className="flex items-center gap-1 text-[11px] opacity-70">
          <Plus size={12} /> Add a remote source (Google Drive)
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
          <input value={folders} onChange={(e) => setFolders(e.target.value)} placeholder="Drive folder IDs (comma/space separated)"
            className="px-1.5 py-0.5 rounded outline-none flex-1" style={{ background: SOFT }} />
          <button onClick={() => void addSource()} disabled={!label.trim()}
            className="px-2 py-0.5 rounded disabled:opacity-40" style={{ background: "color-mix(in oklch, var(--chrome-text) 14%, transparent)" }}>
            Save
          </button>
        </div>
      </div>

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
                <span className="font-medium">{s.label} <span className="opacity-40">· {s.kind}</span></span>
                <span className="opacity-50">{s.folders.length} folder{s.folders.length === 1 ? "" : "s"} · {s.docs} docs · synced {ago(s.lastSyncedMs)}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => void (conn && setSourceEnabled(conn, s.sourceId, !s.enabled).then(reload))}
                  className="opacity-60 hover:opacity-100" title={s.enabled ? "disable (skip nightly)" : "enable"}>
                  {s.enabled ? "on" : "off"}
                </button>
                <button onClick={() => void syncNow(s)} disabled={busy === s.sourceId}
                  className="px-1.5 py-0.5 rounded flex items-center gap-1 disabled:opacity-40"
                  style={{ background: "color-mix(in oklch, var(--rvbbit-accent, var(--chrome-text)) 16%, transparent)" }}>
                  <Zap size={11} className={busy === s.sourceId ? "animate-pulse" : ""} />
                  {busy === s.sourceId ? "syncing…" : "Sync now"}
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
    void reload()
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
            await enrichDocNow(conn, docId)
            setEnriching(false)
            void reload()
          }}
          className="ml-auto opacity-60 hover:opacity-100 flex items-center gap-1"
          title="(Re)extract entities, relations, and wikilinks for this doc"
        >
          <RefreshCw size={10} className={enriching ? "animate-pulse" : ""} /> {enriching ? "enriching…" : "enrich"}
        </button>
      </div>

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
