"use client"

// ⊟ Cube Proposals — the review inbox for agent-drafted cubes. The MCP `propose_cube` tool logs
// every draft to rvbbit.proposals; here a human triages them: review the subject, lineage,
// confidence and the (editable) join SQL, then Accept (→ define_cube, opens the Inspector),
// Accept & Enrich (+ LLM column docs), or Reject. Generic over kind so metric proposals slot in.

import { useCallback, useEffect, useMemo, useState } from "react"
import { RefreshCw, Loader2, Check, X, Sparkles, GitBranch, Package, Play, Save, Trash2 } from "@/lib/icons"
import {
  acceptProposal,
  listProposals,
  refineProposal,
  rejectProposal,
  withdrawProposal,
  type CubeProposal,
} from "@/lib/rvbbit/cubes"
import { previewMetricSql } from "@/lib/rvbbit/metrics"
import { SqlEditor } from "./sql-editor"
import { areaCls, Field, fmtTime, inputCls, Section, StatusNote } from "./cube-shared"

interface Props {
  activeConnectionId: string | null
  hasRvbbit: boolean
  /** open the created CUBE after accepting a cube proposal */
  onOpenInspector?: (name: string) => void
  /** open the created METRIC after accepting a metric proposal */
  onOpenMetricInspector?: (name: string) => void
  /** pop the proposal's SQL out into a native SQL window for testing */
  onOpenSql?: (sql: string, title: string) => void
}

type Filter = "pending" | "accepted" | "rejected" | "all"
const FILTERS: Filter[] = ["pending", "accepted", "rejected", "all"]

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "pending"
      ? "bg-amber-500"
      : status === "accepted"
        ? "bg-emerald-500"
        : status === "rejected"
          ? "bg-danger"
          : "bg-foreground/30"
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} title={status} />
}

