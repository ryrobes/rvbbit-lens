"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Cpu,
  GraduationCap,
  Hammer,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sigma,
  Sparkles,
  Target,
  Trash2,
  XCircle,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import {
  CompositionBar,
  fmtAgo,
  fmtCount,
  fmtMs,
  HBars,
  Metric,
  Panel,
  Readout,
  type HBarRow,
} from "./instruments"
import { EngineDot, EnginePill, EngineRace, ShapeChips } from "./routing-charts"
import { ENGINES, engineMeta, routeExplain, type EngineId, type RouteExplain } from "@/lib/rvbbit/routing"
import {
  activateProfile,
  candidatesArg,
  createProfile,
  deleteTrainingQuery,
  fetchProfileEntriesByName,
  fetchProfiles,
  fetchRejectedShapes,
  fetchTrainingQueries,
  fetchTrainingResults,
  fetchTrainingRuns,
  fetchTrainingSummary,
  rebuildProfile,
  retireProfile,
  setTrainingEnabled,
  trainQuery,
  type ProfileEntryRow,
  type ProfileRow,
  type RejectedShape,
  type TrainingQueryRow,
  type TrainingResultRow,
  type TrainingRunRow,
  type TrainingSummaryRow,
} from "@/lib/rvbbit/route-training"

interface RoutingTrainTabProps {
  activeConnectionId: string | null
}

interface ProfileBundle {
  profile: ProfileRow
  trainingQueries: TrainingQueryRow[]
  trainingSummary: TrainingSummaryRow[]
  entries: ProfileEntryRow[]
  rejected: RejectedShape[]
}

// ── Top-level tab ───────────────────────────────────────────────────

