"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

/**
 * Kit Flow — the switchboard, drawn (0204/0205). A layered graph of a
 * kit's DERIVED app flow: layouts contain plates, plates open each other,
 * params drive via the bus, queries read (logic plates: check) tables,
 * actions write them, contracts gate modules. Everything comes from
 * rvbbit.kit_graph() — nothing is declared for this view, so it can never
 * drift from the app it describes. Plate nodes open the plate; layout
 * nodes open the wall — the map is also a door.
 */

interface FlowEdge {
  src_kind: string
  src: string
  edge: string
  dst_kind: string
  dst: string
}

const KIND_ORDER = ["layout", "contract", "module", "plate", "param", "table"]
const KIND_COLOR: Record<string, string> = {
  layout: "#7f9fd4", contract: "#d47f7f", module: "#c9a2d8",
  plate: "#f5b446", param: "#8fcf9a", table: "#8faec4",
}

async function q(connectionId: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId, sql, readOnly: true, rowLimit: 500, poolLane: "meta" }),
  })
  const j = await res.json()
  if (!j.ok) throw new Error(j.error ?? "query failed")
  return j.rows ?? []
}

export function KitFlowWindow({
  activeConnectionId,
  initialKit,
  onOpenPlate,
  onOpenWall,
}: {
  activeConnectionId: string | null
  initialKit?: string
  onOpenPlate: (plateId: string, title?: string) => void
  onOpenWall: (layoutId: string) => void
}) {
  const [kits, setKits] = useState<string[]>([])
  const [kit, setKit] = useState<string>(initialKit ?? "")
  const [edges, setEdges] = useState<FlowEdge[]>([])
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<"graph" | "brief">("graph")
  const [brief, setBrief] = useState<string>("")

  // The Briefing: rvbbit.kit_brief() — deterministic, compiled at read
  // time, and THE SAME document agents receive. Fetched per kit/tab so
  // the live check statuses inside it are current when you look.
  useEffect(() => {
    if (!activeConnectionId || !kit || view !== "brief") return
    setBrief("")
    void q(activeConnectionId,
      `SELECT rvbbit.kit_brief('${kit.replace(/'/g, "''")}') AS brief`)
      .then((rows) => setBrief(String(rows[0]?.brief ?? "")))
      .catch((e) => setBrief(`(brief failed: ${e instanceof Error ? e.message : String(e)})`))
  }, [activeConnectionId, kit, view])

  useEffect(() => {
    if (!activeConnectionId) return
    void q(activeConnectionId, "SELECT kit FROM rvbbit.kits ORDER BY 1")
      .then((rows) => {
        const ks = rows.map((r) => String(r.kit))
        setKits(ks)
        setKit((cur) => cur || (ks.includes("certify") ? "certify" : ks[0] ?? ""))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !kit) return
    setError(null)
    void q(activeConnectionId,
      `SELECT src_kind, src, edge, dst_kind, dst FROM rvbbit.kit_graph('${kit.replace(/'/g, "''")}')`)
      .then((rows) => setEdges(rows as unknown as FlowEdge[]))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [activeConnectionId, kit])

  const openNode = useCallback(
    (kind: string, label: string) => {
      if (kind === "plate") onOpenPlate(label, label)
      else if (kind === "layout") onOpenWall(label)
    },
    [onOpenPlate, onOpenWall],
  )

  const scene = useMemo(() => {
    const nodes = new Map<string, { kind: string; label: string; x: number; y: number; row: number }>()
    for (const e of edges) {
      nodes.set(`${e.src_kind}:${e.src}`, { kind: e.src_kind, label: e.src, x: 0, y: 0, row: 0 })
      nodes.set(`${e.dst_kind}:${e.dst}`, { kind: e.dst_kind, label: e.dst, x: 0, y: 0, row: 0 })
    }
    const cols = KIND_ORDER.filter((k) => [...nodes.values()].some((n) => n.kind === k))
    const W = 1160
    const colW = W / Math.max(cols.length, 1)
    const perCol: Record<number, number> = {}
    let maxRows = 1
    for (const n of nodes.values()) {
      const c = cols.indexOf(n.kind)
      n.x = c * colW + colW / 2
      n.row = perCol[c] ?? 0
      perCol[c] = n.row + 1
      maxRows = Math.max(maxRows, perCol[c])
    }
    const rowH = 46
    const H = maxRows * rowH + 56
    for (const n of nodes.values()) {
      const colCount = perCol[cols.indexOf(n.kind)] ?? 1
      n.y = 36 + ((maxRows - colCount) * rowH) / 2 + n.row * rowH
    }
    return { nodes, W, H, colW }
  }, [edges])

  return (
    <div className="flex h-full flex-col bg-doc-bg text-foreground">
      <div className="flex shrink-0 items-center gap-3 border-b border-chrome-border/60 px-3 py-2">
        <span className="text-[13px] font-semibold">Kit Flow</span>
        <div className="flex overflow-hidden rounded-md border border-chrome-border text-[11px]">
          {(["graph", "brief"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={
                view === v
                  ? "bg-foreground/10 px-2.5 py-1 text-foreground"
                  : "px-2.5 py-1 text-chrome-text/60 hover:text-foreground"
              }
            >
              {v === "graph" ? "Graph" : "Briefing"}
            </button>
          ))}
        </div>
        <select
          value={kit}
          onChange={(e) => setKit(e.target.value)}
          className="rounded-md border border-chrome-border bg-chrome-bg px-2 py-1 text-[12px]"
        >
          {kits.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <span className="text-[10px] text-chrome-text/45">
          derived from layouts · rv-open · params · reads / writes · contracts — click a plate or layout to open it
        </span>
        <span className="ml-auto flex items-center gap-3 text-[9.5px] text-chrome-text/60">
          {KIND_ORDER.map((k) => (
            <span key={k} style={{ color: KIND_COLOR[k] }}>■ {k}</span>
          ))}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <div className="p-4 text-[12px] text-destructive">{error}</div>
        ) : view === "brief" ? (
          <div className="mx-auto max-w-3xl px-4 py-3">
            <MdLite text={brief || "…compiling briefing"} />
          </div>
        ) : (
          <svg width="100%" viewBox={`0 0 ${scene.W} ${scene.H}`} style={{ minHeight: scene.H }}>
            {edges.map((e, i) => {
              const a = scene.nodes.get(`${e.src_kind}:${e.src}`)
              const b = scene.nodes.get(`${e.dst_kind}:${e.dst}`)
              if (!a || !b) return null
              const mx = (a.x + b.x) / 2
              return (
                <g key={i}>
                  <path
                    d={`M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`}
                    fill="none"
                    stroke={`${KIND_COLOR[a.kind] ?? "#888"}55`}
                    strokeWidth={1.3}
                  />
                  <text x={mx} y={(a.y + b.y) / 2 - 4} textAnchor="middle"
                        style={{ fontSize: 8.5, fill: "var(--chrome-text, #9a8b74)", opacity: 0.7 }}>
                    {e.edge}
                  </text>
                </g>
              )
            })}
            {[...scene.nodes.values()].map((n) => {
              const w = Math.min(Math.max(n.label.length * 6.4 + 18, 60), scene.colW - 14)
              const clickable = n.kind === "plate" || n.kind === "layout"
              const shown = n.label.length > Math.floor(w / 6.4)
                ? `${n.label.slice(0, Math.floor(w / 6.4) - 1)}…`
                : n.label
              return (
                <g
                  key={`${n.kind}:${n.label}`}
                  onClick={() => openNode(n.kind, n.label)}
                  style={{ cursor: clickable ? "pointer" : "default" }}
                >
                  <rect x={n.x - w / 2} y={n.y - 13} width={w} height={26} rx={7}
                        fill="var(--chrome-bg, #1e1813)"
                        stroke={KIND_COLOR[n.kind] ?? "#888"} strokeWidth={clickable ? 1.5 : 1} />
                  <text x={n.x} y={n.y + 4} textAnchor="middle"
                        style={{ fontSize: 11, fill: "var(--foreground, #e8ddcc)" }}>
                    {shown}
                  </text>
                  <title>{`${n.kind}: ${n.label}${clickable ? " — click to open" : ""}`}</title>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}


/** Tiny renderer for kit_brief's own markdown grammar — headers, lists,
 *  bold, code spans, italics, hr. The input is machine-compiled by
 *  rvbbit.kit_brief(), so the grammar is closed; no library needed. */
function MdLite({ text }: { text: string }) {
  const inline = (s: string, key: number) => {
    const parts: React.ReactNode[] = []
    const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g
    let last = 0
    let m: RegExpExecArray | null
    let i = 0
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parts.push(s.slice(last, m.index))
      const tok = m[0]
      if (tok.startsWith("**")) parts.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>)
      else if (tok.startsWith("`"))
        parts.push(
          <code key={`${key}-${i++}`} className="rounded bg-foreground/[0.08] px-1 py-0.5 text-[11px]">
            {tok.slice(1, -1)}
          </code>,
        )
      else parts.push(<em key={`${key}-${i++}`} className="text-chrome-text/70">{tok.slice(1, -1)}</em>)
      last = m.index + tok.length
    }
    if (last < s.length) parts.push(s.slice(last))
    return parts
  }
  const blocks: React.ReactNode[] = []
  let list: React.ReactNode[] = []
  const flushList = (k: string) => {
    if (list.length) {
      blocks.push(<ul key={k} className="my-2 ml-4 list-disc space-y-1">{list}</ul>)
      list = []
    }
  }
  text.split("\n").forEach((line, n) => {
    if (line.startsWith("- ")) {
      list.push(<li key={n} className="text-[12.5px] leading-relaxed">{inline(line.slice(2), n)}</li>)
      return
    }
    flushList(`ul-${n}`)
    if (line.startsWith("### ")) blocks.push(<h4 key={n} className="mt-4 mb-1 text-[12px] font-semibold uppercase tracking-wide text-chrome-text/70">{inline(line.slice(4), n)}</h4>)
    else if (line.startsWith("## ")) blocks.push(<h3 key={n} className="mt-5 mb-1.5 text-[14px] font-semibold text-foreground">{inline(line.slice(3), n)}</h3>)
    else if (line.startsWith("# ")) blocks.push(<h2 key={n} className="mb-2 text-[17px] font-bold text-foreground">{inline(line.slice(2), n)}</h2>)
    else if (line.trim() === "---") blocks.push(<hr key={n} className="my-4 border-chrome-border/60" />)
    else if (line.trim() === "") blocks.push(<div key={n} className="h-1.5" />)
    else blocks.push(<p key={n} className="text-[12.5px] leading-relaxed text-chrome-text/90">{inline(line, n)}</p>)
  })
  flushList("ul-end")
  return <div>{blocks}</div>
}
