"use client"

import { useEffect, useMemo, useRef } from "react"
import CodeMirror, { type Extension, type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { sql, PostgreSQL } from "@codemirror/lang-sql"
import { keymap } from "@codemirror/view"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"

interface SqlEditorProps {
  value: string
  onChange: (next: string) => void
  onRun?: () => void
  height?: string | number
  readOnly?: boolean
  fontSize?: number
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  height = "100%",
  readOnly,
  fontSize = 13,
}: SqlEditorProps) {
  const ref = useRef<ReactCodeMirrorRef | null>(null)

  const extensions: Extension[] = useMemo(() => {
    const exts: Extension[] = [sql({ dialect: PostgreSQL, upperCaseKeywords: false })]
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
  }, [onRun])

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
          highlightActiveLine: true,
          lineNumbers: true,
          foldGutter: false,
          dropCursor: true,
          autocompletion: true,
          searchKeymap: true,
        }}
      />
    </div>
  )
}
