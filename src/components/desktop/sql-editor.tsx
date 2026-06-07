"use client"

import { useEffect, useMemo, useRef } from "react"
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { sql, PostgreSQL, type SQLNamespace } from "@codemirror/lang-sql"
import type { CompletionSource } from "@codemirror/autocomplete"
import { EditorView, keymap } from "@codemirror/view"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"

interface SqlEditorProps {
  value: string
  onChange: (next: string) => void
  onRun?: () => void
  height?: string | number
  readOnly?: boolean
  fontSize?: number
  /** "plain" drops SQL syntax highlighting + autocomplete + line numbers — for
   *  the natural-language "Ask" mode where the content is a question, not SQL. */
  language?: "sql" | "plain"
  /** Live schema (pg schema → table → columns) for table/column autocomplete.
   *  Built from the connection's SchemaSnapshot; omit for keyword-only. */
  schema?: SQLNamespace
  /** Schema whose tables complete unqualified (the Postgres search_path head). */
  defaultSchema?: string
  /** Extra autocomplete sources merged with lang-sql's (e.g. rvbbit functions). */
  completionSources?: readonly CompletionSource[]
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  height = "100%",
  readOnly,
  fontSize = 13,
  language = "sql",
  schema,
  defaultSchema,
  completionSources,
}: SqlEditorProps) {
  const ref = useRef<ReactCodeMirrorRef | null>(null)
  const plain = language === "plain"

  const extensions: Extension[] = useMemo(() => {
    const exts: Extension[] = []
    if (plain) {
      exts.push(EditorView.lineWrapping) // wrap long NL questions instead of scrolling
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
    }
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
  }, [onRun, plain, schema, defaultSchema, completionSources])

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
          autocompletion: !plain,
          searchKeymap: true,
        }}
      />
    </div>
  )
}
