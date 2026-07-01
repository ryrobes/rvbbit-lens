"use client"

/**
 * Chart tab. Auto-renders a Vega-Lite spec from the result columns;
 * the user can flip into an "Edit spec" YAML pane to override it.
 *
 * Theme integration: every render reads CSS vars from :root, so dark
 * /light toggles, wallpaper palette swaps, and font-pref edits flow
 * through to the chart without prop wiring. A MutationObserver bumps
 * a stamp when :root.style or :root.class changes.
 *
 * Selection: spec includes a `point` selection bound to the chart's
 * x field. The signal listener forwards the clicked value to the
 * same param-emit flow the result grid uses — clicking a bar emits
 * a cascading filter onto the params surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import yaml from "js-yaml"
import CodeMirror, { type Extension } from "@uiw/react-codemirror"
import { yaml as yamlLang } from "@codemirror/lang-yaml"
import { assembleChartjs, assembleECharts, assembleVegaLite } from "flint-chart"
import { VegaEmbed } from "react-vega"
import type { Result as VegaEmbedResult } from "vega-embed"
import { BarChart3, ClipboardCopy, ClipboardPaste, FileCode2, Palette, RotateCcw, Sigma } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { QueryResult } from "@/lib/db/types"
import type { ChartRendererKind, ChartThemeOverrides, DesktopParamValue } from "@/lib/desktop/types"
import { inferChartSpec, schemaComment, type InferResult } from "@/lib/desktop/chart-infer"
import { themeFingerprint, vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import {
  buildFlintChartInput,
  CHART_RENDERER_OPTIONS,
  DEFAULT_CHART_RENDERER,
  vegaEncodingField,
} from "@/lib/desktop/flint-chart-adapter"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { ChartShelf } from "./chart-shelf"

export interface ChartViewProps {
  result: QueryResult
  /** Sticky spec authored by the user. When null, auto-render. */
  userSpec: Record<string, unknown> | null
  onChangeUserSpec: (spec: Record<string, unknown> | null) => void
  chartRenderer?: ChartRendererKind
  onChangeChartRenderer?: (renderer: ChartRendererKind) => void
  chartTheme?: ChartThemeOverrides | null
  onChangeChartTheme?: (theme: ChartThemeOverrides | null) => void
  /**
   * Spec seeded from a rollup spec (column-aggregate windows). Takes
   * precedence over column-type inference but yields to a user spec.
   */
  seedSpec?: Record<string, unknown> | null
  /** Mirror of the chart's point selection. `value` is the ARRAY of currently
   *  selected values for `field` (empty array clears the param). */
  onEmitParam: (field: string, value: unknown, dataTypeId: number) => void
  /** This block's active params — used to clear the chart's highlight when the
   *  matching param is removed from the shelf. */
  activeParams?: DesktopParamValue[]
}

type EditorMode = "shelf" | "yaml"

