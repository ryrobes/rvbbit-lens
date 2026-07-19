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
import { loadVoiceSettings } from "./assistant-voice"
import type { AssistantBlockExecutionObservation } from "./assistant-execution"

// ── Command contract (rvbbit.desktop_commands.v1) ──────────────────────

/** An HTML app artifact (rvbbit.html_block.v1 shape, pre-normalization).
 *  Same species the in-block App builder produces — assistant-created apps are
 *  full citizens of the existing app-block runtime (rvbbitQuery bridge,
 *  emitFilter, publish, Saved Views). */
export interface AssistantAppArtifact {
  title?: string
  html: string
  queries: Array<{
    id: string
    title?: string
    role?: string
    sql: string
    filterable?: string[]
  }>
  bindings?: unknown[]
}

export type AssistantCommand =
  | {
      op: "create_block"
      name?: string
      title?: string
      sql?: string
      /** Vega-Lite mark+encoding only — the chart tab injects data/size/theme. */
      chart?: Record<string, unknown>
      /** Full HTML app; when present, sql is derived from the app's queries. */
      app?: AssistantAppArtifact
      place?: "auto" | { near: string }
    }
  | {
      op: "update_block"
      target: string
      patch: {
        sql?: string
        title?: string
        /** New spec, or null to clear back to the auto-inferred chart. */
        chart?: Record<string, unknown> | null
        /** Replace the block's HTML app artifact. */
        app?: AssistantAppArtifact
      }
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
  | {
      /** Visual self-check: screenshot a surface and see it in an automatic
       *  follow-up turn. target = "plate:<id>" or "block:<name>". Opt-in via
       *  assistant settings; the client enforces the per-request budget. */
      op: "capture"
      target: string
    }
  | {
      /** Install (or replace) a plate — a durable server-rendered SQL surface
       *  stored as a rvbbit.plates row. The applier round-trips the install
       *  so apply_report carries the installer's real verdict. */
      op: "upsert_plate"
      plate_id: string
      title?: string
      template: string
      queries?: Record<string, { sql: string; database?: string }>
      actions?: Record<string, unknown>
      params?: Array<Record<string, unknown>>
      kit?: string | null
      description?: string
    }
  | { op: "open_plate"; plate_id: string; title?: string }
  | {
      /** Register/re-register a kit's metadata (title/version/description).
       *  Downgrades refused engine-side; the error lands in apply_report. */
      op: "register_kit"
      kit: string
      title: string
      description?: string
      version?: string
      requires?: Record<string, unknown>
    }

/** Per-command outcome, reported back to the agent in the NEXT turn's
 *  desktop_context.apply_report — the agent never assumes an apply succeeded. */
export interface AssistantApplyResult {
  op: string
  target?: string
  status: "applied" | "skipped"
  detail?: string
  /** capture only: the screenshot, delivered on the auto-continuation turn.
   *  Stripped before the report is serialized into desktop_context. */
  attachment?: AssistantImageAttachment
}

export interface AssistantApplyOptions {
  /** Replaying already-approved transcript commands is not a new model turn and
   *  may legitimately span more than the per-turn command cap. */
  historicalReplay?: boolean
}

export const ASSISTANT_COMMAND_CAP = 12

export interface AssistantMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: number
  attachments?: AssistantImageAttachment[]
  agentRunId?: string | null
  commands?: AssistantCommand[]
  report?: AssistantApplyResult[]
  error?: boolean
}

export interface AssistantImageAttachment {
  id: string
  kind: "image"
  dataUrl: string
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  width: number
  height: number
  name: string
  source?: {
    windowId?: string
    blockName?: string
    title?: string
    capturedAt?: number
  }
}

