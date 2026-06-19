"use client"

/**
 * Agent **Messages** window. A viewer over rvbbit.agent_messages — the per-turn
 * transcript of `kind:"agent"` operator runs. Two panes:
 *   - left: runs rolled up by run_id (one agent call), newest first, with cost
 *   - right: the selected run's transcript (system/user/assistant/tool/error)
 *
 * Read-only; this is a debugging surface for "what did the agent do, and what
 * did it cost". Pairs with the Costs window (operator-level spend) and the
 * Operators builder (where agent operators are authored).
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { RefreshCw } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { AgentMessagesPayload } from "@/lib/desktop/types"
import {
  fetchAgentOperators,
  fetchAgentRuns,
  fetchAgentTranscript,
  type AgentRun,
  type AgentRunStatus,
  type AgentTurn,
} from "@/lib/rvbbit/agent-messages"
import { CodePreview, type CodeLang } from "./code-preview"

interface AgentMessagesWindowProps {
  payload: AgentMessagesPayload
  activeConnectionId: string | null
  onOpenOperator?: (operatorName: string) => void
}

const STATUS_COLOR: Record<AgentRunStatus, string> = {
  done: "var(--success)",
  capped: "var(--warning)",
  error: "var(--danger)",
  running: "var(--chrome-text)",
}
const STATUS_LABEL: Record<AgentRunStatus, string> = {
  done: "done",
  capped: "capped",
  error: "error",
  running: "running",
}

const ROLE_COLOR: Record<string, string> = {
  system: "var(--chrome-text)",
  user: "var(--main)",
  assistant: "var(--viz-op-agent)",
  tool: "var(--viz-op-sql)",
  error: "var(--danger)",
}

function fmtCost(v: number | null | undefined): string {
  if (v == null) return "—"
  if (v === 0) return "$0"
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

function fmtTime(iso: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function fmtDuration(startIso: string, endIso: string): string {
  const a = new Date(startIso).getTime()
  const b = new Date(endIso).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return ""
  const ms = b - a
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

interface ParsedToolCall {
  name: string
  args: string
  json: boolean
}
function parseToolCalls(raw: unknown): ParsedToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw.map((tc) => {
    const fn = (tc as { function?: { name?: string; arguments?: string } }).function
    let args = fn?.arguments ?? ""
    let json = false
    try {
      args = JSON.stringify(JSON.parse(args), null, 2)
      json = true
    } catch {
      /* leave raw */
    }
    return { name: fn?.name ?? "?", args, json }
  })
}

function jsonPreview(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

function codeLang(raw: string | undefined): CodeLang {
  const lang = (raw ?? "").trim().toLowerCase()
  if (lang === "json" || lang === "jsonc") return "json"
  if (lang === "sql" || lang === "postgres" || lang === "postgresql" || lang === "plpgsql") return "sql"
  if (lang === "yaml" || lang === "yml") return "yaml"
  if (lang === "dockerfile") return "dockerfile"
  return "text"
}

function safeHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed
  return null
}

function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let i = 0
  let seq = 0
  const pushText = (value: string) => {
    if (value) nodes.push(value)
  }
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1)
      if (end > i + 1) {
        nodes.push(
          <code key={`${prefix}-code-${seq++}`} className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[0.92em] text-foreground/90">
            {text.slice(i + 1, end)}
          </code>,
        )
        i = end + 1
        continue
      }
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2)
      if (end > i + 2) {
        nodes.push(
          <strong key={`${prefix}-strong-${seq++}`} className="font-semibold text-foreground">
            {renderInline(text.slice(i + 2, end), `${prefix}-strong-${seq}`)}
          </strong>,
        )
        i = end + 2
        continue
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1)
      if (end > i + 1) {
        nodes.push(
          <em key={`${prefix}-em-${seq++}`} className="text-foreground/90">
            {renderInline(text.slice(i + 1, end), `${prefix}-em-${seq}`)}
          </em>,
        )
        i = end + 1
        continue
      }
    }
    if (text[i] === "[") {
      const labelEnd = text.indexOf("]", i + 1)
      const urlStart = labelEnd >= 0 ? text.indexOf("(", labelEnd) : -1
      const urlEnd = urlStart === labelEnd + 1 ? text.indexOf(")", urlStart + 1) : -1
      if (labelEnd > i + 1 && urlEnd > urlStart + 1) {
        const href = safeHref(text.slice(urlStart + 1, urlEnd))
        if (href) {
          nodes.push(
            <a
              key={`${prefix}-a-${seq++}`}
              href={href}
              target={href.startsWith("http") ? "_blank" : undefined}
              rel={href.startsWith("http") ? "noreferrer" : undefined}
              className="text-main underline decoration-main/35 underline-offset-2 hover:decoration-main"
            >
              {renderInline(text.slice(i + 1, labelEnd), `${prefix}-a-${seq}`)}
            </a>,
          )
          i = urlEnd + 1
          continue
        }
      }
    }
    const next = ["`", "*", "["]
      .map((marker) => text.indexOf(marker, i + 1))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)[0]
    if (next == null) {
      pushText(text.slice(i))
      break
    }
    pushText(text.slice(i, next))
    i = next
  }
  return nodes
}

