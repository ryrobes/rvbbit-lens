import { useCallback, useEffect, useMemo, useState } from "react"
import { Brain, Folder, FolderOpen, FileText, Eye, Lock, Search, RefreshCw, ChevronRight, ChevronDown, X } from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  fetchPrincipals,
  fetchBrainTree,
  fetchBrainDoc,
  askBrain,
  type BrainDoc,
  type BrainHit,
  type BrainDocDetail,
} from "@/lib/rvbbit/brain"
import type { BrainPayload } from "@/lib/desktop/types"

interface BrainExplorerWindowProps {
  payload: BrainPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onChangePayload: (mut: (p: BrainPayload) => BrainPayload) => void
}

interface FolderNode {
  path: string
  name: string
  children: Map<string, FolderNode>
  docs: BrainDoc[]
}

function buildTree(docs: BrainDoc[]): FolderNode {
  const root: FolderNode = { path: "/", name: "/", children: new Map(), docs: [] }
  for (const d of docs) {
    const segs = d.folderPath.split("/").filter(Boolean)
    let node = root
    let acc = ""
    for (const seg of segs) {
      acc += "/" + seg
      let child = node.children.get(seg)
      if (!child) {
        child = { path: acc, name: seg, children: new Map(), docs: [] }
        node.children.set(seg, child)
      }
      node = child
    }
    node.docs.push(d)
  }
  return root
}

function countDocs(n: FolderNode): number {
  let c = n.docs.length
  for (const ch of n.children.values()) c += countDocs(ch)
  return c
}

function fmtDate(s: string | null): string {
  if (!s) return "—"
  return s.slice(0, 10)
}

