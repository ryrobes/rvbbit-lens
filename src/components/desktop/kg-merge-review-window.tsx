"use client"

import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  Brain,
  RefreshCw,
  TreeStructure,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo } from "./instruments"
import {
  acceptMerge,
  fetchMergeCandidates,
  rejectMerge,
  suggestMerges,
  type KgMergeCandidate,
} from "@/lib/rvbbit/kg"
import type { KgEntitySource, KgMergeReviewPayload } from "@/lib/desktop/types"

interface KgMergeReviewWindowProps {
  payload: KgMergeReviewPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSpecialist: (name: string) => void
  onOpenEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
}

type StatusFilter = "pending" | "accepted" | "rejected" | "all"

export function KgMergeReviewWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenSpecialist,
  onOpenEntity,
}: KgMergeReviewWindowProps) {
  const [graphFilter, setGraphFilter] = useState<string | null>(payload.graphId ?? null)
  const [kind, setKind] = useState<string>(payload.nodeKindFilter ?? "")
  const [status, setStatus] = useState<StatusFilter>("pending")
  const [threshold, setThreshold] = useState<number>(0.86)
  const [candidates, setCandidates] = useState<KgMergeCandidate[]>([])
  const [cursor, setCursor] = useState<number>(0)
  const [preferredWinner, setPreferredWinner] = useState<"auto" | "left" | "right">("auto")
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState(0)
  const loading = updatedAt === 0
  const current = candidates[cursor] ?? null

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const run = async () => {
      const rows = await fetchMergeCandidates(
        activeConnectionId,
        graphFilter,
        status,
        kind || null,
        200,
      )
      if (cancelled) return
      setCandidates(rows)
      setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)))
      setUpdatedAt(Date.now())
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, graphFilter, status, kind])

  // Reset preferred winner when cursor changes — using the "calculate
  // state during render" pattern instead of an effect to avoid the
  // cascading-render warning.
  const [prevCursor, setPrevCursor] = useState(cursor)
  if (prevCursor !== cursor) {
    setPrevCursor(cursor)
    setPreferredWinner("auto")
  }

  const advance = useCallback(() => {
    setCursor((c) => Math.min(candidates.length - 1, c + 1))
  }, [candidates.length])

  const doAccept = useCallback(async () => {
    if (!activeConnectionId || !current || busy) return
    setBusy(true)
    setError(null)
    const winner =
      preferredWinner === "left"
        ? current.leftNodeId
        : preferredWinner === "right"
          ? current.rightNodeId
          : null
    const r = await acceptMerge(activeConnectionId, current.candidateId, winner)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? "accept failed")
      return
    }
    setToast(`accepted #${current.candidateId}`)
    // Optimistically remove from list, advance cursor stays at same index
    setCandidates((rows) => rows.filter((c) => c.candidateId !== current.candidateId))
    setCursor((c) => Math.min(c, candidates.length - 2))
  }, [activeConnectionId, current, preferredWinner, busy, candidates.length])

  const doReject = useCallback(async () => {
    if (!activeConnectionId || !current || busy) return
    setBusy(true)
    setError(null)
    const r = await rejectMerge(activeConnectionId, current.candidateId)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? "reject failed")
      return
    }
    setToast(`rejected #${current.candidateId}`)
    setCandidates((rows) => rows.filter((c) => c.candidateId !== current.candidateId))
    setCursor((c) => Math.min(c, candidates.length - 2))
  }, [activeConnectionId, current, busy, candidates.length])

  const doSuggest = useCallback(async () => {
    if (!activeConnectionId || !kind.trim()) {
      setError("Pick a kind before suggesting.")
      return
    }
    setBusy(true)
    setError(null)
    const r = await suggestMerges(activeConnectionId, graphFilter, kind.trim(), threshold, 100)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? "suggest failed")
      return
    }
    setToast("regenerated candidates")
    // Trigger reload.
    setUpdatedAt(0)
    const rows = await fetchMergeCandidates(activeConnectionId, graphFilter, status, kind || null, 200)
    setCandidates(rows)
    setCursor(0)
    setUpdatedAt(Date.now())
  }, [activeConnectionId, kind, graphFilter, threshold, status])

  // Clear toast after a beat.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1500)
    return () => clearTimeout(t)
  }, [toast])

  // Keyboard nav — placed after doAccept/doReject/advance so their refs exist.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!current) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setCursor((c) => Math.min(candidates.length - 1, c + 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setCursor((c) => Math.max(0, c - 1))
      } else if (e.key === "1") {
        setPreferredWinner("left")
      } else if (e.key === "2") {
        setPreferredWinner("right")
      } else if (e.key === "a") {
        e.preventDefault()
        void doAccept()
      } else if (e.key === "r") {
        e.preventDefault()
        void doReject()
      } else if (e.key === "s") {
        e.preventDefault()
        advance()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [current, candidates.length, advance, doAccept, doReject])

  if (!hasRvbbit) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-chrome-text">
        The active connection has no <code>pg_rvbbit</code> extension installed.
      </div>
    )
  }

  const distinctGraphs = Array.from(new Set(candidates.map((c) => c.graphId))).sort()

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b border-chrome-border/60 bg-secondary-background/40 px-3 py-2">
        <Brain
          className="h-3.5 w-3.5"
          style={{ color: "var(--brand-kg)" }}
        />
        <span className="text-[11px] uppercase tracking-wider text-chrome-text">
          Merge Review
        </span>

        <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
          <span>graph:</span>
          <select
            value={graphFilter ?? ""}
            onChange={(e) => setGraphFilter(e.target.value || null)}
            className="bg-transparent font-mono text-[11px] focus:outline-none"
          >
            <option value="">all</option>
            {distinctGraphs.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
          <span>kind:</span>
          <input
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            placeholder="e.g. customer"
            className="w-24 bg-transparent font-mono text-[11px] text-foreground placeholder:text-chrome-text/40 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums">
          <span>status:</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="bg-transparent text-[11px] focus:outline-none"
          >
            <option value="pending">pending</option>
            <option value="accepted">accepted</option>
            <option value="rejected">rejected</option>
            <option value="all">all</option>
          </select>
        </div>

        <div
          className="flex items-center gap-1.5 rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[11px] tabular-nums"
          title="Similarity threshold for kg_suggest_merges"
        >
          <span>thresh:</span>
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="w-20"
          />
          <span className="font-mono">{threshold.toFixed(2)}</span>
        </div>

        <button
          type="button"
          onClick={() => void doSuggest()}
          disabled={busy || !kind.trim()}
          className="rounded border border-chrome-border/60 px-2 py-0.5 text-[11px] hover:border-chrome-border hover:bg-foreground/[0.06] disabled:opacity-50"
          title="Regenerate candidates for this kind via rvbbit.kg_suggest_merges"
        >
          suggest
        </button>

        <span className="ml-auto flex items-center gap-2 text-[10px] tabular-nums text-chrome-text/60">
          {loading ? "loading…" : updatedAt ? `updated ${fmtAgo(updatedAt)}` : "—"}
          <button
            type="button"
            onClick={() => setUpdatedAt(0)}
            className="rounded p-1 text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </span>
      </header>

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      ) : null}
      {toast ? (
        <div className="border-b border-success/30 bg-success/10 px-3 py-1.5 text-[11px] text-success">
          {toast}
        </div>
      ) : null}

      {/* Cursor strip */}
      <div className="flex items-center gap-2 border-b border-chrome-border/40 bg-secondary-background/20 px-3 py-1 text-[10px] tabular-nums text-chrome-text/70">
        <span>
          {candidates.length === 0
            ? "no candidates"
            : `${cursor + 1} / ${candidates.length}`}
        </span>
        <span className="ml-auto italic text-chrome-text/50">
          j/k or arrows · 1/2 prefer winner · a accept · r reject · s skip
        </span>
      </div>

      {!current ? (
        <div className="flex flex-1 items-center justify-center text-center text-[11px] italic text-chrome-text/55">
          {status === "pending"
            ? 'No pending candidates. Pick a kind and click "suggest" above.'
            : `No ${status} candidates.`}
        </div>
      ) : (
        <CandidateView
          candidate={current}
          preferredWinner={preferredWinner}
          onSetPreferredWinner={setPreferredWinner}
          onAccept={() => void doAccept()}
          onReject={() => void doReject()}
          onSkip={advance}
          onOpenSpecialist={onOpenSpecialist}
          onOpenEntity={onOpenEntity}
          busy={busy}
        />
      )}
    </div>
  )
}

