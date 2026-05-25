"use client"

import { Vibrant } from "node-vibrant/browser"
import type { Palette, Swatch } from "@vibrant/color"
import type { PaletteExtractor } from "./palette-extractor"
import type { ImagePalette } from "./palette"

/**
 * node-vibrant-backed palette extractor. Maps Vibrant's six role
 * swatches (Vibrant, Muted, DarkMuted, LightVibrant, DarkVibrant,
 * LightMuted) onto our ImagePalette shape. Falls back gracefully
 * when one or more swatches are null (low-saturation images).
 *
 * baseHue + chroma come from the most-vibrant swatch (or a weighted
 * average of the punchy ones) so downstream theme derivation can
 * rotate accent colors around the image's dominant identity.
 */
export const vibrantExtractor: PaletteExtractor = {
  id: "node-vibrant",
  label: "node-vibrant",
  available: () => typeof window !== "undefined",
  async extract(input: Blob | string): Promise<ImagePalette> {
    const url = typeof input === "string" ? input : URL.createObjectURL(input)
    try {
      const palette = await Vibrant.from(url).getPalette()
      return paletteToImagePalette(palette)
    } finally {
      if (typeof input !== "string") URL.revokeObjectURL(url)
    }
  },
}

function paletteToImagePalette(p: Palette): ImagePalette {
  // Resolve each role with a fallback chain — Vibrant will return null
  // for any swatch that didn't have enough pixels.
  const vibrant = firstNonNull(p.Vibrant, p.LightVibrant, p.Muted, p.LightMuted, p.DarkVibrant, p.DarkMuted)
  if (!vibrant) {
    // Image was completely monochrome / black. Bail to default-ish.
    return {
      vibrant: "oklch(76% 0.14 195)",
      darkVibrant: "oklch(40% 0.10 195)",
      lightVibrant: "oklch(82% 0.10 195)",
      muted: "oklch(40% 0.03 270)",
      darkMuted: "oklch(15% 0.04 270)",
      lightMuted: "oklch(75% 0.02 270)",
      baseHue: 270,
      chroma: 0.04,
      source: "node-vibrant (fallback — no swatches)",
      generatedAt: new Date().toISOString(),
    }
  }
  const darkVibrant = p.DarkVibrant ?? p.DarkMuted ?? darken(vibrant)
  const lightVibrant = p.LightVibrant ?? p.LightMuted ?? lighten(vibrant)
  const muted = p.Muted ?? p.LightMuted ?? p.DarkMuted ?? vibrant
  const darkMuted = p.DarkMuted ?? darken(muted)
  const lightMuted = p.LightMuted ?? lighten(muted)

  // baseHue from the most populous vibrant-class swatch — that's what
  // the eye reads as "the image's color". Population-weighted average
  // would average out clashing hues; max-population is more decisive.
  const baseSwatch = pickMostPopulous([p.Vibrant, p.DarkVibrant, p.LightVibrant, p.Muted]) ?? vibrant
  const baseRgb = baseSwatch.rgb
  const baseHcl = rgbToOklch(baseRgb[0], baseRgb[1], baseRgb[2])

  // chroma: average across the three vibrant-family swatches if
  // present, so a low-saturation image yields a low chroma
  const chromaSamples = [p.Vibrant, p.LightVibrant, p.DarkVibrant]
    .filter((s): s is Swatch => !!s)
    .map((s) => rgbToOklch(s.rgb[0], s.rgb[1], s.rgb[2]).c)
  const chroma = chromaSamples.length > 0
    ? chromaSamples.reduce((a, b) => a + b, 0) / chromaSamples.length
    : baseHcl.c

  return {
    vibrant: swatchToOklch(vibrant),
    darkVibrant: swatchToOklch(darkVibrant),
    lightVibrant: swatchToOklch(lightVibrant),
    muted: swatchToOklch(muted),
    darkMuted: swatchToOklch(darkMuted),
    lightMuted: swatchToOklch(lightMuted),
    baseHue: Math.round(baseHcl.h),
    chroma: round(chroma, 4),
    source: "node-vibrant",
    generatedAt: new Date().toISOString(),
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function swatchToOklch(s: Swatch): string {
  const [r, g, b] = s.rgb
  const { l, c, h } = rgbToOklch(r, g, b)
  return `oklch(${round(l * 100, 2)}% ${round(c, 4)} ${round(h, 1)})`
}

function pickMostPopulous(swatches: Array<Swatch | null | undefined>): Swatch | null {
  let best: Swatch | null = null
  for (const s of swatches) {
    if (!s) continue
    if (!best || s.population > best.population) best = s
  }
  return best
}

function firstNonNull(...candidates: Array<Swatch | null | undefined>): Swatch | null {
  for (const s of candidates) if (s) return s
  return null
}

function darken(s: Swatch): Swatch {
  // Crude HCl-based darken — Vibrant's swatch type is a class; clone the
  // RGB and let downstream code pretend it was a real DarkVibrant.
  const [r, g, b] = s.rgb
  return cloneSwatch(s, [Math.round(r * 0.6), Math.round(g * 0.6), Math.round(b * 0.6)])
}

function lighten(s: Swatch): Swatch {
  const [r, g, b] = s.rgb
  const mix = 0.45
  return cloneSwatch(s, [
    Math.round(r + (255 - r) * mix),
    Math.round(g + (255 - g) * mix),
    Math.round(b + (255 - b) * mix),
  ])
}

function cloneSwatch(template: Swatch, rgb: [number, number, number]): Swatch {
  // Construct a fake Swatch-like by reusing the same constructor.
  const ctor = template.constructor as new (rgb: [number, number, number], population: number) => Swatch
  return new ctor(rgb, 1)
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

interface Oklch { l: number; c: number; h: number }

function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = srgbToLin(r / 255), lg = srgbToLin(g / 255), lb = srgbToLin(b / 255)
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const lc = Math.cbrt(l_), mc = Math.cbrt(m_), sc = Math.cbrt(s_)
  const L = 0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc
  const a = 1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc
  const bb = 0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc
  const C = Math.hypot(a, bb)
  const H = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l: Math.max(0, Math.min(1, L)), c: C, h: H }
}

function srgbToLin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
