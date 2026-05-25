"use client"

import { useRef } from "react"
import { Grip, Maximize2, Minus, X, type LucideIcon } from "@/lib/icons"
import type { DesktopWindowState } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"

interface DesktopWindowProps {
  window: DesktopWindowState
  icon: LucideIcon
  children: React.ReactNode
  /** True when this window currently holds keyboard/visual focus. */
  focused: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMinimize: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  viewportScale?: number
}

const MIN_WIDTH = 320
const MIN_HEIGHT = 220
const MAX_WIDTH = 2400
const MAX_HEIGHT = 1800
const MIN_WORLD = -20000
const MAX_WORLD = 20000

export function DesktopWindow({
  window: w,
  icon: Icon,
  children,
  focused,
  onFocus,
  onClose,
  onMinimize,
  onMove,
  onResize,
  viewportScale = 1,
}: DesktopWindowProps) {
  const chrome = windowChrome(w.kind)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originWidth: number
    originHeight: number
  } | null>(null)

  function clamp(v: number) {
    if (!Number.isFinite(v)) return 0
    return Math.min(MAX_WORLD, Math.max(MIN_WORLD, v))
  }

  function onHeaderDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    onFocus(w.id)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: w.x,
      originY: w.y,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHeaderMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const s = Math.max(0.2, viewportScale)
    onMove(w.id, clamp(d.originX + (e.clientX - d.startX) / s), clamp(d.originY + (e.clientY - d.startY) / s))
  }
  function onHeaderUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  function onResizeDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onFocus(w.id)
    resizeRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originWidth: w.width,
      originHeight: w.height,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onResizeMove(e: React.PointerEvent<HTMLButtonElement>) {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    const s = Math.max(0.2, viewportScale)
    const nw = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, r.originWidth + (e.clientX - r.startX) / s))
    const nh = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, r.originHeight + (e.clientY - r.startY) / s))
    onResize(w.id, nw, nh)
  }
  function onResizeUp(e: React.PointerEvent<HTMLButtonElement>) {
    const r = resizeRef.current
    if (!r || r.pointerId !== e.pointerId) return
    resizeRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  if (w.minimized) return null

  return (
    <section
      data-rvbbit-window
      data-focused={focused ? "true" : "false"}
      className={cn(
        "pointer-events-auto absolute overflow-hidden rounded-md border transition-[background-color,backdrop-filter,box-shadow] duration-150",
        focused
          ? "bg-block-bg/95"
          : "bg-block-bg/55 backdrop-blur-[6px] saturate-[0.85]",
      )}
      style={{
        left: w.x,
        top: w.y,
        width: w.width,
        height: w.height,
        zIndex: w.zIndex,
        borderColor: chrome.border,
        // Unfocused windows get a shallower drop shadow and a half-strength
        // ring so the focused window sits visually forward.
        boxShadow: focused
          ? `0 24px 80px oklch(0% 0 0 / 0.62), 0 0 0 1px ${chrome.ring}`
          : `0 12px 40px oklch(0% 0 0 / 0.32), 0 0 0 1px color-mix(in oklch, ${chrome.ring} 45%, transparent)`,
      }}
      onMouseDown={() => onFocus(w.id)}
    >
      <div
        className={cn(
          "flex h-9 cursor-grab select-none items-center border-b px-2 active:cursor-grabbing transition-colors duration-150",
          focused ? "bg-chrome-bg/85" : "bg-chrome-bg/55",
        )}
        style={{ borderColor: chrome.headerBorder }}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded" style={{ backgroundColor: chrome.iconBg }}>
            <Icon className="h-3.5 w-3.5" style={{ color: chrome.icon }} />
          </div>
          <h2 className="truncate text-[12px] font-semibold text-foreground">{w.title}</h2>
        </div>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onMinimize(w.id)}
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.055] text-chrome-text transition-colors hover:bg-foreground/[0.105] hover:text-foreground"
            title="Minimize"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.035] text-chrome-text/30"
            title="Drag the lower-right handle to resize"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onClose(w.id)}
            className="grid h-6 w-6 place-items-center rounded bg-foreground/[0.055] text-chrome-text transition-colors hover:bg-danger/20 hover:text-danger"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content area lets the section's background show through so the
          glass blur is visible across the whole window when unfocused.
          When focused, the section is opaque enough to read as solid. */}
      <div className="h-[calc(100%-2.25rem)] overflow-hidden">{children}</div>

      <button
        type="button"
        aria-label="Resize"
        className="absolute bottom-0 right-0 grid h-6 w-6 cursor-nwse-resize place-items-center rounded-tl bg-foreground/[0.035] text-chrome-text/35 transition-colors hover:bg-foreground/[0.08] hover:text-foreground/65"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      >
        <Grip className="h-3.5 w-3.5 rotate-45" />
      </button>
    </section>
  )
}

interface ChromeColors {
  border: string
  ring: string
  headerBorder: string
  icon: string
  iconBg: string
}

// Every chrome color is a CSS expression that resolves at paint time.
// Per-kind hue lives in --win-<kind>-h (defined per theme in globals.css);
// shared lightness/chroma live in --win-l, --win-l-icon, --win-c. Changing
// any of those — by theme switch or by ImagePalette derivation — re-tints
// every window without re-rendering React.
const KINDS = [
  "finder",
  "data",
  "query-document",
  "artifact",
  "view-app",
  "view-app-builder",
  "view-apps",
  "system-objects",
  "extensions",
  "rvbbit-cache",
  "connections",
  "palette",
  "pg-monitor",
] as const

function buildChrome(kind: string): ChromeColors {
  const h = `var(--win-${kind}-h)`
  return {
    border: `oklch(var(--win-l) var(--win-c) ${h} / 0.34)`,
    ring: `oklch(var(--win-l) var(--win-c) ${h} / 0.18)`,
    headerBorder: `oklch(var(--win-l) var(--win-c) ${h} / 0.16)`,
    icon: `oklch(var(--win-l-icon) var(--win-c) ${h} / 0.86)`,
    iconBg: `oklch(var(--win-l) var(--win-c) ${h} / 0.12)`,
  }
}

const CHROME: Record<string, ChromeColors> = Object.fromEntries(
  KINDS.map((k) => [k, buildChrome(k)]),
)

function windowChrome(kind: string): ChromeColors {
  return CHROME[kind] ?? CHROME.finder
}
