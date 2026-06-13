"use client"

// ✎ Cube Creator — author a cube three ways: Manual (write the join SQL), Propose (an LLM drafts
// it from a subject), or From Pack (instantiate a known-SaaS template, e.g. Salesforce). Manual is
// the default; Propose pre-fills the Manual form for review; From Pack binds a template's
// placeholders to the user's tables and materializes in one call. Mirrors metric-creator-window.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, RefreshCw, Save, Sparkles, Layers, Boxes, Loader2, Wand2 } from "@/lib/icons"
import {
  applyCubePack,
  defineCube,
  defineCubeFromPack,
  fetchPackDetail,
  listBaseTables,
  listCubePacks,
  listCubes,
  previewCubeSql,
  proposeCube,
  suggestBindings,
  type CubePack,
  type CubeSummary,
  type PackDetail,
  type ProposeResult,
} from "@/lib/rvbbit/cubes"
import type { CubeCreatorPayload } from "@/lib/desktop/types"
import { SqlEditor } from "./sql-editor"
import { areaCls, Field, formatSqlSafe, inputCls, Section, StatusNote } from "./cube-shared"

interface Props {
  payload: CubeCreatorPayload
  activeConnectionId: string | null
  hasRvbbit: boolean
  onOpenInspector: (name: string) => void
}

type Mode = "manual" | "propose" | "pack"

interface FormState {
  name: string
  sql: string
  grain: string
  description: string
  owner: string
  category: string
}

const BLANK: FormState = {
  name: "",
  sql: "SELECT a.id, a.col, b.other\nFROM schema.table_a a\nJOIN schema.table_b b ON b.a_id = a.id",
  grain: "",
  description: "",
  owner: "",
  category: "",
}

