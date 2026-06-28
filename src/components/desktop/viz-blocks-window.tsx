"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Clock, LayoutDashboard, Loader2, Play, Plus, RefreshCw, Save, Target, Trash2 } from "@/lib/icons"
import type { VizBlocksPayload } from "@/lib/desktop/types"
import {
  defineVizBlock,
  fetchVizBlockLinks,
  fetchVizBlockVersions,
  listVizBlocks,
  previewVizBlockDraftSql,
  type DefineVizBlockInput,
  type VizBlockSummary,
  type VizBlockVersion,
  type VizObjectLink,
} from "@/lib/rvbbit/viz-blocks"
import { SqlEditor } from "./sql-editor"
import { areaCls, Field, formatMetricBody, formatSqlSafe, inputCls, ParamRowsEditor, Section, StatusNote } from "./metric-shared"

interface VizBlocksWindowProps {
  payload: VizBlocksPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenSqlData?: (sql: string, title: string) => void
}

interface LinkDraft {
  id: string
  objectKind: string
  objectKey: string
  role: string
  confidence: string
  linkSource: string
  conditionsText: string
  notes: string
}

interface FormState {
  name: string
  title: string
  intent: string
  description: string
  owner: string
  sqlTemplate: string
  inputSchemaText: string
  layoutTemplateText: string
  params: Record<string, unknown>
  tagsText: string
  labelsText: string
  enabled: boolean
  links: LinkDraft[]
}

interface JsonParseResult {
  value: Record<string, unknown>
  error: string | null
}

const DEFAULT_SQL = `WITH states AS (
  SELECT {dimension!}::text AS state, count(*)::int AS sightings
  FROM {table!}
  WHERE {dimension!} IS NOT NULL
  GROUP BY 1
  ORDER BY sightings DESC
  LIMIT {limit!}
)
SELECT
  'ui'::text AS rvbbit_artifact,
  'state-bars'::text AS artifact_id,
  'chart'::text AS artifact_kind,
  'basic_chart'::text AS renderer,
  'Sightings by State'::text AS title,
  jsonb_build_object(
    'kind', 'bar',
    'x', 'state',
    'y', 'sightings',
    'filter', jsonb_build_object('field', 'state')
  ) AS spec,
  (SELECT jsonb_agg(to_jsonb(states)) FROM states) AS data
UNION ALL
SELECT
  'ui'::text AS rvbbit_artifact,
  'state-table'::text AS artifact_id,
  'table'::text AS artifact_kind,
  'table'::text AS renderer,
  'Top States'::text AS title,
  '{}'::jsonb AS spec,
  (SELECT jsonb_agg(to_jsonb(states)) FROM states) AS data;`

const DEFAULT_INPUT_SCHEMA = {
  required: ["table", "dimension"],
  properties: {
    table: { role: "qualified relation name", raw: true },
    dimension: { role: "column expression", raw: true },
    limit: { role: "row limit", raw: true },
  },
}

const DEFAULT_LAYOUT_TEMPLATE = {
  layout: [
    { artifact_id: "state-bars", w: 2 },
    { artifact_id: "state-table", w: 1 },
  ],
}

function draftId(): string {
  return `link_${Math.random().toString(36).slice(2)}`
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseJsonObject(label: string, text: string): JsonParseResult {
  const raw = text.trim()
  if (!raw) return { value: {}, error: null }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: `${label} must be a JSON object` }
    }
    return { value: parsed as Record<string, unknown>, error: null }
  } catch (e) {
    return { value: {}, error: `${label}: ${e instanceof Error ? e.message : "invalid JSON"}` }
  }
}

function normalizeName(input: string): string {
  return input.replace(/[^a-z0-9_]/gi, "_").replace(/_+/g, "_").toLowerCase()
}