// ── Candidate side-by-side ──────────────────────────────────────────

function CandidateView({
  candidate,
  preferredWinner,
  onSetPreferredWinner,
  onAccept,
  onReject,
  onSkip,
  onOpenSpecialist,
  onOpenEntity,
  busy,
}: {
  candidate: KgMergeCandidate
  preferredWinner: "auto" | "left" | "right"
  onSetPreferredWinner: (v: "auto" | "left" | "right") => void
  onAccept: () => void
  onReject: () => void
  onSkip: () => void
  onOpenSpecialist: (name: string) => void
  onOpenEntity: (
    entityKind: string,
    entityLabel: string,
    graphId: string,
    source?: KgEntitySource,
    nodeId?: number | null,
  ) => void
  busy: boolean
}) {
  const isEmbedding = (candidate.method ?? "").toLowerCase().includes("embed")
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      {/* Meta strip */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-chrome-border/40 bg-secondary-background/30 px-3 py-2 text-[11px]">
        <span className="font-mono text-foreground">candidate #{candidate.candidateId}</span>
        <KindBadge kind={candidate.kind} />
        <span className="rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] tabular-nums">
          graph: <span className="font-mono">{candidate.graphId}</span>
        </span>
        <span className="rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] tabular-nums">
          score: <span className="font-mono">{candidate.score?.toFixed(3) ?? "—"}</span>
        </span>
        {candidate.method ? (
          <span className="rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] tabular-nums">
            method: <span className="font-mono">{candidate.method}</span>
          </span>
        ) : null}
        {isEmbedding ? (
          <button
            type="button"
            onClick={() => onOpenSpecialist("embed")}
            className="flex items-center gap-1 rounded border border-chrome-border/60 px-1.5 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
            style={{ color: "var(--brand-specialists)" }}
            title="Open the embed backend (used to produce these candidates)"
          >
            <Brain className="h-3 w-3" />
            embed
          </button>
        ) : null}
        <span className="ml-auto text-[10px] tabular-nums text-chrome-text/55">
          {candidate.createdAt ? fmtAgo(candidate.createdAt) : "—"}
        </span>
      </div>
      {candidate.reason ? (
        <div className="mb-3 rounded border border-chrome-border/40 bg-doc-bg/40 px-3 py-2 text-[11px] italic text-chrome-text/80">
          {candidate.reason}
        </div>
      ) : null}

      {/* Side-by-side */}
      <div className="grid grid-cols-2 gap-3">
        <CandidateCard
          side="left"
          nodeId={candidate.leftNodeId}
          label={candidate.leftLabel}
          confidence={candidate.leftConfidence}
          properties={candidate.leftProperties}
          preferred={preferredWinner === "left"}
          onSelectWinner={() => onSetPreferredWinner("left")}
          onOpenNode={() =>
            onOpenEntity(
              candidate.kind,
              candidate.leftLabel,
              candidate.graphId,
              { kind: "browser", graphId: candidate.graphId, label: `Merge · #${candidate.candidateId}` },
              candidate.leftNodeId,
            )
          }
        />
        <CandidateCard
          side="right"
          nodeId={candidate.rightNodeId}
          label={candidate.rightLabel}
          confidence={candidate.rightConfidence}
          properties={candidate.rightProperties}
          preferred={preferredWinner === "right"}
          onSelectWinner={() => onSetPreferredWinner("right")}
          onOpenNode={() =>
            onOpenEntity(
              candidate.kind,
              candidate.rightLabel,
              candidate.graphId,
              { kind: "browser", graphId: candidate.graphId, label: `Merge · #${candidate.candidateId}` },
              candidate.rightNodeId,
            )
          }
        />
      </div>

      {/* Action bar */}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">
          winner:
        </span>
        <label className="flex items-center gap-1 text-[11px] text-chrome-text">
          <input
            type="radio"
            checked={preferredWinner === "auto"}
            onChange={() => onSetPreferredWinner("auto")}
          />
          auto
        </label>
        <label className="flex items-center gap-1 text-[11px] text-chrome-text">
          <input
            type="radio"
            checked={preferredWinner === "left"}
            onChange={() => onSetPreferredWinner("left")}
          />
          left
        </label>
        <label className="flex items-center gap-1 text-[11px] text-chrome-text">
          <input
            type="radio"
            checked={preferredWinner === "right"}
            onChange={() => onSetPreferredWinner("right")}
          />
          right
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="rounded border border-chrome-border/60 px-3 py-1 text-[11px] hover:border-chrome-border hover:bg-foreground/[0.06] disabled:opacity-50"
          >
            skip (s)
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-3 py-1 text-[11px] text-danger hover:bg-danger/15 disabled:opacity-50"
          >
            <AlertTriangle className="h-3 w-3" />
            reject (r)
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-success/40 bg-success/10 px-3 py-1 text-[11px] text-success hover:bg-success/15 disabled:opacity-50"
          >
            <TreeStructure className="h-3 w-3" />
            accept (a)
          </button>
        </div>
      </div>
    </div>
  )
}

