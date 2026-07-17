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
  const rotRef = useRef(0)
  const ampRef = useRef(0)

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
    const baseR = size * 0.22
    const maxDisp = size * 0.2 // wider swing than v1 = more expressive; fits the canvas with peak dots
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
      // Smooth the overall loudness so the core pulse breathes, not flickers.
      ampRef.current += (amp - ampRef.current) * 0.3
      const sAmp = ampRef.current
      // Rotate for life; spin faster when she's loud.
      rotRef.current += 0.004 + sAmp * 0.06

      ctx.clearRect(0, 0, size, size)

      // core: outer glow + a bright pulsing center
      const coreR = baseR * (0.5 + sAmp * 0.9)
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6)
      glow.addColorStop(0, hexA(resolved, 0.35 + sAmp * 0.5))
      glow.addColorStop(0.5, hexA(resolved, 0.12 + sAmp * 0.25))
      glow.addColorStop(1, hexA(resolved, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = hexA(resolved, 0.5 + sAmp * 0.45)
      ctx.beginPath()
      ctx.arc(cx, cy, size * 0.05 * (0.7 + sAmp * 1.4), 0, Math.PI * 2)
      ctx.fill()

      // particle ring — non-linear peak emphasis, brighter/bigger + burst
      // lines on strong peaks, gently rotating.
      const radii = radiiRef.current
      const rot = rotRef.current
      let settled = 0
      ctx.lineWidth = Math.max(0.6, size * 0.006)
      for (let i = 0; i < PARTICLES; i++) {
        const v = freq[i] / 255
        const emph = Math.pow(v, 0.55) // small sounds still register, peaks pop
        const target = active ? emph * maxDisp : 0
        radii[i] += (target - radii[i]) * 0.3 // snappier
        if (radii[i] < 0.15) settled++
        const norm = Math.min(1, radii[i] / maxDisp)
        const ang = (i / PARTICLES) * Math.PI * 2 + rot
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const r = baseR + radii[i]
        const x = cx + ca * r
        const y = cy + sa * r
        // burst line from the core edge out to the particle on strong peaks
        if (norm > 0.35) {
          ctx.strokeStyle = hexA(resolved, (norm - 0.35) * 0.5)
          ctx.beginPath()
          ctx.moveTo(cx + ca * baseR, cy + sa * baseR)
          ctx.lineTo(x, y)
          ctx.stroke()
        }
        const dotR = 1 + norm * (size * 0.05)
        ctx.beginPath()
        ctx.fillStyle = hexA(resolved, 0.45 + norm * 0.55)
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
