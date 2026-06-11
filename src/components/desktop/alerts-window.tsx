"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Activity, Bell, Play, RefreshCw, X, Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { useWorkspaceActive } from "./workspace-active-context"
import { SqlEditor } from "./sql-editor"
import { Combobox } from "./combobox"
import { categoriesFrom, fetchCategoryOptions, setCategory, subcategoriesFor, type CategoryPair } from "@/lib/rvbbit/categories"
import { fetchAllToolsLite, schemaType, type McpToolLite } from "@/lib/rvbbit/mcp"
import { listMetrics, type MetricSummary } from "@/lib/rvbbit/metrics"
import { fetchOperators, type RvbbitOperator } from "@/lib/rvbbit/operators"
import {
  commitThreshold,
  createAlert,
  deleteRule,
  fetchAlertEvents,
  fetchAlertRules,
  fetchAlertState,
  fetchAlertSweepRuns,
  fetchExprColumns,
  muteRule,
  previewCondition,
  previewExprCondition,
  previewMetricObservation,
  runSweep,
  runWorker,
  setAlertsEnabled,
  setRuleEnabled,
  unmuteRule,
  type AlertDraft,
  type AlertEntity,
  type AlertEvent,
  type AlertRule,
  type AlertSweepRun,
  type MetricObsPreview,
  type PreviewRow,
} from "@/lib/rvbbit/alerts"
import type { AlertsPayload } from "@/lib/desktop/types"
import { usePolling } from "@/lib/desktop/use-polling"

interface AlertsWindowProps {
  payload: AlertsPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onChangePayload: (mut: (p: AlertsPayload) => AlertsPayload) => void
  // open a live, auto-running SQL data window (used by the per-rule "history ↗")
  onOpenSqlData?: (sql: string, title: string) => void
}

