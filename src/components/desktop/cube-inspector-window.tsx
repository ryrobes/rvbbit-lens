"use client"

// ⊞ Cube Inspector — master-detail over the curated cubes. A left rail of cubes (listCubes) and a
// right pane that grounds ONE cube: Overview (def + sample + actions), Columns (the semantic layer,
// inline-editable), Health (freshness/staleness/drift/usage), Lineage (source tables). Actions:
// Refresh (snapshot reload), Enrich (LLM column docs), Promote to Metric, Edit (→ Creator).

import { useCallback, useEffect, useMemo, useState } from "react"
import { Boxes, RefreshCw, Sparkles, Pencil, Loader2, TrendingUp, GitBranch, Layers, ChevronRight } from "@/lib/icons"
import {
  cubeVersions,
  describeCube,
  enrichCube,
  listCubes,
  promoteCubeToMetric,
  refreshCube,
  revertCube,
  type CubeDetail,
  type CubeSummary,
  type CubeVersion,
} from "@/lib/rvbbit/cubes"
import type { CubeInspectorPayload } from "@/lib/desktop/types"
import {
  CubeColumnDocEditor,
  DriftGauge,
  fmtAgo,
  fmtTime,
  formatSqlSafe,
  HealthBadge,
  HealthStat,
  ProvenanceTag,
  Section,
  StatusNote,
} from "./cube-shared"

interface Props {
  payload: CubeInspectorPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenCreator: (name?: string) => void
  onOpenMetricInspector?: (name: string) => void
}

type Tab = "overview" | "columns" | "health" | "lineage" | "versions"
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", columns: "Columns", health: "Health", lineage: "Lineage", versions: "Versions" }

