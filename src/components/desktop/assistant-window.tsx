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

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
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
  fetchLiveToolCount,
  fetchThreadRemote,
  fetchTurnToolEvents,
  imageAttachmentFromBlob,
  loadPersona,
  loadThreadLocal,
  mergeAssistantThreads,
  newAssistantMessage,
  diagnoseEnvelope,
  runAssistantTurn,
  saveThreadLocal,
  type AssistantApplyResult,
  type AssistantApplyOptions,
  type AssistantCommand,
  type AssistantImageAttachment,
  type AssistantMessage,
  type TurnToolEvent,
} from "@/lib/desktop/assistant"
import { useAssistantIdentity } from "@/lib/desktop/assistant-identity"
import type { AssistantBlockExecutionObservation } from "@/lib/desktop/assistant-execution"
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror"
import { AssistantChatInput } from "./assistant-chat-input"
import { AssistantIdentityMark } from "./assistant-identity-mark"
import { VoiceOrb } from "./voice-orb"
import {
  loadVoiceSettings,
  renderSpeechScript,
  stripAudioTags,
  synthesizeSpeech,
  transcribeSpeech,
  ttsReady,
  sttReady,
  getVoicePlayer,
  type VoiceSettings,
} from "@/lib/desktop/assistant-voice"
import { Broom, Mic, Pencil, Quote, Volume2, VolumeX, Loader2 } from "@/lib/icons"
import { MarkupEditor } from "./markup-editor"
import { cn } from "@/lib/utils"

