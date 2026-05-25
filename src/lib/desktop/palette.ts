/**
 * Palette pipeline — image → ImagePalette → DerivedTheme → CSS vars.
 *
 * The whole point of this file is to be *source-agnostic*. An image
 * palette can come from:
 *
 *   - node-vibrant (client-side, deterministic, default)
 *   - rvbbit.about(image, "extract 6 UI colors") via a vision specialist
 *   - a manual user pick from a color wheel
 *
 * All three produce the same `ImagePalette` shape, which then feeds the
 * `deriveTheme(palette, mode)` function. Downstream, `applyTheme(theme)`
 * writes CSS variables onto `:root`.
 *
 * Until an extractor is wired up, callers should fall back to
 * DEFAULT_DARK_PALETTE / DEFAULT_LIGHT_PALETTE which mirror the
 * hand-tuned values currently in globals.css.
 */

import type { ColorTokens } from "./theme-tokens"

export type ThemeMode = "dark" | "light"

/**
 * The minimal information we keep about an image's color identity.
 * Roles map approximately to node-vibrant's Swatch outputs but are
 * normalised so a manual / LLM source can populate them just as well.
 *
 * Every color is an oklch() string so we can blend in CSS easily.
 */
export interface ImagePalette {
  /** Most "punchy" color in the image — typically becomes --main. */
  vibrant: string
  /** A darker vibrant — accent on light themes, deep highlight on dark. */
  darkVibrant: string
  /** A lighter vibrant — gentle highlight on dark themes. */
  lightVibrant: string
  /** Subtle desaturated — used for chrome surfaces. */
  muted: string
  darkMuted: string
  lightMuted: string
  /**
   * The image's overall dominant hue, isolated as an oklch hue degree
   * (0–360). Used when we need to *generate* additional accent colors
   * (e.g. chart-3, chart-4) that aren't directly present in the image
   * but should still feel related.
   */
  baseHue: number
  /** Mean chroma across the punchy swatches. Drives accent saturation. */
  chroma: number
  /** Optional reference back to the source so the editor can re-extract. */
  sourceHash?: string
  /** Display label for the editor ("Curated by rvbbit", "from vibrant.js", "manual"). */
  source?: string
  /** ISO timestamp of when this palette was generated. */
  generatedAt?: string
}

/**
 * A complete derived theme — ready to be written to CSS variables.
 * The keys here align 1:1 with the existing tokens in globals.css; if
 * we add a new --foo token, add the matching field here.
 */
export interface DerivedTheme {
  mode: ThemeMode
  tokens: ColorTokens
  palette: ImagePalette
}

// ── Defaults that mirror globals.css ────────────────────────────────

export const DEFAULT_DARK_PALETTE: ImagePalette = {
  vibrant: "oklch(76% 0.14 195)",
  darkVibrant: "oklch(40% 0.10 195)",
  lightVibrant: "oklch(82% 0.10 195)",
  muted: "oklch(40% 0.03 270)",
  darkMuted: "oklch(15% 0.04 270)",
  lightMuted: "oklch(75% 0.02 270)",
  baseHue: 270,
  chroma: 0.04,
  source: "default-dark",
}

export const DEFAULT_LIGHT_PALETTE: ImagePalette = {
  vibrant: "oklch(62% 0.16 195)",
  darkVibrant: "oklch(38% 0.16 195)",
  lightVibrant: "oklch(78% 0.10 195)",
  muted: "oklch(73% 0.015 250)",
  darkMuted: "oklch(45% 0.02 255)",
  lightMuted: "oklch(95% 0.01 250)",
  baseHue: 250,
  chroma: 0.015,
  source: "default-light",
}
