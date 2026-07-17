"use client"

/**
 * Desktop Assistant window — the archive + input surface for the desktop-level
 * agent. Deliberately NOT another boxed chat app: the transcript renders as
 * floating utterances over a translucent, blurred pane so the canvas breathes
 * through it — the assistant is part of the OS, hovering between the user and
 * the desktop. All colors come from theme tokens.
 *
 * The heavy lifting lives elsewhere: context serialization + turn transport in
 * lib/desktop/assistant.ts, command application in the shell
 * (applyAssistantCommands), the brain in rvbbit.desktop_assistant_turn.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import type {
  DesktopParamValue,
  DesktopWindowState,
} from "@/lib/desktop/types"
import type { SchemaSnapshot } from "@/lib/db/types"
import {
  appendThreadRemote,
  assistantReplyForDisplay,
  assistantBlockName,
  buildAssistantDesktopContext,
  fetchThreadRemote,
  loadThreadLocal,
  mergeAssistantThreads,
  newAssistantMessage,
  runAssistantTurn,
  saveThreadLocal,
  type AssistantApplyResult,
  type AssistantApplyOptions,
  type AssistantCommand,
  type AssistantImageAttachment,
  type AssistantMessage,
} from "@/lib/desktop/assistant"
import { useAssistantIdentity } from "@/lib/desktop/assistant-identity"
import type { AssistantBlockExecutionObservation } from "@/lib/desktop/assistant-execution"
import { AssistantIdentityMark } from "./assistant-identity-mark"
import { VoiceOrb } from "./voice-orb"
import {
  loadVoiceSettings,
  synthesizeSpeech,
  transcribeSpeech,
  ttsReady,
  sttReady,
  getVoicePlayer,
  type VoiceSettings,
} from "@/lib/desktop/assistant-voice"
import { Mic, Volume2, VolumeX, Loader2 } from "@/lib/icons"
import { cn } from "@/lib/utils"

interface AssistantWindowProps {
  activeConnectionId: string | null
  schema: SchemaSnapshot | null
  allWindows: DesktopWindowState[]
  params: DesktopParamValue[]
  getExecutionObservations: () => Record<string, AssistantBlockExecutionObservation>
  queuedAttachments: AssistantImageAttachment[]
  onConsumeQueuedAttachments: (ids: string[]) => void
  applyCommands: (
    commands: AssistantCommand[],
    options?: AssistantApplyOptions,
  ) => AssistantApplyResult[]
}

function commandChipLabel(cmd: AssistantCommand, report?: AssistantApplyResult): string {
  const skipped = report?.status === "skipped"
  switch (cmd.op) {
    case "create_block":
      return `${skipped ? "couldn't create" : cmd.app ? "built" : cmd.chart ? "charted" : "created"} ${cmd.name ?? cmd.title ?? "block"}`
    case "update_block":
      return `${skipped ? "couldn't update" : "updated"} ${cmd.target}`
    case "emit_param":
      return `filtered ${cmd.block}.${cmd.field}`
    case "focus_block":
      return `→ ${cmd.target}`
    case "close_block":
      return `closed ${cmd.target}`
    default:
      return (cmd as { op: string }).op
  }
}

/** The canvas handle a chip points at — chips are the join points between
 *  conversation-time and canvas-state. The applier may have renamed a create
 *  (slug collisions), so prefer the report's actual target. */
function chipTarget(cmd: AssistantCommand, report?: AssistantApplyResult): string | null {
  switch (cmd.op) {
    case "create_block":
      return report?.target ?? cmd.name ?? cmd.title ?? null
    case "update_block":
    case "focus_block":
      return report?.target ?? cmd.target
    case "emit_param":
      return cmd.block
    case "close_block":
      return null // closed by design — nothing to point at
    default:
      return null
  }
}

