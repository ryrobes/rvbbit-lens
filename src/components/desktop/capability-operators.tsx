"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Sigma } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { OperatorDef } from "@/lib/rvbbit/capabilities"

/**
 * The SQL operators a capability registers — the thing people actually
 * shop for. Rendered as prominent chips at the foot of a capability card;
 * hovering a chip raises a meta card (signature, shape, description) that
 * reuses the Finder hover-card styling.
 */

/** A chip's operator: the rich manifest def, or just a name for catalog
 *  rows that have no inline manifest. */
export type OpChip = Partial<OperatorDef> & { name: string }

function signature(op: OpChip): string {
  const args = (op.arg_names ?? [])
    .map((a, i) => {
      const t = op.arg_types?.[i]
      return t ? `${a} ${t}` : a
    })
    .join(", ")
  return `${op.name}(${args})`
}

const TT_W = 320

function OperatorTooltip({ op, anchor }: { op: OpChip; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  })
  const [shown, setShown] = useState(false)

  // Measure self, then place centred under the chip, flipping above on
  // bottom overflow and clamping inside the viewport — same approach as
  // the Finder hover card.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cw = el.offsetWidth || TT_W
    const ch = el.offsetHeight
    const m = 8
    let left = anchor.left + anchor.width / 2 - cw / 2
    left = Math.min(Math.max(m, left), window.innerWidth - cw - m)
    let top = anchor.bottom + 6
    if (top + ch > window.innerHeight - m) {
      const above = anchor.top - ch - 6
      top = above >= m ? above : Math.max(m, window.innerHeight - ch - m)
    }
    setPos({ left, top, ready: true })
  }, [anchor])

  useEffect(() => {
    if (!pos.ready) return
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [pos.ready])

  if (typeof document === "undefined") return null

  const hasMeta =
    !!op.description ||
    (op.arg_names?.length ?? 0) > 0 ||
    !!op.return_type ||
    !!op.shape ||
    !!op.infix_symbol ||
    !!op.infix_word

  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        width: TT_W,
        opacity: shown ? 1 : 0,
      }}
      className="pointer-events-none z-50 max-h-[80vh] overflow-y-auto rounded-md border border-chrome-border bg-chrome-bg/95 p-2.5 text-chrome-text shadow-lg backdrop-blur-md motion-safe:transition-opacity motion-safe:duration-100"
    >
      <div className="flex items-center gap-1.5">
        <Sigma className="h-3.5 w-3.5 shrink-0 text-brand-operators" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {op.name}
        </span>
        {op.return_type ? (
          <span className="shrink-0 rounded bg-brand-operators/10 px-1.5 py-px font-mono text-[9px] text-brand-operators">
            → {op.return_type}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 rounded bg-foreground/[0.04] px-2 py-1 font-mono text-[10px] leading-snug text-chrome-text/80">
        {signature(op)}
        {op.return_type ? (
          <span className="text-chrome-text/45"> → {op.return_type}</span>
        ) : null}
      </div>

      {op.description ? (
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/75">
          {op.description}
        </p>
      ) : null}

      {(op.shape || op.infix_symbol || op.infix_word || op.parser) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {op.shape ? <MetaPill label="shape" value={op.shape} /> : null}
          {op.infix_symbol ? <MetaPill label="infix" value={op.infix_symbol} /> : null}
          {op.infix_word ? <MetaPill label="infix" value={op.infix_word} /> : null}
          {op.parser ? <MetaPill label="parser" value={op.parser} /> : null}
        </div>
      ) : null}

      {!hasMeta ? (
        <p className="mt-1.5 text-[10px] text-chrome-text/45">
          No operator metadata in this catalog row.
        </p>
      ) : null}
    </div>,
    document.body,
  )
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-chrome-border/50 bg-foreground/[0.03] px-1.5 py-px text-[9px] text-chrome-text/65">
      <span className="uppercase tracking-wider text-chrome-text/45">{label}</span>
      <span className="font-mono text-chrome-text/80">{value}</span>
    </span>
  )
}

export function OperatorChips({
  operators,
  className,
}: {
  operators: OpChip[]
  className?: string
}) {
  const [hovered, setHovered] = useState<{ op: OpChip; rect: DOMRect } | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const clearTimers = () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current)
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }

  const open = useCallback((op: OpChip, el: HTMLElement) => {
    clearTimers()
    const rect = el.getBoundingClientRect()
    openTimer.current = window.setTimeout(() => setHovered({ op, rect }), 220)
  }, [])

  const close = useCallback(() => {
    clearTimers()
    closeTimer.current = window.setTimeout(() => setHovered(null), 100)
  }, [])

  useEffect(() => () => clearTimers(), [])

  if (operators.length === 0) return null

  return (
    <div className={cn("mt-2 border-t border-chrome-border/40 pt-2", className)}>
      <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
        <Sigma className="h-3 w-3 text-brand-operators" />
        operators
        <span className="font-mono text-chrome-text/35">{operators.length}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {operators.map((op) => (
          <span
            key={op.name}
            onMouseEnter={(e) => open(op, e.currentTarget)}
            onMouseLeave={close}
            className="cursor-default rounded border border-brand-operators/40 bg-brand-operators/10 px-1.5 py-0.5 font-mono text-[10px] text-brand-operators transition-colors hover:border-brand-operators/70 hover:bg-brand-operators/20"
          >
            {op.name}
          </span>
        ))}
      </div>
      {hovered ? <OperatorTooltip op={hovered.op} anchor={hovered.rect} /> : null}
    </div>
  )
}
