import type { ImagePalette, ThemeMode, DerivedTheme } from "./palette"
import type { ColorTokens } from "./theme-tokens"

/**
 * Compose a full token bundle from an ImagePalette + mode.
 *
 * The logic is deliberately simple: the image's accent colors fill the
 * "brand" slots (--main, --rvbbit-accent, the chart series), and the
 * structural surfaces (--background, --chrome-bg, --bevel-*) follow
 * the standard dark/light pattern of the existing globals.css palette.
 *
 * A more sophisticated future version would feed all this into an LLM
 * with a prompt like "produce a 24-token theme JSON" — but that's only
 * worth doing once we've shipped the user-editable palette UI and have
 * a sense for which slots people actually want curated vs algorithmic.
 */
export function deriveTheme(palette: ImagePalette, mode: ThemeMode): DerivedTheme {
  const tokens = mode === "dark" ? deriveDark(palette) : deriveLight(palette)
  return { mode, palette, tokens }
}

function deriveDark(p: ImagePalette): ColorTokens {
  const main = p.vibrant
  const rvbbit = p.lightVibrant
  return {
    // surfaces
    background: oklch(13, 0.035, p.baseHue),
    secondaryBackground: oklch(18, 0.04, p.baseHue),
    foreground: oklch(92, 0, 0),
    border: oklch(40, 0.03, p.baseHue),
    ring: main,
    overlay: oklch(0, 0, 0, 0.7),
    // brand
    main,
    mainForeground: oklch(0, 0, 0),
    // chart series — rotate around the base hue so the palette feels related
    chart1: main,
    chart2: oklch(72, p.chroma * 4.5, (p.baseHue + 90) % 360),
    chart3: oklch(80, p.chroma * 4, (p.baseHue + 180) % 360),
    chart4: oklch(70, p.chroma * 5, (p.baseHue + 240) % 360),
    chart5: oklch(72, p.chroma * 4.2, (p.baseHue + 320) % 360),
    // semantic — stay constant for predictability
    success: "oklch(72% 0.19 145)",
    warning: "oklch(80% 0.16 85)",
    danger: "oklch(65% 0.22 25)",
    info: "oklch(70% 0.14 240)",
    // chrome
    chromeBg: oklch(11, 0.034, p.baseHue),
    chromeBorder: oklch(30, 0.03, p.baseHue),
    chromeText: oklch(70, 0, 0),
    // documents / blocks
    docBg: oklch(12, 0.035, p.baseHue),
    blockBg: oklch(17, 0.035, p.baseHue),
    blockBgHover: oklch(20, 0.04, p.baseHue),
    blockBorder: oklch(32, 0.03, p.baseHue),
    gridDot: oklch(22, 0.03, p.baseHue),
    gridOutline: oklch(22, 0.03, p.baseHue),
    // rvbbit
    rvbbitAccent: rvbbit,
    rvbbitBg: oklch(17, 0.025, hueOf(rvbbit) ?? p.baseHue),
    // terminal accent (slightly different family than main so it reads
    // distinct in mixed-token UI)
    terminal: oklch(72, 0.16, 155),
    terminalDim: oklch(45, 0.08, 155),
    // bevel
    bevelLight: oklch(28, 0.03, p.baseHue),
    bevelDark: oklch(5, 0.025, p.baseHue),
    // icon tile
    iconTileBg: oklch(20, 0.04, p.baseHue, 0.65),
    iconTileBorder: "oklch(100% 0 0 / 0.10)",
    // SQL syntax — derive from main hue family, stay light enough to read
    syntaxForeground: oklch(89, 0.01, 260),
    syntaxKeyword: oklch(76, 0.12, (p.baseHue + 38) % 360),
    syntaxFunction: rvbbit,
    syntaxString: oklch(82, 0.11, 44),
    syntaxNumber: oklch(86, 0.11, 95),
    syntaxComment: oklch(51, 0.02, 262),
    syntaxOperator: oklch(76, 0.08, (p.baseHue + 330) % 360),
    syntaxIdentifier: oklch(82, 0.10, (p.baseHue + 240) % 360),
    // Window chrome — keep the hand-tuned hue identities; shift only
    // chroma/lightness with the image so the windows feel like part
    // of the same room.
    winL: "79%",
    winLIcon: "83%",
    winC: String(Math.max(0.08, Math.min(0.18, p.chroma * 6))),
    winFinderH: "220",
    winDataH: "155",
    winQueryDocumentH: "65",
    winArtifactH: "205",
    winViewAppH: "196",
    winViewAppBuilderH: "178",
    winViewAppsH: "196",
    winSystemObjectsH: "235",
    winExtensionsH: "285",
    winRvbbitCacheH: "175",
    winConnectionsH: "290",
    // Desktop shortcuts inherit the same hue family
    brandFinder: oklch(82, 0.13, 220),
    brandSqlScratch: oklch(83, 0.13, 88),
    brandViewApps: oklch(82, 0.11, 196),
    brandSystemObjects: oklch(82, 0.10, 235),
    brandExtensions: oklch(82, 0.12, 285),
    brandConnections: oklch(83, 0.13, 290),
    brandRvbbitCache: oklch(82, 0.14, 175),
    // Wallpaper overlay tinted by image baseHue so the darkening
    // doesn't fight the wallpaper's own tones
    wallpaperOverlayFrom: oklch(4, 0.02, p.baseHue, 0.78),
    wallpaperOverlayTo: oklch(14, 0.06, p.baseHue, 0.45),
    // Ambient ellipses use a triangle around baseHue
    ambient1: oklch(72, 0.16, p.baseHue, 0.08),
    ambient2: oklch(80, 0.16, (p.baseHue + 120) % 360, 0.05),
    ambient3: oklch(70, 0.18, (p.baseHue + 240) % 360, 0.05),
  }
}

