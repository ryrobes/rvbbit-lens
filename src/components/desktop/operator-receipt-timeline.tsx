"use client"

import { useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { RvbbitOperator, OperatorReceipt, SubCall } from "@/lib/rvbbit/operators"
import { mapTrace } from "@/lib/rvbbit/operator-graph"
import { accentForSubCallKind } from "./operator-graph"

/**
 * Horizontal trace lane — the second view of an operator receipt
 * alongside the graph. Each sub_call is a rect with width proportional
 * to its `latency_ms`, color by kind. Hover shows kind + step + tokens
 * + latency; click selects the corresponding graph node so the user
 * can ping-pong between "show me where" (graph) and "show me when"
 * (timeline).
 *
 * Cumulative-sequential layout: parallel takes execute concurrently in
 * the runtime, but this view treats the trace as a linear log. That
 * matches how `sub_calls` is recorded (one entry per call, in order)
 * and is the right approximation for the common single-take operator.
 */

interface OperatorReceiptTimelineProps {
  op: RvbbitOperator
  receipt: OperatorReceipt
  selectedNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
}

interface Cell {
  index: number
  call: SubCall
  nodeId: string | null
  start: number
  width: number
}

export function OperatorReceiptTimeline({
  op,
  receipt,
  selectedNodeId,
  onSelectNode,
}: OperatorReceiptTimelineProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Cell | null>(null)

  const cells = useMemo<Cell[]>(() => {
    const subCalls = receipt.sub_calls ?? []
    if (subCalls.length === 0) return []
    const trace = mapTrace(op, receipt)
    // Walk the trace map in the same order as sub_calls — mapTrace
    // preserves source order per node, so we can reverse-index by
    // popping the head as we encounter each call.
    const cursor = new Map<string, number>()
    const nodeIdFor = (sc: SubCall): string | null => {
      for (const [nodeId, calls] of trace.entries()) {
        const at = cursor.get(nodeId) ?? 0
        if (at < calls.length && calls[at] === sc) {
          cursor.set(nodeId, at + 1)
          return nodeId
        }
      }
      return null
    }

    const totalLatency = subCalls.reduce((sum, c) => sum + (c.latency_ms ?? 0), 0)
    const totalForLayout = totalLatency > 0 ? totalLatency : subCalls.length
    let acc = 0
    return subCalls.map((sc, i) => {
      const lat = sc.latency_ms ?? 0
      const layoutWidth = totalLatency > 0 ? lat : 1
      const cell: Cell = {
        index: i,
        call: sc,
        nodeId: nodeIdFor(sc),
        start: (acc / totalForLayout) * 100,
        width: Math.max(1.5, (layoutWidth / totalForLayout) * 100),
      }
      acc += layoutWidth
      return cell
    })
  }, [op, receipt])

  const totalLatency = receipt.latency_ms || cells.reduce((s, c) => s + (c.call.latency_ms ?? 0), 0)

  if (cells.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-chrome-bg/20 text-[10px] text-chrome-text/45">
        no sub_calls recorded on this receipt
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-1 bg-chrome-bg/20 px-3 py-2">
      <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wider text-chrome-text/55">
        <span>trace</span>
        <span className="font-mono normal-case tracking-normal text-foreground">
          {cells.length} call{cells.length === 1 ? "" : "s"}
        </span>
        <span className="text-chrome-text/40">·</span>
        <span className="font-mono tabular-nums normal-case tracking-normal text-foreground">
          {fmtMs(totalLatency)}
        </span>
        <span className="text-chrome-text/40">·</span>
        <span className="font-mono tabular-nums normal-case tracking-normal text-chrome-text/65">
          {receipt.n_tokens_in}→{receipt.n_tokens_out} tok
        </span>
        {receipt.error ? (
          <span className="rounded bg-danger/15 px-1 normal-case tracking-normal text-danger">
            error
          </span>
        ) : null}
        <span className="ml-auto font-mono tabular-nums normal-case tracking-normal text-chrome-text/55">
          hover for detail · click to jump
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative h-7 w-full rounded border border-chrome-border/40 bg-doc-bg"
        onMouseLeave={() => setHover(null)}
      >
        {cells.map((c) => {
          const errored = !!c.call.error
          const isSelected = c.nodeId != null && c.nodeId === selectedNodeId
          const base = accentForSubCallKind(c.call.kind)
          return (
            <button
              key={c.index}
              type="button"
              onClick={() => onSelectNode(c.nodeId)}
              onMouseEnter={() => setHover(c)}
              className={cn(
                "absolute inset-y-1 rounded-sm transition",
                "hover:brightness-125 focus:outline-none",
              )}
              style={{
                left: `${c.start}%`,
                width: `${c.width}%`,
                background: errored
                  ? "color-mix(in oklch, var(--danger) 55%, transparent)"
                  : `color-mix(in oklch, ${base} 75%, transparent)`,
                boxShadow: isSelected
                  ? `0 0 0 1.5px var(--main), 0 0 6px color-mix(in oklch, var(--main) 35%, transparent)`
                  : errored
                    ? `inset 0 0 0 1px var(--danger)`
                    : undefined,
              }}
              title={`${c.call.kind} · ${c.call.step}`}
            />
          )
        })}
      </div>

      {/* tick row — shows latency under the bar */}
      <div className="relative h-3 w-full">
        {cells.map((c) => (
          <span
            key={c.index}
            className="absolute -translate-x-1/2 font-mono text-[9px] tabular-nums text-chrome-text/45"
            style={{ left: `${c.start + c.width / 2}%` }}
          >
            {fmtMsShort(c.call.latency_ms ?? 0)}
          </span>
        ))}
      </div>

      {/* hover tooltip */}
      {hover ? (
        <div
          className="pointer-events-none mt-1 inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 self-start rounded border border-chrome-border bg-secondary-background px-2 py-1 text-[10px] text-foreground"
          style={{
            // Anchor below the bar; absolute is fine since parent is flex column
          }}
        >
          <span
            className="inline-flex items-center gap-1 rounded px-1 font-mono uppercase tracking-wider"
            style={{
              background: `color-mix(in oklch, ${accentForSubCallKind(hover.call.kind)} 18%, transparent)`,
              color: accentForSubCallKind(hover.call.kind),
            }}
          >
            {hover.call.kind}
          </span>
          <span className="font-mono text-foreground">{hover.call.step}</span>
          {hover.call.model ? (
            <span className="font-mono text-chrome-text/65">{hover.call.model}</span>
          ) : null}
          <span className="font-mono tabular-nums text-chrome-text/85">
            {fmtMs(hover.call.latency_ms ?? 0)}
          </span>
          {(hover.call.tokens_in ?? 0) + (hover.call.tokens_out ?? 0) > 0 ? (
            <span className="font-mono tabular-nums text-chrome-text/65">
              {hover.call.tokens_in ?? 0}→{hover.call.tokens_out ?? 0} tok
            </span>
          ) : null}
          {hover.call.error ? (
            <span className="truncate text-danger">{hover.call.error}</span>
          ) : null}
          {hover.nodeId ? (
            <span className="ml-auto text-[9px] text-chrome-text/45">click to focus node</span>
          ) : null}
        </div>
      ) : (
        <div className="h-[26px]" />
      )}
    </div>
  )
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtMsShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0"
  if (ms < 1000) return `${Math.round(ms)}`
  return `${(ms / 1000).toFixed(1)}s`
}