export function ChartView({
  result,
  userSpec,
  onChangeUserSpec,
  chartRenderer = DEFAULT_CHART_RENDERER,
  onChangeChartRenderer,
  chartTheme = null,
  onChangeChartTheme,
  seedSpec,
  onEmitParam,
  activeParams,
}: ChartViewProps) {
  const [mode, setMode] = useState<EditorMode>("shelf")
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeStamp, setThemeStamp] = useState(0)
  // Present mode: the Tableau-style shelf + spec editor are pure authoring —
  // render just the Vega canvas (which keeps hover, tooltips, click-to-emit
  // params, and its resize observer, since the ref lives on the canvas wrapper).
  const present = usePresentMode()

  // Bump on :root mutations — palette overrides + font writes touch
  // .style, dark/light toggles flip `data-theme`, and the chrome
  // sometimes toggles .class. Keep the observer broad so all three
  // paths re-derive the Vega config.
  useEffect(() => {
    if (typeof window === "undefined") return
    const observer = new MutationObserver(() => setThemeStamp((n) => n + 1))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme"],
    })
    return () => observer.disconnect()
  }, [])

  const inferred: InferResult | null = useMemo(() => {
    return inferChartSpec(result.columns, result.rows)
  }, [result])

  // Theme fingerprint is read inside the memo so the dependency
  // tracker re-runs the config builder on theme change.
  const themeConfig = useMemo(() => {
    // touch the fingerprint to register the dep
    themeFingerprint()
    return applyChartThemeOverrides(vegaConfigFromTheme(), chartTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeStamp, chartTheme])

  const baseSpec = userSpec ?? seedSpec ?? inferred?.spec ?? null
  const displaySpec = useMemo(
    () => applyChartSpecPresentation(baseSpec, chartTheme),
    [baseSpec, chartTheme],
  )
  const baseXField = useMemo(
    () => vegaEncodingField(baseSpec, "x") || inferred?.xField || "",
    [baseSpec, inferred?.xField],
  )

  // Container-driven sizing for facet/concat. Plain single-mark specs use
  // Vega-Lite's `width: "container"` + signal-driven resize (smooth during
  // drag). Faceted / concat specs need numeric per-cell sizes computed from
  // the measured container; the size state is debounced so a continuous
  // drag-resize doesn't thrash re-embeds.
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null)

  // Vega-Lite's actual rendered chrome (axes, headers, legend, etc.) depends
  // on data and label widths in ways our static padding numbers can't
  // predict — a 5×5 facet ends up with much more chrome than a 1×1. After
  // the first render we measure SVG dimensions vs. the computed cell sizes
  // to derive an additional "chrome bump" that's fed into the next sizing
  // pass. This is a single feedback step: estimated → measured → corrected.
  // A ref + tick state so the post-embed callback can update without going
  // through React state in the hot path.

  /**
   * Mode the spec wants to render in. Drives the sizing strategy below.
   *   plain  — single mark, no facet ⇒ width/height: "container" works directly.
   *   facet  — single mark with column/row facet encoding ⇒ Vega-Lite reads
   *            width/height as per-cell sizes; compute from container.
   *   concat — top-level vconcat/hconcat ⇒ per-subspec width/height,
   *            recursing on nested facets.
   */
  const layoutMode = useMemo<"plain" | "facet" | "concat">(() => {
    if (!displaySpec) return "plain"
    if ("vconcat" in displaySpec || "hconcat" in displaySpec) return "concat"
    const enc = (displaySpec.encoding as Record<string, unknown> | undefined) ?? {}
    if ("column" in enc || "row" in enc) return "facet"
    return "plain"
  }, [displaySpec])


  // Plain spec — never depends on containerSize so its identity is stable
  // across resizes, keeping VegaEmbed from re-mounting.
  const plainSpec = useMemo(() => {
    if (!displaySpec) return null
    return {
      ...displaySpec,
      config: mergeChartConfig(displaySpec.config, themeConfig, chartTheme),
      data: { values: result.rows },
      width: "container",
      height: "container",
      autosize: { type: "fit", contains: "padding", resize: true },
    } as Record<string, unknown>
  }, [chartTheme, displaySpec, themeConfig, result.rows])

  // Sized spec for facet / concat layouts.
  const sizedSpec = useMemo(() => {
    if (!displaySpec) return null
    if (layoutMode === "plain") return plainSpec
    const cs = containerSize ?? { w: 600, h: 400 }
    const themed: Record<string, unknown> = {
      ...displaySpec,
      config: mergeChartConfig(displaySpec.config, themeConfig, chartTheme),
      data: { values: result.rows },
    }
    if (layoutMode === "facet") {
      const enc = (displaySpec.encoding as Record<string, unknown> | undefined) ?? {}
      const { width, height } = computeFacetCellSize(enc, result.rows, cs.w, cs.h)
      themed.width = width
      themed.height = height
      // Force shared axes so each row of cells reuses the same x-axis strip
      // (and each column the same y-axis), instead of Vega-Lite drawing
      // per-cell chrome that bloats total height/width unpredictably.
      themed.resolve = {
        ...(themed.resolve as Record<string, unknown> | undefined),
        axis: { x: "shared", y: "shared" },
      }
      return themed
    }
    // concat
    const kind: "vconcat" | "hconcat" = "vconcat" in displaySpec ? "vconcat" : "hconcat"
    const inner = (displaySpec[kind] as Array<Record<string, unknown>> | undefined) ?? []
    const nSubs = Math.max(1, inner.length)
    const spacing = 24
    // Each subspec carries its own view padding (config.padding ≈ 8 each
    // side), so for vconcat we lose VIEW_PAD × nSubs of vertical height
    // before any cell math; mirror for hconcat horizontally.
    const perSubW =
      kind === "vconcat"
        ? cs.w
        : Math.max(
            160,
            Math.floor((cs.w - spacing * (nSubs - 1) - VIEW_PAD * nSubs) / nSubs),
          )
    const perSubH =
      kind === "hconcat"
        ? cs.h
        : Math.max(
            140,
            Math.floor((cs.h - spacing * (nSubs - 1) - VIEW_PAD * nSubs) / nSubs),
          )
    const sized = inner.map((sub) => {
      const subEnc = (sub.encoding as Record<string, unknown> | undefined) ?? {}
      const subHasFacet = "column" in subEnc || "row" in subEnc
      if (subHasFacet) {
        const cell = computeFacetCellSize(subEnc, result.rows, perSubW, perSubH)
        return { width: cell.width, height: cell.height, ...sub }
      }
      // Subspecs without inner facet — give them numeric sizes so layout is
      // deterministic. "container" inside concat can race with our debounced
      // size state in ways that produce flickers during the first paint.
      const w = Math.max(160, perSubW - 80)
      const h = Math.max(120, perSubH - 60)
      return { width: w, height: h, ...sub }
    })
    themed[kind] = sized
    themed.spacing = spacing
    return themed
  }, [chartTheme, displaySpec, layoutMode, plainSpec, themeConfig, result.rows, containerSize])

  const finalSpec = layoutMode === "plain" ? plainSpec : sizedSpec

  // Track current Result so we can detach listeners on re-embed.
  const viewRef = useRef<VegaEmbedResult | null>(null)
  // The field the point selection is keyed on — remembered so we can clear the
  // param when the selection empties (the empty signal carries no field).
  const selectionFieldRef = useRef<string | null>(null)
  useEffect(() => {
    if (baseXField) selectionFieldRef.current = baseXField
  }, [baseXField])
  const onEmitParamRef = useRef(onEmitParam)
  useEffect(() => {
    onEmitParamRef.current = onEmitParam
  }, [onEmitParam])

  // When this chart's param is removed from the shelf (selection cleared
  // externally), clear the Vega point-selection store so the highlight follows.
  // (After an in-chart re-click the store is already empty, so this is a no-op.)
  const selectedCount = useMemo(() => {
    const f = baseXField
    if (!f) return 0
    const p = activeParams?.find((x) => x.field === f && x.cascade === false)
    const vals = p ? (Array.isArray(p.value) ? p.value : [p.value]) : []
    return vals.length
  }, [activeParams, baseXField])
  useEffect(() => {
    if (selectedCount > 0) return
    const res = viewRef.current
    if (!res) return
    try {
      const store = res.view.data("click_store")
      if (Array.isArray(store) && store.length > 0) void res.view.data("click_store", []).runAsync()
    } catch {
      // No selection store for this spec — nothing to clear.
    }
  }, [selectedCount])

  // Re-fit Vega on container resize. Even with `width: "container"`
  // and `autosize.resize: true`, vega-embed's built-in container
  // observer doesn't update the width/height signals when our host
  // (position:absolute inset-0) shrinks because its parent shrank —
  // it only fires when the host itself receives a direct size change.
  // Workaround: observe our own wrapper, read the live host dimensions
  // via view.container(), and push them onto the width/height signals
  // explicitly. rAF-debounced so a corner-drag doesn't queue a
  // re-render per pointer event.
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  // Layout mode lives in a ref so the observer can read the *current* mode
  // without having to be re-created when the mode changes.
  const layoutModeRef = useRef(layoutMode)
  useEffect(() => {
    layoutModeRef.current = layoutMode
  }, [layoutMode])
  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (!el || typeof ResizeObserver === "undefined") return
    let rafId = 0
    let debounceId: ReturnType<typeof setTimeout> | null = null
    const pushSize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      setContainerSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const view = viewRef.current?.view
        if (view) {
          try {
            const host = (view.container?.() ?? null) as HTMLElement | null
            if (host) {
              view
                .signal("width", host.clientWidth)
                .signal("height", host.clientHeight)
            }
            view.resize()
            void view.runAsync()
          } catch {
            // Spec has no width/height signals — facet/concat takes the
            // path below instead. Either way, the debounce updates state.
          }
        }
      })
      // Re-spec for facet/concat — debounced so dragging the window doesn't
      // queue a re-embed per frame.
      if (layoutModeRef.current !== "plain") {
        if (debounceId) clearTimeout(debounceId)
        debounceId = setTimeout(pushSize, 120)
      }
    })
    observer.observe(el)
    resizeObserverRef.current = observer
    // Seed an initial size so the first paint already has real numbers.
    pushSize()
  }, [])
  const dataTypeMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of result.columns) m.set(c.name, c.dataTypeId)
    return m
  }, [result.columns])
  const flintBuild = useMemo(
    () => buildFlintChartInput({
      spec: displaySpec,
      columns: result.columns,
      rows: result.rows,
      canvasSize: containerSize ? { width: containerSize.w, height: containerSize.h } : null,
    }),
    [displaySpec, containerSize, result.columns, result.rows],
  )
  const wantsFlint = chartRenderer !== "vega-lite"
  const flintCompiled = useMemo(() => {
    if (!wantsFlint || !flintBuild) return null
    try {
      if (chartRenderer === "flint-vega-lite") {
        const raw = assembleVegaLite(flintBuild.input) as Record<string, unknown>
        const themedRaw = applyChartSpecPresentation(raw, chartTheme) ?? raw
        return {
          kind: "vega" as const,
          spec: fitFlintVegaSpec(themedRaw, themeConfig, chartTheme),
        }
      }
      if (chartRenderer === "flint-echarts") {
        return {
          kind: "echarts" as const,
          option: fitEChartsOption(themeEChartsOption(assembleECharts(flintBuild.input) as Record<string, unknown>, themeConfig, chartTheme)),
        }
      }
      if (chartRenderer === "flint-chartjs") {
        return {
          kind: "chartjs" as const,
          config: fitChartjsConfig(themeChartjsConfig(assembleChartjs(flintBuild.input) as Record<string, unknown>, themeConfig, chartTheme)),
        }
      }
      return null
    } catch (error) {
      console.warn("[ChartView] Flint compile failed", error)
      return { kind: "error" as const, message: error instanceof Error ? error.message : String(error) }
    }
  }, [chartRenderer, chartTheme, flintBuild, themeConfig, wantsFlint])
  const canRenderFlint = !!flintCompiled && flintCompiled.kind !== "error"
  const rendererStatus = wantsFlint && !canRenderFlint ? "fallback" : null

  const emitFlintValue = useCallback(
    (field: string, value: unknown) => {
      if (!field || value === undefined || value === null) return
      const dtid = dataTypeMap.get(field) ?? 25
      onEmitParamRef.current(field, [value], dtid)
    },
    [dataTypeMap],
  )

  const handleEmbed = useCallback(
    (res: VegaEmbedResult) => {
      // Detach previous listener if any (vega-embed disposes the
      // old view on re-render but be belt-and-suspenders).
      const view = res.view
      const handler = (_name: string, value: unknown) => {
        // Mirror the FULL point selection into our param (operator "in"):
        // re-clicking a mark toggles it out, so the param set always matches the
        // highlighted marks. An empty selection clears the param (keyed on the
        // remembered field, since the empty signal carries no field).
        let field = selectionFieldRef.current
        let values: unknown[] = []
        if (value && typeof value === "object") {
          const entries = Object.entries(value as Record<string, unknown>).filter(
            ([k]) => k !== "_vgsid_" && k !== "vlPoint",
          )
          if (entries.length > 0) {
            const [f, rawValues] = entries[0] as [string, unknown]
            field = f
            selectionFieldRef.current = f
            values = (Array.isArray(rawValues) ? rawValues : [rawValues]).filter(
              (v) => v !== undefined && v !== null,
            )
          }
        }
        if (!field) return
        const dtid = dataTypeMap.get(field) ?? 25 // default text
        onEmitParamRef.current(field, values, dtid)
      }
      try {
        view.addSignalListener("click", handler)
      } catch {
        // Signal absent for this spec (e.g. histogram without selection). Ignore.
      }
      viewRef.current = res
    },
    [dataTypeMap],
  )
  const handleFlintVegaEmbed = useCallback(
    (res: VegaEmbedResult) => {
      viewRef.current = res
      const field = flintBuild?.xField
      if (!field) return
      const handler = (_event: unknown, item: unknown) => {
        const datum =
          item && typeof item === "object" && "datum" in item
            ? (item as { datum?: unknown }).datum
            : null
        if (!datum || typeof datum !== "object" || Array.isArray(datum)) return
        emitFlintValue(field, (datum as Record<string, unknown>)[field])
      }
      try {
        res.view.addEventListener("click", handler)
      } catch {
        // Some Flint/Vega specs have no mark-level event stream.
      }
    },
    [emitFlintValue, flintBuild?.xField],
  )

  const handleError = useCallback((err: unknown) => {
    // Surface in console — the inline error banner below shows a
    // succinct message via the editor's parse path; runtime Vega
    // errors are rarer once the spec validates.
    console.warn("[ChartView] vega-embed error", err)
  }, [])
  const chartSurfaceStyle = chartTheme?.background ? { background: chartTheme.background } : undefined

  const classicVegaCanvas = finalSpec ? (
    <div ref={containerRefCallback} className="relative h-full w-full" style={chartSurfaceStyle}>
      <VegaEmbed
        spec={finalSpec as Parameters<typeof VegaEmbed>[0]["spec"]}
        options={{
          actions: false,
          renderer: "svg",
          tooltip: { theme: "dark" },
        }}
        onEmbed={handleEmbed}
        onError={handleError}
        className="absolute inset-0"
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  ) : null

  const canvas =
    canRenderFlint && flintCompiled?.kind === "vega" ? (
      <div ref={containerRefCallback} className="relative h-full w-full" style={chartSurfaceStyle}>
        <VegaEmbed
          spec={flintCompiled.spec as Parameters<typeof VegaEmbed>[0]["spec"]}
          options={{
            actions: false,
            renderer: "svg",
            tooltip: { theme: "dark" },
          }}
          onEmbed={handleFlintVegaEmbed}
          onError={handleError}
          className="absolute inset-0"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    ) : canRenderFlint && flintCompiled?.kind === "echarts" && flintBuild ? (
      <div ref={containerRefCallback} className="relative h-full w-full" style={chartSurfaceStyle}>
        <FlintEChartsCanvas
          option={flintCompiled.option}
          rows={result.rows}
          xField={flintBuild.xField}
          onPickValue={emitFlintValue}
        />
      </div>
    ) : canRenderFlint && flintCompiled?.kind === "chartjs" && flintBuild ? (
      <div ref={containerRefCallback} className="relative h-full w-full" style={chartSurfaceStyle}>
        <FlintChartjsCanvas
          config={flintCompiled.config}
          rows={result.rows}
          xField={flintBuild.xField}
          onPickValue={emitFlintValue}
        />
      </div>
    ) : classicVegaCanvas ? (
      classicVegaCanvas
    ) : (
      <EmptyState columns={result.columns.length} rows={result.rows.length} />
    )

  if (present) {
    // Content-only: just the chart, full-bleed.
    return <div className="flex h-full flex-col">{canvas}</div>
  }

  return (
    <div className="flex h-full flex-col">
      <ChartHeader
        mode={mode}
        userSpec={userSpec}
        markType={inferred?.markType ?? null}
        chartRenderer={chartRenderer}
        rendererStatus={rendererStatus}
        onModeChange={setMode}
        onRendererChange={onChangeChartRenderer}
        themeOpen={themeOpen}
        hasThemeOverrides={hasChartThemeOverrides(chartTheme)}
        onThemeToggle={onChangeChartTheme ? () => setThemeOpen((open) => !open) : undefined}
        onReset={() => onChangeUserSpec(null)}
      />

      {themeOpen && onChangeChartTheme ? (
        <ChartThemePanel
          theme={chartTheme}
          config={themeConfig}
          onChange={onChangeChartTheme}
        />
      ) : null}

      {mode === "yaml" ? (
        <SpecEditor
          initial={baseSpec}
          columns={result.columns}
          rowCount={result.rowCount}
          onApply={(spec) => onChangeUserSpec(spec)}
        />
      ) : (
        <ChartShelf
          columns={result.columns}
          rows={result.rows}
          spec={baseSpec}
          onChangeSpec={onChangeUserSpec}
        >
          {canvas}
        </ChartShelf>
      )}
    </div>
  )
}

