"use client"

import { useMemo, useState } from "react"
import { Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * Visualizes a Postgres `EXPLAIN` plan as a top-down node graph.
 *
 * With the pg_rvbbit `EXPLAIN (SEMANTIC)` option the result also carries
 * a "Semantic Execution Graph" — the external/LLM work the query will
 * trigger, which Postgres's own cost model is blind to. That graph is
 * rendered as a second cluster to the right of the plan tree: each
 * semantic call site is a node, its endpoints (LLM / sidecar / code)
 * hang below it, and a dashed edge anchors the call site to the plan
 * node whose row estimate drives its invocation count. That anchor is
 * the whole point — it shows *why* a call site costs what it does (a
 * WHERE-clause operator runs per scanned row; a SELECT-list one only
 * per output row).
 */

export interface ExplainNode {
  "Node Type": string
  Plans?: ExplainNode[]
  "Total Cost"?: number
  "Startup Cost"?: number
  "Plan Rows"?: number
  "Actual Total Time"?: number
  "Actual Rows"?: number
  "Actual Loops"?: number
  "Relation Name"?: string
  "Index Name"?: string
  "Alias"?: string
  "Join Type"?: string
  [key: string]: unknown
}

export interface SemanticEndpoint {
  Kind?: string
  Name?: string
  Calls?: number
  "Tokens In"?: number
  "Tokens Out"?: number
  "Cost Status"?: string
  "Cost USD"?: number
  [key: string]: unknown
}

export interface SemanticCallSite {
  Operator?: string
  Shape?: string
  "Return Type"?: string
  Invocations?: number
  "Invocations Kind"?: string
  Note?: string
  Endpoints?: SemanticEndpoint[]
  [key: string]: unknown
}

export interface SemanticGraph {
  Mode?: string
  "Call Sites"?: SemanticCallSite[]
  "External Call Summary"?: {
    "LLM Calls"?: number
    "Sidecar Calls"?: number
    "Code Calls"?: number
    "Total Cost USD"?: number
    "Cost Basis"?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ExplainRoot {
  Plan: ExplainNode
  "Planning Time"?: number
  "Execution Time"?: number
  "Semantic Execution Graph"?: SemanticGraph
  [key: string]: unknown
}

/** Pull the plan document out of an EXPLAIN (FORMAT JSON) result. */
export function parseExplainResult(
  rows: Array<Record<string, unknown>>,
): ExplainRoot | null {
  if (!rows || rows.length === 0) return null
  let raw: unknown = rows[0]["QUERY PLAN"] ?? Object.values(rows[0])[0]
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const arr = Array.isArray(raw) ? raw : [raw]
  const root = arr[0]
  if (!root || typeof root !== "object" || !("Plan" in root)) return null
  return root as ExplainRoot
}

// ── Layout constants ────────────────────────────────────────────────

const NODE_W = 172
const NODE_H = 70
const COL_GAP = 30
const ROW_GAP = 58
const COL_SPAN = NODE_W + COL_GAP
const ROW_SPAN = NODE_H + ROW_GAP
const SEM_GAP_COLS = 1.5 // gap between plan tree and semantic cluster

// ── Plan-tree layout ────────────────────────────────────────────────

interface LaidNode {
  raw: ExplainNode
  children: LaidNode[]
  depth: number
  col: number
  inclusive: number
  self: number
}

function buildLayout(
  raw: ExplainNode,
  depth: number,
  analyzed: boolean,
  colCounter: { n: number },
): LaidNode {
  const children = (raw.Plans ?? []).map((c) =>
    buildLayout(c, depth + 1, analyzed, colCounter),
  )
  let col: number
  if (children.length === 0) {
    col = colCounter.n
    colCounter.n += 1
  } else {
    col = (children[0].col + children[children.length - 1].col) / 2
  }
  const inclusive = analyzed
    ? (raw["Actual Total Time"] ?? 0) * (raw["Actual Loops"] ?? 1)
    : raw["Total Cost"] ?? 0
  const childSum = children.reduce((s, c) => s + c.inclusive, 0)
  return { raw, children, depth, col, inclusive, self: Math.max(0, inclusive - childSum) }
}

function flatten(node: LaidNode, out: LaidNode[] = []): LaidNode[] {
  out.push(node)
  for (const c of node.children) flatten(c, out)
  return out
}

/** A plan node's descriptor as the semantic Note phrases it. */
function nodeDescriptor(n: ExplainNode): string {
  const rel = n["Relation Name"]
  return rel ? `${n["Node Type"]} on ${rel}` : n["Node Type"]
}

/** Find the plan node a call site is anchored to, parsed from its Note. */
function resolveAnchor(cs: SemanticCallSite, planNodes: LaidNode[]): LaidNode | null {
  const m = (cs.Note ?? "").match(/via EXPLAIN:\s*([^;]+)/)
  if (!m) return null
  const desc = m[1].trim()
  const exact = planNodes
    .filter((n) => nodeDescriptor(n.raw) === desc)
    .sort((a, b) => a.depth - b.depth)
  if (exact[0]) return exact[0]
  const byType = planNodes
    .filter((n) => n.raw["Node Type"] === desc)
    .sort((a, b) => a.depth - b.depth)
  return byType[0] ?? null
}

// ── Semantic-cluster layout ─────────────────────────────────────────

interface LaidEndpoint {
  raw: SemanticEndpoint
  col: number
  depth: number
}
interface LaidCallSite {
  raw: SemanticCallSite
  col: number
  depth: number
  cost: number
  endpoints: LaidEndpoint[]
  anchor: LaidNode | null
}

// ── Component ───────────────────────────────────────────────────────

type Selected =
  | { kind: "plan"; raw: ExplainNode }
  | { kind: "callsite"; raw: SemanticCallSite }
  | { kind: "endpoint"; raw: SemanticEndpoint }

export function ExplainGraph({
  plan,
  analyzed,
}: {
  plan: ExplainRoot
  analyzed: boolean
}) {
  const [selected, setSelected] = useState<Selected | null>(null)

  const layout = useMemo(() => {
    const counter = { n: 0 }
    const root = buildLayout(plan.Plan, 0, analyzed, counter)
    const planNodes = flatten(root)
    const planCols = Math.max(1, counter.n)
    const planDepth = planNodes.reduce((m, n) => Math.max(m, n.depth), 0)

    const semantic = plan["Semantic Execution Graph"]
    const callSitesRaw = semantic?.["Call Sites"] ?? []

    const callSites: LaidCallSite[] = []
    let cursor = 0
    const semBase = planCols + SEM_GAP_COLS
    for (const cs of callSitesRaw) {
      const eps = cs.Endpoints ?? []
      const span = Math.max(1, eps.length)
      const start = semBase + cursor
      const cost = eps.reduce((s, e) => s + (e["Cost USD"] ?? 0), 0)
      callSites.push({
        raw: cs,
        col: start + (span - 1) / 2,
        depth: 0,
        cost,
        endpoints: eps.map((e, j) => ({ raw: e, col: start + j, depth: 1 })),
        anchor: resolveAnchor(cs, planNodes),
      })
      cursor += span + 0.5
    }

    const rootInclusive = root.inclusive || 1
    const semCost = callSites.reduce((s, c) => s + c.cost, 0)
    const totalCols = callSites.length ? semBase + cursor - 0.5 : planCols
    const totalDepth = Math.max(planDepth, callSites.length ? 1 : 0)

    return { planNodes, callSites, planCols, rootInclusive, semCost, totalCols, totalDepth, semantic }
  }, [plan, analyzed])

  const { planNodes, callSites, rootInclusive, semCost, totalCols, totalDepth, semantic } =
    layout
  const width = totalCols * COL_SPAN
  const height = (totalDepth + 1) * ROW_SPAN

  const nodeX = (col: number) => col * COL_SPAN + COL_GAP / 2
  const nodeY = (depth: number) => depth * ROW_SPAN
  const cx = (col: number) => nodeX(col) + NODE_W / 2

  // Which plan nodes anchor semantic call sites → badge them.
  const anchorInfo = new Map<LaidNode, { cost: number; ops: number }>()
  for (const cs of callSites) {
    if (!cs.anchor) continue
    const cur = anchorInfo.get(cs.anchor) ?? { cost: 0, ops: 0 }
    anchorInfo.set(cs.anchor, { cost: cur.cost + cs.cost, ops: cur.ops + 1 })
  }

  return (
    <div className="flex h-full flex-col">
      <PlanSummary plan={plan} analyzed={analyzed} />
      {callSites.length > 0 ? <SemanticSummary semantic={semantic} /> : null}

      <div className="flex-1 overflow-auto p-6">
        <div className="relative" style={{ width, height }}>
          <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
            {/* plan → plan (row flow) */}
            {planNodes.flatMap((n) =>
              n.children.map((c) => (
                <path
                  key={`p-${n.depth}-${n.col}-${c.col}`}
                  d={vEdge(cx(n.col), nodeY(n.depth) + NODE_H, cx(c.col), nodeY(c.depth))}
                  fill="none"
                  stroke="var(--chrome-border)"
                  strokeWidth={1.5}
                />
              )),
            )}
            {/* call site → endpoint (dispatch) */}
            {callSites.flatMap((cs) =>
              cs.endpoints.map((ep) => (
                <path
                  key={`e-${cs.col}-${ep.col}`}
                  d={vEdge(cx(cs.col), nodeY(cs.depth) + NODE_H, cx(ep.col), nodeY(ep.depth))}
                  fill="none"
                  stroke="var(--rvbbit-accent)"
                  strokeWidth={1.5}
                />
              )),
            )}
            {/* plan node → call site (anchor: drives invocation count) */}
            {callSites.map((cs) =>
              cs.anchor ? (
                <path
                  key={`a-${cs.col}`}
                  d={hEdge(
                    nodeX(cs.anchor.col) + NODE_W,
                    nodeY(cs.anchor.depth) + NODE_H / 2,
                    nodeX(cs.col),
                    nodeY(cs.depth) + NODE_H / 2,
                  )}
                  fill="none"
                  stroke="var(--rvbbit-accent)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  opacity={0.6}
                />
              ) : null,
            )}
          </svg>

          {/* plan nodes */}
          {planNodes.map((n) => (
            <PlanNodeBox
              key={`pn-${n.depth}-${n.col}`}
              node={n}
              analyzed={analyzed}
              rootInclusive={rootInclusive}
              anchor={anchorInfo.get(n) ?? null}
              selected={selected?.kind === "plan" && selected.raw === n.raw}
              onSelect={() =>
                setSelected((s) =>
                  s?.kind === "plan" && s.raw === n.raw ? null : { kind: "plan", raw: n.raw },
                )
              }
              style={posStyle(nodeX(n.col), nodeY(n.depth))}
            />
          ))}

          {/* call-site nodes */}
          {callSites.map((cs) => (
            <CallSiteBox
              key={`cs-${cs.col}`}
              site={cs}
              semCost={semCost}
              selected={selected?.kind === "callsite" && selected.raw === cs.raw}
              onSelect={() =>
                setSelected((s) =>
                  s?.kind === "callsite" && s.raw === cs.raw
                    ? null
                    : { kind: "callsite", raw: cs.raw },
                )
              }
              style={posStyle(nodeX(cs.col), nodeY(cs.depth))}
            />
          ))}

          {/* endpoint nodes */}
          {callSites.flatMap((cs) =>
            cs.endpoints.map((ep) => (
              <EndpointBox
                key={`ep-${cs.col}-${ep.col}`}
                endpoint={ep.raw}
                selected={selected?.kind === "endpoint" && selected.raw === ep.raw}
                onSelect={() =>
                  setSelected((s) =>
                    s?.kind === "endpoint" && s.raw === ep.raw
                      ? null
                      : { kind: "endpoint", raw: ep.raw },
                  )
                }
                style={posStyle(nodeX(ep.col), nodeY(ep.depth))}
              />
            )),
          )}
        </div>
      </div>

      {selected ? (
        <NodeDetail selected={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  )
}

// ── Summary strips ──────────────────────────────────────────────────

function PlanSummary({ plan, analyzed }: { plan: ExplainRoot; analyzed: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px]">
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
          analyzed ? "bg-main/15 text-main" : "bg-secondary-background text-chrome-text/70",
        )}
      >
        {analyzed ? "analyzed" : "estimated"}
      </span>
      {typeof plan["Planning Time"] === "number" ? (
        <Stat label="planning" value={`${plan["Planning Time"].toFixed(2)} ms`} />
      ) : null}
      {typeof plan["Execution Time"] === "number" ? (
        <Stat label="execution" value={`${plan["Execution Time"].toFixed(2)} ms`} />
      ) : null}
      <Stat label="total cost" value={fmtNum(plan.Plan["Total Cost"] ?? 0)} />
      <div className="flex-1" />
      <span className="text-[10px] text-chrome-text/50">click a node for detail</span>
    </div>
  )
}

function SemanticSummary({ semantic }: { semantic?: SemanticGraph }) {
  const sum = semantic?.["External Call Summary"]
  const cost = sum?.["Total Cost USD"] ?? 0
  const llm = sum?.["LLM Calls"] ?? 0
  const sidecar = sum?.["Sidecar Calls"] ?? 0
  const code = sum?.["Code Calls"] ?? 0
  const total = llm + sidecar + code
  return (
    <div className="flex items-center gap-3 border-b border-rvbbit-accent/40 bg-rvbbit-bg/40 px-3 py-1.5 text-[11px]">
      <span className="inline-flex items-center gap-1 rounded-full bg-rvbbit-accent/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-rvbbit-accent">
        <Zap className="h-2.5 w-2.5" weight="fill" />
        semantic
      </span>
      <span className="font-semibold text-rvbbit-accent">
        {fmtUSD(cost)}
      </span>
      <span className="text-chrome-text/50">·</span>
      <Stat label="external calls" value={String(total)} />
      <span className="text-chrome-text/70">
        {llm} LLM
        {sidecar ? ` · ${sidecar} sidecar` : ""}
        {code ? ` · ${code} code` : ""}
      </span>
      <div className="flex-1" />
      {sum?.["Cost Basis"] ? (
        <span className="text-[10px] text-chrome-text/55">{sum["Cost Basis"]}</span>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-chrome-text">
      <span className="text-chrome-text/55">{label} </span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  )
}

// ── Node boxes ──────────────────────────────────────────────────────

function PlanNodeBox({
  node,
  analyzed,
  rootInclusive,
  anchor,
  selected,
  onSelect,
  style,
}: {
  node: LaidNode
  analyzed: boolean
  rootInclusive: number
  anchor: { cost: number; ops: number } | null
  selected: boolean
  onSelect: () => void
  style: React.CSSProperties
}) {
  const raw = node.raw
  const type = raw["Node Type"]
  const share = Math.min(1, Math.max(0, node.self / rootInclusive))
  const relation = raw["Relation Name"] ?? raw["Index Name"] ?? raw["Alias"]
  const isSeqScan = type === "Seq Scan"
  const planRows = raw["Plan Rows"] ?? 0
  const actualRows = raw["Actual Rows"]
  const badEstimate =
    analyzed &&
    typeof actualRows === "number" &&
    estimateRatio(planRows, actualRows) >= 10

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...style,
        borderColor: selected
          ? "var(--main)"
          : badEstimate
            ? "var(--viz-series-5)"
            : "var(--chrome-border)",
      }}
      className={cn(
        "relative flex flex-col gap-0.5 overflow-hidden rounded-md border-2 bg-secondary-background px-2 py-1 pb-1.5 text-left",
        selected ? "ring-1 ring-main/50" : "",
      )}
    >
      <div className="flex items-center gap-1">
        <span className="truncate text-[11px] font-semibold text-foreground">
          {raw["Join Type"] ? `${raw["Join Type"]} ${type}` : type}
        </span>
        {anchor ? (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded bg-rvbbit-accent/20 px-1 text-[8px] font-medium text-rvbbit-accent"
            title={`${anchor.ops} semantic call site${anchor.ops === 1 ? "" : "s"} evaluated here`}
          >
            <Zap className="h-2 w-2" weight="fill" />
            {anchor.cost > 0 ? fmtUSD(anchor.cost) : `${anchor.ops} op`}
          </span>
        ) : isSeqScan ? (
          <span
            className="ml-auto shrink-0 rounded bg-warning/20 px-1 text-[8px] uppercase text-warning"
            title="Sequential scan"
          >
            seq
          </span>
        ) : null}
        {badEstimate ? (
          <span className="shrink-0 rounded bg-danger/20 px-1 text-[8px] uppercase text-danger">
            est✗
          </span>
        ) : null}
      </div>
      {relation ? (
        <div className="truncate font-mono text-[9px] text-chrome-text">{relation}</div>
      ) : (
        <div className="text-[9px] text-chrome-text/40">—</div>
      )}
      <div className="mt-auto flex items-center justify-between text-[9px] tabular-nums text-chrome-text">
        <span className="font-medium text-foreground">
          {analyzed
            ? fmtMs(raw["Actual Total Time"] ?? 0)
            : `cost ${fmtNum(raw["Total Cost"] ?? 0)}`}
        </span>
        <span>
          {analyzed && typeof actualRows === "number"
            ? `${fmtNum(actualRows)} / ${fmtNum(planRows)} rows`
            : `${fmtNum(planRows)} rows`}
        </span>
      </div>
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-[3px]"
        style={{
          width: `${Math.max(3, Math.round(share * 100))}%`,
          backgroundColor: share >= 0.5 ? "var(--viz-series-5)" : "var(--viz-status-pending)",
        }}
      />
    </button>
  )
}

function CallSiteBox({
  site,
  semCost,
  selected,
  onSelect,
  style,
}: {
  site: LaidCallSite
  semCost: number
  selected: boolean
  onSelect: () => void
  style: React.CSSProperties
}) {
  const cs = site.raw
  const invocations = cs.Invocations ?? 0
  const estimated = (cs["Invocations Kind"] ?? "estimated") === "estimated"
  const share = semCost > 0 ? Math.min(1, site.cost / semCost) : 0

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...style,
        borderColor: selected ? "var(--main)" : "var(--viz-op-llm)",
      }}
      className={cn(
        "relative flex flex-col gap-0.5 overflow-hidden rounded-md border-2 bg-rvbbit-bg px-2 py-1 pb-1.5 text-left",
        selected ? "ring-1 ring-main/50" : "",
      )}
    >
      <div className="flex items-center gap-1">
        <Zap className="h-3 w-3 shrink-0 text-rvbbit-accent" weight="fill" />
        <span className="truncate text-[11px] font-semibold text-foreground">
          rvbbit.{cs.Operator}
        </span>
      </div>
      <div className="truncate font-mono text-[9px] text-chrome-text">
        {cs.Shape ?? "scalar"} → {cs["Return Type"] ?? "?"}
      </div>
      <div className="mt-auto flex items-center justify-between text-[9px] tabular-nums">
        <span className="text-chrome-text">
          {estimated ? "~" : ""}
          {fmtNum(invocations)}× calls
        </span>
        <span className="font-medium text-rvbbit-accent">{fmtUSD(site.cost)}</span>
      </div>
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-[3px]"
        style={{
          width: `${Math.max(3, Math.round(share * 100))}%`,
          backgroundColor: share >= 0.5 ? "var(--viz-series-5)" : "var(--viz-op-llm)",
        }}
      />
    </button>
  )
}

