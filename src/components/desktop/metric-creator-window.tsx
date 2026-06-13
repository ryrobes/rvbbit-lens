"use client"

// ✎ Metric Creator — author + version SQL metrics with a LIVE resolved-SQL
// preview. Master-detail: left rail lists existing metrics (+ New); the right
// pane is the editor form. Editing an existing metric keeps the Name fixed
// (Save appends a NEW VERSION); "New" clears + unlocks Name. The preview pane
// is the debuggable surface — it shows raw preview errors verbatim.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, RefreshCw, Save, Sparkles, Wand2, Loader2, Play } from "@/lib/icons"
import {
  defineMetric,
  listMetrics,
  previewCheckSql,
  previewMetricSql,
  proposeMetric,
  type MetricProposeResult,
  type MetricSummary,
  type MetricVerdict,
} from "@/lib/rvbbit/metrics"
import { listBaseTables, listCubes } from "@/lib/rvbbit/cubes"
import { categoriesFrom, fetchCategoryOptions, setCategory, subcategoriesFor, type CategoryPair } from "@/lib/rvbbit/categories"
import type { MetricCreatorPayload } from "@/lib/desktop/types"
import { SqlEditor } from "./sql-editor"
import { Combobox } from "./combobox"
import {
  areaCls,
  Field,
  formatMetricBody,
  formatSqlSafe,
  inputCls,
  ParamRowsEditor,
  Section,
  StatusNote,
  VerdictBadge,
} from "./metric-shared"

interface MetricCreatorWindowProps {
  payload: MetricCreatorPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenInspector: (name: string) => void
  /** pop the resolved SQL out into a native SQL window for testing */
  onOpenSql?: (sql: string, title: string) => void
}

interface FormState {
  name: string
  sql: string
  params: Record<string, unknown>
  grain: string
  description: string
  owner: string
  check: string
  category: string
  subcategory: string
}

const BLANK: FormState = {
  name: "",
  sql: "SELECT date_trunc('{grain!}', ts) AS bucket, count(*) AS n\nFROM your_table\nGROUP BY 1\nORDER BY 1",
  params: {},
  grain: "",
  description: "",
  owner: "",
  check: "",
  category: "",
  subcategory: "",
}

function fromSummary(m: MetricSummary): FormState {
  return {
    name: m.name,
    // Format the loaded template body (tokens preserved) so it opens readable.
    sql: formatMetricBody(m.sql),
    params: m.params ?? {},
    grain: m.grain ?? "",
    description: m.description ?? "",
    owner: m.owner ?? "",
    check: m.checkSql ? formatMetricBody(m.checkSql) : "",
    category: m.category ?? "",
    subcategory: m.subcategory ?? "",
  }
}

