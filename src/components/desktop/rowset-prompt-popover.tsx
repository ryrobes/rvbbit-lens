"use client"

import { useEffect, useRef, useState } from "react"
import { Sparkles } from "@/lib/icons"
import type { SemanticOpMeta } from "@/lib/desktop/types"

/**
 * Bind step for a rowset (whole-result) pipeline operator dropped on a block.
 * Collects the single natural-language instruction (the op's `prompt` arg)
 * before the `then <op>('…')` stage is appended. Anchored at the drop point;
 * Cmd/Ctrl+Enter submits, Escape / click-away cancels. Mirrors
 * SemanticBindPopover stylistically.
 */
export function RowsetPromptPopover({
  op,
  blockTitle,
  at,
  onSubmit,
  onCancel,
}: {
  op: SemanticOpMeta
  blockTitle: string
  at: { x: number; y: number }
  onSubmit: (prompt: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("mousedown", onDown)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("mousedown", onDown)
    }
  }, [onCancel])

  const canSubmit = value.trim().length > 0
  const submit = () => {
    if (canSubmit) onSubmit(value.trim())
  }

  const W = 320
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280
  const vh = typeof window !== "undefined" ? window.innerHeight : 800
  const left = Math.min(Math.max(8, at.x), vw - W - 8)
  const top = Math.min(Math.max(8, at.y), vh - 180)

  return (
    <div
      ref={ref}
      role="dialog"
      className="pointer-events-auto fixed z-[80] rounded-lg border border-chrome-border bg-chrome-bg/95 p-2.5 shadow-2xl backdrop-blur"
      style={{ left, top, width: W }}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-foreground">
        <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--viz-op-rowset)" }} />
        <span className="font-mono">then {op.name}</span>
        <span className="min-w-0 flex-1 truncate text-chrome-text/45">on {blockTitle}</span>
      </div>
      {op.description ? (
        <div className="mb-2 text-[10px] leading-snug text-chrome-text/60">{op.description}</div>
      ) : null}
      <label className="block">
        <span className="mb-0.5 block text-[9px] uppercase tracking-wider text-chrome-text/55">instruction</span>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
          placeholder={rowsetPlaceholder(op.name)}
          spellCheck={false}
          className="w-full resize-none rounded border border-chrome-border bg-secondary-background px-2 py-1.5 text-[11px] leading-snug text-foreground outline-none placeholder:text-chrome-text/35 focus:ring-2 focus:ring-ring"
        />
      </label>
      <div className="mt-2 flex items-center justify-between gap-1.5">
        <span className="text-[9px] text-chrome-text/35">⌘↩ to apply</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2 py-1 text-[10px] text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-rvbbit-accent/15 px-2.5 py-1 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
          >
            Apply →
          </button>
        </div>
      </div>
    </div>
  )
}

function rowsetPlaceholder(name: string): string {
  switch (name) {
    case "filter":
      return "e.g. orders over $500 placed this year"
    case "group":
      return "e.g. total revenue by month"
    case "pivot":
      return "e.g. revenue by region across quarters"
    case "top":
      return "e.g. the 10 newest rows"
    case "analyze":
      return "e.g. summarize the main themes"
    case "enrich":
      return "e.g. add a 'sentiment' column from the review text"
    default:
      return "describe what this stage should do"
  }
}
