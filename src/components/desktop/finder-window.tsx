"use client"

import { useMemo, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  Database,
  FolderOpen,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
  Loader2,
} from "@/lib/icons"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { SchemaSnapshot, SchemaTable } from "@/lib/db/types"
import { cn } from "@/lib/utils"

interface FinderWindowProps {
  schema: SchemaSnapshot | null
  loading: boolean
  activeConnectionId: string | null
  onOpenTable: (schema: string, name: string) => void
  onReload: () => void
  onOpenConnections: () => void
}

export function FinderWindow({
  schema,
  loading,
  activeConnectionId,
  onOpenTable,
  onReload,
  onOpenConnections,
}: FinderWindowProps) {
  const [search, setSearch] = useState("")
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(() => new Set(["public", "rvbbit"]))

  const grouped = useMemo(() => groupTables(schema?.tables ?? [], search), [schema?.tables, search])

  if (!activeConnectionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Plug className="h-8 w-8 text-chrome-text/60" />
        <div className="text-sm text-chrome-text">No connection selected.</div>
        <Button size="sm" variant="neutral" onClick={onOpenConnections}>Open Connections</Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-chrome-border px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-chrome-text/60" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tables..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={onReload} title="Reload schema" className="h-7 w-7">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
        <Database className="h-3 w-3" />
        <span className="truncate">{schema?.currentDatabase ?? "—"}</span>
        {schema?.hasRvbbit ? (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-rvbbit-accent/40 bg-rvbbit-bg/40 px-1.5 py-0 text-[9px] uppercase tracking-wide text-rvbbit-accent">
            <Sparkles className="h-2.5 w-2.5" />
            rvbbit v{schema.rvbbitVersion}
          </span>
        ) : null}
        <div className="flex-1" />
        <span>
          {(schema?.tables?.length ?? 0)} tables ·{" "}
          {(schema?.schemas?.length ?? 0)} schemas
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!schema && loading ? (
          <div className="flex h-32 items-center justify-center text-xs text-chrome-text/70">
            <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading schema...
          </div>
        ) : null}
        {schema && grouped.length === 0 ? (
          <div className="px-4 py-3 text-xs text-chrome-text/70">No tables match &quot;{search}&quot;.</div>
        ) : null}
        {grouped.map(({ schema: ns, tables }) => {
          const isOpen = openSchemas.has(ns)
          return (
            <div key={ns} className="border-b border-chrome-border/50 last:border-b-0">
              <button
                type="button"
                onClick={() => {
                  setOpenSchemas((s) => {
                    const next = new Set(s)
                    if (next.has(ns)) next.delete(ns)
                    else next.add(ns)
                    return next
                  })
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] uppercase tracking-wider text-chrome-text hover:bg-foreground/[0.04]"
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <FolderOpen className="h-3 w-3" />
                <span className="flex-1">{ns}</span>
                <span className="text-chrome-text/60">{tables.length}</span>
              </button>
              {isOpen ? (
                <div className="space-y-px pb-1">
                  {tables.map((t) => (
                    <TableRow key={`${t.schema}.${t.name}`} table={t} onOpen={() => onOpenTable(t.schema, t.name)} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TableRow({ table, onOpen }: { table: SchemaTable; onOpen: () => void }) {
  const isRvbbit = table.isRvbbit
  return (
    <button
      type="button"
      onClick={onOpen}
      onDoubleClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1.5 px-4 py-1 text-left text-xs hover:bg-foreground/[0.05]",
        "text-foreground",
      )}
    >
      <Table2 className={cn("h-3 w-3 shrink-0", isRvbbit ? "text-rvbbit-accent" : "text-chrome-text/80")} />
      <span className="truncate flex-1">{table.name}</span>
      <span className="text-[10px] text-chrome-text/60">
        {table.kind === "view" ? "view" : table.kind === "matview" ? "mv" : table.rowEstimate != null ? fmtRows(table.rowEstimate) : ""}
      </span>
    </button>
  )
}

function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function groupTables(tables: SchemaTable[], search: string) {
  const filtered = search
    ? tables.filter((t) =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.schema.toLowerCase().includes(search.toLowerCase()),
      )
    : tables
  const map = new Map<string, SchemaTable[]>()
  for (const t of filtered) {
    const list = map.get(t.schema) ?? []
    list.push(t)
    map.set(t.schema, list)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => schemaSortKey(a) - schemaSortKey(b) || a.localeCompare(b))
    .map(([ns, ts]) => ({ schema: ns, tables: ts }))
}

function schemaSortKey(name: string): number {
  if (name === "public") return 0
  if (name === "rvbbit") return 1
  if (name.startsWith("pg_")) return 5
  return 2
}