function EndpointBox({
  endpoint,
  selected,
  onSelect,
  style,
}: {
  endpoint: SemanticEndpoint
  selected: boolean
  onSelect: () => void
  style: React.CSSProperties
}) {
  const kind = (endpoint.Kind ?? "").toUpperCase()
  const billable = (endpoint["Cost Status"] ?? "") === "billable"
  const tokIn = endpoint["Tokens In"] ?? 0
  const tokOut = endpoint["Tokens Out"] ?? 0
  const cost = endpoint["Cost USD"] ?? 0

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...style,
        borderColor: selected ? "var(--main)" : "var(--chrome-border)",
      }}
      className={cn(
        "flex flex-col gap-0.5 overflow-hidden rounded-md border bg-secondary-background px-2 py-1 text-left",
        selected ? "ring-1 ring-main/50" : "",
      )}
    >
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "shrink-0 rounded px-1 text-[8px] font-medium uppercase tracking-wide",
            billable ? "bg-chart-3/20 text-chart-3" : "bg-foreground/10 text-chrome-text/70",
          )}
        >
          {kind || "endpoint"}
        </span>
        <span className="truncate font-mono text-[9px] text-foreground">{endpoint.Name}</span>
      </div>
      <div className="text-[9px] tabular-nums text-chrome-text">
        {fmtNum(endpoint.Calls ?? 0)} calls
        {tokIn || tokOut ? ` · ${fmtNum(tokIn)}→${fmtNum(tokOut)} tok` : ""}
      </div>
      <div className="mt-auto text-[9px] font-medium tabular-nums">
        {billable ? (
          <span className="text-chart-3">{fmtUSD(cost)} billable</span>
        ) : (
          <span className="text-chrome-text/60">local · $0</span>
        )}
      </div>
    </button>
  )
}