export function CubeInspectorWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenCreator,
  onOpenMetricInspector,
}: Props) {
  const [cubes, setCubes] = useState<CubeSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(payload.cubeName ?? null)
  const [listReloadKey, setListReloadKey] = useState(0)

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const { cubes: rows, error } = await listCubes(activeConnectionId)
      if (cancelled) return
      setCubes(rows)
      setListError(error)
      setSelectedName((cur) => cur ?? rows[0]?.name ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, listReloadKey])

  // re-open for a different cube updates the payload on the mounted window
  const [lastOpenName, setLastOpenName] = useState(payload.cubeName)
  if (payload.cubeName && payload.cubeName !== lastOpenName) {
    setLastOpenName(payload.cubeName)
    setSelectedName(payload.cubeName)
  }

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* LEFT RAIL */}
        <div className="w-52 shrink-0 overflow-y-auto border-r border-chrome-border/50">
          <div className="flex items-center gap-1.5 border-b border-chrome-border/50 px-3 py-2">
            <Boxes className="h-3.5 w-3.5 text-main" />
            <span className="text-[11px] uppercase tracking-wider text-chrome-text/60">Cubes</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setListReloadKey((k) => k + 1)}
              title="Reload cubes"
              className="rounded p-1 text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {cubes == null ? (
            <StatusNote state="loading" />
          ) : listError ? (
            <StatusNote state="error" message={listError} />
          ) : cubes.length === 0 ? (
            <StatusNote state="empty" message="No cubes defined yet." />
          ) : (
            <div className="py-1">
              {cubes.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setSelectedName(c.name)}
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                    selectedName === c.name ? "bg-main/10" : "hover:bg-foreground/[0.04]"
                  }`}
                >
                  <span className={`font-mono text-[12px] ${selectedName === c.name ? "text-main" : "text-foreground"}`}>
                    {c.name}
                  </span>
                  <span className="truncate text-[10px] text-chrome-text/45" title={c.grain ?? undefined}>
                    {c.grain ?? "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT PANE */}
        {selectedName ? (
          <CubeDetailPane
            key={selectedName}
            connectionId={activeConnectionId}
            name={selectedName}
            onOpenCreator={onOpenCreator}
            onOpenMetricInspector={onOpenMetricInspector}
            onChanged={() => setListReloadKey((k) => k + 1)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <StatusNote state="empty" message="Select a cube." />
          </div>
        )}
      </div>
    </div>
  )
}

function CubeDetailPane({
  connectionId,
  name,
  onOpenCreator,
  onOpenMetricInspector,
  onChanged,
}: {
  connectionId: string
  name: string
  onOpenCreator: (name?: string) => void
  onOpenMetricInspector?: (name: string) => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<CubeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTab] = useState<Tab>("overview")
  const [busy, setBusy] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  // Defer to a microtask so we don't call setState synchronously in the effect body.
  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      void (async () => {
        setLoading(true)
        const { cube, error: err } = await describeCube(connectionId, name)
        if (cancelled) return
        setDetail(cube)
        setError(err)
        setLoading(false)
      })()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [connectionId, name, reloadKey])

  async function doRefresh() {
    setBusy("refresh")
    setActionMsg(null)
    const { rows, error: err } = await refreshCube(connectionId, name)
    setBusy(null)
    setActionMsg(err ? `Refresh failed: ${err}` : `Refreshed — ${rows ?? "?"} rows.`)
    if (!err) {
      reload()
      onChanged()
    }
  }

  async function doEnrich() {
    setBusy("enrich")
    setActionMsg(null)
    const { result, error: err } = await enrichCube(connectionId, name)
    setBusy(null)
    setActionMsg(err ? `Enrich failed: ${err}` : `Enriched ${result?.columns_enriched ?? "?"} columns.`)
    if (!err) reload()
  }

  const sql = useMemo(() => formatSqlSafe(detail?.sql), [detail?.sql])

  if (loading && !detail) return <StatusNote state="loading" message="Loading cube…" />
  if (error) return <StatusNote state="error" message={error} />
  if (!detail) return <StatusNote state="empty" message="Cube not found." />

  const health = detail.health

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-chrome-border/50 px-3 py-2">
        <span className="font-mono text-[13px] text-foreground">{detail.name}</span>
        <span className="text-[10px] text-chrome-text/45">v{detail.version}</span>
        {health ? <HealthBadge status={health.status} /> : null}
        <div className="flex-1" />
        <ActionBtn icon={RefreshCw} label="Refresh" busy={busy === "refresh"} onClick={() => void doRefresh()} />
        <ActionBtn icon={Sparkles} label="Enrich" busy={busy === "enrich"} onClick={() => void doEnrich()} />
        <PromoteButton
          connectionId={connectionId}
          cube={name}
          onOpenMetricInspector={onOpenMetricInspector}
          onMessage={setActionMsg}
        />
        <button
          type="button"
          onClick={() => onOpenCreator(name)}
          title="Edit in Creator (saves a new version)"
          className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>
      </div>

      {actionMsg ? (
        <div className="border-b border-chrome-border/30 bg-foreground/[0.02] px-3 py-1 text-[11px] text-chrome-text/70">
          {actionMsg}
        </div>
      ) : null}

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-chrome-border/40 px-2 py-1">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-[3px] px-2 py-0.5 text-[11px] ${
              tab === t ? "bg-main/15 text-main" : "text-chrome-text/60 hover:bg-foreground/[0.05] hover:text-foreground"
            }`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? (
          <div>
            <Section title="About">
              <div className="space-y-1.5 text-[12px]">
                <div className="text-foreground/90">{detail.description ?? <span className="text-chrome-text/35">No description.</span>}</div>
                <Meta label="Grain" value={detail.grain} />
                <Meta label="Category" value={detail.category} />
                <Meta label="Rows" value={detail.rows?.toLocaleString() ?? null} />
                <Meta label="Refreshed" value={detail.refreshedAt ? fmtTime(Date.parse(detail.refreshedAt)) : null} />
                <Meta label="Enriched" value={detail.enrichedAt ? fmtTime(Date.parse(detail.enrichedAt)) : null} />
              </div>
            </Section>
            <Section title="Definition SQL">
              <pre className="overflow-auto rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02] p-2 font-mono text-[11px] leading-snug text-foreground/85">
                {sql}
              </pre>
            </Section>
            <Section title={`Sample (${detail.sample.length})`}>
              <SampleGrid rows={detail.sample} />
            </Section>
          </div>
        ) : tab === "columns" ? (
          <ColumnsTab connectionId={connectionId} cube={name} detail={detail} onSaved={reload} />
        ) : tab === "health" ? (
          <HealthTab health={health} />
        ) : tab === "lineage" ? (
          <LineageTab tables={detail.sourceTables} />
        ) : (
          <VersionsTab connectionId={connectionId} cube={name} currentVersion={detail.version} onReverted={reload} />
        )}
      </div>
    </div>
  )
}

