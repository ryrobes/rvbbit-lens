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
  const seriesC = vizChroma(p, "dark")
  const brandC = brandChroma(p, "dark")
  const brandSoftC = brandC * 0.78
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
    // chart/viz series — rotate around the base hue so the palette feels related
    chart1: main,
    chart2: oklch(72, seriesC * 0.9, (p.baseHue + 90) % 360),
    chart3: oklch(80, seriesC * 0.8, (p.baseHue + 180) % 360),
    chart4: oklch(70, seriesC, (p.baseHue + 240) % 360),
    chart5: oklch(72, seriesC * 0.85, (p.baseHue + 320) % 360),
    chart6: oklch(74, seriesC * 0.95, (p.baseHue + 290) % 360),
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
    winPaletteH: "320",
    winPgMonitorH: "150",
    winLockExplorerH: "205",
    winDuckH: "210",
    winFolderH: "85",
    // Desktop shortcuts inherit the same hue family
    brandFinder: oklch(82, brandC, 220),
    brandSqlScratch: oklch(83, brandC, 88),
    brandViewApps: oklch(82, brandSoftC, 196),
    brandSystemObjects: oklch(82, brandSoftC, 235),
    brandExtensions: oklch(82, brandC, 285),
    brandConnections: oklch(83, brandC, 290),
    brandRvbbitCache: oklch(82, brandC, 175),
    brandCache: oklch(83, brandC * 0.75, 95),
    brandPgMonitor: oklch(83, brandSoftC, 150),
    brandLockExplorer: oklch(82, brandSoftC, 205),
    brandOperators: oklch(82, brandSoftC, 168),
    brandSpecialists: oklch(80, brandSoftC, 300),
    brandRouting: oklch(81, brandSoftC, 255),
    brandMcp: oklch(82, brandSoftC, 55),
    brandQueryLens: oklch(82, brandSoftC, 200),
    brandKg: oklch(81, brandSoftC, 320),
    brandCapability: oklch(82, brandSoftC, 190),
    brandWarren: oklch(82, brandSoftC, 35),
    brandCosts: oklch(83, brandSoftC, 130),
    brandDuck: oklch(80, brandSoftC, 210),
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
  const seriesC = vizChroma(p, "light")
  const brandC = brandChroma(p, "light")
  const brandSoftC = brandC * 0.78
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
    chart2: oklch(58, seriesC * 0.92, (p.baseHue + 90) % 360),
    chart3: oklch(66, seriesC * 0.82, (p.baseHue + 180) % 360),
    chart4: oklch(60, seriesC, (p.baseHue + 240) % 360),
    chart5: oklch(60, seriesC * 0.92, (p.baseHue + 320) % 360),
    chart6: oklch(64, seriesC * 0.96, (p.baseHue + 290) % 360),
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
    winPaletteH: "320",
    winPgMonitorH: "150",
    winLockExplorerH: "205",
    winDuckH: "210",
    winFolderH: "85",
    brandFinder: oklch(50, brandC, 220),
    brandSqlScratch: oklch(58, brandC * 0.94, 88),
    brandViewApps: oklch(54, brandSoftC, 196),
    brandSystemObjects: oklch(50, brandSoftC, 235),
    brandExtensions: oklch(54, brandC * 0.94, 285),
    brandConnections: oklch(50, brandC, 290),
    brandRvbbitCache: oklch(54, brandC, 175),
    brandCache: oklch(58, brandC * 0.7, 95),
    brandPgMonitor: oklch(50, brandSoftC, 150),
    brandLockExplorer: oklch(52, brandSoftC, 205),
    brandOperators: oklch(53, brandSoftC, 168),
    brandSpecialists: oklch(52, brandSoftC, 300),
    brandRouting: oklch(52, brandSoftC, 255),
    brandMcp: oklch(54, brandSoftC, 55),
    brandQueryLens: oklch(53, brandSoftC, 200),
    brandKg: oklch(52, brandSoftC, 320),
    brandCapability: oklch(54, brandSoftC, 190),
    brandWarren: oklch(56, brandSoftC, 35),
    brandCosts: oklch(56, brandSoftC, 130),
    brandDuck: oklch(54, brandSoftC, 210),
    wallpaperOverlayFrom: oklch(94, 0.01, p.baseHue, 0.62),
    wallpaperOverlayTo: oklch(86, 0.03, p.baseHue, 0.35),
    ambient1: oklch(76, 0.10, p.baseHue, 0.18),
    ambient2: oklch(82, 0.12, (p.baseHue + 120) % 360, 0.14),
    ambient3: oklch(72, 0.14, (p.baseHue + 240) % 360, 0.10),
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function vizChroma(p: ImagePalette, mode: ThemeMode): number {
  return clamp(p.chroma * (mode === "dark" ? 6 : 7), mode === "dark" ? 0.12 : 0.13, mode === "dark" ? 0.20 : 0.18)
}

function brandChroma(p: ImagePalette, mode: ThemeMode): number {
  return clamp(p.chroma * (mode === "dark" ? 5.5 : 7), mode === "dark" ? 0.06 : 0.09, mode === "dark" ? 0.15 : 0.18)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

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