function ChartHeader({
  mode,
  userSpec,
  markType,
  chartRenderer,
  rendererStatus,
  onModeChange,
  onRendererChange,
  themeOpen,
  hasThemeOverrides,
  onThemeToggle,
  onReset,
}: {
  mode: EditorMode
  userSpec: Record<string, unknown> | null
  markType: string | null
  chartRenderer: ChartRendererKind
  rendererStatus?: "fallback" | null
  onModeChange: (m: EditorMode) => void
  onRendererChange?: (renderer: ChartRendererKind) => void
  themeOpen: boolean
  hasThemeOverrides: boolean
  onThemeToggle?: () => void
  onReset: () => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-chrome-border bg-chrome-bg/40 px-2 py-1">
      <BarChart3 className="h-3.5 w-3.5 text-rvbbit-accent" />
      <span className="text-[10px] uppercase tracking-wider text-chrome-text">
        {userSpec ? "custom" : markType ? `auto · ${markType}` : "auto"}
      </span>
      <div className="ml-2 flex items-center rounded border border-chrome-border/60 bg-doc-bg p-0.5 text-[10px]">
        {(["shelf", "yaml"] as EditorMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono",
              mode === m
                ? "bg-rvbbit-accent/15 text-foreground"
                : "text-chrome-text/65 hover:text-foreground",
            )}
            title={m === "shelf" ? "Visual shelf editor" : "Edit raw Vega-Lite YAML"}
          >
            {m === "shelf" ? <Sigma className="h-3 w-3" /> : <FileCode2 className="h-3 w-3" />}
            {m === "shelf" ? "Shelf" : "YAML"}
          </button>
        ))}
      </div>
      <div className="ml-1 flex items-center rounded border border-chrome-border/60 bg-doc-bg p-0.5 text-[10px]">
        {CHART_RENDERER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onRendererChange?.(option.id)}
            disabled={!onRendererChange}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono",
              chartRenderer === option.id
                ? "bg-main/20 text-foreground"
                : "text-chrome-text/65 hover:text-foreground",
              !onRendererChange ? "cursor-default opacity-70" : "",
            )}
            title={option.label}
          >
            {option.shortLabel}
          </button>
        ))}
      </div>
      {rendererStatus === "fallback" ? (
        <span className="text-[10px] uppercase tracking-wider text-amber-300/80">fallback</span>
      ) : null}
      {onThemeToggle ? (
        <button
          type="button"
          onClick={onThemeToggle}
          className={cn(
            "ml-1 inline-flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] font-mono",
            themeOpen ? "bg-main/20 text-foreground" : "bg-doc-bg text-chrome-text/70 hover:text-foreground",
          )}
          title="Chart theme, color, and palette overrides"
        >
          <Palette className="h-3 w-3" />
          Theme
          {hasThemeOverrides ? <span className="h-1.5 w-1.5 rounded-full bg-rvbbit-accent" /> : null}
        </button>
      ) : null}
      <div className="flex-1" />
      {userSpec ? (
        <Button size="sm" variant="ghost" onClick={onReset} title="Discard custom spec; return to auto-inferred">
          <RotateCcw className="h-3 w-3" />
          <span className="text-xs">Reset to auto</span>
        </Button>
      ) : null}
    </div>
  )
}