function NodeDetail({
  selected,
  onClose,
}: {
  selected: Selected
  onClose: () => void
}) {
  const skip = selected.kind === "plan" ? "Plans" : selected.kind === "callsite" ? "Endpoints" : ""
  const title =
    selected.kind === "plan"
      ? (selected.raw["Node Type"] as string)
      : selected.kind === "callsite"
        ? `rvbbit.${selected.raw.Operator}`
        : `${selected.raw.Kind} · ${selected.raw.Name}`
  const entries = Object.entries(selected.raw)
    .filter(([k]) => k !== skip)
    .sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="max-h-52 shrink-0 overflow-auto border-t border-chrome-border bg-chrome-bg/40">
      <div className="sticky top-0 flex items-center gap-2 border-b border-chrome-border/60 bg-chrome-bg/95 px-3 py-1.5">
        <span className="text-[12px] font-semibold text-foreground">{title}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1.5 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
        >
          close
        </button>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-[11px]">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-chrome-text/60">{k}</dt>
            <dd className="break-words font-mono text-chrome-text">{fmtValue(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────

function posStyle(left: number, top: number): React.CSSProperties {
  return { position: "absolute", left, top, width: NODE_W, height: NODE_H }
}

/** Vertical-flow cubic edge (parent above child). */
function vEdge(sx: number, sy: number, ex: number, ey: number): string {
  const my = (sy + ey) / 2
  return `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`
}

/** Horizontal-flow cubic edge (left node to right node). */
function hEdge(sx: number, sy: number, ex: number, ey: number): string {
  const mx = (sx + ex) / 2
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`
}

function estimateRatio(planRows: number, actualRows: number): number {
  const a = Math.max(1, planRows)
  const b = Math.max(1, actualRows)
  return Math.max(a, b) / Math.min(a, b)
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  if (abs >= 100 || Number.isInteger(n)) return String(Math.round(n))
  return n.toFixed(1)
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${ms.toFixed(ms < 1 ? 2 : 1)} ms`
}

function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function fmtValue(v: unknown): string {
  if (v == null) return "—"
  if (Array.isArray(v)) return v.map((x) => fmtValue(x)).join(", ")
  if (typeof v === "object") return JSON.stringify(v)
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3)
  return String(v)
}