// The firing + action audit trail for one rule, as an editable/runnable query.
function alertHistorySql(ruleName: string): string {
  const safe = ruleName.replace(/'/g, "''")
  return `-- firing + action history for ${ruleName}
SELECT ts, entity_key, transition, status, error,
       action_output, action_receipt_id
FROM rvbbit.alert_events
WHERE rule_name = '${safe}'
ORDER BY ts DESC
LIMIT 200;`
}

// ── small helpers ─────────────────────────────────────────────────────────────

function fmtAgo(ms: number | null): string {
  if (ms == null) return "—"
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Episode-state color: pass=calm, fail(armed)=amber, fired=red, muted=grey. */
function statusColor(status: string | null): string {
  switch (status) {
    case "fail":
      return "var(--danger)"
    case "pass":
      return "var(--success)"
    default:
      return "var(--chrome-text)"
  }
}

function numFmt(n: number | null): string {
  if (n == null) return "—"
  return Math.abs(n) >= 1000 || (n !== 0 && Math.abs(n) < 0.01)
    ? n.toPrecision(3)
    : String(Math.round(n * 1000) / 1000)
}

// ── threshold explorer (the showpiece: drag to preview breaches) ──────────────

function ThresholdExplorer({
  rule,
  entities,
  now,
  onCommit,
}: {
  rule: AlertRule
  entities: AlertEntity[]
  now: number
  onCommit: (threshold: number) => void
}) {
  const compare = String(rule.conditionSpec.compare ?? "gte")
  const ruleThresh = Number(rule.conditionSpec.threshold ?? 0)
  const scored = entities.filter((e) => e.score != null) as (AlertEntity & { score: number })[]
  const [drag, setDrag] = useState(ruleThresh)
  const svgRef = useRef<SVGSVGElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(640)
  // Drive the viewBox width from the measured container so the plot fills any
  // window width 1:1 (no aspect-ratio cap from a fixed viewBox).
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setBoxW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W = Math.max(boxW, 240)
  const H = 132
  const PADX = 28
  const AXIS_Y = 92

  const { dMin, dMax } = useMemo(() => {
    const vals = [ruleThresh, drag, ...scored.map((e) => e.score)]
    let lo = Math.min(...vals)
    let hi = Math.max(...vals)
    if (hi - lo < 1e-9) {
      lo -= 0.5
      hi += 0.5
    }
    const pad = (hi - lo) * 0.12
    return { dMin: lo - pad, dMax: hi + pad }
  }, [scored, ruleThresh, drag])

  // Plain closures (recomputed each render) so a width/domain change can't leave
  // a stale W captured in a memoized callback.
  const xOf = (v: number) => PADX + ((v - dMin) / (dMax - dMin)) * (W - 2 * PADX)
  const breaches = (s: number) => (compare === "lte" ? s <= drag : s >= drag)
  const nBreach = scored.filter((e) => breaches(e.score)).length

  const xToVal = (clientX: number) => {
    const el = svgRef.current
    if (!el) return drag
    const r = el.getBoundingClientRect()
    const vx = ((clientX - r.left) / r.width) * W
    const v = dMin + ((vx - PADX) / (W - 2 * PADX)) * (dMax - dMin)
    return Math.min(dMax, Math.max(dMin, v))
  }

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(xToVal(e.clientX))
  }
  const onMove = (e: React.PointerEvent) => {
    if (e.buttons === 0) return
    setDrag(xToVal(e.clientX))
  }

  const dirty = Math.abs(drag - ruleThresh) > 1e-9
  const tx = xOf(drag)

  return (
    <div ref={boxRef} className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="font-medium text-foreground">
          Threshold explorer · <span className="text-chrome-text/70">score {compare === "lte" ? "≤" : "≥"} t</span>
        </span>
        <span className="tabular-nums text-chrome-text/70">
          <span className="font-medium" style={{ color: nBreach > 0 ? statusColor("fail") : statusColor("pass") }}>
            {nBreach}
          </span>{" "}
          / {scored.length} breaching · t = <span className="font-medium text-foreground">{numFmt(drag)}</span>
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        style={{ height: H }}
        onPointerMove={onMove}
      >
        {/* breach shading */}
        <rect
          x={compare === "lte" ? PADX : tx}
          y={10}
          width={Math.max(0, compare === "lte" ? tx - PADX : W - PADX - tx)}
          height={AXIS_Y - 10}
          fill="color-mix(in oklch, var(--danger) 12%, transparent)"
        />
        {/* axis */}
        <line x1={PADX} y1={AXIS_Y} x2={W - PADX} y2={AXIS_Y} stroke="var(--chrome-border, #444)" strokeWidth={1} />
        {/* entity dots */}
        {scored.map((e, i) => {
          const x = xOf(e.score)
          const br = breaches(e.score)
          const y = AXIS_Y - 12 - (i % 4) * 14
          // entities the most recent sweep just transitioned pulse for a few seconds
          const recent = e.changedMs != null && now - e.changedMs < 6000
          return (
            <g key={e.entityKey || i}>
              {recent ? (
                <circle
                  cx={x}
                  cy={y}
                  r={9}
                  fill="none"
                  stroke={statusColor(br ? "fail" : "pass")}
                  strokeWidth={1.5}
                  className="alerts-just-changed"
                  style={{ transition: "cx 0.5s ease" }}
                />
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={5}
                fill={br ? statusColor("fail") : statusColor("pass")}
                opacity={br ? 1 : 0.55}
                style={{ transition: "cx 0.5s ease, fill 0.4s, opacity 0.4s" }}
              />
              <text x={x} y={y - 8} textAnchor="middle" className="fill-chrome-text/70" style={{ fontSize: 8, transition: "x 0.5s ease" }}>
                {e.entityKey || "·"}
              </text>
            </g>
          )
        })}
        {/* draggable threshold */}
        <g style={{ cursor: "ew-resize" }} onPointerDown={onDown}>
          <line x1={tx} y1={6} x2={tx} y2={AXIS_Y + 6} stroke="var(--danger)" strokeWidth={2} />
          <rect x={tx - 16} y={AXIS_Y + 8} width={32} height={16} rx={3} fill="var(--danger)" opacity={0.9} />
          <text x={tx} y={AXIS_Y + 19} textAnchor="middle" className="fill-white" style={{ fontSize: 9 }}>
            {numFmt(drag)}
          </text>
        </g>
        {/* invisible wide hit-target for the handle */}
        <rect x={tx - 10} y={0} width={20} height={H} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={onDown} />
      </svg>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[10px] text-chrome-text/50">drag the line to preview — entities cross live</span>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => onCommit(Math.round(drag * 1e6) / 1e6)}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px] transition-colors",
            dirty
              ? "border-rvbbit-accent/50 bg-rvbbit-accent/15 text-rvbbit-accent hover:bg-rvbbit-accent/25"
              : "border-chrome-border text-chrome-text/40",
          )}
        >
          Set threshold → {numFmt(drag)}
        </button>
      </div>
    </div>
  )
}

// ── episode timeline (per-entity firing history + current episode over time) ──

function EpisodeTimeline({
  entities,
  events,
  sweeps,
  now,
}: {
  entities: AlertEntity[]
  events: AlertEvent[]
  sweeps: AlertSweepRun[]
  now: number
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(640)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 0) setBoxW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W = Math.max(boxW, 240)
  const PADL = 76
  const PADR = 12
  const ROW_H = 18

  const evByEntity = useMemo(() => {
    const m = new Map<string, AlertEvent[]>()
    for (const e of events) {
      const k = e.entityKey || ""
      const a = m.get(k) ?? []
      a.push(e)
      m.set(k, a)
    }
    return m
  }, [events])

  // lanes: most-active entities first (most fires, then currently-failing)
  const lanes = useMemo(
    () =>
      [...entities].sort((a, b) => {
        const af = evByEntity.get(a.entityKey)?.length ?? 0
        const bf = evByEntity.get(b.entityKey)?.length ?? 0
        if (af !== bf) return bf - af
        const ar = a.lastStatus === "fail" ? 0 : 1
        const br = b.lastStatus === "fail" ? 0 : 1
        return ar - br
      }),
    [entities, evByEntity],
  )

  const tsList = [
    ...events.map((e) => e.tsMs),
    ...entities.map((e) => e.changedMs),
    ...sweeps.map((s) => s.startedMs),
  ].filter((t): t is number => t != null)
  const t0 = tsList.length ? Math.min(...tsList) : now - 3_600_000
  const span = Math.max(now - t0, 60_000)
  const xOf = (ms: number) => PADL + ((ms - t0) / span) * (W - PADL - PADR)
  const H = 30 + Math.max(1, lanes.length) * ROW_H

  return (
    <div ref={boxRef} className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium text-foreground">Episode timeline</span>
        <span className="text-[10px] text-chrome-text/50">{fmtAgo(t0)} → now · ● fire · ▬ current episode · ┊ sweeps</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {/* sweep ticks */}
        {sweeps.map((s) =>
          s.startedMs != null ? (
            <line key={s.sweepId} x1={xOf(s.startedMs)} y1={18} x2={xOf(s.startedMs)} y2={H - 4} stroke="var(--chrome-border, #444)" strokeWidth={1} opacity={0.22} />
          ) : null,
        )}
        {/* now line */}
        <line x1={xOf(now)} y1={14} x2={xOf(now)} y2={H - 4} stroke="var(--rvbbit-accent)" strokeWidth={1} opacity={0.5} strokeDasharray="2 2" />
        {/* lanes */}
        {lanes.map((e, i) => {
          const y = 30 + i * ROW_H
          const evs = evByEntity.get(e.entityKey) ?? []
          const segStart = e.changedMs != null ? xOf(e.changedMs) : xOf(now)
          const segColor = statusColor(e.lastStatus)
          return (
            <g key={e.entityKey || i}>
              <text x={4} y={y + 3} className="fill-chrome-text/75 font-mono" style={{ fontSize: 9 }}>
                {(e.entityKey || "(scalar)").slice(0, 11)}
              </text>
              <line x1={PADL} y1={y} x2={W - PADR} y2={y} stroke="var(--chrome-border, #444)" strokeWidth={1} opacity={0.18} />
              {/* current-episode trailing segment (changed → now) */}
              <rect
                x={segStart}
                y={y - 3}
                width={Math.max(2, xOf(now) - segStart)}
                height={6}
                rx={2}
                fill={segColor}
                opacity={e.lastStatus === "fail" ? 0.5 : 0.28}
              />
              {/* fire markers */}
              {evs.map((ev, j) =>
                ev.tsMs != null ? (
                  <circle key={j} cx={xOf(ev.tsMs)} cy={y} r={4} fill={ev.status === "fired" ? "var(--danger)" : "var(--warning)"}>
                    <title>{`${ev.transition} · ${ev.status} · ${fmtAgo(ev.tsMs)}`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          )
        })}
        {lanes.length === 0 ? (
          <text x={PADL} y={30} className="fill-chrome-text/45" style={{ fontSize: 11 }}>
            no entities yet — run a sweep
          </text>
        ) : null}
      </svg>
    </div>
  )
}

// ── sweep heartbeat strip ─────────────────────────────────────────────────────

function SweepHeartbeat({ sweeps }: { sweeps: AlertSweepRun[] }) {
  const ordered = [...sweeps].reverse() // oldest → newest
  const maxTx = Math.max(1, ...ordered.map((s) => s.transitions))
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <Activity className="h-3.5 w-3.5 text-rvbbit-accent" /> Sweep heartbeat
        <span className="ml-auto text-[10px] font-normal text-chrome-text/50">{sweeps.length} ticks · transitions ↑</span>
      </div>
      <div className="flex h-12 items-end gap-0.5">
        {ordered.map((s) => {
          const h = 6 + (s.transitions / maxTx) * 38
          return (
            <div
              key={s.sweepId}
              title={`#${s.sweepId} ${s.tier} · ${s.rulesEvaluated} rules · ${s.transitions} transitions · ${s.enqueued} enqueued${s.errors ? ` · ${s.errors} err` : ""}`}
              className="min-w-[3px] flex-1 rounded-t transition-all"
              style={{
                height: h,
                background:
                  s.errors > 0
                    ? "var(--danger)"
                    : s.transitions > 0
                      ? "var(--warning)"
                      : "color-mix(in oklch, var(--rvbbit-accent) 45%, transparent)",
              }}
            />
          )
        })}
        {ordered.length === 0 ? <span className="text-[11px] text-chrome-text/40">no sweeps yet</span> : null}
      </div>
    </div>
  )
}

// ── event log ─────────────────────────────────────────────────────────────────

function EventLog({
  events,
  showRule = false,
  title = "Firing log",
  maxHClass = "max-h-44",
  onPickRule,
}: {
  events: AlertEvent[]
  /** Render the originating rule name (for the global cross-rule log). */
  showRule?: boolean
  title?: string
  maxHClass?: string
  onPickRule?: (rule: string) => void
}) {
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40">
      <div className="flex items-center border-b border-chrome-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground">
        {title}
        <span className="ml-auto text-[10px] font-normal text-chrome-text/45">{events.length}</span>
      </div>
      <div className={cn(maxHClass, "overflow-auto")}>
        {events.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-chrome-text/45">no fires yet</div>
        ) : (
          <ul className="divide-y divide-chrome-border/30">
            {events.map((e, i) => (
              <li key={i} className="flex items-center gap-2 px-3 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: e.status === "fired" ? statusColor("fail") : "var(--danger)" }}
                />
                {showRule ? (
                  <button
                    type="button"
                    onClick={onPickRule ? () => onPickRule(e.ruleName) : undefined}
                    className={cn(
                      "w-28 shrink-0 truncate text-left font-medium text-foreground",
                      onPickRule && "hover:text-rvbbit-accent",
                    )}
                    title={e.ruleName}
                  >
                    {e.ruleName}
                  </button>
                ) : null}
                <span className="w-20 shrink-0 truncate font-mono text-chrome-text/80">{e.entityKey || "·"}</span>
                <span className="shrink-0 text-chrome-text/55">{e.transition}</span>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ color: e.status === "fired" ? "var(--success)" : "var(--danger)" }}
                >
                  {e.status}
                  {e.error ? ` — ${e.error}` : ""}
                </span>
                <span className="shrink-0 tabular-nums text-chrome-text/45">{fmtAgo(e.tsMs)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── entity state grid ─────────────────────────────────────────────────────────

function EntityState({ entities, now }: { entities: AlertEntity[]; now: number }) {
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40">
      <div className="border-b border-chrome-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground">
        Entities · {entities.length}
      </div>
      <div className="max-h-44 overflow-auto p-2">
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {entities.map((e) => {
            const recent = e.changedMs != null && now - e.changedMs < 6000
            return (
            <div
              key={e.entityKey}
              className={cn("flex items-center gap-2 rounded border px-2 py-1 text-[11px]", recent && "alerts-just-changed")}
              style={{ borderColor: "color-mix(in oklch, " + statusColor(e.lastStatus) + " 40%, transparent)" }}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(e.lastStatus) }} />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{e.entityKey || "(scalar)"}</span>
              {e.score != null ? <span className="tabular-nums text-chrome-text/70">{numFmt(e.score)}</span> : null}
              {e.lastStatus === "fail" && e.consecutive > 1 ? (
                <span
                  className="rounded px-1 text-[9px] tabular-nums"
                  style={{ background: "color-mix(in oklch, var(--warning) 25%, transparent)", color: "var(--warning)" }}
                  title="consecutive fails"
                >
                  ×{e.consecutive}
                </span>
              ) : null}
              {e.firedMs != null ? (
                <span className="shrink-0 text-[9px] text-chrome-text/45" title="last fired">{fmtAgo(e.firedMs)}</span>
              ) : null}
            </div>
            )
          })}
          {entities.length === 0 ? (
            <div className="col-span-full px-1 py-3 text-center text-[11px] text-chrome-text/45">
              no state yet — run a sweep
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── rule editor (author a rule; live-previews the condition as you write) ─────

const inputCls =
  "w-full rounded border border-chrome-border bg-block-bg/60 px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-rvbbit-accent/50"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">{label}</span>
      {children}
    </label>
  )
}

function RuleEditor({
  connectionId,
  initial,
  onSaved,
  onCancel,
  onDeleted,
}: {
  connectionId: string
  initial: AlertRule | null
  onSaved: (name: string) => void
  onCancel: () => void
  onDeleted: () => void
}) {
  const editing = initial != null
  const cs = initial?.conditionSpec ?? {}
  const fp = initial?.firePolicy ?? {}
  const as = initial?.actionSpec ?? {}
  const opInit = ((): "noop" | "sql" | "operator" | "mcp_call" | "flow" => {
    const o = String(as.operator ?? "noop")
    return o === "sql" || o === "mcp_call" || o === "flow" || o === "operator" ? o : "noop"
  })()
  const cadInit = (["fast", "normal", "slow"] as const).includes(initial?.cadenceTier as "fast")
    ? (initial!.cadenceTier as "fast" | "normal" | "slow")
    : "normal"

  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [category, setCat] = useState(initial?.category ?? "")
  const [subcategory, setSub] = useState(initial?.subcategory ?? "")
  const [catPairs, setCatPairs] = useState<CategoryPair[]>([])
  // how a sql condition decides fail/pass: 'scored' (threshold/compare on a score
  // column), 'status' (the query returns a status), or 'expr' (a boolean SQL
  // expression over the query's columns).
  const condShapeInit: "scored" | "status" | "expr" =
    typeof cs.expr === "string" && cs.expr !== "" ? "expr" : initial ? (cs.threshold != null ? "scored" : "status") : "scored"
  const [condShape, setCondShape] = useState<"scored" | "status" | "expr">(condShapeInit)
  const scored = condShape === "scored"
  // default references `score` — the default query's output column (it aliases
  // drop_pct AS score), since the expr sees the query's OUTPUT columns.
  const [expr, setExpr] = useState(typeof cs.expr === "string" ? cs.expr : "score >= 0.15")
  const [exprColumns, setExprColumns] = useState<string[]>([])
  const [query, setQuery] = useState(typeof cs.query === "string" ? cs.query : "SELECT region AS entity_key, drop_pct AS score FROM my_table")
  const [threshold, setThreshold] = useState(cs.threshold != null ? String(cs.threshold) : "0.15")
  const [compare, setCompare] = useState<"gte" | "lte">(cs.compare === "lte" ? "lte" : "gte")
  const [consecutiveN, setConsecutiveN] = useState(fp.consecutive_n != null ? String(fp.consecutive_n) : "1")
  const [cooldownSecs, setCooldownSecs] = useState(fp.cooldown_secs != null ? String(fp.cooldown_secs) : "0")
  const [operator, setOperator] = useState<"noop" | "sql" | "operator" | "mcp_call" | "flow">(opInit)
  const [actionSql, setActionSql] = useState(typeof as.sql === "string" ? as.sql : "INSERT INTO incidents(rule, entity, ts)\n  VALUES ($1->>'rule', $1->>'entity', now())")
  const [server, setServer] = useState(typeof as.server === "string" ? as.server : "linear")
  const [tool, setTool] = useState(typeof as.tool === "string" ? as.tool : "create_issue")
  const [argsJson, setArgsJson] = useState(as.args != null ? JSON.stringify(as.args, null, 2) : '{\n  "title": "{rule}: {entity} breached",\n  "description": "transition {transition}"\n}')
  const [spec, setSpec] = useState(typeof as.spec === "string" ? as.spec : "")
  const [cadence, setCadence] = useState<"fast" | "normal" | "slow">(cadInit)
  const [fanOutCap, setFanOutCap] = useState(initial ? String(initial.fanOutCap) : "100")
  const [preview, setPreview] = useState<PreviewRow[]>([])
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [mcpTools, setMcpTools] = useState<McpToolLite[]>([])
  // condition: 'sql' (free-form) or 'metric' (ride a KPI's verdict)
  const [condMode, setCondMode] = useState<"sql" | "metric">(cs.kind === "metric" ? "metric" : "sql")
  const [metricName, setMetricName] = useState(typeof cs.metric === "string" ? cs.metric : "")
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [metricObs, setMetricObs] = useState<MetricObsPreview | null>(null)
  // operator action: pick a catalogued operator + fill its typed args
  const [operatorName, setOperatorName] = useState(typeof as.operator_name === "string" ? as.operator_name : "")
  const [operators, setOperators] = useState<RvbbitOperator[]>([])

  // load the MCP tool catalog once the user picks the mcp_call action, so we can
  // offer server/tool completion + show the selected tool's docstring + args.
  // Re-fetches when the active connection changes (the catalog is per-connection);
  // the `cancelled` flag drops stale responses.
  useEffect(() => {
    if (operator !== "mcp_call") return
    let cancelled = false
    void (async () => {
      const r = await fetchAllToolsLite(connectionId)
      if (!cancelled) setMcpTools(r.rows)
    })()
    return () => {
      cancelled = true
    }
  }, [operator, connectionId])

  // metric catalog when the condition is metric-referenced (re-fetch per connection)
  useEffect(() => {
    if (condMode !== "metric") return
    let cancelled = false
    void (async () => {
      const r = await listMetrics(connectionId)
      if (!cancelled) setMetrics(r.metrics)
    })()
    return () => {
      cancelled = true
    }
  }, [condMode, connectionId])

  // the picked metric's latest observation = what the alert would read right now
  useEffect(() => {
    if (condMode !== "metric") return
    let cancelled = false
    void (async () => {
      if (!metricName.trim()) {
        if (!cancelled) setMetricObs(null)
        return
      }
      const r = await previewMetricObservation(connectionId, metricName)
      if (!cancelled) setMetricObs(r.obs)
    })()
    return () => {
      cancelled = true
    }
  }, [condMode, metricName, connectionId])

  // operator catalog when the action is operator-typed (re-fetch per connection)
  useEffect(() => {
    if (operator !== "operator") return
    let cancelled = false
    void (async () => {
      const r = await fetchOperators(connectionId)
      if (!cancelled) setOperators(r.operators)
    })()
    return () => {
      cancelled = true
    }
  }, [operator, connectionId])

  // the in-use category tree (shared metric+alert taxonomy) for the pickers
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const r = await fetchCategoryOptions(connectionId)
      if (!cancelled) setCatPairs(r.pairs)
    })()
    return () => {
      cancelled = true
    }
  }, [connectionId])

  // debounced live preview of the condition query (all setState in the async
  // callback so nothing runs synchronously in the effect body)
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      if (!query.trim()) {
        setPreview([])
        setPreviewErr(null)
        return
      }
      if (condShape === "expr") {
        // columns from the bare query (so the available names show even when the
        // expr itself is invalid), plus the wrapped expr preview for breaches
        const [cols, r] = await Promise.all([
          fetchExprColumns(connectionId, query),
          previewExprCondition(connectionId, query, expr),
        ])
        if (cancelled) return
        setExprColumns(cols.columns)
        setPreview(r.rows)
        setPreviewErr(r.error)
      } else {
        const r = await previewCondition(connectionId, query)
        if (cancelled) return
        setPreview(r.rows)
        setPreviewErr(r.error)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, expr, condShape, connectionId])

  const thr = Number(threshold)
  const breaches = (row: PreviewRow) =>
    condShape === "scored"
      ? row.score != null && (compare === "lte" ? row.score <= thr : row.score >= thr)
      : row.status === "fail" // 'status' + 'expr' both surface a status of 'fail'
  const nBreach = preview.filter(breaches).length

  const argsValid = useMemo(() => {
    if (operator !== "mcp_call" && operator !== "operator") return true
    try {
      JSON.parse(argsJson)
      return true
    } catch {
      return false
    }
  }, [operator, argsJson])

  const selectedMetric = useMemo(() => metrics.find((m) => m.name === metricName) ?? null, [metrics, metricName])
  const selectedOperator = useMemo(() => operators.find((o) => o.name === operatorName) ?? null, [operators, operatorName])
  // (name, type) per positional arg of the picked operator
  const operatorArgs = useMemo(() => {
    if (!selectedOperator) return [] as { name: string; type: string }[]
    return selectedOperator.arg_names.map((n, i) => ({ name: n, type: selectedOperator.arg_types[i] ?? "text" }))
  }, [selectedOperator])
  const fillOperatorTemplate = () => {
    if (!selectedOperator) return
    const skel: Record<string, unknown> = {}
    for (const n of selectedOperator.arg_names) skel[n] = ""
    setArgsJson(JSON.stringify(skel, null, 2))
  }

  const mcpServers = useMemo(() => [...new Set(mcpTools.map((t) => t.server))].sort(), [mcpTools])
  const toolsForServer = useMemo(() => mcpTools.filter((t) => t.server === server), [mcpTools, server])
  const selectedTool = useMemo(
    () => mcpTools.find((t) => t.server === server && t.name === tool) ?? null,
    [mcpTools, server, tool],
  )
  // (name, type, required, description) for each documented argument of the picked tool
  const argSpecs = useMemo(() => {
    const props = selectedTool?.inputSchema?.properties
    if (!props) return [] as { name: string; type: string; required: boolean; description: string | null }[]
    const req = new Set(selectedTool?.inputSchema?.required ?? [])
    return Object.entries(props).map(([n, p]) => ({
      name: n,
      type: schemaType(p),
      required: req.has(n),
      description: p.description ?? null,
    }))
  }, [selectedTool])

  // seed the args template with a skeleton of the tool's required keys
  const fillArgsTemplate = () => {
    const props = selectedTool?.inputSchema?.properties
    if (!props) return
    const keys = selectedTool?.inputSchema?.required ?? Object.keys(props)
    const skel: Record<string, unknown> = {}
    for (const k of keys) {
      const t = schemaType(props[k])
      skel[k] = t === "number" || t === "integer" ? 0 : t === "boolean" ? false : ""
    }
    setArgsJson(JSON.stringify(skel, null, 2))
  }

  const buildDraft = (): AlertDraft => {
    let condition: Record<string, unknown>
    if (condMode === "metric") {
      condition = { kind: "metric", metric: metricName.trim() }
    } else {
      condition = { kind: "sql", query: query.trim() }
      if (condShape === "scored") {
        condition.threshold = Number(threshold)
        condition.compare = compare
      } else if (condShape === "expr") {
        condition.expr = expr.trim()
      }
    }
    const action: Record<string, unknown> = { operator }
    if (operator === "sql") action.sql = actionSql
    else if (operator === "operator") {
      action.operator_name = operatorName.trim()
      try {
        action.args = JSON.parse(argsJson)
      } catch {
        action.args = {}
      }
    } else if (operator === "mcp_call") {
      action.server = server
      action.tool = tool
      try {
        action.args = JSON.parse(argsJson)
      } catch {
        action.args = {}
      }
    } else if (operator === "flow") action.spec = spec
    return {
      name: name.trim(),
      description,
      conditionSpec: condition,
      firePolicy: {
        consecutive_n: Math.max(1, Number(consecutiveN) || 1),
        cooldown_secs: Math.max(0, Number(cooldownSecs) || 0),
      },
      actionSpec: action,
      cardinality: "per_entity",
      fanOutCap: Number(fanOutCap) || 100,
      cadenceTier: cadence,
    }
  }

  const conditionReady =
    condMode === "metric"
      ? metricName.trim().length > 0
      : query.trim().length > 0 && (condShape !== "expr" || expr.trim().length > 0)
  const operatorReady = operator !== "operator" || operatorName.trim().length > 0
  const canSave = name.trim().length > 0 && conditionReady && operatorReady && argsValid && !saving
  const save = async () => {
    setSaving(true)
    const err = await createAlert(connectionId, buildDraft())
    // category lives apart from the versioned def; set it after the rule exists
    const catErr = err ? null : await setCategory(connectionId, "alert", name.trim(), category, subcategory)
    setSaving(false)
    if (err) {
      setSaveErr(err)
      return
    }
    if (catErr) {
      // the rule saved; only the category step failed — surface it, stay open
      setSaveErr(`Rule saved, but the category wasn't applied: ${catErr}`)
      return
    }
    onSaved(name.trim())
  }

  const doDelete = async () => {
    if (!editing) return
    setDeleting(true)
    const err = await deleteRule(connectionId, initial!.name)
    setDeleting(false)
    if (err) {
      setSaveErr(err)
      return
    }
    onDeleted()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-foreground">{editing ? `Edit ${initial!.name}` : "New alert"}</span>
        {editing ? (
          <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] text-chrome-text/55">saves a new version</span>
        ) : null}
        {editing ? (
          confirmDel ? (
            <span className="flex items-center gap-1 text-[10px]">
              <button type="button" disabled={deleting} onClick={() => void doDelete()} className="rounded border border-danger/50 bg-danger/15 px-1.5 py-0.5 text-danger hover:bg-danger/25">
                {deleting ? "deleting…" : "confirm delete"}
              </button>
              <button type="button" onClick={() => setConfirmDel(false)} className="text-chrome-text/50 hover:text-chrome-text">
                keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded border border-danger/30 px-1.5 py-0.5 text-[10px] text-danger/80 hover:bg-danger/10">
              delete
            </button>
          )
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onCancel} className="rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.06]">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void save()}
            className={cn(
              "rounded border px-2.5 py-0.5 text-[11px] transition-colors",
              canSave ? "border-rvbbit-accent/50 bg-rvbbit-accent/15 text-rvbbit-accent hover:bg-rvbbit-accent/25" : "border-chrome-border text-chrome-text/40",
            )}
          >
            {saving ? "Saving…" : editing ? "Save new version" : "Create alert"}
          </button>
        </div>
      </div>
      {saveErr ? <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">{saveErr}</div> : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="name">
          <input value={name} onChange={(e) => setName(e.target.value)} readOnly={editing} placeholder="revenue_drop" spellCheck={false} className={cn(inputCls, editing && "cursor-not-allowed opacity-60")} />
        </Field>
        <Field label="description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="what this watches" className={inputCls} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="category">
          <Combobox
            value={category}
            onChange={(c) => {
              setCat(c)
              setSub("")
            }}
            options={categoriesFrom(catPairs).map((c) => ({ value: c }))}
            placeholder="— none —"
            searchPlaceholder="search or add…"
            allowCustom
          />
        </Field>
        <Field label="subcategory">
          <Combobox
            value={subcategory}
            onChange={setSub}
            options={subcategoriesFor(catPairs, category).map((s) => ({ value: s }))}
            placeholder={category ? "— none —" : "set a category first"}
            searchPlaceholder="search or add…"
            allowCustom
            disabled={!category}
          />
        </Field>
      </div>

      {/* condition + live preview */}
      <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-2.5">
        <div className="mb-1 flex items-center gap-2 text-[11px]">
          <span className="font-medium text-foreground">Condition</span>
          <div className="flex items-center overflow-hidden rounded border border-chrome-border text-[10px]">
            {(["sql", "metric"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setCondMode(m)} className={cn("px-1.5 py-0.5 font-mono", condMode === m ? "bg-rvbbit-accent/20 text-foreground" : "text-chrome-text/60")}>
                {m}
              </button>
            ))}
          </div>
          {condMode === "sql" ? (
            <div className="flex items-center overflow-hidden rounded border border-chrome-border text-[10px]">
              {(["scored", "status", "expr"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setCondShape(m)}
                  className={cn("px-1.5 py-0.5", condShape === m ? "bg-rvbbit-accent/20 text-foreground" : "text-chrome-text/60")}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}
          <span className="ml-auto text-[10px] text-chrome-text/50">
            {condMode !== "sql" ? (
              "fires when the metric's KPI check fails"
            ) : condShape === "expr" ? (
              "fails the rows where the expression is true"
            ) : (
              <>
                returns <span className="font-mono">entity_key</span> + <span className="font-mono">{condShape === "scored" ? "score" : "status"}</span>
              </>
            )}
          </span>
        </div>
        {condMode === "metric" ? (
          <div className="flex flex-col gap-2">
            <Field label="metric (KPI)">
              <Combobox
                value={metricName}
                onChange={setMetricName}
                options={metrics.map((m) => ({ value: m.name, hint: m.checkSql ? undefined : "no check" }))}
                placeholder="— pick a metric —"
                searchPlaceholder="search metrics…"
                emptyText="no metrics defined"
              />
            </Field>
            {selectedMetric ? (
              <div className="rounded border border-chrome-border/60 bg-block-bg/40 p-2 text-[10px]">
                {selectedMetric.description ? <div className="mb-1 text-chrome-text/70">{selectedMetric.description}</div> : null}
                {!selectedMetric.checkSql ? (
                  <div className="mb-1 text-warning/80">⚠ this metric has no KPI check — add a check_sql so the alert has a pass/fail verdict to ride.</div>
                ) : null}
                {metricObs ? (
                  <div className="flex items-center gap-2">
                    <span className="text-chrome-text/55">latest verdict</span>
                    <span
                      className="rounded px-1.5 py-0.5 font-medium uppercase"
                      style={{
                        background: "color-mix(in oklch, " + statusColor(metricObs.status === "fail" ? "fail" : "pass") + " 18%, transparent)",
                        color: metricObs.status === "fail" ? "var(--danger)" : "var(--success)",
                      }}
                    >
                      {metricObs.status ?? "—"}
                    </span>
                    <span className="ml-auto text-chrome-text/45">as of {metricObs.dataAsOf ? metricObs.dataAsOf.slice(0, 19) : "—"}</span>
                  </div>
                ) : (
                  <div className="text-chrome-text/40">no materialized observation yet — materialize the metric so the alert has something to read.</div>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="h-36 overflow-hidden rounded border border-chrome-border/60">
              <SqlEditor value={query} onChange={setQuery} height="100%" />
            </div>
            {scored ? (
              <div className="mt-1.5 flex items-center gap-2">
            <Field label="compare">
              <div className="flex items-center overflow-hidden rounded border border-chrome-border text-[10px]">
                {(["lte", "gte"] as const).map((c) => (
                  <button key={c} type="button" onClick={() => setCompare(c)} className={cn("px-1.5 py-0.5", compare === c ? "bg-rvbbit-accent/20 text-foreground" : "text-chrome-text/60")}>
                    {c === "gte" ? "≥" : "≤"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="threshold">
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} className={cn(inputCls, "w-24 tabular-nums")} />
            </Field>
          </div>
        ) : null}
            {condShape === "expr" ? (
              <div className="mt-1.5">
                <Field label="fail when — a SQL boolean over the query's output columns">
                  <div className={cn("overflow-hidden rounded border", previewErr ? "border-danger/50" : "border-chrome-border/60")}>
                    <SqlEditor language="sql" compact value={expr} onChange={setExpr} height="30px" />
                  </div>
                </Field>
                {exprColumns.length > 0 ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-chrome-text/50">
                    <span>columns:</span>
                    {exprColumns.map((c) => (
                      <span key={c} className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-chrome-text/70">
                        {c}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
        {/* live preview */}
        <div className="mt-2 rounded border border-chrome-border/60 bg-block-bg/40 p-1.5">
          <div className="mb-1 flex items-center justify-between text-[10px]">
            <span className="text-chrome-text/60">live preview</span>
            <span className="tabular-nums">
              {previewErr ? (
                <span className="text-danger">{previewErr}</span>
              ) : (
                <span>
                  <span className="font-medium" style={{ color: nBreach > 0 ? statusColor("fail") : statusColor("pass") }}>{nBreach}</span> / {preview.length} would breach
                </span>
              )}
            </span>
          </div>
          <div className="flex max-h-20 flex-wrap gap-1 overflow-auto">
            {preview.slice(0, 60).map((row, i) => {
              const br = breaches(row)
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px]"
                  style={{
                    background: "color-mix(in oklch, " + (br ? statusColor("fail") : statusColor("pass")) + " 18%, transparent)",
                    color: br ? "var(--danger)" : "var(--success)",
                  }}
                >
                  <span className="font-mono">{row.entityKey || "·"}</span>
                  <span className="opacity-70">{scored ? numFmt(row.score) : row.status}</span>
                </span>
              )
            })}
            {preview.length === 0 && !previewErr ? <span className="text-[10px] text-chrome-text/40">no rows — adjust the query</span> : null}
          </div>
        </div>
          </>
        )}
      </div>

      {/* fire policy */}
      <div className="grid grid-cols-3 gap-2">
        <Field label="fire after N×">
          <input value={consecutiveN} onChange={(e) => setConsecutiveN(e.target.value)} className={cn(inputCls, "tabular-nums")} />
        </Field>
        <Field label="cooldown (s)">
          <input value={cooldownSecs} onChange={(e) => setCooldownSecs(e.target.value)} className={cn(inputCls, "tabular-nums")} />
        </Field>
        <Field label="fan-out cap">
          <input value={fanOutCap} onChange={(e) => setFanOutCap(e.target.value)} className={cn(inputCls, "tabular-nums")} />
        </Field>
      </div>

      {/* action */}
      <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-2.5">
        <div className="mb-1 flex items-center gap-2 text-[11px]">
          <span className="font-medium text-foreground">Action</span>
          <div className="flex items-center overflow-hidden rounded border border-chrome-border text-[10px]">
            {(["noop", "sql", "operator", "mcp_call", "flow"] as const).map((op) => (
              <button key={op} type="button" onClick={() => setOperator(op)} className={cn("px-1.5 py-0.5 font-mono", operator === op ? "bg-rvbbit-accent/20 text-foreground" : "text-chrome-text/60")}>
                {op}
              </button>
            ))}
          </div>
        </div>
        {operator === "sql" ? (
          <Field label="sql (the alert context is bound to $1, a jsonb of rule/entity/transition)">
            <div className="h-24 overflow-hidden rounded border border-chrome-border/60">
              <SqlEditor value={actionSql} onChange={setActionSql} height="100%" />
            </div>
          </Field>
        ) : null}
        {operator === "operator" ? (
          <div className="flex flex-col gap-1.5">
            <Field label="operator">
              <Combobox
                value={operatorName}
                onChange={setOperatorName}
                options={operators.map((o) => ({ value: o.name, hint: `${o.shape}→${o.return_type}` }))}
                placeholder="— pick an operator —"
                searchPlaceholder="search operators…"
                emptyText="no operators in the catalog"
              />
            </Field>
            {selectedOperator ? (
              <div className="rounded border border-chrome-border/60 bg-block-bg/40 p-2 text-[10px]">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-rvbbit-accent">{selectedOperator.name}</span>
                  <span className="text-chrome-text/45">
                    {selectedOperator.shape} → {selectedOperator.return_type}
                  </span>
                  {operatorArgs.length > 0 ? (
                    <button
                      type="button"
                      onClick={fillOperatorTemplate}
                      title="Fill the args with this operator's parameter names"
                      className="ml-auto rounded border border-chrome-border px-1.5 py-0.5 text-[9px] text-chrome-text/70 hover:bg-foreground/[0.06]"
                    >
                      use template
                    </button>
                  ) : null}
                </div>
                {selectedOperator.description ? <div className="mb-1.5 leading-snug text-chrome-text/70">{selectedOperator.description}</div> : null}
                <div className="flex flex-col gap-0.5">
                  {operatorArgs.map((a) => (
                    <div key={a.name} className="flex items-baseline gap-1.5">
                      <span className="font-mono text-foreground">{a.name}</span>
                      <span className="text-chrome-text/45">{a.type}</span>
                    </div>
                  ))}
                  {operatorArgs.length === 0 ? <span className="text-chrome-text/40">no arguments</span> : null}
                </div>
              </div>
            ) : operatorName.trim() ? (
              <div className="text-[10px] text-chrome-text/40">
                no operator named <span className="font-mono">{operatorName}</span> in the catalog.
              </div>
            ) : null}
            <Field label={`args — {rule} {entity} {transition} fill from context${argsValid ? "" : "  ⚠ invalid JSON"}`}>
              <div className={cn("h-24 overflow-hidden rounded border", argsValid ? "border-chrome-border/60" : "border-danger/50")}>
                <SqlEditor language="json" value={argsJson} onChange={setArgsJson} height="100%" />
              </div>
            </Field>
          </div>
        ) : null}
        {operator === "mcp_call" ? (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-2">
              <Field label="server">
                <Combobox
                  value={server}
                  onChange={setServer}
                  options={mcpServers.map((s) => ({ value: s }))}
                  placeholder="— server —"
                  searchPlaceholder="search servers…"
                  emptyText="no MCP servers"
                />
              </Field>
              <Field label="tool">
                <Combobox
                  value={tool}
                  onChange={setTool}
                  options={toolsForServer.map((t) => ({ value: t.name, hint: t.description ? t.description.slice(0, 28) : undefined }))}
                  placeholder="— tool —"
                  searchPlaceholder="search tools…"
                  emptyText={server ? "no tools for this server" : "pick a server first"}
                />
              </Field>
            </div>
            {/* docstring for the picked tool — informational, so you know what to provide */}
            {selectedTool ? (
              <div className="rounded border border-chrome-border/60 bg-block-bg/40 p-2 text-[10px]">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-rvbbit-accent">
                    {selectedTool.server}.{selectedTool.name}
                  </span>
                  {argSpecs.length > 0 ? (
                    <button
                      type="button"
                      onClick={fillArgsTemplate}
                      title="Fill the args template with this tool's required keys"
                      className="ml-auto rounded border border-chrome-border px-1.5 py-0.5 text-[9px] text-chrome-text/70 hover:bg-foreground/[0.06]"
                    >
                      use template
                    </button>
                  ) : null}
                </div>
                {selectedTool.description ? <div className="mb-1.5 leading-snug text-chrome-text/70">{selectedTool.description}</div> : null}
                <div className="flex flex-col gap-0.5">
                  {argSpecs.map((a) => (
                    <div key={a.name} className="flex items-baseline gap-1.5">
                      <span className="font-mono text-foreground">{a.name}</span>
                      <span className="text-chrome-text/45">{a.type}</span>
                      {a.required ? (
                        <span className="rounded bg-warning/15 px-1 text-[8px] uppercase tracking-wide text-warning">req</span>
                      ) : null}
                      {a.description ? (
                        <span className="min-w-0 flex-1 truncate text-chrome-text/55" title={a.description}>
                          — {a.description}
                        </span>
                      ) : null}
                    </div>
                  ))}
                  {argSpecs.length === 0 ? <span className="text-chrome-text/40">no documented arguments</span> : null}
                </div>
              </div>
            ) : tool.trim() ? (
              <div className="text-[10px] text-chrome-text/40">
                no catalog entry for <span className="font-mono">{server}.{tool}</span> — check the name or run a catalog refresh.
              </div>
            ) : null}
            <Field label={`args template — {rule} {entity} {transition} fill from context${argsValid ? "" : "  ⚠ invalid JSON"}`}>
              <div className={cn("h-24 overflow-hidden rounded border", argsValid ? "border-chrome-border/60" : "border-danger/50")}>
                <SqlEditor language="json" value={argsJson} onChange={setArgsJson} height="100%" />
              </div>
            </Field>
          </div>
        ) : null}
        {operator === "flow" ? (
          <Field label="flow spec (interpolated with the context, then run via rvbbit.flow)">
            <textarea value={spec} onChange={(e) => setSpec(e.target.value)} rows={2} spellCheck={false} className={cn(inputCls, "resize-y font-mono leading-snug")} />
          </Field>
        ) : null}
        {operator === "noop" ? <div className="text-[10px] text-chrome-text/45">no-op — fires + logs an event without reaching out (good for testing).</div> : null}
      </div>

      <Field label="cadence tier">
        <div className="flex items-center overflow-hidden rounded border border-chrome-border text-[11px]" style={{ width: "fit-content" }}>
          {(["fast", "normal", "slow"] as const).map((c) => (
            <button key={c} type="button" onClick={() => setCadence(c)} className={cn("px-2 py-0.5", cadence === c ? "bg-rvbbit-accent/20 text-foreground" : "text-chrome-text/60")}>
              {c}
            </button>
          ))}
        </div>
      </Field>
    </div>
  )
}

// ── operational overview (shown when no rule is selected) ──────────────────────

function StatTile({
  label,
  value,
  tone,
  sub,
}: {
  label: string
  value: React.ReactNode
  tone?: "danger" | "warning" | "accent"
  sub?: string
}) {
  const color =
    tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : tone === "accent" ? "var(--rvbbit-accent)" : "var(--foreground)"
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-chrome-text/50">{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums leading-none" style={{ color }}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[10px] text-chrome-text/45">{sub}</div> : null}
    </div>
  )
}

/**
 * The default landing for the Alerts cockpit: an at-a-glance read of the
 * alert *system's* operational health (kill-switch, sweep cadence per tier,
 * action-queue depth, recent fires/errors) plus a cross-rule firing log that
 * doubles as a jump-off into any rule.
 */
function AlertsOverview({
  rules,
  enabled,
  events,
  sweeps,
  now,
  onPickRule,
}: {
  rules: AlertRule[]
  enabled: boolean
  events: AlertEvent[]
  sweeps: AlertSweepRun[]
  now: number
  onPickRule: (rule: string) => void
}) {
  const [filter, setFilter] = useState("")

  const agg = useMemo(() => {
    const enabledCount = rules.filter((r) => r.enabled).length
    const mutedCount = rules.filter((r) => r.muted).length
    const breachingEntities = rules.reduce((s, r) => s + r.breaching, 0)
    const rulesBreaching = rules.filter((r) => r.breaching > 0).length
    const pendingActions = rules.reduce((s, r) => s + r.pending, 0)
    const lastFireMs = rules.reduce<number>((m, r) => Math.max(m, r.lastFiredMs ?? 0), 0) || null
    const recentErrors = events.filter((e) => e.error || e.status !== "fired").length
    const recentFires = events.filter((e) => e.status === "fired").length
    return { enabledCount, mutedCount, breachingEntities, rulesBreaching, pendingActions, lastFireMs, recentErrors, recentFires }
  }, [rules, events])

  // Per-tier sweep cadence: derive a "typical interval" from the gaps between
  // consecutive ticks and flag a tier whose last tick is overdue — a stalled
  // cron worker shows up here even though everything else looks fine.
  const tiers = useMemo(() => {
    const byTier = new Map<string, AlertSweepRun[]>()
    for (const s of sweeps) {
      const t = s.tier || "?"
      const list = byTier.get(t) ?? []
      list.push(s)
      byTier.set(t, list)
    }
    return [...byTier.entries()]
      .map(([tier, runs]) => {
        const sorted = runs.filter((r) => r.startedMs != null).sort((a, b) => b.startedMs! - a.startedMs!)
        const lastMs = sorted[0]?.startedMs ?? null
        const gaps: number[] = []
        for (let i = 0; i < sorted.length - 1; i++) gaps.push(sorted[i].startedMs! - sorted[i + 1].startedMs!)
        gaps.sort((a, b) => a - b)
        const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null
        const ageMs = lastMs != null ? now - lastMs : null
        // Only flag overdue when we know the tier's typical cadence; without a
        // baseline, a generous 5-min floor avoids false alarms on slow tiers.
        const stalled = ageMs != null && (typical != null ? ageMs > typical * 2.5 + 5000 : ageMs > 300_000)
        return { tier, lastMs, ageMs, typical, stalled, ticks: runs.length }
      })
      .sort((a, b) => a.tier.localeCompare(b.tier))
  }, [sweeps, now])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return events
    return events.filter(
      (e) =>
        e.ruleName.toLowerCase().includes(q) ||
        e.entityKey.toLowerCase().includes(q) ||
        e.status.toLowerCase().includes(q) ||
        (e.error ?? "").toLowerCase().includes(q),
    )
  }, [events, filter])

  return (
    <div className="flex flex-col gap-3">
      {/* system stat strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="System"
          value={enabled ? "Armed" : "Paused"}
          tone={enabled ? undefined : "danger"}
          sub={`${rules.length} rules · ${agg.enabledCount} on · ${agg.mutedCount} muted`}
        />
        <StatTile
          label="Breaching"
          value={agg.breachingEntities}
          tone={agg.breachingEntities > 0 ? "danger" : undefined}
          sub={`across ${agg.rulesBreaching} rule${agg.rulesBreaching === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Queue depth"
          value={agg.pendingActions}
          tone={agg.pendingActions > 0 ? "warning" : undefined}
          sub="pending actions"
        />
        <StatTile
          label="Recent fires"
          value={agg.recentFires}
          tone={agg.recentErrors > 0 ? "warning" : "accent"}
          sub={agg.recentErrors > 0 ? `${agg.recentErrors} errored` : "last 50 events"}
        />
        <StatTile label="Last fire" value={agg.lastFireMs ? fmtAgo(agg.lastFireMs) : "—"} />
      </div>

      {/* sweep cadence per tier */}
      <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <Activity className="h-3.5 w-3.5 text-rvbbit-accent" /> Sweep cadence
          <span className="ml-auto text-[10px] font-normal text-chrome-text/45">last tick per tier</span>
        </div>
        {tiers.length === 0 ? (
          <div className="py-2 text-center text-[11px] text-chrome-text/40">no sweeps recorded yet</div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {tiers.map((t) => (
              <div
                key={t.tier}
                className="flex items-center gap-2 rounded border px-2 py-1.5"
                style={{ borderColor: t.stalled ? "color-mix(in oklch, var(--danger) 50%, transparent)" : "var(--chrome-border)" }}
                title={t.typical != null ? `typical interval ≈ ${fmtDur(t.typical)} · ${t.ticks} ticks` : `${t.ticks} ticks`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: t.stalled ? "var(--danger)" : "var(--success)" }}
                />
                <span className="text-[11px] font-medium uppercase tracking-wide text-foreground">{t.tier}</span>
                <span className="ml-auto text-[10px] tabular-nums text-chrome-text/55">
                  {t.ageMs != null ? fmtAgo(t.lastMs) : "—"}
                  {t.stalled ? <span className="ml-1 text-danger">stalled?</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <SweepHeartbeat sweeps={sweeps} />

      {/* cross-rule firing log with a filter */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-foreground">Activity log</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by rule, entity, status, error…"
          className="ml-auto h-6 w-64 rounded border border-chrome-border bg-doc-bg/40 px-2 text-[11px] text-foreground outline-none focus:border-rvbbit-accent/50"
        />
      </div>
      <EventLog events={filtered} showRule title="All rules" maxHClass="max-h-[40vh]" onPickRule={onPickRule} />
    </div>
  )
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

// ── main cockpit ──────────────────────────────────────────────────────────────

export function AlertsWindow({ payload, activeConnectionId, hasRvbbit, onChangePayload, onOpenSqlData }: AlertsWindowProps) {
  const wsActive = useWorkspaceActive()
  const [rules, setRules] = useState<AlertRule[]>([])
  const [enabled, setEnabled] = useState(true)
  const [entities, setEntities] = useState<AlertEntity[]>([])
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [sweeps, setSweeps] = useState<AlertSweepRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // wall-clock for the timeline, advanced by the poll (kept out of render so it
  // stays a pure deterministic render).
  const [now, setNow] = useState(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [editTarget, setEditTarget] = useState<AlertRule | null>(null)
  // last manual sweep result + when we ran it — drives the "watch the sweep" readout.
  const [lastSweep, setLastSweep] = useState<{ at: number; summary: Record<string, unknown> } | null>(null)

  const selected = payload.rule ?? null
  const rule = useMemo(() => rules.find((r) => r.name === selected) ?? null, [rules, selected])

  const loadRules = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchAlertRules(activeConnectionId)
    setRules(r.rules)
    setEnabled(r.enabled)
    setError(r.error)
    // No auto-select: a fresh window lands on the operational Overview so you
    // see the system's health first. Click a rule (or a log row) to drill in.
  }, [activeConnectionId])

  const loadDetail = useCallback(async () => {
    if (!activeConnectionId) return
    const [st, ev, sw] = await Promise.all([
      selected ? fetchAlertState(activeConnectionId, selected) : Promise.resolve({ entities: [], error: null }),
      // Overview pulls a deeper cross-rule log; per-rule view stays lean.
      fetchAlertEvents(activeConnectionId, selected, selected ? 50 : 200),
      fetchAlertSweepRuns(activeConnectionId, selected ? 40 : 150),
    ])
    setEntities(st.entities)
    setEvents(ev.events)
    setSweeps(sw.sweeps)
  }, [activeConnectionId, selected])

  // initial + polled load
  const tick = useCallback(async () => {
    setNow(Date.now())
    await loadRules()
    await loadDetail()
  }, [loadRules, loadDetail])
  usePolling(tick, 4000, {
    enabled: wsActive && !!activeConnectionId && hasRvbbit,
    // include `selected` so picking a rule refetches its detail immediately (the old
    // effect re-armed on loadDetail's identity, which changes with `selected`).
    resetKey: `${activeConnectionId ?? ""}::${selected ?? ""}`,
  })

  const act = useCallback(
    async (fn: () => Promise<string | null>) => {
      if (!activeConnectionId) return
      setBusy(true)
      const err = await fn()
      if (err) setError(err)
      await loadRules()
      await loadDetail()
      setBusy(false)
    },
    [activeConnectionId, loadRules, loadDetail],
  )

  // Sweep is its own handler (not act()) so we can surface what the sweep DID —
  // the returned summary feeds the toolbar readout and the just-changed pulse.
  const doSweep = useCallback(
    async (sweepTier: string) => {
      if (!activeConnectionId) return
      setBusy(true)
      const r = await runSweep(activeConnectionId, sweepTier)
      if (r.error) setError(r.error)
      else if (r.summary) setLastSweep({ at: Date.now(), summary: r.summary })
      await loadRules()
      await loadDetail()
      setNow(Date.now())
      setBusy(false)
    },
    [activeConnectionId, loadRules, loadDetail],
  )

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/60">
        No pg_rvbbit on this connection.
      </div>
    )
  }

  const tier = rule?.cadenceTier ?? "normal"
  const isScored = rule != null && rule.conditionSpec.threshold != null

  return (
    <div className="flex h-full flex-col text-foreground">
      <style>{`
        @keyframes alerts-sweep-flash {
          0% { background-color: color-mix(in oklch, var(--warning) 45%, transparent); }
          100% { background-color: rgba(255,255,255,0.05); }
        }
        .alerts-sweep-flash { animation: alerts-sweep-flash 1.4s ease-out 1; }
        @keyframes alerts-just-changed {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .alerts-just-changed { animation: alerts-just-changed 0.9s ease-in-out 3; }
      `}</style>
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-2">
        <Bell className="h-4 w-4" style={{ color: "var(--danger)" }} />
        <span className="text-[12px] font-medium">Alerts</span>
        <button
          type="button"
          onClick={() => void act(() => setAlertsEnabled(activeConnectionId!, !enabled))}
          title={enabled ? "Alerts ON — click to disable globally (kill-switch)" : "Alerts OFF — click to enable"}
          className={cn(
            "ml-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
            enabled
              ? "border-success/40 bg-success/15 text-success"
              : "border-danger/40 bg-danger/15 text-danger",
          )}
        >
          <Zap className="h-3 w-3" /> {enabled ? "armed" : "paused"}
        </button>
        <div className="ml-auto flex items-center gap-1">
          {lastSweep ? (
            <span
              key={lastSweep.at}
              className="alerts-sweep-flash inline-flex items-center gap-1 rounded bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] tabular-nums text-chrome-text/70"
              title={`sweep ${String(lastSweep.summary.sweep_id ?? "")} · ${String(lastSweep.summary.rules_evaluated ?? 0)} rules evaluated`}
            >
              <span className="text-chrome-text/45">swept</span>
              <span className={cn(Number(lastSweep.summary.transitions ?? 0) > 0 ? "text-warning" : "text-chrome-text/55")}>
                {Number(lastSweep.summary.transitions ?? 0)} transitions
              </span>
              <span className="text-chrome-text/25">·</span>
              <span className={cn(Number(lastSweep.summary.enqueued ?? 0) > 0 ? "text-rvbbit-accent" : "text-chrome-text/55")}>
                {Number(lastSweep.summary.enqueued ?? 0)} fired
              </span>
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void doSweep(tier)}
            title={rule ? `Run a ${tier}-tier sweep now` : "Run a normal-tier sweep now"}
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/80 hover:bg-foreground/[0.06] disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> Sweep
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => runWorker(activeConnectionId!, 50))}
            title="Drain the action queue (worker tick)"
            className="inline-flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-[11px] text-chrome-text/80 hover:bg-foreground/[0.06] disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} /> Drain
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          <X className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* rule rail */}
        <div className="w-56 shrink-0 overflow-auto border-r border-chrome-border bg-doc-bg/30">
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setEditTarget(null)
              onChangePayload((p) => ({ ...p, rule: undefined }))
            }}
            title="System overview — sweep cadence, queue depth & the cross-rule activity log"
            className={cn(
              "flex w-full items-center gap-1.5 border-b border-chrome-border/40 px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors",
              !editing && !selected ? "bg-rvbbit-accent/15 text-rvbbit-accent" : "text-chrome-text/70 hover:bg-foreground/[0.04]",
            )}
          >
            <Activity className="h-3.5 w-3.5" />
            Overview
          </button>
          <button
            type="button"
            onClick={() => {
              setEditTarget(null)
              setEditing(true)
            }}
            className={cn(
              "flex w-full items-center gap-1.5 border-b border-chrome-border/40 px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors",
              editing && !editTarget ? "bg-rvbbit-accent/15 text-rvbbit-accent" : "text-chrome-text/70 hover:bg-foreground/[0.04]",
            )}
          >
            <span className="grid h-4 w-4 place-items-center rounded border border-current text-[11px] leading-none">+</span>
            New alert
          </button>
          {rules.map((r) => {
            const sel = r.name === selected
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => {
                  setEditing(false)
                  // Re-clicking the selected rule toggles back to the Overview.
                  onChangePayload((p) => ({ ...p, rule: sel ? undefined : r.name }))
                }}
                className={cn(
                  "flex w-full flex-col gap-0.5 border-b border-chrome-border/30 px-2.5 py-1.5 text-left transition-colors",
                  sel ? "bg-rvbbit-accent/10" : "hover:bg-foreground/[0.04]",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: r.breaching > 0 ? statusColor("fail") : statusColor("pass"), opacity: r.muted ? 0.3 : 1 }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{r.name}</span>
                  {r.muted ? <span className="text-[9px] text-chrome-text/40">muted</span> : null}
                  {!r.enabled ? <span className="text-[9px] text-warning/70">off</span> : null}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-chrome-text/55">
                  <span style={{ color: r.breaching > 0 ? statusColor("fail") : undefined }}>
                    {r.breaching}/{r.entities} breaching
                  </span>
                  {r.pending > 0 ? <span className="text-warning/80">{r.pending} pending</span> : null}
                  <span className="ml-auto">{r.lastFiredMs ? fmtAgo(r.lastFiredMs) : "—"}</span>
                </div>
              </button>
            )
          })}
          {rules.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-chrome-text/45">
              No alerts defined. Use <span className="font-mono">rvbbit.define_alert(…)</span>.
            </div>
          ) : null}
        </div>

        {/* main observable panel */}
        <div className="min-w-0 flex-1 overflow-auto p-3">
          {editing ? (
            <RuleEditor
              key={editTarget?.name ?? "new"}
              connectionId={activeConnectionId!}
              initial={editTarget}
              onCancel={() => {
                setEditing(false)
                setEditTarget(null)
              }}
              onSaved={(nm) => {
                setEditing(false)
                setEditTarget(null)
                onChangePayload((p) => ({ ...p, rule: nm }))
                void loadRules()
                void loadDetail()
              }}
              onDeleted={() => {
                setEditing(false)
                setEditTarget(null)
                onChangePayload((p) => ({ ...p, rule: undefined }))
                void loadRules()
                void loadDetail()
              }}
            />
          ) : !rule ? (
            <AlertsOverview
              rules={rules}
              enabled={enabled}
              events={events}
              sweeps={sweeps}
              now={now}
              onPickRule={(name) => onChangePayload((p) => ({ ...p, rule: name }))}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {/* anatomy */}
              <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{rule.name}</span>
                  {rule.category ? (
                    <span className="rounded border border-chrome-border/60 px-1.5 py-0.5 text-[9px] text-chrome-text/70">
                      {rule.category}
                      {rule.subcategory ? <span className="text-chrome-text/40"> › {rule.subcategory}</span> : null}
                    </span>
                  ) : null}
                  <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/60">
                    {rule.cadenceTier}
                  </span>
                  <span className="text-[9px] text-chrome-text/50">{rule.cardinality}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {onOpenSqlData ? (
                      <button
                        type="button"
                        onClick={() => onOpenSqlData(alertHistorySql(rule.name), `Alert history · ${rule.name}`)}
                        title="Open the full firing + action history as an editable, runnable SQL query"
                        className="rounded border border-chrome-border px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06]"
                      >
                        history ↗
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setEditTarget(rule)
                        setEditing(true)
                      }}
                      className="rounded border border-chrome-border px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06]"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(() => setRuleEnabled(activeConnectionId!, rule.name, !rule.enabled))}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        rule.enabled ? "border-chrome-border text-chrome-text/70" : "border-warning/40 text-warning",
                      )}
                    >
                      {rule.enabled ? "disable" : "enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void act(() => (rule.muted ? unmuteRule(activeConnectionId!, rule.name) : muteRule(activeConnectionId!, rule.name, 60)))
                      }
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        rule.muted ? "border-sky-500/40 text-sky-300" : "border-chrome-border text-chrome-text/70",
                      )}
                    >
                      {rule.muted ? "unmute" : "mute 1h"}
                    </button>
                  </div>
                </div>
                {rule.description ? <div className="mt-1 text-[11px] text-chrome-text/70">{rule.description}</div> : null}
                {/* condition → policy → action pipeline */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="rounded border border-chrome-border bg-block-bg/60 px-1.5 py-0.5 font-mono text-chrome-text/80">
                    {rule.conditionSpec.kind === "metric"
                      ? `metric: ${rule.conditionSpec.metric}`
                      : typeof rule.conditionSpec.expr === "string" && rule.conditionSpec.expr !== ""
                        ? `fail when: ${rule.conditionSpec.expr}`
                        : isScored
                          ? `score ${rule.conditionSpec.compare === "lte" ? "≤" : "≥"} ${numFmt(Number(rule.conditionSpec.threshold))}`
                          : "status = fail"}
                  </span>
                  <span className="text-chrome-text/40">→</span>
                  <span className="rounded border border-chrome-border bg-block-bg/60 px-1.5 py-0.5 text-chrome-text/80">
                    fire after {Number(rule.firePolicy.consecutive_n ?? 1)}×
                    {Number(rule.firePolicy.cooldown_secs ?? 0) > 0 ? ` · cooldown ${Number(rule.firePolicy.cooldown_secs)}s` : ""}
                  </span>
                  <span className="text-chrome-text/40">→</span>
                  <span
                    className="rounded border px-1.5 py-0.5 font-mono"
                    style={{
                      borderColor: "color-mix(in oklch, var(--rvbbit-accent) 40%, transparent)",
                      color: "var(--rvbbit-accent)",
                    }}
                    title={JSON.stringify(rule.actionSpec, null, 2)}
                  >
                    {String(rule.actionSpec.operator ?? "?")}
                    {rule.actionSpec.operator === "mcp_call" ? `(${rule.actionSpec.server}.${rule.actionSpec.tool})` : ""}
                    {rule.actionSpec.operator === "operator" ? `(${rule.actionSpec.operator_name})` : ""}
                  </span>
                </div>
                {typeof rule.conditionSpec.query === "string" ? (
                  <div className="mt-1.5 truncate font-mono text-[10px] text-chrome-text/45" title={String(rule.conditionSpec.query)}>
                    {String(rule.conditionSpec.query)}
                  </div>
                ) : null}
              </div>

              {/* the showpiece: draggable threshold over the score distribution */}
              {isScored ? (
                <ThresholdExplorer
                  key={rule.name}
                  rule={rule}
                  entities={entities}
                  now={now}
                  onCommit={(t) => void act(() => commitThreshold(activeConnectionId!, rule, t))}
                />
              ) : null}

              <EpisodeTimeline entities={entities} events={events} sweeps={sweeps} now={now} />

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <EntityState entities={entities} now={now} />
                <EventLog events={events} />
              </div>

              <SweepHeartbeat sweeps={sweeps} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