function inlineWithBreaks(text: string, prefix: string): ReactNode[] {
  const lines = text.split("\n")
  const nodes: ReactNode[] = []
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${prefix}-br-${i}`} />)
    nodes.push(...renderInline(line, `${prefix}-${i}`))
  })
  return nodes
}

function parseTable(lines: string[], start: number): { node: ReactNode; next: number } | null {
  if (start + 1 >= lines.length) return null
  if (!lines[start].includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[start + 1])) {
    return null
  }
  const split = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
  const head = split(lines[start])
  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(split(lines[i]))
    i += 1
  }
  return {
    next: i,
    node: (
      <div key={`table-${start}`} className="my-2 overflow-x-auto rounded border border-chrome-border/45">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead className="bg-foreground/[0.04] text-chrome-text/70">
            <tr>
              {head.map((cell, idx) => (
                <th key={idx} className="border-b border-chrome-border/45 px-2 py-1 font-medium">
                  {inlineWithBreaks(cell, `table-${start}-h-${idx}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-t border-chrome-border/25">
                {head.map((_, cellIdx) => (
                  <td key={cellIdx} className="px-2 py-1 align-top text-foreground/85">
                    {inlineWithBreaks(row[cellIdx] ?? "", `table-${start}-${rowIdx}-${cellIdx}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  }
}

function MarkdownMessage({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const nodes: ReactNode[] = []
  const flushParagraph = (buffer: string[], key: string) => {
    if (buffer.length === 0) return
    nodes.push(
      <p key={key} className="my-2 leading-relaxed text-foreground/88">
        {inlineWithBreaks(buffer.join("\n"), key)}
      </p>,
    )
    buffer.length = 0
  }
  const paragraph: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      flushParagraph(paragraph, `p-${i}`)
      i += 1
      continue
    }

    const fence = line.match(/^\s*```([A-Za-z0-9_-]+)?\s*$/)
    if (fence) {
      flushParagraph(paragraph, `p-${i}`)
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      nodes.push(
        <CodePreview
          key={`code-${i}`}
          code={body.join("\n")}
          lang={codeLang(fence[1])}
          overflow="x"
          className="my-2 rounded border border-chrome-border/45 bg-foreground/[0.025] p-2 text-[10.5px]"
        />,
      )
      continue
    }

    const table = parseTable(lines, i)
    if (table) {
      flushParagraph(paragraph, `p-${i}`)
      nodes.push(table.node)
      i = table.next
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushParagraph(paragraph, `p-${i}`)
      const level = heading[1].length
      nodes.push(
        <div
          key={`h-${i}`}
          className={cn(
            "mb-1 mt-2 font-semibold text-foreground",
            level <= 1 ? "text-[14px]" : level === 2 ? "text-[13px]" : "text-[12px]",
          )}
        >
          {renderInline(heading[2], `h-${i}`)}
        </div>,
      )
      i += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph, `p-${i}`)
      const quoted: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""))
        i += 1
      }
      nodes.push(
        <blockquote key={`q-${i}`} className="my-2 border-l-2 border-main/45 pl-2 text-chrome-text/75">
          {inlineWithBreaks(quoted.join("\n"), `q-${i}`)}
        </blockquote>,
      )
      continue
    }

    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)/)
    if (listMatch) {
      flushParagraph(paragraph, `p-${i}`)
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/)
        if (!item) break
        items.push(item[1])
        i += 1
      }
      const Tag = ordered ? "ol" : "ul"
      nodes.push(
        <Tag
          key={`list-${i}`}
          className={cn("my-2 space-y-1 pl-5 text-foreground/86", ordered ? "list-decimal" : "list-disc")}
        >
          {items.map((item, idx) => (
            <li key={idx}>{inlineWithBreaks(item, `list-${i}-${idx}`)}</li>
          ))}
        </Tag>,
      )
      continue
    }

    paragraph.push(line)
    i += 1
  }
  flushParagraph(paragraph, "p-last")
  return <div className="av-agent-markdown text-[11px] leading-relaxed">{nodes}</div>
}