export interface AssistantTurnResult {
  reply: string
  commands: AssistantCommand[]
  attachments: AssistantImageAttachment[]
  agentRunId: string | null
  status: string
  error: string | null
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
  executionObservations: Record<string, AssistantBlockExecutionObservation> = {},
  focusedWindowId: string | null = null,
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
      // Chatting doesn't steal window focus, so the focused window is a
      // live signal of what the user is looking at — a disambiguation
      // hint ("this chart", "make it wider"), never a scope restriction.
      ...(w.id === focusedWindowId ? { focused: true } : {}),
    }
    if (w.kind === "data") {
      const payload = w.payload as DataPayload | undefined
      const block = compiled?.get(w.id)
      base.sql = payload ? sourceSqlForPayload(payload) : null
      if (block?.compiledSql && block.compiledSql !== base.sql) {
        base.resolved_sql = block.compiledSql
      }
      if (block?.missingParams?.length) base.missing_params = block.missingParams
      const execution = executionObservations[w.id]
      if (execution) base.execution = execution
      // App blocks: the artifact IS the current truth she patches against —
      // it rides in the snapshot (fresh every turn), never in conversation.
      if (payload?.htmlBlock) {
        base.app = {
          title: payload.htmlBlock.title,
          html: payload.htmlBlock.html,
          queries: payload.htmlBlock.queries?.map((q) => ({
            id: q.id,
            title: q.title,
            sql: q.sql,
          })),
          bindings: payload.htmlBlock.bindings,
        }
      }
    }
    return base
  })

  const persona = loadPersona()
  const selfCheck = loadVisualSelfCheck()
    ? 'VISUAL SELF-CHECK is enabled: after creating or restyling a visual surface you may add {"op":"capture","target":"plate:<id>"} or {"op":"capture","target":"block:<name>"} as the LAST command — the desktop screenshots it and sends the image back in an automatic follow-up turn. Budget: 2 captures per user request, client-enforced. The loop is build, capture, one fix pass, capture, done — never iterate further without asking. Captures render with fallback fonts and no wallpaper; judge layout, hierarchy, and spacing, not font faces.'
    : ""
  // Content-shape nudge only — delivery (audio tags, flavor) lives in the
  // speech-render pass, never in the agent loop.
  const speakable = loadVoiceSettings().ttsEnabled
    ? "Replies may be read aloud by text-to-speech: prefer speakable prose, and avoid gratuitous tables or long code dumps in the reply text (put those on the desktop instead)."
    : ""
  const personaOut = [persona, speakable, selfCheck].filter(Boolean).join("\n\n")
  const themeTokens = readThemeTokens()
  return {
    schema_version: "rvbbit.desktop_context.v1",
    ...(personaOut ? { persona: personaOut } : {}),
    ...(themeTokens
      ? {
          theme: {
            note: "The desktop's live theme. These CSS custom properties are pre-materialized inside app iframes — style apps with var(--main), var(--background), var(--foreground) etc. (or the literal values here) so they match the desktop instead of inventing a palette.",
            tokens: themeTokens,
          },
        }
      : {}),
    spend_threshold_usd: loadSpendThreshold(),
    ...(focusedWindowId && windows.some((w) => w.id === focusedWindowId)
      ? {
          focused_block_note:
            "One block carries focused:true — the window the user currently has focused. When a request is ambiguous about its target ('this one', 'the chart', bare restyle asks), prefer the focused block; every other block remains fully addressable.",
        }
      : {}),
    blocks,
    params: params.map((p) => ({
      key: p.key,
      block: p.sourceBlockName,
      field: p.field,
      operator: p.operator ?? "eq",
      value: p.value,
    })),
    apply_report:
      applyReport?.map(({ attachment: _drop, ...rest }) => rest) ?? applyReport,
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
const INCOMPLETE_COMMAND_REPLY =
  "I ran out of output space while building that, so I left the desktop unchanged. Try asking me to split it into smaller blocks."
const INVALID_COMMAND_REPLY =
  "I could not finish a valid desktop command, so I left the desktop unchanged. Please try that again."

function looksLikeIncompleteCommandEnvelope(value: unknown): boolean {
  if (typeof value !== "string") return false
  const text = value.trim()
  return text.startsWith("{") && (!text.endsWith("}") || /"(?:reply|commands|op)"\s*:/.test(text))
}

/** Keep legacy malformed envelopes out of both the visible transcript and the
 * next model turn. The raw durable record stays untouched for diagnostics. */
export function assistantReplyForDisplay(text: string): string {
  if (!looksLikeIncompleteCommandEnvelope(text)) return text
  return text.trim().endsWith("}") ? INVALID_COMMAND_REPLY : INCOMPLETE_COMMAND_REPLY
}

// ── Pasted images → attachments ─────────────────────────────────────────

/** Turn a clipboard image blob into a chat attachment: downscaled to a
 *  vision-friendly size and re-encoded webp so a 4K screenshot doesn't ride
 *  the turn at full weight. */
export async function imageAttachmentFromBlob(
  blob: Blob,
  name = "pasted image",
): Promise<AssistantImageAttachment> {
  const bitmap = await createImageBitmap(blob)
  const maxSide = 1600
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("canvas unavailable")
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return {
    id: randomUUID(),
    kind: "image",
    dataUrl: canvas.toDataURL("image/webp", 0.85),
    mimeType: "image/webp",
    width,
    height,
    name,
  }
}

// ── Desktop theme tokens ────────────────────────────────────────────────
//
// App iframes have their own document, so the desktop's CSS custom
// properties don't resolve inside them. Two halves of one fix: the app
// renderer injects a PRE-MATERIALIZED :root{} block (app-block-view), and
// the agent's desktop context carries the same resolved values so generated
// HTML styles itself with the live theme instead of invented colors.

const THEME_TOKENS = [
  "main",
  "background",
  "foreground",
  "secondary-background",
  "chrome-border",
  "chrome-text",
  "block-bg",
  "success",
  "warning",
  "destructive",
] as const

export function readThemeTokens(): Record<string, string> | null {
  if (typeof document === "undefined") return null
  const cs = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const t of THEME_TOKENS) {
    const v = cs.getPropertyValue(`--${t}`).trim()
    if (v) out[`--${t}`] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A <style> tag materializing the live theme for an app iframe's document. */
export function themeStyleTag(): string {
  const tokens = readThemeTokens()
  if (!tokens) return ""
  const vars = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ")
  return `<style id="__rvbbit-theme">:root { ${vars} }</style>`
}

// ── In-turn tool activity (the thinking dots) ───────────────────────────
//
// The agent loop writes one rvbbit.agent_messages row per COMPLETED tool
// call (role='tool': tool_name + call arguments + result). While a turn is
// in flight the window polls the newest run and renders a dot per call —
// the enhanced-thinking effect. Read-only, best-effort, and scoped to rows
// newer than the turn start (15s skew buffer) so an old run never bleeds in.

export interface TurnToolEvent {
  idx: number
  tool: string
  /** The call's arguments (e.g. the SQL text), clipped server-side. */
  args: string
  /** First bytes of the tool result, clipped server-side. */
  result: string
}

/** Cross-connection live tally of the in-flight turn's tool calls — the
 *  agent loop bumps shared memory per call (engines ≥ 4.0.11), because the
 *  audit rows themselves are invisible until the turn's transaction commits.
 *  Returns 0 on older engines (no tick → no rows), which just means the
 *  thinking pill shows no dots until the reply lands. */
export async function fetchLiveToolCount(connectionId: string): Promise<number> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql: "SELECT coalesce(sum(calls), 0)::int AS n FROM rvbbit.live_call_counts() WHERE operator = 'assistant:tool'",
        readOnly: true,
        rowLimit: 1,
      }),
    })
    const body = (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string }
    if (!res.ok || body.error) return 0
    return Number(body.rows?.[0]?.n ?? 0)
  } catch {
    return 0
  }
}

