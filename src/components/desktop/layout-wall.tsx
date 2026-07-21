"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DesktopParamValue } from "@/lib/desktop/types"
import { Maximize2, Minimize2, AppWindow, X } from "@/lib/icons"
import { PlateWindow } from "./plate-window"

/**
 * LayoutWall — full-screen "wall" mode for a plate layout
 * (rvbbit-sql/docs/PLATE_COMPOSE_PLAN.md). Panes are chromeless
 * PlateWindows absolutely positioned by their fraction rects (percentages
 * do the per-axis design→viewport translation; content is never
 * transform-scaled). The desktop stays behind, dimmed. The wall owns
 * arrangement, never behavior: navigation from inside panes is the plates'
 * own rv-open vocabulary — `plate:x` opens a wall-local window (the modal
 * layer), `plate:x@pane` renders into the named pane (the slot gesture).
 * ESC unwinds: modal → zoom → wall.
 */

export interface WallLayoutPane {
  id: string
  plate?: string
  x: number
  y: number
  w: number
  h: number
  z?: number
  params?: Record<string, unknown>
  slot?: boolean
  title?: string
}

export interface WallLayout {
  layout_id: string
  kit: string | null
  title: string
  description: string | null
  design: { width: number; height: number; min_width?: number }
  panes: WallLayoutPane[]
}