export function CubeCreatorWindow({ payload, activeConnectionId, hasRvbbit, onOpenInspector }: Props) {
  const [cubes, setCubes] = useState<CubeSummary[]>([])
  const [editing, setEditing] = useState<string | null>(payload.cubeName ?? null)
  const [form, setForm] = useState<FormState>(BLANK)
  const [mode, setMode] = useState<Mode>("manual")
  const [bootstrapped, setBootstrapped] = useState(false)

  const [tables, setTables] = useState<string[]>([])
  const isExisting = editing != null

  const refreshList = useCallback(async (): Promise<CubeSummary[]> => {
    if (!activeConnectionId) return []
    const { cubes: rows } = await listCubes(activeConnectionId)
    setCubes(rows)
    return rows
  }, [activeConnectionId])

  useEffect(() => {
    if (!activeConnectionId || !hasRvbbit) return
    let cancelled = false
    void (async () => {
      const rows = await refreshList()
      const { tables: t } = await listBaseTables(activeConnectionId)
      if (cancelled) return
      setTables(t)
      // bootstrap the form once (load the payload cube into the Manual editor)
      if (!bootstrapped) {
        if (payload.cubeName) {
          const m = rows.find((c) => c.name === payload.cubeName)
          if (m) setForm({ name: m.name, sql: "", grain: m.grain ?? "", description: m.description ?? "", owner: "", category: m.category ?? "" })
          // load the full SQL from describe (cubes() doesn't carry sql)
          void loadCubeSql(activeConnectionId, payload.cubeName, setForm)
        }
        setBootstrapped(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, hasRvbbit, refreshList, bootstrapped, payload.cubeName])

  const startNew = useCallback(() => {
    setEditing(null)
    setForm(BLANK)
    setMode("manual")
  }, [])

  const loadExisting = useCallback(
    async (name: string) => {
      if (!activeConnectionId) return
      setEditing(name)
      setMode("manual")
      const c = cubes.find((x) => x.name === name)
      setForm((f) => ({ ...f, name, grain: c?.grain ?? "", description: c?.description ?? "", category: c?.category ?? "" }))
      await loadCubeSql(activeConnectionId, name, setForm)
    },
    [activeConnectionId, cubes],
  )

  if (!activeConnectionId || !hasRvbbit) {
    return <StatusNote state="empty" message="Connect to an rvbbit-enabled database." />
  }

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT RAIL */}
      <div className="w-48 shrink-0 overflow-y-auto border-r border-chrome-border/50">
        <div className="flex items-center gap-1.5 border-b border-chrome-border/50 px-3 py-2">
          <Boxes className="h-3.5 w-3.5 text-main" />
          <span className="text-[11px] uppercase tracking-wider text-chrome-text/60">Cubes</span>
          <div className="flex-1" />
          <button type="button" onClick={() => void refreshList()} title="Reload" className="rounded p-1 text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
        <button
          type="button"
          onClick={startNew}
          className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] ${editing == null ? "bg-main/10 text-main" : "text-chrome-text/70 hover:bg-foreground/[0.04]"}`}
        >
          <Plus className="h-3 w-3" /> New cube
        </button>
        <div className="py-1">
          {cubes.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => void loadExisting(c.name)}
              className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[12px] ${editing === c.name ? "bg-main/10 text-main" : "text-foreground/80 hover:bg-foreground/[0.04]"}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT PANE */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* mode toggle (hidden when editing an existing cube — Manual only) */}
        {!isExisting ? (
          <div className="flex items-center gap-1 border-b border-chrome-border/40 px-3 py-1.5">
            {([
              ["manual", "Manual", Save],
              ["propose", "Propose", Sparkles],
              ["pack", "From Pack", Layers],
            ] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1 rounded-[3px] px-2 py-0.5 text-[11px] ${mode === m ? "bg-main/15 text-main" : "text-chrome-text/60 hover:bg-foreground/[0.05] hover:text-foreground"}`}
              >
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
        ) : (
          <div className="border-b border-chrome-border/40 px-3 py-1.5 text-[11px] text-chrome-text/55">
            Editing <span className="font-mono text-foreground">{editing}</span> — Save appends a new version.
          </div>
        )}

        {mode === "manual" || isExisting ? (
          <ManualPane
            connectionId={activeConnectionId}
            form={form}
            setForm={setForm}
            isExisting={isExisting}
            onSaved={async (name) => {
              await refreshList()
              onOpenInspector(name)
            }}
          />
        ) : mode === "propose" ? (
          <ProposePane
            connectionId={activeConnectionId}
            tables={tables}
            onDraft={(d) => {
              setForm({
                name: d.name,
                sql: formatSqlSafe(d.sql),
                grain: d.grain ?? "",
                description: d.description ?? "",
                owner: "",
                category: "",
              })
              setMode("manual")
            }}
          />
        ) : (
          <PackPane
            connectionId={activeConnectionId}
            tables={tables}
            onCreated={async (name) => {
              await refreshList()
              onOpenInspector(name)
            }}
          />
        )}
      </div>
    </div>
  )
}

async function loadCubeSql(
  connectionId: string,
  name: string,
  setForm: React.Dispatch<React.SetStateAction<FormState>>,
) {
  const { describeCube } = await import("@/lib/rvbbit/cubes")
  const { cube } = await describeCube(connectionId, name)
  if (cube) setForm((f) => ({ ...f, name: cube.name, sql: formatSqlSafe(cube.sql), grain: cube.grain ?? "", description: cube.humanDescription ?? cube.description ?? "", category: cube.category ?? "" }))
}