export function RoutingTrainTab({ activeConnectionId }: RoutingTrainTabProps) {
  const [profiles, setProfiles] = useState<ProfileRow[] | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  // The bundle carries its own key so stale fetches don't render.
  const [bundleSlot, setBundleSlot] = useState<{ key: string; data: ProfileBundle } | null>(null)
  const [selectedQueryId, setSelectedQueryId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ tone: "ok" | "warn"; msg: string } | null>(null)
  const [showNew, setShowNew] = useState(false)

  // bump to force a refetch
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  const flashToast = useCallback((tone: "ok" | "warn", msg: string) => {
    setToast({ tone, msg })
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4000)
  }, [])

  // Load profiles list
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    void (async () => {
      const res = await fetchProfiles(activeConnectionId)
      if (cancelled) return
      if (res.error) setError(res.error)
      else setError(null)
      setProfiles(res.rows)
      // Default-select active profile, then most recent, then first
      setSelectedName((cur) => {
        if (cur && res.rows.some((p) => p.name === cur)) return cur
        if (res.rows.length === 0) return null
        return res.rows.find((p) => p.active)?.name ?? res.rows[0].name
      })
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, refreshTick])

  // Load bundle for the selected profile — the slot's key gates rendering.
  useEffect(() => {
    if (!activeConnectionId || !selectedName || !profiles) return
    const profile = profiles.find((p) => p.name === selectedName)
    if (!profile) return
    let cancelled = false
    const key = `${selectedName}#${refreshTick}`
    void (async () => {
      const [trainingQueries, trainingSummary, entries, rejected] = await Promise.all([
        fetchTrainingQueries(activeConnectionId, selectedName),
        fetchTrainingSummary(activeConnectionId, selectedName),
        fetchProfileEntriesByName(activeConnectionId, selectedName),
        fetchRejectedShapes(activeConnectionId, selectedName),
      ])
      if (cancelled) return
      setBundleSlot({
        key,
        data: { profile, trainingQueries, trainingSummary, entries, rejected },
      })
      // Drop selectedQueryId if it's no longer in the corpus.
      setSelectedQueryId((cur) =>
        cur != null && !trainingQueries.some((q) => q.id === cur) ? null : cur,
      )
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selectedName, profiles, refreshTick])

  // Only render bundle if it's for the currently selected profile.
  const bundle =
    bundleSlot && selectedName && bundleSlot.data.profile.name === selectedName
      ? bundleSlot.data
      : null

  // Mutators wrapped with shared error / refresh handling
  const wrap = useCallback(
    async <T,>(
      label: string,
      run: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
      onOk?: (data: T) => void,
    ) => {
      setBusy(label)
      try {
        const res = await run()
        if (!res.ok) {
          setError(res.error)
          flashToast("warn", `${label} failed`)
          return
        }
        onOk?.(res.data)
        setError(null)
        flashToast("ok", `${label} ok`)
        refresh()
      } finally {
        setBusy(null)
      }
    },
    [flashToast, refresh],
  )

  const onCreateProfile = useCallback(
    async (name: string, activate: boolean) => {
      if (!activeConnectionId) return
      await wrap("create profile", () => createProfile(activeConnectionId, name, activate), () => {
        setSelectedName(name)
      })
      setShowNew(false)
    },
    [activeConnectionId, wrap],
  )

  const onActivate = useCallback(
    async (name: string) => {
      if (!activeConnectionId) return
      await wrap("activate", () => activateProfile(activeConnectionId, name))
    },
    [activeConnectionId, wrap],
  )

  const onRetire = useCallback(
    async (name: string) => {
      if (!activeConnectionId) return
      await wrap("retire", () => retireProfile(activeConnectionId, name))
    },
    [activeConnectionId, wrap],
  )

  const onRebuild = useCallback(
    async (name: string, minGainPct: number, activate: boolean) => {
      if (!activeConnectionId) return
      await wrap(
        activate ? "rebuild & publish" : "rebuild draft",
        () => rebuildProfile(activeConnectionId, name, minGainPct, activate),
      )
    },
    [activeConnectionId, wrap],
  )

  const onTrain = useCallback(
    async (args: {
      sql: string
      label: string
      repeats: number
      minGainPct: number
      activate: boolean
      candidates: EngineId[]
    }) => {
      if (!activeConnectionId || !selectedName) return
      const candidates = candidatesArg(args.candidates)
      await wrap(
        "train query",
        () =>
          trainQuery(activeConnectionId, {
            profileName: selectedName,
            sql: args.sql,
            label: args.label,
            repeats: args.repeats,
            minGainPct: args.minGainPct,
            activate: args.activate,
            candidates,
          }),
        (data) => {
          setSelectedQueryId(data.trainingQueryId)
        },
      )
    },
    [activeConnectionId, selectedName, wrap],
  )

  const onToggleEnabled = useCallback(
    async (queryId: number, enabled: boolean) => {
      if (!activeConnectionId || !selectedName) return
      await wrap(enabled ? "enable" : "disable", () =>
        setTrainingEnabled(activeConnectionId, selectedName, queryId, enabled),
      )
    },
    [activeConnectionId, selectedName, wrap],
  )

  const onDelete = useCallback(
    async (queryId: number, rebuildAfter: boolean) => {
      if (!activeConnectionId || !selectedName) return
      await wrap(
        rebuildAfter ? "delete & rebuild" : "delete",
        () => deleteTrainingQuery(activeConnectionId, selectedName, queryId, rebuildAfter),
        () => setSelectedQueryId(null),
      )
    },
    [activeConnectionId, selectedName, wrap],
  )

  // Derived UI state
  const selectedQuery =
    bundle?.trainingQueries.find((q) => q.id === selectedQueryId) ?? null

  if (!activeConnectionId) {
    return (
      <div className="grid h-full place-items-center bg-doc-bg p-6 text-center text-[12px] text-chrome-text/70">
        Connect to a database to inspect and curate training profiles.
      </div>
    )
  }

  if (!profiles) {
    return (
      <div className="grid h-40 place-items-center text-[11px] text-chrome-text/55">
        <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
        Loading profiles…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 bg-doc-bg p-2.5 text-[12px] text-chrome-text">
      {/* Profile rail */}
      <ProfileRail
        profiles={profiles}
        selectedName={selectedName}
        onSelect={(n) => {
          setSelectedName(n)
          setSelectedQueryId(null)
        }}
        onCreate={() => setShowNew(true)}
        onRefresh={refresh}
        busy={busy}
      />

      {/* New-profile dialog */}
      {showNew ? (
        <NewProfileForm
          existing={profiles.map((p) => p.name)}
          onCancel={() => setShowNew(false)}
          onCreate={onCreateProfile}
        />
      ) : null}

      {/* Toast / error */}
      {error ? (
        <div className="flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="break-words font-mono">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto rounded px-1 text-danger/70 hover:bg-danger/10"
            aria-label="Dismiss"
          >
            <XCircle className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {toast ? (
        <div
          className={cn(
            "rounded-md border px-2.5 py-1 text-[11px]",
            toast.tone === "ok"
              ? "border-success/40 bg-success/10 text-success"
              : "border-warning/40 bg-warning/10 text-warning",
          )}
        >
          {toast.tone === "ok" ? (
            <CheckCircle2 className="mr-1 inline h-3 w-3" />
          ) : (
            <AlertTriangle className="mr-1 inline h-3 w-3" />
          )}
          {toast.msg}
        </div>
      ) : null}

      {/* Selected profile header + rebuild */}
      {selectedName && bundle ? (
        <ProfileHeaderCard
          key={`${bundle.profile.name}/${bundle.profile.active}`}
          profile={bundle.profile}
          onActivate={() => onActivate(selectedName)}
          onRetire={() => onRetire(selectedName)}
          onRebuild={onRebuild}
          busy={busy}
        />
      ) : null}

      {/* Main two-column workspace */}
      {selectedName && bundle ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2.5">
          <div className="flex min-h-0 flex-col gap-2.5">
            <TrainingQueriesPanel
              queries={bundle.trainingQueries}
              summary={bundle.trainingSummary}
              selectedId={selectedQueryId}
              onSelect={setSelectedQueryId}
              onToggleEnabled={onToggleEnabled}
            />
            <ComposeQueryPanel
              key={`${selectedName}/${bundle.profile.active}`}
              activeConnectionId={activeConnectionId}
              profileName={selectedName}
              isActiveProfile={bundle.profile.active}
              onTrain={onTrain}
              busy={busy}
            />
          </div>
          <div className="flex min-h-0 flex-col gap-2.5">
            {selectedQuery ? (
              <TrainingQueryDetail
                activeConnectionId={activeConnectionId}
                query={selectedQuery}
                summary={bundle.trainingSummary.filter(
                  (s) => s.trainingQueryId === selectedQuery.id,
                )}
                onRetrain={(repeats, minGain, activate, cands) =>
                  onTrain({
                    sql: selectedQuery.querySql,
                    label: selectedQuery.label ?? "",
                    repeats,
                    minGainPct: minGain,
                    activate,
                    candidates: cands,
                  })
                }
                onDelete={onDelete}
              />
            ) : (
              <ProfileSidePanels bundle={bundle} />
            )}
          </div>
        </div>
      ) : profiles.length === 0 ? (
        <div className="grid flex-1 place-items-center text-center text-[11px] text-chrome-text/55">
          <div>
            <GraduationCap className="mx-auto mb-2 h-7 w-7 text-chrome-text/30" />
            No profiles yet — create one to start curating training queries.
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Profile rail ────────────────────────────────────────────────────

function ProfileRail({
  profiles,
  selectedName,
  onSelect,
  onCreate,
  onRefresh,
  busy,
}: {
  profiles: ProfileRow[]
  selectedName: string | null
  onSelect: (name: string) => void
  onCreate: () => void
  onRefresh: () => void
  busy: string | null
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto rounded-md border border-chrome-border/60 bg-secondary-background/40 px-2 py-1.5">
      <span className="shrink-0 text-[9px] uppercase tracking-wider text-chrome-text/55">
        profiles
      </span>
      {profiles.length === 0 ? (
        <span className="text-[10px] italic text-chrome-text/55">none</span>
      ) : null}
      {profiles.map((p) => {
        const isSel = p.name === selectedName
        return (
          <button
            key={p.name}
            type="button"
            onClick={() => onSelect(p.name)}
            title={`${p.entries} entries · ${p.trainingQueries} queries · updated ${
              p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"
            }`}
            className={cn(
              "group inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px]",
              isSel
                ? "border-rvbbit-accent/60 bg-rvbbit-bg text-foreground"
                : "border-chrome-border/60 bg-doc-bg text-chrome-text/85 hover:border-rvbbit-accent/40 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                p.active
                  ? "bg-success ring-2 ring-success/30"
                  : "bg-chrome-text/35",
              )}
            />
            <span className="truncate">{p.name}</span>
            <span className="text-[9px] tabular-nums text-chrome-text/55">
              {p.entries}/{p.trainingQueries}
            </span>
          </button>
        )
      })}
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 text-[10px] text-foreground hover:border-rvbbit-accent/40"
        >
          <Plus className="h-3 w-3" />
          new profile
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!!busy}
          title="Reload all training state"
          className="grid h-5 w-5 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
        </button>
      </div>
    </div>
  )
}

function NewProfileForm({
  existing,
  onCancel,
  onCreate,
}: {
  existing: string[]
  onCancel: () => void
  onCreate: (name: string, activate: boolean) => void
}) {
  const [name, setName] = useState("")
  const [activate, setActivate] = useState(false)
  const conflict = existing.includes(name.trim())
  const valid = /^[a-z][a-z0-9._-]{1,63}$/i.test(name.trim()) && !conflict
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-rvbbit-accent/40 bg-rvbbit-bg/40 px-2.5 py-2 text-[11px]">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <label className="text-[9px] uppercase tracking-wider text-chrome-text/55">
          new profile name
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="dashboard-fast-path"
          className="rounded border border-chrome-border bg-doc-bg px-1.5 py-1 font-mono text-[11px] text-foreground outline-none focus:border-rvbbit-accent/60"
        />
        {conflict ? (
          <span className="text-[9px] text-warning">name already exists</span>
        ) : null}
      </div>
      <label className="inline-flex items-center gap-1.5 text-[10px] text-chrome-text/85">
        <input
          type="checkbox"
          checked={activate}
          onChange={(e) => setActivate(e.target.checked)}
        />
        activate immediately
      </label>
      <div className="ml-auto flex gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px] hover:border-chrome-border/80"
        >
          cancel
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={() => onCreate(name.trim(), activate)}
          className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/60 bg-rvbbit-accent/15 px-2 py-0.5 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/25 disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          create
        </button>
      </div>
    </div>
  )
}

// ── Profile header card ─────────────────────────────────────────────

function ProfileHeaderCard({
  profile,
  onActivate,
  onRetire,
  onRebuild,
  busy,
}: {
  profile: ProfileRow
  onActivate: () => void
  onRetire: () => void
  onRebuild: (name: string, minGainPct: number, activate: boolean) => void
  busy: string | null
}) {
  const [minGain, setMinGain] = useState(5)
  const [activate, setActivate] = useState(profile.active)

  const mixSegments = ENGINES.map((e) => ({
    label: e.label,
    value: profile.candidateMix[e.id] ?? 0,
    color: e.color,
  }))

  return (
    <Panel
      icon={BookOpen}
      title={`profile · ${profile.name}`}
      right={
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[9px] uppercase tracking-wider",
            profile.active
              ? "bg-success/15 text-success"
              : "bg-foreground/[0.06] text-chrome-text/70",
          )}
        >
          {profile.active ? "active" : "draft"}
        </span>
      }
    >
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <Readout
          value={fmtCount(profile.entries)}
          label="accepted entries"
          accent
        />
        <Metric label="rejected shapes" value={fmtCount(profile.rejectedCount)} tone={profile.rejectedCount > 0 ? "muted" : undefined} />
        <Metric label="training queries" value={fmtCount(profile.trainingQueries)} />
        <Metric label="profile points" value={fmtCount(profile.points)} />
        <Metric
          label="avg confidence"
          value={
            profile.avgConfidence != null
              ? `${(profile.avgConfidence * 100).toFixed(0)}%`
              : "—"
          }
        />
        <Metric
          label="updated"
          value={profile.updatedAt ? fmtAgo(new Date(profile.updatedAt).getTime()) : "—"}
        />
        {profile.generatedBy ? (
          <Metric label="generated by" value={profile.generatedBy} tone="muted" />
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-[1fr_auto] items-end gap-3">
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
            chosen-engine mix across entries
          </div>
          {profile.entries === 0 ? (
            <p className="text-[10px] text-chrome-text/55">
              No accepted entries yet — train a few queries, then rebuild.
            </p>
          ) : (
            <>
              <CompositionBar segments={mixSegments} height={14} />
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px]">
                {mixSegments
                  .filter((s) => s.value > 0)
                  .sort((a, b) => b.value - a.value)
                  .map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: s.color }}
                      />
                      <span className="text-chrome-text/80">{s.label}</span>
                      <span className="tabular-nums text-chrome-text/55">{s.value}</span>
                    </span>
                  ))}
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-chrome-border/60 bg-doc-bg p-2">
          <div className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            rebuild this profile
          </div>
          <label className="inline-flex items-center gap-1.5 text-[10px] text-chrome-text/85">
            <span className="text-chrome-text/55">min gain</span>
            <input
              type="range"
              min={0}
              max={50}
              step={1}
              value={minGain}
              onChange={(e) => setMinGain(Number(e.target.value))}
              className="h-1 w-24 accent-rvbbit-accent"
            />
            <span className="w-10 font-mono tabular-nums text-foreground">{minGain}%</span>
          </label>
          <label className="inline-flex items-center gap-1.5 text-[10px] text-chrome-text/85">
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
            />
            activate after rebuild
          </label>
          <div className="mt-0.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => onRebuild(profile.name, minGain / 100, activate)}
              className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-0.5 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
            >
              <Hammer className="h-3 w-3" />
              rebuild
            </button>
            {profile.active ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={onRetire}
                className="inline-flex items-center gap-1 rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px] text-chrome-text/85 hover:border-warning/40 hover:text-warning disabled:opacity-40"
              >
                retire
              </button>
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={onActivate}
                className="inline-flex items-center gap-1 rounded border border-success/50 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success hover:bg-success/15 disabled:opacity-40"
              >
                activate
              </button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ── Training queries table ──────────────────────────────────────────

function TrainingQueriesPanel({
  queries,
  summary,
  selectedId,
  onSelect,
  onToggleEnabled,
}: {
  queries: TrainingQueryRow[]
  summary: TrainingSummaryRow[]
  selectedId: number | null
  onSelect: (id: number) => void
  onToggleEnabled: (id: number, enabled: boolean) => void
}) {
  const byQuery = useMemo(() => {
    const m = new Map<number, TrainingSummaryRow[]>()
    for (const s of summary) {
      const arr = m.get(s.trainingQueryId) ?? []
      arr.push(s)
      m.set(s.trainingQueryId, arr)
    }
    return m
  }, [summary])

  return (
    <Panel
      icon={GraduationCap}
      title="training queries"
      right={
        <span>
          {queries.length} saved · {queries.filter((q) => q.enabled).length} enabled
        </span>
      }
    >
      {queries.length === 0 ? (
        <p className="text-[11px] text-chrome-text/55">
          No training queries yet. Use <span className="font-mono">compose</span> below to add the
          first one.
        </p>
      ) : (
        <div className="max-h-[260px] overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-[1] bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
              <tr>
                <th className="py-1 pr-1 text-left font-medium">#</th>
                <th className="py-1 pr-2 text-left font-medium">label / shape</th>
                <th className="py-1 pr-2 text-left font-medium">candidate race</th>
                <th className="py-1 pr-2 text-right font-medium">best</th>
                <th className="py-1 pr-2 text-right font-medium">runs</th>
                <th className="py-1 pr-1 text-center font-medium">on</th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => {
                const sums = byQuery.get(q.id) ?? []
                const times: Partial<Record<string, number | null>> = {}
                let bestMs: number | null = null
                let bestCand: string | null = null
                for (const s of sums) {
                  times[s.candidate] = s.medianMs
                  if (s.medianMs != null && (bestMs == null || s.medianMs < bestMs)) {
                    bestMs = s.medianMs
                    bestCand = s.candidate
                  }
                }
                const hasMismatch = sums.some(
                  (s) => s.lastValidationStatus === "mismatch" || s.errorRuns > 0,
                )
                const isSel = q.id === selectedId
                return (
                  <tr
                    key={q.id}
                    onClick={() => onSelect(q.id)}
                    className={cn(
                      "cursor-pointer border-t border-chrome-border/30 align-middle hover:bg-foreground/[0.03]",
                      isSel && "bg-rvbbit-bg/40",
                      !q.enabled && "opacity-55",
                    )}
                  >
                    <td className="py-1 pr-1 font-mono text-[10px] tabular-nums text-chrome-text/55">
                      {q.id}
                    </td>
                    <td className="max-w-0 py-1 pr-2">
                      <div className="truncate font-mono text-[11px] text-foreground">
                        {q.label || <span className="text-chrome-text/45">untitled</span>}
                      </div>
                      <ShapeChips shape={q.shapeFamily || q.shapeKey} limit={4} />
                    </td>
                    <td className="py-1 pr-2">
                      <EngineRace
                        times={times}
                        choice={bestCand ?? ""}
                        height={22}
                      />
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {bestMs != null ? (
                        <span
                          className="font-mono text-[10px] tabular-nums"
                          style={{ color: engineMeta(bestCand ?? "").color }}
                        >
                          {fmtMs(bestMs)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-chrome-text/40">—</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-[10px] tabular-nums text-chrome-text/75">
                      {q.runs}
                      {hasMismatch ? (
                        <AlertTriangle className="ml-1 inline h-2.5 w-2.5 text-warning" />
                      ) : null}
                    </td>
                    <td
                      className="py-1 pr-1 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={q.enabled}
                        onChange={() => onToggleEnabled(q.id, !q.enabled)}
                        title={q.enabled ? "Enabled — counted in rebuild" : "Disabled"}
                        className="accent-rvbbit-accent"
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

// ── Selected training-query detail ──────────────────────────────────

function TrainingQueryDetail({
  activeConnectionId,
  query,
  summary,
  onRetrain,
  onDelete,
}: {
  activeConnectionId: string
  query: TrainingQueryRow
  summary: TrainingSummaryRow[]
  onRetrain: (
    repeats: number,
    minGainPct: number,
    activate: boolean,
    candidates: EngineId[],
  ) => void
  onDelete: (id: number, rebuildAfter: boolean) => void
}) {
  const [runs, setRuns] = useState<TrainingRunRow[]>([])
  // Stored with the runId it belongs to so render can gate on it.
  const [runResultsSlot, setRunResultsSlot] = useState<{
    runId: number
    rows: TrainingResultRow[]
  } | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Load run history
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await fetchTrainingRuns(activeConnectionId, query.profileName, query.id)
      if (cancelled) return
      setRuns(list)
      const next = list[0]?.id ?? null
      setSelectedRunId((cur) => (cur != null && list.some((r) => r.id === cur) ? cur : next))
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, query.profileName, query.id])

  // Load per-repeat results for the selected run
  useEffect(() => {
    if (selectedRunId == null) return
    let cancelled = false
    const runId = selectedRunId
    void (async () => {
      const res = await fetchTrainingResults(activeConnectionId, runId)
      if (!cancelled) setRunResultsSlot({ runId, rows: res })
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, selectedRunId])

  const bestCand = useMemo(() => {
    let best: TrainingSummaryRow | null = null
    for (const s of summary) {
      if (s.medianMs == null) continue
      if (!best || (best.medianMs != null && s.medianMs < best.medianMs)) best = s
    }
    return best?.candidate ?? ""
  }, [summary])

  const candidateTimes = useMemo(() => {
    const t: Partial<Record<string, number | null>> = {}
    for (const s of summary) t[s.candidate] = s.medianMs
    return t
  }, [summary])

  // Per-repeat grid — gate on selectedRunId inside the memo so the dep set
  // stays stable.
  const repeatGrid = useMemo(() => {
    const rows =
      runResultsSlot && runResultsSlot.runId === selectedRunId
        ? runResultsSlot.rows
        : []
    const repeats = Math.max(0, ...rows.map((r) => r.repeatIdx)) + 1
    const candidates = ENGINES.filter((e) => rows.some((r) => r.candidate === e.id))
    const cellByKey = new Map<string, TrainingResultRow>()
    for (const r of rows) cellByKey.set(`${r.candidate}/${r.repeatIdx}`, r)
    return { repeats, candidates, cellByKey }
  }, [runResultsSlot, selectedRunId])

  return (
    <Panel
      icon={Sigma}
      title={`query #${query.id} · ${query.shapeFamily || query.shapeKey}`}
      right={
        <span className={cn(!query.enabled && "text-warning")}>
          {query.enabled ? "enabled" : "disabled"} · {query.runs} runs
        </span>
      }
    >
      <div className="space-y-2.5">
        {/* Label + SQL */}
        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
            label
          </div>
          <div className="font-mono text-[11px] text-foreground">
            {query.label || <span className="text-chrome-text/45">untitled</span>}
          </div>
          <div className="mb-0.5 mt-1.5 text-[9px] uppercase tracking-wider text-chrome-text/45">
            source SQL
          </div>
          <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap rounded border border-chrome-border bg-doc-bg p-1.5 font-mono text-[10px] leading-relaxed text-chrome-text/85">
            {query.querySql || "—"}
          </pre>
        </div>

        {/* Candidate race */}
        <div className="rounded border border-chrome-border/60 bg-doc-bg p-2">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
              candidate medians
            </span>
            {bestCand ? (
              <span className="text-[10px] text-chrome-text/65">
                fastest: <EnginePill id={bestCand} />
              </span>
            ) : null}
          </div>
          <CandidateMedianBars summary={summary} />
          <div className="mt-2 flex justify-end">
            <EngineRace times={candidateTimes} choice={bestCand} height={26} />
          </div>
        </div>

        {/* Run history + per-repeat grid */}
        <div className="grid grid-cols-[140px_1fr] gap-2">
          <div className="rounded border border-chrome-border/60 bg-doc-bg p-1.5">
            <div className="mb-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
              runs
            </div>
            <div className="max-h-[180px] space-y-0.5 overflow-auto">
              {runs.length === 0 ? (
                <span className="text-[10px] text-chrome-text/45">no runs</span>
              ) : (
                runs.map((r) => {
                  const isSel = r.id === selectedRunId
                  const finished = r.finishedAt ? new Date(r.finishedAt).getTime() : 0
                  const started = r.startedAt ? new Date(r.startedAt).getTime() : 0
                  const dur = finished > 0 && started > 0 ? finished - started : 0
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      className={cn(
                        "block w-full rounded px-1.5 py-1 text-left font-mono text-[10px]",
                        isSel
                          ? "bg-rvbbit-accent/15 text-foreground"
                          : "text-chrome-text/85 hover:bg-foreground/[0.05]",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="tabular-nums">#{r.id}</span>
                        <span
                          className={cn(
                            "rounded px-1 text-[8px] uppercase tracking-wider",
                            r.status === "finished"
                              ? "bg-success/15 text-success"
                              : "bg-warning/15 text-warning",
                          )}
                        >
                          {r.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-chrome-text/55">
                        <span>{r.repeats}× × {r.candidates.length}</span>
                        <span>{dur > 0 ? fmtMs(dur) : "—"}</span>
                      </div>
                      <div className="text-[9px] text-chrome-text/45">
                        {r.startedAt ? fmtAgo(new Date(r.startedAt).getTime()) : "—"}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          <div className="rounded border border-chrome-border/60 bg-doc-bg p-1.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
                per-repeat results
              </span>
              {selectedRunId != null ? (
                <span className="font-mono text-[9px] text-chrome-text/55">
                  run #{selectedRunId}
                </span>
              ) : null}
            </div>
            <RepeatGrid
              repeats={repeatGrid.repeats}
              candidates={repeatGrid.candidates}
              cellByKey={repeatGrid.cellByKey}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-chrome-border/40 pt-2">
          <button
            type="button"
            onClick={() =>
              onRetrain(
                Math.max(1, runs[0]?.repeats ?? 3),
                0.05,
                false,
                ENGINES.map((e) => e.id),
              )
            }
            className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-0.5 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15"
          >
            <RefreshCw className="h-3 w-3" />
            retrain
          </button>
          <span className="text-[9px] text-chrome-text/45">
            (repeats from last run · all candidates · draft rebuild)
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {confirmDelete ? (
              <>
                <span className="text-[10px] text-warning">delete?</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(false)
                    onDelete(query.id, false)
                  }}
                  className="inline-flex items-center gap-1 rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/15"
                >
                  <Trash2 className="h-3 w-3" />
                  delete only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(false)
                    onDelete(query.id, true)
                  }}
                  className="inline-flex items-center gap-1 rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/15"
                >
                  delete & rebuild
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px]"
                >
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1 rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px] text-chrome-text/70 hover:border-danger/40 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
                delete
              </button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function CandidateMedianBars({ summary }: { summary: TrainingSummaryRow[] }) {
  const rows = useMemo<HBarRow[]>(() => {
    return ENGINES.map((e) => {
      const s = summary.find((x) => x.candidate === e.id)
      const ms = s?.medianMs ?? null
      const status = s?.lastValidationStatus ?? "—"
      const errors = s?.errorRuns ?? 0
      const muted = ms == null
      return {
        label: (
          <span className="inline-flex items-center gap-1">
            <EngineDot id={e.id} />
            {e.label}
            {status === "mismatch" ? (
              <span className="rounded bg-warning/15 px-1 text-[8px] uppercase text-warning">
                mismatch
              </span>
            ) : null}
          </span>
        ),
        value: ms == null ? 0 : ms,
        valueLabel: ms == null ? "—" : fmtMs(ms),
        sub: errors > 0 ? `${errors} err` : "",
        color: e.color,
        title: status,
        muted,
      } satisfies HBarRow
    }).sort((a, b) => {
      if (a.muted && !b.muted) return 1
      if (b.muted && !a.muted) return -1
      return a.value - b.value
    })
  }, [summary])
  return <HBars rows={rows} />
}

function RepeatGrid({
  repeats,
  candidates,
  cellByKey,
}: {
  repeats: number
  candidates: { id: EngineId; label: string; color: string }[]
  cellByKey: Map<string, TrainingResultRow>
}) {
  if (repeats === 0 || candidates.length === 0) {
    return <p className="text-[10px] text-chrome-text/45">No per-repeat data.</p>
  }
  // find max elapsed for color scaling
  const maxElapsed = Math.max(
    1,
    ...Array.from(cellByKey.values()).map((v) => v.elapsedMs ?? 0),
  )
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="text-[9px] uppercase tracking-wider text-chrome-text/45">
            <th className="px-1 py-0.5 text-left font-medium">candidate</th>
            {Array.from({ length: repeats }).map((_, i) => (
              <th key={i} className="px-1 py-0.5 text-center font-medium">
                r{i + 1}
              </th>
            ))}
            <th className="px-1 py-0.5 text-left font-medium">status</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            // pick a row to gather candidate-level state
            const last = Array.from(cellByKey.values())
              .filter((r) => r.candidate === c.id)
              .sort((a, b) => b.repeatIdx - a.repeatIdx)[0]
            return (
              <tr key={c.id} className="border-t border-chrome-border/20 align-middle">
                <td className="whitespace-nowrap px-1 py-0.5">
                  <span className="inline-flex items-center gap-1 font-mono">
                    <EngineDot id={c.id} />
                    {c.label}
                  </span>
                </td>
                {Array.from({ length: repeats }).map((_, i) => {
                  const cell = cellByKey.get(`${c.id}/${i}`)
                  if (!cell) {
                    return (
                      <td key={i} className="px-1 py-0.5 text-center text-chrome-text/30">
                        —
                      </td>
                    )
                  }
                  const ok =
                    cell.status === "ok" &&
                    (cell.validationStatus === "baseline" || cell.validationStatus === "ok")
                  const tone =
                    cell.status === "error"
                      ? "var(--danger)"
                      : cell.validationStatus === "mismatch"
                        ? "var(--warning)"
                        : ok
                          ? c.color
                          : "var(--chrome-text)"
                  const intensity =
                    cell.elapsedMs != null && cell.elapsedMs > 0
                      ? 0.18 + 0.7 * Math.min(1, cell.elapsedMs / maxElapsed)
                      : 0.1
                  return (
                    <td
                      key={i}
                      className="px-0.5 py-0.5 text-center"
                      title={
                        cell.status === "error"
                          ? `error: ${cell.error ?? ""}`
                          : cell.validationStatus === "mismatch"
                            ? "validation mismatch"
                            : cell.elapsedMs != null
                              ? `${cell.elapsedMs.toFixed(1)}ms · ${cell.validationStatus}`
                              : cell.status
                      }
                    >
                      <span
                        className="inline-block rounded px-1 font-mono tabular-nums"
                        style={{
                          background: `color-mix(in oklch, ${tone} ${(intensity * 100).toFixed(0)}%, transparent)`,
                          color: ok ? "var(--foreground)" : tone,
                        }}
                      >
                        {cell.elapsedMs != null
                          ? fmtMs(cell.elapsedMs)
                          : cell.status === "skipped"
                            ? "skip"
                            : "err"}
                      </span>
                    </td>
                  )
                })}
                <td className="px-1 py-0.5">
                  {last ? (
                    <span
                      className={cn(
                        "rounded px-1 text-[9px] uppercase tracking-wider",
                        last.validationStatus === "ok" || last.validationStatus === "baseline"
                          ? "bg-success/10 text-success"
                          : last.validationStatus === "mismatch"
                            ? "bg-warning/15 text-warning"
                            : last.status === "skipped"
                              ? "bg-foreground/[0.05] text-chrome-text/65"
                              : "bg-danger/15 text-danger",
                      )}
                    >
                      {last.validationStatus || last.status}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Compose new query ───────────────────────────────────────────────

function ComposeQueryPanel({
  activeConnectionId,
  profileName,
  isActiveProfile,
  onTrain,
  busy,
}: {
  activeConnectionId: string
  profileName: string
  isActiveProfile: boolean
  onTrain: (args: {
    sql: string
    label: string
    repeats: number
    minGainPct: number
    activate: boolean
    candidates: EngineId[]
  }) => void
  busy: string | null
}) {
  const [sql, setSql] = useState("")
  const [label, setLabel] = useState("")
  const [repeats, setRepeats] = useState(3)
  const [minGain, setMinGain] = useState(5)
  const [activate, setActivate] = useState(isActiveProfile)
  const [selected, setSelected] = useState<EngineId[]>(ENGINES.map((e) => e.id))
  const [explain, setExplain] = useState<RouteExplain | null>(null)
  const [explainErr, setExplainErr] = useState<string | null>(null)
  const [explainBusy, setExplainBusy] = useState(false)

  const reset = useCallback(() => {
    setSql("")
    setLabel("")
    setExplain(null)
    setExplainErr(null)
  }, [])

  const onPreview = useCallback(async () => {
    if (!sql.trim()) return
    setExplainBusy(true)
    const res = await routeExplain(activeConnectionId, sql)
    setExplainBusy(false)
    setExplainErr(res.error ?? null)
    setExplain(res.explain)
  }, [activeConnectionId, sql])

  const toggleCand = (id: EngineId) =>
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    )

  const candsSummary = useMemo(() => {
    if (selected.length === ENGINES.length) return "all"
    return selected.length === 0
      ? "(none — native only)"
      : selected.map((id) => engineMeta(id).label).join(", ")
  }, [selected])

  const isTraining = busy === "train query"

  return (
    <Panel
      icon={Sparkles}
      title={`compose · train on ${profileName}`}
      right={
        <span className="text-[9px] text-chrome-text/55">
          synchronous · {repeats}× × {selected.length || 1} candidates
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-2">
        <div>
          <div className="mb-0.5 flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-wider text-chrome-text/45">
              source SQL
            </span>
            <span className="text-[9px] text-chrome-text/40">
              SELECT/WITH only · no volatile fns
            </span>
          </div>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                if (sql.trim()) {
                  onTrain({
                    sql,
                    label,
                    repeats,
                    minGainPct: minGain / 100,
                    activate,
                    candidates: selected,
                  })
                }
              }
            }}
            rows={4}
            spellCheck={false}
            placeholder={`SELECT … FROM your_rvbbit_table\nGROUP BY …\nORDER BY …`}
            className="w-full resize-y rounded border border-chrome-border bg-doc-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-rvbbit-accent/60"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-[10px] text-chrome-text/80">
            <span className="text-chrome-text/55">label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="dashboard region distinct users"
              className="w-56 rounded border border-chrome-border bg-doc-bg px-1.5 py-0.5 font-mono text-[10px] text-foreground outline-none focus:border-rvbbit-accent/60"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[10px] text-chrome-text/80">
            <span className="text-chrome-text/55">repeats</span>
            <input
              type="number"
              min={1}
              max={100}
              value={repeats}
              onChange={(e) => setRepeats(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className="w-12 rounded border border-chrome-border bg-doc-bg px-1 py-0.5 text-right font-mono text-[10px] tabular-nums text-foreground outline-none focus:border-rvbbit-accent/60"
            />
          </label>

          <label className="flex items-center gap-1.5 text-[10px] text-chrome-text/80">
            <span className="text-chrome-text/55">min gain</span>
            <input
              type="range"
              min={0}
              max={50}
              step={1}
              value={minGain}
              onChange={(e) => setMinGain(Number(e.target.value))}
              className="h-1 w-20 accent-rvbbit-accent"
            />
            <span className="w-7 font-mono tabular-nums text-foreground">{minGain}%</span>
          </label>

          <label className="inline-flex items-center gap-1.5 text-[10px] text-chrome-text/85">
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
            />
            activate after rebuild
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[9px] uppercase tracking-wider text-chrome-text/45">
            candidates
          </span>
          {ENGINES.map((e) => {
            const on = selected.includes(e.id)
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => toggleCand(e.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px]",
                  on
                    ? "border-rvbbit-accent/40 text-foreground"
                    : "border-chrome-border bg-doc-bg text-chrome-text/55 opacity-70",
                )}
                style={
                  on
                    ? {
                        background: `color-mix(in oklch, ${e.color} 18%, transparent)`,
                      }
                    : undefined
                }
              >
                <EngineDot id={e.id} />
                {e.label}
                {on ? <Check className="h-2.5 w-2.5" /> : null}
              </button>
            )
          })}
          <span className="ml-2 text-[9px] text-chrome-text/45">→ {candsSummary}</span>
        </div>

        {/* Preview shape */}
        {explain ? (
          <ExplainPreview explain={explain} />
        ) : explainErr ? (
          <div className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            <span className="font-mono">{explainErr}</span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onPreview}
            disabled={!sql.trim() || explainBusy}
            className="inline-flex items-center gap-1 rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px] text-chrome-text/85 hover:border-rvbbit-accent/40 hover:text-foreground disabled:opacity-40"
          >
            <Pencil className="h-3 w-3" />
            preview shape
          </button>
          <button
            type="button"
            disabled={!sql.trim() || isTraining}
            onClick={() =>
              onTrain({
                sql,
                label,
                repeats,
                minGainPct: minGain / 100,
                activate,
                candidates: selected,
              })
            }
            className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-bg px-2 py-0.5 text-[10px] font-medium text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
          >
            {isTraining ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                training… stay put
              </>
            ) : (
              <>
                <Play className="h-3 w-3" />
                train
                <span className="text-[9px] text-rvbbit-accent/60">⌘⏎</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={isTraining}
            className="rounded border border-chrome-border bg-doc-bg px-2 py-0.5 text-[10px] text-chrome-text/65 hover:text-foreground disabled:opacity-40"
          >
            clear
          </button>
          <span className="ml-1 text-[9px] text-chrome-text/40">
            executes the query {repeats}× per candidate
          </span>
        </div>
      </div>
    </Panel>
  )
}

function ExplainPreview({ explain }: { explain: RouteExplain }) {
  const m = engineMeta(explain.chosenCandidate)
  const f = explain.features
  const shapeKey = typeof f.shape_key === "string" ? (f.shape_key as string) : ""
  const tableRows =
    typeof f.table_rows === "number" ? (f.table_rows as number) : null
  return (
    <div
      className="rounded border px-2 py-1 text-[10px]"
      style={{
        borderColor: `color-mix(in oklch, ${m.color} 35%, var(--chrome-border))`,
        background: `color-mix(in oklch, ${m.color} 5%, transparent)`,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[9px] uppercase tracking-wider text-chrome-text/55">
          would route to
        </span>
        <span
          className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold"
          style={{ color: m.color }}
        >
          <EngineDot id={explain.chosenCandidate} />
          {m.label}
        </span>
        <span className="font-mono text-[9px] text-chrome-text/55">
          via {explain.routeSource || "—"}
        </span>
        {tableRows != null ? (
          <span className="font-mono text-[9px] text-chrome-text/55">
            · {fmtCount(tableRows)} rows
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-px text-[8px] uppercase tracking-wider",
            explain.safeSelect
              ? "bg-success/15 text-success"
              : "bg-warning/15 text-warning",
          )}
        >
          {explain.safeSelect ? "safe" : "rejected by training"}
        </span>
      </div>
      {shapeKey ? (
        <div className="mt-1">
          <ShapeChips shape={shapeKey} limit={6} />
        </div>
      ) : null}
    </div>
  )
}

// ── Profile side panels (when no query is selected) ─────────────────

function ProfileSidePanels({ bundle }: { bundle: ProfileBundle }) {
  return (
    <>
      <Panel
        icon={Target}
        title="accepted entries"
        right={<span>{bundle.entries.length} shapes</span>}
      >
        {bundle.entries.length === 0 ? (
          <p className="text-[11px] text-chrome-text/55">
            No accepted entries yet — rebuild after training to populate.
          </p>
        ) : (
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 z-[1] bg-secondary-background text-[9px] uppercase tracking-wider text-chrome-text/45">
                <tr>
                  <th className="py-1 pr-2 text-left font-medium">shape</th>
                  <th className="py-1 pr-2 text-left font-medium">routes to</th>
                  <th className="py-1 pr-2 text-right font-medium">conf</th>
                  <th className="py-1 pr-2 text-right font-medium">obs</th>
                </tr>
              </thead>
              <tbody>
                {bundle.entries.slice(0, 100).map((e, i) => (
                  <tr key={i} className="border-t border-chrome-border/30 align-middle">
                    <td className="max-w-0 py-1 pr-2">
                      <ShapeChips shape={e.shapeKey} limit={4} />
                    </td>
                    <td className="py-1 pr-2">
                      <EnginePill id={e.choice} />
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-[10px] tabular-nums text-chrome-text/70">
                      {(e.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="py-1 pr-2 text-right font-mono text-[10px] tabular-nums text-chrome-text/70">
                      {e.observations}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        icon={Cpu}
        title="rejected shapes"
        right={<span>{bundle.rejected.length}</span>}
      >
        {bundle.rejected.length === 0 ? (
          <p className="text-[11px] text-chrome-text/55">
            Nothing rejected — every measured shape has an accepted entry.
          </p>
        ) : (
          <div className="max-h-[220px] space-y-1.5 overflow-auto">
            {bundle.rejected.slice(0, 60).map((r, i) => (
              <div
                key={i}
                className="rounded border border-chrome-border/40 bg-doc-bg px-2 py-1.5"
              >
                <div className="flex items-baseline gap-2">
                  <ShapeChips shape={r.shapeKey} limit={4} />
                  {r.candidate ? (
                    <span className="ml-auto">
                      <EnginePill id={r.candidate} dim />
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[10px] text-chrome-text/65">
                  {r.reason || "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  )
}
