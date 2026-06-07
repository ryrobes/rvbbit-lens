"use client"

import { useEffect, useRef, useState } from "react"
import { Sparkles } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { DesktopColumnRef, SemanticArg, SemanticOpMeta } from "@/lib/desktop/types"

type ArgMode = "literal" | "column"
interface ArgDraft {
  mode: ArgMode
  literal: string
  column: string
}

/**
 * Bind step for a multi-arg semantic op dropped on a column. arg[0] is the
 * dragged column; this collects each remaining arg, which can be bound either
 * as a typed literal (classify's `categories`, semantic_score's `criterion`)
 * OR as another column from the same relation (the pairwise ops —
 * contradicts/implies/supports — `rvbbit.contradicts(a::text, b::text)`).
 * Anchored at the drop point; Enter submits, Escape / click-away cancels.
 */
export function SemanticBindPopover({
  op,
  columnName,
  availableColumns,
  at,
  onSubmit,
  onCancel,
}: {
  op: SemanticOpMeta
  columnName: string
  /** All columns of the source relation, for column-valued binds. */
  availableColumns: DesktopColumnRef[]
  at: { x: number; y: number }
  onSubmit: (args: SemanticArg[]) => void
  onCancel: () => void
}) {
  const extra = op.argNames.slice(1)
  // Pairwise ops use a/b arg names → both sides are statements, so default the
  // extra arg to a column. Everything else (topic/criterion/categories) defaults
  // to a literal. Column mode is only possible when siblings exist.
  const canColumn = availableColumns.length > 0
  const preferColumn = op.argNames[0] === "a" && canColumn
  const defaultColumn = (availableColumns.find((c) => c.name !== columnName) ?? availableColumns[0])?.name ?? ""
  const [drafts, setDrafts] = useState<ArgDraft[]>(() =>
    extra.map(() => ({ mode: preferColumn ? "column" : "literal", literal: "", column: defaultColumn })),
  )
  const ref = useRef<HTMLDivElement>(null)
  const firstInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstInput.current?.focus()
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

  const setDraft = (i: number, patch: Partial<ArgDraft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)))

  const draftValid = (d: ArgDraft) => (d.mode === "column" ? d.column.length > 0 : d.literal.trim().length > 0)
  const canSubmit = drafts.every(draftValid)
  const submit = () => {
    if (!canSubmit) return
    onSubmit(
      drafts.map((d): SemanticArg =>
        d.mode === "column" ? { kind: "column", column: d.column } : { kind: "literal", value: d.literal.trim() },
      ),
    )
  }

  const W = 300
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280
  const vh = typeof window !== "undefined" ? window.innerHeight : 800
  const left = Math.min(Math.max(8, at.x), vw - W - 8)
  const top = Math.min(Math.max(8, at.y), vh - 200)

  return (
    <div
      ref={ref}
      role="dialog"
      className="pointer-events-auto fixed z-[80] rounded-lg border border-chrome-border bg-chrome-bg/95 p-2.5 shadow-2xl backdrop-blur"
      style={{ left, top, width: W }}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-foreground">
        <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--viz-op-pipeline)" }} />
        <span className="font-mono">rvbbit.{op.name}</span>
        <span className="truncate text-chrome-text/45">({columnName}, …)</span>
      </div>
      {op.description ? (
        <div className="mb-2 text-[10px] leading-snug text-chrome-text/60">{op.description}</div>
      ) : null}
      <div className="space-y-2">
        {extra.map((name, i) => {
          const d = drafts[i]
          return (
            <label key={name} className="block">
              <span className="mb-0.5 flex items-center justify-between text-[9px] uppercase tracking-wider text-chrome-text/55">
                {name}
                {canColumn ? (
                  <span className="inline-flex overflow-hidden rounded border border-chrome-border/70">
                    <button
                      type="button"
                      onClick={() => setDraft(i, { mode: "literal" })}
                      className={cn(
                        "px-1.5 py-0.5 text-[8px] normal-case tracking-normal transition-colors",
                        d.mode === "literal" ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/55 hover:bg-foreground/[0.06]",
                      )}
                    >
                      value
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft(i, { mode: "column" })}
                      className={cn(
                        "px-1.5 py-0.5 text-[8px] normal-case tracking-normal transition-colors",
                        d.mode === "column" ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/55 hover:bg-foreground/[0.06]",
                      )}
                    >
                      column
                    </button>
                  </span>
                ) : null}
              </span>
              {d.mode === "column" ? (
                <select
                  value={d.column}
                  onChange={(e) => setDraft(i, { column: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
                  className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  {availableColumns.map((c) => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  ref={i === 0 ? firstInput : undefined}
                  value={d.literal}
                  onChange={(e) => setDraft(i, { literal: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
                  placeholder={argPlaceholder(name)}
                  spellCheck={false}
                  className="h-7 w-full rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground outline-none placeholder:text-chrome-text/35 focus:ring-2 focus:ring-ring"
                />
              )}
            </label>
          )
        })}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
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
  )
}

function argPlaceholder(arg: string): string {
  switch (arg) {
    case "categories":
    case "buckets":
      return "e.g. positive,negative,neutral"
    case "criterion":
      return "e.g. mentions a refund"
    case "what":
      return "value to extract"
    case "topic":
      return "topic to score against"
    case "intent":
      return "describe the transform"
    case "b":
      return "statement to compare against"
    default:
      return ""
  }
}