function ChartThemePanel({
  theme,
  config,
  onChange,
}: {
  theme: ChartThemeOverrides | null
  config: Record<string, unknown>
  onChange: (theme: ChartThemeOverrides | null) => void
}) {
  const defaults = themeDefaultsFromConfig(config)
  const palette = normalizedPalette(theme?.palette, defaults.palette)
  const update = (patch: Partial<ChartThemeOverrides>) => {
    onChange(cleanChartTheme({ ...(theme ?? {}), ...patch }))
  }
  const setPaletteSlot = (index: number, value: string) => {
    const next = [...palette]
    next[index] = value.trim()
    update({ palette: next })
  }
  const setDefaultedToggle = (key: keyof Pick<ChartThemeOverrides, "grid" | "legend" | "labels" | "points" | "roundedBars">, checked: boolean, defaultValue: boolean) => {
    update({ [key]: checked === defaultValue ? undefined : checked })
  }

  return (
    <div className="border-b border-chrome-border/60 bg-chrome-bg/25 px-2 py-2 text-[11px] text-chrome-text">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[300px] flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono uppercase tracking-wider text-chrome-text/75">Palette</span>
            <button
              type="button"
              onClick={() => update({ palette: undefined })}
              className="rounded border border-chrome-border/60 px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/70 hover:text-foreground"
            >
              theme default
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1 md:grid-cols-3 xl:grid-cols-6">
            {palette.map((color, index) => (
              <ColorField
                key={index}
                label={`${index + 1}`}
                value={theme?.palette?.[index] ?? ""}
                resolved={color}
                pickerFallback={DEFAULT_PICKER_PALETTE[index % DEFAULT_PICKER_PALETTE.length]}
                onChange={(value) => setPaletteSlot(index, value || defaults.palette[index] || DEFAULT_PICKER_PALETTE[index % DEFAULT_PICKER_PALETTE.length])}
              />
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {PALETTE_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => update({ palette: preset.colors })}
                className="inline-flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 font-mono text-[10px] text-chrome-text/75 hover:border-rvbbit-accent/50 hover:text-foreground"
                title={`Use ${preset.name} palette`}
              >
                <span className="flex overflow-hidden rounded-sm border border-chrome-border/50">
                  {preset.colors.slice(0, 4).map((color) => (
                    <span key={color} className="h-2.5 w-2.5" style={{ background: color }} />
                  ))}
                </span>
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid min-w-[280px] flex-1 grid-cols-2 gap-1">
          <ColorField
            label="accent"
            value={theme?.accent ?? ""}
            resolved={defaults.accent}
            pickerFallback="#22d3ee"
            onChange={(value) => update({ accent: value || undefined })}
          />
          <ColorField
            label="bg"
            value={theme?.background ?? ""}
            resolved={defaults.background}
            pickerFallback="#111827"
            onChange={(value) => update({ background: value || undefined })}
          />
          <ColorField
            label="text"
            value={theme?.foreground ?? ""}
            resolved={defaults.foreground}
            pickerFallback="#e5e7eb"
            onChange={(value) => update({ foreground: value || undefined })}
          />
          <ColorField
            label="axis"
            value={theme?.axisColor ?? ""}
            resolved={defaults.axisColor}
            pickerFallback="#94a3b8"
            onChange={(value) => update({ axisColor: value || undefined })}
          />
          <ColorField
            label="grid"
            value={theme?.gridColor ?? ""}
            resolved={defaults.gridColor}
            pickerFallback="#334155"
            onChange={(value) => update({ gridColor: value || undefined })}
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded border border-chrome-border/60 px-2 py-1 font-mono text-[10px] text-chrome-text/75 hover:border-danger/50 hover:text-danger"
          >
            reset all
          </button>
        </div>

        <div className="min-w-[220px]">
          <div className="mb-1 font-mono uppercase tracking-wider text-chrome-text/75">Render</div>
          <div className="grid grid-cols-2 gap-1">
            <ThemeToggle
              label="Grid"
              checked={theme?.grid ?? true}
              onChange={(checked) => setDefaultedToggle("grid", checked, true)}
            />
            <ThemeToggle
              label="Legend"
              checked={theme?.legend ?? true}
              onChange={(checked) => setDefaultedToggle("legend", checked, true)}
            />
            <ThemeToggle
              label="Labels"
              checked={theme?.labels ?? true}
              onChange={(checked) => setDefaultedToggle("labels", checked, true)}
            />
            <ThemeToggle
              label="Points"
              checked={theme?.points ?? true}
              onChange={(checked) => setDefaultedToggle("points", checked, true)}
            />
            <ThemeToggle
              label="Round bars"
              checked={theme?.roundedBars ?? false}
              onChange={(checked) => setDefaultedToggle("roundedBars", checked, false)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  resolved,
  pickerFallback,
  onChange,
}: {
  label: string
  value: string
  resolved: string
  pickerFallback: string
  onChange: (value: string) => void
}) {
  const display = value || resolved || pickerFallback
  const pickerValue = colorPickerValue(display, pickerFallback)
  return (
    <label className="flex min-w-0 items-center gap-1 rounded border border-chrome-border/50 bg-doc-bg/60 px-1.5 py-1">
      <span className="w-10 shrink-0 font-mono text-[10px] uppercase text-chrome-text/65">{label}</span>
      <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded border border-chrome-border/70" style={{ background: display }}>
        <input
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label={`${label} color picker`}
        />
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={resolved}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-foreground outline-none placeholder:text-chrome-text/45"
      />
    </label>
  )
}

function ThemeToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1 rounded border border-chrome-border/50 bg-doc-bg/60 px-2 py-1 font-mono text-[10px] text-chrome-text/80">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-3 w-3 accent-rvbbit-accent"
      />
      <span>{label}</span>
    </label>
  )
}

function FlintEChartsCanvas({
  option,
  rows,
  xField,
  onPickValue,
}: {
  option: Record<string, unknown>
  rows: Record<string, unknown>[]
  xField: string
  onPickValue: (field: string, value: unknown) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let observer: ResizeObserver | null = null
    let chart: ReturnType<typeof import("echarts").init> | null = null
    void import("echarts").then((echarts) => {
      if (cancelled || !hostRef.current) return
      chart = echarts.init(hostRef.current, null, { renderer: "canvas" })
      chart.setOption(option, true)
      const handler = (params: unknown) => {
        const value = eChartsPickValue(params, rows, xField)
        onPickValue(xField, value)
      }
      chart.on("click", handler)
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => resizeEChartsToHost(chart, hostRef.current))
        observer.observe(hostRef.current)
      }
      resizeEChartsToHost(chart, hostRef.current)
    })
    return () => {
      cancelled = true
      observer?.disconnect()
      chart?.dispose()
    }
  }, [onPickValue, option, rows, xField])
  return <div ref={hostRef} className="absolute inset-0" />
}

