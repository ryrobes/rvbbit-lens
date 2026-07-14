"use client"

/**
 * Desktop Assistant — turn transport, command contract, and context
 * serialization for `rvbbit.desktop_assistant_turn`.
 *
 * The assistant is a desktop-level chat whose agent turn returns
 * `{reply, commands[]}` (rvbbit.desktop_commands.v1). The desktop verbs are
 * deliberately NOT MCP tools: they exist only in this contract and the shell
 * applier, so external MCP clients can never see or call them. Design:
 * docs/DESKTOP_ASSISTANT_PLAN.md.
 *
 * Conversation persistence is a single unbroken thread per home — localStorage
 * is the L1 cache, homebase (`lens_assistant_messages`) is the durable record.
 * The thread is intentionally NOT part of desktop state or scenes: restoring a
 * scene must never rewind the chat.
 */

import { randomUUID } from "@/lib/uuid"
import type {
  DesktopParamOperator,
  DesktopParamValue,
  DesktopWindowState,
  DataPayload,
} from "./types"
import type { SchemaSnapshot } from "@/lib/db/types"
import {
  buildDesktopRuntimeGraph,
  slugifyBlockName,
  sourceSqlForPayload,
} from "./reactive-sql"
import { getHomeId } from "./server-sync"

// ── Command contract (rvbbit.desktop_commands.v1) ──────────────────────

export type AssistantCommand =
  | {
      op: "create_block"
      name?: string
      title?: string
      sql: string
      place?: "auto" | { near: string }
    }
  | {
      op: "update_block"
      target: string
      patch: { sql?: string; title?: string }
    }
  | {
      op: "emit_param"
      block: string
      field: string
      value: unknown
      operator?: DesktopParamOperator
    }
  | { op: "focus_block"; target: string }
  | { op: "close_block"; target: string }

/** Per-command outcome, reported back to the agent in the NEXT turn's
 *  desktop_context.apply_report — the agent never assumes an apply succeeded. */
export interface AssistantApplyResult {
  op: string
  target?: string
  status: "applied" | "skipped"
  detail?: string
}

export const ASSISTANT_COMMAND_CAP = 12

export interface AssistantMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: number
  agentRunId?: string | null
  commands?: AssistantCommand[]
  report?: AssistantApplyResult[]
  error?: boolean
}

export interface AssistantTurnResult {
  reply: string
  commands: AssistantCommand[]
  agentRunId: string | null
  status: string
}

// ── Desktop context snapshot (the "eyes") ──────────────────────────────
//
// Re-sent fresh EVERY turn: the conversation carries intent; the snapshot
// carries truth. Active workspace only. Lean by design — full result pulls go
// through the agent's query tool on demand, not through the snapshot.

export function assistantBlockName(w: DesktopWindowState): string {
  const payload = w.payload as DataPayload | undefined
  return (
    payload?.reactive?.blockName ??
    slugifyBlockName(payload?.title ?? w.title ?? "block")
  )
}

export function buildAssistantDesktopContext(
  windows: DesktopWindowState[],
  params: DesktopParamValue[],
  schema: SchemaSnapshot | null,
  applyReport: AssistantApplyResult[] | null,
): Record<string, unknown> {
  // Resolved SQL (post reactive-rewrite) is what actually executes; raw
  // payload.sql may contain block./param. refs. Compile defensively — a broken
  // reactive graph must not take the assistant down with it.
  let compiled: Map<string, { compiledSql?: string; missingParams?: string[] }> | null = null
  try {
    const graph = buildDesktopRuntimeGraph(windows, params, schema ?? undefined)
    compiled = graph.blocks as unknown as Map<
      string,
      { compiledSql?: string; missingParams?: string[] }
    >
  } catch {
    compiled = null
  }

  const blocks = windows.map((w) => {
    const base: Record<string, unknown> = {
      name: assistantBlockName(w),
      kind: w.kind,
      title: w.title,
      rect: { x: w.x, y: w.y, width: w.width, height: w.height },
      minimized: w.minimized,
    }
    if (w.kind === "data") {
      const payload = w.payload as DataPayload | undefined
      const block = compiled?.get(w.id)
      base.sql = payload ? sourceSqlForPayload(payload) : null
      if (block?.compiledSql && block.compiledSql !== base.sql) {
        base.resolved_sql = block.compiledSql
      }
      if (block?.missingParams?.length) base.missing_params = block.missingParams
    }
    return base
  })

  return {
    schema_version: "rvbbit.desktop_context.v1",
    blocks,
    params: params.map((p) => ({
      key: p.key,
      block: p.sourceBlockName,
      field: p.field,
      operator: p.operator ?? "eq",
      value: p.value,
    })),
    apply_report: applyReport,
  }
}