export function LayoutWall({
  layoutId,
  activeConnectionId,
  onClose,
  onOpenSql,
  onOpenApp,
  onEmitParam,
  onPopOut,
  onAssistant,
  busParams,
}: {
  layoutId: string
  activeConnectionId: string | null
  onClose: () => void
  onOpenSql: (title: string, sql: string, run: boolean) => void
  onOpenApp?: (appId: string, params: Record<string, string>) => void
  /** Bus write, attributed per pane by the shell wrapper. */
  onEmitParam?: (paneId: string, field: string, value: unknown) => void
  /** Hover-pill escape hatch: open this pane's plate as a real desktop window. */
  onPopOut?: (plateId: string) => void
  /** Summon the assistant OVER the wall (the dock renders at z-80) — the
   *  same brain chat-first users already know, one click from the Hub. */
  onAssistant?: () => void
  busParams?: DesktopParamValue[]
}) {
  const [layout, setLayout] = useState<WallLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [linkCopied, setLinkCopied] = useState(false)
  // Slot targeting: rv-open="plate:x@pane" replaces the pane's occupant.
  const [occupants, setOccupants] = useState<Record<string, string>>({})
  // Wall-local windows — the modal layer for transient plates (edit/create).
  const [modals, setModals] = useState<Array<{ key: string; plateId: string }>>([])
  const [zoomed, setZoomed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLayout(null)
    setError(null)
    setOccupants({})
    setModals([])
    setZoomed(null)
    void fetch("/api/layout/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: activeConnectionId, layoutId }),
    })
      .then((r) => r.json())
      .then((body: { ok: boolean; layout?: WallLayout; error?: string }) => {
        if (cancelled) return
        if (!body.ok || !body.layout) setError(body.error ?? "layout not found")
        else setLayout(body.layout)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, layoutId])

  // ESC unwinds one level at a time: top modal → zoom → the wall itself.
  // Read through refs and keep the updaters PURE — a side effect inside a
  // setState updater double-fires under StrictMode (unzoom was also
  // closing the wall).
  const modalsRef = useRef(modals)
  modalsRef.current = modals
  const zoomedRef = useRef(zoomed)
  zoomedRef.current = zoomed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      if (modalsRef.current.length > 0) {
        setModals((m) => m.slice(0, -1))
        return
      }
      if (zoomedRef.current != null) {
        setZoomed(null)
        return
      }
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const paneIds = useMemo(() => new Set((layout?.panes ?? []).map((p) => p.id)), [layout])

  // The plates' own navigation vocabulary, wall-interpreted.
  const openFromPane = useCallback(
    (target: string) => {
      const at = target.lastIndexOf("@")
      if (at > 0) {
        const pane = target.slice(at + 1)
        const plate = target.slice(0, at)
        if (paneIds.has(pane)) {
          setOccupants((o) => ({ ...o, [pane]: plate }))
          return
        }
      }
      const plate = at > 0 ? target.slice(0, at) : target
      setModals((m) => [...m, { key: `${plate}:${m.length}:${Math.random().toString(36).slice(2, 8)}`, plateId: plate }])
    },
    [paneIds],
  )

  const panes = useMemo(
    () => [...(layout?.panes ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)),
    [layout],
  )

  return (
    <div className="fixed inset-0 z-[60]" data-rvbbit-capture-exclude>
      {/* Dim the desktop, keep it present — render parity, and ESC is home. */}
      <div className="absolute inset-0 bg-background/85 backdrop-blur-[3px]" onClick={onClose} />
      {/* Identity pill — the only wall chrome. */}
      <div className="absolute right-3 top-2 z-[75] flex items-center gap-2 rounded-full border border-chrome-border/60 bg-chrome-bg/80 px-2.5 py-0.5 text-[11px] text-chrome-text/70 backdrop-blur">
        <span className="text-foreground">{layout?.title ?? layoutId}</span>
        <button
          type="button"
          onClick={() => {
            // The hand-out link: /hub for the Hub, /wall/<id> for any
            // other layout — the pretty redirect paths, stable to share.
            const url = `${window.location.origin}${layoutId === "hub" ? "/hub" : `/wall/${encodeURIComponent(layoutId)}`}`
            void navigator.clipboard.writeText(url).then(() => {
              setLinkCopied(true)
              setTimeout(() => setLinkCopied(false), 1600)
            })
          }}
          className="text-chrome-text/60 hover:text-foreground"
          title="Copy a link straight to this wall"
        >
          {linkCopied ? "✓" : "⧉"}
        </button>
        {onAssistant ? (
          <button type="button" onClick={onAssistant} className="text-chrome-text/60 hover:text-foreground" title="Summon Assistant">
            ✦
          </button>
        ) : null}
        <span className="text-chrome-text/40">esc</span>
        <button type="button" onClick={onClose} className="text-chrome-text/50 hover:text-foreground" title="Back to the desktop">
          <X className="h-3 w-3" />
        </button>
      </div>
      {error ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="rounded-md border border-destructive/40 bg-background/90 px-4 py-3 text-[13px] text-destructive">{error}</div>
        </div>
      ) : null}
      {panes.map((pane) => {
        const occupant = occupants[pane.id] ?? pane.plate
        const isZoomed = zoomed === pane.id
        if (zoomed != null && !isZoomed) return null
        const rect = isZoomed
          ? { left: "2%", top: "3%", width: "96%", height: "94%" }
          : {
              left: `${pane.x * 100}%`,
              top: `${pane.y * 100}%`,
              width: `${pane.w * 100}%`,
              height: `${pane.h * 100}%`,
            }
        return (
          <div
            key={pane.id}
            className="group/pane absolute overflow-hidden rounded-lg"
            style={{ ...rect, zIndex: isZoomed ? 70 : 61 + (pane.z ?? 0), background: "color-mix(in oklch, var(--doc-bg) 88%, transparent)" }}
          >
            {/* Hover pill: the strip's utilities, wall edition. */}
            <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1 rounded-full border border-chrome-border/50 bg-chrome-bg/85 px-1.5 py-0.5 opacity-0 backdrop-blur transition-opacity group-hover/pane:opacity-100">
              <span className="max-w-40 truncate text-[10px] text-chrome-text/60">{pane.title ?? occupant ?? pane.id}</span>
              <button
                type="button"
                onClick={() => setZoomed(isZoomed ? null : pane.id)}
                title={isZoomed ? "Unzoom" : "Zoom this pane"}
                className="text-chrome-text/50 hover:text-foreground"
              >
                {isZoomed ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              </button>
              {occupant && onPopOut ? (
                <button
                  type="button"
                  onClick={() => onPopOut(occupant)}
                  title="Open as a desktop window"
                  className="text-chrome-text/50 hover:text-foreground"
                >
                  <AppWindow className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            {occupant ? (
              <PlateWindow
                key={occupant}
                plateId={occupant}
                activeConnectionId={activeConnectionId}
                chromeless
                pinnedParams={pane.params}
                busParams={busParams}
                onOpenSql={onOpenSql}
                onOpenPlate={openFromPane}
                onOpenApp={onOpenApp}
                onEmitParam={(field, value) => onEmitParam?.(pane.id, field, value)}
              />
            ) : (
              <div className="grid h-full place-items-center text-[12px] text-chrome-text/35">
                {pane.title ?? pane.id}
              </div>
            )}
          </div>
        )
      })}
      {/* Wall-local windows: the modal layer for transient plates. */}
      {modals.map((modal, i) => (
        <div key={modal.key} className="absolute inset-0 grid place-items-center" style={{ zIndex: 72 + i }}>
          <div className="absolute inset-0 bg-background/50" onClick={() => setModals((m) => m.filter((x) => x.key !== modal.key))} />
          <div
            className="relative flex max-h-[86%] w-[min(760px,92vw)] flex-col overflow-hidden rounded-lg border border-chrome-border bg-doc-bg shadow-2xl"
            style={{ transform: `translate(${i * 14}px, ${i * 12}px)` }}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-chrome-border bg-chrome-bg/60 px-3 py-1.5 text-[12px]">
              <span className="truncate text-foreground">{modal.plateId}</span>
              <div className="flex items-center gap-2">
                {onPopOut ? (
                  <button
                    type="button"
                    onClick={() => {
                      // The breadcrumb rung: same plate, real desktop window.
                      onPopOut(modal.plateId)
                      setModals((m) => m.filter((x) => x.key !== modal.key))
                    }}
                    className="text-chrome-text/50 hover:text-foreground"
                    title="Open as a desktop window"
                  >
                    <AppWindow className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setModals((m) => m.filter((x) => x.key !== modal.key))}
                  className="text-chrome-text/50 hover:text-foreground"
                  title="Close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <PlateWindow
                plateId={modal.plateId}
                activeConnectionId={activeConnectionId}
                chromeless
                busParams={busParams}
                onOpenSql={onOpenSql}
                onOpenPlate={openFromPane}
                onOpenApp={onOpenApp}
                onEmitParam={(field, value) => onEmitParam?.(`modal:${modal.plateId}`, field, value)}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
