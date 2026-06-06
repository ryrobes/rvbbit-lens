"use client"

/**
 * useScryCascade — the reactive "it" cascade, extracted from the original
 * popover so the prompt-in-a-box and the full-screen Scry canvas share one
 * source of truth. Pure logic: stages, race-guarded re-flow, no presentation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react"
import { randomUUID } from "@/lib/uuid"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import { runScryStage, scopeFromHits, type ScryStage } from "@/lib/desktop/scry"

export interface UseScryCascade {
  stages: ScryStage[]
  inputRefs: MutableRefObject<(HTMLInputElement | null)[]>
  finalStage: ScryStage | undefined
  finalHits: DataSearchHit[]
  finalError: string | undefined
  canRefine: boolean
  setQuery: (i: number, q: string) => void
  addStage: () => void
  removeStage: (i: number) => void
  onInputKey: (e: ReactKeyboardEvent<HTMLInputElement>, i: number) => void
  submit: () => void
}

function emptyStage(): ScryStage {
  return { id: randomUUID(), query: "", hits: [], loading: false }
}

export function useScryCascade(
  connectionId: string | null,
  open: boolean,
  onSubmit: (chain: { query: string }[], hits: DataSearchHit[]) => void,
  graph: string = "db_catalog",
): UseScryCascade {
  const [stages, setStagesState] = useState<ScryStage[]>([emptyStage()])
  // Mirror in a ref so the async re-flow + key handlers read the latest stages.
  const stagesRef = useRef(stages)
  const runRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  const setStages = useCallback((next: ScryStage[]) => {
    stagesRef.current = next
    setStagesState(next)
  }, [])

  // Fresh chain each time Scry opens; focus the root input.
  useEffect(() => {
    if (!open) return
    setStages([emptyStage()])
    runRef.current++
    const t = setTimeout(() => inputRefs.current[0]?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, setStages])

  // Patch one stage's result fields against the LATEST stages so a write that
  // lands after the user edited another stage can't clobber their text.
  const patch = useCallback(
    (i: number, partial: Partial<ScryStage>) => {
      setStages(stagesRef.current.map((s, idx) => (idx === i ? { ...s, ...partial } : s)))
    },
    [setStages],
  )

  // Re-flow stages [from..end]: each searches within the prior one's relations.
  const recompute = useCallback(
    async (from: number) => {
      if (!connectionId) return
      const myRun = ++runRef.current
      let scope: Set<string> | null =
        from === 0 ? null : scopeFromHits(stagesRef.current[from - 1]?.hits ?? [])
      for (let i = from; i < stagesRef.current.length; i++) {
        const q = stagesRef.current[i].query.trim()
        if (!q) {
          patch(i, { hits: [], loading: false, error: undefined })
          scope = new Set()
          continue
        }
        patch(i, { loading: true })
        const { hits, error } = await runScryStage(connectionId, q, scope, graph)
        if (runRef.current !== myRun) return
        patch(i, { hits, loading: false, error })
        scope = scopeFromHits(hits)
      }
    },
    [connectionId, patch, graph],
  )

  // Re-flow the whole chain against the new graph when the source toggles.
  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute
  useEffect(() => {
    if (open) void recomputeRef.current(0)
  }, [graph, open])

  const scheduleRecompute = useCallback(
    (from: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void recompute(from), 160)
    },
    [recompute],
  )

  const setQuery = useCallback(
    (i: number, q: string) => {
      setStages(stagesRef.current.map((s, idx) => (idx === i ? { ...s, query: q } : s)))
      scheduleRecompute(i)
    },
    [setStages, scheduleRecompute],
  )

  const addStage = useCallback(() => {
    const next = [...stagesRef.current, emptyStage()]
    setStages(next)
    const idx = next.length - 1
    setTimeout(() => inputRefs.current[idx]?.focus(), 20)
  }, [setStages])

  const removeStage = useCallback(
    (i: number) => {
      if (stagesRef.current.length <= 1) return
      const next = stagesRef.current.filter((_, idx) => idx !== i)
      setStages(next)
      scheduleRecompute(Math.max(0, i - 1))
      setTimeout(() => inputRefs.current[Math.max(0, i - 1)]?.focus(), 20)
    },
    [setStages, scheduleRecompute],
  )

  const finalStage = useMemo(() => [...stages].reverse().find((s) => s.query.trim()), [stages])
  const finalHits = useMemo(() => finalStage?.hits ?? [], [finalStage])
  const finalError = finalStage?.error
  const canRefine = !!stages[stages.length - 1]?.query.trim()

  const submit = useCallback(() => {
    const chain = stagesRef.current.filter((s) => s.query.trim()).map((s) => ({ query: s.query.trim() }))
    if (chain.length === 0) return
    const fs = [...stagesRef.current].reverse().find((s) => s.query.trim())
    onSubmitRef.current(chain, fs?.hits ?? [])
  }, [])

  const onInputKey = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>, i: number) => {
      if (e.key === "Enter") {
        e.preventDefault()
        submit()
      } else if (e.key === "Tab" && !e.shiftKey) {
        if (i === stagesRef.current.length - 1 && stagesRef.current[i].query.trim()) {
          e.preventDefault()
          addStage()
        }
      } else if (e.key === "Backspace" && stagesRef.current[i].query === "" && i > 0) {
        e.preventDefault()
        removeStage(i)
      }
    },
    [submit, addStage, removeStage],
  )

  return {
    stages,
    inputRefs,
    finalStage,
    finalHits,
    finalError,
    canRefine,
    setQuery,
    addStage,
    removeStage,
    onInputKey,
    submit,
  }
}
