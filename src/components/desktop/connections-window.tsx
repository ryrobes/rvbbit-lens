"use client"

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Plus, Trash2, XCircle, Plug, Loader2 } from "@/lib/icons"
import type { ConnectionTestResult, SslMode } from "@/lib/db/types"
import type { SanitizedConnection } from "@/lib/db/registry"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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
  // ── SSH tunnel ──
  sshEnabled: boolean
  sshHost: string
  sshPort: string
  sshUser: string
  sshKeyPath: string
  sshPrivateKey: string
  sshPassphrase: string
  sshPassword: string
  // placeholders: whether a secret is already stored (for "(unchanged)" hints)
  hasSshPrivateKey: boolean
  hasSshPassphrase: boolean
  hasSshPassword: boolean
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
  sshEnabled: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshKeyPath: "",
  sshPrivateKey: "",
  sshPassphrase: "",
  sshPassword: "",
  hasSshPrivateKey: false,
  hasSshPassphrase: false,
  hasSshPassword: false,
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
      sshEnabled: c.sshEnabled ?? false,
      sshHost: c.sshHost ?? "",
      sshPort: c.sshPort ? String(c.sshPort) : "22",
      sshUser: c.sshUser ?? "",
      sshKeyPath: c.sshKeyPath ?? "",
      sshPrivateKey: "",
      sshPassphrase: "",
      sshPassword: "",
      hasSshPrivateKey: c.hasSshPrivateKey,
      hasSshPassphrase: c.hasSshPassphrase,
      hasSshPassword: c.hasSshPassword,
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
          sshEnabled: draft.sshEnabled,
          // Non-secret fields: send the (possibly empty) trimmed string so clearing
          // a field actually sticks (server distinguishes "" = clear from undefined).
          sshHost: draft.sshHost.trim(),
          sshPort: draft.sshPort.trim() ? Number(draft.sshPort) : undefined,
          sshUser: draft.sshUser.trim(),
          sshKeyPath: draft.sshKeyPath.trim(),
          // Secrets: send only when the user typed a new value, so a blank field
          // preserves the stored secret (server-side normalizeInput keeps existing).
          sshPrivateKey: draft.sshPrivateKey.length > 0 ? draft.sshPrivateKey : undefined,
          sshPassphrase: draft.sshPassphrase.length > 0 ? draft.sshPassphrase : undefined,
          sshPassword: draft.sshPassword.length > 0 ? draft.sshPassword : undefined,
        }),
      })
      const body = (await res.json()) as { connection?: SanitizedConnection; error?: string }
      if (!res.ok || !body.connection) throw new Error(body?.error ?? "save failed")
      loadIntoDraft(body.connection)
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

  // A connection string and an SSH tunnel are mutually exclusive (a tunnel needs
  // host/port mode), so each disables the other in the form.
  const hasConnString = Boolean(draft.connectionString && draft.connectionString.length > 0)

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
            disabled={draft.sshEnabled}
            title={draft.sshEnabled ? "Disabled while SSH tunneling is on — a tunnel needs host/port mode" : undefined}
          />
        </Field>

        {/* ── SSH tunnel (bastion) ── */}
        <div className="mt-4 rounded-base border border-border/60 bg-secondary-background/40 p-3">
          <label
            className={cn(
              "flex items-center gap-2 text-sm text-foreground",
              hasConnString && "opacity-50",
            )}
          >
            <input
              type="checkbox"
              checked={draft.sshEnabled}
              disabled={hasConnString}
              onChange={(e) => setDraft({ ...draft, sshEnabled: e.target.checked })}
            />
            <span className="font-medium">Connect through an SSH tunnel</span>
            {hasConnString ? (
              <span className="text-[11px] font-normal text-chrome-text/60">
                — clear the connection string to use a tunnel
              </span>
            ) : null}
          </label>
          {draft.sshEnabled ? (
            <>
              <p className="mt-2 text-[11px] leading-relaxed text-chrome-text/70">
                The DB <span className="text-foreground">Host</span>/<span className="text-foreground">Port</span> above are
                resolved <em>from the SSH host</em> (like <code className="text-chrome-text">ssh -L</code>). For a DB on the
                bastion itself, use host <code className="text-chrome-text">localhost</code>. SSH tunneling requires
                host/port mode (not a connection string), and typically SSL Mode <code className="text-chrome-text">disable</code>{" "}
                or <code className="text-chrome-text">no-verify</code> since SSH already encrypts the hop.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="SSH Host">
                  <Input
                    value={draft.sshHost}
                    onChange={(e) => setDraft({ ...draft, sshHost: e.target.value })}
                    placeholder="bastion.example.com"
                  />
                </Field>
                <Field label="SSH Port">
                  <Input
                    value={draft.sshPort}
                    onChange={(e) => setDraft({ ...draft, sshPort: e.target.value.replace(/[^0-9]/g, "") })}
                    placeholder="22"
                  />
                </Field>
                <Field label="SSH User">
                  <Input
                    value={draft.sshUser}
                    onChange={(e) => setDraft({ ...draft, sshUser: e.target.value })}
                    placeholder="ubuntu"
                  />
                </Field>
                <Field label="Private key file (path)">
                  <Input
                    value={draft.sshKeyPath}
                    onChange={(e) => setDraft({ ...draft, sshKeyPath: e.target.value })}
                    placeholder="~/key.pem"
                  />
                </Field>
              </div>
              <Field label="…or paste private key" className="mt-3">
                <textarea
                  value={draft.sshPrivateKey}
                  onChange={(e) => setDraft({ ...draft, sshPrivateKey: e.target.value })}
                  placeholder={
                    draft.hasSshPrivateKey ? "(unchanged — paste to replace)" : "-----BEGIN OPENSSH PRIVATE KEY-----"
                  }
                  rows={3}
                  spellCheck={false}
                  className="w-full rounded-base border-2 border-border bg-secondary-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
              </Field>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Field label="Key passphrase">
                  <Input
                    type="password"
                    value={draft.sshPassphrase}
                    onChange={(e) => setDraft({ ...draft, sshPassphrase: e.target.value })}
                    placeholder={draft.hasSshPassphrase ? "(unchanged)" : ""}
                  />
                </Field>
                <Field label="…or SSH password">
                  <Input
                    type="password"
                    value={draft.sshPassword}
                    onChange={(e) => setDraft({ ...draft, sshPassword: e.target.value })}
                    placeholder={draft.hasSshPassword ? "(unchanged)" : ""}
                  />
                </Field>
              </div>
            </>
          ) : null}
        </div>

        {error ? (
          <div className="mt-3 rounded-base border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        ) : null}

        {testResult ? <TestResultPanel result={testResult} /> : null}

        <div className="sticky bottom-0 -mx-4 mt-4 flex items-center gap-2 border-t border-chrome-border bg-block-bg/95 px-4 py-3 backdrop-blur">
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