// ── Manual: the form + live LIMIT-5 preview + Save ────────────────────────
function ManualPane({
  connectionId,
  form,
  setForm,
  isExisting,
  onSaved,
}: {
  connectionId: string
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  isExisting: boolean
  onSaved: (name: string) => void | Promise<void>
}) {
  const [preview, setPreview] = useState<{ columns: string[]; rows: Array<Record<string, unknown>> } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // debounced live preview of the body — all setState is deferred into the timer callback so
  // none runs synchronously in the effect body (cascading-render lint rule).
  useEffect(() => {
    const body = form.sql.trim()
    let cancelled = false
    const id = setTimeout(() => {
      void (async () => {
        if (!body) {
          if (!cancelled) {
            setPreview(null)
            setPreviewError(null)
            setPreviewing(false)
          }
          return
        }
        setPreviewing(true)
        const { columns, rows, error } = await previewCubeSql(connectionId, body, 5)
        if (cancelled) return
        setPreview(error ? null : { columns, rows })
        setPreviewError(error)
        setPreviewing(false)
      })()
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [connectionId, form.sql])

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  async function save() {
    if (!form.name.trim() || !form.sql.trim()) {
      setSaveError("Name and SQL are required.")
      return
    }
    setSaving(true)
    setSaveError(null)
    const { version, error } = await defineCube(connectionId, {
      name: form.name.trim(),
      sql: form.sql,
      grain: form.grain.trim() || null,
      description: form.description.trim() || null,
      owner: form.owner.trim() || null,
      category: form.category.trim() || null,
    })
    setSaving(false)
    if (error) {
      setSaveError(error)
      return
    }
    void onSaved(form.name.trim())
    void version
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 w-1/2 overflow-y-auto border-r border-chrome-border/40">
        <Section title="Cube">
          <Field label="Name" hint={isExisting ? "fixed (new version)" : "lowercase identifier"}>
            <input
              className={inputCls}
              value={form.name}
              disabled={isExisting}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="sales_orders"
            />
          </Field>
          <Field label="Grain">
            <input className={inputCls} value={form.grain} onChange={(e) => update({ grain: e.target.value })} placeholder="one row per order" />
          </Field>
          <Field label="Description">
            <textarea className={`${areaCls} h-14`} value={form.description} onChange={(e) => update({ description: e.target.value })} placeholder="what this cube is and what it answers" />
          </Field>
          <div className="flex gap-2">
            <Field label="Owner">
              <input className={inputCls} value={form.owner} onChange={(e) => update({ owner: e.target.value })} placeholder="team" />
            </Field>
            <Field label="Category">
              <input className={inputCls} value={form.category} onChange={(e) => update({ category: e.target.value })} placeholder="sales" />
            </Field>
          </div>
        </Section>
        <Section title="SQL">
          <div className="h-64 overflow-hidden rounded-[3px] border border-chrome-border/40">
            <SqlEditor value={form.sql} onChange={(v) => update({ sql: v })} />
          </div>
          {saveError ? <div className="mt-1 whitespace-pre-wrap text-[11px] text-danger">{saveError}</div> : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 text-[12px] text-main hover:bg-main/25 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {isExisting ? "Save new version" : "Create cube"}
          </button>
        </Section>
      </div>

      {/* live preview */}
      <div className="min-h-0 w-1/2 overflow-auto">
        <div className="flex items-center gap-1.5 border-b border-chrome-border/40 px-3 py-1.5 text-[10px] uppercase tracking-wider text-chrome-text/50">
          Live preview {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        </div>
        {previewError ? (
          <div className="whitespace-pre-wrap p-3 text-[11px] text-danger">{previewError}</div>
        ) : !preview ? (
          <StatusNote state="empty" message="Type a SELECT to preview." />
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-chrome-bg/70 text-[9px] uppercase tracking-wider text-chrome-text/50">
              <tr>
                {preview.columns.map((c) => (
                  <th key={c} className="border-b border-chrome-border/40 px-2 py-1 text-left font-normal">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} className="border-b border-chrome-border/15">
                  {preview.columns.map((c) => (
                    <td key={c} className="px-2 py-1 font-mono text-chrome-text/75">
                      {r[c] == null ? <span className="text-chrome-text/25">∅</span> : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Propose: subject → LLM draft → into the Manual form ───────────────────
function ProposePane({
  connectionId,
  tables,
  onDraft,
}: {
  connectionId: string
  tables: string[]
  onDraft: (d: ProposeResult) => void
}) {
  const [subject, setSubject] = useState("")
  const [schema, setSchema] = useState("")
  const [seeds, setSeeds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schemas = useMemo(() => Array.from(new Set(tables.map((t) => t.split(".")[0]))).sort(), [tables])
  const seedChoices = useMemo(() => (schema ? tables.filter((t) => t.startsWith(`${schema}.`)) : tables), [tables, schema])

  async function go() {
    if (!subject.trim()) {
      setError("Describe the subject first.")
      return
    }
    setBusy(true)
    setError(null)
    const { draft, error: err } = await proposeCube(connectionId, subject.trim(), seeds.length ? seeds : null, schema || null)
    setBusy(false)
    if (err || !draft) {
      setError(err ?? "No draft produced.")
      return
    }
    onDraft(draft)
  }

  function toggleSeed(t: string) {
    setSeeds((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Describe the cube you want">
        <Field label="Subject" hint="natural language">
          <textarea
            className={`${areaCls} h-16`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="opportunities with their account name, stage, amount and close date"
          />
        </Field>
        <Field label="Scope to schema" hint="optional">
          <select className={inputCls} value={schema} onChange={(e) => { setSchema(e.target.value); setSeeds([]) }}>
            <option value="">— any schema —</option>
            {schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Seed tables" hint="optional — pin the join">
          <div className="max-h-40 overflow-auto rounded-[3px] border border-chrome-border/40 p-1">
            {seedChoices.length === 0 ? (
              <div className="px-1 py-2 text-[11px] text-chrome-text/35">No tables.</div>
            ) : (
              seedChoices.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-foreground/[0.04]">
                  <input type="checkbox" checked={seeds.includes(t)} onChange={() => toggleSeed(t)} className="h-3 w-3" />
                  <span className="font-mono text-chrome-text/75">{t}</span>
                </label>
              ))
            )}
          </div>
        </Field>
        {error ? <div className="whitespace-pre-wrap text-[11px] text-danger">{error}</div> : null}
        <button
          type="button"
          onClick={() => void go()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 text-[12px] text-main hover:bg-main/25 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />} Draft cube
        </button>
        <div className="text-[10px] text-chrome-text/40">
          An LLM drafts the join from the FK graph + table docs. You review and Save — nothing is created until you do.
        </div>
      </Section>
    </div>
  )
}

// ── From Pack: bind a SaaS template to your tables → materialize ──────────
function PackPane({
  connectionId,
  tables,
  onCreated,
}: {
  connectionId: string
  tables: string[]
  onCreated: (name: string) => void | Promise<void>
}) {
  const [packs, setPacks] = useState<CubePack[]>([])
  const [packKey, setPackKey] = useState("")
  const [schema, setSchema] = useState("")
  const [detail, setDetail] = useState<PackDetail | null>(null)
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [cubeName, setCubeName] = useState("")
  const [resolved, setResolved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const schemas = useMemo(() => Array.from(new Set(tables.map((t) => t.split(".")[0]))).sort(), [tables])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { packs: rows } = await listCubePacks(connectionId)
      if (!cancelled) setPacks(rows)
    })()
    return () => { cancelled = true }
  }, [connectionId])

  const choosePack = useCallback(
    async (key: string) => {
      setPackKey(key)
      setResolved(null)
      setError(null)
      const pk = packs.find((p) => p.packKey === key)
      setCubeName(pk?.cubeNameSuggest ?? "")
      const { detail: d } = await fetchPackDetail(connectionId, key)
      setDetail(d)
      setBindings(d ? Object.fromEntries(d.placeholders.map((p) => [p, ""])) : {})
    },
    [connectionId, packs],
  )

  async function autoSuggest() {
    if (!packKey) return
    setBusy("suggest")
    const { suggestions } = await suggestBindings(connectionId, packKey, schema || null)
    // *_col placeholders → best column; *_table placeholders → most common suggested table
    const byField = new Map(suggestions.map((s) => [s.field, s]))
    const tableVotes = new Map<string, number>()
    for (const s of suggestions) if (s.bestTable) tableVotes.set(s.bestTable, (tableVotes.get(s.bestTable) ?? 0) + 1)
    const topTable = [...tableVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
    setBindings((prev) => {
      const next = { ...prev }
      for (const ph of Object.keys(next)) {
        if (ph.endsWith("_table")) {
          next[ph] = topTable
        } else {
          const s = byField.get(ph)
          if (s?.bestColumn) next[ph] = s.bestColumn
        }
      }
      return next
    })
    setBusy(null)
  }

  async function preview() {
    setBusy("preview")
    setError(null)
    const { status, resolvedSql, error: err } = await applyCubePack(connectionId, packKey, bindings)
    setBusy(null)
    if (status !== "ok") {
      setError(err ?? "apply failed")
      setResolved(resolvedSql)
      return
    }
    setResolved(resolvedSql)
  }

  async function create() {
    if (!cubeName.trim()) {
      setError("Cube name is required.")
      return
    }
    setBusy("create")
    setError(null)
    const { version, error: err } = await defineCubeFromPack(connectionId, packKey, bindings, cubeName.trim())
    setBusy(null)
    if (err) {
      setError(err)
      return
    }
    void version
    void onCreated(cubeName.trim())
  }

  const tableChoices = useMemo(() => (schema ? tables.filter((t) => t.startsWith(`${schema}.`)) : tables), [tables, schema])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title="Instantiate a SaaS pack">
        <Field label="Pack">
          <select className={inputCls} value={packKey} onChange={(e) => void choosePack(e.target.value)}>
            <option value="">— choose a pack —</option>
            {packs.map((p) => (
              <option key={p.packKey} value={p.packKey}>{p.packKey} ({p.canonicalObject})</option>
            ))}
          </select>
        </Field>
        {detail ? (
          <>
            <div className="flex items-end gap-2">
              <Field label="Your schema" hint="where the source tables live">
                <select className={inputCls} value={schema} onChange={(e) => setSchema(e.target.value)}>
                  <option value="">— any —</option>
                  {schemas.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                onClick={() => void autoSuggest()}
                disabled={busy === "suggest"}
                className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-chrome-border/60 px-2 text-[11px] text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
              >
                {busy === "suggest" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Auto-suggest
              </button>
            </div>

            <div className="rounded-[3px] border border-chrome-border/40">
              <div className="border-b border-chrome-border/30 px-2 py-1 text-[10px] uppercase tracking-wider text-chrome-text/45">
                Bindings ({detail.placeholders.length})
              </div>
              <div className="max-h-56 overflow-auto">
                {detail.placeholders.map((ph) => (
                  <div key={ph} className="flex items-center gap-2 border-b border-chrome-border/15 px-2 py-1">
                    <span className="w-40 shrink-0 truncate font-mono text-[11px] text-chrome-text/70" title={ph}>{ph}</span>
                    {ph.endsWith("_table") ? (
                      <select
                        className={`${inputCls} flex-1`}
                        value={bindings[ph] ?? ""}
                        onChange={(e) => setBindings((b) => ({ ...b, [ph]: e.target.value }))}
                      >
                        <option value="">— table —</option>
                        {tableChoices.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={`${inputCls} flex-1`}
                        value={bindings[ph] ?? ""}
                        onChange={(e) => setBindings((b) => ({ ...b, [ph]: e.target.value }))}
                        placeholder="column name"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <Field label="New cube name">
              <input className={inputCls} value={cubeName} onChange={(e) => setCubeName(e.target.value)} placeholder="sf_opportunities" />
            </Field>

            {error ? <div className="whitespace-pre-wrap text-[11px] text-danger">{error}</div> : null}
            {resolved ? (
              <pre className="max-h-32 overflow-auto rounded-[3px] border border-chrome-border/40 bg-foreground/[0.02] p-2 font-mono text-[10px] leading-snug text-foreground/80">
                {formatSqlSafe(resolved)}
              </pre>
            ) : null}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void preview()}
                disabled={busy === "preview"}
                className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-chrome-border/60 px-3 text-[12px] text-chrome-text/70 hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
              >
                {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Preview SQL
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy === "create"}
                className="inline-flex h-8 items-center gap-1.5 rounded-[3px] border border-main/40 bg-main/15 px-3 text-[12px] text-main hover:bg-main/25 disabled:opacity-50"
              >
                {busy === "create" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers className="h-3.5 w-3.5" />} Create cube
              </button>
            </div>
            <div className="text-[10px] text-chrome-text/40">
              Pack docs are pre-seeded as curated column docs (preserved across Enrich).
            </div>
          </>
        ) : null}
      </Section>
    </div>
  )
}
