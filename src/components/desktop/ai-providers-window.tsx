"use client"

import { useCallback, useEffect, useId, useMemo, useState } from "react"
import { Check, ChevronDown, Loader2, Plug, RefreshCw, Sparkles, Trash2, X } from "@/lib/icons"
import { cn } from "@/lib/utils"

/**
 * AI Providers — the first-class front door for LLM credentials
 * (docs/FIELD_GUIDE_PLAN.md §7). Provider credentials are the same species
 * as Postgres connections: something the USER has, configured here — while
 * capabilities stay for things the SYSTEM deploys. This panel writes the
 * SAME rows the engine already reads (rvbbit.backends + rvbbit.secrets +
 * settings.default_provider), so every existing LLM path keeps working
 * untouched; it just gained an honest entrance.
 *
 * Keys: stored via rvbbit.set_secret under the provider's canonical env
 * name — the engine's auth resolution is env var FIRST (deploy-time wins),
 * then the secrets table. Never displayed back; the panel shows presence
 * only. Test = rvbbit.provider_test (one real completion through the exact
 * production path). Model catalogs = rvbbit.refresh_provider_catalogs into
 * rvbbit.provider_models, browsable below for observability.
 */

async function dbQuery(
  connectionId: string,
  sql: string,
  rowLimit = 600,
): Promise<{ rows?: Array<Record<string, unknown>>; error?: string }> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, sql, readOnly: false, rowLimit }),
  })
  return (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string }
}

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

interface ProviderRow {
  name: string
  transport: string
  endpoint_url: string
  auth_header_env: string | null
  max_concurrent: number
  description: string
  is_default: boolean
  has_secret: boolean
  /** Where the credential resolves TODAY, per the engine's own precedence:
   *  env | secret | missing | none (empty name). Pre-0194 servers: unknown. */
  key_state: "env" | "secret" | "missing" | "none" | "unknown"
  /** Installed by a capability (install_manifest present) — the capability
   *  owns endpoint/key/lifecycle; the panel shows, tests, but never edits. */
  managed: boolean
  capability: string
  /** The backend's default model (transport_opts.model) — managed backends
   *  serve a fixed alias; empty test input falls back to it. */
  default_model: string
  model_count: number
  models_fetched_at: string | null
}

interface ModelRow {
  provider: string
  model: string
  display_name: string | null
  context_window: number | null
  available: boolean
}

/** Preset ladder — canonical key names match the engine's catalog fetchers
 *  so one pasted key powers BOTH completions and model-list refresh. */
