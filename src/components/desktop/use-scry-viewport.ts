"use client"

/**
 * useScryViewport — pan/zoom for the Scry canvas, isolated from the desktop
 * viewport (separate state, distinct ScryViewport type). Mirrors the desktop
 * screen↔world math and the zoom-to-cursor recipe.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent, RefObject } from "react"
import {
  clampScryViewport,
  DEFAULT_SCRY_VIEWPORT,
  SCRY_MAX_SCALE,
  SCRY_MIN_SCALE,
  type ScryViewport,
} from "@/lib/desktop/scry-scene"

export interface UseScryViewport {
  viewport: ScryViewport
  containerRef: RefObject<HTMLDivElement | null>
  screenToWorld: (s: { x: number; y: number }) => { x: number; y: number }
  worldToScreen: (w: { x: number; y: number }) => { x: number; y: number }
  onCanvasPointerDown: (e: ReactPointerEvent) => void
  onCanvasPointerMove: (e: ReactPointerEvent) => void
  onCanvasPointerUp: (e: ReactPointerEvent) => void
  /**
   * Pan (keeping scale) so a world point lands at the center of the VISIBLE
   * canvas. `rightInset` reserves space on the right (e.g. the results rail) so
   * the point isn't centered under it.
   */
  centerOnWorld: (wx: number, wy: number, rightInset?: number) => void
}

export function useScryViewport(open: boolean): UseScryViewport {
  const [viewport, setViewport] = useState<ScryViewport>(DEFAULT_SCRY_VIEWPORT)
  const vpRef = useRef(viewport)
  vpRef.current = viewport
  const containerRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null)

  // Reset to identity each time Scry opens.
  useEffect(() => {
    if (open) setViewport(DEFAULT_SCRY_VIEWPORT)
  }, [open])

  // Wheel listener attached natively with { passive: false } so preventDefault
  // actually stops the page from scrolling (React's onWheel can be passive).
  useEffect(() => {
    const el = containerRef.current
    if (!el || !open) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setViewport((vp) => {
        const newScale = Math.min(SCRY_MAX_SCALE, Math.max(SCRY_MIN_SCALE, vp.scale * delta))
        // keep the world point under the cursor fixed (zoom-to-cursor)
        const wx = (e.clientX - vp.x) / vp.scale
        const wy = (e.clientY - vp.y) / vp.scale
        return clampScryViewport({ x: e.clientX - wx * newScale, y: e.clientY - wy * newScale, scale: newScale })
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [open])

  const screenToWorld = useCallback(
    (s: { x: number; y: number }) => ({
      x: (s.x - vpRef.current.x) / vpRef.current.scale,
      y: (s.y - vpRef.current.y) / vpRef.current.scale,
    }),
    [],
  )
  const worldToScreen = useCallback(
    (w: { x: number; y: number }) => ({
      x: w.x * vpRef.current.scale + vpRef.current.x,
      y: w.y * vpRef.current.scale + vpRef.current.y,
    }),
    [],
  )

  // Pan starts on any canvas pointerdown that isn't a node (nodes stopPropagation).
  const onCanvasPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    panRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: vpRef.current.x, oy: vpRef.current.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onCanvasPointerMove = useCallback((e: ReactPointerEvent) => {
    const p = panRef.current
    if (!p || p.id !== e.pointerId) return
    // panning the camera is screen-space: do NOT divide by scale
    setViewport((vp) => clampScryViewport({ ...vp, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }))
  }, [])
  const onCanvasPointerUp = useCallback((e: ReactPointerEvent) => {
    if (panRef.current?.id === e.pointerId) {
      panRef.current = null
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    }
  }, [])

  const centerOnWorld = useCallback((wx: number, wy: number, rightInset = 0) => {
    setViewport((vp) => {
      const w = typeof window !== "undefined" ? window.innerWidth : 1280
      const h = typeof window !== "undefined" ? window.innerHeight : 720
      const cx = (w - rightInset) / 2
      const cy = h / 2
      return clampScryViewport({ x: cx - wx * vp.scale, y: cy - wy * vp.scale, scale: vp.scale })
    })
  }, [])

  return {
    viewport,
    containerRef,
    screenToWorld,
    worldToScreen,
    onCanvasPointerDown,
    onCanvasPointerMove,
    onCanvasPointerUp,
    centerOnWorld,
  }
}