function MessageContent({ content }: { content: string }) {
  const json = jsonPreview(content)
  if (json) {
    return (
      <CodePreview
        code={json}
        lang="json"
        overflow="x"
        className="rounded border border-chrome-border/45 bg-foreground/[0.025] p-2 text-[10.5px]"
      />
    )
  }
  return <MarkdownMessage text={content} />
}

function TokenHeatStrip({ run, maxTokens }: { run: AgentRun; maxTokens: number }) {
  if (run.messageHeat.length === 0) return null
  return (
    <div className="flex flex-wrap gap-px" aria-label="Messages by token volume">
      {run.messageHeat.map((m) => {
        const pct = Math.max(0.05, Math.min(1, m.tokens / Math.max(1, maxTokens)))
        const heat = Math.round(18 + pct * 58)
        const background = m.error
          ? "var(--danger)"
          : `linear-gradient(135deg, color-mix(in oklch, var(--main) ${heat}%, transparent), color-mix(in oklch, var(--viz-op-agent) ${Math.min(84, heat + 18)}%, transparent))`
        const ringColor =
          m.role === "tool"
            ? "color-mix(in oklch, var(--viz-op-sql) 52%, transparent)"
            : "color-mix(in oklch, white 12%, transparent)"
        const style = {
          background,
          opacity: 0.38 + pct * 0.62,
          "--tw-ring-color": ringColor,
        } as CSSProperties
        return (
          <span
            key={m.turnIdx}
            className="h-1.5 w-1.5 rounded-[1px] ring-1 ring-inset"
            style={style}
            title={`#${m.turnIdx} ${m.role}${m.toolName ? `:${m.toolName}` : ""} · ${m.tokens} tokens${m.error ? " · error" : ""}`}
          />
        )
      })}
    </div>
  )
}