interface AssistantWindowProps {
  activeConnectionId: string | null
  schema: SchemaSnapshot | null
  allWindows: DesktopWindowState[]
  /** The focused window — a hint for ambiguous targets, not a scope. */
  focusedWindowId: string | null
  params: DesktopParamValue[]
  getExecutionObservations: () => Record<string, AssistantBlockExecutionObservation>
  queuedAttachments: AssistantImageAttachment[]
  onConsumeQueuedAttachments: (ids: string[]) => void
  /** Enqueue an attachment (pasted screenshots ride the same gallery). */
  onQueueAttachment?: (attachment: AssistantImageAttachment) => void
  /** Replace a queued attachment in place (the markup editor's Apply). */
  onUpdateQueuedAttachment?: (attachment: AssistantImageAttachment) => void
  applyCommands: (
    commands: AssistantCommand[],
    options?: AssistantApplyOptions,
  ) => Promise<AssistantApplyResult[]>
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
    case "upsert_plate":
      return `${skipped ? "couldn't install" : "installed"} plate ${cmd.plate_id}`
    case "patch_plate":
      return `${skipped ? "couldn't patch" : "patched"} plate ${cmd.plate_id}`
    case "open_plate":
      return `opened ${cmd.plate_id}`
    case "upsert_layout":
      return `${skipped ? "couldn't install" : "installed"} layout ${cmd.layout_id}`
    case "patch_layout":
      return `${skipped ? "couldn't patch" : "patched"} layout ${cmd.layout_id}`
    case "open_layout":
      return `opened layout ${cmd.layout_id}`
    case "open_panel":
      return `${skipped ? "couldn't open" : "opened"} ${cmd.panel}${cmd.hint ? ` → ${cmd.hint}` : ""}`
    case "register_kit":
      return `${skipped ? "couldn't register" : "registered"} kit ${cmd.kit}`
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
      data-rvbbit-capture-exclude
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

/** Karaoke text — while a message's audio plays, a soft background sweep
 *  lights the words at the clip's pace. Deliberately approximate: linear
 *  word pacing against clip length reads as "she's saying this" without
 *  pretending to be a subtitle track. */
function KaraokeText({ text }: { text: string }) {
  // Keep whitespace tokens so layout is byte-identical to the plain render.
  const tokens = useMemo(() => text.split(/(\s+)/), [text])
  const wordCount = useMemo(
    () => tokens.filter((t) => t.length > 0 && !/^\s+$/.test(t)).length,
    [tokens],
  )
  const [lit, setLit] = useState(0)
  useEffect(() => {
    const player = getVoicePlayer()
    let raf = 0
    const loop = () => {
      const p = player.getProgress()
      if (p != null) {
        const n = Math.min(wordCount, Math.floor(p * wordCount) + 1)
        setLit((cur) => (cur === n ? cur : n))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [wordCount])
  // Paint-only styling (background / box-shadow / text-shadow) so the text
  // metrics never change — the layout must not breathe as words light up.
  // The word being said right now gets a glowing leading edge; already-said
  // words keep a solid wash behind them.
  const spokenBg = "color-mix(in oklch, var(--main) 24%, transparent)"
  const currentBg = "color-mix(in oklch, var(--main) 42%, transparent)"
  let seen = 0
  return (
    <>
      {tokens.map((t, i) => {
        if (t.length === 0 || /^\s+$/.test(t)) return t
        const idx = seen++
        const state = idx < lit - 1 ? "spoken" : idx === lit - 1 ? "current" : "unspoken"
        return (
          <span
            key={i}
            className="rounded-[3px]"
            style={{
              transition: "background-color 300ms, box-shadow 300ms, text-shadow 300ms",
              ...(state === "spoken"
                ? { background: spokenBg, boxShadow: `0 0 0 2px ${spokenBg}` }
                : state === "current"
                  ? {
                      background: currentBg,
                      boxShadow: `0 0 0 3px ${currentBg}, 0 0 14px color-mix(in oklch, var(--main) 35%, transparent)`,
                      textShadow: "0 0 10px color-mix(in oklch, var(--main) 60%, transparent)",
                    }
                  : {}),
            }}
          >
            {t}
          </span>
        )
      })}
    </>
  )
}

export function AssistantWindow({
  activeConnectionId,
  schema,
  allWindows,
  focusedWindowId,
  params,
  getExecutionObservations,
  queuedAttachments,
  onConsumeQueuedAttachments,
  onQueueAttachment,
  onUpdateQueuedAttachment,
  applyCommands,
}: AssistantWindowProps) {
  // Chips dim when their block leaves the canvas — the transcript visibly
  // decays where the desktop has moved on.
  const liveBlockNames = new Set(
    allWindows.map((w) => assistantBlockName(w).toLowerCase()),
  )
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [draft, setDraft] = useState("")
  const [markupTarget, setMarkupTarget] = useState<AssistantImageAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  // The enhanced thinking effect, in two layers: a LIVE dot count from
  // shared memory while the turn runs (audit rows are MVCC-invisible until
  // commit), then the full tool strip — args + result tooltips — attached
  // to the finished reply from rvbbit.agent_messages by run_id.
  const [liveToolCount, setLiveToolCount] = useState(0)
  const [toolStrips, setToolStrips] = useState<Record<string, TurnToolEvent[]>>({})
  const [hoveredTool, setHoveredTool] = useState<string | null>(null)
  // Expressive re-voicing: once a message has been rendered for speech, the
  // persona-voiced script (tags stripped) becomes its DISPLAY text too —
  // otherwise what you hear and what you read diverge confusingly. The thread,
  // the agent loop, and homebase all keep the ORIGINAL; this is session-local.
  const [voiceScripts, setVoiceScripts] = useState<Record<string, string>>({})
  const [hoveredOriginal, setHoveredOriginal] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  // ── Voice ──────────────────────────────────────────────────────────
  const [voice, setVoice] = useState<VoiceSettings>(() => loadVoiceSettings())
  const [speaking, setSpeaking] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const micCtxRef = useRef<AudioContext | null>(null)
  const micAnalyserRef = useRef<AnalyserNode | null>(null)
  const sendAfterRef = useRef(false)
  const cancelledRef = useRef(false)
  const spokenIdRef = useRef<string | null>(null)
  // send() is declared below; recording finishes async and may fire it, so
  // reach it through a ref rather than a declaration-order dependency.
  const sendRef = useRef<(text?: string) => void>(() => {})
  const player = getVoicePlayer()

  // Voice settings live in localStorage (browser-local L1); re-read on focus so
  // a change in the settings window is picked up without a remount.
  useEffect(() => {
    const reload = () => setVoice(loadVoiceSettings())
    window.addEventListener("focus", reload)
    return () => window.removeEventListener("focus", reload)
  }, [])

  useEffect(() => player.onChange(setSpeaking), [player])

  // Poll the live tool-call tally while a turn is in flight — dots accumulate
  // as the agent works. Best-effort: older engines report 0 and the pill just
  // says "working…" until the reply lands.
  useEffect(() => {
    if (!busy || !activeConnectionId) return
    let cancelled = false
    const tick = async () => {
      const n = await fetchLiveToolCount(activeConnectionId)
      if (!cancelled && n > 0) setLiveToolCount(n)
    }
    void tick()
    const handle = window.setInterval(() => void tick(), 1200)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [busy, activeConnectionId])

  const speakMessage = useCallback(
    async (id: string, text: string) => {
      const clean = assistantReplyForDisplay(text).trim()
      if (!clean) return
      const settings = loadVoiceSettings()
      if (!ttsReady(settings)) return
      try {
        setSpeakingId(id)
        // Expressive pass: re-voice the reply for the ear (markdown stripped,
        // sparing v3 audio tags, persona flavor) — display text untouched,
        // null falls back to speaking the plain reply.
        let script = clean
        if (settings.expressive && activeConnectionId) {
          const rendered = await renderSpeechScript({
            connectionId: activeConnectionId,
            text: clean,
            persona: loadPersona(),
            model: settings.speechModel,
          })
          if (rendered) {
            script = rendered
            // The re-voiced script becomes the display text for this message.
            setVoiceScripts((prev) => (prev[id] === rendered ? prev : { ...prev, [id]: rendered }))
          }
        }
        const blob = await synthesizeSpeech(script, settings)
        await player.play(blob)
      } catch {
        // voice is icing — a TTS failure never disrupts the transcript
      } finally {
        setSpeakingId((cur) => (cur === id ? null : cur))
      }
    },
    [player, activeConnectionId],
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

  // Finish the current recording. `send` => transcribe and fire the turn with
  // no edit phase; otherwise the transcript lands in the draft for review.
  const finishRecording = useCallback((send: boolean) => {
    if (!recorderRef.current) return
    sendAfterRef.current = send
    cancelledRef.current = false
    recorderRef.current.stop()
  }, [])

  const cancelRecording = useCallback(() => {
    if (!recorderRef.current) return
    cancelledRef.current = true
    recorderRef.current.stop()
  }, [])

  const startRecording = useCallback(async () => {
    const settings = loadVoiceSettings()
    if (!sttReady(settings) || recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Live level metering for the overlay orb — analyser only, never routed
      // to the speakers (no self-monitoring).
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const srcNode = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      srcNode.connect(analyser)
      micCtxRef.current = ctx
      micAnalyserRef.current = analyser

      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        void micCtxRef.current?.close().catch(() => {})
        micCtxRef.current = null
        micAnalyserRef.current = null
        setRecording(false)
        const wantSend = sendAfterRef.current
        if (cancelledRef.current) return
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" })
        if (blob.size < 1200) return // too short to be speech
        setVoiceBusy(true)
        try {
          const text = await transcribeSpeech(blob, settings)
          if (text) {
            if (wantSend) void sendRef.current(text)
            else {
              setDraft((d) => (d ? `${d} ${text}` : text))
              inputRef.current?.view?.focus()
            }
          }
        } catch {
          // silent — the mic just did nothing useful
        } finally {
          setVoiceBusy(false)
        }
      }
      recorderRef.current = rec
      sendAfterRef.current = false
      cancelledRef.current = false
      rec.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }, [recording])

  const toggleMic = useCallback(() => {
    if (recording) finishRecording(false)
    else void startRecording()
  }, [recording, finishRecording, startRecording])

  // While recording: Space transcribes into the draft, Enter transcribes and
  // sends immediately, Esc cancels. Captured at the window level so the user
  // never has to aim at a button.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault()
        finishRecording(false)
      } else if (e.key === "Enter") {
        e.preventDefault()
        finishRecording(true)
      } else if (e.key === "Escape") {
        e.preventDefault()
        cancelRecording()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [recording, finishRecording, cancelRecording])
  const lastReportRef = useRef<AssistantApplyResult[] | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<ReactCodeMirrorRef | null>(null)
  // Fresh slate: hide everything at or before this timestamp from the
  // TRANSCRIPT only — the thread (and the model's rolling context) is
  // untouched, and a reload brings everything back. Purely visual relief.
  const [slateAt, setSlateAt] = useState<number | null>(null)

  // Latest desktop state without re-rendering the chat on every canvas change.
  const windowsRef = useRef(allWindows)
  windowsRef.current = allWindows
  const focusedRef = useRef(focusedWindowId)
  focusedRef.current = focusedWindowId
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

  const send = useCallback(async (textOverride?: string) => {
    const pendingAttachments = queuedAttachments
    const text = (textOverride ?? draft).trim() || (pendingAttachments.length > 0 ? "Take a look at this current block view." : "")
    if ((!text && pendingAttachments.length === 0) || busy) return
    if (!activeConnectionId) return
    setDraft("")
    onConsumeQueuedAttachments(pendingAttachments.map((attachment) => attachment.id))
    setLiveToolCount(0)
    setHoveredTool(null)
    setBusy(true)
    const userMsg = newAssistantMessage("user", text, {
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
    })
    let thread = [...messagesRef.current, userMsg]
    setMessages(thread)
    saveThreadLocal(thread)
    appendThreadRemote([userMsg])
    try {
      // Visual self-check loop: a turn ending in capture commands earns an
      // automatic follow-up carrying the screenshots. The budget lives HERE,
      // outside the model — at most 2 auto-continuations per user request;
      // further captures are refused structurally via the apply report.
      const CAPTURE_BUDGET = 2
      // Auto-repair loop: a turn whose command envelope truncated or failed
      // to parse (the giant-single-plate failure mode) earns a follow-up
      // carrying the parse diagnosis + the incremental recovery protocol
      // (skeleton via upsert_plate, remainder via patch_plate). Bounded so
      // a persistently confused model can't burn turns.
      const REPAIR_BUDGET = 2
      let repairs = 0
      let turnText = text
      let turnAttachments = pendingAttachments
      for (let hop = 0; ; hop++) {
        setLiveToolCount(0)
        const context = buildAssistantDesktopContext(
          windowsRef.current,
          paramsRef.current,
          schemaRef.current,
          lastReportRef.current,
          getExecutionObservations(),
          focusedRef.current,
        )
        const turn = await runAssistantTurn(
          activeConnectionId,
          turnText,
          thread,
          context,
          turnAttachments,
        )
        let report: AssistantApplyResult[] = []
        if (turn.commands.length > 0) {
          report = await applyCommands(turn.commands)
        }
        const captures = report
          .filter((r) => r.op === "capture" && r.status === "applied" && r.attachment)
          .map((r) => r.attachment!)
        if (hop >= CAPTURE_BUDGET && captures.length > 0) {
          for (const r of report) {
            if (r.op === "capture" && r.attachment) {
              r.status = "skipped"
              r.detail = `visual self-check budget (${CAPTURE_BUDGET}) exhausted — ask the user before looking again`
              delete r.attachment
            }
          }
          captures.length = 0
        }
        lastReportRef.current = report.length > 0 ? report : null
        const assistantMsg = newAssistantMessage("assistant", turn.reply, {
          agentRunId: turn.agentRunId,
          attachments: turn.attachments.length > 0 ? turn.attachments : undefined,
          commands: turn.commands.length > 0 ? turn.commands : undefined,
          report: report.length > 0 ? report : undefined,
          error: !!turn.error || turn.status === "provider_error" || turn.status === "memory_error",
        })
        thread = [...thread, assistantMsg]
        setMessages((prev) => {
          const next = [...prev, assistantMsg]
          saveThreadLocal(next)
          return next
        })
        appendThreadRemote([assistantMsg])
        // The turn is committed now — fetch its tool receipts and hang the
        // dot strip (with args/result tooltips) off the finished reply.
        if (turn.agentRunId) {
          const doneMsgId = assistantMsg.id
          void fetchTurnToolEvents(activeConnectionId, turn.agentRunId).then((events) => {
            if (events.length > 0) {
              setToolStrips((prev) => ({ ...prev, [doneMsgId]: events }))
            }
          })
        }
        if (
          (turn.status === "output_truncated" || turn.status === "invalid_structured_output") &&
          repairs < REPAIR_BUDGET
        ) {
          repairs++
          const diagnosis =
            turn.status === "output_truncated"
              ? "Your last reply overflowed the output limit mid-envelope and was discarded — nothing was applied."
              : `Your last reply looked like a command envelope but failed to parse, so nothing was applied. Parse diagnosis: ${diagnoseEnvelope(turn.rawEnvelope ?? "")}`
          const followText =
            `[auto-repair ${repairs}/${REPAIR_BUDGET}] ${diagnosis} ` +
            `Recover INCREMENTALLY — do not re-emit the whole thing as one giant command. ` +
            `For a large plate: first upsert_plate a WORKING SKELETON (template plus only the queries it references), ` +
            `then add the remaining queries/actions with patch_plate commands (queries/actions merge per key; more patch_plate turns are fine). ` +
            `Keep every command comfortably small.`
          const followMsg = newAssistantMessage("user", followText)
          thread = [...thread, followMsg]
          setMessages((prev) => {
            const next = [...prev, followMsg]
            saveThreadLocal(next)
            return next
          })
          appendThreadRemote([followMsg])
          turnText = followText
          turnAttachments = []
          continue
        }
        if (captures.length === 0) break
        // Deliver the screenshots as a visible synthetic turn — the user
        // sees exactly what she saw, right in the transcript.
        const followText = `[visual self-check ${hop + 1}/${CAPTURE_BUDGET}] Requested capture attached.`
        const followMsg = newAssistantMessage("user", followText, { attachments: captures })
        thread = [...thread, followMsg]
        setMessages((prev) => {
          const next = [...prev, followMsg]
          saveThreadLocal(next)
          return next
        })
        appendThreadRemote([followMsg])
        turnText = followText
        turnAttachments = captures
      }
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
      inputRef.current?.view?.focus()
    }
  }, [draft, queuedAttachments, busy, activeConnectionId, applyCommands, getExecutionObservations, onConsumeQueuedAttachments])

  // Keep the ref current so a recording that finishes async fires the latest send.
  sendRef.current = send

  // Bubble plate: each utterance carries its own translucent blur backdrop so
  // the transcript floats over any wallpaper — the container paints nothing.
  const plate = (extra?: Record<string, string>) => ({
    background: "color-mix(in oklch, var(--background) 68%, transparent)",
    backdropFilter: "blur(12px)",
    ...extra,
  })

  return (
    <div className="relative flex h-full flex-col">
      {messages.some((m) => slateAt == null || m.at > slateAt) ? (
        <button
          type="button"
          onClick={() => setSlateAt(Date.now())}
          title="Fresh slate — hide the messages above (display only; the thread and context are kept, reload restores)"
          className="absolute right-2 top-1 z-20 grid h-5 w-5 place-items-center rounded-full text-chrome-text/35 transition-colors hover:text-main"
        >
          <Broom className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {recording ? (
        <div
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4"
          style={{
            background: "color-mix(in oklch, var(--background) 82%, transparent)",
            backdropFilter: "blur(10px)",
          }}
          onClick={() => finishRecording(false)}
        >
          <VoiceOrb getAnalyser={() => micAnalyserRef.current} active size={172} />
          <div className="text-[12px] font-medium tracking-wide text-main">Listening…</div>
          <div className="flex flex-col items-center gap-1 text-[10.5px] text-chrome-text/60">
            <div className="flex gap-3">
              <span><Kbd>Space</Kbd> transcribe</span>
              <span><Kbd>Enter</Kbd> transcribe &amp; send</span>
              <span><Kbd>Esc</Kbd> cancel</span>
            </div>
          </div>
        </div>
      ) : null}

      {speaking && !recording ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-1">
          <VoiceOrb getAnalyser={() => player.getAnalyser()} active size={120} />
          <button
            type="button"
            onClick={() => {
              player.stop()
              setSpeakingId(null)
            }}
            className="pointer-events-auto -mt-2 flex items-center gap-1 rounded-full border border-main/40 bg-background/70 px-2 py-0.5 text-[10px] text-main/80 backdrop-blur hover:text-main"
            title="Stop speaking"
          >
            <VolumeX className="h-3 w-3" /> stop
          </button>
        </div>
      ) : null}

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
                  <VoiceOrb getAnalyser={() => player.getAnalyser()} active={speaking} size={96} />
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
          {slateAt != null && messages.some((m) => m.at <= slateAt) ? (
            <button
              type="button"
              onClick={() => setSlateAt(null)}
              className="mx-auto rounded-full border border-chrome-border/60 px-2.5 py-0.5 text-[10px] text-chrome-text/45 transition-colors hover:text-foreground"
              title="Show the swept messages again"
            >
              {messages.filter((m) => m.at <= slateAt).length} swept · show
            </button>
          ) : null}
          {messages.map((m, messageIndex) =>
            slateAt != null && m.at <= slateAt ? null : m.role === "user" ? (
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
                    {(() => {
                      const display = voiceScripts[m.id]
                        ? stripAudioTags(voiceScripts[m.id])
                        : assistantReplyForDisplay(m.text)
                      return speaking && speakingId === m.id ? (
                        <KaraokeText text={display} />
                      ) : (
                        display
                      )
                    })()}
                  </div>
                  {voiceScripts[m.id] ? (
                    <span className="relative mt-[3px] shrink-0 self-start">
                      <button
                        type="button"
                        onMouseEnter={() => setHoveredOriginal(m.id)}
                        onMouseLeave={() => setHoveredOriginal(null)}
                        className="text-chrome-text/30 transition-colors hover:text-chrome-text/70"
                        aria-label="show the original reply"
                      >
                        <Quote className="h-3 w-3" />
                      </button>
                      {hoveredOriginal === m.id ? (
                        <div className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 w-[min(24rem,75vw)] rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-xl backdrop-blur">
                          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
                            original reply — re-voiced for speech
                          </div>
                          <div className="max-h-40 overflow-hidden whitespace-pre-wrap text-[11px] leading-snug text-chrome-text/80">
                            {assistantReplyForDisplay(m.text)}
                          </div>
                        </div>
                      ) : null}
                    </span>
                  ) : null}
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
                {toolStrips[m.id]?.length ? (
                  <div className="relative ml-6 flex items-center gap-1">
                    {toolStrips[m.id].map((ev) => {
                      const key = `${m.id}:${ev.idx}`
                      return (
                        <button
                          key={key}
                          type="button"
                          onMouseEnter={() => setHoveredTool(key)}
                          onMouseLeave={() => setHoveredTool(null)}
                          className={cn(
                            "h-2 w-2 rounded-full transition-transform",
                            hoveredTool === key ? "scale-150 bg-main" : "bg-main/50",
                          )}
                          aria-label={`tool call: ${ev.tool}`}
                        />
                      )
                    })}
                    <span className="ml-1 text-[9px] text-chrome-text/40">
                      {toolStrips[m.id].length} tool call{toolStrips[m.id].length === 1 ? "" : "s"}
                    </span>
                    {hoveredTool?.startsWith(`${m.id}:`)
                      ? (() => {
                          const idx = Number(hoveredTool.slice(m.id.length + 1))
                          const ev = toolStrips[m.id].find((e) => e.idx === idx)
                          if (!ev) return null
                          return (
                            <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-[min(26rem,80vw)] overflow-hidden rounded-md border border-chrome-border bg-chrome-bg/95 p-2 shadow-xl backdrop-blur">
                              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-main/80">
                                {ev.tool}
                              </div>
                              {ev.args ? (
                                <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-chrome-text/80">
                                  {ev.args}
                                </pre>
                              ) : null}
                              {ev.result ? (
                                <div className="mt-1 truncate border-t border-chrome-border/40 pt-1 font-mono text-[9.5px] text-chrome-text/50">
                                  → {ev.result}
                                </div>
                              ) : null}
                            </div>
                          )
                        })()
                      : null}
                  </div>
                ) : null}
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
              className="relative flex w-fit items-center gap-2.5 rounded-full px-3 py-1.5"
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
              {/* live shared-memory tally: one dot per tool call so far;
                  trailing ping = whatever is in flight right now */}
              {liveToolCount > 0 ? (
                <span
                  className="flex items-center gap-1"
                  title={`${liveToolCount} tool call${liveToolCount === 1 ? "" : "s"} so far`}
                >
                  {Array.from({ length: Math.min(liveToolCount, 24) }, (_, i) => (
                    <span key={i} className="h-2 w-2 rounded-full bg-main/60" />
                  ))}
                  <span className="h-2 w-2 animate-ping rounded-full bg-main/40" />
                </span>
              ) : null}
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
                  {onUpdateQueuedAttachment ? (
                    <button
                      type="button"
                      onClick={() => setMarkupTarget(attachment)}
                      className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-background/80 text-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
                      title="Mark up before sending"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  ) : null}
                  <div className="absolute inset-x-0 bottom-0 truncate bg-background/75 px-1.5 py-0.5 text-[9px] text-foreground backdrop-blur">
                    {attachment.name}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {markupTarget ? (
            <MarkupEditor
              attachment={markupTarget}
              onApply={(updated) => {
                onUpdateQueuedAttachment?.(updated)
                setMarkupTarget(null)
              }}
              onCancel={() => setMarkupTarget(null)}
            />
          ) : null}
          <div
            className="flex items-end gap-1.5"
            // Capture phase so image pastes are intercepted BEFORE CodeMirror
            // sees the event; text pastes fall through untouched.
            onPasteCapture={(e) => {
              if (!onQueueAttachment) return
              const images = Array.from(e.clipboardData?.items ?? []).filter(
                (it) => it.kind === "file" && it.type.startsWith("image/"),
              )
              if (images.length === 0) return
              e.preventDefault()
              e.stopPropagation()
              for (const item of images) {
                const file = item.getAsFile()
                if (file) {
                  void imageAttachmentFromBlob(file)
                    .then(onQueueAttachment)
                    .catch(() => {})
                }
              }
            }}
          >
            <AssistantChatInput
              editorRef={inputRef}
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              disabled={busy || !activeConnectionId}
              placeholder={
                recording
                  ? "listening…"
                  : activeConnectionId
                    ? "ask the desktop…"
                    : "connect to a database first"
              }
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

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-chrome-border/70 bg-chrome-bg/60 px-1 py-px font-mono text-[9.5px] text-chrome-text/80">
      {children}
    </kbd>
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