function deriveLight(p: ImagePalette): ColorTokens {
  const main = p.darkVibrant
  const rvbbit = p.darkVibrant
  return {
    background: oklch(96, 0.008, 95),
    secondaryBackground: oklch(92, 0.012, 95),
    foreground: oklch(21, 0.015, 260),
    border: oklch(45, 0.02, 255),
    ring: main,
    overlay: oklch(18, 0.01, 260, 0.14),
    main,
    mainForeground: oklch(99, 0, 0),
    chart1: main,
    chart2: oklch(58, p.chroma * 6, (p.baseHue + 90) % 360),
    chart3: oklch(66, p.chroma * 5, (p.baseHue + 180) % 360),
    chart4: oklch(60, p.chroma * 6.5, (p.baseHue + 240) % 360),
    chart5: oklch(60, p.chroma * 6, (p.baseHue + 320) % 360),
    success: "oklch(58% 0.17 145)",
    warning: "oklch(71% 0.16 85)",
    danger: "oklch(58% 0.21 25)",
    info: "oklch(58% 0.14 240)",
    chromeBg: oklch(91, 0.01, 95),
    chromeBorder: oklch(73, 0.015, 250),
    chromeText: oklch(39, 0.012, 255),
    docBg: oklch(98, 0.003, 95),
    blockBg: "oklch(100% 0 0)",
    blockBgHover: oklch(95, 0.012, hueOf(main) ?? 190),
    blockBorder: oklch(76, 0.016, 250),
    gridDot: oklch(85, 0.015, 240),
    gridOutline: oklch(82, 0.015, 245),
    rvbbitAccent: rvbbit,
    rvbbitBg: oklch(94, 0.03, hueOf(rvbbit) ?? p.baseHue),
    terminal: oklch(42, 0.14, 155),
    terminalDim: oklch(35, 0.08, 155),
    bevelLight: oklch(82, 0.01, 95),
    bevelDark: oklch(55, 0.015, 255),
    iconTileBg: oklch(94, 0.012, 95, 0.85),
    iconTileBorder: "oklch(20% 0 0 / 0.08)",
    syntaxForeground: oklch(28, 0.012, 260),
    syntaxKeyword: oklch(50, 0.15, (p.baseHue + 38) % 360),
    syntaxFunction: rvbbit,
    syntaxString: oklch(54, 0.14, 44),
    syntaxNumber: oklch(58, 0.14, 92),
    syntaxComment: oklch(58, 0.03, 255),
    syntaxOperator: oklch(48, 0.11, (p.baseHue + 330) % 360),
    syntaxIdentifier: oklch(50, 0.12, (p.baseHue + 240) % 360),
    winL: "62%",
    winLIcon: "50%",
    winC: String(Math.max(0.10, Math.min(0.2, p.chroma * 8))),
    winFinderH: "220",
    winDataH: "155",
    winQueryDocumentH: "65",
    winArtifactH: "205",
    winViewAppH: "196",
    winViewAppBuilderH: "178",
    winViewAppsH: "196",
    winSystemObjectsH: "235",
    winExtensionsH: "285",
    winRvbbitCacheH: "175",
    winConnectionsH: "290",
    brandFinder: oklch(50, 0.16, 220),
    brandSqlScratch: oklch(58, 0.15, 88),
    brandViewApps: oklch(54, 0.14, 196),
    brandSystemObjects: oklch(50, 0.13, 235),
    brandExtensions: oklch(54, 0.15, 285),
    brandConnections: oklch(50, 0.16, 290),
    brandRvbbitCache: oklch(54, 0.16, 175),
    wallpaperOverlayFrom: oklch(94, 0.01, p.baseHue, 0.62),
    wallpaperOverlayTo: oklch(86, 0.03, p.baseHue, 0.35),
    ambient1: oklch(76, 0.10, p.baseHue, 0.18),
    ambient2: oklch(82, 0.12, (p.baseHue + 120) % 360, 0.14),
    ambient3: oklch(72, 0.14, (p.baseHue + 240) % 360, 0.10),
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function oklch(l: number, c: number, h: number, a?: number): string {
  return a !== undefined && a !== 1
    ? `oklch(${l}% ${c} ${h} / ${a})`
    : `oklch(${l}% ${c} ${h})`
}

function hueOf(oklchStr: string): number | null {
  // Pull the hue component out of an oklch(L C H[/A]) string. Returns
  // null if the input wasn't in the expected shape.
  const m = oklchStr.match(/oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/i)
  return m ? Number(m[1]) : null
}