function FlintChartjsCanvas({
  config,
  rows,
  xField,
  onPickValue,
}: {
  config: Record<string, unknown>
  rows: Record<string, unknown>[]
  xField: string
  onPickValue: (field: string, value: unknown) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let chart: InstanceType<typeof import("chart.js/auto").default> | null = null
    void import("chart.js/auto").then((mod) => {
      if (cancelled || !canvasRef.current) return
      const Chart = mod.default
      const options = asRecord(config.options)
      const configWithClick = {
        ...config,
        options: {
          ...options,
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 0,
          onClick: (_event: unknown, elements: { index?: number; datasetIndex?: number }[], activeChart: unknown) => {
            const element = elements[0]
            if (!element || typeof element.index !== "number") return
            const value = chartjsPickValue(activeChart, element, rows, xField)
            onPickValue(xField, value)
          },
        },
      } as unknown as ConstructorParameters<typeof Chart>[1]
      chart = new Chart(canvasRef.current, configWithClick)
    })
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [config, onPickValue, rows, xField])
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
}

function EmptyState({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-xs text-chrome-text/80">
      <div>
        <BarChart3 className="mx-auto mb-2 h-6 w-6 text-rvbbit-accent" />
        {rows === 0
          ? "No rows yet — run the query to see a chart."
          : `Can't infer a chart from ${columns} column${columns === 1 ? "" : "s"}. Click Edit spec to author one.`}
      </div>
    </div>
  )
}