export function AgentMessagesWindow({
  payload,
  activeConnectionId,
  onOpenOperator,
}: AgentMessagesWindowProps) {
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [operators, setOperators] = useState<string[]>([])
  const [operatorFilter, setOperatorFilter] = useState<string | null>(payload.operator ?? null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(payload.initialRunId ?? null)
  const [transcript, setTranscript] = useState<AgentTurn[]>([])
  const [loading, setLoading] = useState(false)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    if (!activeConnectionId) {
      setRuns([])
      return
    }
    setLoading(true)
    setError(null)
    const [r, ops] = await Promise.all([
      fetchAgentRuns(activeConnectionId, { operator: operatorFilter, limit: 200 }),
      fetchAgentOperators(activeConnectionId),
    ])
    if (r.error) setError(r.error)
    setRuns(r.runs)
    setOperators(ops.operators)
    setLoading(false)
    // Auto-select the first run if nothing is selected (or selection vanished).
    setSelectedRunId((prev) =>
      prev && r.runs.some((x) => x.runId === prev) ? prev : (r.runs[0]?.runId ?? null),
    )
  }, [activeConnectionId, operatorFilter])

  useEffect(() => {
    // Defer out of the synchronous effect body so the initial setState in
    // loadRuns doesn't cascade renders (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      void loadRuns()
    })
  }, [loadRuns])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!activeConnectionId || !selectedRunId) {
        setTranscript([])
        return
      }
      setTranscriptLoading(true)
      fetchAgentTranscript(activeConnectionId, selectedRunId).then((res) => {
        if (cancelled) return
        setTranscript(res.turns)
        setTranscriptLoading(false)
      })
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selectedRunId])

  const totals = useMemo(() => {
    let cost = 0
    let tokens = 0
    let hasCost = false
    for (const r of runs) {
      if (r.costUsd != null) {
        cost += r.costUsd
        hasCost = true
      }
      tokens += r.tokensIn + r.tokensOut
    }
    return { cost: hasCost ? cost : null, tokens }
  }, [runs])
  const heatMaxTokens = useMemo(
    () => Math.max(1, ...runs.flatMap((r) => r.messageHeat.map((m) => m.tokens))),
    [runs],
  )

  const selected = runs.find((r) => r.runId === selectedRunId) ?? null

  if (!activeConnectionId) {
    return (
      <div className="flex h-full items-center justify-center bg-doc-bg text-sm text-chrome-text/60 group-data-[focused=false]/window:bg-doc-bg/70">
        No active connection.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-doc-bg text-foreground group-data-[focused=false]/window:bg-doc-bg/70">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-chrome-border/60 bg-chrome-bg/35 px-3 py-2 backdrop-blur-[2px] group-data-[focused=false]/window:bg-chrome-bg/20">
        <span className="text-[11px] font-medium uppercase tracking-wider text-chrome-text/70">
          Agent Messages
        </span>
        <select
          value={operatorFilter ?? ""}
          onChange={(e) => setOperatorFilter(e.target.value || null)}
          className="rounded border border-chrome-border/70 bg-transparent px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-main/60"
        >
          <option value="">all operators</option>
          {operators.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-3 text-[10px] tabular-nums text-chrome-text/60">
          <span>{runs.length} runs</span>
          <span>{(totals.tokens / 1000).toFixed(1)}k tok</span>
          <span className="text-foreground/80">{fmtCost(totals.cost)}</span>
          <button
            type="button"
            onClick={() => void loadRuns()}
            className="rounded p-1 hover:bg-foreground/10"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Left — run list */}
        <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-chrome-border/50 bg-foreground/[0.012] group-data-[focused=false]/window:bg-transparent">
          {runs.length === 0 && !loading ? (
            <div className="p-4 text-[11px] leading-relaxed text-chrome-text/55">
              No agent runs yet. Call an agent operator (a <span className="font-mono">kind:&quot;agent&quot;</span>{" "}
              step) — e.g. <span className="font-mono">SELECT rvbbit.pg_health(&apos;&apos;)</span> — and its
              transcript appears here.
            </div>
          ) : (
            runs.map((r) => (
              <button
                key={r.runId}
                type="button"
                onClick={() => setSelectedRunId(r.runId)}
                className={cn(
                  "flex flex-col gap-1 border-b border-chrome-border/30 px-3 py-2 text-left transition-colors",
                  r.runId === selectedRunId ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.03]",
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_COLOR[r.status] }}
                    title={STATUS_LABEL[r.status]}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
                    {r.operator ?? "(unknown)"}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-foreground/70">
                    {fmtCost(r.costUsd)}
                  </span>
                </div>
                {r.task ? (
                  <span className="line-clamp-2 text-[10px] leading-snug text-chrome-text/60">
                    {r.task}
                  </span>
                ) : null}
                <TokenHeatStrip run={r} maxTokens={heatMaxTokens} />
                <div className="flex items-center gap-2 text-[9px] tabular-nums text-chrome-text/45">
                  <span>{fmtTime(r.startedAt)}</span>
                  <span>· {r.turns} turns</span>
                  <span>· {r.toolCalls} tools</span>
                  {r.toolErrors > 0 ? (
                    <span className="text-warning/80" title="tool errors the agent recovered from">
                      · {r.toolErrors} retried
                    </span>
                  ) : null}
                  <span>· {((r.tokensIn + r.tokensOut) / 1000).toFixed(1)}k tok</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Right — transcript */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selected ? (
            <div className="flex items-center gap-2 border-b border-chrome-border/40 px-3 py-1.5 text-[10px] text-chrome-text/60">
              <button
                type="button"
                disabled={!onOpenOperator || !selected.operator}
                onClick={() => selected.operator && onOpenOperator?.(selected.operator)}
                className={cn(
                  "font-mono text-foreground/85",
                  onOpenOperator && selected.operator
                    ? "underline-offset-2 hover:underline"
                    : "cursor-default",
                )}
              >
                {selected.operator ?? "(unknown)"}
              </button>
              {selected.model ? <span className="text-chrome-text/45">{selected.model}</span> : null}
              <span className="text-chrome-text/45">
                {fmtDuration(selected.startedAt, selected.endedAt)}
              </span>
              <span className="ml-auto tabular-nums">
                {selected.tokensIn}↓ / {selected.tokensOut}↑ tok · {fmtCost(selected.costUsd)}
              </span>
              {selected.toolErrors > 0 ? (
                <span
                  className="rounded px-1.5 py-px text-[9px] text-warning/90"
                  style={{ backgroundColor: "color-mix(in oklch, var(--warning) 14%, transparent)" }}
                  title="tool errors the agent recovered from"
                >
                  {selected.toolErrors} tool {selected.toolErrors === 1 ? "retry" : "retries"}
                </span>
              ) : null}
              <span
                className="rounded px-1.5 py-px text-[9px] font-medium uppercase tracking-wide"
                style={{
                  color: STATUS_COLOR[selected.status],
                  backgroundColor: `color-mix(in oklch, ${STATUS_COLOR[selected.status]} 16%, transparent)`,
                }}
              >
                {STATUS_LABEL[selected.status]}
              </span>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {transcriptLoading ? (
              <div className="p-4 text-[11px] text-chrome-text/50">Loading transcript…</div>
            ) : transcript.length === 0 ? (
              <div className="p-4 text-[11px] text-chrome-text/50">
                {selected ? "No turns recorded for this run." : "Select a run to see its transcript."}
              </div>
            ) : (
              <div className="space-y-2">
                {transcript.map((t) => (
                  <TurnBlock key={t.turnIdx} turn={t} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TurnBlock({ turn }: { turn: AgentTurn }) {
  const color = ROLE_COLOR[turn.role] ?? "var(--chrome-text)"
  const toolCalls = turn.role === "assistant" ? parseToolCalls(turn.toolCalls) : []
  return (
    <div
      className="rounded-[4px] border bg-foreground/[0.02] px-2.5 py-1.5"
      style={{ borderColor: `color-mix(in oklch, ${color} 30%, transparent)` }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className="text-[9px] font-semibold uppercase tracking-wider"
          style={{ color }}
        >
          {turn.role}
          {turn.role === "tool" && turn.toolName ? (
            <span className="ml-1 font-mono normal-case text-chrome-text/55">{turn.toolName}</span>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[9px] tabular-nums text-chrome-text/40">
          {turn.finishReason ? <span>{turn.finishReason}</span> : null}
          {turn.tokensIn || turn.tokensOut ? (
            <span>
              {turn.tokensIn}↓/{turn.tokensOut}↑
            </span>
          ) : null}
          {turn.costUsd ? <span>{fmtCost(turn.costUsd)}</span> : null}
          {turn.latencyMs ? <span>{turn.latencyMs}ms</span> : null}
        </span>
      </div>

      {toolCalls.length > 0 ? (
        <div className="mb-2 space-y-1">
          {toolCalls.map((c, i) => (
            <div
              key={i}
              className="overflow-hidden rounded border border-chrome-border/40 bg-foreground/[0.035]"
            >
              <div className="border-b border-chrome-border/35 px-2 py-1 font-mono text-[10px] text-foreground/85">
                {c.name}
              </div>
              {c.args ? (
                c.json ? (
                  <CodePreview
                    code={c.args}
                    lang="json"
                    overflow="x"
                    className="bg-transparent p-2 text-[10px]"
                  />
                ) : (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words p-2 font-mono text-[10px] leading-relaxed text-chrome-text/75">
                    {c.args}
                  </pre>
                )
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {turn.content ? (
        <MessageContent content={turn.content} />
      ) : toolCalls.length === 0 ? (
        <span className="text-[10px] italic text-chrome-text/40">(no content)</span>
      ) : null}

      {turn.error ? (
        <div className="mt-1 rounded bg-danger/10 px-1.5 py-1 text-[10px] text-danger">
          {turn.error}
        </div>
      ) : null}
    </div>
  )
}
