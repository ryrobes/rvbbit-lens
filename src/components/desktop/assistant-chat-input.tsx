"use client"

import { useMemo, useRef } from "react"
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { EditorView, keymap } from "@codemirror/view"
import { Prec } from "@codemirror/state"
import { insertNewlineAndIndent } from "@codemirror/commands"
import { rvbbitLensCodeMirrorTheme } from "@/lib/desktop/codemirror-theme"

/**
 * The assistant's message box as a real CodeMirror instance: proper cursor
 * movement, undo history, and multi-line editing instead of a bare textarea.
 * Grows with the draft (about two lines minimum) up to a cap, then scrolls
 * internally — the draft never disappears above a fixed-height box.
 *
 * Enter sends, Shift+Enter inserts a newline — bound at highest precedence
 * so CodeMirror's default newline never wins.
 */
export function AssistantChatInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  editorRef,
}: {
  value: string
  onChange: (next: string) => void
  onSend: () => void
  disabled?: boolean
  placeholder?: string
  editorRef?: React.RefObject<ReactCodeMirrorRef | null>
}) {
  // The Enter keymap is built once; it reads the CURRENT send through a ref
  // so re-renders don't reconfigure the editor every keystroke.
  const sendRef = useRef(onSend)
  sendRef.current = onSend
  const extensions = useMemo(
    () => [
      Prec.highest(
        keymap.of([
          {
            key: "Enter",
            run: () => {
              sendRef.current()
              return true
            },
          },
          { key: "Shift-Enter", run: insertNewlineAndIndent },
        ]),
      ),
      EditorView.lineWrapping,
      rvbbitLensCodeMirrorTheme,
      // Chat-bar overrides on top of the shared theme: transparent chrome,
      // grow-then-scroll sizing.
      EditorView.theme({
        "&": { backgroundColor: "transparent", fontSize: "13px", maxHeight: "180px" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { overflowY: "auto", lineHeight: "1.6" },
        ".cm-content": { padding: "3px 0", minHeight: "40px", caretColor: "var(--main)" },
        ".cm-line": { padding: "0 2px 0 0" },
        ".cm-placeholder": { color: "color-mix(in oklch, var(--foreground) 38%, transparent)" },
      }),
    ],
    [],
  )
  return (
    <CodeMirror
      ref={editorRef ?? undefined}
      value={value}
      onChange={onChange}
      editable={!disabled}
      readOnly={disabled}
      placeholder={placeholder}
      // Without this, react-codemirror injects its default LIGHT theme —
      // a white box over the translucent dock. The shared lens theme (in
      // extensions) is the only theme wanted here.
      theme="none"
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        highlightSelectionMatches: false,
        autocompletion: false,
        closeBrackets: false,
        bracketMatching: false,
        searchKeymap: false,
      }}
      extensions={extensions}
      className="min-w-0 flex-1"
    />
  )
}
