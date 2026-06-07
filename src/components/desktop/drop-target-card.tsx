"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Layers, type LucideIcon } from "@/lib/icons"
import { returnTypeIcon, type SemanticOpTile } from "@/lib/desktop/semantic-ops"

const ACCENT = "var(--brand-operators)"

/**
 * Detail card for a hovered drop tile, shown WHILE a column is being dragged.
 * Short tile labels can't say much, so this explains what the target does — its
 * description, full signature, return type, and any extra args the user will be
 * prompted for on drop. Style + placement mirror the Finder hover card
 * (portal, fixed, self-measured, opacity fade-in); it's pointer-events-none so
 * it never intercepts the drag or a drop.
 */
export interface DropTargetInfo {
  icon: LucideIcon
  /** Friendly title, e.g. "Classify" or "Group by". */
  title: string
  /** Mono subtitle, e.g. "rvbbit.classify". */
  mono?: string
  /** Small chip, e.g. the return type ("text"/"bool"/"float8"). */
  typeChip?: string
  /** Shape word appended to the mono line ("scalar", …). */
  shape?: string
  /** Accent color (CSS expression). */
  accent: string
  description?: string
  /** Full call signature, e.g. "rvbbit.classify(notes, categories)". */
  signature?: string
  /** Extra args (beyond the dragged column) the user binds on drop. */
  extraArgs?: { name: string; type: string }[]
  /** Footer note about the drop behavior. */
  note?: string
}

/**
 * Hover-card info for a SCALAR op tile (per-row projection). Shared by the
 * on-block overlay and the top-center palette so both surfaces explain the op
 * identically (description, signature, args-to-bind, cost note).
 */
export function scalarDropInfo(tile: SemanticOpTile, colName: string): DropTargetInfo {
  const op = tile.op.operator
  const extra = op.argNames.slice(1)
  return {
    icon: returnTypeIcon(tile.returnType),
    title: tile.label,
    mono: `rvbbit.${op.name}`,
    typeChip: tile.returnType,
    shape: op.shape,
    accent: ACCENT,
    description: op.description,
    signature: `rvbbit.${op.name}(${[colName, ...extra].join(", ")})`,
    extraArgs: extra.map((name, i) => ({ name, type: op.argTypes[i + 1] ?? "text" })),
    note: tile.needsArgs
      ? "On drop you'll fill these args, then it previews calls & cost on the Explain tab — nothing runs yet."
      : "On drop it previews the LLM/sidecar calls & cost on the Explain tab — nothing runs until you hit Run.",
  }
}

/**
 * Hover-card info for a DIMENSION op tile (fan-out → group-by). Distinct copy:
 * it doesn't add a per-row column, it explodes the column into label rows and
 * counts them (a frequency table).
 */
export function dimensionDropInfo(tile: SemanticOpTile, colName: string): DropTargetInfo {
  const op = tile.op.operator
  return {
    icon: Layers,
    title: tile.label,
    mono: `rvbbit.${op.name}`,
    shape: "dimension · group-by",
    accent: ACCENT,
    description: op.description,
    signature: `LATERAL rvbbit.${op.name}(${colName}) → GROUP BY label`,
    note: "On drop it fans this column out into label rows and counts them — a frequency table. Previews calls & cost on the Explain tab first; nothing runs until you Run.",
  }
}

const CARD_W = 268

export function DropTargetCard({
  info,
  panelRect,
  tileRect,
}: {
  info: DropTargetInfo
  /** Rect of the drop panel; the card docks just outside it. */
  panelRect: DOMRect | null
  /** Rect of the hovered tile; the card aligns its top to it. */
  tileRect: DOMRect | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({ left: 0, top: 0, ready: false })
  const [shown, setShown] = useState(false)

  // Dock to the right of the panel (so it never covers the tiles); flip to the
  // left if it would overflow, clamp inside the viewport. Vertically follow the
  // hovered tile.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const cw = el.offsetWidth || CARD_W
    const ch = el.offsetHeight
    const m = 8
    const gap = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const anchor = panelRect ?? tileRect
    let left = (anchor ? anchor.right : vw / 2) + gap
    if (left + cw > vw - m) {
      left = (anchor ? anchor.left : vw / 2) - cw - gap
      if (left < m) left = Math.max(m, vw - cw - m)
    }
    let top = tileRect ? tileRect.top : anchor ? anchor.top : vh / 2
    top = Math.min(Math.max(m, top), vh - ch - m)
    setPos({ left, top, ready: true })
  }, [panelRect, tileRect, info])

  // Fade in only after it's placed, so it never slides in from 0,0.
  useEffect(() => {
    if (!pos.ready) return
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [pos.ready])

  if (typeof document === "undefined") return null
  const Icon = info.icon

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ position: "fixed", left: pos.left, top: pos.top, width: CARD_W, opacity: shown ? 1 : 0 }}
      className="pointer-events-none z-[75] max-h-[80vh] overflow-y-auto rounded-md border border-chrome-border bg-chrome-bg/95 p-2.5 text-chrome-text shadow-lg backdrop-blur-md motion-safe:transition-opacity motion-safe:duration-100"
    >
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: info.accent }} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{info.title}</span>
        {info.typeChip ? (
          <span
            className="shrink-0 rounded-full border px-1.5 py-0 font-mono text-[8px] uppercase tracking-wide"
            style={{ borderColor: `color-mix(in oklch, ${info.accent} 40%, transparent)`, color: info.accent }}
          >
            {info.typeChip}
          </span>
        ) : null}
      </div>

      {info.mono ? (
        <div className="mt-1 font-mono text-[10px] text-chrome-text/55">
          {info.mono}
          {info.shape ? <span className="text-chrome-text/35"> · {info.shape}</span> : null}
        </div>
      ) : null}

      {info.description ? (
        <div className="mt-1.5 text-[11px] leading-snug text-chrome-text/80">{info.description}</div>
      ) : null}

      {info.signature ? (
        <div className="mt-1.5 break-all rounded border border-chrome-border/50 bg-foreground/[0.03] px-1.5 py-1 font-mono text-[10px] text-chrome-text/70">
          {info.signature}
        </div>
      ) : null}

      {info.extraArgs && info.extraArgs.length > 0 ? (
        <div className="mt-1.5">
          <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">needs</div>
          <div className="mt-0.5 space-y-0.5">
            {info.extraArgs.map((a) => (
              <div key={a.name} className="flex items-baseline gap-1.5 text-[10px]">
                <span className="text-foreground/80">{a.name}</span>
                <span className="font-mono text-chrome-text/40">{a.type}</span>
              </div>
            ))}
          </div>
          <div className="mt-0.5 text-[9px] italic text-chrome-text/40">you’ll be prompted on drop</div>
        </div>
      ) : null}

      {info.note ? (
        <div className="mt-1.5 border-t border-chrome-border/40 pt-1.5 text-[9px] leading-snug text-chrome-text/45">
          {info.note}
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