function ActionBtn({
  icon: Icon,
  label,
  busy,
  onClick,
}: {
  icon: typeof RefreshCw
  label: string
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />} {label}
    </button>
  )
}

function PromoteButton({
  connectionId,
  cube,
  onOpenMetricInspector,
  onMessage,
}: {
  connectionId: string
  cube: string
  onOpenMetricInspector?: (name: string) => void
  onMessage: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [metricName, setMetricName] = useState(`${cube}_metric`)
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    const { version, error } = await promoteCubeToMetric(connectionId, cube, metricName.trim())
    setBusy(false)
    setOpen(false)
    if (error) {
      onMessage(`Promote failed: ${error}`)
      return
    }
    onMessage(`Promoted to metric ${metricName} (v${version}).`)
    onOpenMetricInspector?.(metricName.trim())
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Create a blessed metric over this cube"
        className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <TrendingUp className="h-3 w-3" /> Promote
      </button>
    )
  }
  return (
    <div className="inline-flex items-center gap-1">
      <input
        value={metricName}
        onChange={(e) => setMetricName(e.target.value)}
        className="h-7 w-36 rounded-[3px] border border-main/40 bg-foreground/[0.03] px-2 font-mono text-[11px] text-foreground outline-none focus:bg-foreground/[0.06]"
        placeholder="metric name"
      />
      <button
        type="button"
        onClick={() => void go()}
        disabled={busy || !metricName.trim()}
        className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-main/40 bg-main/15 px-2 text-[11px] text-main hover:bg-main/25 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <TrendingUp className="h-3 w-3" />} Go
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-chrome-text/45 hover:text-foreground">
        ✕
      </button>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-chrome-text/45">{label}</span>
      <span className="text-[12px] text-chrome-text/80">{value ?? <span className="text-chrome-text/30">—</span>}</span>
    </div>
  )
}