const PRESETS = [
  { id: "openrouter", label: "OpenRouter", transport: "openai_chat", url: "https://openrouter.ai/api/v1/chat/completions", keyName: "OPENROUTER_API_KEY", testModel: "openai/gpt-5.4-mini", catalog: true, blurb: "One key, every major model. Easiest BYOK." },
  { id: "openai", label: "OpenAI", transport: "openai_chat", url: "https://api.openai.com/v1/chat/completions", keyName: "OPENAI_API_KEY", testModel: "gpt-5.4-mini", catalog: true, blurb: "Direct OpenAI." },
  { id: "anthropic", label: "Anthropic", transport: "anthropic", url: "https://api.anthropic.com/v1/messages", keyName: "ANTHROPIC_API_KEY", testModel: "claude-haiku-4-5", catalog: true, blurb: "Direct Anthropic (native transport)." },
  { id: "gemini", label: "Google Gemini", transport: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", keyName: "GEMINI_API_KEY", testModel: "gemini-2.5-flash", catalog: true, blurb: "Direct Google (model rides the URL)." },
  { id: "clover", label: "Clover (managed)", transport: "openai_chat", url: "http://hutch.rvbbit.ai:8090/v1/chat/completions", keyName: "RVBBIT_CLOVER_KEY", testModel: "gemma4", catalog: false, blurb: "DataRabbit's managed inference — free tier available." },
  { id: "ollama", label: "Ollama (local)", transport: "openai_chat", url: "http://localhost:11434/v1/chat/completions", keyName: "", testModel: "llama3.2", catalog: false, blurb: "Local models, zero keys." },
  { id: "custom", label: "Custom (OpenAI-compatible)", transport: "openai_chat", url: "", keyName: "", testModel: "", catalog: false, blurb: "vLLM, LM Studio, gateways — any /v1/chat/completions." },
] as const

const CATALOG_PROVIDERS = new Set(["openrouter", "openai", "anthropic", "gemini"])

export function AiProvidersWindow({ activeConnectionId }: { activeConnectionId: string | null }) {
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // "<action>:<provider>"
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [testModels, setTestModels] = useState<Record<string, string>>({})
  const [reloadTick, setReloadTick] = useState(0)

  // Add-provider form
  const [formOpen, setFormOpen] = useState(false)
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("openrouter")
  const [fName, setFName] = useState("openrouter")
  const [fTransport, setFTransport] = useState("openai_chat")
  const [fUrl, setFUrl] = useState<string>(PRESETS[0].url)
  const [fKeyName, setFKeyName] = useState<string>(PRESETS[0].keyName)
  const [fKey, setFKey] = useState("")
  const [fConcurrent, setFConcurrent] = useState("8")

  // Models browser
  const [modelFilter, setModelFilter] = useState("")
  const [modelProvider, setModelProvider] = useState("")
  const [models, setModels] = useState<ModelRow[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  // Per-provider model ids for the test-input datalists (combobox: pick
  // from the cached catalog, or type any id).
  const [modelIds, setModelIds] = useState<Record<string, string[]>>({})
  const listId = useId()

  const applyPreset = useCallback((id: (typeof PRESETS)[number]["id"]) => {
    const p = PRESETS.find((x) => x.id === id)!
    setPreset(id)
    setFName(id === "custom" ? "" : id)
    setFTransport(p.transport)
    setFUrl(p.url)
    setFKeyName(p.keyName)
  }, [])

  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    setLoading(true)
    const load = async () => {
      // A missing function fails at PARSE time even in an un-taken CASE
      // branch, so probe for 0194's credential_state before referencing it
      // (older engine + newer lens must still render).
      const probe = await dbQuery(
        activeConnectionId,
        "SELECT to_regprocedure('rvbbit.credential_state(text)') IS NOT NULL AS ok",
      )
      const hasCredFn = probe.rows?.[0]?.ok === true
      // Keep managed (capability-installed) models mirrored into
      // provider_models — cheap, idempotent, and older engines just skip.
      const syncProbe = await dbQuery(
        activeConnectionId,
        "SELECT to_regprocedure('rvbbit.sync_managed_provider_models()') IS NOT NULL AS ok",
      )
      if (syncProbe.rows?.[0]?.ok === true) {
        await dbQuery(activeConnectionId, "SELECT rvbbit.sync_managed_provider_models()")
      }
      const keyStateExpr = hasCredFn
        ? `CASE WHEN b.auth_header_env IS NULL THEN 'none' ELSE rvbbit.credential_state(b.auth_header_env) END`
        : `CASE WHEN b.auth_header_env IS NULL THEN 'none' ELSE 'unknown' END`
      const res = await dbQuery(
        activeConnectionId,
        `SELECT b.name, b.transport, b.endpoint_url, b.auth_header_env,
                coalesce(b.max_concurrent, 4) AS max_concurrent,
                coalesce(b.description, '') AS description,
                (b.name = rvbbit.default_provider()) AS is_default,
                EXISTS (SELECT 1 FROM rvbbit.list_secrets() s WHERE s.name = b.auth_header_env) AS has_secret,
                ${keyStateExpr} AS key_state,
                (b.install_manifest IS NOT NULL) AS managed,
                coalesce(b.install_manifest->>'capability', '') AS capability,
                coalesce(nullif(b.transport_opts->>'model', ''), '') AS default_model,
                (SELECT count(*) FROM rvbbit.provider_models m WHERE m.provider = b.name)::int AS model_count,
                (SELECT max(fetched_at) FROM rvbbit.provider_models m WHERE m.provider = b.name)::text AS models_fetched_at
         FROM rvbbit.backends b
         WHERE b.transport IN ('openai_chat', 'anthropic', 'gemini', 'openai')
         ORDER BY (b.name = rvbbit.default_provider()) DESC, b.name`,
      )
      if (cancelled) return
      if (res.error) setError(res.error)
      else {
        setError(null)
        setProviders((res.rows ?? []) as unknown as ProviderRow[])
      }
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, reloadTick])

  // Catalog ids for the listed providers → test-input datalists.
  useEffect(() => {
    if (!activeConnectionId || providers.length === 0) return
    let cancelled = false
    const names = providers.map((p) => sqlLit(p.name)).join(", ")
    void dbQuery(
      activeConnectionId,
      `SELECT provider, model FROM rvbbit.provider_models
       WHERE provider IN (${names}) AND available
       ORDER BY provider, model LIMIT 1500`,
      1500,
    ).then((res) => {
      if (cancelled || res.error) return
      const map: Record<string, string[]> = {}
      for (const r of res.rows ?? []) {
        const prov = String(r.provider)
        ;(map[prov] ??= []).push(String(r.model))
      }
      setModelIds(map)
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, providers])

  useEffect(() => {
    if (!activeConnectionId || !modelsOpen) return
    let cancelled = false
    const filter = modelFilter.trim().replace(/'/g, "''")
    void dbQuery(
      activeConnectionId,
      `SELECT provider, model, display_name, context_window, available
       FROM rvbbit.provider_models
       WHERE (${modelProvider ? `provider = ${sqlLit(modelProvider)}` : "true"})
         AND (${filter ? `(model ILIKE '%${filter}%' OR display_name ILIKE '%${filter}%')` : "true"})
       ORDER BY provider, model
       LIMIT 400`,
    ).then((res) => {
      if (!cancelled && !res.error) setModels((res.rows ?? []) as unknown as ModelRow[])
    })
    return () => {
      cancelled = true
    }
  }, [activeConnectionId, modelsOpen, modelFilter, modelProvider, reloadTick])

  const run = useCallback(
    async (key: string, sqls: string[], okNote: string) => {
      if (!activeConnectionId) return
      setBusy(key)
      setNote(null)
      for (const sql of sqls) {
        const res = await dbQuery(activeConnectionId, sql)
        if (res.error) {
          setNote(res.error)
          setBusy(null)
          return
        }
      }
      setBusy(null)
      setNote(okNote)
      setReloadTick((t) => t + 1)
    },
    [activeConnectionId],
  )

  const saveProvider = useCallback(async () => {
    if (!activeConnectionId || !fName.trim() || !fUrl.trim()) return
    setBusy("save")
    setNote(null)
    const name = fName.trim()
    const keyName = fKeyName.trim()
    try {
      if (fKey.trim() && keyName) {
        const r = await dbQuery(
          activeConnectionId,
          `SELECT rvbbit.set_secret(${sqlLit(keyName)}, ${sqlLit(fKey.trim())}, 'AI Providers panel')`,
        )
        if (r.error) throw new Error(r.error)
      }
      const r2 = await dbQuery(
        activeConnectionId,
        `SELECT rvbbit.register_backend(
           ${sqlLit(name)}, ${sqlLit(fUrl.trim())}, ${sqlLit(fTransport)},
           16, ${Math.max(1, Math.min(64, Number(fConcurrent) || 8))}, 60000,
           ${keyName ? sqlLit(keyName) : "NULL"}, '{}'::jsonb,
           ${sqlLit("LLM provider (AI Providers panel)")})`,
      )
      if (r2.error) throw new Error(r2.error)
      await dbQuery(activeConnectionId, "SELECT rvbbit.reload_backends()")
      setNote(`${name} saved${fKey.trim() ? " (key stored as secret — never shown again)" : ""}`)
      setFKey("")
      setFormOpen(false)
      setReloadTick((t) => t + 1)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [activeConnectionId, fName, fUrl, fTransport, fKeyName, fKey, fConcurrent])

  const testProvider = useCallback(
    async (p: ProviderRow) => {
      if (!activeConnectionId) return
      const model =
        testModels[p.name]?.trim() ||
        p.default_model ||
        PRESETS.find((x) => x.id === p.name)?.testModel ||
        ""
      if (!model) {
        setTestResults((r) => ({ ...r, [p.name]: { ok: false, detail: "enter a model id to test with" } }))
        return
      }
      setBusy(`test:${p.name}`)
      const res = await dbQuery(
        activeConnectionId,
        `SELECT rvbbit.provider_test(${sqlLit(p.name)}, ${sqlLit(model)}) AS r`,
      )
      setBusy(null)
      const raw = res.rows?.[0]?.r
      const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined
      if (res.error || !body) {
        setTestResults((r) => ({ ...r, [p.name]: { ok: false, detail: res.error ?? "no response" } }))
        return
      }
      setTestResults((r) => ({
        ...r,
        [p.name]: body.ok
          ? { ok: true, detail: `"${String(body.content ?? "").slice(0, 40)}" · ${body.latency_ms}ms · ${model}` }
          : { ok: false, detail: String(body.error ?? "failed") },
      }))
    },
    [activeConnectionId, testModels],
  )

  const refreshCatalog = useCallback(
    async (p: ProviderRow) => {
      if (!activeConnectionId) return
      setBusy(`refresh:${p.name}`)
      const res = await dbQuery(
        activeConnectionId,
        `SELECT provider, status, models, auth_state, coalesce(error,'') AS error
         FROM rvbbit.refresh_provider_catalogs(${sqlLit(p.name)})`,
      )
      setBusy(null)
      const row = res.rows?.[0]
      if (res.error || !row) setNote(res.error ?? "refresh returned nothing")
      else if (row.error) setNote(`${p.name}: ${row.error}`)
      else setNote(`${p.name}: ${row.models} models · auth ${row.auth_state}`)
      setReloadTick((t) => t + 1)
    },
    [activeConnectionId],
  )

  const providerNames = useMemo(() => [...new Set(models.map((m) => m.provider))], [models])

  if (!activeConnectionId) {
    return <div className="grid h-full place-items-center text-[12px] text-chrome-text/60">connect to a database first</div>
  }

  const input =
    "rounded border border-chrome-border bg-transparent px-1.5 py-0.5 text-[12px] outline-none placeholder:text-chrome-text/30"

  return (
    <div className="flex h-full flex-col text-[12px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <Sparkles className="h-3.5 w-3.5 text-main" />
        <span className="font-medium text-foreground">AI Providers</span>
        <span className="text-chrome-text/45">credentials & endpoints — every LLM feature reads this registry</span>
        <div className="flex-1" />
        {note ? <span className="max-w-[46%] truncate text-[11px] text-main/80" title={note}>{note}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="p-4 text-chrome-text/50">loading…</div>
        ) : error ? (
          <div className="p-4 text-destructive">{error}</div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {providers.length === 0 ? (
                <div className="rounded-md border border-chrome-border/60 p-3 leading-relaxed text-chrome-text/60">
                  No LLM providers configured — the assistant and semantic operators are asleep.
                  Add one below: OpenRouter is the easiest single key; Clover is DataRabbit&apos;s
                  managed option; Ollama needs no key at all.
                </div>
              ) : null}
              {providers.map((p) => {
                const test = testResults[p.name]
                const keyState = !p.auth_header_env
                  ? { label: "no key needed", ok: true }
                  : p.key_state === "env"
                    ? { label: `${p.auth_header_env} · via env ✓${p.has_secret ? " (secret also stored)" : ""}`, ok: true }
                    : p.key_state === "secret"
                      ? { label: `${p.auth_header_env} · stored secret ✓`, ok: true }
                      : p.key_state === "missing"
                        ? { label: `${p.auth_header_env} · MISSING`, ok: false }
                        : { label: `${p.auth_header_env} · ${p.has_secret ? "stored secret" : "state unknown (older engine)"}`, ok: p.has_secret }
                return (
                  <div key={p.name} className="rounded-md border border-chrome-border/60 bg-chrome-bg/20 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Plug className={cn("h-3.5 w-3.5 shrink-0", p.is_default ? "text-main" : "text-chrome-text/40")} />
                      <span className="font-medium text-foreground">{p.name}</span>
                      {p.managed ? (
                        <span
                          className="rounded-full border border-chrome-border px-1.5 text-[9px] uppercase tracking-wider text-chrome-text/55"
                          title={`Installed by the ${p.capability || "capability"} capability — endpoint, key & lifecycle are managed there (Capabilities panel), not here.`}
                        >
                          managed · {p.capability.replace(/^managed\//, "") || "capability"}
                        </span>
                      ) : null}
                      {p.is_default ? (
                        <span className="rounded-full border border-main/40 px-1.5 text-[9px] uppercase tracking-wider text-main">default</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            void run(
                              `default:${p.name}`,
                              [`SELECT rvbbit.set_default_provider(${sqlLit(p.name)})`, "SELECT rvbbit.reload_backends()"],
                              `${p.name} is now the default provider`,
                            )
                          }
                          className="rounded-full border border-chrome-border px-1.5 text-[9px] uppercase tracking-wider text-chrome-text/50 hover:text-foreground"
                        >
                          make default
                        </button>
                      )}
                      <span className="truncate text-[10.5px] text-chrome-text/45">{p.transport} · {p.endpoint_url}</span>
                      <div className="flex-1" />
                      <span className={cn("shrink-0 text-[10px]", keyState.ok ? "text-chrome-text/45" : "text-warning")}>{keyState.label}</span>
                      {p.managed ? null : (
                        <button
                          type="button"
                          title="Remove this provider (backends row only — the stored secret stays)"
                          onClick={() =>
                            void run(
                              `rm:${p.name}`,
                              [`DELETE FROM rvbbit.backends WHERE name = ${sqlLit(p.name)}`, "SELECT rvbbit.reload_backends()"],
                              `${p.name} removed`,
                            )
                          }
                          className="text-chrome-text/35 hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <input
                        value={testModels[p.name] ?? ""}
                        onChange={(e) => setTestModels((m) => ({ ...m, [p.name]: e.target.value }))}
                        list={modelIds[p.name]?.length ? `${listId}-${p.name}` : undefined}
                        placeholder={
                          (p.default_model ? `${p.default_model} (backend default)` : "") ||
                          PRESETS.find((x) => x.id === p.name)?.testModel ||
                          (modelIds[p.name]?.length ? `pick a model (${modelIds[p.name].length} cached)` : "model id to test")
                        }
                        spellCheck={false}
                        className={cn(input, "w-56")}
                      />
                      {modelIds[p.name]?.length ? (
                        <datalist id={`${listId}-${p.name}`}>
                          {modelIds[p.name].map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void testProvider(p)}
                        disabled={busy != null}
                        className="rounded border border-main/40 px-2 py-0.5 text-main disabled:opacity-40"
                      >
                        {busy === `test:${p.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : "test"}
                      </button>
                      {CATALOG_PROVIDERS.has(p.name) ? (
                        <button
                          type="button"
                          onClick={() => void refreshCatalog(p)}
                          disabled={busy != null}
                          title="Fetch the live model list into rvbbit.provider_models"
                          className="flex items-center gap-1 rounded border border-chrome-border px-2 py-0.5 text-chrome-text/70 hover:text-foreground disabled:opacity-40"
                        >
                          {busy === `refresh:${p.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          models
                        </button>
                      ) : null}
                      {p.model_count > 0 ? (
                        <span className="text-[10px] text-chrome-text/45">{p.model_count} models cached</span>
                      ) : null}
                      {test ? (
                        <span className={cn("flex min-w-0 items-center gap-1 truncate text-[10.5px]", test.ok ? "text-main/80" : "text-destructive")}>
                          {test.ok ? <Check className="h-3 w-3 shrink-0" /> : <X className="h-3 w-3 shrink-0" />}
                          <span className="truncate" title={test.detail}>{test.detail}</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Add provider */}
            <div className="mt-3 rounded-md border border-chrome-border/60">
              <button
                type="button"
                onClick={() => setFormOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-chrome-text/70 hover:text-foreground"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", formOpen ? "" : "-rotate-90")} />
                Add a provider
              </button>
              {formOpen ? (
                <div className="space-y-2 border-t border-chrome-border/50 p-2.5">
                  <div className="flex flex-wrap gap-1">
                    {PRESETS.map((pr) => (
                      <button
                        key={pr.id}
                        type="button"
                        onClick={() => applyPreset(pr.id)}
                        title={pr.blurb}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10.5px]",
                          preset === pr.id ? "border-main/50 text-main" : "border-chrome-border text-chrome-text/60 hover:text-foreground",
                        )}
                      >
                        {pr.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="name (e.g. openrouter)" spellCheck={false} className={cn(input, "w-40")} />
                    <input value={fUrl} onChange={(e) => setFUrl(e.target.value)} placeholder="chat completions URL" spellCheck={false} className={cn(input, "min-w-72 flex-1")} />
                    <select value={fTransport} onChange={(e) => setFTransport(e.target.value)} className={cn(input, "bg-chrome-bg")}>
                      <option value="openai_chat">openai_chat</option>
                      <option value="anthropic">anthropic</option>
                      <option value="gemini">gemini</option>
                    </select>
                    <input value={fConcurrent} onChange={(e) => setFConcurrent(e.target.value)} placeholder="lanes" title="max concurrent requests" className={cn(input, "w-14")} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input value={fKeyName} onChange={(e) => setFKeyName(e.target.value)} placeholder="key name (blank = no auth)" spellCheck={false} className={cn(input, "w-52")} title="Env var checked first; pasted keys are stored under this name in rvbbit.secrets" />
                    <input value={fKey} onChange={(e) => setFKey(e.target.value)} type="password" placeholder="paste API key (optional if set via env)" className={cn(input, "min-w-64 flex-1")} autoComplete="off" />
                    <button
                      type="button"
                      disabled={!fName.trim() || !fUrl.trim() || busy != null}
                      onClick={() => void saveProvider()}
                      className="rounded border border-main/40 px-2.5 py-0.5 text-main disabled:opacity-40"
                    >
                      {busy === "save" ? <Loader2 className="h-3 w-3 animate-spin" /> : "save provider"}
                    </button>
                  </div>
                  <div className="text-[10.5px] leading-relaxed text-chrome-text/45">
                    Keys resolve env-var first (deploy-time wins), then the encrypted-at-rest-by-your-database
                    rvbbit.secrets table. Pasted keys are never displayed again. Saving re-registers the
                    backend and reloads the engine&apos;s spec cache — everything that calls LLMs picks it up immediately.
                  </div>
                </div>
              ) : null}
            </div>

            {/* Models browser */}
            <div className="mt-3 rounded-md border border-chrome-border/60">
              <button
                type="button"
                onClick={() => setModelsOpen((o) => !o)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-chrome-text/70 hover:text-foreground"
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", modelsOpen ? "" : "-rotate-90")} />
                Browse model catalogs
                <span className="text-[10px] text-chrome-text/40">rvbbit.provider_models — refreshed per provider above</span>
              </button>
              {modelsOpen ? (
                <div className="border-t border-chrome-border/50 p-2.5">
                  <div className="mb-2 flex items-center gap-1.5">
                    <input value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="filter models…" className={cn(input, "w-56")} />
                    <select value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} className={cn(input, "bg-chrome-bg")}>
                      <option value="">all providers</option>
                      {[...new Set([...providerNames, ...providers.map((p) => p.name)])].sort().map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-chrome-text/40">{models.length} shown · click a row to copy the model id</span>
                  </div>
                  <div className="max-h-72 overflow-y-auto rounded border border-chrome-border/40">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-chrome-bg">
                        <tr className="text-left text-[9.5px] uppercase tracking-wider text-chrome-text/45">
                          <th className="px-2 py-1">provider</th>
                          <th className="px-2 py-1">model</th>
                          <th className="px-2 py-1">context</th>
                          <th className="px-2 py-1">ok</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((m) => (
                          <tr
                            key={`${m.provider}:${m.model}`}
                            onClick={() => {
                              void navigator.clipboard.writeText(m.model).catch(() => {})
                              setNote(`copied ${m.model}`)
                            }}
                            className="cursor-pointer border-t border-chrome-border/30 hover:bg-foreground/[0.04]"
                            title={m.display_name ?? m.model}
                          >
                            <td className="px-2 py-0.5 text-chrome-text/55">{m.provider}</td>
                            <td className="px-2 py-0.5 font-mono text-foreground">{m.model}</td>
                            <td className="px-2 py-0.5 tabular-nums text-chrome-text/55">{m.context_window ? `${Math.round(Number(m.context_window) / 1000)}k` : "—"}</td>
                            <td className="px-2 py-0.5">{m.available ? "✓" : "✗"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
