"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  DollarSign,
  RefreshCw,
  Save,
  Search,
  Settings2,
} from "@/lib/icons"
import { cn } from "@/lib/utils"
import { fmtAgo, fmtCount } from "./instruments"
import {
  fetchModelSettingsBundle,
  saveOperatorModel,
  saveScopeModel,
  type ModelRate,
  type ModelScopeId,
  type ModelSettingsBundle,
  type ModelUsage,
  type OperatorModelSetting,
  type ScopeModelSetting,
} from "@/lib/rvbbit/model-settings"
import type { LlmModel } from "@/lib/rvbbit/operators"

interface ModelSettingsWindowProps {
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenOperator: (name: string | null) => void
  onOpenCosts: (initialFilter?: {
    operator?: string | null
    model?: string | null
  }) => void
}

type OperatorScopeFilter = "all" | OperatorModelSetting["scope"]

function modelId(m: LlmModel): string {
  return m.model
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n < 0.01) return "<$0.01"
  if (n < 10) return `$${n.toFixed(2)}`
  if (n < 1000) return `$${n.toFixed(0)}`
  return `$${(n / 1000).toFixed(1)}k`
}

function fmtRate(rate: ModelRate | undefined): string {
  if (!rate || rate.inputPerMtok == null || rate.outputPerMtok == null) return "rate unknown"
  return `$${rate.inputPerMtok}/$${rate.outputPerMtok} per Mtok`
}

function fmtRateShort(rate: ModelRate | undefined): string {
  if (!rate || rate.inputPerMtok == null || rate.outputPerMtok == null) return ""
  return `$${rate.inputPerMtok}/${rate.outputPerMtok}/M`
}

function lastAtLabel(iso: string | null): string {
  return iso ? fmtAgo(new Date(iso).getTime()) : "never"
}

function scopeTone(scope: OperatorModelSetting["scope"]): string {
  switch (scope) {
    case "cube":
      return "bg-warning/10 text-warning"
    case "semantic":
      return "bg-rvbbit-accent/10 text-rvbbit-accent"
    case "agent":
      return "bg-brand-warren/15 text-brand-warren"
    case "pipeline":
      return "bg-info/10 text-info"
    default:
      return "bg-foreground/[0.06] text-chrome-text/70"
  }
}

