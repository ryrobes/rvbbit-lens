/**
 * The full set of color tokens our themes write to :root.
 *
 * Each key corresponds 1:1 to a `--<key>` CSS variable in globals.css.
 * Adding a new visual surface? Add the token here AND in globals.css
 * (both light and dark defaults) AND in @theme inline so Tailwind picks
 * it up.
 *
 * Keeping this list central also lets us snapshot/restore a theme as a
 * plain JSON blob — no parsing of the stylesheet required.
 */

export interface ColorTokens {
  // Base surfaces
  background: string
  secondaryBackground: string
  foreground: string
  border: string
  ring: string
  overlay: string

  // Brand
  main: string
  mainForeground: string

  // Chart series (small, predictable; not derived from the image)
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  chart6: string

  // Semantic
  success: string
  warning: string
  danger: string
  info: string

  // Chrome (menu bar, window frames)
  chromeBg: string
  chromeBorder: string
  chromeText: string

  // Document / block surfaces (window content)
  docBg: string
  blockBg: string
  blockBgHover: string
  blockBorder: string
  gridDot: string
  gridOutline: string

  // Rvbbit-extension surface
  rvbbitAccent: string
  rvbbitBg: string

  // Terminal accent (NeXTSTEP look)
  terminal: string
  terminalDim: string

  // NeXTSTEP bevel
  bevelLight: string
  bevelDark: string

  // Small chrome surfaces — icons, tiles
  iconTileBg: string
  iconTileBorder: string

  // SQL syntax (CodeMirror reads these)
  syntaxForeground: string
  syntaxKeyword: string
  syntaxFunction: string
  syntaxString: string
  syntaxNumber: string
  syntaxComment: string
  syntaxOperator: string
  syntaxIdentifier: string

  // Window chrome — shared L/C plus per-kind hue. Hue tokens are
  // numeric (degrees, 0–360); CSS resolves them inside oklch() at
  // paint time.
  winL: string
  winLIcon: string
  winC: string
  winFinderH: string
  winDataH: string
  winQueryDocumentH: string
  winArtifactH: string
  winViewAppH: string
  winViewAppBuilderH: string
  winViewAppsH: string
  winSystemObjectsH: string
  winExtensionsH: string
  winRvbbitCacheH: string
  winConnectionsH: string
  winPaletteH: string
  winPgMonitorH: string
  winLockExplorerH: string
  winMvccExplorerH: string
  winDuckH: string
  winFolderH: string

  // Desktop shortcut brand colors (full oklch strings)
  brandFinder: string
  brandSqlScratch: string
  brandViewApps: string
  brandSystemObjects: string
  brandExtensions: string
  brandConnections: string
  brandRvbbitCache: string
  brandCache: string
  brandPgMonitor: string
  brandLockExplorer: string
  brandMvccExplorer: string
  brandOperators: string
  brandSpecialists: string
  brandRouting: string
  brandMcp: string
  brandQueryLens: string
  brandKg: string
  brandCapability: string
  brandWarren: string
  brandCosts: string
  brandDuck: string

  // Wallpaper darkening overlay
  wallpaperOverlayFrom: string
  wallpaperOverlayTo: string

  // Ambient backdrop ellipses (no wallpaper)
  ambient1: string
  ambient2: string
  ambient3: string
}

/**
 * Camel → kebab so we can write `:root { --foreground: ...; }` from a
 * `tokens.foreground` value.
 */
export function tokenKey(camel: keyof ColorTokens): string {
  // Insert a hyphen at camel humps AND at letter→digit boundaries, so `chart1`
  // and `ambient1` become `--chart-1` / `--ambient-1` — the names globals.css and
  // every chart consumer actually read. Without the digit rule these token writes
  // hit dead `--chart1` vars and the whole wallpaper-derived chart palette never
  // reached a single chart.
  return `--${camel
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2")
    .toLowerCase()}`
}

/**
 * Write a tokens object onto `document.documentElement` as inline CSS
 * variables. Returns a cleanup function that restores the previous
 * inline values, in case the caller wants a "preview" mode.
 */
export function applyTokensToRoot(tokens: ColorTokens): () => void {
  if (typeof document === "undefined") return () => {}
  const root = document.documentElement
  const previous: Record<string, string> = {}
  for (const k of Object.keys(tokens) as Array<keyof ColorTokens>) {
    const cssVar = tokenKey(k)
    previous[cssVar] = root.style.getPropertyValue(cssVar)
    root.style.setProperty(cssVar, tokens[k])
  }
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v) root.style.setProperty(k, v)
      else root.style.removeProperty(k)
    }
  }
}
