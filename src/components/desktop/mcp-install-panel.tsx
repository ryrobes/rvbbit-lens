"use client"

import { useEffect, useState } from "react"

import {
  fetchMcpSecretNames,
  installMcpCapability,
  type McpCapability,
  type McpInstallResult,
} from "@/lib/rvbbit/mcp"

const mcpInputCls =
  "mt-0.5 w-full rounded border border-chrome-border bg-chrome-bg px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-rvbbit-accent/50"

/**
 * The install surface for an MCP capability: a server name + one password
 * input per declared secret + the Install button + drift result. The keys the
 * user types are pushed straight to the gateway's encrypted store (never PG) —
 * see {@link installMcpCapability}. Extracted so both the MCP servers window's
 * catalog browser and the unified capability-detail window render the same
 * thing (MCP capabilities want *keys*, not the model "install knobs").
 */
export function McpInstallPanel({
  connId,
  cap,
  onInstalled,
  onBack,
}: {
  connId: string | null
  cap: McpCapability
  onInstalled?: () => void | Promise<void>
  /** When set, renders a "← back" affordance (catalog-list usage). */
  onBack?: () => void
}) {
  const [serverName, setServerName] = useState(cap.name)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState(false)
  const [result, setResult] = useState<McpInstallResult | null>(null)
  const [savedNames, setSavedNames] = useState<Set<string>>(new Set())

  // Which keys does the gateway already hold for this server name? (names
  // only — values never leave the gateway). Lets reinstalls/updates show
  // "saved" instead of a blank submit-only form.
  useEffect(() => {
    if (!connId || !serverName.trim()) return
    let cancelled = false
    void fetchMcpSecretNames(connId, serverName.trim()).then((names) => {
      if (!cancelled) setSavedNames(new Set(names))
    })
    return () => {
      cancelled = true
    }
  }, [connId, serverName])

  const missingRequired = cap.secrets.some(
    (s) => s.required && !(secrets[s.envVar] ?? "").trim() && !savedNames.has(s.envVar),
  )

  const doInstall = async () => {
    if (!connId) return
    setInstalling(true)
    setResult(null)
    // Only push keys the user actually typed — blank fields keep whatever the
    // gateway already holds (the "saved" state).
    const typed = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim().length > 0))
    const r = await installMcpCapability(connId, cap.id, serverName.trim() || cap.name, typed)
    setInstalling(false)
    setResult(r)
    if (r.ok) await onInstalled?.()
  }

  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{cap.title}</span>
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="text-[10px] text-chrome-text/60 hover:text-foreground"
          >
            ← back
          </button>
        ) : null}
      </div>
      <div className="text-[10px] text-chrome-text/60">
        adds {cap.operators.length} operators + {cap.nResources} tables
      </div>

      <label className="block">
        <span className="text-[10px] text-chrome-text/60">install as server</span>
        <input
          value={serverName}
          onChange={(e) => setServerName(e.target.value)}
          className={mcpInputCls}
        />
      </label>

      {cap.secrets.length > 0 ? (
        <div className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-wider text-chrome-text/50">keys</span>
          {cap.secrets.map((s) => {
            const saved = savedNames.has(s.envVar)
            return (
              <label key={s.name} className="block">
                <span className="flex items-center justify-between">
                  <span className="text-[10px] text-chrome-text/70">
                    {s.label}
                    {s.required ? <span className="text-danger"> *</span> : null}
                    {saved ? (
                      <span className="ml-1.5 rounded-full bg-rvbbit-accent/15 px-1.5 py-px text-[9px] text-rvbbit-accent">
                        saved
                      </span>
                    ) : null}
                  </span>
                  {s.link ? (
                    <a
                      href={s.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-rvbbit-accent hover:underline"
                    >
                      get a key →
                    </a>
                  ) : null}
                </span>
                <input
                  type="password"
                  value={secrets[s.envVar] ?? ""}
                  onChange={(e) => setSecrets((p) => ({ ...p, [s.envVar]: e.target.value }))}
                  placeholder={saved ? "●●●●●●●●●●●●  saved — paste to replace" : s.help || s.envVar}
                  className={mcpInputCls}
                  style={saved ? { borderColor: "color-mix(in oklch, var(--rvbbit-accent, #7dd3a8) 45%, transparent)" } : undefined}
                />
              </label>
            )
          })}
          <div className="text-[9px] leading-snug text-chrome-text/45">
            Keys go straight to the gateway&apos;s encrypted store — Postgres only ever
            sees a <code className="text-chrome-text/65">${"{VAR}"}</code> reference.
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-chrome-text/50">No keys required.</div>
      )}

      <button
        type="button"
        onClick={() => void doInstall()}
        disabled={installing || !connId || missingRequired}
        className="inline-flex items-center gap-1 rounded border border-rvbbit-accent/50 bg-rvbbit-accent/15 px-2 py-1 text-[11px] text-rvbbit-accent disabled:opacity-50"
      >
        {installing ? "Installing…" : "Install"}
      </button>

      {result ? (
        result.ok ? (
          <div className="rounded border border-success/40 bg-success/10 px-2 py-1 text-[10px] text-success">
            Installed “{result.server}” — {result.operatorsCreated} operators created.{" "}
            {result.drift?.changed
              ? `Drift vs manifest: +${result.drift.added.length} / −${result.drift.removed.length}.`
              : "No drift."}
          </div>
        ) : (
          <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">
            {result.error}
          </div>
        )
      ) : null}
    </div>
  )
}
