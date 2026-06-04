"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Sparkles, X } from "@/lib/icons"
import { randomUUID } from "@/lib/uuid"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import { runScryStage, scopeFromHits, type ScryStage } from "@/lib/desktop/scry"
import { hitLabel, KindBadge, ScoreBar } from "./scry-shared"

interface ScryPromptProps {
  open: boolean
  onClose: () => void
  connectionId: string | null
  /** Spawn a fresh, accreting results window from the current cascade. */
  onSpawnResults: (chain: { query: string }[], hits: DataSearchHit[]) => void
  /** Open a table directly (reuses the Finder/Data-Search table opener). */
  onOpenTable: (schema: string, name: string) => void
}

function emptyStage(): ScryStage {
  return { id: randomUUID(), query: "", hits: [], loading: false }
}

export function ScryPrompt({ open, onClose, connectionId, onSpawnResults, onOpenTable }: ScryPromptProps) {
  const [stages, setStagesState] = useState<ScryStage[]>([emptyStage()])
  // Mirror state in a ref so the async cascade loop and keystroke handlers
  // always read the latest stages without stale-closure surprises.
  const stagesRef = useRef(stages)
  const runRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const setStages = useCallback((next: ScryStage[]) => {
    stagesRef.current = next
    setStagesState(next)
  }, [])

  // Fresh chain each time the prompt opens; focus the root input.
  useEffect(() => {
    if (!open) return
    setStages([emptyStage()])
    runRef.current++
    const t = setTimeout(() => inputRefs.current[0]?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, setStages])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Patch one stage's result fields against the *latest* stages (so a write
  // landing after the user edited another stage can't clobber their text).
  const patch = useCallback((i: number, partial: Partial<ScryStage>) => {
    setStages(stagesRef.current.map((s, idx) => (idx === i ? { ...s, ...partial } : s)))
  }, [setStages])

  // Re-flow stages [from .. end] sequentially: each one searches within the
  // previous one's relations. A newer run supersedes this one (runRef guard).
  const recompute = useCallback(async (from: number) => {
    if (!connectionId) return
    const myRun = ++runRef.current
    let scope: Set<string> | null =
      from === 0 ? null : scopeFromHits(stagesRef.current[from - 1]?.hits ?? [])
    for (let i = from; i < stagesRef.current.length; i++) {
      const q = stagesRef.current[i].query.trim()
      if (!q) { patch(i, { hits: [], loading: false, error: undefined }); scope = new Set(); continue }
      patch(i, { loading: true })
      const { hits, error } = await runScryStage(connectionId, q, scope)
      if (runRef.current !== myRun) return
      patch(i, { hits, loading: false, error })
      scope = scopeFromHits(hits)
    }
  }, [connectionId, patch])

  const scheduleRecompute = useCallback((from: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void recompute(from), 160)
  }, [recompute])

  const setQuery = useCallback((i: number, q: string) => {
    setStages(stagesRef.current.map((s, idx) => (idx === i ? { ...s, query: q } : s)))
    scheduleRecompute(i)
  }, [setStages, scheduleRecompute])

  const addStage = useCallback(() => {
    const next = [...stagesRef.current, emptyStage()]
    setStages(next)
    const idx = next.length - 1
    setTimeout(() => inputRefs.current[idx]?.focus(), 20)
  }, [setStages])

  const removeStage = useCallback((i: number) => {
    if (stagesRef.current.length <= 1) return
    const next = stagesRef.current.filter((_, idx) => idx !== i)
    setStages(next)
    scheduleRecompute(Math.max(0, i - 1))
    setTimeout(() => inputRefs.current[Math.max(0, i - 1)]?.focus(), 20)
  }, [setStages, scheduleRecompute])

  // The deepest non-empty stage is what we preview and spawn.
  const finalStage = [...stages].reverse().find((s) => s.query.trim())
  const finalHits = finalStage?.hits ?? []
  const finalErr = finalStage?.error
  const relCount = new Set(finalHits.map((h) => `${h.schema}.${h.rel}`)).size
  const canRefine = !!stages[stages.length - 1]?.query.trim()

  const spawn = useCallback(() => {
    const chain = stagesRef.current.filter((s) => s.query.trim()).map((s) => ({ query: s.query.trim() }))
    if (chain.length === 0) return
    const fs = [...stagesRef.current].reverse().find((s) => s.query.trim())
    onSpawnResults(chain, fs?.hits ?? [])
  }, [onSpawnResults])

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
      if (e.key === "Enter") {
        e.preventDefault()
        spawn()
      } else if (e.key === "Tab" && !e.shiftKey) {
        // Tab off the last non-empty stage adds a "within" refinement.
        if (i === stagesRef.current.length - 1 && stagesRef.current[i].query.trim()) {
          e.preventDefault()
          addStage()
        }
      } else if (e.key === "Backspace" && stagesRef.current[i].query === "" && i > 0) {
        e.preventDefault()
        removeStage(i)
      }
    },
    [spawn, addStage, removeStage],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-overlay px-4 pt-[12vh] backdrop-blur-sm"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Scry"
        onMouseDown={(e) => e.stopPropagation()}
        className="nextstep-panel w-[620px] max-w-full overflow-hidden rounded-lg border border-chrome-border bg-chrome-bg/95 shadow-2xl backdrop-blur"
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-chrome-border/60 px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 text-terminal" />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-terminal/80">scry</span>
          <span className="ml-auto text-[10px] text-chrome-text/45">semantic catalog search</span>
        </div>

        {/* cascade stack */}
        <div>
          {stages.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 border-b border-chrome-border/40 px-3 py-2">
              <span className="w-4 shrink-0 text-center font-mono text-[13px] text-terminal">{i === 0 ? "›" : "⤷"}</span>
              <input
                ref={(el) => {
                  inputRefs.current[i] = el
                }}
                value={s.query}
                onChange={(e) => setQuery(i, e.target.value)}
                onKeyDown={(e) => onInputKey(e, i)}
                placeholder={i === 0 ? "describe the data you're looking for…" : "…within those, find…"}
                spellCheck={false}
                style={{ caretColor: "var(--terminal)" }}
                className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground placeholder:text-chrome-text/35 focus:outline-none"
              />
              {s.loading ? (
                <Loader2 className="h-3 w-3 animate-spin text-chrome-text/50" />
              ) : s.query.trim() ? (
                <span className="text-[10px] tabular-nums text-chrome-text/45">{s.hits.length}</span>
              ) : null}
              {stages.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeStage(i)}
                  title="Remove stage"
                  className="grid h-4 w-4 place-items-center rounded text-chrome-text/40 hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        {/* results / preview */}
        <div className="max-h-[42vh] min-h-[3rem] overflow-auto">
          {finalErr ? (
            <div className="px-3 py-3 text-[11px] text-danger">{finalErr}</div>
          ) : !connectionId ? (
            <div className="px-3 py-3 text-[11px] text-chrome-text/55">Connect to a database to scry its catalog.</div>
          ) : !finalStage ? (
            <div className="px-3 py-4 text-[11px] leading-relaxed text-chrome-text/50">
              Search tables &amp; columns by meaning. Press <Kbd>Tab</Kbd> to refine within the results,{" "}
              <Kbd>↩</Kbd> to spawn a results window.
            </div>
          ) : finalHits.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-chrome-text/55">
              No matches{stages.length > 1 ? " within the upstream results" : ""}.
            </div>
          ) : (
            <ul className="divide-y divide-chrome-border/30">
              {finalHits.map((h) => (
                <li
                  key={`${h.kind}:${h.nodeId}`}
                  onClick={() => onOpenTable(h.schema, h.rel)}
                  className="group flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-foreground/[0.04]"
                >
                  <KindBadge kind={h.kind} />
                  <span className="truncate font-mono text-[12px] text-foreground">{hitLabel(h)}</span>
                  <span className="flex-1" />
                  <ScoreBar score={h.score} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-2 border-t border-chrome-border/60 px-3 py-2 text-[10px] text-chrome-text/50">
          <span>{finalHits.length > 0 ? `${finalHits.length} results · ${relCount} relations` : ""}</span>
          <span className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={addStage}
              disabled={!canRefine}
              className="rounded border border-chrome-border/60 px-2 py-0.5 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            >
              ⤷ Refine within
            </button>
            <button
              type="button"
              onClick={spawn}
              disabled={finalHits.length === 0}
              className="rounded border border-chrome-border bg-secondary-background px-2 py-0.5 text-foreground hover:bg-foreground/[0.08] disabled:opacity-40"
            >
              Spawn results →
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-chrome-border/60 bg-foreground/[0.05] px-1 py-0.5 font-mono text-[9px] text-chrome-text">
      {children}
    </kbd>
  )
}
