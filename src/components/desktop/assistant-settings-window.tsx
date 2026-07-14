"use client"

/**
 * Assistant Settings — model selection, personality, and (soon) voice for the
 * desktop Assistant. Launched from the Semantic folder; the Assistant herself
 * toggles from the OS bar. Model changes write through to the
 * desktop_assistant_turn operator (both operators.model AND the agent step's
 * pinned model — the step wins at runtime, so both must move together).
 * Personality is browser-local (L1, like the thread) and rides every turn in
 * desktop_context.persona.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { fetchLlmModels, type LlmModel } from "@/lib/rvbbit/operators"
import {
  loadPersona,
  savePersona,
  loadSpendThreshold,
  saveSpendThreshold,
  PERSONA_MAX_CHARS,
} from "@/lib/desktop/assistant"

const OPERATOR = "desktop_assistant_turn"

async function dbQuery(
  connectionId: string,
  sql: string,
): Promise<{ rows?: Array<Record<string, unknown>>; error?: string }> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, sql, readOnly: false, rowLimit: 50 }),
  })
  return (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string }
}

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

export function AssistantSettingsWindow({
  activeConnectionId,
}: {
  activeConnectionId: string | null
}) {
  const [models, setModels] = useState<LlmModel[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [persona, setPersona] = useState("")
  const [personaSaved, setPersonaSaved] = useState(false)
  const [spend, setSpend] = useState("")
  const [spendSaved, setSpendSaved] = useState(false)

  useEffect(() => {
    setPersona(loadPersona())
    setSpend(loadSpendThreshold().toFixed(2))
  }, [])

  const onSpendBlur = useCallback(() => {
    const parsed = Number.parseFloat(spend)
    const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    saveSpendThreshold(value)
    setSpend(value.toFixed(2))
    setSpendSaved(true)
    window.setTimeout(() => setSpendSaved(false), 1600)
  }, [spend])

  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    void fetchLlmModels(activeConnectionId).then((r) => {
      if (!cancelled) setModels(r.models)
    })
    void dbQuery(
      activeConnectionId,
      `SELECT model FROM rvbbit.operators WHERE name = ${sqlLit(OPERATOR)}`,
    ).then((r) => {
      if (cancelled) return
      const m = r.rows?.[0]?.model
      if (typeof m === "string") setCurrentModel(m)
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  const applyModel = useCallback(
    async (model: string) => {
      if (!activeConnectionId || !model) return
      setModelStatus("saving…")
      const a = await dbQuery(
        activeConnectionId,
        `SELECT rvbbit.set_operator_model(${sqlLit(OPERATOR)}, ${sqlLit(model)})`,
      )
      // The agent step pins its own model inside steps JSON and wins at
      // runtime — move it in lockstep with operators.model.
      const b = await dbQuery(
        activeConnectionId,
        `UPDATE rvbbit.operators SET steps = jsonb_set(steps, '{0,model}', to_jsonb(${sqlLit(model)}::text)) WHERE name = ${sqlLit(OPERATOR)}`,
      )
      if (a.error || b.error) {
        setModelStatus(a.error ?? b.error ?? "failed")
      } else {
        setCurrentModel(model)
        setModelStatus("saved")
        window.setTimeout(() => setModelStatus(null), 1600)
      }
    },
    [activeConnectionId],
  )

  const onPersonaChange = useCallback((value: string) => {
    setPersona(value.slice(0, PERSONA_MAX_CHARS))
    setPersonaSaved(false)
  }, [])

  const onPersonaBlur = useCallback(() => {
    savePersona(persona)
    setPersonaSaved(true)
    window.setTimeout(() => setPersonaSaved(false), 1600)
  }, [persona])

  const modelOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: LlmModel[] = []
    for (const m of models) {
      const id = m.model
      if (seen.has(id)) continue
      seen.add(id)
      out.push(m)
    }
    if (currentModel && !seen.has(currentModel)) {
      out.unshift({
        provider: "current",
        model: currentModel,
        displayName: null,
        selfHosted: false,
      })
    }
    return out
  }, [models, currentModel])

  const sectionTitle = (label: string) => (
    <div
      className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide"
      style={{ color: "var(--main)" }}
    >
      <span
        aria-hidden
        style={{ textShadow: "0 0 10px color-mix(in oklch, var(--main) 55%, transparent)" }}
      >
        ✦
      </span>
      {label}
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-doc-bg p-4 text-[12px] text-foreground">
      <section>
        {sectionTitle("Mind")}
        <div className="flex items-center gap-2">
          <select
            value={currentModel ?? ""}
            disabled={!activeConnectionId}
            onChange={(e) => void applyModel(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-chrome-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-main/60"
          >
            {currentModel === null ? <option value="">loading…</option> : null}
            {modelOptions.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName ?? m.model}
                {m.selfHosted ? " · self-hosted" : ""}
              </option>
            ))}
          </select>
          {modelStatus ? (
            <span className="shrink-0 text-[11px] text-chrome-text/60">{modelStatus}</span>
          ) : null}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/55">
          The model behind every assistant turn. Frontier models recommended —
          she reads your whole desktop each turn and writes SQL, charts, and
          apps against live schema.
        </p>
      </section>

      <section>
        {sectionTitle("Personality")}
        <textarea
          value={persona}
          onChange={(e) => onPersonaChange(e.target.value)}
          onBlur={onPersonaBlur}
          rows={6}
          placeholder={
            "Standing notes on voice and behavior — she reads these every turn.\ne.g. “Be blunt. Prefer charts over tables. Never touch blocks I made by hand without asking.”"
          }
          className="w-full resize-none rounded-md border border-chrome-border bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-chrome-text/35 focus:border-main/60"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-chrome-text/45">
          <span>{personaSaved ? "saved" : "saves on blur · local to this browser"}</span>
          <span>
            {persona.length}/{PERSONA_MAX_CHARS}
          </span>
        </div>
      </section>

      <section>
        {sectionTitle("Budget")}
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-chrome-text/70">$</span>
          <input
            type="number"
            min={0}
            step={0.05}
            value={spend}
            onChange={(e) => {
              setSpend(e.target.value)
              setSpendSaved(false)
            }}
            onBlur={onSpendBlur}
            className="w-24 rounded-md border border-chrome-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-main/60"
          />
          <span className="text-[11px] text-chrome-text/55">
            {spendSaved ? "saved" : "per semantic SQL run"}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/55">
          Semantic SQL she projects at or under this cost runs without asking
          (she'll still mention the price). Anything over, she quotes the
          estimate and waits for your go-ahead. $0.00 = always ask first.
        </p>
      </section>

      <section>
        {sectionTitle("Voice")}
        <div className="space-y-1.5 opacity-55">
          <label className="flex items-center justify-between rounded-md border border-chrome-border/60 bg-chrome-bg/30 px-2.5 py-1.5">
            <span>Voice input (STT)</span>
            <span className="text-[10px] uppercase tracking-wide text-chrome-text/50">soon</span>
          </label>
          <label className="flex items-center justify-between rounded-md border border-chrome-border/60 bg-chrome-bg/30 px-2.5 py-1.5">
            <span>Spoken replies (TTS)</span>
            <span className="text-[10px] uppercase tracking-wide text-chrome-text/50">soon</span>
          </label>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-chrome-text/55">
          Her utterances are already sized for speech — voice is icing, and the
          cake is baked.
        </p>
      </section>
    </div>
  )
}