function ColumnsTab({
  connectionId,
  cube,
  detail,
  onSaved,
}: {
  connectionId: string
  cube: string
  detail: CubeDetail
  onSaved: () => void
}) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead className="sticky top-0 z-10 bg-chrome-bg text-[10px] uppercase tracking-wider text-chrome-text/55">
        <tr className="border-b border-chrome-border/50">
          <th className="px-3 py-1 text-left font-normal">Column</th>
          <th className="px-2 py-1 text-left font-normal">Type</th>
          <th className="px-2 py-1 text-left font-normal">Doc / semantics</th>
          <th className="px-2 py-1 text-left font-normal">Source</th>
          <th className="px-2 py-1 text-right font-normal">Conf</th>
          <th className="px-2 py-1 text-left font-normal">By</th>
        </tr>
      </thead>
      <tbody>
        {detail.columns.map((col) => (
          <tr key={col.name} className="group border-b border-chrome-border/20 align-top hover:bg-foreground/[0.02]">
            <td className="px-3 py-1.5 font-mono text-foreground">{col.name}</td>
            <td className="px-2 py-1.5 font-mono text-[11px] text-chrome-text/55">{col.type ?? "—"}</td>
            <td className="max-w-[360px] px-2 py-1.5">
              <CubeColumnDocEditor connectionId={connectionId} cube={cube} column={col} onSaved={onSaved} />
            </td>
            <td className="max-w-[160px] px-2 py-1.5 font-mono text-[10px] text-chrome-text/50">
              <span className="block truncate" title={col.sourceRef ?? undefined}>
                {col.sourceRef ?? "—"}
              </span>
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-chrome-text/60">
              {col.confidence == null ? "—" : col.confidence.toFixed(2)}
            </td>
            <td className="px-2 py-1.5">
              <ProvenanceTag editedBy={col.editedBy} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HealthTab({ health }: { health: CubeDetail["health"] }) {
  if (!health) return <StatusNote state="empty" message="No health data." />
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <HealthBadge status={health.status} size="md" />
        {health.lastError ? <span className="text-[11px] text-danger">{health.lastError}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <HealthStat label="Last refresh" value={fmtAgo(health.secondsSinceRefresh)} />
        <HealthStat label="Current rows" value={health.currentRows?.toLocaleString() ?? "—"} />
        <HealthStat label="Row Δ since refresh" value={health.rowDelta == null ? "—" : health.rowDelta.toLocaleString()} />
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-chrome-text/45">Drift</div>
        <DriftGauge ratio={health.driftRatio} recommendation={health.driftRecommendation} />
      </div>
    </div>
  )
}

function LineageTab({ tables }: { tables: string[] }) {
  if (!tables.length) return <StatusNote state="empty" message="No source tables detected." />
  return (
    <div className="space-y-1 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-chrome-text/45">
        <GitBranch className="h-3 w-3" /> Reads from
      </div>
      {tables.map((t) => (
        <div
          key={t}
          className="flex items-center gap-2 rounded-[3px] border border-chrome-border/30 bg-foreground/[0.02] px-2.5 py-1 font-mono text-[12px] text-chrome-text/80"
        >
          {t}
        </div>
      ))}
    </div>
  )
}

// ── Versions: the cube's def history + revert-to ────────────────────────────
function VersionsTab({
  connectionId,
  cube,
  currentVersion,
  onReverted,
}: {
  connectionId: string
  cube: string
  currentVersion: number | null
  onReverted: () => void
}) {
  const [versions, setVersions] = useState<CubeVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    const id = setTimeout(() => {
      void (async () => {
        const { versions: rows, error: err } = await cubeVersions(connectionId, cube)
        if (cancelled) return
        setVersions(rows)
        setError(err)
      })()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [connectionId, cube, reloadKey])

  // the live/current version is the highest (cube_versions returns newest first)
  const latest = versions && versions.length ? versions[0].version : currentVersion

  async function revert(v: number) {
    setBusy(v)
    setMsg(null)
    const { newVersion, error: err } = await revertCube(connectionId, cube, v)
    setBusy(null)
    if (err) {
      setMsg(`Revert failed: ${err}`)
      return
    }
    setMsg(`Reverted to v${v} → now live as v${newVersion}.`)
    setReloadKey((k) => k + 1)
    onReverted()
  }

  if (versions == null) return <StatusNote state="loading" message="Loading versions…" />
  if (error) return <StatusNote state="error" message={error} />
  if (versions.length === 0) return <StatusNote state="empty" message="No version history." />

  return (
    <div className="p-3">
      {msg ? <div className="mb-2 text-[11px] text-chrome-text/70">{msg}</div> : null}
      <div className="space-y-1.5">
        {versions.map((v) => {
          const isCurrent = v.version === latest
          const open = expanded === v.version
          return (
            <div key={v.version} className="rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02]">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : v.version)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title="Show this version's SQL"
                >
                  <ChevronRight className={`h-3 w-3 shrink-0 text-chrome-text/40 transition-transform ${open ? "rotate-90" : ""}`} />
                  <span className="font-mono text-[12px] text-foreground">v{v.version}</span>
                  {isCurrent ? (
                    <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-emerald-500">
                      current
                    </span>
                  ) : null}
                  <span className="truncate text-[10px] text-chrome-text/45">
                    {v.grain ?? ""}
                    {v.category ? ` · ${v.category}` : ""}
                  </span>
                  <div className="flex-1" />
                  <span className="shrink-0 text-[10px] tabular-nums text-chrome-text/40">
                    {v.createdAt ? fmtTime(Date.parse(v.createdAt)) : ""}
                  </span>
                </button>
                {!isCurrent ? (
                  <button
                    type="button"
                    onClick={() => void revert(v.version)}
                    disabled={busy != null}
                    title={`Restore this definition (appends a new version)`}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
                  >
                    {busy === v.version ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Revert to v{v.version}
                  </button>
                ) : null}
              </div>
              {open ? (
                <pre className="max-h-56 overflow-auto border-t border-chrome-border/30 px-2.5 py-1.5 font-mono text-[10px] leading-snug text-foreground/80">
                  {formatSqlSafe(v.sql)}
                </pre>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-chrome-text/40">
        <Layers className="h-3 w-3" /> Reverting appends a new version restoring the old definition — nothing is lost.
      </div>
    </div>
  )
}

function SampleGrid({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (!rows.length) return <div className="text-[11px] text-chrome-text/35">No sample rows.</div>
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s }, new Set<string>()))
  return (
    <div className="overflow-auto rounded-[3px] border border-chrome-border/40">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-chrome-bg/60 text-[9px] uppercase tracking-wider text-chrome-text/50">
          <tr>
            {cols.map((c) => (
              <th key={c} className="border-b border-chrome-border/40 px-2 py-1 text-left font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-chrome-border/15">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 font-mono text-chrome-text/75">
                  {r[c] == null ? <span className="text-chrome-text/25">∅</span> : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
