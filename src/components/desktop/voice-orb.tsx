"use client"

/**
 * VoiceOrb — the Assistant's "speaking" visualization.
 *
 * A ring of particles whose radius is driven by live frequency data off the
 * currently-playing TTS audio (VoicePlayer's AnalyserNode). It's the web-cheap
 * cousin of a particle "mouth": one canvas, ~64 dots, requestAnimationFrame
 * only while active — when idle it settles to a calm breathing circle and the
 * loop stops entirely.
 */

import { useEffect, useRef } from "react"

const PARTICLES = 64

export function VoiceOrb({
  getAnalyser,
  active,
  size = 96,
  color = "var(--main)",
}: {
  getAnalyser: () => AnalyserNode | null
  active: boolean
  size?: number
  color?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  // Smoothed radii so idle→speaking and peaks feel organic, not steppy.
  const radiiRef = useRef<number[]>(new Array(PARTICLES).fill(0))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    // Resolve the CSS var to a concrete color once (canvas needs a literal).
    const resolved =
      color.startsWith("var(")
        ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1).trim()).trim() || "#9df7d5"
        : color

    const cx = size / 2
    const cy = size / 2
    const baseR = size * 0.26
    const maxDisp = size * 0.16
    const freq = new Uint8Array(PARTICLES)

    const draw = () => {
      const analyser = getAnalyser()
      let amp = 0
      if (analyser && active) {
        const bins = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(bins)
        const step = Math.max(1, Math.floor(bins.length / PARTICLES))
        for (let i = 0; i < PARTICLES; i++) freq[i] = bins[i * step] ?? 0
        amp = freq.reduce((a, b) => a + b, 0) / (PARTICLES * 255)
      } else {
        freq.fill(0)
      }

      ctx.clearRect(0, 0, size, size)

      // core glow scales with overall loudness
      const coreR = baseR * (0.55 + amp * 0.5)
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2)
      grad.addColorStop(0, hexA(resolved, 0.28 + amp * 0.4))
      grad.addColorStop(1, hexA(resolved, 0))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2)
      ctx.fill()

      // particle ring
      const radii = radiiRef.current
      let settled = 0
      for (let i = 0; i < PARTICLES; i++) {
        const target = active ? (freq[i] / 255) * maxDisp : 0
        radii[i] += (target - radii[i]) * 0.25 // smoothing
        if (radii[i] < 0.15) settled++
        const ang = (i / PARTICLES) * Math.PI * 2
        const r = baseR + radii[i]
        const x = cx + Math.cos(ang) * r
        const y = cy + Math.sin(ang) * r
        const dotR = 1 + (radii[i] / maxDisp) * 1.6
        ctx.beginPath()
        ctx.fillStyle = hexA(resolved, 0.5 + (radii[i] / maxDisp) * 0.5)
        ctx.arc(x, y, dotR, 0, Math.PI * 2)
        ctx.fill()
      }

      // While speaking, keep animating. When idle, run only until the ring
      // settles to its calm circle, then stop the loop entirely (good citizen —
      // no rAF burning when nothing is speaking).
      if (active || settled < PARTICLES) {
        rafRef.current = requestAnimationFrame(draw)
      } else {
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [getAnalyser, active, size, color])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
    />
  )
}

// Apply alpha to a hex or rgb color for canvas fills.
function hexA(color: string, a: number): string {
  const alpha = Math.max(0, Math.min(1, a))
  if (color.startsWith("#")) {
    let h = color.slice(1)
    if (h.length === 3) h = h.split("").map((c) => c + c).join("")
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  if (color.startsWith("rgb")) {
    const nums = color.match(/[\d.]+/g) ?? ["157", "247", "213"]
    return `rgba(${nums[0]},${nums[1]},${nums[2]},${alpha})`
  }
  return `rgba(157,247,213,${alpha})`
}