function SpecEditor({
  initial,
  columns,
  rowCount,
  onApply,
}: {
  initial: Record<string, unknown> | null
  columns: QueryResult["columns"]
  rowCount: number
  onApply: (spec: Record<string, unknown>) => void
}) {
  const [text, setText] = useState(() => initialYaml(initial, columns, rowCount))
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function parseAndApply() {
    try {
      const stripped = stripSchemaComment(text)
      const parsed = yaml.load(stripped)
      if (!parsed || typeof parsed !== "object") {
        setError("Spec must be a YAML/JSON object.")
        return
      }
      setError(null)
      onApply(parsed as Record<string, unknown>)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function copyForChat() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // best-effort
    }
  }

  async function pasteFromChat() {
    try {
      const incoming = await navigator.clipboard.readText()
      if (incoming.trim().length > 0) setText(incoming)
    } catch {
      // best-effort
    }
  }

  const cmExtensions: Extension[] = useMemo(
    () => [yamlLang(), ...rvbbitLensCodeMirrorTheme],
    [],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-chrome-border/60 bg-chrome-bg/30 px-2 py-1 text-[11px] text-chrome-text">
        <span>Vega-Lite spec (YAML or JSON)</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={copyForChat} title="Copy spec + schema comment to clipboard">
          <ClipboardCopy className="h-3 w-3" />
          <span className="text-xs">{copied ? "Copied" : "Copy for chat"}</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={pasteFromChat} title="Replace with clipboard contents">
          <ClipboardPaste className="h-3 w-3" />
          <span className="text-xs">Paste</span>
        </Button>
        <Button size="sm" onClick={parseAndApply} title="Parse this YAML and apply it as the chart spec">
          <span className="text-xs">Apply</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          value={text}
          onChange={setText}
          height="100%"
          theme="none"
          extensions={cmExtensions}
          basicSetup={{
            highlightActiveLine: true,
            lineNumbers: true,
            foldGutter: false,
            dropCursor: true,
            autocompletion: false,
            searchKeymap: true,
            indentOnInput: true,
            bracketMatching: true,
          }}
        />
      </div>
      {error ? (
        <div className="border-t border-danger/40 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
    </div>
  )
}

function initialYaml(
  spec: Record<string, unknown> | null,
  columns: QueryResult["columns"],
  rowCount: number,
): string {
  const comment = schemaComment(columns, rowCount)
  if (!spec) {
    return `${comment}# Author a Vega-Lite spec below.\n# Data binds to \`data: { values: rows }\` automatically — omit \`data\`.\n\nmark: bar\nencoding:\n  x: { field: ${columns[0]?.name ?? "x"}, type: nominal }\n  y: { aggregate: count, type: quantitative }\n`
  }
  // Strip auto-added bits that aren't part of the persisted spec.
  const cleaned: Record<string, unknown> = { ...spec }
  delete cleaned.data
  delete cleaned.width
  delete cleaned.height
  delete cleaned.autosize
  return comment + yaml.dump(cleaned, { lineWidth: 100, noRefs: true })
}

function stripSchemaComment(text: string): string {
  // Drop leading lines starting with '#' (the schema comment block)
  // plus any blank line immediately after, so users can author the
  // spec without worrying about the comment.
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === "")) i += 1
  return lines.slice(i).join("\n")
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

const DEFAULT_PICKER_PALETTE = ["#22d3ee", "#a3e635", "#f59e0b", "#f472b6", "#60a5fa", "#e5e7eb"]

const PALETTE_PRESETS: { name: string; colors: string[] }[] = [
  { name: "bright", colors: ["#22d3ee", "#a3e635", "#f59e0b", "#f472b6", "#60a5fa", "#f87171"] },
  { name: "muted", colors: ["#7dd3fc", "#86efac", "#fcd34d", "#c4b5fd", "#f9a8d4", "#cbd5e1"] },
  { name: "warm", colors: ["#f97316", "#facc15", "#ef4444", "#fb7185", "#d97706", "#fde68a"] },
  { name: "cool", colors: ["#06b6d4", "#3b82f6", "#10b981", "#8b5cf6", "#14b8a6", "#93c5fd"] },
]

function normalizedPalette(value: unknown, fallback: string[] = DEFAULT_PICKER_PALETTE): string[] {
  const colors = stringArray(value).map((item) => item.trim()).filter(Boolean)
  const base = colors.length > 0 ? colors : fallback
  if (base.length === 0) return []
  const next = [...base]
  while (next.length < 6) next.push(DEFAULT_PICKER_PALETTE[next.length % DEFAULT_PICKER_PALETTE.length])
  return next.slice(0, 6)
}

function cleanColor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cleanChartTheme(value: ChartThemeOverrides): ChartThemeOverrides | null {
  const palette = normalizedPalette(value.palette, []).filter(Boolean)
  const next: ChartThemeOverrides = {}
  if (palette.length > 0) next.palette = palette
  const accent = cleanColor(value.accent)
  const background = cleanColor(value.background)
  const foreground = cleanColor(value.foreground)
  const axisColor = cleanColor(value.axisColor)
  const gridColor = cleanColor(value.gridColor)
  if (accent) next.accent = accent
  if (background) next.background = background
  if (foreground) next.foreground = foreground
  if (axisColor) next.axisColor = axisColor
  if (gridColor) next.gridColor = gridColor
  if (typeof value.grid === "boolean") next.grid = value.grid
  if (typeof value.legend === "boolean") next.legend = value.legend
  if (typeof value.labels === "boolean") next.labels = value.labels
  if (typeof value.points === "boolean") next.points = value.points
  if (typeof value.roundedBars === "boolean") next.roundedBars = value.roundedBars
  return Object.keys(next).length > 0 ? next : null
}

function hasChartThemeOverrides(value: ChartThemeOverrides | null | undefined): boolean {
  return !!cleanChartTheme(value ?? {})
}

function explicitChartPalette(theme: ChartThemeOverrides | null | undefined): string[] {
  return normalizedPalette(cleanChartTheme(theme ?? {})?.palette, [])
}

function explicitChartAccent(theme: ChartThemeOverrides | null | undefined): string | undefined {
  return cleanColor(cleanChartTheme(theme ?? {})?.accent)
}

function chartThemeAccent(theme: ChartThemeOverrides | null | undefined): string | undefined {
  return explicitChartAccent(theme) ?? explicitChartPalette(theme)[0]
}

function themeDefaultsFromConfig(config: Record<string, unknown>): {
  palette: string[]
  accent: string
  background: string
  foreground: string
  axisColor: string
  gridColor: string
} {
  const t = themeTokens(config)
  const mark = asRecord(config.mark)
  const background = typeof config.background === "string" && config.background !== "transparent"
    ? config.background
    : "#111827"
  const accent = typeof mark.color === "string" ? mark.color : t.palette[0] ?? DEFAULT_PICKER_PALETTE[0]
  return {
    palette: normalizedPalette(t.palette),
    accent,
    background,
    foreground: t.foreground,
    axisColor: t.chromeText,
    gridColor: t.chromeBorder,
  }
}

function mergeChartConfig(specConfig: unknown, themeConfig: Record<string, unknown>, theme: ChartThemeOverrides | null | undefined): Record<string, unknown> {
  const authored = asRecord(specConfig)
  return hasChartThemeOverrides(theme)
    ? { ...authored, ...themeConfig }
    : { ...themeConfig, ...authored }
}

function colorPickerValue(value: string, fallback: string): string {
  const trimmed = value.trim()
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback
}

function applyChartThemeOverrides(config: Record<string, unknown>, theme: ChartThemeOverrides | null | undefined): Record<string, unknown> {
  const cleaned = cleanChartTheme(theme ?? {})
  if (!cleaned) return config
  const explicitPalette = explicitChartPalette(cleaned)
  const palette = normalizedPalette(cleaned.palette, stringArray(asRecord(config.range).category))
  const accent = cleanColor(cleaned.accent) ?? explicitPalette[0]
  const foreground = cleanColor(cleaned.foreground)
  const axisColor = cleanColor(cleaned.axisColor) ?? foreground
  const gridColor = cleanColor(cleaned.gridColor)
  const background = cleanColor(cleaned.background)
  const range = asRecord(config.range)
  const axis = asRecord(config.axis)
  const legend = asRecord(config.legend)
  const title = asRecord(config.title)
  const header = asRecord(config.header)
  const mark = asRecord(config.mark)
  const bar = asRecord(config.bar)
  const line = asRecord(config.line)
  const point = asRecord(config.point)
  const area = asRecord(config.area)
  const axisPatch: Record<string, unknown> = {
    ...axis,
  }
  if (axisColor) {
    axisPatch.labelColor = axisColor
    axisPatch.titleColor = axisColor
    axisPatch.domainColor = axisColor
    axisPatch.tickColor = axisColor
  }
  if (gridColor) axisPatch.gridColor = gridColor
  if (cleaned.grid === false) axisPatch.grid = false
  if (cleaned.labels === false) axisPatch.labels = false
  return {
    ...config,
    ...(background ? { background } : {}),
    ...(foreground ? { text: { ...asRecord(config.text), color: foreground } } : {}),
    range: {
      ...range,
      category: palette,
      ordinal: palette,
    },
    axis: axisPatch,
    axisX: { ...asRecord(config.axisX), ...axisPatch },
    axisY: { ...asRecord(config.axisY), ...axisPatch },
    legend: {
      ...legend,
      ...(cleaned.legend === false ? { disable: true } : {}),
      ...(foreground ? { labelColor: foreground, titleColor: foreground } : {}),
    },
    title: foreground ? { ...title, color: foreground, subtitleColor: foreground } : title,
    header: foreground ? { ...header, labelColor: foreground, titleColor: foreground } : header,
    mark: accent ? { ...mark, color: accent } : mark,
    bar: {
      ...bar,
      ...(accent ? { color: accent } : {}),
      ...(cleaned.roundedBars ? { cornerRadiusEnd: 4 } : cleaned.roundedBars === false ? { cornerRadiusEnd: 0 } : {}),
    },
    line: accent ? { ...line, stroke: accent } : line,
    point: accent ? { ...point, fill: accent, stroke: accent } : point,
    area: accent ? { ...area, fill: accent } : area,
  }
}

function applyChartSpecPresentation(spec: Record<string, unknown> | null, theme: ChartThemeOverrides | null | undefined): Record<string, unknown> | null {
  const cleaned = cleanChartTheme(theme ?? {})
  if (!spec || !cleaned) return spec
  const next: Record<string, unknown> = { ...spec }
  const encoding = asRecord(next.encoding)
  const hasEncoding = encoding === next.encoding
  next.mark = decorateSpecMark(next.mark, cleaned, hasEncoding ? hasEncodedColorChannel(encoding) : false)
  if (!hasEncoding) return decorateConcatSpecs(next, cleaned)
  next.encoding = decorateEncodingPresentation(encoding, cleaned)
  return decorateConcatSpecs(next, cleaned)
}

function decorateConcatSpecs(spec: Record<string, unknown>, theme: ChartThemeOverrides): Record<string, unknown> {
  const next = { ...spec }
  for (const key of ["vconcat", "hconcat", "layer"] as const) {
    const items = next[key]
    if (Array.isArray(items)) {
      next[key] = items.map((item) => (
        item && typeof item === "object" && !Array.isArray(item)
          ? applyChartSpecPresentation(item as Record<string, unknown>, theme)
          : item
      ))
    }
  }
  return next
}

function decorateSpecMark(mark: unknown, theme: ChartThemeOverrides, hasColorEncoding: boolean): unknown {
  const accent = hasColorEncoding ? undefined : chartThemeAccent(theme)
  const roundedPatch = theme.roundedBars
    ? { cornerRadiusEnd: 4 }
    : theme.roundedBars === false
      ? { cornerRadiusEnd: 0 }
      : {}
  if (typeof mark === "string") {
    if (mark === "bar") return { type: "bar", ...roundedPatch, ...(accent ? { color: accent } : {}) }
    if (mark === "line" && (typeof theme.points === "boolean" || accent)) {
      return { type: "line", ...(typeof theme.points === "boolean" ? { point: theme.points } : {}), ...(accent ? { color: accent } : {}) }
    }
    if (accent && (mark === "point" || mark === "circle" || mark === "square" || mark === "area" || mark === "tick" || mark === "rect")) {
      return { type: mark, color: accent }
    }
    return mark
  }
  const current = asRecord(mark)
  const type = typeof current.type === "string" ? current.type : ""
  const next = { ...current }
  if (accent && !("color" in current) && !("fill" in current) && !("stroke" in current)) {
    if (type === "line" || type === "rule") next.stroke = accent
    else if (type === "area") next.fill = accent
    else next.color = accent
  }
  if (type === "bar") Object.assign(next, roundedPatch)
  if (type === "line" && typeof theme.points === "boolean") next.point = theme.points
  if ((type === "point" || type === "circle" || type === "square") && theme.points === false) next.opacity = 0
  return Object.keys(next).length > 0 ? next : mark
}

function hasEncodedColorChannel(encoding: Record<string, unknown>): boolean {
  return ["color", "fill", "stroke"].some((channel) => isDataBoundEncoding(encoding[channel]))
}

function isDataBoundEncoding(value: unknown): boolean {
  const enc = asRecord(value)
  return typeof enc.field === "string" || typeof enc.aggregate === "string"
}

function decorateEncodingPresentation(encoding: Record<string, unknown>, theme: ChartThemeOverrides): Record<string, unknown> {
  const next = { ...encoding }
  const palette = explicitChartPalette(theme)
  for (const channel of ["color", "fill", "stroke", "shape", "size", "opacity", "strokeDash"]) {
    const enc = asRecord(next[channel])
    if (Object.keys(enc).length === 0) continue
    let patched = { ...enc }
    if (palette.length > 0 && (channel === "color" || channel === "fill" || channel === "stroke") && isDataBoundEncoding(enc)) {
      patched = {
        ...patched,
        scale: paletteScale(asRecord(patched.scale), palette),
      }
    }
    if (theme.legend === false) patched.legend = null
    next[channel] = patched
  }
  return next
}

function paletteScale(scale: Record<string, unknown>, palette: string[]): Record<string, unknown> {
  const next = { ...scale }
  delete next.scheme
  return {
    ...next,
    range: palette,
  }
}

function dropFixedSizing(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  delete next.width
  delete next.height
  delete next._width
  delete next._height
  return next
}

function fitFlintVegaSpec(raw: Record<string, unknown>, themeConfig: Record<string, unknown>, theme?: ChartThemeOverrides | null): Record<string, unknown> {
  return {
    ...dropFixedSizing(raw),
    config: mergeChartConfig(raw.config, themeConfig, theme),
    width: "container",
    height: "container",
    autosize: { type: "fit", contains: "padding", resize: true },
  }
}

function fitEChartsGrid(grid: unknown): unknown {
  const fitOne = (item: unknown) => {
    const current = asRecord(item)
    const next = { ...current }
    delete next.width
    delete next.height
    return {
      ...next,
      containLabel: current.containLabel ?? true,
    }
  }
  return Array.isArray(grid) ? grid.map(fitOne) : fitOne(grid)
}

function fitEChartsOption(option: Record<string, unknown>): Record<string, unknown> {
  return {
    ...dropFixedSizing(option),
    grid: fitEChartsGrid(option.grid),
  }
}

function fitChartjsConfig(config: Record<string, unknown>): Record<string, unknown> {
  const options = asRecord(config.options)
  const next = dropFixedSizing(config)
  return {
    ...next,
    options: {
      ...options,
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 0,
    },
  }
}

function resizeEChartsToHost(
  chart: ReturnType<typeof import("echarts").init> | null,
  host: HTMLElement | null,
): void {
  if (!chart || !host) return
  const width = host.clientWidth
  const height = host.clientHeight
  if (width <= 0 || height <= 0) return
  chart.resize({ width, height })
}

function themeTokens(config: Record<string, unknown>): {
  background: string
  foreground: string
  chromeText: string
  chromeBorder: string
  font: string
  palette: string[]
} {
  const axis = asRecord(config.axis)
  const range = asRecord(config.range)
  return {
    background: typeof config.background === "string" ? config.background : "transparent",
    foreground: typeof axis.titleColor === "string" ? axis.titleColor : "#e7e7e7",
    chromeText: typeof axis.labelColor === "string" ? axis.labelColor : "#a8a8a8",
    chromeBorder: typeof axis.gridColor === "string" ? axis.gridColor : "#2a2a2a",
    font: typeof config.font === "string" ? config.font : "ui-sans-serif, system-ui, sans-serif",
    palette: stringArray(range.category),
  }
}

function themeEChartsAxis(axis: unknown, config: Record<string, unknown>, theme?: ChartThemeOverrides | null): unknown {
  const t = themeTokens(config)
  const apply = (item: unknown) => {
    const current = asRecord(item)
    return {
      ...current,
      axisLine: { ...asRecord(current.axisLine), lineStyle: { color: t.chromeBorder } },
      axisTick: { ...asRecord(current.axisTick), lineStyle: { color: t.chromeBorder } },
      splitLine: {
        ...asRecord(current.splitLine),
        show: theme?.grid === false ? false : asRecord(current.splitLine).show,
        lineStyle: { color: t.chromeBorder, opacity: 0.35 },
      },
      axisLabel: {
        ...asRecord(current.axisLabel),
        show: theme?.labels === false ? false : asRecord(current.axisLabel).show,
        color: t.chromeText,
        fontFamily: t.font,
      },
      nameTextStyle: { ...asRecord(current.nameTextStyle), color: t.foreground, fontFamily: t.font },
    }
  }
  return Array.isArray(axis) ? axis.map(apply) : apply(axis)
}

function themeEChartsSeries(series: unknown, theme: ChartThemeOverrides | null | undefined, palette: string[]): unknown {
  const explicitPalette = explicitChartPalette(theme)
  const accent = explicitChartAccent(theme)
  const forceAccent = !!accent
  const seriesCount = Array.isArray(series) ? series.length : 1
  const apply = (item: unknown, index: number) => {
    const current = asRecord(item)
    const type = typeof current.type === "string" ? current.type : ""
    const next = { ...current }
    const color = accent ?? palette[index % Math.max(1, palette.length)]
    if (forceAccent && color) {
      if (type === "line") {
        next.lineStyle = { ...asRecord(current.lineStyle), color }
        next.itemStyle = { ...asRecord(current.itemStyle), color }
      } else if (type === "bar" || type === "scatter" || type === "effectScatter" || type === "pie") {
        next.itemStyle = { ...asRecord(current.itemStyle), color }
      }
    } else if (explicitPalette.length > 0 && seriesCount === 1 && (type === "bar" || type === "scatter" || type === "effectScatter" || type === "pie")) {
      next.colorBy = "data"
    }
    if (type === "line" && typeof theme?.points === "boolean") next.showSymbol = theme.points
    if ((type === "scatter" || type === "effectScatter") && theme?.points === false) next.symbolSize = 0
    if (type === "bar" && typeof theme?.roundedBars === "boolean") {
      next.itemStyle = {
        ...asRecord(next.itemStyle),
        borderRadius: theme.roundedBars ? 4 : 0,
      }
    }
    return next
  }
  return Array.isArray(series) ? series.map(apply) : apply(series, 0)
}

function themeEChartsOption(option: Record<string, unknown>, config: Record<string, unknown>, theme?: ChartThemeOverrides | null): Record<string, unknown> {
  const t = themeTokens(config)
  return {
    ...option,
    backgroundColor: t.background,
    color: t.palette.length > 0 ? t.palette : option.color,
    textStyle: { ...asRecord(option.textStyle), color: t.chromeText, fontFamily: t.font },
    xAxis: themeEChartsAxis(option.xAxis, config, theme),
    yAxis: themeEChartsAxis(option.yAxis, config, theme),
    legend: {
      ...asRecord(option.legend),
      show: theme?.legend === false ? false : asRecord(option.legend).show,
      textStyle: { ...asRecord(asRecord(option.legend).textStyle), color: t.chromeText, fontFamily: t.font },
    },
    series: themeEChartsSeries(option.series, theme, t.palette),
  }
}

function themeChartjsConfig(config: Record<string, unknown>, themeConfig: Record<string, unknown>, theme?: ChartThemeOverrides | null): Record<string, unknown> {
  const t = themeTokens(themeConfig)
  const options = asRecord(config.options)
  const plugins = asRecord(options.plugins)
  const legend = asRecord(plugins.legend)
  const scales = asRecord(options.scales)
  const data = asRecord(config.data)
  const datasets = Array.isArray(config.data) ? [] : Array.isArray(data.datasets) ? data.datasets as unknown[] : []
  const labelCount = Array.isArray(data.labels) ? data.labels.length : 0
  const forceColor = explicitChartPalette(theme).length > 0 || !!explicitChartAccent(theme)
  const themedDatasets = datasets.map((dataset, index) => {
    const current = asRecord(dataset)
    const color = chartjsDatasetColor({
      chartType: typeof config.type === "string" ? config.type : "",
      datasetType: typeof current.type === "string" ? current.type : "",
      palette: t.palette,
      index,
      labelCount,
      datasetCount: datasets.length,
      forceColor,
      accent: explicitChartAccent(theme),
      existingBackground: current.backgroundColor,
      existingBorder: current.borderColor,
    })
    return {
      ...current,
      ...(color.borderColor ? { borderColor: color.borderColor } : {}),
      ...(color.backgroundColor ? { backgroundColor: color.backgroundColor } : {}),
      ...(typeof theme?.points === "boolean" ? { pointRadius: theme.points ? current.pointRadius ?? 3 : 0 } : {}),
      ...(typeof theme?.roundedBars === "boolean" ? { borderRadius: theme.roundedBars ? 4 : 0 } : {}),
    }
  })
  const themedScales = Object.fromEntries(
    Object.entries(scales).map(([key, scale]) => {
      const current = asRecord(scale)
      return [key, {
        ...current,
        grid: { ...asRecord(current.grid), display: theme?.grid === false ? false : asRecord(current.grid).display, color: t.chromeBorder },
        ticks: {
          ...asRecord(current.ticks),
          display: theme?.labels === false ? false : asRecord(current.ticks).display,
          color: t.chromeText,
          font: { ...asRecord(asRecord(current.ticks).font), family: t.font },
        },
        title: { ...asRecord(current.title), color: t.foreground, font: { ...asRecord(asRecord(current.title).font), family: t.font } },
      }]
    }),
  )
  return {
    ...config,
    data: {
      ...data,
      ...(themedDatasets.length > 0 ? { datasets: themedDatasets } : {}),
    },
    options: {
      ...options,
      color: t.chromeText,
      plugins: {
        ...plugins,
        legend: {
          ...legend,
          display: theme?.legend === false ? false : legend.display,
          labels: { ...asRecord(legend.labels), color: t.chromeText, font: { ...asRecord(asRecord(legend.labels).font), family: t.font } },
        },
      },
      elements: {
        ...asRecord(options.elements),
        point: {
          ...asRecord(asRecord(options.elements).point),
          ...(typeof theme?.points === "boolean" ? { radius: theme.points ? asRecord(asRecord(options.elements).point).radius ?? 3 : 0 } : {}),
        },
        bar: {
          ...asRecord(asRecord(options.elements).bar),
          ...(typeof theme?.roundedBars === "boolean" ? { borderRadius: theme.roundedBars ? 4 : 0 } : {}),
        },
      },
      scales: themedScales,
    },
  }
}

function chartjsDatasetColor({
  chartType,
  datasetType,
  palette,
  index,
  labelCount,
  datasetCount,
  forceColor,
  accent,
  existingBackground,
  existingBorder,
}: {
  chartType: string
  datasetType: string
  palette: string[]
  index: number
  labelCount: number
  datasetCount: number
  forceColor: boolean
  accent?: string
  existingBackground: unknown
  existingBorder: unknown
}): { backgroundColor?: unknown; borderColor?: unknown } {
  const color = accent ?? palette[index % Math.max(1, palette.length)]
  if (!color) return {}
  if (!forceColor) {
    return {
      backgroundColor: existingBackground ?? color,
      borderColor: existingBorder ?? color,
    }
  }
  const type = datasetType || chartType
  if (type !== "line" && !accent && labelCount > 1 && datasetCount === 1) {
    const colors = Array.from({ length: labelCount }, (_, i) => palette[i % Math.max(1, palette.length)])
    return { backgroundColor: colors, borderColor: colors }
  }
  return { backgroundColor: color, borderColor: color }
}

function eChartsPickValue(params: unknown, rows: Record<string, unknown>[], xField: string): unknown {
  const p = asRecord(params)
  const name = p.name
  if (name !== undefined && name !== null && name !== "" && typeof name !== "number") return name
  const dataIndex = typeof p.dataIndex === "number" ? p.dataIndex : -1
  const rowValue = dataIndex >= 0 ? rows[dataIndex]?.[xField] : undefined
  if (rowValue !== undefined && rowValue !== null) return rowValue
  const value = p.value
  if (Array.isArray(value) && value.length > 0) return value[0]
  if (asRecord(value)[xField] !== undefined) return asRecord(value)[xField]
  return name
}

function chartjsPickValue(
  chart: unknown,
  element: { index?: number; datasetIndex?: number },
  rows: Record<string, unknown>[],
  xField: string,
): unknown {
  const index = typeof element.index === "number" ? element.index : -1
  const data = asRecord(asRecord(chart).data)
  const labels = Array.isArray(data.labels) ? data.labels : []
  if (index >= 0 && labels[index] !== undefined && labels[index] !== null) return labels[index]
  const datasets = Array.isArray(data.datasets) ? data.datasets : []
  const dataset = asRecord(datasets[typeof element.datasetIndex === "number" ? element.datasetIndex : 0])
  const points = Array.isArray(dataset.data) ? dataset.data : []
  const point = points[index]
  if (asRecord(point)[xField] !== undefined) return asRecord(point)[xField]
  if (asRecord(point).x !== undefined) return asRecord(point).x
  return index >= 0 ? rows[index]?.[xField] : undefined
}

// ── Sizing helpers ──────────────────────────────────────────────────

function fieldOfEnc(enc: unknown): string | null {
  if (!enc || typeof enc !== "object") return null
  const f = (enc as Record<string, unknown>).field
  return typeof f === "string" ? f : null
}

function countDistinct(rows: Record<string, unknown>[], field: string): number {
  const s = new Set<unknown>()
  for (const r of rows) {
    s.add(r[field])
    if (s.size >= 200) break
  }
  return Math.max(1, s.size)
}

/**
 * Given a Vega-Lite spec's encoding + the available container box, compute
 * the per-facet-cell `width`/`height` so the whole grid (Ncols × Nrows) fills
 * the box. Vega-Lite reads `width`/`height` on a faceted spec as the inner
 * cell, so we have to do the division ourselves.
 *
 * Padding accounts for axis titles, tick labels, the legend, and the facet
 * header strip. The numbers are empirical — too generous and the chart looks
 * cramped; too tight and content overflows.
 */
/**
 * Vega-Lite renders each view (spec or concat-subspec) with its own padding
 * around the encoding box — the theme config sets `padding: 8`, so total
 * extra around each view ≈ 16px on each axis. The cell-size math has to
 * subtract this once per *view*, otherwise the rendered chart is taller
 * (or wider) than the container and the bottom clips.
 */
const VIEW_PAD = 16

function computeFacetCellSize(
  enc: Record<string, unknown>,
  rows: Record<string, unknown>[],
  outerW: number,
  outerH: number,
): { width: number; height: number } {
  const colField = fieldOfEnc(enc.column)
  const rowField = fieldOfEnc(enc.row)
  const nCols = colField ? countDistinct(rows, colField) : 1
  const nRows = rowField ? countDistinct(rows, rowField) : 1
  // Chrome budgets are deliberately generous — Vega-Lite's actual axis label
  // and legend widths depend on data (long category names, multi-row label
  // strips, legend entry counts) and clipping on the bottom is much more
  // visible than a few px of underfill, so we err on the cautious side.
  //
  // Width:
  //   y-axis title + tick labels ............ ~80 px
  //   right-side legend (color etc, variable) ~120 px
  //   row-facet header (label strip + title)  ~55 px (added below)
  const axisPadW = 220
  // Height:
  //   bottom axis title + rotated tick labels ~ 90 px (more with long labels)
  //   top column-facet header (labels+title) ~ 55 px (added below)
  //   stretch buffer for spec-level "title" / "subtitle" overflows ~ 30 px
  const axisPadH = 120
  // A column-facet adds: one strip of value labels + the field title above.
  // Each line ≈ 20 px tall plus padding.
  const headerPadH = colField ? 55 : 0
  const headerPadW = rowField ? 55 : 0
  const cellGapW = 14
  const cellGapH = 14
  const availW = Math.max(
    120,
    outerW - axisPadW - headerPadW - VIEW_PAD - cellGapW * (nCols - 1),
  )
  const availH = Math.max(
    100,
    outerH - axisPadH - headerPadH - VIEW_PAD - cellGapH * (nRows - 1),
  )
  return {
    width: Math.max(80, Math.floor(availW / nCols)),
    height: Math.max(60, Math.floor(availH / nRows)),
  }
}