export async function fetchTurnToolEvents(
  connectionId: string,
  runId: string,
): Promise<TurnToolEvent[]> {
  const sql = `
    SELECT turn_idx AS idx,
           coalesce(nullif(tool_name, ''), 'tool') AS tool,
           left(coalesce(tool_calls::text, ''), 500) AS args,
           left(coalesce(content, ''), 240) AS result
    FROM rvbbit.agent_messages
    WHERE run_id = ${sqlLiteral(runId)} AND role = 'tool'
    ORDER BY turn_idx`
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, sql, readOnly: true, rowLimit: 64 }),
    })
    const body = (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string }
    if (!res.ok || body.error) return []
    return (body.rows ?? []).map((r) => ({
      idx: Number(r.idx ?? 0),
      tool: String(r.tool ?? "tool"),
      args: String(r.args ?? ""),
      result: String(r.result ?? ""),
    }))
  } catch {
    return []
  }
}

export async function runAssistantTurn(
  connectionId: string,
  message: string,
  thread: AssistantMessage[],
  desktopContext: Record<string, unknown>,
  attachments: AssistantImageAttachment[] = [],
): Promise<AssistantTurnResult> {
  // The spine carries intent + a compact record of what each turn DID (so
  // "put those back" works across desktop resets) — never tool payloads.
  const conversation = thread
    .filter((m) => !m.error)
    .slice(-CONVERSATION_WINDOW)
    .map((m) => ({
      role: m.role,
      text: m.role === "assistant" ? assistantReplyForDisplay(m.text) : m.text,
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map((attachment) => ({
              kind: attachment.kind,
              mimeType: attachment.mimeType,
              width: attachment.width,
              height: attachment.height,
              name: attachment.name,
              source: attachment.source,
            })),
          }
        : {}),
      ...(m.commands?.length
        ? {
            did: m.commands.map((c, i) => {
              const compact: Record<string, unknown> = {
                ...c,
                ...("sql" in c && typeof c.sql === "string"
                  ? { sql: c.sql.slice(0, 400) }
                  : {}),
                ...(m.report?.[i]?.status === "skipped" ? { skipped: true } : {}),
              }
              // App artifacts carry whole HTML documents — summarize instead of
              // dragging kilobytes of markup through every future turn. The
              // artifact itself lives on the block; she can ask for it.
              const app = (c as { app?: { html?: string; queries?: Array<{ id: string; sql: string }> } }).app
              if (app) {
                compact.app = {
                  html: `[${app.html?.length ?? 0} chars — live on the block]`,
                  queries: app.queries?.map((q) => ({ id: q.id, sql: q.sql.slice(0, 200) })),
                }
              }
              const patch = (c as { patch?: { app?: { html?: string; queries?: Array<{ id: string; sql: string }> } } }).patch
              if (patch?.app) {
                compact.patch = {
                  ...patch,
                  app: {
                    html: `[${patch.app.html?.length ?? 0} chars — live on the block]`,
                    queries: patch.app.queries?.map((q) => ({ id: q.id, sql: q.sql.slice(0, 200) })),
                  },
                }
              }
              return compact
            }),
          }
        : {}),
    }))
  // Keep text-only turns compatible with pre-vision pg_rvbbit installs. The
  // vision-capable overload is introduced by migration 0153 and carries only
  // the images attached to this user turn; historical screenshots remain
  // lightweight transcript metadata instead of being re-billed every turn.
  // Pass opts explicitly as the fifth argument so PostgreSQL cannot bind the
  // attachment jsonb to the legacy wrapper's fourth `opts` parameter.
  const sql = attachments.length > 0
    ? `SELECT rvbbit.desktop_assistant_turn(${sqlLiteral(message)}, ${sqlJsonLiteral(conversation)}, ${sqlJsonLiteral(desktopContext)}, ${sqlJsonLiteral(attachments)}, '{}'::jsonb) AS result`
    : `SELECT rvbbit.desktop_assistant_turn(${sqlLiteral(message)}, ${sqlJsonLiteral(conversation)}, ${sqlJsonLiteral(desktopContext)}) AS result`
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
    if (
      attachments.length > 0 &&
      /desktop_assistant_turn|function .* does not exist|no function matches/i.test(body.error ?? "")
    ) {
      throw new Error("Assistant screenshots require the pg_rvbbit assistant-vision update (migration 0153).")
    }
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
  const status = typeof inner.status === "string" ? inner.status : "unknown"
  const rawReply = typeof inner.reply === "string" ? inner.reply : ""
  const rawError = typeof inner.error === "string" && inner.error.trim()
    ? inner.error.trim()
    : null
  // Older pg_rvbbit runtimes returned a raw, partial command envelope as the
  // reply *and* supplied commands: []. Do not let that empty array mask the
  // malformed response while the extension and Lens are briefly on different
  // upgrade revisions.
  const incompleteCommandEnvelope = looksLikeIncompleteCommandEnvelope(rawReply)
  const normalizedStatus = incompleteCommandEnvelope
    ? rawReply.trim().endsWith("}")
      ? "invalid_structured_output"
      : "output_truncated"
    : status
  const incompleteOutput =
    normalizedStatus === "output_truncated" ||
    normalizedStatus === "invalid_structured_output"
  const commands = !incompleteOutput && Array.isArray(inner.commands)
    ? (inner.commands as AssistantCommand[])
    : []
  const responseAttachments = assistantImageAttachments(inner.attachments ?? inner.images)
  return {
    reply:
      incompleteOutput
        ? normalizedStatus === "output_truncated"
          ? INCOMPLETE_COMMAND_REPLY
          : INVALID_COMMAND_REPLY
        : rawReply.trim().length > 0
        ? rawReply
        : rawError
          ? `The assistant could not complete this turn: ${rawError}`
          : responseAttachments.length > 0
            ? ""
            : "The assistant turn ended without a reply.",
    commands,
    attachments: responseAttachments,
    agentRunId: typeof inner.agent_run_id === "string" ? inner.agent_run_id : null,
    status: normalizedStatus,
    error: rawError,
  }
}