function CandidateCard({
  side,
  nodeId,
  label,
  confidence,
  properties,
  preferred,
  onSelectWinner,
  onOpenNode,
}: {
  side: "left" | "right"
  nodeId: number
  label: string
  confidence: number | null
  properties: unknown
  preferred: boolean
  onSelectWinner: () => void
  onOpenNode: () => void
}) {
  const propsObj =
    properties && typeof properties === "object" ? (properties as Record<string, unknown>) : null
  const propKeys = propsObj ? Object.keys(propsObj) : []
  return (
    <div
      className={cn(
        "flex flex-col rounded-md border bg-background p-3",
        preferred ? "border-success/60" : "border-chrome-border/60",
      )}
      style={preferred ? { boxShadow: "0 0 0 1px var(--success) inset" } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">
          {side} · node {nodeId}
        </span>
        <button
          type="button"
          onClick={onSelectWinner}
          className="ml-auto rounded border border-chrome-border/60 px-2 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
          title={`Prefer this node as winner (${side === "left" ? "1" : "2"})`}
        >
          prefer ({side === "left" ? "1" : "2"})
        </button>
      </div>
      <button
        type="button"
        onClick={onOpenNode}
        className="text-left font-mono text-[14px] text-foreground hover:text-rvbbit-accent"
        title="Open entity detail"
      >
        {label}
      </button>
      <div className="mt-1 flex items-center gap-3 text-[10px] tabular-nums text-chrome-text/60">
        <span>conf {confidence != null ? confidence.toFixed(2) : "—"}</span>
      </div>
      {propKeys.length > 0 ? (
        <details className="mt-2 rounded border border-chrome-border/40 bg-doc-bg/40 p-2 text-[10px]">
          <summary className="cursor-pointer text-chrome-text/70">
            properties · {propKeys.length}
          </summary>
          <pre className="mt-2 overflow-auto font-mono leading-tight text-foreground/80">
            {JSON.stringify(propsObj, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        background: "color-mix(in oklch, var(--brand-kg) 18%, transparent)",
        color: "var(--brand-kg)",
      }}
    >
      {kind}
    </span>
  )
}
