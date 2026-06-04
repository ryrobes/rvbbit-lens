"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Box,
  Check,
  Database,
  Hash,
  Lock,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Wand2,
  X,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount } from "./instruments"
import type { CachePayload } from "@/lib/desktop/types"

interface CacheWindowProps {
  payload: CachePayload
  activeConnectionId: string | null
  onOpenOperator?: (name: string) => void
}

type TabKey = "synth" | "memo"

const TABS: {
  key: TabKey
  label: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
}[] = [
  { key: "synth", label: "Synth", hint: "shape → SQL", icon: Wand2 },
  { key: "memo", label: "Memo", hint: "inputs → output", icon: Box },
]

// ── Row shapes ──────────────────────────────────────────────────────

interface SynthRow {
  operator: string
  shape: string
  promptHash: string
  generatedSql: string
  status: string
  pinned: boolean
  updatedAt: number | null
}

interface MemoRow {
  operator: string
  hash: string
  model: string | null
  inputs: string
  output: string
  hits: number
  lastAt: number | null
}

/**
 * Cache — the administrable side of rvbbit's operator caches, the
 * counterpart to the read-only Receipts dashboard. Two surfaces:
 *
 *   Synth — the shape-keyed SQL compiler cache (rvbbit.synth_cache): one
 *           generated snippet per structural input shape. Pin, edit, or
 *           forget snippets; mutations bust the in-memory L1 via flush_cache.
 *   Memo  — the content-addressed operator result cache (rvbbit.receipts):
 *           atomic operation+inputs → output units with reuse counts. Purge
 *           per operator; flush the in-memory LRU.
 */
export function CacheWindow({ payload, activeConnectionId, onOpenOperator }: CacheWindowProps) {
  const [tab, setTab] = useState<TabKey>(payload.initialView === "memo" ? "memo" : "synth")
  const [updatedAt, setUpdatedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const loading = updatedAt === 0

  const [synth, setSynth] = useState<SynthRow[]>([])
  const [memo, setMemo] = useState<MemoRow[]>([])
  const [mem, setMem] = useState<{ size: number; capacity: number } | null>(null)
  const [filter, setFilter] = useState("")

  const reload = useCallback(async () => {
    if (!activeConnectionId) return
    const [s, m, c] = await Promise.all([
      runQuery(activeConnectionId, SYNTH_SQL).then(parseSynth),
      runQuery(activeConnectionId, MEMO_SQL).then(parseMemo),
      runQuery(activeConnectionId, INMEM_SQL).then(parseMem),
    ])
    setError(s.error ?? m.error ?? c.error ?? null)
    setSynth(s.rows)
    setMemo(m.rows)
    setMem(c.row)
    setUpdatedAt(Date.now())
  }, [activeConnectionId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (cancelled) return
      await reload()
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [reload])

  // Run a mutating statement (+ flush), then reload. Errors surface in the banner.
  const mutate = useCallback(
    async (sql: string) => {
      if (!activeConnectionId || busy) return
      setBusy(true)
      const res = await runQuery(activeConnectionId, sql)
      if (!res.ok) {
        setError(res.error)
        setBusy(false)
        return
      }
      await reload()
      setBusy(false)
    },
    [activeConnectionId, busy, reload],
  )

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Database className="h-3.5 w-3.5 text-rvbbit-accent" />
          Cache
        </span>
        {!loading ? (
          <>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">{fmtCount(synth.length)}</span>{" "}
              snippets
            </span>
            <span className="text-chrome-text/40">·</span>
            <span>
              <span className="font-mono tabular-nums text-foreground">{fmtCount(memo.length)}</span>{" "}
              memo entries
            </span>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {mem ? (
            <span
              className="inline-flex items-center gap-1.5 rounded border border-chrome-border bg-secondary-background px-1.5 py-0.5 text-[10px] text-chrome-text/75"
              title="in-memory L1 (LRU) — fronts receipts & scalar synth"
            >
              <span className="uppercase tracking-wider text-chrome-text/45">L1</span>
              <span className="font-mono tabular-nums text-foreground">
                {fmtCount(mem.size)}/{fmtCount(mem.capacity)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void mutate("SELECT rvbbit.flush_cache()")}
                title="Flush in-memory L1 (synth + operator results)"
                className="grid h-4 w-4 place-items-center rounded text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </span>
          ) : null}
          {updatedAt > 0 ? (
            <span className="text-[10px] text-chrome-text/45">{fmtAgo(updatedAt)}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-warning/70 hover:text-warning"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {/* tab bar */}
      <div className="flex items-center gap-px border-b border-chrome-border bg-chrome-bg/20 px-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition",
              tab === t.key
                ? "border-rvbbit-accent text-rvbbit-accent"
                : "border-transparent text-chrome-text/65 hover:text-foreground",
            )}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
            <span className="font-mono text-[9px] normal-case tracking-normal text-chrome-text/40">
              {t.hint}
            </span>
          </button>
        ))}
        <div className="ml-auto flex items-center py-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            className="h-6 w-40 rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground outline-none placeholder:text-chrome-text/40 focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="grid h-full place-items-center text-[11px] text-chrome-text/55">
            loading cache…
          </div>
        ) : tab === "synth" ? (
          <SynthTab rows={synth} filter={filter} busy={busy} mutate={mutate} onOpenOperator={onOpenOperator} />
        ) : (
          <MemoTab rows={memo} filter={filter} busy={busy} mutate={mutate} onOpenOperator={onOpenOperator} />
        )}
      </div>
    </div>
  )
}