export function ModelSettingsWindow({
  activeConnectionId,
  hasRvbbit,
  onOpenOperator,
  onOpenCosts,
}: ModelSettingsWindowProps) {
  const [bundle, setBundle] = useState<ModelSettingsBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [scopeFilter, setScopeFilter] = useState<OperatorScopeFilter>("all")
  const [draftScopes, setDraftScopes] = useState<Record<ModelScopeId, string>>({
    semantic: "",
    cube: "",
  })
  const [draftOperators, setDraftOperators] = useState<Record<string, string>>({})

  const reload = useCallback(async () => {
    if (!activeConnectionId || !hasRvbbit) return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchModelSettingsBundle(activeConnectionId)
      setBundle(next)
      setDraftScopes({
        semantic: next.scopes.find((s) => s.id === "semantic")?.currentModel ?? "",
        cube: next.scopes.find((s) => s.id === "cube")?.currentModel ?? "",
      })
      setDraftOperators(
        Object.fromEntries(next.operators.map((op) => [op.operator, op.model])),
      )
      setError(next.errors[0] ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId, hasRvbbit])

  useEffect(() => {
    void reload()
  }, [reload])

  const usageByModel = useMemo(() => {
    const m = new Map<string, ModelUsage>()
    for (const row of bundle?.modelUsage ?? []) m.set(row.model, row)
    return m
  }, [bundle])

  const rateByModel = useMemo(() => {
    const m = new Map<string, ModelRate>()
    for (const row of bundle?.rates ?? []) m.set(row.model, row)
    return m
  }, [bundle])

  const filteredOperators = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (bundle?.operators ?? []).filter((op) => {
      if (scopeFilter !== "all" && op.scope !== scopeFilter) return false
      if (!q) return true
      return (
        op.operator.toLowerCase().includes(q) ||
        op.model.toLowerCase().includes(q) ||
        (op.description ?? "").toLowerCase().includes(q)
      )
    })
  }, [bundle, query, scopeFilter])

  const totalCalls = bundle?.modelUsage.reduce((sum, row) => sum + row.calls, 0) ?? 0
  const totalCost = bundle?.modelUsage.reduce((sum, row) => sum + row.totalCostUsd, 0) ?? 0

  const saveScope = async (scope: ScopeModelSetting) => {
    const model = draftScopes[scope.id]?.trim()
    if (!activeConnectionId || !model) return
    setSaving(`scope:${scope.id}`)
    setNotice(null)
    const res = await saveScopeModel(activeConnectionId, scope.id, model)
    setSaving(null)
    if (res.error) {
      setError(res.error)
      return
    }
    window.dispatchEvent(new CustomEvent("rvbbit-lens:operators-changed"))
    setNotice(`${scope.label}: ${res.changed} operator${res.changed === 1 ? "" : "s"} updated`)
    await reload()
  }

  const saveOperator = async (op: OperatorModelSetting) => {
    const model = draftOperators[op.operator]?.trim()
    if (!activeConnectionId || !model) return
    setSaving(`operator:${op.operator}`)
    setNotice(null)
    const res = await saveOperatorModel(activeConnectionId, op.operator, model)
    setSaving(null)
    if (res.error) {
      setError(res.error)
      return
    }
    window.dispatchEvent(new CustomEvent("rvbbit-lens:operators-changed"))
    setNotice(`${op.operator}: model updated`)
    await reload()
  }

  if (!activeConnectionId) {
    return (
      <Centered icon={Brain}>Connect to a database to manage semantic model settings.</Centered>
    )
  }

  if (!hasRvbbit) {
    return (
      <Centered icon={Brain}>
        This connection has no <span className="font-mono">pg_rvbbit</span> extension.
      </Centered>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px] text-chrome-text">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Brain className="h-3.5 w-3.5 text-rvbbit-accent" />
          Model Settings
        </span>
        <span className="text-chrome-text/40">·</span>
        <span>{bundle ? `${bundle.models.length} available models` : "loading models"}</span>
        <span className="text-chrome-text/40">·</span>
        <button
          type="button"
          onClick={() => onOpenCosts()}
          className="inline-flex items-center gap-1 text-chrome-text hover:text-foreground"
          title="Open Costs"
        >
          <DollarSign className="h-3 w-3" />
          <span className="font-mono tabular-nums text-foreground">{fmtUsd(totalCost)}</span>
          <span>{fmtCount(totalCalls)} calls · 30d</span>
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          {notice ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-success">
              <CheckCircle2 className="h-3 w-3" />
              {notice}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            title="Reload"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <div className="border-b border-chrome-border/60 bg-secondary-background/30">
          <div className="grid gap-px bg-chrome-border/40 md:grid-cols-2">
            {(bundle?.scopes ?? []).map((scope) => (
              <ScopeRow
                key={scope.id}
                scope={scope}
                models={bundle?.models ?? []}
                value={draftScopes[scope.id] ?? ""}
                usageByModel={usageByModel}
                rateByModel={rateByModel}
                saving={saving === `scope:${scope.id}`}
                onChange={(v) => setDraftScopes((prev) => ({ ...prev, [scope.id]: v }))}
                onSave={() => void saveScope(scope)}
                onOpenCosts={() => onOpenCosts({ operator: null, model: draftScopes[scope.id] || null })}
              />
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/45" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search operators, models, descriptions"
                className="h-7 w-full rounded border border-chrome-border bg-secondary-background pl-7 pr-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <select
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value as OperatorScopeFilter)}
              className="h-7 rounded border border-chrome-border bg-secondary-background px-2 text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">all scopes</option>
              <option value="semantic">semantic</option>
              <option value="cube">cube</option>
              <option value="agent">agent</option>
              <option value="pipeline">pipeline</option>
              <option value="other">other</option>
            </select>
            <span className="text-[11px] text-chrome-text/55">
              {filteredOperators.length} operator{filteredOperators.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-secondary-background text-[10px] uppercase tracking-wider text-chrome-text/55">
                <tr className="[&>th]:border-b [&>th]:border-chrome-border [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                  <th>Operator</th>
                  <th>Scope</th>
                  <th>Model</th>
                  <th>Steps</th>
                  <th className="text-right">30d</th>
                  <th className="w-20 text-right">Save</th>
                </tr>
              </thead>
              <tbody>
                {filteredOperators.map((op) => (
                  <OperatorRow
                    key={op.operator}
                    op={op}
                    models={bundle?.models ?? []}
                    usageByModel={usageByModel}
                    rateByModel={rateByModel}
                    value={draftOperators[op.operator] ?? op.model}
                    saving={saving === `operator:${op.operator}`}
                    onChange={(v) =>
                      setDraftOperators((prev) => ({ ...prev, [op.operator]: v }))
                    }
                    onSave={() => void saveOperator(op)}
                    onOpenOperator={() => onOpenOperator(op.operator)}
                    onOpenCosts={() => onOpenCosts({ operator: op.operator })}
                  />
                ))}
              </tbody>
            </table>
            {!loading && filteredOperators.length === 0 ? (
              <div className="grid h-28 place-items-center text-[12px] text-chrome-text/55">
                No operators match the current filter.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function ScopeRow({
  scope,
  models,
  value,
  usageByModel,
  rateByModel,
  saving,
  onChange,
  onSave,
  onOpenCosts,
}: {
  scope: ScopeModelSetting
  models: LlmModel[]
  value: string
  usageByModel: Map<string, ModelUsage>
  rateByModel: Map<string, ModelRate>
  saving: boolean
  onChange: (value: string) => void
  onSave: () => void
  onOpenCosts: () => void
}) {
  const dirty = value.trim().length > 0 && (scope.mixed || value !== scope.currentModel)
  const dist = scope.distribution.slice(0, 3)
  return (
    <section className="min-w-0 bg-chrome-bg/55 p-3">
      <div className="mb-2 flex items-start gap-2">
        <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-rvbbit-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[12px] font-semibold text-foreground">{scope.label}</h3>
            <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-chrome-text/70">
              {scope.operatorCount} ops
            </span>
            {scope.mixed ? (
              <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                mixed
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-chrome-text/55">{scope.detail}</div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <ModelSelect
          value={value}
          models={models}
          usageByModel={usageByModel}
          rateByModel={rateByModel}
          onChange={onChange}
        />
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={onSave}
          className={cn(
            "inline-flex h-8 items-center justify-center gap-1 rounded border px-2 text-[11px]",
            dirty
              ? "border-main/40 bg-main/15 text-main hover:bg-main/25"
              : "border-chrome-border bg-foreground/[0.03] text-chrome-text/35",
          )}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving" : "Save"}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-chrome-text/55">
        <button type="button" onClick={onOpenCosts} className="hover:text-foreground">
          <span className="font-mono tabular-nums text-foreground">{fmtUsd(scope.cost30d)}</span>{" "}
          · {fmtCount(scope.calls30d)} calls
        </button>
        <span className="font-mono">{scope.setter}</span>
        {dist.map((d) => (
          <span key={d.model} className="min-w-0 truncate">
            {d.model}: {d.operators}
          </span>
        ))}
      </div>
    </section>
  )
}

function OperatorRow({
  op,
  models,
  value,
  usageByModel,
  rateByModel,
  saving,
  onChange,
  onSave,
  onOpenOperator,
  onOpenCosts,
}: {
  op: OperatorModelSetting
  models: LlmModel[]
  value: string
  usageByModel: Map<string, ModelUsage>
  rateByModel: Map<string, ModelRate>
  saving: boolean
  onChange: (value: string) => void
  onSave: () => void
  onOpenOperator: () => void
  onOpenCosts: () => void
}) {
  const dirty = value.trim().length > 0 && value !== op.model
  return (
    <tr className="border-b border-chrome-border/50 align-top hover:bg-foreground/[0.035]">
      <td className="min-w-56 px-3 py-2">
        <button
          type="button"
          onClick={onOpenOperator}
          className="font-mono text-[12px] text-foreground hover:text-main"
        >
          {op.operator}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-chrome-text/55">
          <span>{op.shape}</span>
          {op.description ? <span className="max-w-72 truncate">{op.description}</span> : null}
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", scopeTone(op.scope))}>
          {op.scope}
        </span>
      </td>
      <td className="w-[34%] min-w-72 px-3 py-2">
        <ModelSelect
          value={value}
          models={models}
          usageByModel={usageByModel}
          rateByModel={rateByModel}
          onChange={onChange}
        />
        <div className="mt-1 truncate text-[10px] text-chrome-text/45">
          current <span className="font-mono">{op.model}</span>
        </div>
      </td>
      <td className="max-w-56 px-3 py-2 text-[10px] text-chrome-text/60">
        {op.explicitStepModels ? (
          <div className="space-y-1">
            <div className="text-warning">explicit step model{op.stepModels.length === 1 ? "" : "s"}</div>
            <div className="truncate font-mono text-chrome-text/70">{op.stepModels.join(", ")}</div>
          </div>
        ) : (
          <div className="text-success">inherits catalog model</div>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <button type="button" onClick={onOpenCosts} className="hover:text-foreground">
          <div className="font-mono tabular-nums text-foreground">{fmtUsd(op.cost30d)}</div>
          <div className="text-[10px] text-chrome-text/55">
            {fmtCount(op.calls30d)} calls · {lastAtLabel(op.lastAt)}
          </div>
        </button>
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={onSave}
          className={cn(
            "inline-grid h-7 w-7 place-items-center rounded border",
            dirty
              ? "border-main/40 bg-main/15 text-main hover:bg-main/25"
              : "border-chrome-border bg-foreground/[0.03] text-chrome-text/35",
          )}
          title="Save model"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}

function ModelSelect({
  value,
  models,
  usageByModel,
  rateByModel,
  onChange,
}: {
  value: string
  models: LlmModel[]
  usageByModel: Map<string, ModelUsage>
  rateByModel: Map<string, ModelRate>
  onChange: (value: string) => void
}) {
  const groups = useMemo(() => {
    const g = new Map<string, LlmModel[]>()
    for (const model of models) {
      const arr = g.get(model.provider) ?? []
      arr.push(model)
      g.set(model.provider, arr)
    }
    return [...g.entries()]
  }, [models])
  const inCatalog = models.some((m) => modelId(m) === value)
  const rate = rateByModel.get(value)
  return (
    <div className="min-w-0">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
      >
        {!value ? <option value="">select model...</option> : null}
        {value && !inCatalog ? <option value={value}>{value} (current)</option> : null}
        {groups.map(([provider, ms]) => (
          <optgroup key={provider} label={provider}>
            {ms.map((m) => {
              const id = modelId(m)
              const usage = usageByModel.get(id)
              const r = rateByModel.get(id)
              const labelParts = [
                m.displayName && m.displayName !== m.model ? `${m.displayName} (${id})` : id,
                usage ? `${fmtUsd(usage.totalCostUsd)} / ${fmtCount(usage.calls)} calls` : null,
                fmtRateShort(r) || null,
              ].filter(Boolean)
              return (
                <option key={id} value={id}>
                  {labelParts.join(" · ")}
                </option>
              )
            })}
          </optgroup>
        ))}
      </select>
      <div className="mt-1 truncate text-[10px] text-chrome-text/45">
        {fmtRate(rate)}
        {usageByModel.get(value) ? (
          <>
            {" "}
            · {fmtUsd(usageByModel.get(value)?.totalCostUsd ?? 0)} /{" "}
            {fmtCount(usageByModel.get(value)?.calls ?? 0)} calls
          </>
        ) : null}
      </div>
    </div>
  )
}

function Centered({
  children,
  icon: Icon,
}: {
  children: ReactNode
  icon: typeof Brain
}) {
  return (
    <div className="grid h-full place-items-center p-6 text-center text-[12px] text-chrome-text/70">
      <div>
        <Icon className="mx-auto mb-2 h-6 w-6 text-chrome-text/40" />
        {children}
      </div>
    </div>
  )
}
