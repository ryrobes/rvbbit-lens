"use client"

/**
 * The Fitting Room — the native workbench where a kit adapts to the
 * customer's schema (KIT_PLATES_PLAN §21). Kits ship TARGETS (canonical
 * view shapes); this app proposes candidate source tables, drafts a
 * mapping SELECT, previews it against real rows + the engine's
 * fitting_check verdicts, and on Accept records a FITTING and creates the
 * view. Stateless by doctrine: expectations and accepted fittings are
 * rows; this is just the tailor's mirror. Switchboards link here via
 * rv-open="app:fitting?kit=…".
 */

import { useCallback, useEffect, useState } from "react"
import { RefreshCw, Wrench } from "@/lib/icons"
import { cn } from "@/lib/utils"

interface FitTarget {
  kit: string
  target: string
  description: string | null
  columns: Array<{ name: string; type?: string; description?: string; required?: boolean }>
  accepted_at: string | null
  accepted_by: string | null
  select_sql: string | null
  view_exists: boolean
}

interface FitCandidate {
  schema_name: string
  rel_name: string
  score: number
  matched_on: string
}

interface FitCheck {
  check_name: string
  ok: boolean
  detail: string
}

export function FittingRoomWindow({
  activeConnectionId,
  initialKit,
}: {
  activeConnectionId: string | null
  initialKit?: string
}) {
  const [targets, setTargets] = useState<FitTarget[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<FitCandidate[]>([])
  const [tables, setTables] = useState<Array<{ schema_name: string; rel_name: string }>>([])
  const [draft, setDraft] = useState("")
  const [checks, setChecks] = useState<FitCheck[]>([])
  const [preview, setPreview] = useState<Array<Record<string, unknown>>>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const api = useCallback(
    async (op: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch("/api/kit/fitting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: activeConnectionId, op, ...extra }),
      })
      return (await res.json()) as Record<string, unknown> & { ok: boolean; error?: string }
    },
    [activeConnectionId],
  )

  const loadOverview = useCallback(async () => {
    if (!activeConnectionId) return
    const body = await api("overview")
    if (body.ok) {
      const ts = (body.targets ?? []) as FitTarget[]
      setTargets(ts)
      setSelected((prev) => {
        if (prev && ts.some((t) => `${t.kit}${t.target}` === prev)) return prev
        const first = initialKit ? (ts.find((t) => t.kit === initialKit) ?? ts[0]) : ts[0]
        return first ? `${first.kit}${first.target}` : null
      })
    } else setNote(body.error ?? "failed to load targets")
  }, [activeConnectionId, api, initialKit])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOverview(), 0)
    return () => window.clearTimeout(timer)
  }, [loadOverview])

  const sel = targets.find((t) => selected === `${t.kit}${t.target}`)

  // Selection changed: fetch candidates + tables, seed SQL from the
  // recorded fitting when one exists.
  useEffect(() => {
    if (!sel || !activeConnectionId) return
    let cancelled = false
    const run = async () => {
      setChecks([])
      setPreview([])
      setDraft(sel.select_sql ?? "")
      const [cand, tabs] = await Promise.all([
        api("candidates", { kit: sel.kit, target: sel.target }),
        api("tables"),
      ])
      if (cancelled) return
      setCandidates(cand.ok ? ((cand.candidates ?? []) as FitCandidate[]) : [])
      setTables(tabs.ok ? ((tabs.tables ?? []) as Array<{ schema_name: string; rel_name: string }>) : [])
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, activeConnectionId])

  const draftFrom = useCallback(
    async (schemaName: string, relName: string) => {
      if (!sel) return
      setBusy("draft")
      try {
        const body = await api("draft", { kit: sel.kit, target: sel.target, schemaName, relName })
        if (body.ok) {
          setDraft(String(body.draft ?? ""))
          setChecks([])
          setPreview([])
          setNote(null)
        } else setNote(body.error ?? "draft failed")
      } finally {
        setBusy(null)
      }
    },
    [api, sel],
  )

  const runCheck = useCallback(async () => {
    if (!sel || !draft.trim()) return
    setBusy("check")
    try {
      const body = await api("check", { kit: sel.kit, target: sel.target, selectSql: draft })
      if (body.ok) {
        setChecks((body.checks ?? []) as FitCheck[])
        setPreview((body.preview ?? []) as Array<Record<string, unknown>>)
        setNote(null)
      } else setNote(body.error ?? "check failed")
    } finally {
      setBusy(null)
    }
  }, [api, sel, draft])

  const accept = useCallback(async () => {
    if (!sel || !draft.trim()) return
    setBusy("apply")
    try {
      const body = await api("apply", {
        kit: sel.kit,
        target: sel.target,
        selectSql: draft,
        proposal: { candidates: candidates.slice(0, 3), accepted_from: "fitting-room" },
      })
      if (body.ok) {
        setChecks((body.checks ?? []) as FitCheck[])
        setNote(`${sel.target} fitted`)
        // Same event the plates use: switchboards re-render, gates flip.
        window.dispatchEvent(
          new CustomEvent("rvbbit:plate-data-changed", { detail: { plateId: "fitting-room", kit: sel.kit } }),
        )
        await loadOverview()
      } else setNote(body.error ?? "apply failed")
    } finally {
      setBusy(null)
    }
  }, [api, sel, draft, candidates, loadOverview])

  if (!activeConnectionId) {
    return <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">connect to a database first</div>
  }

  const checksBad = checks.filter((c) => !c.ok).length
  const canAccept = checks.length > 0 && checksBad === 0

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Wrench className="h-3.5 w-3.5 text-main" />
        <span className="font-medium text-foreground">Fitting Room</span>
        <span className="truncate text-chrome-text/45">
          map your tables onto a kit&apos;s canonical views — contracts go green when everything is fitted
        </span>
        <div className="flex-1" />
        {note ? (
          <span className="max-w-[40%] truncate text-[11px] text-main/80" title={note}>
            {note}
          </span>
        ) : null}
        <button type="button" onClick={() => void loadOverview()} title="Reload" className="text-chrome-text/50 hover:text-foreground">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-chrome-border/60 p-2">
          {targets.length === 0 ? (
            <div className="p-2 leading-relaxed text-chrome-text/55">
              No kit targets on this database. Kits ship them via <code>rvbbit.upsert_kit_target(&hellip;)</code>.
            </div>
          ) : (
            targets.map((t) => {
              const key = `${t.kit}${t.target}`
              const fitted = !!t.accepted_at && t.view_exists
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  className={cn(
                    "mb-1 w-full rounded-md border px-2 py-1.5 text-left",
                    selected === key ? "border-main/50 bg-main/10" : "border-chrome-border/50 bg-chrome-bg/25 hover:border-main/30",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", fitted ? "bg-success" : "bg-warning")} />
                    <span className="truncate font-medium text-foreground">{t.target.split(".").pop()}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-chrome-text/45">
                    {t.kit} &middot; {fitted ? "fitted" : "needs fitting"}
                  </div>
                </button>
              )
            })
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {!sel ? (
            <div className="p-4 text-chrome-text/50">pick a target</div>
          ) : (
            <>
              <div className="mb-2">
                <span className="font-medium text-foreground">{sel.target}</span>
                <span className="ml-2 text-chrome-text/50">{sel.description}</span>
              </div>
              <table className="mb-3 w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-[9.5px] uppercase tracking-wide text-chrome-text/45">
                    <th className="py-0.5 pr-3">expected column</th>
                    <th className="pr-3">type</th>
                    <th className="pr-3">meaning</th>
                    <th>required</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.columns.map((c) => (
                    <tr key={c.name} className="border-t border-chrome-border/30">
                      <td className="py-0.5 pr-3 font-mono text-main/80">{c.name}</td>
                      <td className="pr-3 text-chrome-text/70">{c.type ?? "text"}</td>
                      <td className="pr-3 text-chrome-text/55">{c.description}</td>
                      <td className="text-chrome-text/55">{c.required === false ? "optional" : "required"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-chrome-text/45">
                candidates &mdash; from the data catalog (crawl to refresh); or pick any table
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {candidates.map((c) => (
                  <button
                    key={`${c.schema_name}.${c.rel_name}`}
                    type="button"
                    disabled={busy != null}
                    onClick={() => void draftFrom(c.schema_name, c.rel_name)}
                    title={`score ${c.score} - matched on: ${c.matched_on}`}
                    className="rounded-full border border-main/30 px-2 py-0.5 text-[11px] text-foreground hover:border-main/60"
                  >
                    {c.schema_name}.{c.rel_name} <span className="text-chrome-text/45">{c.score}</span>
                  </button>
                ))}
                <select
                  className="rounded-md border border-chrome-border bg-chrome-bg/55 px-2 py-0.5 text-[11px] text-foreground"
                  value=""
                  onChange={(e) => {
                    const dot = e.target.value.indexOf(".")
                    if (dot > 0) void draftFrom(e.target.value.slice(0, dot), e.target.value.slice(dot + 1))
                  }}
                >
                  <option value="">any table&hellip;</option>
                  {tables.map((t) => (
                    <option key={`${t.schema_name}.${t.rel_name}`} value={`${t.schema_name}.${t.rel_name}`}>
                      {t.schema_name}.{t.rel_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-1 text-[10px] uppercase tracking-wide text-chrome-text/45">
                mapping SELECT (edit freely &mdash; the checks are the judge)
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={6}
                spellCheck={false}
                className="mb-2 w-full rounded-md border border-chrome-border bg-chrome-bg/55 p-2 font-mono text-[11px] text-foreground focus:border-main/50 focus:outline-none"
                placeholder="SELECT source_col AS target_col, ... FROM your.table"
              />
              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy != null || !draft.trim()}
                  onClick={() => void runCheck()}
                  className="rounded-md border border-chrome-border px-3 py-1 text-[11px] text-foreground hover:border-main/50 disabled:opacity-50"
                >
                  {busy === "check" ? "checking..." : "Preview & check"}
                </button>
                <button
                  type="button"
                  disabled={busy != null || !canAccept}
                  onClick={() => void accept()}
                  title={canAccept ? `Creates ${sel.target} and records the fitting` : "Run a clean check first"}
                  className="rounded-md border border-main/40 px-3 py-1 text-[11px] text-main hover:bg-main/10 disabled:opacity-50"
                >
                  {busy === "apply" ? "fitting..." : "Accept fitting"}
                </button>
                {checks.length > 0 ? (
                  <span className={cn("text-[11px]", checksBad ? "text-warning" : "text-success")}>
                    {checksBad ? `${checksBad} check(s) failing` : "all checks pass"}
                  </span>
                ) : null}
              </div>

              {checks.length > 0 ? (
                <div className="mb-3">
                  {checks.map((c) => (
                    <div key={c.check_name} className="flex items-baseline gap-2 border-t border-chrome-border/30 py-0.5">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.ok ? "bg-success" : "bg-danger")} />
                      <span className="w-40 shrink-0 font-mono text-[10.5px] text-chrome-text/70">{c.check_name}</span>
                      <span className={cn("text-[11px]", c.ok ? "text-chrome-text/55" : "text-danger")}>{c.detail}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {preview.length > 0 ? (
                <>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-chrome-text/45">preview (5 rows through the mapping)</div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="text-left text-[9.5px] uppercase tracking-wide text-chrome-text/45">
                          {Object.keys(preview[0]).map((k) => (
                            <th key={k} className="py-0.5 pr-3">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={i} className="border-t border-chrome-border/30">
                            {Object.keys(preview[0]).map((k) => (
                              <td key={k} className="max-w-[260px] truncate py-0.5 pr-3 text-chrome-text/75">
                                {String(row[k] ?? "")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
