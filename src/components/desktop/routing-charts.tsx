"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useElementWidth } from "./instruments"
import {
  ENGINES,
  engineFlowOrder,
  engineMeta,
  prettyToken,
  shapeHighlights,
} from "@/lib/rvbbit/routing"

// ── Engine identity bits ────────────────────────────────────────────

export function EngineDot({ id, className }: { id: string; className?: string }) {
  return (
    <span
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ background: engineMeta(id).color }}
    />
  )
}

export function EnginePill({
  id,
  dim,
  className,
}: {
  id: string
  dim?: boolean
  className?: string
}) {
  const m = engineMeta(id)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] font-medium",
        className,
      )}
      style={{
        color: m.color,
        background: `color-mix(in oklch, ${m.color} ${dim ? 8 : 16}%, transparent)`,
        opacity: dim ? 0.7 : 1,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  )
}

// ── ShapeChips — the legible form of a shape_key / shape_family ──────

export function ShapeChips({
  shape,
  limit = 99,
  className,
}: {
  shape: string
  limit?: number
  className?: string
}) {
  const hi = shapeHighlights(shape)
  const shown = hi.slice(0, limit)
  const extra = hi.length - shown.length
  if (hi.length === 0) {
    return <span className="font-mono text-[9px] text-chrome-text/40">trivial shape</span>
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)} title={shape}>
      {shown.map((t, i) => (
        <span
          key={i}
          className="rounded bg-foreground/[0.06] px-1 py-px font-mono text-[9px] text-chrome-text/85"
        >
          {prettyToken(t.k, t.v)}
        </span>
      ))}
      {extra > 0 ? (
        <span className="font-mono text-[9px] text-chrome-text/40">+{extra}</span>
      ) : null}
    </div>
  )
}

// ── EngineRace — the candidate timings as mini bars (one per ENGINE) ─

/**
 * A row's measured candidate timings as log-scaled bars — one bar per
 * engine, in ENGINES order. The winner (the `choice`) is full-opacity;
 * the eye reads "shortest + brightest = chosen". Log scale keeps a 50×
 * spread legible. `times` keys missing or null → an unmeasured baseline.
 */