// ── recursive folder tree (left pane) ─────────────────────────────────────────
function FolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: FolderNode
  depth: number
  selected: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const kids = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name))
  const isOpen = expanded.has(node.path)
  const isSel = selected === node.path
  const total = countDocs(node)
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-1 py-0.5 rounded cursor-pointer select-none text-xs",
          isSel && "font-semibold",
        )}
        style={{
          paddingLeft: 4 + depth * 12,
          background: isSel ? "color-mix(in oklch, var(--chrome-text) 12%, transparent)" : undefined,
        }}
        onClick={() => onSelect(node.path)}
      >
        {kids.length > 0 ? (
          <span
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.path)
            }}
            className="opacity-70"
          >
            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span style={{ width: 12, display: "inline-block" }} />
        )}
        {isOpen && kids.length > 0 ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span className="truncate">{node.name === "/" ? "All documents" : node.name}</span>
        <span className="ml-auto opacity-50 tabular-nums">{total}</span>
      </div>
      {isOpen &&
        kids.map((ch) => (
          <FolderRow
            key={ch.path}
            node={ch}
            depth={depth + 1}
            selected={selected}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  )
}

export function BrainExplorerWindow({ payload, activeConnectionId, hasRvbbit, onChangePayload }: BrainExplorerWindowProps) {
  const conn = activeConnectionId
  const [principals, setPrincipals] = useState<string[]>([])
  const [viewAs, setViewAs] = useState<string>(payload.viewAs ?? "")
  const [docs, setDocs] = useState<BrainDoc[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]))
  const [selectedFolder, setSelectedFolder] = useState<string>(payload.selectedFolder ?? "/")
  const [detail, setDetail] = useState<BrainDocDetail | null>(null)
  const [query, setQuery] = useState<string>("")
  const [hits, setHits] = useState<BrainHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // candidate identities
  useEffect(() => {
    if (!conn) return
    fetchPrincipals(conn).then((p) => {
      setPrincipals(p)
      setViewAs((cur) => cur || p[0] || "")
    })
  }, [conn])

  const reload = useCallback(async () => {
    if (!conn || !viewAs) {
      setDocs([])
      return
    }
    setLoading(true)
    const { docs, error } = await fetchBrainTree(conn, viewAs)
    setDocs(docs)
    setError(error)
    setLoading(false)
  }, [conn, viewAs])

  useEffect(() => {
    void reload()
    onChangePayload((p) => ({ ...p, viewAs }))
  }, [reload, viewAs]) // eslint-disable-line react-hooks/exhaustive-deps

  const tree = useMemo(() => buildTree(docs), [docs])

  // docs shown in the right pane: search hits, or the docs in/under the selected folder
  const folderDocs = useMemo(() => {
    if (selectedFolder === "/") return docs
    return docs.filter((d) => d.folderPath === selectedFolder || d.folderPath.startsWith(selectedFolder + "/"))
  }, [docs, selectedFolder])

  const openDoc = useCallback(
    async (docId: number) => {
      if (!conn || !viewAs) return
      onChangePayload((p) => ({ ...p, selectedDocId: docId }))
      const { doc } = await fetchBrainDoc(conn, viewAs, docId)
      setDetail(doc)
    },
    [conn, viewAs, onChangePayload],
  )

  const runSearch = useCallback(async () => {
    if (!conn || !viewAs || !query.trim()) {
      setHits(null)
      return
    }
    setLoading(true)
    const { hits, error } = await askBrain(conn, viewAs, query, 12)
    setHits(hits)
    setError(error)
    setLoading(false)
  }, [conn, viewAs, query])

  if (!hasRvbbit) {
    return <div className="p-4 text-xs opacity-70">The rvbbit extension is not installed on this connection.</div>
  }

  return (
    <div className="flex flex-col h-full text-sm" style={{ color: "var(--chrome-text)" }}>
      {/* header */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b" style={{ borderColor: "color-mix(in oklch, var(--chrome-text) 15%, transparent)" }}>
        <Brain size={16} />
        <span className="font-semibold">Document Brain</span>
        <span className="opacity-50 text-xs">role-gated · semantic</span>
        <div className="ml-auto flex items-center gap-2">
          <Eye size={13} className="opacity-60" />
          <span className="text-xs opacity-60">View as</span>
          <input
            list="brain-principals"
            value={viewAs}
            onChange={(e) => setViewAs(e.target.value)}
            placeholder="email…"
            className="text-xs px-1.5 py-0.5 rounded outline-none"
            style={{ background: "color-mix(in oklch, var(--chrome-text) 8%, transparent)", minWidth: 160 }}
          />
          <datalist id="brain-principals">
            {principals.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <button onClick={() => void reload()} className="opacity-70 hover:opacity-100" title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* search bar */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b" style={{ borderColor: "color-mix(in oklch, var(--chrome-text) 10%, transparent)" }}>
        <Search size={13} className="opacity-60" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch()
            if (e.key === "Escape") {
              setQuery("")
              setHits(null)
            }
          }}
          placeholder="Ask the brain (semantic search over what this identity can see)…"
          className="flex-1 text-xs px-2 py-1 rounded outline-none"
          style={{ background: "color-mix(in oklch, var(--chrome-text) 8%, transparent)" }}
        />
        {hits != null && (
          <button
            onClick={() => {
              setQuery("")
              setHits(null)
            }}
            className="text-xs opacity-70 hover:opacity-100 flex items-center gap-1"
          >
            <X size={12} /> clear
          </button>
        )}
      </div>

      {error && (
        <div className="px-2 py-1 text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* left: folder tree */}
        <div className="w-56 shrink-0 overflow-auto p-1 border-r" style={{ borderColor: "color-mix(in oklch, var(--chrome-text) 10%, transparent)" }}>
          {docs.length === 0 && !loading ? (
            <div className="text-xs opacity-50 p-2">{viewAs ? "No documents visible to this identity." : "Pick an identity to view as."}</div>
          ) : (
            <FolderRow
              node={tree}
              depth={0}
              selected={selectedFolder}
              expanded={expanded}
              onToggle={(p) =>
                setExpanded((s) => {
                  const n = new Set(s)
                  if (n.has(p)) n.delete(p)
                  else n.add(p)
                  return n
                })
              }
              onSelect={(p) => {
                setSelectedFolder(p)
                onChangePayload((pl) => ({ ...pl, selectedFolder: p }))
              }}
            />
          )}
        </div>

        {/* middle: doc list (search hits or folder contents) */}
        <div className="flex-1 min-w-0 overflow-auto p-1">
          {hits != null ? (
            <div className="flex flex-col gap-1">
              <div className="text-xs opacity-50 px-1 py-0.5">
                {hits.length} result{hits.length === 1 ? "" : "s"} · ranked by relevance
              </div>
              {hits.map((h, i) => (
                <div
                  key={`${h.docId}-${i}`}
                  className="flex flex-col gap-0.5 px-2 py-1.5 rounded cursor-pointer text-xs"
                  style={{ background: "color-mix(in oklch, var(--chrome-text) 5%, transparent)" }}
                  onClick={() => void openDoc(h.docId)}
                >
                  <div className="flex items-center gap-2">
                    <FileText size={13} className="opacity-70 shrink-0" />
                    <span className="font-medium truncate">{h.title}</span>
                    <span className="ml-auto tabular-nums opacity-60">{h.score?.toFixed(3)}</span>
                  </div>
                  <div className="opacity-60 truncate">{h.folderPath} · {h.source}</div>
                  <div className="opacity-75 line-clamp-2">{h.chunk}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {folderDocs.map((d) => (
                <div
                  key={d.docId}
                  className="flex flex-col items-center gap-1 p-2 rounded cursor-pointer text-center"
                  style={{ background: "color-mix(in oklch, var(--chrome-text) 5%, transparent)" }}
                  onClick={() => void openDoc(d.docId)}
                  title={`${d.title}\n${d.folderPath}`}
                >
                  <FileText size={28} className="opacity-80" />
                  <span className="text-xs truncate w-full">{d.title}</span>
                  <span className="text-[10px] opacity-50 truncate w-full">
                    {d.source} · {fmtDate(d.occurredMs ? new Date(d.occurredMs).toISOString() : null)}
                  </span>
                </div>
              ))}
              {folderDocs.length === 0 && <div className="text-xs opacity-50 p-2">Empty folder.</div>}
            </div>
          )}
        </div>

        {/* right: doc viewer */}
        {detail && (
          <div className="w-96 shrink-0 overflow-auto border-l p-3 flex flex-col gap-2" style={{ borderColor: "color-mix(in oklch, var(--chrome-text) 10%, transparent)" }}>
            <div className="flex items-start gap-2">
              <FileText size={16} className="mt-0.5 shrink-0" />
              <div className="font-semibold leading-tight">{detail.title}</div>
              <button onClick={() => setDetail(null)} className="ml-auto opacity-60 hover:opacity-100">
                <X size={14} />
              </button>
            </div>
            <div className="text-[11px] opacity-60 flex flex-col gap-0.5">
              <div>{detail.folderPath} · {detail.source}</div>
              {detail.author && <div>by {detail.author}</div>}
              <div>occurred {fmtDate(detail.occurredAt)} · ingested {fmtDate(detail.ingestedAt)}</div>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <Lock size={11} className="opacity-60" />
              {detail.roles.length ? (
                detail.roles.map((r) => (
                  <span key={r} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "color-mix(in oklch, var(--chrome-text) 12%, transparent)" }}>
                    {r}
                  </span>
                ))
              ) : (
                <span className="text-[10px] opacity-50">no roles (default-deny)</span>
              )}
            </div>
            <pre className="text-xs whitespace-pre-wrap leading-relaxed mt-1" style={{ fontFamily: "inherit" }}>
              {detail.body ?? "(no body)"}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