function KindChip({ kind }: { kind: string }) {
  const isMetric = kind === "metric"
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide ${
        isMetric ? "border-sky-500/40 bg-sky-500/10 text-sky-500" : "border-main/40 bg-main/10 text-main"
      }`}
    >
      {kind}
    </span>
  )
}

export function CubeProposalsWindow({ activeConnectionId, hasRvbbit, onOpenInspector, onOpenMetricInspector, onOpenSql }: Props) {
  const [proposals, setProposals] = useState<CubeProposal[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("pending")
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const id = setTimeout(() => {
      void (async () => {
        const { proposals: rows, error: err } = await listProposals(activeConnectionId)
        if (cancelled) return
        setProposals(rows)
        setError(err)
        setSelectedId((cur) => cur ?? rows.find((p) => p.status === "pending")?.proposalId ?? rows[0]?.proposalId ?? null)
      })()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [activeConnectionId, hasRvbbit, reloadKey])

  const filtered = useMemo(() => {
    const all = proposals ?? []
    return filter === "all" ? all : all.filter((p) => p.status === filter)
  }, [proposals, filter])

  const pendingCount = useMemo(() => (proposals ?? []).filter((p) => p.status === "pending").length, [proposals])
  const selected = useMemo(() => (proposals ?? []).find((p) => p.proposalId === selectedId) ?? null, [proposals, selectedId])

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px]">
        <Package className="h-3.5 w-3.5 text-main" />
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--syntax-keyword)" }}>
          Proposals
        </span>
        {pendingCount > 0 ? (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-500">
            {pendingCount} pending
          </span>
        ) : null}
        <div className="ml-2 flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-[3px] px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                filter === f ? "bg-main/15 text-main" : "text-chrome-text/55 hover:bg-foreground/[0.05] hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={reload}
          title="Refresh"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-chrome-border/60 text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {error ? <StatusNote state="error" message={error} className="border-b border-danger/30" /> : null}

      <div className="flex min-h-0 flex-1">
        {/* LEFT — list */}
        <div className="w-60 shrink-0 overflow-y-auto border-r border-chrome-border/50">
          {proposals == null ? (
            <StatusNote state="loading" />
          ) : filtered.length === 0 ? (
            <StatusNote state="empty" message={filter === "pending" ? "No proposals waiting. The agent's propose_cube drafts land here." : `No ${filter} proposals.`} />
          ) : (
            <div className="py-1">
              {filtered.map((p) => (
                <button
                  key={p.proposalId}
                  type="button"
                  onClick={() => setSelectedId(p.proposalId)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                    selectedId === p.proposalId ? "bg-main/10" : "hover:bg-foreground/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={p.status} />
                    <span className={`truncate font-mono text-[12px] ${selectedId === p.proposalId ? "text-main" : "text-foreground"}`}>
                      {p.name ?? `#${p.proposalId}`}
                    </span>
                    <div className="flex-1" />
                    <KindChip kind={p.kind} />
                    {p.confidence != null ? (
                      <span className="shrink-0 tabular-nums text-[10px] text-chrome-text/45">{p.confidence.toFixed(2)}</span>
                    ) : null}
                  </div>
                  <span className="truncate text-[10px] text-chrome-text/45" title={p.subject ?? undefined}>
                    {p.subject ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — detail */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <ProposalDetail
              key={selected.proposalId}
              connectionId={activeConnectionId}
              proposal={selected}
              onReload={reload}
              onOpenInspector={onOpenInspector}
              onOpenMetricInspector={onOpenMetricInspector}
              onOpenSql={onOpenSql}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <StatusNote state="empty" message="Select a proposal." />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProposalDetail({
  connectionId,
  proposal,
  onReload,
  onOpenInspector,
  onOpenMetricInspector,
  onOpenSql,
}: {
  connectionId: string
  proposal: CubeProposal
  onReload: () => void
  onOpenInspector?: (name: string) => void
  onOpenMetricInspector?: (name: string) => void
  onOpenSql?: (sql: string, title: string) => void
}) {
  const isPending = proposal.status === "pending"
  const isMetric = proposal.kind === "metric"

  // Pop the proposal's SQL into a native SQL window to run + inspect. Metrics carry {param}
  // tokens, so resolve them with the draft's default params first (falls back to raw on error).
  async function openInSql() {
    const title = `${proposal.kind}: ${name || proposal.name || "draft"}`
    if (isMetric) {
      const { sql: resolved } = await previewMetricSql(connectionId, sql, proposal.params ?? {})
      onOpenSql?.(resolved && resolved.trim() ? resolved : sql, title)
    } else {
      onOpenSql?.(sql, title)
    }
  }
  const [name, setName] = useState(proposal.name ?? "")
  const [sql, setSql] = useState(proposal.sql)
  const [grain, setGrain] = useState(proposal.grain ?? "")
  const [description, setDescription] = useState(proposal.description ?? "")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function accept(enrich: boolean) {
    if (!name.trim()) {
      setMsg(`A ${proposal.kind} name is required.`)
      return
    }
    setBusy(enrich ? "enrich" : "accept")
    setMsg(null)
    const { name: created, kind, error } = await acceptProposal(connectionId, proposal.proposalId, {
      name: name.trim(),
      sql,
      grain: grain.trim() || null,
      description: description.trim() || null,
      enrich,
    })
    setBusy(null)
    if (error) {
      setMsg(`Accept failed: ${error}`)
      return
    }
    onReload()
    if (created) {
      if (kind === "metric") onOpenMetricInspector?.(created)
      else onOpenInspector?.(created)
    }
  }

  async function reject() {
    setBusy("reject")
    setMsg(null)
    const { ok, error } = await rejectProposal(connectionId, proposal.proposalId, note.trim() || null)
    setBusy(null)
    if (!ok) {
      setMsg(`Reject failed: ${error}`)
      return
    }
    onReload()
  }

  async function saveEdits() {
    setBusy("save")
    setMsg(null)
    const { ok, error } = await refineProposal(connectionId, proposal.proposalId, {
      name: name.trim() || null,
      sql,
      grain: grain.trim() || null,
      description: description.trim() || null,
    })
    setBusy(null)
    setMsg(ok ? "Edits saved to the draft." : `Save failed: ${error}`)
    if (ok) onReload()
  }

  async function withdraw() {
    setBusy("withdraw")
    setMsg(null)
    const { ok, error } = await withdrawProposal(connectionId, proposal.proposalId, note.trim() || null)
    setBusy(null)
    if (!ok) {
      setMsg(`Withdraw failed: ${error}`)
      return
    }
    onReload()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border/50 px-3 py-2">
        <StatusDot status={proposal.status} />
        <span className="text-[12px] uppercase tracking-wide text-chrome-text/70">{proposal.status}</span>
        <KindChip kind={proposal.kind} />
        <span className="text-[10px] text-chrome-text/40">
          {proposal.proposedBy ?? "—"}
          {proposal.proposedVia ? ` · ${proposal.proposedVia}` : ""} · {fmtTime(proposal.createdAt ? Date.parse(proposal.createdAt) : null)}
        </span>
        <div className="flex-1" />
        {proposal.confidence != null ? (
          <span className="tabular-nums text-[11px] text-chrome-text/60">confidence {proposal.confidence.toFixed(2)}</span>
        ) : null}
        {proposal.resultName ? (
          <button
            type="button"
            onClick={() => onOpenInspector?.(proposal.resultName as string)}
            className="font-mono text-[11px] text-main hover:underline"
          >
            → {proposal.resultName}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Section title="Subject">
          <div className="text-[12px] text-foreground/90">{proposal.subject ?? <span className="text-chrome-text/35">—</span>}</div>
          {proposal.joinRationale ? (
            <div className="mt-1 text-[11px] italic text-chrome-text/55">{proposal.joinRationale}</div>
          ) : null}
        </Section>

        {proposal.sourceTables.length ? (
          <Section title="Reads from">
            <div className="flex flex-wrap gap-1.5">
              {proposal.sourceTables.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02] px-1.5 py-0.5 font-mono text-[11px] text-chrome-text/75">
                  <GitBranch className="h-2.5 w-2.5 text-chrome-text/45" />
                  {t}
                </span>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title={isPending ? "Review & edit before blessing" : "Definition"}>
          <Field label={isMetric ? "Metric name" : "Cube name"}>
            <input className={inputCls} value={name} disabled={!isPending} onChange={(e) => setName(e.target.value)} placeholder={isMetric ? "metric_name" : "cube_name"} />
          </Field>
          <div className="flex gap-2">
            <Field label="Grain">
              <input className={inputCls} value={grain} disabled={!isPending} onChange={(e) => setGrain(e.target.value)} placeholder="one row per …" />
            </Field>
          </div>
          <Field label="Description">
            <textarea className={`${areaCls} h-12`} value={description} disabled={!isPending} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="SQL">
            <div className="h-56 overflow-hidden rounded-[3px] border border-chrome-border/40">
              <SqlEditor value={sql} onChange={setSql} readOnly={!isPending} wrap height="100%" />
            </div>
            {onOpenSql ? (
              <button
                type="button"
                onClick={() => void openInSql()}
                title="Run & inspect this SQL in a native SQL window"
                className="mt-1 inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Play className="h-2.5 w-2.5" /> Open in SQL{isMetric ? " (params resolved)" : ""}
              </button>
            ) : null}
          </Field>
          {isMetric && Object.keys(proposal.params).length > 0 ? (
            <Field label="Default params">
              <pre className="overflow-auto rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02] p-2 font-mono text-[10px] text-chrome-text/75">
                {JSON.stringify(proposal.params, null, 2)}
              </pre>
            </Field>
          ) : null}
          {isMetric && proposal.checkSql ? (
            <Field label="KPI check">
              <pre className="overflow-auto rounded-[3px] border border-emerald-500/20 bg-emerald-500/[0.04] p-2 font-mono text-[10px] text-chrome-text/80">
                {proposal.checkSql}
              </pre>
            </Field>
          ) : null}
        </Section>

        {proposal.notes ? (
          <Section title="Reviewer note">
            <div className="text-[11px] text-chrome-text/60">{proposal.notes}</div>
          </Section>
        ) : null}
      </div>

      {msg ? (
        <div className="border-t border-chrome-border/30 bg-foreground/[0.02] px-3 py-1 text-[11px] text-chrome-text/70">{msg}</div>
      ) : null}

      {isPending ? (
        <div className="flex items-center gap-2 border-t border-chrome-border/50 px-3 py-2">
          <button
            type="button"
            onClick={() => void accept(false)}
            disabled={busy != null}
            className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 text-[12px] text-main hover:bg-main/25 disabled:opacity-50"
          >
            {busy === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Accept
          </button>
          {!isMetric ? (
            <button
              type="button"
              onClick={() => void accept(true)}
              disabled={busy != null}
              className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-chrome-border/60 px-3 text-[12px] text-chrome-text/75 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
            >
              {busy === "enrich" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Accept & Enrich
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void saveEdits()}
            disabled={busy != null}
            title="Save your edits to the draft without accepting"
            className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-chrome-border/60 px-3 text-[12px] text-chrome-text/75 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save edits
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void withdraw()}
            disabled={busy != null}
            title="Retract this draft (status → withdrawn)"
            className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-chrome-border/60 px-3 text-[12px] text-chrome-text/60 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
          >
            {busy === "withdraw" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Withdraw
          </button>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="reject note (optional)"
            className="h-8 w-40 rounded-[3px] border border-chrome-border/50 bg-foreground/[0.03] px-2 text-[11px] text-foreground outline-none focus:bg-foreground/[0.06]"
          />
          <button
            type="button"
            onClick={() => void reject()}
            disabled={busy != null}
            className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-danger/40 px-3 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {busy === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Reject
          </button>
        </div>
      ) : null}
    </div>
  )
}