function sameBlockTarget(left: string | null, right: string | null): boolean {
  return !!left && !!right && left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** Rebuild the exact command lineage through one historical pill. Create
 * commands are full snapshots; app updates replace their app with another full
 * snapshot, while SQL/chart patches layer in order. Replaying the lineage keeps
 * both those semantics and each intermediate revision intact. */
function historicalReplayFor(
  messages: AssistantMessage[],
  selectedMessageIndex: number,
  selectedCommandIndex: number,
): { commands: AssistantCommand[]; target: string } | null {
  const selectedMessage = messages[selectedMessageIndex]
  const selected = selectedMessage?.commands?.[selectedCommandIndex]
  const selectedReport = selectedMessage?.report?.[selectedCommandIndex]
  if (!selected || selectedReport?.status === "skipped") return null
  const target = chipTarget(selected, selectedReport)
  if (!target || (selected.op !== "create_block" && selected.op !== "update_block")) return null

  if (selected.op === "create_block") {
    return {
      commands: [{ ...selected, name: target, place: "auto" }],
      target,
    }
  }

  let lineage: AssistantCommand[] | null = null
  for (let messageIndex = 0; messageIndex <= selectedMessageIndex; messageIndex += 1) {
    const message = messages[messageIndex]
    const commands = message.commands ?? []
    const lastCommand = messageIndex === selectedMessageIndex
      ? selectedCommandIndex
      : commands.length - 1
    for (let commandIndex = 0; commandIndex <= lastCommand; commandIndex += 1) {
      const command = commands[commandIndex]
      const report = message.report?.[commandIndex]
      if (!command || report?.status === "skipped") continue
      const commandTarget = chipTarget(command, report)
      if (!sameBlockTarget(commandTarget, target)) continue
      if (command.op === "create_block") {
        // A later create with the same canonical handle begins a new lineage.
        lineage = [{ ...command, name: target, place: "auto" }]
      } else if (command.op === "update_block" && lineage) {
        lineage.push({ ...command, target })
      }
    }
  }
  return lineage?.length ? { commands: lineage, target } : null
}

// ── OS dock — the assistant is NOT a workspace window ───────────────────
//
// She sits between the user and the desktop: a fixed overlay above the canvas
// that survives workspace switches, never appears in scenes or desktop state,
// and is always exactly where you left her. Position persists per browser.

interface DockRect {
  x: number
  y: number
  width: number
  height: number
}

const DOCK_KEY = "rvbbit-lens.assistant.dock.v1"

function loadDockState(): { open: boolean; rect: DockRect | null } {
  if (typeof window === "undefined") return { open: false, rect: null }
  try {
    const raw = window.localStorage.getItem(DOCK_KEY)
    if (!raw) return { open: false, rect: null }
    const parsed = JSON.parse(raw) as { open?: boolean; rect?: DockRect }
    return { open: !!parsed.open, rect: parsed.rect ?? null }
  } catch {
    return { open: false, rect: null }
  }
}

function saveDockState(open: boolean, rect: DockRect | null): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(DOCK_KEY, JSON.stringify({ open, rect }))
  } catch {
    // best-effort
  }
}

export function loadAssistantDockOpen(): boolean {
  return loadDockState().open
}

function defaultDockRect(): DockRect {
  const w = typeof window !== "undefined" ? window.innerWidth : 1600
  return { x: Math.max(16, w - 464), y: 84, width: 440, height: 640 }
}

