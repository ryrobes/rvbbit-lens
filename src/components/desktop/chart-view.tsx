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
import { VegaEmbed } from "react-vega"
import type { Result as VegaEmbedResult } from "vega-embed"
import { BarChart3, ClipboardCopy, ClipboardPaste, FileCode2, RotateCcw, Sigma } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { QueryResult } from "@/lib/db/types"
import { inferChartSpec, schemaComment, type InferResult } from "@/lib/desktop/chart-infer"
import { themeFingerprint, vegaConfigFromTheme } from "@/lib/desktop/chart-theme"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"
import { ChartShelf } from "./chart-shelf"

export interface ChartViewProps {
  result: QueryResult
  /** Sticky spec authored by the user. When null, auto-render. */
  userSpec: Record<string, unknown> | null
  onChangeUserSpec: (spec: Record<string, unknown> | null) => void
  /**
   * Spec seeded from a rollup spec (column-aggregate windows). Takes
   * precedence over column-type inference but yields to a user spec.
   */
  seedSpec?: Record<string, unknown> | null
  /** Forwarded to the desktop param-emit flow when a mark is clicked. */
  onEmitParam: (field: string, value: unknown, dataTypeId: number) => void
}

type EditorMode = "shelf" | "yaml"

export function ChartView({ result, userSpec, onChangeUserSpec, seedSpec, onEmitParam }: ChartViewProps) {
  const [mode, setMode] = useState<EditorMode>("shelf")
  const [themeStamp, setThemeStamp] = useState(0)

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
    return vegaConfigFromTheme()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeStamp])

  const baseSpec = userSpec ?? seedSpec ?? inferred?.spec ?? null

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
    if (!baseSpec) return "plain"
    if ("vconcat" in baseSpec || "hconcat" in baseSpec) return "concat"
    const enc = (baseSpec.encoding as Record<string, unknown> | undefined) ?? {}
    if ("column" in enc || "row" in enc) return "facet"
    return "plain"
  }, [baseSpec])


  // Plain spec — never depends on containerSize so its identity is stable
  // across resizes, keeping VegaEmbed from re-mounting.
  const plainSpec = useMemo(() => {
    if (!baseSpec) return null
    return {
      ...baseSpec,
      config: {
        ...(themeConfig as Record<string, unknown>),
        ...((baseSpec.config as Record<string, unknown> | undefined) ?? {}),
      },
      data: { values: result.rows },
      width: "container",
      height: "container",
      autosize: { type: "fit", contains: "padding", resize: true },
    } as Record<string, unknown>
  }, [baseSpec, themeConfig, result.rows])

  // Sized spec for facet / concat layouts.
  const sizedSpec = useMemo(() => {
    if (!baseSpec) return null
    if (layoutMode === "plain") return plainSpec
    const cs = containerSize ?? { w: 600, h: 400 }
    const themed: Record<string, unknown> = {
      ...baseSpec,
      config: {
        ...(themeConfig as Record<string, unknown>),
        ...((baseSpec.config as Record<string, unknown> | undefined) ?? {}),
      },
      data: { values: result.rows },
    }
    if (layoutMode === "facet") {
      const enc = (baseSpec.encoding as Record<string, unknown> | undefined) ?? {}
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
    const kind: "vconcat" | "hconcat" = "vconcat" in baseSpec ? "vconcat" : "hconcat"
    const inner = (baseSpec[kind] as Array<Record<string, unknown>> | undefined) ?? []
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
  }, [baseSpec, layoutMode, plainSpec, themeConfig, result.rows, containerSize])

  const finalSpec = layoutMode === "plain" ? plainSpec : sizedSpec

  // Track current Result so we can detach listeners on re-embed.
  const viewRef = useRef<VegaEmbedResult | null>(null)
  const onEmitParamRef = useRef(onEmitParam)
  useEffect(() => {
    onEmitParamRef.current = onEmitParam
  }, [onEmitParam])

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

  const handleEmbed = useCallback(
    (res: VegaEmbedResult) => {
      // Detach previous listener if any (vega-embed disposes the
      // old view on re-render but be belt-and-suspenders).
      const view = res.view
      const handler = (_name: string, value: unknown) => {
        if (!value || typeof value !== "object") return
        const entries = Object.entries(value as Record<string, unknown>).filter(
          ([k]) => k !== "_vgsid_" && k !== "vlPoint",
        )
        if (entries.length === 0) return
        const [field, rawValues] = entries[0] as [string, unknown]
        const arr = Array.isArray(rawValues) ? rawValues : [rawValues]
        if (arr.length === 0 || arr[0] === undefined || arr[0] === null) return
        const dtid = dataTypeMap.get(field) ?? 25 // default text
        onEmitParamRef.current(field, arr[0], dtid)
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

  const handleError = useCallback((err: unknown) => {
    // Surface in console — the inline error banner below shows a
    // succinct message via the editor's parse path; runtime Vega
    // errors are rarer once the spec validates.
    console.warn("[ChartView] vega-embed error", err)
  }, [])

  const canvas =
    !finalSpec ? (
      <EmptyState columns={result.columns.length} rows={result.rows.length} />
    ) : (
      <div ref={containerRefCallback} className="relative h-full w-full">
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
    )

  return (
    <div className="flex h-full flex-col bg-doc-bg">
      <ChartHeader
        mode={mode}
        userSpec={userSpec}
        markType={inferred?.markType ?? null}
        onModeChange={setMode}
        onReset={() => onChangeUserSpec(null)}
      />

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
  onModeChange,
  onReset,
}: {
  mode: EditorMode
  userSpec: Record<string, unknown> | null
  markType: string | null
  onModeChange: (m: EditorMode) => void
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
      <div className="min-h-0 flex-1 overflow-hidden bg-doc-bg">
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