// ── Turn transport ──────────────────────────────────────────────────────

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sqlJsonLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value ?? null))}::jsonb`
}

const CONVERSATION_WINDOW = 24

export async function runAssistantTurn(
  connectionId: string,
  message: string,
  thread: AssistantMessage[],
  desktopContext: Record<string, unknown>,
): Promise<AssistantTurnResult> {
  // The spine carries intent + a compact record of what each turn DID (so
  // "put those back" works across desktop resets) — never tool payloads.
  const conversation = thread
    .filter((m) => !m.error)
    .slice(-CONVERSATION_WINDOW)
    .map((m) => ({
      role: m.role,
      text: m.text,
      ...(m.commands?.length
        ? {
            did: m.commands.map((c, i) => ({
              ...c,
              ...("sql" in c && typeof c.sql === "string"
                ? { sql: c.sql.slice(0, 400) }
                : {}),
              ...(m.report?.[i]?.status === "skipped" ? { skipped: true } : {}),
            })),
          }
        : {}),
    }))
  const sql = `SELECT rvbbit.desktop_assistant_turn(${sqlLiteral(message)}, ${sqlJsonLiteral(conversation)}, ${sqlJsonLiteral(desktopContext)}) AS result`
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, sql, readOnly: false, rowLimit: 1 }),
  })
  const body = (await res.json()) as {
    error?: string
    rows?: Array<Record<string, unknown>>
  }
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `assistant turn failed (${res.status})`)
  }
  let value: unknown = body.rows?.[0]?.result ?? null
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      value = { reply: value, commands: [] }
    }
  }
  // The operator's final sql step returns a row named `result`, so the op
  // return arrives as {result: {...}} — unwrap one level when present.
  const outer = (value ?? {}) as Record<string, unknown>
  const inner = (outer.result ?? outer) as Record<string, unknown>
  const commands = Array.isArray(inner.commands)
    ? (inner.commands as AssistantCommand[])
    : []
  return {
    reply:
      typeof inner.reply === "string" && inner.reply.trim().length > 0
        ? inner.reply
        : "(no reply)",
    commands,
    agentRunId: typeof inner.agent_run_id === "string" ? inner.agent_run_id : null,
    status: typeof inner.status === "string" ? inner.status : "unknown",
  }
}

// ── Thread persistence: localStorage L1, homebase as the record ────────

const THREAD_KEY = "rvbbit-lens.assistant.thread.v1"
const THREAD_LOCAL_MAX = 400

export function loadThreadLocal(): AssistantMessage[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(THREAD_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AssistantMessage[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveThreadLocal(messages: AssistantMessage[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      THREAD_KEY,
      JSON.stringify(messages.slice(-THREAD_LOCAL_MAX)),
    )
  } catch {
    // localStorage full/blocked — homebase still has the record.
  }
}

/** Best-effort append to homebase (fire-and-forget, like server-sync). */
export function appendThreadRemote(messages: AssistantMessage[]): void {
  if (typeof window === "undefined" || messages.length === 0) return
  try {
    void fetch("/api/lens/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ home: getHomeId(), messages }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // best-effort
  }
}

/** Hydrate from homebase when localStorage is empty (new browser, same home). */
export async function fetchThreadRemote(): Promise<AssistantMessage[]> {
  try {
    const res = await fetch(
      `/api/lens/assistant?home=${encodeURIComponent(getHomeId())}&limit=${THREAD_LOCAL_MAX}`,
    )
    if (!res.ok) return []
    const body = (await res.json()) as { messages?: AssistantMessage[] }
    return Array.isArray(body.messages) ? body.messages : []
  } catch {
    return []
  }
}

export function newAssistantMessage(
  role: AssistantMessage["role"],
  text: string,
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return { id: randomUUID(), role, text, at: Date.now(), ...extra }
}
