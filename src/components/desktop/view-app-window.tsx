"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, Play, RefreshCw } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { ResultGrid } from "./result-grid"
import { getViewApp } from "@/lib/desktop/view-apps"
import { iconFor } from "@/lib/desktop/icon-glyphs"
import type { QueryResult } from "@/lib/db/types"
import type { ViewAppPayload } from "@/lib/desktop/types"

interface ViewAppWindowProps {
  payload: ViewAppPayload
  activeConnectionId: string | null
}

export function ViewAppWindow({ payload, activeConnectionId }: ViewAppWindowProps) {
  const app = useMemo(() => getViewApp(payload.appId), [payload.appId])
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    if (!app) return
    const connectionId = app.connectionId ?? activeConnectionId
    if (!connectionId) {
      setError("This app has no connection; select one in the menu bar.")
      return
    }
    setRunning(true)
    setError(null)
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId, sql: app.sql, rowLimit: 5000 }),
      })
      const body = await res.json()
      if (body.ok === false) {
        setError(body.error ?? "query failed")
        setResult(null)
      } else {
        setResult(body as QueryResult)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [app, activeConnectionId])

  useEffect(() => { void run() }, [run])

  if (!app) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-xs text-chrome-text">
        <div>
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
          View app no longer exists.
        </div>
      </div>
    )
  }

  const Icon = iconFor(app.iconKey)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
        <span className="grid h-7 w-7 place-items-center rounded border border-icon-tile-border bg-icon-tile-bg">
          <Icon className="h-3.5 w-3.5" style={{ color: app.iconColor }} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="truncate text-[12px] text-foreground">{app.name}</div>
          {app.description ? (
            <div className="truncate text-[10px] text-chrome-text">{app.description}</div>
          ) : null}
        </div>
        <Button size="sm" variant="neutral" onClick={run} disabled={running} title="Re-run">
          <RefreshCw className={running ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="m-4 inline-flex items-center gap-2 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        ) : null}
        {!error && result ? <ResultGrid columns={result.columns} rows={result.rows} /> : null}
        {!error && !result ? (
          <div className="grid h-full place-items-center text-xs text-chrome-text">
            <Button size="sm" onClick={run}>
              <Play className="h-3 w-3" />
              Run
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
