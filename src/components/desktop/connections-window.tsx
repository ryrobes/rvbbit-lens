"use client"

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Plus, Trash2, XCircle, Plug, Loader2 } from "@/lib/icons"
import type { ConnectionRecord, ConnectionTestResult, SslMode } from "@/lib/db/types"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type SanitizedConnection = Omit<ConnectionRecord, "password"> & { hasPassword: boolean }

interface ConnectionsWindowProps {
  onChanged: () => Promise<void>
}

interface DraftConnection {
  id?: string
  label: string
  host: string
  port: string
  database: string
  user: string
  password: string
  sslMode: SslMode
  connectionString?: string
  isDefault: boolean
}

const EMPTY_DRAFT: DraftConnection = {
  label: "",
  host: "localhost",
  port: "5432",
  database: "postgres",
  user: "postgres",
  password: "",
  sslMode: "prefer",
  isDefault: false,
}

export function ConnectionsWindow({ onChanged }: ConnectionsWindowProps) {
  const [connections, setConnections] = useState<SanitizedConnection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftConnection>(EMPTY_DRAFT)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch("/api/db/connections", { cache: "no-store" })
    if (!res.ok) return
    const body = (await res.json()) as { connections: SanitizedConnection[] }
    setConnections(body.connections)
  }, [])

  useEffect(() => { void reload() }, [reload])

  function loadIntoDraft(c: SanitizedConnection | null) {
    setTestResult(null)
    setError(null)
    if (!c) {
      setDraft(EMPTY_DRAFT)
      setSelectedId(null)
      return
    }
    setSelectedId(c.id)
    setDraft({
      id: c.id,
      label: c.label,
      host: c.host,
      port: String(c.port),
      database: c.database,
      user: c.user,
      password: "",
      sslMode: c.sslMode ?? "prefer",
      connectionString: c.connectionString,
      isDefault: c.isDefault ?? false,
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/db/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          label: draft.label,
          host: draft.host,
          port: Number(draft.port) || 5432,
          database: draft.database,
          user: draft.user,
          password: draft.password.length > 0 ? draft.password : undefined,
          sslMode: draft.sslMode,
          connectionString: draft.connectionString,
          isDefault: draft.isDefault,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? "save failed")
      setSelectedId(body.connection.id)
      await reload()
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    if (!draft.id) {
      setError("Save the connection first to test it.")
      return
    }
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      const res = await fetch("/api/db/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: draft.id }),
      })
      const body = (await res.json()) as ConnectionTestResult
      setTestResult(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    if (!draft.id) return
    if (!confirm("Delete this connection?")) return
    const res = await fetch(`/api/db/connections/${encodeURIComponent(draft.id)}`, { method: "DELETE" })
    if (!res.ok) return
    loadIntoDraft(null)
    await reload()
    await onChanged()
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 flex-col border-r border-chrome-border bg-chrome-bg/30">
        <div className="flex items-center justify-between border-b border-chrome-border px-3 py-2 text-[11px] uppercase tracking-wider text-chrome-text">
          <span>Saved</span>
          <button
            type="button"
            onClick={() => loadIntoDraft(null)}
            className="grid h-5 w-5 place-items-center rounded text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
            title="New connection"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1">
          {connections.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-chrome-text/70">No connections yet.</div>
          ) : (
            connections.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => loadIntoDraft(c)}
                className={cn(
                  "block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-foreground/[0.06]",
                  c.id === selectedId ? "bg-foreground/[0.08] text-foreground" : "text-chrome-text",
                )}
              >
                <div className="flex items-center gap-1.5 truncate">
                  <Plug className="h-3 w-3 shrink-0 text-main" />
                  <span className="truncate">{c.label}</span>
                </div>
                <div className="ml-4 truncate text-[10px] text-chrome-text/70">
                  {c.user}@{c.host}:{c.port}/{c.database}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex flex-1 flex-col overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label">
            <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="My local Postgres" />
          </Field>
          <Field label="Host">
            <Input value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder="localhost" />
          </Field>
          <Field label="Port">
            <Input value={draft.port} onChange={(e) => setDraft({ ...draft, port: e.target.value.replace(/[^0-9]/g, "") })} />
          </Field>
          <Field label="Database">
            <Input value={draft.database} onChange={(e) => setDraft({ ...draft, database: e.target.value })} placeholder="postgres" />
          </Field>
          <Field label="User">
            <Input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              placeholder={draft.id ? "(unchanged)" : ""}
            />
          </Field>
          <Field label="SSL Mode">
            <select
              value={draft.sslMode}
              onChange={(e) => setDraft({ ...draft, sslMode: e.target.value as SslMode })}
              className="h-9 w-full rounded-base border-2 border-border bg-secondary-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="prefer">prefer</option>
              <option value="require">require</option>
              <option value="no-verify">require (no-verify)</option>
              <option value="disable">disable</option>
            </select>
          </Field>
          <Field label="Default">
            <label className="flex h-9 items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
              />
              Use as default
            </label>
          </Field>
        </div>

        <Field label="Connection string (overrides above)" className="mt-3">
          <Input
            value={draft.connectionString ?? ""}
            onChange={(e) => setDraft({ ...draft, connectionString: e.target.value || undefined })}
            placeholder="postgres://user:pass@host:5432/db?sslmode=prefer"
          />
        </Field>

        {error ? (
          <div className="mt-3 rounded-base border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}

        {testResult ? <TestResultPanel result={testResult} /> : null}

        <div className="mt-4 flex items-center gap-2">
          <Button onClick={save} disabled={saving || !draft.label}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {draft.id ? "Save" : "Create"}
          </Button>
          <Button variant="neutral" onClick={test} disabled={testing || !draft.id}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Test
          </Button>
          <div className="flex-1" />
          {draft.id ? (
            <Button variant="ghost" onClick={remove}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1 text-[11px] uppercase tracking-wider text-chrome-text", className)}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function TestResultPanel({ result }: { result: ConnectionTestResult }) {
  if (!result.ok) {
    return (
      <div className="mt-3 rounded-base border border-danger/50 bg-danger/10 p-3 text-xs text-danger">
        <div className="flex items-center gap-1.5 font-medium">
          <XCircle className="h-3.5 w-3.5" />
          Failed in {result.durationMs}ms
        </div>
        <div className="mt-1 text-danger/90">{result.error}</div>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-base border border-success/40 bg-success/10 p-3 text-xs text-success">
      <div className="flex items-center gap-1.5 font-medium">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected in {result.durationMs}ms
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 text-chrome-text">
        <span>Database: <span className="text-foreground">{result.database}</span></span>
        <span>Schemas: <span className="text-foreground">{result.schemaCount}</span></span>
        <span>Tables: <span className="text-foreground">{result.tableCount}</span></span>
        <span>
          Rvbbit:{" "}
          {result.hasRvbbit ? (
            <span className="text-rvbbit-accent">v{result.rvbbitVersion}</span>
          ) : (
            <span className="text-chrome-text/70">not installed</span>
          )}
        </span>
      </div>
      {result.serverVersion ? (
        <div className="mt-1 truncate text-chrome-text/70">{result.serverVersion}</div>
      ) : null}
    </div>
  )
}
