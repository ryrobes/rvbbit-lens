"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Activity, Bell, Play, RefreshCw, X, Zap } from "@/lib/icons"
import { cn } from "@/lib/utils"
import { useWorkspaceActive } from "./workspace-active-context"
import {
  commitThreshold,
  fetchAlertEvents,
  fetchAlertRules,
  fetchAlertState,
  fetchAlertSweepRuns,
  muteRule,
  runSweep,
  runWorker,
  setAlertsEnabled,
  setRuleEnabled,
  unmuteRule,
  type AlertEntity,
  type AlertEvent,
  type AlertRule,
  type AlertSweepRun,
} from "@/lib/rvbbit/alerts"
import type { AlertsPayload } from "@/lib/desktop/types"

interface AlertsWindowProps {
  payload: AlertsPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onChangePayload: (mut: (p: AlertsPayload) => AlertsPayload) => void
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
      return "var(--color-amber-400, #fbbf24)"
    case "pass":
      return "var(--color-emerald-400, #34d399)"
    default:
      return "var(--color-zinc-500, #71717a)"
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
  onCommit,
}: {
  rule: AlertRule
  entities: AlertEntity[]
  onCommit: (threshold: number) => void
}) {
  const compare = String(rule.conditionSpec.compare ?? "gte")
  const ruleThresh = Number(rule.conditionSpec.threshold ?? 0)
  const scored = entities.filter((e) => e.score != null) as (AlertEntity & { score: number })[]
  const [drag, setDrag] = useState(ruleThresh)
  const svgRef = useRef<SVGSVGElement>(null)

  const W = 640
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

  const xOf = useCallback((v: number) => PADX + ((v - dMin) / (dMax - dMin)) * (W - 2 * PADX), [dMin, dMax])
  const breaches = useCallback((s: number) => (compare === "lte" ? s <= drag : s >= drag), [compare, drag])
  const nBreach = scored.filter((e) => breaches(e.score)).length

  const xToVal = useCallback(
    (clientX: number) => {
      const el = svgRef.current
      if (!el) return drag
      const r = el.getBoundingClientRect()
      const vx = ((clientX - r.left) / r.width) * W
      const v = dMin + ((vx - PADX) / (W - 2 * PADX)) * (dMax - dMin)
      return Math.min(dMax, Math.max(dMin, v))
    },
    [dMin, dMax, drag],
  )

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
    <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
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
          fill="color-mix(in oklch, var(--color-red-500, #ef4444) 12%, transparent)"
        />
        {/* axis */}
        <line x1={PADX} y1={AXIS_Y} x2={W - PADX} y2={AXIS_Y} stroke="var(--chrome-border, #444)" strokeWidth={1} />
        {/* entity dots */}
        {scored.map((e, i) => {
          const x = xOf(e.score)
          const br = breaches(e.score)
          const y = AXIS_Y - 12 - (i % 4) * 14
          return (
            <g key={e.entityKey || i}>
              <circle cx={x} cy={y} r={5} fill={br ? statusColor("fail") : statusColor("pass")} opacity={br ? 1 : 0.55} />
              <text x={x} y={y - 8} textAnchor="middle" className="fill-chrome-text/70" style={{ fontSize: 8 }}>
                {e.entityKey || "·"}
              </text>
            </g>
          )
        })}
        {/* draggable threshold */}
        <g style={{ cursor: "ew-resize" }} onPointerDown={onDown}>
          <line x1={tx} y1={6} x2={tx} y2={AXIS_Y + 6} stroke="var(--color-red-400, #f87171)" strokeWidth={2} />
          <rect x={tx - 16} y={AXIS_Y + 8} width={32} height={16} rx={3} fill="var(--color-red-500, #ef4444)" opacity={0.9} />
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
                    ? "var(--color-red-500, #ef4444)"
                    : s.transitions > 0
                      ? "var(--color-amber-400, #fbbf24)"
                      : "color-mix(in oklch, var(--rvbbit-accent, #4fd1c5) 45%, transparent)",
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

function EventLog({ events }: { events: AlertEvent[] }) {
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40">
      <div className="border-b border-chrome-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground">
        Firing log
      </div>
      <div className="max-h-44 overflow-auto">
        {events.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-chrome-text/45">no fires yet</div>
        ) : (
          <ul className="divide-y divide-chrome-border/30">
            {events.map((e, i) => (
              <li key={i} className="flex items-center gap-2 px-3 py-1 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: e.status === "fired" ? statusColor("fail") : "var(--color-red-500,#ef4444)" }}
                />
                <span className="w-20 shrink-0 truncate font-mono text-chrome-text/80">{e.entityKey || "·"}</span>
                <span className="shrink-0 text-chrome-text/55">{e.transition}</span>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ color: e.status === "fired" ? "var(--color-emerald-300,#6ee7b7)" : "var(--color-red-300,#fca5a5)" }}
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

function EntityState({ entities }: { entities: AlertEntity[] }) {
  return (
    <div className="rounded-md border border-chrome-border bg-doc-bg/40">
      <div className="border-b border-chrome-border/60 px-3 py-1.5 text-[11px] font-medium text-foreground">
        Entities · {entities.length}
      </div>
      <div className="max-h-44 overflow-auto p-2">
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {entities.map((e) => (
            <div
              key={e.entityKey}
              className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]"
              style={{ borderColor: "color-mix(in oklch, " + statusColor(e.lastStatus) + " 40%, transparent)" }}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(e.lastStatus) }} />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{e.entityKey || "(scalar)"}</span>
              {e.score != null ? <span className="tabular-nums text-chrome-text/70">{numFmt(e.score)}</span> : null}
              {e.lastStatus === "fail" && e.consecutive > 1 ? (
                <span
                  className="rounded px-1 text-[9px] tabular-nums"
                  style={{ background: "color-mix(in oklch, var(--color-amber-400,#fbbf24) 25%, transparent)", color: "var(--color-amber-200,#fde68a)" }}
                  title="consecutive fails"
                >
                  ×{e.consecutive}
                </span>
              ) : null}
              {e.firedMs != null ? (
                <span className="shrink-0 text-[9px] text-chrome-text/45" title="last fired">{fmtAgo(e.firedMs)}</span>
              ) : null}
            </div>
          ))}
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

// ── main cockpit ──────────────────────────────────────────────────────────────

export function AlertsWindow({ payload, activeConnectionId, hasRvbbit, onChangePayload }: AlertsWindowProps) {
  const wsActive = useWorkspaceActive()
  const [rules, setRules] = useState<AlertRule[]>([])
  const [enabled, setEnabled] = useState(true)
  const [entities, setEntities] = useState<AlertEntity[]>([])
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [sweeps, setSweeps] = useState<AlertSweepRun[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = payload.rule ?? null
  const rule = useMemo(() => rules.find((r) => r.name === selected) ?? null, [rules, selected])

  const loadRules = useCallback(async () => {
    if (!activeConnectionId) return
    const r = await fetchAlertRules(activeConnectionId)
    setRules(r.rules)
    setEnabled(r.enabled)
    setError(r.error)
    // auto-select the most-active rule (most breaching) so the cockpit opens on
    // something happening — falling back to the first rule.
    if (!selected && r.rules.length > 0) {
      const pick = [...r.rules].sort((a, b) => b.breaching - a.breaching)[0]
      onChangePayload((p) => ({ ...p, rule: pick.name }))
    }
  }, [activeConnectionId, selected, onChangePayload])

  const loadDetail = useCallback(async () => {
    if (!activeConnectionId) return
    const [st, ev, sw] = await Promise.all([
      selected ? fetchAlertState(activeConnectionId, selected) : Promise.resolve({ entities: [], error: null }),
      fetchAlertEvents(activeConnectionId, selected, 50),
      fetchAlertSweepRuns(activeConnectionId, 40),
    ])
    setEntities(st.entities)
    setEvents(ev.events)
    setSweeps(sw.sweeps)
  }, [activeConnectionId, selected])

  // initial + polled load
  useEffect(() => {
    if (!wsActive || !activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      await loadRules()
      await loadDetail()
    }
    void tick()
    const id = setInterval(() => void tick(), 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [wsActive, activeConnectionId, hasRvbbit, loadRules, loadDetail])

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

  if (!hasRvbbit) {
    return (
      <div className="grid h-full place-items-center bg-block-bg p-6 text-center text-[12px] text-chrome-text/60">
        No pg_rvbbit on this connection.
      </div>
    )
  }

  const tier = rule?.cadenceTier ?? "normal"
  const isScored = rule != null && rule.conditionSpec.threshold != null

  return (
    <div className="flex h-full flex-col bg-block-bg text-foreground">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-2">
        <Bell className="h-4 w-4" style={{ color: "var(--color-red-400, #f87171)" }} />
        <span className="text-[12px] font-medium">Alerts</span>
        <button
          type="button"
          onClick={() => void act(() => setAlertsEnabled(activeConnectionId!, !enabled))}
          title={enabled ? "Alerts ON — click to disable globally (kill-switch)" : "Alerts OFF — click to enable"}
          className={cn(
            "ml-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
            enabled
              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              : "border-red-500/40 bg-red-500/15 text-red-300",
          )}
        >
          <Zap className="h-3 w-3" /> {enabled ? "armed" : "paused"}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={busy || !rule}
            onClick={() => void act(() => runSweep(activeConnectionId!, tier))}
            title={`Run a ${tier}-tier sweep now`}
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
        <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-200">
          <X className="h-3 w-3" /> {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* rule rail */}
        <div className="w-56 shrink-0 overflow-auto border-r border-chrome-border bg-doc-bg/30">
          {rules.map((r) => {
            const sel = r.name === selected
            return (
              <button
                key={r.name}
                type="button"
                onClick={() => onChangePayload((p) => ({ ...p, rule: r.name }))}
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
                  {!r.enabled ? <span className="text-[9px] text-amber-400/70">off</span> : null}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-chrome-text/55">
                  <span style={{ color: r.breaching > 0 ? statusColor("fail") : undefined }}>
                    {r.breaching}/{r.entities} breaching
                  </span>
                  {r.pending > 0 ? <span className="text-amber-400/80">{r.pending} pending</span> : null}
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
          {!rule ? (
            <div className="grid h-full place-items-center text-[12px] text-chrome-text/45">Select an alert.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* anatomy */}
              <div className="rounded-md border border-chrome-border bg-doc-bg/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-foreground">{rule.name}</span>
                  <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chrome-text/60">
                    {rule.cadenceTier}
                  </span>
                  <span className="text-[9px] text-chrome-text/50">{rule.cardinality}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void act(() => setRuleEnabled(activeConnectionId!, rule.name, !rule.enabled))}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        rule.enabled ? "border-chrome-border text-chrome-text/70" : "border-amber-500/40 text-amber-300",
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
                    {isScored
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
                      borderColor: "color-mix(in oklch, var(--rvbbit-accent,#4fd1c5) 40%, transparent)",
                      color: "var(--rvbbit-accent, #4fd1c5)",
                    }}
                    title={JSON.stringify(rule.actionSpec, null, 2)}
                  >
                    {String(rule.actionSpec.operator ?? "?")}
                    {rule.actionSpec.operator === "mcp_call" ? `(${rule.actionSpec.server}.${rule.actionSpec.tool})` : ""}
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
                  onCommit={(t) => void act(() => commitThreshold(activeConnectionId!, rule, t))}
                />
              ) : null}

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <EntityState entities={entities} />
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
