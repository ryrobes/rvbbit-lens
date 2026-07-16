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
  assistantBlockName,
  buildAssistantDesktopContext,
  fetchThreadRemote,
  loadThreadLocal,
  newAssistantMessage,
  runAssistantTurn,
  saveThreadLocal,
  type AssistantApplyResult,
  type AssistantCommand,
  type AssistantMessage,
} from "@/lib/desktop/assistant"
import { useAssistantIdentity } from "@/lib/desktop/assistant-identity"
import { AssistantIdentityMark } from "./assistant-identity-mark"

interface AssistantWindowProps {
  activeConnectionId: string | null
  schema: SchemaSnapshot | null
  allWindows: DesktopWindowState[]
  params: DesktopParamValue[]
  applyCommands: (commands: AssistantCommand[]) => AssistantApplyResult[]
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

  // One unbroken thread: localStorage L1, homebase behind it.
  useEffect(() => {
    let cancelled = false
    const local = loadThreadLocal()
    if (local.length > 0) {
      setMessages(local)
      setHydrated(true)
      return
    }
    void fetchThreadRemote().then((remote) => {
      if (cancelled) return
      if (remote.length > 0) {
        setMessages(remote)
        saveThreadLocal(remote)
      }
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
    const text = draft.trim()
    if (!text || busy) return
    if (!activeConnectionId) return
    setDraft("")
    setBusy(true)
    const userMsg = newAssistantMessage("user", text)
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
      )
      const turn = await runAssistantTurn(activeConnectionId, text, thread, context)
      let report: AssistantApplyResult[] = []
      if (turn.commands.length > 0) {
        report = applyCommands(turn.commands)
      }
      lastReportRef.current = report.length > 0 ? report : null
      const assistantMsg = newAssistantMessage("assistant", turn.reply, {
        agentRunId: turn.agentRunId,
        commands: turn.commands.length > 0 ? turn.commands : undefined,
        report: report.length > 0 ? report : undefined,
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
  }, [draft, busy, activeConnectionId, applyCommands])

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
              <AssistantIdentityMark
                className="grid h-7 w-7 place-items-center text-lg"
                fallbackStyle={{
                  color: "var(--main)",
                  textShadow: "0 0 18px color-mix(in oklch, var(--main) 55%, transparent)",
                }}
              />
            </div>
            I can see the desktop — every block, every filter.
            <br />
            Ask about the data, or ask me to put something up.
          </div>
        ) : null}
        <div className="flex flex-col gap-4">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div
                  className="max-w-[82%] rounded-2xl rounded-br-sm px-3.5 py-2 text-[13px] leading-relaxed"
                  style={plate({
                    border: "1px solid color-mix(in oklch, var(--foreground) 10%, transparent)",
                    color: "color-mix(in oklch, var(--foreground) 85%, transparent)",
                  })}
                >
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
                    {m.text}
                  </div>
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
                      return (
                        <button
                          key={i}
                          type="button"
                          disabled={!alive}
                          onClick={() => {
                            if (alive && target) {
                              applyCommands([{ op: "focus_block", target }])
                            }
                          }}
                          title={
                            rep?.detail ??
                            (alive
                              ? "focus this block"
                              : skipped
                                ? undefined
                                : target
                                  ? "no longer on the desktop"
                                  : undefined)
                          }
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] transition-opacity"
                          style={{
                            border: `1px solid color-mix(in oklch, var(--main) ${skipped ? 18 : alive ? 40 : 22}%, transparent)`,
                            background: `color-mix(in oklch, color-mix(in oklch, var(--main) ${skipped ? 8 : alive ? 18 : 9}%, var(--background)) 72%, transparent)`,
                            backdropFilter: "blur(10px)",
                            color: skipped
                              ? "color-mix(in oklch, var(--foreground) 50%, transparent)"
                              : alive
                                ? "color-mix(in oklch, var(--main) 80%, var(--foreground))"
                                : "color-mix(in oklch, var(--foreground) 38%, transparent)",
                            cursor: alive ? "pointer" : "default",
                            opacity: !skipped && !alive && target ? 0.65 : 1,
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
              activeConnectionId ? "ask the desktop…" : "connect to a database first"
            }
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none"
            style={{
              color: "var(--foreground)",
              caretColor: "var(--main)",
            }}
          />
        </div>
      </div>
    </div>
  )
}
