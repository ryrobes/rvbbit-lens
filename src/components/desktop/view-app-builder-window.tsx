"use client"

import { useMemo, useState } from "react"
import { Save } from "@/lib/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SqlEditor } from "./sql-editor"
import { getViewApp, upsertViewApp } from "@/lib/desktop/view-apps"
import { ICON_COLOR_OPTIONS, ICON_GLYPHS } from "@/lib/desktop/icon-glyphs"
import type { ViewAppBuilderPayload } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"

interface ViewAppBuilderWindowProps {
  payload: ViewAppBuilderPayload
  activeConnectionId: string | null
  onClose: () => void
}

export function ViewAppBuilderWindow({ payload, activeConnectionId }: ViewAppBuilderWindowProps) {
  const existing = useMemo(() => (payload.appId ? getViewApp(payload.appId) : null), [payload.appId])

  const [name, setName] = useState(existing?.name ?? payload.initialName ?? "")
  const [description, setDescription] = useState(existing?.description ?? "")
  const [sql, setSql] = useState(existing?.sql ?? payload.initialSql ?? "SELECT 1;")
  const [iconKey, setIconKey] = useState(existing?.iconKey ?? "play")
  const [iconColor, setIconColor] = useState(existing?.iconColor ?? ICON_COLOR_OPTIONS[0].value)
  const chartSpec = existing?.chartSpec ?? payload.initialChartSpec ?? null
  const statementViews = existing?.statementViews ?? payload.initialStatementViews
  const statementLayout = existing?.statementLayout ?? payload.initialStatementLayout
  const viewKind = existing?.viewKind ?? payload.initialViewKind
  const controlField = existing?.controlField ?? payload.initialControlField
  const [saved, setSaved] = useState(false)

  function save() {
    upsertViewApp({
      id: existing?.id,
      name: name || "Untitled",
      description,
      sql,
      iconKey,
      iconColor,
      connectionId: existing?.connectionId ?? activeConnectionId ?? null,
      chartSpec,
      statementViews,
      statementLayout,
      viewKind,
      controlField,
    })
    setSaved(true)
    window.dispatchEvent(new Event("rvbbit-lens:apps-changed"))
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-64 flex-col border-r border-chrome-border bg-chrome-bg/30 p-3">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }} placeholder="Daily orders" />
        <Label className="mt-3">Description</Label>
        <textarea
          value={description}
          onChange={(e) => { setDescription(e.target.value); setSaved(false) }}
          rows={3}
          className="h-20 w-full resize-none rounded-base border-2 border-border bg-secondary-background p-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <Label className="mt-3">Icon</Label>
        <div className="grid max-h-44 grid-cols-7 gap-1 overflow-y-auto rounded-base border border-chrome-border bg-secondary-background/40 p-1">
          {ICON_GLYPHS.map((g) => {
            const Icon = g.icon
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => { setIconKey(g.key); setSaved(false) }}
                title={g.label}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded border",
                  iconKey === g.key
                    ? "border-main/80 bg-main/15 text-foreground"
                    : "border-transparent text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            )
          })}
        </div>

        <Label className="mt-3">Color</Label>
        <div className="flex flex-wrap gap-1.5">
          {ICON_COLOR_OPTIONS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => { setIconColor(c.value); setSaved(false) }}
              title={c.key}
              className={cn(
                "h-6 w-6 rounded-md border-2",
                iconColor === c.value ? "border-foreground" : "border-transparent",
              )}
              style={{ backgroundColor: c.value }}
            />
          ))}
        </div>

        <div className="mt-auto pt-3">
          <Button onClick={save} disabled={!name && !sql.trim()} className="w-full">
            <Save className="h-3.5 w-3.5" />
            {saved ? "Saved" : existing ? "Update app" : "Create app"}
          </Button>
        </div>
      </aside>

      <section className="flex flex-1 flex-col">
        <div className="border-b border-chrome-border bg-chrome-bg/30 px-3 py-1.5 text-[11px] uppercase tracking-wider text-chrome-text">
          SQL · ⌘↩ to test
        </div>
        <div className="flex-1 overflow-hidden">
          <SqlEditor value={sql} onChange={(next) => { setSql(next); setSaved(false) }} />
        </div>
      </section>
    </div>
  )
}

function Label({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("mb-1 text-[10px] uppercase tracking-wider text-chrome-text", className)}>
      {children}
    </span>
  )
}