export function MetricCreatorWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenInspector,
  onOpenSql,
}: MetricCreatorWindowProps) {
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)

  // null name = "New" (blank form, editable Name); otherwise editing existing.
  const [editing, setEditing] = useState<string | null>(payload.metricName ?? null)
  const [form, setForm] = useState<FormState>(BLANK)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [catPairs, setCatPairs] = useState<CategoryPair[]>([])

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewFormatted = useMemo(() => formatSqlSafe(preview), [preview])

  // Draft KPI verdict (only when a check is present).
  const [verdict, setVerdict] = useState<MetricVerdict | null>(null)
  const [verdictError, setVerdictError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)

  const isExisting = editing != null

  const refreshList = useCallback(async (): Promise<MetricSummary[]> => {
    if (!activeConnectionId) return []
    setListLoading(true)
    const { metrics, error } = await listMetrics(activeConnectionId)
    setMetrics(metrics)
    setListError(error)
    setListLoading(false)
    return metrics
  }, [activeConnectionId])

  // the shared in-use category tree for the pickers
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const r = await fetchCategoryOptions(activeConnectionId)
      if (!cancelled) setCatPairs(r.pairs)
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit])

  // Initial load: fetch the catalog, and seed the form from payload.metricName.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    ;(async () => {
      const list = await refreshList()
      if (cancelled) return
      const target = payload.metricName ?? null
      if (target) {
        const found = list.find((m) => m.name === target)
        if (found) {
          setEditing(found.name)
          setForm(fromSummary(found))
        } else {
          // Not in the catalog (yet) — start blank but keep the requested name.
          setEditing(null)
          setForm({ ...BLANK, name: target })
        }
      }
      setBootstrapped(true)
    })()
    return () => {
      cancelled = true
    }
    // payload.metricName only seeds on mount; user navigation drives the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, hasRvbbit, refreshList])

  const selectMetric = useCallback((m: MetricSummary) => {
    setEditing(m.name)
    setForm(fromSummary(m))
    setSaveError(null)
    setSavedVersion(null)
    setSavedName(null)
  }, [])

  const startNew = useCallback(() => {
    setEditing(null)
    setForm(BLANK)
    setSaveError(null)
    setSavedVersion(null)
    setSavedName(null)
  }, [])

  // ── Live, debounced resolved-SQL preview (350ms) on sql/params change. ──
  // All setState happens inside the timeout callback (an external timer, not
  // the effect body) so we don't trigger cascading synchronous renders.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    const handle = setTimeout(async () => {
      if (form.sql.trim() === "") {
        setPreview(null)
        setPreviewError(null)
        setPreviewing(false)
        return
      }
      setPreviewing(true)
      const { sql, error } = await previewMetricSql(activeConnectionId, form.sql, form.params)
      setPreview(sql)
      setPreviewError(error)
      setPreviewing(false)
    }, 350)
    return () => clearTimeout(handle)
  }, [activeConnectionId, hasRvbbit, form.sql, form.params])

  // Draft KPI verdict — debounced, only when both metric + check are present.
  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    const handle = setTimeout(async () => {
      if (form.sql.trim() === "" || form.check.trim() === "") {
        setVerdict(null)
        setVerdictError(null)
        return
      }
      const { verdict: v, error } = await previewCheckSql(
        activeConnectionId,
        form.sql,
        form.check,
        form.params,
      )
      setVerdict(v)
      setVerdictError(error)
    }, 400)
    return () => clearTimeout(handle)
  }, [activeConnectionId, hasRvbbit, form.sql, form.check, form.params])

  const canSave = !saving && form.name.trim() !== "" && form.sql.trim() !== ""

  const save = useCallback(async () => {
    if (!activeConnectionId || !canSave) return
    setSaving(true)
    setSaveError(null)
    setSavedVersion(null)
    const name = form.name.trim()
    const { version, error } = await defineMetric(activeConnectionId, {
      name,
      sql: form.sql,
      params: form.params,
      grain: form.grain.trim() || null,
      description: form.description.trim() || null,
      owner: form.owner.trim() || null,
      check: form.check.trim() || null,
    })
    if (error) {
      setSaveError(error)
      setSaving(false)
      return
    }
    // category lives apart from the versioned def; set it after the metric exists.
    // The metric IS saved even if this fails, so proceed + surface non-blockingly.
    const catErr = await setCategory(activeConnectionId, "metric", name, form.category, form.subcategory)
    setSavedVersion(version)
    setSavedName(name)
    setEditing(name) // now editing this metric (next Save appends another version)
    await refreshList()
    await fetchCategoryOptions(activeConnectionId).then((r) => setCatPairs(r.pairs))
    if (catErr) setSaveError(`Saved, but the category wasn't applied: ${catErr}`)
    setSaving(false)
  }, [activeConnectionId, canSave, form, refreshList])

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-chrome-bg text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* ── Left rail: existing metrics + New ─────────────────────── */}
        <div className="flex w-56 shrink-0 flex-col border-r border-chrome-border/50">
          <div className="flex items-center justify-between border-b border-chrome-border/50 px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">Metrics</span>
            <button
              type="button"
              onClick={() => void refreshList()}
              title="Refresh"
              className="rounded p-0.5 text-chrome-text/50 hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RefreshCw className={`h-3 w-3 ${listLoading ? "animate-spin" : ""}`} />
            </button>
          </div>
          <button
            type="button"
            onClick={startNew}
            className={`flex items-center gap-1.5 border-b border-chrome-border/40 px-2 py-1.5 text-left text-[11px] ${
              !isExisting
                ? "bg-main/15 text-main"
                : "text-chrome-text/70 hover:bg-foreground/[0.04] hover:text-foreground"
            }`}
          >
            <Plus className="h-3 w-3" /> New metric
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listError ? (
              <StatusNote state="error" message={listError} />
            ) : metrics.length === 0 ? (
              <StatusNote
                state="empty"
                message={listLoading || !bootstrapped ? "Loading…" : "No metrics yet — create one →"}
              />
            ) : (
              metrics.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  onClick={() => selectMetric(m)}
                  className={`flex w-full flex-col gap-0.5 border-b border-chrome-border/30 px-2 py-1.5 text-left ${
                    isExisting && editing === m.name
                      ? "bg-foreground/[0.07]"
                      : "hover:bg-foreground/[0.03]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[11px] text-foreground">{m.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] text-chrome-text/45">
                      v{m.version}
                    </span>
                  </div>
                  <span className="truncate text-[9px] text-chrome-text/45">
                    {[m.grain, m.owner].filter(Boolean).join(" · ") || "—"}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Right pane: editor form (scrollable) ──────────────────── */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="px-3 pt-2 text-[12px] font-medium text-foreground">
            {isExisting ? (
              <>
                Edit <span className="font-mono text-main">{editing}</span>
                <span className="ml-1.5 text-[10px] font-normal text-chrome-text/45">
                  · Save appends a new version
                </span>
              </>
            ) : (
              "New metric"
            )}
          </div>

          {!isExisting ? (
            <MetricProposePanel
              connectionId={activeConnectionId}
              onDraft={(d) =>
                setForm((f) => ({
                  ...f,
                  name: d.name,
                  sql: formatMetricBody(d.sql),
                  grain: d.grain ?? "",
                  description: d.description ?? "",
                  params: d.params ?? {},
                  check: d.checkSql ?? "",
                }))
              }
            />
          ) : null}

          <Section title="Definition">
            <Field label="name">
              {isExisting ? (
                <div className="flex h-7 items-center rounded-[3px] border border-foreground/10 bg-foreground/[0.02] px-2 font-mono text-[12px] text-chrome-text/80">
                  {form.name}
                </div>
              ) : (
                <input
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      name: e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase(),
                    }))
                  }
                  placeholder="revenue_by_region"
                  className={inputCls}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <div className="flex-[0_0_50%]">
                <Field label="grain" hint="day / week / month / quarter / year">
                  <input
                    value={form.grain}
                    onChange={(e) => setForm((f) => ({ ...f, grain: e.target.value }))}
                    placeholder="month"
                    className={inputCls}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="owner">
                  <input
                    value={form.owner}
                    onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                    placeholder="analytics"
                    className={inputCls}
                  />
                </Field>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field label="category">
                  <Combobox
                    value={form.category}
                    onChange={(c) => setForm((f) => ({ ...f, category: c, subcategory: "" }))}
                    options={categoriesFrom(catPairs).map((c) => ({ value: c }))}
                    placeholder="— none —"
                    searchPlaceholder="search or add…"
                    allowCustom
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="subcategory">
                  <Combobox
                    value={form.subcategory}
                    onChange={(s) => setForm((f) => ({ ...f, subcategory: s }))}
                    options={subcategoriesFor(catPairs, form.category).map((s) => ({ value: s }))}
                    placeholder={form.category ? "— none —" : "set a category first"}
                    searchPlaceholder="search or add…"
                    allowCustom
                    disabled={!form.category}
                  />
                </Field>
              </div>
            </div>
            <Field label="description">
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="what this metric measures"
                className={areaCls}
              />
            </Field>
          </Section>

          <Section title="SQL body">
            <Field label="template" hint="tokens: {param} · {param!} (raw) · {metric:NAME} · {metric:NAME.-1day} (rolling)">
              <div className="h-56 overflow-hidden rounded-[3px] border border-chrome-border/60">
                <SqlEditor
                  value={form.sql}
                  onChange={(v) => setForm((f) => ({ ...f, sql: v }))}
                  onRun={() => void save()}
                  height="100%"
                />
              </div>
            </Field>
          </Section>

          <Section title="Default params">
            <ParamRowsEditor
              params={form.params}
              onChange={(next) => setForm((f) => ({ ...f, params: next }))}
            />
          </Section>

          <Section
            title="Check (KPI)"
            right={
              form.check.trim() ? <VerdictBadge verdict={verdict} /> : (
                <span className="text-[10px] text-chrome-text/35">optional</span>
              )
            }
          >
            <Field
              label="threshold / assertion"
              hint="over the `metric` CTE → one row, an `ok` boolean. e.g. SELECT total >= {target} AS ok FROM metric · rolling: {metric:self.-1day}"
            >
              <div className="h-28 overflow-hidden rounded-[3px] border border-chrome-border/60">
                <SqlEditor
                  value={form.check}
                  onChange={(v) => setForm((f) => ({ ...f, check: v }))}
                  onRun={() => void save()}
                  height="100%"
                  fontSize={12}
                />
              </div>
            </Field>
            {verdictError ? <StatusNote state="error" message={verdictError} className="px-0 py-1" /> : null}
          </Section>

          <Section
            title="Resolved SQL — live preview"
            right={
              <div className="flex items-center gap-2">
                {previewing ? <span className="text-[10px] text-chrome-text/45">resolving…</span> : null}
                {onOpenSql && (preview || form.sql.trim()) ? (
                  <button
                    type="button"
                    onClick={() => onOpenSql((preview && preview.trim()) || form.sql, `metric: ${form.name || "draft"}`)}
                    title="Open the resolved SQL in a native SQL window to run & inspect"
                    className="inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/60 px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    <Play className="h-2.5 w-2.5" /> Open in SQL
                  </button>
                ) : null}
              </div>
            }
          >
            <div className="h-40 overflow-hidden rounded-[3px] border border-chrome-border/60">
              <SqlEditor value={previewFormatted} onChange={() => {}} readOnly wrap height="100%" />
            </div>
            {previewError ? <StatusNote state="error" message={previewError} className="px-0 py-2" /> : null}
          </Section>

          <Section title="Save">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!canSave}
                className="inline-flex items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-2.5 py-1 text-[11px] text-main hover:bg-main/25 disabled:opacity-40"
              >
                <Save className="h-3 w-3" /> {saving ? "Saving…" : isExisting ? "Save version" : "Create metric"}
              </button>
              {savedVersion != null ? (
                <span className="text-[11px] text-chrome-text/70">
                  Saved <span className="font-mono text-foreground">v{savedVersion}</span>
                </span>
              ) : null}
              {savedVersion != null && savedName ? (
                <button
                  type="button"
                  onClick={() => onOpenInspector(savedName)}
                  className="rounded-[3px] border border-chrome-border/60 px-2 py-1 text-[11px] text-chrome-text/75 hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  Open in Inspector →
                </button>
              ) : null}
            </div>
            {saveError ? <StatusNote state="error" message={saveError} className="px-0 py-2" /> : null}
          </Section>

          <div className="h-3" />
        </div>
      </div>
    </div>
  )
}

// ── Draft-with-AI panel: subject → propose_metric → fills the form ──────────
function MetricProposePanel({
  connectionId,
  onDraft,
}: {
  connectionId: string
  onDraft: (d: MetricProposeResult) => void
}) {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [schema, setSchema] = useState("")
  const [seeds, setSeeds] = useState<string[]>([])
  const [sources, setSources] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // load candidate sources (cubes first, then base tables) when the panel opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const [{ cubes }, { tables }] = await Promise.all([listCubes(connectionId), listBaseTables(connectionId)])
      if (cancelled) return
      setSources([...cubes.map((c) => `cubes.${c.name}`), ...tables])
    })()
    return () => {
      cancelled = true
    }
  }, [open, connectionId])

  const schemas = useMemo(() => Array.from(new Set(sources.map((s) => s.split(".")[0]))).sort(), [sources])
  const seedChoices = useMemo(() => (schema ? sources.filter((s) => s.startsWith(`${schema}.`)) : sources), [sources, schema])

  async function go() {
    if (!subject.trim()) {
      setError("Describe what to measure first.")
      return
    }
    setBusy(true)
    setError(null)
    const { draft, error: err } = await proposeMetric(connectionId, subject.trim(), seeds.length ? seeds : null, schema || null)
    setBusy(false)
    if (err || !draft) {
      setError(err ?? "No draft produced.")
      return
    }
    onDraft(draft)
    setOpen(false)
  }

  if (!open) {
    return (
      <div className="px-3 pt-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-[3px] border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-500 hover:bg-sky-500/20"
        >
          <Sparkles className="h-3 w-3" /> Draft with AI
        </button>
      </div>
    )
  }

  return (
    <div className="mx-3 mt-1.5 space-y-2 rounded-[3px] border border-sky-500/30 bg-sky-500/[0.04] p-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sky-500/80">
        <Sparkles className="h-3 w-3" /> Draft a metric with AI
        <div className="flex-1" />
        <button type="button" onClick={() => setOpen(false)} className="text-chrome-text/45 hover:text-foreground">✕</button>
      </div>
      <textarea
        className={`${areaCls} h-14`}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="e.g. total won opportunity amount by month, from the opportunities cube"
      />
      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-0.5 block text-[10px] uppercase tracking-wider text-chrome-text/55">Scope to schema (optional)</span>
          <select className={inputCls} value={schema} onChange={(e) => { setSchema(e.target.value); setSeeds([]) }}>
            <option value="">— any (cubes preferred) —</option>
            {schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void go()}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 text-[11px] text-main hover:bg-main/25 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Draft
        </button>
      </div>
      {seedChoices.length ? (
        <div className="max-h-28 overflow-auto rounded-[3px] border border-chrome-border/40 p-1">
          {seedChoices.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-foreground/[0.04]">
              <input
                type="checkbox"
                checked={seeds.includes(s)}
                onChange={() => setSeeds((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                className="h-3 w-3"
              />
              <span className="font-mono text-chrome-text/75">{s}</span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <div className="whitespace-pre-wrap text-[11px] text-danger">{error}</div> : null}
      <div className="text-[10px] text-chrome-text/40">Prefers cubes as the source. The draft fills the form below — review &amp; Save to create.</div>
    </div>
  )
}
