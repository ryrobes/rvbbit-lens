"use client"

import type { ImagePalette } from "./palette"

/**
 * Extractor interface. Implementations pull an ImagePalette out of
 * something. We keep this open so we can drop a node-vibrant-backed
 * extractor in when ready, and an rvbbit-vision-backed extractor when
 * a vision specialist is registered, without changing any callers.
 *
 *   client → vibrantExtractor.extract(blob) → ImagePalette
 *   client → rvbbitVisionExtractor.extract(blob) → ImagePalette
 *
 * Both produce the same shape; downstream code is source-agnostic.
 */
export interface PaletteExtractor {
  /** Stable identifier for diagnostics / palette-editor labelling. */
  id: string
  /** Human-readable label shown in the palette editor. */
  label: string
  /** Returns true if this extractor is ready to use *right now*. */
  available(): boolean | Promise<boolean>
  /** Extract a palette from an image blob or URL. */
  extract(input: Blob | string): Promise<ImagePalette>
}

const extractors: PaletteExtractor[] = []

export function registerPaletteExtractor(extractor: PaletteExtractor) {
  if (!extractors.some((e) => e.id === extractor.id)) {
    extractors.push(extractor)
  }
}

export function listPaletteExtractors(): PaletteExtractor[] {
  return [...extractors]
}

export async function pickReadyExtractor(): Promise<PaletteExtractor | null> {
  for (const e of extractors) {
    const ok = await e.available()
    if (ok) return e
  }
  return null
}

/**
 * Stub extractor that just samples the image's average pixel as the
 * "vibrant" color and returns a flat palette. Useful so the wallpaper
 * flow has *something* to call before node-vibrant is wired in.
 */
export const naiveSampleExtractor: PaletteExtractor = {
  id: "naive-sample",
  label: "Average pixel",
  available: () => typeof document !== "undefined" && typeof window !== "undefined",
  extract: async (input: Blob | string): Promise<ImagePalette> => {
    const url = typeof input === "string" ? input : URL.createObjectURL(input)
    try {
      const { r, g, b } = await sampleAveragePixel(url)
      const oklch = rgbToOklch(r, g, b)
      const hueDeg = oklch.h
      return {
        vibrant: `oklch(${oklch.l * 100}% ${oklch.c} ${hueDeg})`,
        darkVibrant: `oklch(${oklch.l * 60}% ${oklch.c} ${hueDeg})`,
        lightVibrant: `oklch(${Math.min(95, oklch.l * 130)}% ${oklch.c} ${hueDeg})`,
        muted: `oklch(40% 0.03 ${hueDeg})`,
        darkMuted: `oklch(15% 0.04 ${hueDeg})`,
        lightMuted: `oklch(75% 0.02 ${hueDeg})`,
        baseHue: hueDeg,
        chroma: oklch.c,
        source: "naive-sample",
        generatedAt: new Date().toISOString(),
      }
    } finally {
      if (typeof input !== "string") URL.revokeObjectURL(url)
    }
  },
}

registerPaletteExtractor(naiveSampleExtractor)

// ── helpers ─────────────────────────────────────────────────────────

interface RGB { r: number; g: number; b: number }
interface Oklch { l: number; c: number; h: number }

function sampleAveragePixel(url: string): Promise<RGB> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onerror = () => reject(new Error("could not load image"))
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext("2d")
        if (!ctx) return reject(new Error("no 2d context"))
        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1
        }
        resolve({ r: r / n, g: g / n, b: b / n })
      } catch (err) {
        reject(err as Error)
      }
    }
    img.src = url
  })
}

function rgbToOklch(r: number, g: number, b: number): Oklch {
  // Standard sRGB → linear → OKLab → OKLCh conversion. Source:
  // https://bottosson.github.io/posts/oklab/
  const lr = srgbToLin(r / 255), lg = srgbToLin(g / 255), lb = srgbToLin(b / 255)
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const lc = Math.cbrt(l), mc = Math.cbrt(m), sc = Math.cbrt(s)
  const L =
    0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc
  const a = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc
  const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc
  const C = Math.hypot(a, bb)
  const H = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l: Math.max(0, Math.min(1, L)), c: C, h: H }
}

function srgbToLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
