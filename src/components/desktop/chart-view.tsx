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
  /** Forwarded to the desktop param-emit flow when a mark is clicked. */
  onEmitParam: (field: string, value: unknown, dataTypeId: number) => void
}

type EditorMode = "shelf" | "yaml"

export function ChartView({ result, userSpec, onChangeUserSpec, onEmitParam }: ChartViewProps) {
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

  const baseSpec = userSpec ?? inferred?.spec ?? null

  const finalSpec = useMemo(() => {
    if (!baseSpec) return null
    const merged = {
      ...baseSpec,
      config: { ...(themeConfig as Record<string, unknown>), ...(baseSpec.config as Record<string, unknown> | undefined ?? {}) },
      data: { values: result.rows },
      width: "container",
      height: "container",
      autosize: { type: "fit", contains: "padding", resize: true },
    }
    return merged as Record<string, unknown>
  }, [baseSpec, themeConfig, result.rows])

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
  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (!el || typeof ResizeObserver === "undefined") return
    let rafId = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const view = viewRef.current?.view
        if (!view) return
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
          // Either the view was disposed mid-resize, or this spec
          // doesn't have width/height signals (rare with our
          // inferrer; spec authors who edit YAML and remove them
          // are responsible for their own sizing). Next embed
          // reattaches the listener cleanly.
        }
      })
    })
    observer.observe(el)
    resizeObserverRef.current = observer
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
