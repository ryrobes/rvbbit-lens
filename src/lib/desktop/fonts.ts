"use client"

/**
 * Font preferences — sans family, mono family, and an overall UI
 * scale. All three resolve to CSS variables on :root, so any class
 * using `var(--font-family-sans)` / `font-mono` / rem-based sizing
 * follows.
 *
 * The non-system families are Google Fonts preloaded via a <link> in
 * layout.tsx. Picking a family before its stylesheet has loaded still
 * falls through the stack to the system default — no broken render.
 *
 * Curation notes — these were chosen to suit a dark, technical SQL
 * desktop without looking like every other shadcn/Inter app:
 *
 *   SANS
 *     System          — zero-latency default
 *     Inter           — the dependable workhorse grotesk
 *     Geist           — Vercel's typeface; clean, slightly mechanical
 *     Space Grotesk    — geometric with real character (the off-beat pick)
 *     IBM Plex Sans    — enterprise-trusted; pairs with IBM Plex Mono
 *
 *   MONO
 *     System          — zero-latency default
 *     JetBrains Mono   — tall x-height, superb for SQL
 *     Fira Code        — classic coding font with ligatures
 *     Geist Mono       — minimal, matches Geist sans
 *     IBM Plex Mono    — distinctive slab-ish mono
 *     Martian Mono     — wide, grid-locked, unmistakably off-beat
 */

export type SansFont = "system" | "inter" | "geist" | "space-grotesk" | "ibm-plex-sans"
export type MonoFont =
  | "system"
  | "jetbrains-mono"
  | "fira-code"
  | "geist-mono"
  | "ibm-plex-mono"
  | "martian-mono"
export type FontScale = "sm" | "md" | "lg"

export const SANS_OPTIONS: Record<SansFont, { label: string; stack: string }> = {
  system: {
    label: "System",
    stack: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  },
  inter: {
    label: "Inter",
    stack: "'Inter', ui-sans-serif, system-ui, sans-serif",
  },
  geist: {
    label: "Geist",
    stack: "'Geist', ui-sans-serif, system-ui, sans-serif",
  },
  "space-grotesk": {
    label: "Space Grotesk",
    stack: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
  },
  "ibm-plex-sans": {
    label: "IBM Plex Sans",
    stack: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  },
}

export const MONO_OPTIONS: Record<MonoFont, { label: string; stack: string }> = {
  system: {
    label: "System",
    stack: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  "jetbrains-mono": {
    label: "JetBrains Mono",
    stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  "fira-code": {
    label: "Fira Code",
    stack: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  "geist-mono": {
    label: "Geist Mono",
    stack: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  "ibm-plex-mono": {
    label: "IBM Plex Mono",
    stack: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  "martian-mono": {
    label: "Martian Mono",
    stack: "'Martian Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
}

/**
 * The single Google Fonts stylesheet URL that preloads every
 * non-system candidate. Kept here next to the option tables so the
 * two never drift. Imported by layout.tsx.
 */
export const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2" +
  "?family=Inter:wght@400;500;600" +
  "&family=Geist:wght@400;500;600" +
  "&family=Space+Grotesk:wght@400;500;600" +
  "&family=IBM+Plex+Sans:wght@400;500;600" +
  "&family=JetBrains+Mono:wght@400;500" +
  "&family=Fira+Code:wght@400;500" +
  "&family=Geist+Mono:wght@400;500" +
  "&family=IBM+Plex+Mono:wght@400;500" +
  "&family=Martian+Mono:wght@400;500" +
  "&display=swap"

export const FONT_SCALE_PX: Record<FontScale, number> = {
  sm: 13,
  md: 14,
  lg: 16,
}

export const FONT_SCALE_LABELS: Record<FontScale, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
}

export const DEFAULT_SANS: SansFont = "system"
export const DEFAULT_MONO: MonoFont = "jetbrains-mono"
export const DEFAULT_SCALE: FontScale = "md"

const LS_SANS = "rvbbit-lens-sans-font"
const LS_MONO = "rvbbit-lens-mono-font"
const LS_SCALE = "rvbbit-lens-font-scale"

export interface FontPrefs {
  sans: SansFont
  mono: MonoFont
  scale: FontScale
}

export function readFontPrefs(): FontPrefs {
  if (typeof window === "undefined") {
    return { sans: DEFAULT_SANS, mono: DEFAULT_MONO, scale: DEFAULT_SCALE }
  }
  // Validate against the current option tables — a value saved before
  // a font-list revision (e.g. the retired "inter-tight") falls back
  // to the default rather than rendering as an unknown family.
  const rawSans = window.localStorage.getItem(LS_SANS) as SansFont | null
  const rawMono = window.localStorage.getItem(LS_MONO) as MonoFont | null
  const rawScale = window.localStorage.getItem(LS_SCALE) as FontScale | null
  return {
    sans: rawSans && rawSans in SANS_OPTIONS ? rawSans : DEFAULT_SANS,
    mono: rawMono && rawMono in MONO_OPTIONS ? rawMono : DEFAULT_MONO,
    scale: rawScale && rawScale in FONT_SCALE_PX ? rawScale : DEFAULT_SCALE,
  }
}

export function writeFontPrefs(prefs: FontPrefs): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LS_SANS, prefs.sans)
    window.localStorage.setItem(LS_MONO, prefs.mono)
    window.localStorage.setItem(LS_SCALE, prefs.scale)
  } catch {
    // best-effort
  }
}

export function applyFontPrefs(prefs: FontPrefs): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  const sans = SANS_OPTIONS[prefs.sans] ?? SANS_OPTIONS[DEFAULT_SANS]
  const mono = MONO_OPTIONS[prefs.mono] ?? MONO_OPTIONS[DEFAULT_MONO]
  root.style.setProperty("--font-family-sans", sans.stack)
  root.style.setProperty("--font-sans", sans.stack)
  root.style.setProperty("--font-family-mono", mono.stack)
  root.style.setProperty("--font-mono", mono.stack)
  root.style.fontSize = `${FONT_SCALE_PX[prefs.scale]}px`
}