function splitTags(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function newLinkDraft(partial: Partial<LinkDraft> = {}): LinkDraft {
  return {
    id: draftId(),
    objectKind: partial.objectKind ?? "table",
    objectKey: partial.objectKey ?? "public.bigfoot_sightings",
    role: partial.role ?? "source",
    confidence: partial.confidence ?? "1",
    linkSource: partial.linkSource ?? "declared",
    conditionsText: partial.conditionsText ?? "{}",
    notes: partial.notes ?? "",
  }
}

function blankForm(): FormState {
  return {
    name: "",
    title: "",
    intent: "distribution",
    description: "",
    owner: "",
    sqlTemplate: DEFAULT_SQL,
    inputSchemaText: prettyJson(DEFAULT_INPUT_SCHEMA),
    layoutTemplateText: prettyJson(DEFAULT_LAYOUT_TEMPLATE),
    params: {
      table: "public.bigfoot_sightings",
      dimension: "state",
      limit: "25",
    },
    tagsText: "table, distribution, state",
    labelsText: "{}",
    enabled: true,
    links: [newLinkDraft()],
  }
}

function linkToDraft(link: VizObjectLink): LinkDraft {
  return newLinkDraft({
    objectKind: link.objectKind,
    objectKey: link.objectKey,
    role: link.role,
    confidence: Number.isFinite(link.confidence) ? String(link.confidence) : "1",
    linkSource: link.linkSource,
    conditionsText: prettyJson(link.conditions),
    notes: link.notes ?? "",
  })
}

function formFromBlock(block: VizBlockSummary, links: VizObjectLink[] = []): FormState {
  return {
    name: block.name,
    title: block.title === block.name ? "" : block.title,
    intent: block.intent || "overview",
    description: block.description ?? "",
    owner: block.owner ?? "",
    sqlTemplate: formatMetricBody(block.sqlTemplate),
    inputSchemaText: prettyJson(block.inputSchema),
    layoutTemplateText: prettyJson(block.layoutTemplate),
    params: block.params ?? {},
    tagsText: block.tags.join(", "),
    labelsText: prettyJson(block.labels),
    enabled: block.enabled,
    links: links.map(linkToDraft),
  }
}

function shortDate(value: string | null | undefined): string {
  if (!value) return ""
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : value
}

export function VizBlocksWindow({
  payload,
  activeConnectionId,
  hasRvbbit,
  onOpenSqlData,
}: VizBlocksWindowProps) {
  const [blocks, setBlocks] = useState<VizBlockSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [bootstrapped, setBootstrapped] = useState(false)

  const [editing, setEditing] = useState<string | null>(payload.blockName ?? null)
  const [form, setForm] = useState<FormState>(() => {
    const f = blankForm()
    return payload.blockName ? { ...f, name: normalizeName(payload.blockName) } : f
  })

  const [versions, setVersions] = useState<VizBlockVersion[]>([])
  const [versionsError, setVersionsError] = useState<string | null>(null)

  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewFormatted = useMemo(() => formatSqlSafe(preview), [preview])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)

  const inputSchema = useMemo(
    () => parseJsonObject("input_schema", form.inputSchemaText),
    [form.inputSchemaText],
  )
  const layoutTemplate = useMemo(
    () => parseJsonObject("layout_template", form.layoutTemplateText),
    [form.layoutTemplateText],
  )
  const labels = useMemo(() => parseJsonObject("labels", form.labelsText), [form.labelsText])

  const linkIssues = useMemo(() => {
    const issues: string[] = []
    form.links.forEach((link, index) => {
      const hasAny =
        link.objectKind.trim() ||
        link.objectKey.trim() ||
        link.role.trim() ||
        link.linkSource.trim() ||
        link.conditionsText.trim() !== "{}" ||
        link.notes.trim()
      if (!hasAny) return
      if (!link.objectKind.trim() || !link.objectKey.trim()) {
        issues.push(`link ${index + 1}: object kind and key are required`)
      }
      const parsed = parseJsonObject(`link ${index + 1} conditions`, link.conditionsText)
      if (parsed.error) issues.push(parsed.error)
      const confidence = Number(link.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        issues.push(`link ${index + 1}: confidence must be between 0 and 1`)
      }
    })
    return issues
  }, [form.links])

  const jsonIssues = useMemo(
    () => [inputSchema.error, layoutTemplate.error, labels.error, ...linkIssues].filter(Boolean) as string[],
    [inputSchema.error, layoutTemplate.error, labels.error, linkIssues],
  )

  const groupedBlocks = useMemo(() => {
    const groups = new Map<string, VizBlockSummary[]>()
    for (const block of blocks) {
      const key = block.intent || "overview"
      groups.set(key, [...(groups.get(key) ?? []), block])
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [blocks])

  const isExisting = editing != null
  const canSave =
    !saving &&
    form.name.trim() !== "" &&
    form.sqlTemplate.trim() !== "" &&
    jsonIssues.length === 0
  const canRunPreview = !!onOpenSqlData && !!preview?.trim() && !previewError

  const refreshList = useCallback(async (): Promise<VizBlockSummary[]> => {
    if (!activeConnectionId) return []
    setListLoading(true)
    const { blocks: nextBlocks, error } = await listVizBlocks(activeConnectionId)
    setBlocks(nextBlocks)
    setListError(error)
    setListLoading(false)
    return nextBlocks
  }, [activeConnectionId])

  const fetchDetails = useCallback(
    async (name: string): Promise<VizObjectLink[]> => {
      if (!activeConnectionId) return []
      const [{ versions: nextVersions, error: versionErr }, { links, error: linksErr }] = await Promise.all([
        fetchVizBlockVersions(activeConnectionId, name),
        fetchVizBlockLinks(activeConnectionId, name),
      ])
      setVersions(nextVersions)
      setVersionsError(versionErr ?? linksErr)
      return linksErr ? [] : links
    },
    [activeConnectionId],
  )

  const selectBlock = useCallback(
    async (block: VizBlockSummary) => {
      setEditing(block.name)
      setForm(formFromBlock(block))
      setSaveError(null)
      setSavedVersion(null)
      setPreviewError(null)
      const links = await fetchDetails(block.name)
      setForm((current) => (current.name === block.name ? { ...current, links: links.map(linkToDraft) } : current))
    },
    [fetchDetails],
  )

  const startNew = useCallback(() => {
    setEditing(null)
    setForm(blankForm())
    setVersions([])
    setVersionsError(null)
    setSaveError(null)
    setSavedVersion(null)
    setPreviewError(null)
  }, [])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const nextBlocks = await refreshList()
      if (cancelled) return
      const target = payload.blockName ?? null
      if (target) {
        const found = nextBlocks.find((block) => block.name === target)
        if (found) {
          await selectBlock(found)
        } else {
          setEditing(null)
          setForm((current) => ({ ...current, name: normalizeName(target) }))
        }
      }
      if (!cancelled) setBootstrapped(true)
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, payload.blockName, refreshList, selectBlock])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    const handle = setTimeout(async () => {
      if (!form.sqlTemplate.trim()) {
        setPreview(null)
        setPreviewError(null)
        setPreviewing(false)
        return
      }
      setPreviewing(true)
      const { sql, error } = await previewVizBlockDraftSql(activeConnectionId, form.sqlTemplate, form.params)
      if (cancelled) return
      setPreview(sql)
      setPreviewError(error)
      setPreviewing(false)
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [activeConnectionId, hasRvbbit, form.sqlTemplate, form.params])

  const loadVersion = useCallback((version: VizBlockVersion) => {
    setForm((current) => ({ ...formFromBlock(version), links: current.links }))
    setEditing(version.name)
    setSaveError(null)
    setSavedVersion(null)
  }, [])

  const buildLinks = useCallback((): { links: NonNullable<DefineVizBlockInput["links"]>; error: string | null } => {
    const links: NonNullable<DefineVizBlockInput["links"]> = []
    for (const [index, link] of form.links.entries()) {
      const hasAny =
        link.objectKind.trim() ||
        link.objectKey.trim() ||
        link.role.trim() ||
        link.linkSource.trim() ||
        link.conditionsText.trim() !== "{}" ||
        link.notes.trim()
      if (!hasAny) continue
      if (!link.objectKind.trim() || !link.objectKey.trim()) {
        return { links: [], error: `link ${index + 1}: object kind and key are required` }
      }
      const conditions = parseJsonObject(`link ${index + 1} conditions`, link.conditionsText)
      if (conditions.error) return { links: [], error: conditions.error }
      const confidence = Number(link.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return { links: [], error: `link ${index + 1}: confidence must be between 0 and 1` }
      }
      links.push({
        objectKind: link.objectKind.trim(),
        objectKey: link.objectKey.trim(),
        role: link.role.trim() || "source",
        confidence,
        linkSource: link.linkSource.trim() || "declared",
        conditions: conditions.value,
        notes: link.notes.trim() || null,
      })
    }
    return { links, error: null }
  }, [form.links])

  const save = useCallback(async () => {
    if (!activeConnectionId || !canSave) return
    setSaving(true)
    setSaveError(null)
    setSavedVersion(null)

    const links = buildLinks()
    if (links.error) {
      setSaveError(links.error)
      setSaving(false)
      return
    }

    const name = normalizeName(form.name.trim())
    const { version, error } = await defineVizBlock(activeConnectionId, {
      name,
      title: form.title.trim() || null,
      intent: form.intent.trim() || "overview",
      description: form.description.trim() || null,
      owner: form.owner.trim() || null,
      sqlTemplate: form.sqlTemplate,
      inputSchema: inputSchema.value,
      layoutTemplate: layoutTemplate.value,
      params: form.params,
      tags: splitTags(form.tagsText),
      labels: labels.value,
      enabled: form.enabled,
      links: links.links,
    })

    if (error) {
      setSaveError(error)
      setSaving(false)
      return
    }

    const nextBlocks = await refreshList()
    const saved = nextBlocks.find((block) => block.name === name)
    if (saved) {
      await selectBlock(saved)
    } else {
      setEditing(name)
      await fetchDetails(name)
    }
    setSavedVersion(version)
    setSaving(false)
  }, [
    activeConnectionId,
    buildLinks,
    canSave,
    fetchDetails,
    form.description,
    form.enabled,
    form.intent,
    form.name,
    form.owner,
    form.params,
    form.sqlTemplate,
    form.tagsText,
    form.title,
    inputSchema.value,
    labels.value,
    layoutTemplate.value,
    refreshList,
    selectBlock,
  ])

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-chrome-bg text-foreground">
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col border-r border-chrome-border/50">
          <div className="flex items-center justify-between border-b border-chrome-border/50 px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-chrome-text/55">Viz Blocks</span>
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
            <Plus className="h-3 w-3" /> New block
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listError ? (
              <StatusNote state="error" message={listError} />
            ) : blocks.length === 0 ? (
              <StatusNote
                state="empty"
                message={listLoading || !bootstrapped ? "Loading..." : "No viz blocks yet."}
              />
            ) : (
              groupedBlocks.map(([intent, intentBlocks]) => (
                <div key={intent} className="border-b border-chrome-border/30">
                  <div className="px-2 pb-0.5 pt-2 text-[9px] uppercase tracking-wider text-chrome-text/35">
                    {intent}
                  </div>
                  {intentBlocks.map((block) => (
                    <button
                      key={block.name}
                      type="button"
                      onClick={() => void selectBlock(block)}
                      className={`flex w-full flex-col gap-0.5 px-2 py-1.5 text-left ${
                        isExisting && editing === block.name
                          ? "bg-foreground/[0.07]"
                          : "hover:bg-foreground/[0.03]"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[11px] text-foreground">{block.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[9px] text-chrome-text/45">
                          v{block.version}
                        </span>
                      </div>
                      <span className="truncate text-[9px] text-chrome-text/45">
                        {[block.title, block.owner].filter(Boolean).join(" - ") || "untitled"}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 px-3 pt-2 text-[12px] font-medium text-foreground">
            <LayoutDashboard className="h-3.5 w-3.5 text-main" />
            {isExisting ? (
              <>
                Edit <span className="font-mono text-main">{editing}</span>
                <span className="text-[10px] font-normal text-chrome-text/45">Save appends a new version</span>
              </>
            ) : (
              "New viz block"
            )}
          </div>

          <Section
            title="Versions"
            right={versionsError ? <span className="text-[10px] text-danger">{versionsError}</span> : null}
          >
            {versions.length === 0 ? (
              <div className="text-[10px] text-chrome-text/35">Save this block to start version history.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {versions.map((version) => (
                  <button
                    key={`${version.name}-${version.version}`}
                    type="button"
                    onClick={() => loadVersion(version)}
                    title={shortDate(version.createdAt)}
                    className="inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/60 px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    <Clock className="h-2.5 w-2.5" /> v{version.version}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Definition">
            <div className="grid gap-2 lg:grid-cols-[1.1fr_1fr_0.8fr_0.5fr]">
              <Field label="name">
                {isExisting ? (
                  <div className="flex h-7 items-center rounded-[3px] border border-foreground/10 bg-foreground/[0.02] px-2 font-mono text-[12px] text-chrome-text/80">
                    {form.name}
                  </div>
                ) : (
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: normalizeName(e.target.value) }))}
                    placeholder="table_state_distribution"
                    className={inputCls}
                  />
                )}
              </Field>
              <Field label="title">
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="State Distribution"
                  className={inputCls}
                />
              </Field>
              <Field label="intent">
                <input
                  value={form.intent}
                  onChange={(e) => setForm((f) => ({ ...f, intent: normalizeName(e.target.value) }))}
                  placeholder="overview"
                  className={inputCls}
                />
              </Field>
              <Field label="enabled">
                <label className="flex h-7 items-center gap-2 rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 text-[11px] text-chrome-text/70">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => ({ ...f, enabled: e.currentTarget.checked }))}
                    className="h-3 w-3"
                  />
                  active
                </label>
              </Field>
            </div>
            <div className="grid gap-2 lg:grid-cols-[0.8fr_1fr]">
              <Field label="owner">
                <input
                  value={form.owner}
                  onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                  placeholder="analytics"
                  className={inputCls}
                />
              </Field>
              <Field label="tags">
                <input
                  value={form.tagsText}
                  onChange={(e) => setForm((f) => ({ ...f, tagsText: e.target.value }))}
                  placeholder="table, overview, kpi"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="description">
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="what this block renders and when it should be used"
                className={areaCls}
              />
            </Field>
          </Section>

          <Section title="SQL Template">
            <Field label="template" hint="tokens: {param} for literals, {param!} for raw SQL">
              <div className="h-72 overflow-hidden rounded-[3px] border border-chrome-border/60">
                <SqlEditor
                  value={form.sqlTemplate}
                  onChange={(value) => setForm((f) => ({ ...f, sqlTemplate: value }))}
                  onRun={() => void save()}
                  height="100%"
                />
              </div>
            </Field>
          </Section>

          <Section title="Default Params">
            <ParamRowsEditor params={form.params} onChange={(params) => setForm((f) => ({ ...f, params }))} />
          </Section>

          <Section title="Contracts">
            <div className="grid gap-2 xl:grid-cols-3">
              <JsonObjectField
                label="input_schema"
                value={form.inputSchemaText}
                error={inputSchema.error}
                onChange={(value) => setForm((f) => ({ ...f, inputSchemaText: value }))}
              />
              <JsonObjectField
                label="layout_template"
                value={form.layoutTemplateText}
                error={layoutTemplate.error}
                onChange={(value) => setForm((f) => ({ ...f, layoutTemplateText: value }))}
              />
              <JsonObjectField
                label="labels"
                value={form.labelsText}
                error={labels.error}
                onChange={(value) => setForm((f) => ({ ...f, labelsText: value }))}
              />
            </div>
          </Section>

          <Section
            title="Known Object Links"
            right={
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, links: [...f.links, newLinkDraft({ objectKey: "" })] }))}
                className="inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/60 px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Plus className="h-2.5 w-2.5" /> Add link
              </button>
            }
          >
            <LinkRowsEditor
              links={form.links}
              onChange={(links) => setForm((f) => ({ ...f, links }))}
            />
            {linkIssues.length ? (
              <StatusNote state="error" message={linkIssues.join("\n")} className="px-0 py-1" />
            ) : null}
          </Section>

          <Section
            title="Resolved SQL - Live Preview"
            right={
              <div className="flex items-center gap-2">
                {previewing ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-chrome-text/45">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" /> resolving
                  </span>
                ) : null}
                {onOpenSqlData ? (
                  <button
                    type="button"
                    disabled={!canRunPreview}
                    onClick={() =>
                      preview ? onOpenSqlData(preview, `viz: ${form.name.trim() || "draft"}`) : undefined
                    }
                    title="Run the resolved SQL in a data window"
                    className="inline-flex items-center gap-1 rounded-[3px] border border-chrome-border/60 px-1.5 py-0.5 text-[10px] text-chrome-text/70 hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
                  >
                    <Play className="h-2.5 w-2.5" /> Run
                  </button>
                ) : null}
              </div>
            }
          >
            <div className="h-44 overflow-hidden rounded-[3px] border border-chrome-border/60">
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
                <Save className="h-3 w-3" /> {saving ? "Saving..." : isExisting ? "Save version" : "Create block"}
              </button>
              {savedVersion != null ? (
                <span className="text-[11px] text-chrome-text/70">
                  Saved <span className="font-mono text-foreground">v{savedVersion}</span>
                </span>
              ) : null}
            </div>
            {jsonIssues.length ? (
              <StatusNote state="error" message={jsonIssues.join("\n")} className="px-0 py-2" />
            ) : null}
            {saveError ? <StatusNote state="error" message={saveError} className="px-0 py-2" /> : null}
          </Section>

          <div className="h-3" />
        </div>
      </div>
    </div>
  )
}

function JsonObjectField({
  label,
  value,
  error,
  onChange,
}: {
  label: string
  value: string
  error: string | null
  onChange: (value: string) => void
}) {
  return (
    <Field label={label}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={8}
        className={`${areaCls} h-32`}
      />
      {error ? <div className="pt-1 text-[10px] text-danger">{error}</div> : null}
    </Field>
  )
}

function LinkRowsEditor({
  links,
  onChange,
}: {
  links: LinkDraft[]
  onChange: (links: LinkDraft[]) => void
}) {
  function patch(index: number, next: Partial<LinkDraft>) {
    const copy = links.slice()
    copy[index] = { ...copy[index], ...next }
    onChange(copy)
  }

  if (links.length === 0) {
    return <div className="text-[10px] text-chrome-text/35">No linked objects.</div>
  }

  return (
    <div className="space-y-2">
      {links.map((link, index) => (
        <div key={link.id} className="border-t border-chrome-border/35 pt-2 first:border-t-0 first:pt-0">
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-chrome-text/45">
            <Target className="h-3 w-3" /> link {index + 1}
            <button
              type="button"
              title="Remove link"
              onClick={() => onChange(links.filter((item) => item.id !== link.id))}
              className="ml-auto rounded px-1 text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          <div className="grid gap-1.5 xl:grid-cols-[0.7fr_1.4fr_0.7fr_0.55fr_0.8fr]">
            <input
              className={inputCls}
              placeholder="kind"
              value={link.objectKind}
              onChange={(e) => patch(index, { objectKind: normalizeName(e.target.value) })}
            />
            <input
              className={inputCls}
              placeholder="schema.object / metric name"
              value={link.objectKey}
              onChange={(e) => patch(index, { objectKey: e.target.value })}
            />
            <input
              className={inputCls}
              placeholder="role"
              value={link.role}
              onChange={(e) => patch(index, { role: normalizeName(e.target.value) })}
            />
            <input
              className={inputCls}
              placeholder="0-1"
              value={link.confidence}
              onChange={(e) => patch(index, { confidence: e.target.value })}
            />
            <input
              className={inputCls}
              placeholder="declared"
              value={link.linkSource}
              onChange={(e) => patch(index, { linkSource: normalizeName(e.target.value) })}
            />
          </div>
          <div className="mt-1.5 grid gap-1.5 xl:grid-cols-[1fr_1fr]">
            <textarea
              className={`${areaCls} h-16`}
              value={link.conditionsText}
              spellCheck={false}
              onChange={(e) => patch(index, { conditionsText: e.target.value })}
              placeholder="conditions JSON"
            />
            <textarea
              className={`${areaCls} h-16`}
              value={link.notes}
              onChange={(e) => patch(index, { notes: e.target.value })}
              placeholder="notes"
            />
          </div>
        </div>
      ))}
    </div>
  )
}
