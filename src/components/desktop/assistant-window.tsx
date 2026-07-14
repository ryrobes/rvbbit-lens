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

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  DesktopParamValue,
  DesktopWindowState,
} from "@/lib/desktop/types"
import type { SchemaSnapshot } from "@/lib/db/types"
import {
  appendThreadRemote,
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

interface AssistantWindowProps {
  window: DesktopWindowState
  activeConnectionId: string | null
  schema: SchemaSnapshot | null
  allWindows: DesktopWindowState[]
  params: DesktopParamValue[]
  applyCommands: (commands: AssistantCommand[]) => AssistantApplyResult[]
}

function commandChipLabel(cmd: AssistantCommand, report?: AssistantApplyResult): string {
  const skipped = report?.status === "skipped"
  const mark = skipped ? "⃠" : "✦"
  switch (cmd.op) {
    case "create_block":
      return `${mark} ${skipped ? "couldn't create" : "created"} ${cmd.name ?? cmd.title ?? "block"}`
    case "update_block":
      return `${mark} ${skipped ? "couldn't update" : "updated"} ${cmd.target}`
    case "emit_param":
      return `${mark} filtered ${cmd.block}.${cmd.field}`
    case "focus_block":
      return `${mark} → ${cmd.target}`
    case "close_block":
      return `${mark} closed ${cmd.target}`
    default:
      return `${mark} ${(cmd as { op: string }).op}`
  }
}

export function AssistantWindow({
  activeConnectionId,
  schema,
  allWindows,
  params,
  applyCommands,
}: AssistantWindowProps) {
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

  return (
    <div
      className="flex h-full flex-col"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in oklch, var(--background) 55%, transparent) 0%, color-mix(in oklch, var(--background) 78%, transparent) 100%)",
        backdropFilter: "blur(14px)",
      }}
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
        {hydrated && messages.length === 0 && !busy ? (
          <div
            className="mt-10 select-none text-center text-[13px] leading-relaxed"
            style={{ color: "color-mix(in oklch, var(--foreground) 45%, transparent)" }}
          >
            <div
              className="mb-2 text-lg"
              style={{
                color: "var(--main)",
                textShadow: "0 0 18px color-mix(in oklch, var(--main) 55%, transparent)",
              }}
            >
              ✦
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
                  style={{
                    background: "color-mix(in oklch, var(--foreground) 9%, transparent)",
                    color: "color-mix(in oklch, var(--foreground) 82%, transparent)",
                  }}
                >
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-1.5 pr-6">
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-[3px] shrink-0 text-[11px]"
                    style={{
                      color: m.error ? "var(--destructive, #b5524a)" : "var(--main)",
                      textShadow: m.error
                        ? "none"
                        : "0 0 12px color-mix(in oklch, var(--main) 60%, transparent)",
                    }}
                  >
                    ✦
                  </span>
                  <div
                    className="text-[13.5px] leading-relaxed"
                    style={{
                      color: m.error
                        ? "color-mix(in oklch, var(--destructive, #b5524a) 80%, var(--foreground))"
                        : "var(--foreground)",
                      textShadow:
                        "0 0 24px color-mix(in oklch, var(--main) 14%, transparent)",
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
                      return (
                        <span
                          key={i}
                          title={rep?.detail}
                          className="rounded-full px-2.5 py-0.5 text-[11px]"
                          style={{
                            border: `1px solid color-mix(in oklch, var(--main) ${skipped ? 18 : 40}%, transparent)`,
                            background: `color-mix(in oklch, var(--main) ${skipped ? 4 : 10}%, transparent)`,
                            color: skipped
                              ? "color-mix(in oklch, var(--foreground) 50%, transparent)"
                              : "color-mix(in oklch, var(--main) 80%, var(--foreground))",
                          }}
                        >
                          {commandChipLabel(cmd, rep)}
                        </span>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ),
          )}
          {busy ? (
            <div className="flex items-center gap-2.5 pl-0.5">
              <span
                className="animate-pulse text-[11px]"
                style={{
                  color: "var(--main)",
                  textShadow: "0 0 14px color-mix(in oklch, var(--main) 70%, transparent)",
                }}
              >
                ✦
              </span>
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
      <div
        className="px-5 pb-4 pt-2"
        style={{
          borderTop: "1px solid color-mix(in oklch, var(--main) 14%, transparent)",
        }}
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
  )
}
