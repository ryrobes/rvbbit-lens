"use client"

import { useEffect, useMemo, useRef } from "react"
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { sql, PostgreSQL } from "@codemirror/lang-sql"
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
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  height = "100%",
  readOnly,
  fontSize = 13,
  language = "sql",
}: SqlEditorProps) {
  const ref = useRef<ReactCodeMirrorRef | null>(null)
  const plain = language === "plain"

  const extensions: Extension[] = useMemo(() => {
    const exts: Extension[] = []
    if (plain) exts.push(EditorView.lineWrapping) // wrap long NL questions instead of scrolling
    else exts.push(sql({ dialect: PostgreSQL, upperCaseKeywords: false }))
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
  }, [onRun, plain])

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