export function AssistantDock({
  open,
  onClose,
  ...windowProps
}: { open: boolean; onClose: () => void } & AssistantWindowProps) {
  const identity = useAssistantIdentity()
  const [rect, setRect] = useState<DockRect | null>(null)
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; base: DockRect } | null>(null)

  useEffect(() => {
    setRect(loadDockState().rect ?? defaultDockRect())
  }, [])

  useEffect(() => {
    if (rect) saveDockState(open, rect)
  }, [open, rect])

  const startDrag = useCallback(
    (mode: "move" | "resize") => (e: ReactPointerEvent) => {
      if (!rect) return
      e.preventDefault()
      dragRef.current = { mode, startX: e.clientX, startY: e.clientY, base: rect }
      const onMove = (ev: globalThis.PointerEvent) => {
        const d = dragRef.current
        if (!d) return
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - d.startY
        if (d.mode === "move") {
          setRect({
            ...d.base,
            x: Math.min(Math.max(d.base.x + dx, 8 - d.base.width + 120), window.innerWidth - 120),
            y: Math.min(Math.max(d.base.y + dy, 36), window.innerHeight - 60),
          })
        } else {
          setRect({
            ...d.base,
            width: Math.max(320, d.base.width + dx),
            height: Math.max(280, d.base.height + dy),
          })
        }
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    },
    [rect],
  )

  if (!open || !rect) return null
  // No conventional window chrome: a faint tinted glass field gives the dock
  // a readable boundary while preserving the assistant's floating OS-layer
  // character. The drag pill and resize corner remain the only controls.
  return (
    <div
      className="fixed flex flex-col rounded-[18px]"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: 80,
        background:
          "linear-gradient(145deg, color-mix(in oklch, var(--main) 5%, color-mix(in oklch, var(--block-bg) 30%, transparent)), color-mix(in oklch, var(--background) 24%, transparent))",
        backdropFilter: "blur(18px) saturate(1.08)",
        WebkitBackdropFilter: "blur(18px) saturate(1.08)",
        boxShadow:
          "0 18px 54px oklch(0% 0 0 / 0.18), inset 0 1px 0 color-mix(in oklch, var(--foreground) 5%, transparent)",
      }}
    >
      <div
        onPointerDown={startDrag("move")}
        className="flex shrink-0 cursor-move select-none items-center justify-between px-2 pb-1.5 pt-2"
      >
        <span
          className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
          style={{
            background: "color-mix(in oklch, var(--background) 62%, transparent)",
            border: "1px solid color-mix(in oklch, var(--main) 22%, transparent)",
            color: "var(--foreground)",
            backdropFilter: "blur(12px)",
          }}
        >
          <AssistantIdentityMark
            className="grid h-4 w-4 place-items-center"
            fallbackStyle={{
              color: "var(--main)",
              textShadow: "0 0 12px color-mix(in oklch, var(--main) 60%, transparent)",
            }}
          />
          {identity.name}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="grid h-5 w-5 place-items-center rounded-full text-[11px] leading-none"
          style={{
            background: "color-mix(in oklch, var(--background) 62%, transparent)",
            border: "1px solid color-mix(in oklch, var(--foreground) 14%, transparent)",
            color: "color-mix(in oklch, var(--foreground) 60%, transparent)",
            backdropFilter: "blur(12px)",
          }}
          title={`Dismiss ${identity.name} (the thread is kept)`}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <AssistantWindow {...windowProps} />
      </div>
      <div
        onPointerDown={startDrag("resize")}
        className="absolute -bottom-1 -right-1 h-5 w-5 cursor-nwse-resize"
        title="Resize"
      />
    </div>
  )
}