function assistantImageAttachments(value: unknown): AssistantImageAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return []
    const image = entry as Record<string, unknown>
    const dataUrl = typeof image.dataUrl === "string"
      ? image.dataUrl
      : typeof image.data_url === "string"
        ? image.data_url
        : ""
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i.exec(dataUrl)
    if (!match) return []
    const mimeType = match[1].toLowerCase() as AssistantImageAttachment["mimeType"]
    return [{
      id: typeof image.id === "string" ? image.id : `assistant-image-${Date.now()}-${index}`,
      kind: "image" as const,
      dataUrl,
      mimeType,
      width: typeof image.width === "number" && image.width > 0 ? image.width : 0,
      height: typeof image.height === "number" && image.height > 0 ? image.height : 0,
      name: typeof image.name === "string" ? image.name : `Assistant image ${index + 1}`,
    }]
  })
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

/** Reconcile the durable thread with the browser's current in-memory tail.
 *  Later arguments win duplicate ids; timestamps restore transcript order. */
export function mergeAssistantThreads(...threads: AssistantMessage[][]): AssistantMessage[] {
  const byId = new Map<string, AssistantMessage>()
  for (const thread of threads) {
    for (const message of thread) {
      if (message?.id) byId.set(message.id, message)
    }
  }
  return [...byId.values()].sort((a, b) => a.at - b.at)
}