// ── Synth tab ───────────────────────────────────────────────────────

function SynthTab({
  rows,
  filter,
  busy,
  mutate,
  onOpenOperator,
}: {
  rows: SynthRow[]
  filter: string
  busy: boolean
  mutate: (sql: string) => Promise<void>
  onOpenOperator?: (name: string) => void
}) {
  const groups = useMemo(() => groupSynth(rows, filter), [rows, filter])

  if (rows.length === 0) {
    return (
      <EmptyHint big label="no synth snippets yet — run a pivot/group/filter/reshape to compile one" />
    )
  }
  if (groups.length === 0) {
    return <EmptyHint big label="no snippets match the filter" />
  }

  return (
    <div className="space-y-3 p-2.5">
      {groups.map((g) => (
        <div key={g.operator} className="space-y-1.5">
          <div className="flex items-center gap-2 px-0.5">
            <button
              type="button"
              onClick={() => onOpenOperator?.(g.operator)}
              className="font-mono text-[12px] font-medium text-rvbbit-accent hover:underline"
              title="open operator flow"
            >
              rvbbit.{g.operator}
            </button>
            <span className="text-[10px] text-chrome-text/50">
              {g.rows.length} snippet{g.rows.length === 1 ? "" : "s"}
              {g.pinned > 0 ? ` · ${g.pinned} pinned` : ""}
            </span>
            <ConfirmButton
              label="forget all"
              icon={Trash2}
              disabled={busy}
              danger
              onConfirm={() =>
                void mutate(
                  `DELETE FROM rvbbit.synth_cache WHERE operator = ${q(g.operator)}; SELECT rvbbit.flush_cache();`,
                )
              }
              className="ml-auto"
            />
          </div>
          <div className="space-y-1.5">
            {g.rows.map((r) => (
              <SynthCard key={`${r.operator}::${r.shape}::${r.promptHash}`} row={r} busy={busy} mutate={mutate} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function SynthCard({
  row,
  busy,
  mutate,
}: {
  row: SynthRow
  busy: boolean
  mutate: (sql: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.generatedSql)

  const where = `operator = ${q(row.operator)} AND shape_fingerprint = ${q(row.shape)} AND prompt_hash = ${q(row.promptHash)}`

  const save = () => {
    if (draft.trim() === row.generatedSql.trim()) {
      setEditing(false)
      return
    }
    void mutate(
      `UPDATE rvbbit.synth_cache SET generated_sql = ${q(draft.trim())}, status = 'edited', updated_at = clock_timestamp() WHERE ${where}; SELECT rvbbit.flush_cache();`,
    ).then(() => setEditing(false))
  }

  return (
    <div
      className={cn(
        "rounded-md border bg-secondary-background/40 p-2",
        row.pinned ? "border-rvbbit-accent/40" : "border-chrome-border/60",
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Hash className="h-3 w-3 text-chrome-text/45" />
        <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-foreground">
          {row.shape}
        </span>
        <StatusBadge status={row.status} pinned={row.pinned} />
        <span className="font-mono text-[9px] text-chrome-text/35" title="prompt hash">
          {row.promptHash.slice(0, 8)}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconBtn
            icon={Lock}
            title={row.pinned ? "Unpin (allow recompile)" : "Pin (freeze this snippet)"}
            active={row.pinned}
            disabled={busy}
            onClick={() =>
              void mutate(
                `UPDATE rvbbit.synth_cache SET pinned = ${row.pinned ? "false" : "true"}, updated_at = clock_timestamp() WHERE ${where}; SELECT rvbbit.flush_cache();`,
              )
            }
          />
          <IconBtn
            icon={editing ? X : Pencil}
            title={editing ? "Cancel edit" : "Edit generated SQL"}
            disabled={busy}
            onClick={() => {
              setDraft(row.generatedSql)
              setEditing((e) => !e)
            }}
          />
          <ConfirmButton
            icon={Trash2}
            disabled={busy}
            danger
            onConfirm={() =>
              void mutate(`DELETE FROM rvbbit.synth_cache WHERE ${where}; SELECT rvbbit.flush_cache();`)
            }
          />
        </span>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            className="w-full resize-y rounded border border-chrome-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="inline-flex items-center gap-1 rounded bg-rvbbit-accent/15 px-2 py-1 text-[11px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
            >
              <Save className="h-3 w-3" /> Save
            </button>
            <span className="text-[10px] text-chrome-text/45">
              saving marks status <span className="font-mono">edited</span> &amp; flushes L1
            </span>
          </div>
        </div>
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90">
          {row.generatedSql}
        </pre>
      )}
    </div>
  )
}

// ── Memo tab ────────────────────────────────────────────────────────

function MemoTab({
  rows,
  filter,
  busy,
  mutate,
  onOpenOperator,
}: {
  rows: MemoRow[]
  filter: string
  busy: boolean
  mutate: (sql: string) => Promise<void>
  onOpenOperator?: (name: string) => void
}) {
  const groups = useMemo(() => groupMemo(rows, filter), [rows, filter])

  if (rows.length === 0) {
    return <EmptyHint big label="no cached operator results yet" />
  }
  if (groups.length === 0) {
    return <EmptyHint big label="no entries match the filter" />
  }

  return (
    <div className="space-y-3 p-2.5">
      {groups.map((g) => (
        <div key={g.operator} className="space-y-1">
          <div className="flex items-center gap-2 px-0.5">
            <button
              type="button"
              onClick={() => onOpenOperator?.(g.operator)}
              className="font-mono text-[12px] font-medium text-rvbbit-accent hover:underline"
              title="open operator flow"
            >
              rvbbit.{g.operator}
            </button>
            <span className="text-[10px] text-chrome-text/50">
              {g.rows.length} entr{g.rows.length === 1 ? "y" : "ies"} · {fmtCount(g.hits)} hits
            </span>
            <ConfirmButton
              label="purge"
              icon={Trash2}
              disabled={busy}
              danger
              onConfirm={() => void mutate(`SELECT rvbbit.judgment_purge(${q(g.operator)})`)}
              className="ml-auto"
            />
          </div>
          <table className="w-full table-fixed text-[11px]">
            <thead className="text-[9px] uppercase tracking-wider text-chrome-text/45">
              <tr>
                <th className="w-[40%] px-2 py-1 text-left font-medium">inputs</th>
                <th className="px-2 py-1 text-left font-medium">output</th>
                <th className="w-16 px-2 py-1 text-right font-medium">hits</th>
                <th className="w-20 px-2 py-1 text-right font-medium">last</th>
                <th className="w-8 px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr
                  key={`${r.operator}::${r.hash}`}
                  className="border-t border-chrome-border/30 align-top hover:bg-foreground/[0.03]"
                >
                  <td className="px-2 py-1 font-mono text-chrome-text/75" title={r.inputs}>
                    <div className="line-clamp-2 break-words">{r.inputs || "—"}</div>
                  </td>
                  <td className="px-2 py-1 font-mono text-foreground/90" title={r.output}>
                    <div className="line-clamp-2 break-words">{r.output || "—"}</div>
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                    {fmtCount(r.hits)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-chrome-text/65">
                    {r.lastAt ? fmtAgo(r.lastAt) : "—"}
                  </td>
                  <td className="px-1 py-1 text-right">
                    <ConfirmButton
                      icon={Trash2}
                      disabled={busy}
                      danger
                      onConfirm={() =>
                        void mutate(
                          `DELETE FROM rvbbit.receipts WHERE operator = ${q(r.operator)} AND inputs_hash = decode(${q(r.hash)}, 'hex'); SELECT rvbbit.flush_cache();`,
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────

function StatusBadge({ status, pinned }: { status: string; pinned: boolean }) {
  const tone = pinned
    ? "bg-rvbbit-accent/15 text-rvbbit-accent"
    : status === "valid"
      ? "bg-success/10 text-success"
      : status === "edited"
        ? "bg-chart-3/15 text-chart-3"
        : "bg-foreground/[0.06] text-chrome-text/65"
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider", tone)}>
      {pinned ? <Lock className="h-2.5 w-2.5" /> : null}
      {pinned ? "pinned" : status}
    </span>
  )
}

function IconBtn({
  icon: Icon,
  title,
  onClick,
  disabled,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-6 w-6 place-items-center rounded transition disabled:opacity-40",
        active
          ? "text-rvbbit-accent hover:bg-rvbbit-accent/10"
          : "text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

/** A two-step destructive button: first click arms (shows ✓/✗), second confirms. */
function ConfirmButton({
  icon: Icon,
  label,
  onConfirm,
  disabled,
  danger,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  label?: string
  onConfirm: () => void
  disabled?: boolean
  danger?: boolean
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  if (armed) {
    return (
      <span className={cn("inline-flex items-center gap-0.5", className)}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setArmed(false)
            onConfirm()
          }}
          title="Confirm"
          className="grid h-6 w-6 place-items-center rounded bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          title="Cancel"
          className="grid h-6 w-6 place-items-center rounded text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setArmed(true)}
      title={label ?? "Delete"}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] transition disabled:opacity-40",
        danger
          ? "text-chrome-text/55 hover:bg-danger/10 hover:text-danger"
          : "text-chrome-text/65 hover:bg-foreground/[0.08] hover:text-foreground",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label ? <span className="uppercase tracking-wider">{label}</span> : null}
    </button>
  )
}

function EmptyHint({ label, big }: { label: string; big?: boolean }) {
  return (
    <div
      className={cn(
        "grid place-items-center px-6 text-center text-[11px] text-chrome-text/45",
        big ? "h-full" : "h-16",
      )}
    >
      {label}
    </div>
  )
}

// ── grouping ────────────────────────────────────────────────────────

function groupSynth(rows: SynthRow[], filter: string) {
  const f = filter.trim().toLowerCase()
  const kept = f
    ? rows.filter(
        (r) =>
          r.operator.toLowerCase().includes(f) ||
          r.shape.toLowerCase().includes(f) ||
          r.generatedSql.toLowerCase().includes(f),
      )
    : rows
  const m = new Map<string, { operator: string; rows: SynthRow[]; pinned: number }>()
  for (const r of kept) {
    const g = m.get(r.operator) ?? { operator: r.operator, rows: [], pinned: 0 }
    g.rows.push(r)
    if (r.pinned) g.pinned += 1
    m.set(r.operator, g)
  }
  return [...m.values()].sort((a, b) => a.operator.localeCompare(b.operator))
}

function groupMemo(rows: MemoRow[], filter: string) {
  const f = filter.trim().toLowerCase()
  const kept = f
    ? rows.filter(
        (r) =>
          r.operator.toLowerCase().includes(f) ||
          r.inputs.toLowerCase().includes(f) ||
          r.output.toLowerCase().includes(f),
      )
    : rows
  const m = new Map<string, { operator: string; rows: MemoRow[]; hits: number }>()
  for (const r of kept) {
    const g = m.get(r.operator) ?? { operator: r.operator, rows: [], hits: 0 }
    g.rows.push(r)
    g.hits += r.hits
    m.set(r.operator, g)
  }
  return [...m.values()].sort((a, b) => b.hits - a.hits || a.operator.localeCompare(b.operator))
}

// ── SQL ─────────────────────────────────────────────────────────────

/** Postgres single-quoted literal with quote-doubling (the query API has no params). */
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

const SYNTH_SQL = `SELECT operator, shape_fingerprint, prompt_hash, generated_sql,
       status, pinned, updated_at
FROM rvbbit.synth_cache
ORDER BY operator, pinned DESC, updated_at DESC`

const MEMO_SQL = `SELECT operator,
       encode(inputs_hash, 'hex')                            AS hash,
       (array_agg(model  ORDER BY invocation_at DESC))[1]    AS model,
       (array_agg(inputs ORDER BY invocation_at DESC))[1]    AS inputs,
       (array_agg(output ORDER BY invocation_at DESC))[1]    AS output,
       count(*)::int                                         AS hits,
       max(invocation_at)                                    AS last_at
FROM rvbbit.receipts
WHERE error IS NULL
GROUP BY operator, inputs_hash
ORDER BY count(*) DESC, max(invocation_at) DESC
LIMIT 500`

const INMEM_SQL = `SELECT rvbbit.cache_size() AS size, rvbbit.cache_capacity() AS capacity`

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 1000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function epoch(v: unknown): number | null {
  if (v == null) return null
  const t = new Date(String(v)).getTime()
  return Number.isFinite(t) ? t : null
}
function asText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function parseSynth(res: QueryOk | QueryErr): { rows: SynthRow[]; error: string | null } {
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      operator: String(r.operator ?? ""),
      shape: String(r.shape_fingerprint ?? ""),
      promptHash: String(r.prompt_hash ?? ""),
      generatedSql: String(r.generated_sql ?? ""),
      status: String(r.status ?? ""),
      pinned: r.pinned === true || r.pinned === "t",
      updatedAt: epoch(r.updated_at),
    })),
  }
}

function parseMemo(res: QueryOk | QueryErr): { rows: MemoRow[]; error: string | null } {
  if (!res.ok) return { rows: [], error: res.error }
  return {
    error: null,
    rows: res.rows.map((r) => ({
      operator: String(r.operator ?? ""),
      hash: String(r.hash ?? ""),
      model: r.model == null ? null : String(r.model),
      inputs: asText(r.inputs),
      output: asText(r.output),
      hits: num(r.hits),
      lastAt: epoch(r.last_at),
    })),
  }
}

function parseMem(
  res: QueryOk | QueryErr,
): { row: { size: number; capacity: number } | null; error: string | null } {
  if (!res.ok) return { row: null, error: res.error }
  const r = res.rows[0]
  if (!r) return { row: null, error: null }
  return { row: { size: num(r.size), capacity: num(r.capacity) }, error: null }
}