export function AssistantWindow({
  activeConnectionId,
  schema,
  allWindows,
  params,
  getExecutionObservations,
  queuedAttachments,
  onConsumeQueuedAttachments,
  applyCommands,
}: AssistantWindowProps) {
  // Chips dim when their block leaves the canvas — the transcript visibly
  // decays where the desktop has moved on.
  const liveBlockNames = new Set(
    allWindows.map((w) => assistantBlockName(w).toLowerCase()),
  )
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // ── Voice ──────────────────────────────────────────────────────────
  const [voice, setVoice] = useState<VoiceSettings>(() => loadVoiceSettings())
  const [speaking, setSpeaking] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const spokenIdRef = useRef<string | null>(null)
  const player = getVoicePlayer()

  // Voice settings live in localStorage (browser-local L1); re-read on focus so
  // a change in the settings window is picked up without a remount.
  useEffect(() => {
    const reload = () => setVoice(loadVoiceSettings())
    window.addEventListener("focus", reload)
    return () => window.removeEventListener("focus", reload)
  }, [])

  useEffect(() => player.onChange(setSpeaking), [player])

  const speakMessage = useCallback(
    async (id: string, text: string) => {
      const clean = assistantReplyForDisplay(text).trim()
      if (!clean) return
      const settings = loadVoiceSettings()
      if (!ttsReady(settings)) return
      try {
        setSpeakingId(id)
        const blob = await synthesizeSpeech(clean, settings)
        await player.play(blob)
      } catch {
        // voice is icing — a TTS failure never disrupts the transcript
      } finally {
        setSpeakingId((cur) => (cur === id ? null : cur))
      }
    },
    [player],
  )

  const toggleSpeak = useCallback(
    (id: string, text: string) => {
      if (speaking && speakingId === id) {
        player.stop()
        setSpeakingId(null)
      } else {
        void speakMessage(id, text)
      }
    },
    [speaking, speakingId, player, speakMessage],
  )

  // Auto-speak: when a new completed assistant reply lands and autoSpeak is on,
  // read it. Guarded by an id ref so re-renders don't re-trigger.
  useEffect(() => {
    if (!voice.ttsEnabled || !voice.autoSpeak || busy) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant" || last.error) return
    if (spokenIdRef.current === last.id) return
    spokenIdRef.current = last.id
    void speakMessage(last.id, last.text)
  }, [messages, busy, voice.ttsEnabled, voice.autoSpeak, speakMessage])

  const toggleMic = useCallback(async () => {
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    const settings = loadVoiceSettings()
    if (!sttReady(settings)) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" })
        if (blob.size < 1200) return // too short to be speech
        setVoiceBusy(true)
        try {
          const text = await transcribeSpeech(blob, settings)
          if (text) setDraft((d) => (d ? `${d} ${text}` : text))
          inputRef.current?.focus()
        } catch {
          // silent — the mic just did nothing useful
        } finally {
          setVoiceBusy(false)
        }
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }, [recording])
  const lastReportRef = useRef<AssistantApplyResult[] | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Latest desktop state without re-rendering the chat on every canvas change.
  const windowsRef = useRef(allWindows)
  windowsRef.current = allWindows
  const paramsRef = useRef(params)
  paramsRef.current = params
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  // Mirror of messages for synchronous reads inside send() — a setMessages
  // updater runs at render time, so a variable assigned inside it is still
  // stale when the turn request fires.
  const messagesRef = useRef<AssistantMessage[]>([])
  messagesRef.current = messages

  // One unbroken thread: show localStorage immediately, then reconcile the
  // durable tail even when local is nonempty. Large HTML commands can exceed
  // localStorage while still being safely present in homebase.
  useEffect(() => {
    let cancelled = false
    const local = loadThreadLocal()
    if (local.length > 0) {
      setMessages(local)
    }
    void fetchThreadRemote().then((remote) => {
      if (cancelled) return
      setMessages((current) => {
        const merged = mergeAssistantThreads(remote, current)
        saveThreadLocal(merged)
        return merged
      })
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  const send = useCallback(async () => {
    const pendingAttachments = queuedAttachments
    const text = draft.trim() || (pendingAttachments.length > 0 ? "Take a look at this current block view." : "")
    if ((!text && pendingAttachments.length === 0) || busy) return
    if (!activeConnectionId) return
    setDraft("")
    onConsumeQueuedAttachments(pendingAttachments.map((attachment) => attachment.id))
    setBusy(true)
    const userMsg = newAssistantMessage("user", text, {
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
    })
    const thread = [...messagesRef.current, userMsg]
    setMessages(thread)
    saveThreadLocal(thread)
    appendThreadRemote([userMsg])
    try {
      const context = buildAssistantDesktopContext(
        windowsRef.current,
        paramsRef.current,
        schemaRef.current,
        lastReportRef.current,
        getExecutionObservations(),
      )
      const turn = await runAssistantTurn(
        activeConnectionId,
        text,
        thread,
        context,
        pendingAttachments,
      )
      let report: AssistantApplyResult[] = []
      if (turn.commands.length > 0) {
        report = applyCommands(turn.commands)
      }
      lastReportRef.current = report.length > 0 ? report : null
      const assistantMsg = newAssistantMessage("assistant", turn.reply, {
        agentRunId: turn.agentRunId,
        attachments: turn.attachments.length > 0 ? turn.attachments : undefined,
        commands: turn.commands.length > 0 ? turn.commands : undefined,
        report: report.length > 0 ? report : undefined,
        error: !!turn.error || turn.status === "provider_error" || turn.status === "memory_error",
      })
      setMessages((prev) => {
        const next = [...prev, assistantMsg]
        saveThreadLocal(next)
        return next
      })
      appendThreadRemote([assistantMsg])
    } catch (err) {
      const failMsg = newAssistantMessage(
        "assistant",
        err instanceof Error ? err.message : "something went sideways — try again?",
        { error: true },
      )
      setMessages((prev) => {
        const next = [...prev, failMsg]
        saveThreadLocal(next)
        return next
      })
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }, [draft, queuedAttachments, busy, activeConnectionId, applyCommands, getExecutionObservations, onConsumeQueuedAttachments])

  // Bubble plate: each utterance carries its own translucent blur backdrop so
  // the transcript floats over any wallpaper — the container paints nothing.
  const plate = (extra?: Record<string, string>) => ({
    background: "color-mix(in oklch, var(--background) 68%, transparent)",
    backdropFilter: "blur(12px)",
    ...extra,
  })

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {hydrated && messages.length === 0 && !busy ? (
          <div
            className="mx-auto mt-10 max-w-[85%] select-none rounded-2xl px-4 py-3 text-center text-[13px] leading-relaxed"
            style={plate({ color: "color-mix(in oklch, var(--foreground) 55%, transparent)" })}
          >
            <div className="mb-2 flex justify-center">
              {voice.ttsEnabled ? (
                <div className="relative grid place-items-center">
                  <VoiceOrb getAnalyser={() => player.getAnalyser()} active={speaking} size={72} />
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <AssistantIdentityMark
                      className="grid h-6 w-6 place-items-center text-base"
                      fallbackStyle={{ color: "var(--main)" }}
                    />
                  </div>
                </div>
              ) : (
                <AssistantIdentityMark
                  className="grid h-7 w-7 place-items-center text-lg"
                  fallbackStyle={{
                    color: "var(--main)",
                    textShadow: "0 0 18px color-mix(in oklch, var(--main) 55%, transparent)",
                  }}
                />
              )}
            </div>
            I can see the desktop — every block, every filter.
            <br />
            Ask about the data, or ask me to put something up.
          </div>
        ) : null}
        <div className="flex flex-col gap-4">
          {messages.map((m, messageIndex) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div
                  className="max-w-[82%] rounded-2xl rounded-br-sm px-3.5 py-2 text-[13px] leading-relaxed"
                  style={plate({
                    border: "1px solid color-mix(in oklch, var(--foreground) 10%, transparent)",
                    color: "color-mix(in oklch, var(--foreground) 85%, transparent)",
                  })}
                >
                  {m.attachments?.length ? (
                    <AssistantAttachmentGallery attachments={m.attachments} />
                  ) : null}
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-1.5 pr-4">
                <div
                  className="flex max-w-[92%] items-start gap-2.5 rounded-2xl rounded-bl-sm px-3.5 py-2"
                  style={plate({
                    border: `1px solid color-mix(in oklch, var(--main) ${m.error ? 8 : 16}%, transparent)`,
                  })}
                >
                  <AssistantIdentityMark
                    className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center text-[11px]"
                    fallbackStyle={{
                      color: m.error ? "var(--destructive, #b5524a)" : "var(--main)",
                      textShadow: m.error
                        ? "none"
                        : "0 0 12px color-mix(in oklch, var(--main) 60%, transparent)",
                    }}
                  />
                  <div
                    className="text-[13.5px] leading-relaxed"
                    style={{
                      color: m.error
                        ? "color-mix(in oklch, var(--destructive, #b5524a) 80%, var(--foreground))"
                        : "var(--foreground)",
                    }}
                  >
                    {m.attachments?.length ? (
                      <AssistantAttachmentGallery attachments={m.attachments} />
                    ) : null}
                    {assistantReplyForDisplay(m.text)}
                  </div>
                  {ttsReady(voice) && !m.error ? (
                    <button
                      type="button"
                      onClick={() => toggleSpeak(m.id, m.text)}
                      title={speaking && speakingId === m.id ? "Stop" : "Read aloud"}
                      className="mt-[3px] shrink-0 self-start text-main/50 transition-colors hover:text-main"
                    >
                      {speaking && speakingId === m.id ? (
                        <VolumeX className="h-3.5 w-3.5" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : null}
                </div>
                {m.commands?.length ? (
                  <div className="ml-6 flex flex-wrap gap-1.5">
                    {m.commands.map((cmd, i) => {
                      const rep = m.report?.[i]
                      const skipped = rep?.status === "skipped"
                      const target = chipTarget(cmd, rep)
                      const alive =
                        !skipped &&
                        !!target &&
                        liveBlockNames.has(target.toLowerCase())
                      const canRestore =
                        !alive &&
                        !skipped &&
                        (cmd.op === "create_block" || cmd.op === "update_block") &&
                        historicalReplayFor(messages, messageIndex, i) !== null
                      const actionable = alive || canRestore
                      return (
                        <button
                          key={i}
                          type="button"
                          disabled={!actionable}
                          onClick={() => {
                            if (alive && target) {
                              if (cmd.op === "update_block") {
                                applyCommands(
                                  [{ ...cmd, target }, { op: "focus_block", target }],
                                  { historicalReplay: true },
                                )
                              } else {
                                applyCommands([{ op: "focus_block", target }])
                              }
                              return
                            }
                            if (canRestore) {
                              const replay = historicalReplayFor(messages, messageIndex, i)
                              if (replay) {
                                applyCommands(
                                  [...replay.commands, { op: "focus_block", target: replay.target }],
                                  { historicalReplay: true },
                                )
                              }
                            }
                          }}
                          title={
                            (alive
                              ? cmd.op === "update_block"
                                ? "reapply this revision and show the block"
                                : "show this block"
                              : canRestore
                                ? "restore this historical version"
                              : skipped
                                ? rep?.detail
                                : target
                                  ? "the original create command is no longer in history"
                                  : rep?.detail)
                          }
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] transition-opacity"
                          style={{
                            border: `1px solid color-mix(in oklch, var(--main) ${skipped ? 18 : alive ? 40 : canRestore ? 32 : 18}%, transparent)`,
                            background: `color-mix(in oklch, color-mix(in oklch, var(--main) ${skipped ? 8 : alive ? 18 : canRestore ? 13 : 7}%, var(--background)) 72%, transparent)`,
                            backdropFilter: "blur(10px)",
                            color: skipped
                              ? "color-mix(in oklch, var(--foreground) 50%, transparent)"
                              : alive
                                ? "color-mix(in oklch, var(--main) 80%, var(--foreground))"
                                : canRestore
                                  ? "color-mix(in oklch, var(--main) 62%, var(--foreground))"
                                : "color-mix(in oklch, var(--foreground) 38%, transparent)",
                            cursor: actionable ? "pointer" : "default",
                            opacity: !skipped && !alive && !canRestore && target ? 0.5 : 1,
                          }}
                        >
                          {skipped ? (
                            <span aria-hidden>⃠</span>
                          ) : (
                            <AssistantIdentityMark className="grid h-3 w-3 place-items-center" />
                          )}
                          {commandChipLabel(cmd, rep)}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ),
          )}
          {busy ? (
            <div
              className="flex w-fit items-center gap-2.5 rounded-full px-3 py-1.5"
              style={plate()}
            >
              <AssistantIdentityMark
                className="grid h-4 w-4 animate-pulse place-items-center text-[11px]"
                fallbackStyle={{
                  color: "var(--main)",
                  textShadow: "0 0 14px color-mix(in oklch, var(--main) 70%, transparent)",
                }}
              />
              <span
                className="text-[12px] italic"
                style={{ color: "color-mix(in oklch, var(--foreground) 40%, transparent)" }}
              >
                working…
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-2 pb-2 pt-1.5">
        <div
          className="rounded-2xl px-3.5 py-2"
          style={plate({
            border: "1px solid color-mix(in oklch, var(--main) 24%, transparent)",
          })}
        >
          {queuedAttachments.length > 0 ? (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {queuedAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="group relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border border-main/30 bg-background/50"
                >
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => onConsumeQueuedAttachments([attachment.id])}
                    className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-background/80 text-[11px] text-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
                    title="Remove screenshot"
                  >
                    ×
                  </button>
                  <div className="absolute inset-x-0 bottom-0 truncate bg-background/75 px-1.5 py-0.5 text-[9px] text-foreground backdrop-blur">
                    {attachment.name}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
            <textarea
              ref={inputRef}
              value={draft}
              disabled={busy || !activeConnectionId}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              placeholder={
                recording
                  ? "listening…"
                  : activeConnectionId
                    ? "ask the desktop…"
                    : "connect to a database first"
              }
              className="w-full flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none"
              style={{
                color: "var(--foreground)",
                caretColor: "var(--main)",
              }}
            />
            {sttReady(voice) ? (
              <button
                type="button"
                onClick={() => void toggleMic()}
                disabled={voiceBusy || busy || !activeConnectionId}
                title={recording ? "Stop & transcribe" : "Speak"}
                className={cn(
                  "mb-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-40",
                  recording
                    ? "animate-pulse border-main bg-main/20 text-main"
                    : "border-main/30 text-main/60 hover:border-main/60 hover:text-main",
                )}
              >
                {voiceBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Mic className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function AssistantAttachmentGallery({ attachments }: { attachments: AssistantImageAttachment[] }) {
  return (
    <div className="mb-2 grid max-w-full grid-cols-1 gap-1.5">
      {attachments.map((attachment) => (
        <figure
          key={attachment.id}
          className="overflow-hidden rounded-xl border border-foreground/10 bg-background/35"
        >
          <img
            src={attachment.dataUrl}
            alt={attachment.name}
            className="block max-h-72 w-full object-contain"
          />
          <figcaption className="truncate border-t border-foreground/10 px-2 py-1 text-[10px] text-foreground/55">
            {attachment.name}
            {attachment.width > 0 && attachment.height > 0
              ? ` · ${attachment.width}×${attachment.height}`
              : ""}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