/** Best-effort append to homebase (fire-and-forget, like server-sync). */
export function appendThreadRemote(messages: AssistantMessage[]): void {
  if (typeof window === "undefined" || messages.length === 0) return
  try {
    const body = JSON.stringify({ home: getHomeId(), messages })
    void fetch("/api/lens/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // Browsers reject keepalive request bodies above roughly 64 KiB. Full
      // HTML app commands routinely cross that line; send those normally so
      // their resurrection payload reaches durable storage.
      keepalive: body.length <= 60_000,
    }).catch(() => {})
  } catch {
    // best-effort
  }
}

/** Fetch the durable tail. Callers merge it even when localStorage is nonempty:
 *  a large command may have exceeded localStorage while still reaching homebase. */
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

// ── Persona (assistant settings) ────────────────────────────────────────
//
// A user-authored standing note on voice/behavior, injected into every turn's
// desktop_context.persona. Local to the browser like the rest of L1 state.

const PERSONA_KEY = "rvbbit-lens.assistant.persona.v1"
export const PERSONA_MAX_CHARS = 2000

export function loadPersona(): string {
  if (typeof window === "undefined") return ""
  try {
    return (window.localStorage.getItem(PERSONA_KEY) ?? "").slice(0, PERSONA_MAX_CHARS)
  } catch {
    return ""
  }
}

export function savePersona(value: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(PERSONA_KEY, value.slice(0, PERSONA_MAX_CHARS))
  } catch {
    // best-effort
  }
}

// ── Visual self-check (opt-in) ──────────────────────────────────────────

const SELF_CHECK_KEY = "rvbbit-lens.assistant.selfcheck.v1"

export function loadVisualSelfCheck(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(SELF_CHECK_KEY) === "on"
  } catch {
    return false
  }
}

export function saveVisualSelfCheck(on: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SELF_CHECK_KEY, on ? "on" : "off")
  } catch {
    // best-effort
  }
}

// ── Spend threshold (the budget knob) ───────────────────────────────────
//
// Semantic SQL below this projected cost runs without asking; above it, she
// quotes the explain_semantic estimate and waits (a zero-command turn). The
// knob's existence is itself the incentive: you can't compare against a
// threshold without pricing first, so everything gets pre-explained.

const SPEND_KEY = "rvbbit-lens.assistant.spend.v1"
export const DEFAULT_SPEND_THRESHOLD_USD = 0.25

export function loadSpendThreshold(): number {
  if (typeof window === "undefined") return DEFAULT_SPEND_THRESHOLD_USD
  try {
    const raw = window.localStorage.getItem(SPEND_KEY)
    if (raw === null) return DEFAULT_SPEND_THRESHOLD_USD
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SPEND_THRESHOLD_USD
  } catch {
    return DEFAULT_SPEND_THRESHOLD_USD
  }
}

export function saveSpendThreshold(value: number): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SPEND_KEY, String(Math.max(0, value)))
  } catch {
    // best-effort
  }
}

export function newAssistantMessage(
  role: AssistantMessage["role"],
  text: string,
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return { id: randomUUID(), role, text, at: Date.now(), ...extra }
}
