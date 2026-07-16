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

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"
import { fetchLlmModels, type LlmModel } from "@/lib/rvbbit/operators"
import { WALLPAPER_FILE_ACCEPT, isLikelyImageFile } from "@/lib/desktop/wallpaper-store"
import {
  ASSISTANT_NAME_MAX_CHARS,
  centerCropAssistantAvatar,
  clearAssistantAvatar,
  loadAssistantName,
  saveAssistantAvatar,
  saveAssistantName,
  useAssistantIdentity,
} from "@/lib/desktop/assistant-identity"
import {
  loadPersona,
  savePersona,
  loadSpendThreshold,
  saveSpendThreshold,
  PERSONA_MAX_CHARS,
} from "@/lib/desktop/assistant"
import { AssistantIdentityMark } from "./assistant-identity-mark"

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
  const identity = useAssistantIdentity()
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState(() => loadAssistantName())
  const [nameSaved, setNameSaved] = useState(false)
  const [avatarStatus, setAvatarStatus] = useState<string | null>(null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [persona, setPersona] = useState(() => loadPersona())
  const [personaSaved, setPersonaSaved] = useState(false)
  const [spend, setSpend] = useState(() => loadSpendThreshold().toFixed(2))
  const [spendSaved, setSpendSaved] = useState(false)

  const onNameBlur = useCallback(() => {
    const saved = saveAssistantName(name)
    setName(saved)
    setNameSaved(true)
    window.setTimeout(() => setNameSaved(false), 1600)
  }, [name])

  const onAvatarChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!isLikelyImageFile(file)) {
      setAvatarStatus("choose an image file")
      return
    }
    setAvatarBusy(true)
    setAvatarStatus("center-cropping…")
    try {
      const cropped = await centerCropAssistantAvatar(file)
      await saveAssistantAvatar(cropped)
      setAvatarStatus("saved")
      window.setTimeout(() => setAvatarStatus(null), 1800)
    } catch (error) {
      setAvatarStatus(error instanceof Error ? error.message : "image upload failed")
    } finally {
      setAvatarBusy(false)
    }
  }, [])

  const removeAvatar = useCallback(async () => {
    setAvatarBusy(true)
    setAvatarStatus("removing…")
    try {
      await clearAssistantAvatar()
      setAvatarStatus("removed")
      window.setTimeout(() => setAvatarStatus(null), 1600)
    } catch (error) {
      setAvatarStatus(error instanceof Error ? error.message : "could not remove image")
    } finally {
      setAvatarBusy(false)
    }
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
      <AssistantIdentityMark
        className="grid h-3 w-3 place-items-center"
        fallbackStyle={{ textShadow: "0 0 10px color-mix(in oklch, var(--main) 55%, transparent)" }}
      />
      {label}
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-doc-bg p-4 text-[12px] text-foreground">
      <section>
        {sectionTitle("Identity")}
        <div className="grid grid-cols-[minmax(0,1fr)_88px] items-start gap-4 rounded-md border border-chrome-border/60 bg-secondary-background/40 p-3">
          <div className="min-w-0">
            <label className="text-[10px] uppercase tracking-wide text-chrome-text/55" htmlFor="assistant-display-name">
              Name
            </label>
            <input
              id="assistant-display-name"
              value={name}
              maxLength={ASSISTANT_NAME_MAX_CHARS}
              onChange={(event) => {
                setName(event.target.value.slice(0, ASSISTANT_NAME_MAX_CHARS))
                setNameSaved(false)
              }}
              onBlur={onNameBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur()
              }}
              className="mt-1 w-full rounded-md border border-chrome-border bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-main/60"
              placeholder="Assistant"
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-chrome-text/45">
              <span>{nameSaved ? "saved" : "saves on blur · labels only"}</span>
              <span>{name.length}/{ASSISTANT_NAME_MAX_CHARS}</span>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-chrome-text/50">
              The internal assistant operator and protocol names stay unchanged.
            </p>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            <button
              type="button"
              disabled={avatarBusy}
              onClick={() => avatarInputRef.current?.click()}
              title="Upload assistant picture"
              className="group relative grid h-[72px] w-[72px] place-items-center overflow-hidden rounded-full border border-main/35 bg-background/70 text-lg text-main shadow-[0_8px_24px_oklch(0%_0_0_/_0.18)] outline-none transition hover:border-main/65 focus-visible:ring-2 focus-visible:ring-main/45 disabled:opacity-55"
            >
              <AssistantIdentityMark
                className={identity.avatarUrl ? "h-full w-full" : "grid h-full w-full place-items-center"}
                fallbackStyle={{ textShadow: "0 0 14px color-mix(in oklch, var(--main) 60%, transparent)" }}
              />
              <span className="absolute inset-x-0 bottom-0 bg-background/75 py-0.5 text-center text-[8px] uppercase tracking-wide text-foreground/70 opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
                upload
              </span>
            </button>
            <input
              ref={avatarInputRef}
              type="file"
              accept={WALLPAPER_FILE_ACCEPT}
              className="hidden"
              onChange={(event) => void onAvatarChange(event)}
            />
            {identity.avatarUrl ? (
              <button
                type="button"
                disabled={avatarBusy}
                onClick={() => void removeAvatar()}
                className="text-[9px] text-chrome-text/45 hover:text-danger disabled:opacity-45"
              >
                remove
              </button>
            ) : (
              <span className="text-[9px] text-chrome-text/40">picture</span>
            )}
          </div>
        </div>
        <div className="mt-1 text-[10px] text-chrome-text/45">
          {avatarStatus ?? "Images are automatically center-cropped to a 1:1 circle and kept in this browser."}
        </div>
      </section>

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
          (she&apos;ll still mention the price). Anything over, she quotes the
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