export function EngineRace({
  times,
  choice,
  height = 30,
}: {
  times: Partial<Record<string, number | null>>
  choice: string
  height?: number
}) {
  const present = ENGINES.map((e) => times[e.id]).filter(
    (v): v is number => v != null && v > 0,
  )
  const maxMs = Math.max(1, ...present)
  const denom = Math.log10(maxMs + 1) || 1
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {ENGINES.map((e) => {
        const ms = times[e.id]
        if (ms == null) {
          return (
            <div key={e.id} className="flex w-2.5 items-end" title={`${e.label}: not measured`}>
              <div className="h-[3px] w-full rounded-sm bg-foreground/[0.07]" />
            </div>
          )
        }
        const isChoice = e.id === choice
        const h = Math.max(3, (Math.log10(ms + 1) / denom) * height)
        return (
          <div
            key={e.id}
            className="flex w-2.5 items-end"
            title={`${e.label}: ${ms.toFixed(1)}ms${isChoice ? " — chosen" : ""}`}
          >
            <div
              className="w-full rounded-sm"
              style={{
                height: h,
                background: e.color,
                opacity: isChoice ? 1 : 0.32,
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

// ── FlowDiagram — route_source → engine, a small Sankey ─────────────

export interface FlowLink {
  source: string
  target: string
  value: number
}

export function FlowDiagram({
  links,
  height = 188,
  className,
}: {
  links: FlowLink[]
  height?: number
  className?: string
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const [hovered, setHovered] = useState<number | null>(null)

  const padX = 104
  const nodeW = 9
  const gap = 13

  const model = useMemo(() => {
    const grand = links.reduce((s, l) => s + l.value, 0)
    if (grand <= 0 || w <= 0) return null

    const srcTotals = new Map<string, number>()
    for (const l of links) srcTotals.set(l.source, (srcTotals.get(l.source) ?? 0) + l.value)
    const sources = [...srcTotals.entries()].sort((a, b) => b[1] - a[1])

    const tgtTotals = new Map<string, number>()
    for (const l of links) tgtTotals.set(l.target, (tgtTotals.get(l.target) ?? 0) + l.value)
    // Target nodes are derived from the links themselves (not the fixed ENGINES
    // list) so the virtual native·heap/parquet/vortex split nodes appear too.
    // Only targets with traffic this window; ordered by engineFlowOrder (native
    // sub-paths grouped where native sits). Resolved to EngineMeta via engineMeta.
    const activeEngines = [...tgtTotals.entries()]
      .filter(([, total]) => total > 0)
      .sort((a, b) => {
        const ka = engineFlowOrder(a[0])
        const kb = engineFlowOrder(b[0])
        return ka[0] - kb[0] || ka[1] - kb[1]
      })
      .map(([id]) => engineMeta(id))

    const availLeft = height - (sources.length - 1) * gap
    const availRight = height - Math.max(0, activeEngines.length - 1) * gap
    const unit = Math.max(0, Math.min(availLeft, availRight)) / grand
    if (unit <= 0) return null

    // left column — proportional source bars, vertically centred.
    // y-positions are prefix sums (no running mutation) so the layout
    // stays a pure render computation.
    const srcContentH = grand * unit + (sources.length - 1) * gap
    const srcTop = (height - srcContentH) / 2
    const srcNodes = sources.map(([name, total], i) => ({
      name,
      total,
      h: total * unit,
      y: srcTop + sources.slice(0, i).reduce((s, [, t]) => s + t * unit + gap, 0),
    }))

    // right column — only engines with routing this window, sized by volume
    const tgtSized = activeEngines.map((e) => {
      const total = tgtTotals.get(e.id) ?? 0
      return { engine: e, total, h: total * unit }
    })
    const tgtContentH =
      tgtSized.reduce((s, t) => s + t.h, 0) + Math.max(0, tgtSized.length - 1) * gap
    const tgtTop = (height - tgtContentH) / 2
    const tgtNodes = tgtSized.map((t, i) => ({
      ...t,
      y: tgtTop + tgtSized.slice(0, i).reduce((s, x) => s + x.h + gap, 0),
    }))
    const tgtById = new Map<string, (typeof tgtNodes)[number]>(
      tgtNodes.map((n) => [n.engine.id, n]),
    )

    // ribbons — ordered source top→bottom, engine order within a source;
    // each ribbon's slice offset is a prefix sum over earlier ribbons.
    const ordered: {
      sn: (typeof srcNodes)[number]
      tn: (typeof tgtNodes)[number]
      value: number
    }[] = []
    for (const sn of srcNodes) {
      for (const e of activeEngines) {
        const l = links.find((x) => x.source === sn.name && x.target === e.id)
        const tn = tgtById.get(e.id)
        if (l && l.value > 0 && tn) ordered.push({ sn, tn, value: l.value })
      }
    }
    const x0 = padX + nodeW
    const x1 = w - padX - nodeW
    const xm = (x0 + x1) / 2
    const ribbons = ordered.map((o, i) => {
      const th = o.value * unit
      const prior = ordered.slice(0, i)
      const sy0 =
        o.sn.y + prior.filter((p) => p.sn === o.sn).reduce((s, p) => s + p.value * unit, 0)
      const ty0 =
        o.tn.y + prior.filter((p) => p.tn === o.tn).reduce((s, p) => s + p.value * unit, 0)
      const sy1 = sy0 + th
      const ty1 = ty0 + th
      return {
        d:
          `M ${x0} ${sy0} C ${xm} ${sy0} ${xm} ${ty0} ${x1} ${ty0} ` +
          `L ${x1} ${ty1} C ${xm} ${ty1} ${xm} ${sy1} ${x0} ${sy1} Z`,
        color: o.tn.engine.color,
        label: `${o.sn.name} → ${engineMeta(o.tn.engine.id).label} · ${o.value}`,
      }
    })
    return { srcNodes, tgtNodes, ribbons }
  }, [links, w, height])

  return (
    <div ref={ref} className={cn("relative", className)} style={{ height }}>
      {model ? (
        <svg width={w} height={height} role="img">
          {model.ribbons.map((rb, i) => (
            <path
              key={i}
              d={rb.d}
              fill={rb.color}
              opacity={hovered == null ? 0.34 : hovered === i ? 0.72 : 0.12}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{rb.label}</title>
            </path>
          ))}
          {model.srcNodes.map((n) => (
            <g key={n.name}>
              <rect
                x={padX}
                y={n.y}
                width={nodeW}
                height={Math.max(2, n.h)}
                rx={1.5}
                fill="var(--chrome-text)"
                opacity={0.55}
              />
              <text
                x={padX - 6}
                y={n.y + n.h / 2 + 3}
                textAnchor="end"
                fontSize={9}
                className="font-mono"
                fill="var(--foreground)"
              >
                {n.name}
              </text>
              <text
                x={padX - 6}
                y={n.y + n.h / 2 + 13}
                textAnchor="end"
                fontSize={8}
                className="font-mono"
                fill="var(--chrome-text)"
                opacity={0.6}
              >
                {n.total} decision{n.total === 1 ? "" : "s"}
              </text>
            </g>
          ))}
          {model.tgtNodes.map((n) => (
            <g key={n.engine.id}>
              <rect
                x={w - padX - nodeW}
                y={n.y}
                width={nodeW}
                height={Math.max(2, n.h)}
                rx={1.5}
                fill={n.engine.color}
                opacity={0.9}
              />
              <text
                x={w - padX + 6}
                y={n.y + n.h / 2 + 3}
                textAnchor="start"
                fontSize={9}
                className="font-mono"
                fill="var(--foreground)"
              >
                {n.engine.label}
              </text>
              <text
                x={w - padX + 6}
                y={n.y + n.h / 2 + 13}
                textAnchor="start"
                fontSize={8}
                className="font-mono"
                fill="var(--chrome-text)"
                opacity={0.6}
              >
                {n.total} routed
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <div className="grid h-full place-items-center text-[11px] text-chrome-text/45">
          No routing decisions recorded yet.
        </div>
      )}
    </div>
  )
}

// ── FlowDiagram3 — decision source → engine → placement ─────────────
//
// The "all" pathways view in CAUSAL order: the router picks the source rule
// (why) and the engine (what) at decision time; dispatch draws the node
// (where) last, so placement is the terminus. Both ribbon halves carry the
// engine's color — a choice flows in from its source and out to the machines
// that served it. Execution-weighted by necessity — only executions know
// where dispatch landed (decisions can't claim a node under rotation). The
// single-node pill views keep the classic two-column diagram.

export interface FlowTriple {
  source: string
  /** engine (flow-target id, physical-path split included) */
  mid: string
  /** placement — brain, warren name, or hare */
  target: string
  value: number
}

const SEP = "\u001f"

function placementColor(name: string): string {
  if (name === "brain" || name === "hare" || name.startsWith("hare")) return "var(--main)"
  return "var(--success, #3fb950)"
}

export function FlowDiagram3({
  triples,
  height = 232,
  className,
}: {
  triples: FlowTriple[]
  height?: number
  className?: string
}) {
  const [ref, w] = useElementWidth<HTMLDivElement>()
  const [hovered, setHovered] = useState<string | null>(null)

  const padX = 104
  const nodeW = 9
  const gap = 13

  const model = useMemo(() => {
    const grand = triples.reduce((s, t) => s + t.value, 0)
    if (grand <= 0 || w <= 0) return null

    const totals = (key: (t: FlowTriple) => string) => {
      const m = new Map<string, number>()
      for (const t of triples) m.set(key(t), (m.get(key(t)) ?? 0) + t.value)
      return m
    }
    const srcTotals = totals((t) => t.source)
    const midTotals = totals((t) => t.mid)
    const tgtTotals = totals((t) => t.target)

    const sources = [...srcTotals.entries()].sort((a, b) => b[1] - a[1])
    const engines = [...midTotals.entries()]
      .filter(([, total]) => total > 0)
      .sort((a, b) => {
        const ka = engineFlowOrder(a[0])
        const kb = engineFlowOrder(b[0])
        return ka[0] - kb[0] || ka[1] - kb[1]
      })
      .map(([id]) => engineMeta(id))
    const placements = [...tgtTotals.entries()].sort((a, b) =>
      a[0] === "brain" ? -1 : b[0] === "brain" ? 1 : b[1] - a[1],
    )

    const avail = (n: number) => height - Math.max(0, n - 1) * gap
    const unit =
      Math.max(0, Math.min(avail(sources.length), avail(engines.length), avail(placements.length))) /
      grand
    if (unit <= 0) return null

    const column = (entries: [string, number][]) => {
      const contentH =
        entries.reduce((s, [, t]) => s + t * unit, 0) + Math.max(0, entries.length - 1) * gap
      const top = (height - contentH) / 2
      return entries.map(([name, total], i) => ({
        name,
        total,
        h: total * unit,
        y: top + entries.slice(0, i).reduce((s, [, t]) => s + t * unit + gap, 0),
      }))
    }
    const srcNodes = column(sources)
    const midSized = engines.map((e) => [e.id, midTotals.get(e.id) ?? 0] as [string, number])
    const midNodes = column(midSized).map((n, i) => ({ ...n, engine: engines[i] }))
    const tgtNodes = column(placements)

    const srcById = new Map(srcNodes.map((n) => [n.name, n]))
    const midById = new Map<string, (typeof midNodes)[number]>(midNodes.map((n) => [n.engine.id, n]))
    const tgtById = new Map(tgtNodes.map((n) => [n.name, n]))

    const xL = padX + nodeW
    const xM0 = w / 2 - nodeW / 2
    const xM1 = xM0 + nodeW
    const xR = w - padX - nodeW

    // left ribbons: (source → mid); right ribbons: (mid → target). Each is an
    // aggregation of the triples; slice offsets are prefix sums per node side.
    const aggPairs = (a: (t: FlowTriple) => string, b: (t: FlowTriple) => string) => {
      const m = new Map<string, { a: string; b: string; value: number }>()
      for (const t of triples) {
        const key = `${a(t)}${SEP}${b(t)}`
        const ex = m.get(key)
        if (ex) ex.value += t.value
        else m.set(key, { a: a(t), b: b(t), value: t.value })
      }
      return [...m.values()]
    }
    const leftLinks = aggPairs((t) => t.source, (t) => t.mid).sort(
      (p, q) =>
        (srcById.get(p.a)?.y ?? 0) - (srcById.get(q.a)?.y ?? 0) ||
        (midById.get(p.b)?.y ?? 0) - (midById.get(q.b)?.y ?? 0),
    )
    const rightLinks = aggPairs((t) => t.mid, (t) => t.target).sort(
      (p, q) =>
        (midById.get(p.a)?.y ?? 0) - (midById.get(q.a)?.y ?? 0) ||
        (tgtById.get(p.b)?.y ?? 0) - (tgtById.get(q.b)?.y ?? 0),
    )

    const ribbonPath = (x0: number, x1: number, sy0: number, ty0: number, th: number): string => {
      const xm = (x0 + x1) / 2
      const sy1 = sy0 + th
      const ty1 = ty0 + th
      return (
        `M ${x0} ${sy0} C ${xm} ${sy0} ${xm} ${ty0} ${x1} ${ty0} ` +
        `L ${x1} ${ty1} C ${xm} ${ty1} ${xm} ${sy1} ${x0} ${sy1} Z`
      )
    }

    const srcOut = new Map<string, number>()
    const midIn = new Map<string, number>()
    const left = leftLinks.flatMap((l, i) => {
      const sn = srcById.get(l.a)
      const mn = midById.get(l.b)
      if (!sn || !mn) return []
      const th = l.value * unit
      const sy = sn.y + (srcOut.get(l.a) ?? 0)
      const ty = mn.y + (midIn.get(l.b) ?? 0)
      srcOut.set(l.a, (srcOut.get(l.a) ?? 0) + th)
      midIn.set(l.b, (midIn.get(l.b) ?? 0) + th)
      return [
        {
          id: `L${i}`,
          d: ribbonPath(xL, xM0, sy, ty, th),
          color: engineMeta(l.b).color,
          label: `${l.a} → ${engineMeta(l.b).label} · ${l.value}`,
        },
      ]
    })
    const midOut = new Map<string, number>()
    const tgtIn = new Map<string, number>()
    const right = rightLinks.flatMap((l, i) => {
      const mn = midById.get(l.a)
      const tn = tgtById.get(l.b)
      if (!mn || !tn) return []
      const th = l.value * unit
      const sy = mn.y + (midOut.get(l.a) ?? 0)
      const ty = tn.y + (tgtIn.get(l.b) ?? 0)
      midOut.set(l.a, (midOut.get(l.a) ?? 0) + th)
      tgtIn.set(l.b, (tgtIn.get(l.b) ?? 0) + th)
      return [
        {
          id: `R${i}`,
          d: ribbonPath(xM1, xR, sy, ty, th),
          color: engineMeta(l.a).color,
          label: `${engineMeta(l.a).label} → ${l.b} · ${l.value}`,
        },
      ]
    })
    return { srcNodes, midNodes, tgtNodes, ribbons: [...left, ...right], xM0 }
  }, [triples, w, height])

  return (
    <div ref={ref} className={cn("relative", className)} style={{ height }}>
      {model ? (
        <svg width={w} height={height} role="img">
          {model.ribbons.map((rb) => (
            <path
              key={rb.id}
              d={rb.d}
              fill={rb.color}
              opacity={hovered == null ? 0.3 : hovered === rb.id ? 0.72 : 0.1}
              onMouseEnter={() => setHovered(rb.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{rb.label}</title>
            </path>
          ))}
          {model.srcNodes.map((n) => (
            <g key={n.name}>
              <rect x={padX} y={n.y} width={nodeW} height={Math.max(2, n.h)} rx={1.5} fill="var(--chrome-text)" opacity={0.55} />
              <text x={padX - 6} y={n.y + n.h / 2 + 3} textAnchor="end" fontSize={9} className="font-mono" fill="var(--foreground)">
                {n.name}
              </text>
              <text x={padX - 6} y={n.y + n.h / 2 + 13} textAnchor="end" fontSize={8} className="font-mono" fill="var(--chrome-text)" opacity={0.6}>
                {n.total} run{n.total === 1 ? "" : "s"}
              </text>
            </g>
          ))}
          {model.midNodes.map((n) => (
            <g key={n.engine.id}>
              <rect x={model.xM0} y={n.y} width={nodeW} height={Math.max(2, n.h)} rx={1.5} fill={n.engine.color} opacity={0.9} />
              <text x={model.xM0 + nodeW / 2} y={n.y - 4} textAnchor="middle" fontSize={9} className="font-mono" fill="var(--foreground)">
                {engineMeta(n.engine.id).label}
              </text>
            </g>
          ))}
          {model.tgtNodes.map((n) => (
            <g key={n.name}>
              <rect x={w - padX - nodeW} y={n.y} width={nodeW} height={Math.max(2, n.h)} rx={1.5} fill={placementColor(n.name)} opacity={0.85} />
              <text x={w - padX + 6} y={n.y + n.h / 2 + 3} textAnchor="start" fontSize={9} className="font-mono" fill="var(--foreground)">
                {n.name}
              </text>
              <text x={w - padX + 6} y={n.y + n.h / 2 + 13} textAnchor="start" fontSize={8} className="font-mono" fill="var(--chrome-text)" opacity={0.6}>
                {n.total} served
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <div className="grid h-full place-items-center text-[11px] text-chrome-text/45">
          No routed executions in this window yet.
        </div>
      )}
    </div>
  )
}
