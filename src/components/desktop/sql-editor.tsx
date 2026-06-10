"use client"

import { useEffect, useMemo, useRef } from "react"
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { sql, PostgreSQL, type SQLNamespace } from "@codemirror/lang-sql"
import { json as jsonLang } from "@codemirror/lang-json"
import type { CompletionSource } from "@codemirror/autocomplete"
import { EditorView, keymap, tooltips } from "@codemirror/view"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"
import { blockReferenceExtensions, type BlockReferenceMap } from "@/lib/desktop/sql-block-refs"
import { hasParamDragPayload } from "@/lib/desktop/param-drag"
import { hasColumnDragPayload } from "@/lib/desktop/column-drag"
import { hasBlockDragPayload } from "@/lib/desktop/block-drag"

/** The app's internal chip drags (param / column / block) carry a text/plain
 *  fallback that CodeMirror's default drop would paste into the SQL. The window's
 *  own drop zone already handles these, so the editor must ignore them. */
function isInternalChipDrag(dt: DataTransfer | null): boolean {
  return hasParamDragPayload(dt) || hasColumnDragPayload(dt) || hasBlockDragPayload(dt)
}

interface SqlEditorProps {
  value: string
  onChange: (next: string) => void
  onRun?: () => void
  height?: string | number
  readOnly?: boolean
  fontSize?: number
  /** "plain" drops SQL syntax highlighting + autocomplete + line numbers — for
   *  the natural-language "Ask" mode where the content is a question, not SQL.
   *  "json" swaps the SQL grammar for JSON highlighting (e.g. action arg bodies). */
  language?: "sql" | "json" | "plain"
  /** Soft-wrap long lines instead of scrolling horizontally — for read-only
   *  previews where a long line would otherwise widen the container. */
  wrap?: boolean
  /** Live schema (pg schema → table → columns) for table/column autocomplete.
   *  Built from the connection's SchemaSnapshot; omit for keyword-only. */
  schema?: SQLNamespace
  /** Schema whose tables complete unqualified (the Postgres search_path head). */
  defaultSchema?: string
  /** Extra autocomplete sources merged with lang-sql's (e.g. rvbbit functions). */
  completionSources?: readonly CompletionSource[]
  /** Cross-block `{name}` references → info, for highlighting + hover tooltips
   *  showing the referenced block's SQL. Omit to disable reference decoration. */
  blockReferences?: BlockReferenceMap
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  height = "100%",
  readOnly,
  fontSize = 13,
  language = "sql",
  wrap = false,
  schema,
  defaultSchema,
  completionSources,
  blockReferences,
}: SqlEditorProps) {
  const ref = useRef<ReactCodeMirrorRef | null>(null)
  const plain = language === "plain"
  const isJson = language === "json"

  const extensions: Extension[] = useMemo(() => {
    const exts: Extension[] = []
    // Swallow internal chip drags so CodeMirror's default drop doesn't paste the
    // chip's text/plain fallback (e.g. "param.<key>") into the SQL. Returning
    // true preventDefaults + stops CM here; we deliberately do NOT stopPropagation,
    // so the window's onDrop still fires and subscribes/merges.
    exts.push(
      EditorView.domEventHandlers({
        dragover: (event) => isInternalChipDrag(event.dataTransfer),
        drop: (event) => {
          if (!isInternalChipDrag(event.dataTransfer)) return false
          event.preventDefault()
          return true
        },
      }),
    )
    if (plain) {
      exts.push(EditorView.lineWrapping) // wrap long NL questions instead of scrolling
    } else if (isJson) {
      exts.push(jsonLang()) // JSON grammar → the theme's highlightStyle colors it
    } else {
      // schema-aware completion when a SQLNamespace is supplied (tables + columns
      // with type hints); falls back to keyword-only completion otherwise.
      const lang = sql({ dialect: PostgreSQL, upperCaseKeywords: false, schema, defaultSchema })
      exts.push(lang)
      // merge any extra sources (e.g. rvbbit semantic functions) into the SQL
      // language's completion — they run alongside the schema/keyword sources.
      for (const source of completionSources ?? []) {
        exts.push(lang.language.data.of({ autocomplete: source }))
      }
      // highlight cross-block {name} references + hover-to-see their SQL.
      if (blockReferences) exts.push(blockReferenceExtensions(blockReferences))
      // Render tooltips (hover cards + the completion popup) into <body> so the
      // editor's overflow-hidden chrome (rail, window body) can't clip them. CM
      // copies the editor's theme classes onto the external container, so the
      // themed styling is preserved.
      if (typeof document !== "undefined") {
        exts.push(tooltips({ position: "fixed", parent: document.body }))
      }
    }
    if (wrap && !plain) exts.push(EditorView.lineWrapping)
    if (onRun) {
      exts.push(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => { onRun(); return true },
          },
        ]),
      )
    }
    return exts
  }, [onRun, plain, isJson, wrap, schema, defaultSchema, completionSources, blockReferences])

  // Auto-focus on first mount.
  useEffect(() => {
    if (ref.current?.view) {
      ref.current.view.focus()
    }
  }, [])

  return (
    <div className="h-full w-full overflow-hidden" style={{ fontSize }}>
      <CodeMirror
        ref={ref}
        value={value}
        height={typeof height === "number" ? `${height}px` : height}
        // @uiw applies height="100%" only to .cm-editor/.cm-scroller, never to
        // its own root wrapper div — so without an explicit height here that
        // div is auto-sized and .cm-editor's 100% collapses to content height
        // (text overflows + gets clipped, no scrollbar). Fill the parent so the
        // scroller actually has a bounded box to scroll within.
        className="h-full w-full"
        theme="none"
        readOnly={readOnly}
        extensions={[...extensions, ...rvbbitLensCodeMirrorTheme]}
        onChange={onChange}
        basicSetup={{
          highlightActiveLine: !plain,
          lineNumbers: !plain,
          foldGutter: false,
          dropCursor: true,
          autocompletion: !plain && !isJson,
          searchKeymap: true,
        }}
      />
    </div>
  )
}
