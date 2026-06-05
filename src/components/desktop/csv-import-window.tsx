"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, FileCsv, RefreshCw, Upload } from "@/lib/icons"
import { cn } from "@/lib/utils"
import type { CsvImportPayload } from "@/lib/desktop/types"
import type { SchemaSnapshot } from "@/lib/db/types"
import type { CsvDialect, CsvEncoding, ImportColumn, InspectResult, PgType } from "@/lib/import/types"
import { dropImportFile, peekImportFile } from "@/lib/import/file-store"
import { PG_TYPE_OPTIONS, identNeedsQuote, sanitizeIdent } from "@/lib/import/csv-infer"
import { buildCreateTableSql, includedColumns } from "@/lib/import/ddl"

interface CsvImportWindowProps {
  windowId: string
  payload: CsvImportPayload
  activeConnectionId: string | null
  schema: SchemaSnapshot | null
  onReloadSchema: () => void
  onOpenTable: (schema: string, name: string) => void
}

/** Head slice we read + send to the inspector. Bounded so a 2GB drop only
 *  ever touches this much in the browser. Enough rows for solid inference. */
const SAMPLE_BYTES = 1024 * 1024
const RAW_LINES = 60

type Tab = "columns" | "preview" | "sql" | "raw"
type Status = "reading" | "inspecting" | "ready" | "error"

const DELIMITER_OPTIONS: { value: string; label: string }[] = [
  { value: ",", label: "Comma ," },
  { value: ";", label: "Semicolon ;" },
  { value: "\t", label: "Tab ⇥" },
  { value: "|", label: "Pipe |" },
]
const ENCODING_OPTIONS: CsvEncoding[] = ["utf-8", "utf-16le", "latin1"]

/**
 * CSV importer — Phase 2: detect dialect, infer typed columns, let the user
 * rename/retype/drop columns and choose target schema + HEAP/RVBBIT, and show
 * the exact CREATE TABLE that will run. No data is written yet (Phase 3 adds
 * the streaming COPY loader behind the Import button).
 */
export function CsvImportWindow({
  windowId,
  payload,
  activeConnectionId,
  schema,
}: CsvImportWindowProps) {
  // onReloadSchema + onOpenTable are wired in Phase 3 (refresh Finder + open
  // the new table after the load completes).
  const [file] = useState<File | null>(() => peekImportFile(windowId) ?? null)
  const missing = file == null

  const [sample, setSample] = useState<Uint8Array | null>(null)
  const [status, setStatus] = useState<Status>("reading")
  const [error, setError] = useState<string | null>(null)
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [dialect, setDialect] = useState<CsvDialect | null>(null)
  const [columns, setColumns] = useState<ImportColumn[]>([])
  const [tab, setTab] = useState<Tab>("columns")

  // Target table. The name derives from the file (e.g. "Q1 Sales.csv" →
  // "q1_sales"); the user can edit it.
  const [targetSchema, setTargetSchema] = useState(payload.defaultSchema ?? "public")
  const [tableName, setTableName] = useState(() =>
    sanitizeIdent(payload.fileName.replace(/\.[^.]+$/, ""), new Set()),
  )
  const [accessMethod, setAccessMethod] = useState<"heap" | "rvbbit">("heap")

  const schemas = schema?.schemas ?? []
  const hasRvbbit = schema?.hasRvbbit ?? false

  // ── Read the head slice once, then inspect ────────────────────────
  const doInspect = useCallback(
    async (bytes: Uint8Array, size: number, hints?: Partial<CsvDialect>) => {
      setStatus("inspecting")
      const params = new URLSearchParams({ totalBytes: String(size) })
      if (hints) {
        for (const [k, v] of Object.entries(hints)) {
          if (v != null) params.set(k, String(v))
        }
      }
      try {
        const res = await fetch(`/api/db/import/inspect?${params.toString()}`, {
          method: "POST",
          body: bytes as BodyInit,
        })
        const json = (await res.json()) as ({ ok: true } & InspectResult) | { ok: false; error: string }
        if (!json.ok) {
          setError(json.error)
          setStatus("error")
          return
        }
        setInspect(json)
        setDialect(json.dialect)
        setColumns(json.columns)
        setStatus("ready")
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus("error")
      }
    },
    [],
  )

  useEffect(() => {
    if (!file) return
    let cancelled = false
    file
      .slice(0, SAMPLE_BYTES)
      .arrayBuffer()
      .then((buf) => {
        if (cancelled) return
        const bytes = new Uint8Array(buf)
        setSample(bytes)
        void doInspect(bytes, file.size)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setStatus("error")
        }
      })
    return () => {
      cancelled = true
    }
  }, [file, doInspect])

  useEffect(() => () => dropImportFile(windowId), [windowId])

  // ── Edits ─────────────────────────────────────────────────────────
  const changeDialect = useCallback(
    (patch: Partial<CsvDialect>) => {
      if (!dialect || !sample || !file) return
      const next = { ...dialect, ...patch }
      setDialect(next)
      void doInspect(sample, file.size, next)
    },
    [dialect, sample, file, doInspect],
  )

  const updateColumn = useCallback((index: number, patch: Partial<ImportColumn>) => {
    setColumns((cols) => cols.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }, [])

  const reinspect = useCallback(() => {
    if (sample && file) void doInspect(sample, file.size, dialect ?? undefined)
  }, [sample, file, dialect, doInspect])

  // ── Derived ───────────────────────────────────────────────────────
  const rawLines = useMemo(() => {
    if (!sample || !dialect) return null
    const text = decodeForRaw(sample, dialect.encoding)
    return text.split(/\r\n|\n|\r/).slice(0, RAW_LINES)
  }, [sample, dialect])

  const included = includedColumns(columns)

  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>()
    for (const c of included) seen.set(c.targetName, (seen.get(c.targetName) ?? 0) + 1)
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name))
  }, [included])

  const ddl = useMemo(() => {
    if (included.length === 0 || !tableName) return null
    return buildCreateTableSql({ schema: targetSchema, table: tableName, accessMethod, columns })
  }, [included.length, tableName, targetSchema, accessMethod, columns])

  // ── Render ────────────────────────────────────────────────────────
  if (missing) {
    return (
      <div className="flex h-full flex-col text-[12px] text-chrome-text">
        <Header payload={payload} estimatedRows={null} onReload={reinspect} canReload={false} />
        <MissingFile fileName={payload.fileName} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col text-[12px] text-chrome-text">
      <Header
        payload={payload}
        estimatedRows={inspect?.estimatedRows ?? null}
        onReload={reinspect}
        canReload={status === "ready" || status === "error"}
      />

      {!activeConnectionId ? (
        <Banner tone="warning" icon>
          No active connection — pick one to choose a target schema and import.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="warning" icon onClose={() => setError(null)}>
          {error}
        </Banner>
      ) : null}

      {status === "reading" || status === "inspecting" ? (
        <div className="grid flex-1 place-items-center text-[11px] text-chrome-text/55">
          {status === "reading" ? "reading…" : "inspecting…"}
        </div>
      ) : status === "error" ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-[11px] text-chrome-text/55">
          Couldn&apos;t inspect this file. Try adjusting the format, or check the Raw view.
        </div>
      ) : (
        <>
          <TargetBar
            schemas={schemas}
            targetSchema={targetSchema}
            onSchema={setTargetSchema}
            tableName={tableName}
            onTable={setTableName}
            accessMethod={accessMethod}
            onAccessMethod={setAccessMethod}
            hasRvbbit={hasRvbbit}
          />
          {dialect ? <FormatBar dialect={dialect} onChange={changeDialect} /> : null}

          <Tabs tab={tab} onTab={setTab} />

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "columns" ? (
              <ColumnsTab columns={columns} duplicateNames={duplicateNames} onUpdate={updateColumn} />
            ) : tab === "preview" ? (
              <PreviewTab columns={included} rows={inspect?.sampleRows ?? []} />
            ) : tab === "sql" ? (
              <SqlTab ddl={ddl} />
            ) : (
              <RawTab lines={rawLines} />
            )}
          </div>

          <Footer
            inspect={inspect}
            includedCount={included.length}
            duplicateCount={duplicateNames.size}
          />
        </>
      )}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────

function Header({
  payload,
  estimatedRows,
  onReload,
  canReload,
}: {
  payload: CsvImportPayload
  estimatedRows: number | null
  onReload: () => void
  canReload: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-chrome-border bg-chrome-bg/40 px-3 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <FileCsv className="h-3.5 w-3.5 text-rvbbit-accent" />
        <span className="max-w-[240px] truncate font-medium" title={payload.fileName}>
          {payload.fileName}
        </span>
      </span>
      <span className="text-chrome-text/40">·</span>
      <span className="font-mono tabular-nums text-chrome-text/75">{fmtBytes(payload.fileSize)}</span>
      {estimatedRows != null ? (
        <>
          <span className="text-chrome-text/40">·</span>
          <span className="text-chrome-text/65">
            <span className="font-mono tabular-nums text-foreground">~{fmtCount(estimatedRows)}</span> rows
          </span>
        </>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {canReload ? (
          <button
            type="button"
            onClick={onReload}
            title="Re-inspect"
            className="grid h-6 w-6 place-items-center rounded text-chrome-text/70 hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── Target bar ──────────────────────────────────────────────────────

function TargetBar({
  schemas,
  targetSchema,
  onSchema,
  tableName,
  onTable,
  accessMethod,
  onAccessMethod,
  hasRvbbit,
}: {
  schemas: string[]
  targetSchema: string
  onSchema: (s: string) => void
  tableName: string
  onTable: (s: string) => void
  accessMethod: "heap" | "rvbbit"
  onAccessMethod: (m: "heap" | "rvbbit") => void
  hasRvbbit: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-chrome-border/60 bg-chrome-bg/20 px-3 py-1.5">
      <label className="inline-flex items-center gap-1.5 text-[11px] text-chrome-text/65">
        <span className="uppercase tracking-wider text-chrome-text/45">schema</span>
        <select
          value={targetSchema}
          onChange={(e) => onSchema(e.target.value)}
          className="h-6 rounded border border-chrome-border bg-secondary-background px-1.5 text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          {schemas.length === 0 ? <option value={targetSchema}>{targetSchema}</option> : null}
          {schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <span className="text-chrome-text/30">.</span>
      <input
        value={tableName}
        onChange={(e) => onTable(e.target.value)}
        placeholder="table_name"
        spellCheck={false}
        className="h-6 w-44 rounded border border-chrome-border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-chrome-text/40 focus:ring-2 focus:ring-ring"
      />
      <div className="ml-auto inline-flex overflow-hidden rounded border border-chrome-border">
        <SegBtn active={accessMethod === "heap"} onClick={() => onAccessMethod("heap")}>
          HEAP
        </SegBtn>
        <SegBtn
          active={accessMethod === "rvbbit"}
          disabled={!hasRvbbit}
          title={hasRvbbit ? "Create as a rvbbit columnar table" : "rvbbit extension not installed on this connection"}
          onClick={() => hasRvbbit && onAccessMethod("rvbbit")}
        >
          RVBBIT
        </SegBtn>
      </div>
    </div>
  )
}

function SegBtn({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-35",
        active
          ? "bg-rvbbit-accent/20 text-rvbbit-accent"
          : "bg-secondary-background text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

// ── Format bar ──────────────────────────────────────────────────────

function FormatBar({
  dialect,
  onChange,
}: {
  dialect: CsvDialect
  onChange: (patch: Partial<CsvDialect>) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-chrome-border/40 bg-chrome-bg/10 px-3 py-1 text-[10px] text-chrome-text/60">
      <span className="uppercase tracking-wider text-chrome-text/40">format</span>
      <MiniSelect
        label="delim"
        value={dialect.delimiter}
        options={DELIMITER_OPTIONS}
        onChange={(v) => onChange({ delimiter: v })}
      />
      <MiniSelect
        label="enc"
        value={dialect.encoding}
        options={ENCODING_OPTIONS.map((e) => ({ value: e, label: e }))}
        onChange={(v) => onChange({ encoding: v as CsvEncoding })}
      />
      <Check checked={dialect.hasHeader} onChange={(b) => onChange({ hasHeader: b })}>
        header row
      </Check>
      <Check checked={dialect.trimWhitespace} onChange={(b) => onChange({ trimWhitespace: b })}>
        trim
      </Check>
      <label className="inline-flex items-center gap-1">
        <span className="uppercase tracking-wider text-chrome-text/40">null</span>
        <input
          value={dialect.nullToken}
          onChange={(e) => onChange({ nullToken: e.target.value })}
          placeholder="(empty)"
          spellCheck={false}
          className="h-5 w-16 rounded border border-chrome-border bg-secondary-background px-1.5 font-mono text-[10px] text-foreground outline-none placeholder:text-chrome-text/35 focus:ring-1 focus:ring-ring"
        />
      </label>
    </div>
  )
}

function MiniSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <label className="inline-flex items-center gap-1">
      <span className="uppercase tracking-wider text-chrome-text/40">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-5 rounded border border-chrome-border bg-secondary-background px-1 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (b: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-rvbbit-accent" />
      <span>{children}</span>
    </label>
  )
}

// ── Tabs ────────────────────────────────────────────────────────────

function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { key: Tab; label: string }[] = [
    { key: "columns", label: "Columns" },
    { key: "preview", label: "Preview" },
    { key: "sql", label: "SQL" },
    { key: "raw", label: "Raw" },
  ]
  return (
    <div className="flex items-center gap-px border-b border-chrome-border bg-chrome-bg/20 px-2">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onTab(it.key)}
          className={cn(
            "border-b-2 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition",
            tab === it.key
              ? "border-rvbbit-accent text-rvbbit-accent"
              : "border-transparent text-chrome-text/65 hover:text-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// ── Columns tab ─────────────────────────────────────────────────────

function ColumnsTab({
  columns,
  duplicateNames,
  onUpdate,
}: {
  columns: ImportColumn[]
  duplicateNames: Set<string>
  onUpdate: (index: number, patch: Partial<ImportColumn>) => void
}) {
  return (
    <div className="divide-y divide-chrome-border/30">
      {columns.map((c, i) => {
        const dup = c.include && duplicateNames.has(c.targetName)
        const quoted = c.include && identNeedsQuote(c.targetName)
        return (
          <div
            key={c.sourceIndex}
            className={cn("flex items-center gap-2 px-3 py-1.5", !c.include && "opacity-45")}
          >
            <input
              type="checkbox"
              checked={c.include}
              onChange={(e) => onUpdate(i, { include: e.target.checked })}
              title={c.include ? "Exclude column" : "Include column"}
              className="accent-rvbbit-accent"
            />
            <span className="w-32 shrink-0 truncate text-[10px] text-chrome-text/45" title={c.sourceName}>
              {c.sourceName}
            </span>
            <span className="text-chrome-text/30">→</span>
            <div className="relative">
              <input
                value={c.targetName}
                disabled={!c.include}
                onChange={(e) => onUpdate(i, { targetName: e.target.value })}
                spellCheck={false}
                className={cn(
                  "h-6 w-40 rounded border bg-secondary-background px-2 font-mono text-[11px] text-foreground outline-none focus:ring-2 focus:ring-ring",
                  dup ? "border-danger/70" : quoted ? "border-warning/60" : "border-chrome-border",
                )}
                title={
                  dup
                    ? "Duplicate column name"
                    : quoted
                      ? "Will be quoted in SQL (not a bare identifier)"
                      : undefined
                }
              />
            </div>
            <select
              value={c.type}
              disabled={!c.include}
              onChange={(e) => onUpdate(i, { type: e.target.value as PgType })}
              className={cn(
                "h-6 rounded border border-chrome-border bg-secondary-background px-1.5 font-mono text-[10px] outline-none focus:ring-2 focus:ring-ring",
                c.type === c.inferredType ? "text-foreground" : "text-rvbbit-accent",
              )}
              title={c.type === c.inferredType ? "Inferred type" : `Overridden (inferred: ${c.inferredType})`}
            >
              {PG_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Check checked={c.nullable} onChange={(b) => onUpdate(i, { nullable: b })}>
              <span className="text-[10px] text-chrome-text/55">null</span>
            </Check>
            <span className="ml-auto max-w-[180px] truncate text-[10px] text-chrome-text/35" title={c.sampleValues.join(" · ")}>
              {c.sampleValues.slice(0, 3).join(" · ")}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Preview tab ─────────────────────────────────────────────────────

function PreviewTab({ columns, rows }: { columns: ImportColumn[]; rows: string[][] }) {
  if (columns.length === 0) return <EmptyHint label="No columns selected." />
  if (rows.length === 0) return <EmptyHint label="No sample rows." />
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead className="sticky top-0 bg-chrome-bg/95 text-[9px] uppercase tracking-wider text-chrome-text/50 backdrop-blur">
        <tr>
          {columns.map((c) => (
            <th key={c.sourceIndex} className="border-b border-chrome-border px-2 py-1 text-left font-medium">
              <div className="font-mono normal-case tracking-normal text-foreground">{c.targetName}</div>
              <div className="font-mono lowercase text-chrome-text/40">{c.type}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-chrome-border/20 hover:bg-foreground/[0.03]">
            {columns.map((c) => (
              <td key={c.sourceIndex} className="max-w-[220px] truncate px-2 py-1 font-mono text-foreground/85" title={r[c.sourceIndex] ?? ""}>
                {r[c.sourceIndex] === "" || r[c.sourceIndex] == null ? (
                  <span className="text-chrome-text/30">∅</span>
                ) : (
                  r[c.sourceIndex]
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── SQL tab ─────────────────────────────────────────────────────────

function SqlTab({ ddl }: { ddl: string | null }) {
  if (!ddl) return <EmptyHint label="Set a table name and keep at least one column." />
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
      {ddl}
    </pre>
  )
}

// ── Raw tab ─────────────────────────────────────────────────────────

function RawTab({ lines }: { lines: string[] | null }) {
  if (!lines) return <EmptyHint label="No sample." />
  return (
    <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
      {lines.map((line, i) => (
        <div key={i} className="flex gap-3 whitespace-pre">
          <span className="select-none text-right text-chrome-text/30" style={{ minWidth: "2.5ch" }}>
            {i + 1}
          </span>
          <span className="break-all">{line || " "}</span>
        </div>
      ))}
    </pre>
  )
}

// ── Footer + shared ─────────────────────────────────────────────────

function Footer({
  inspect,
  includedCount,
  duplicateCount,
}: {
  inspect: InspectResult | null
  includedCount: number
  duplicateCount: number
}) {
  const warning = inspect?.warnings[0]
  return (
    <div className="flex items-center gap-2 border-t border-chrome-border bg-chrome-bg/40 px-3 py-1 text-[10px] text-chrome-text/55">
      {duplicateCount > 0 ? (
        <span className="text-danger">
          {duplicateCount} duplicate column name{duplicateCount === 1 ? "" : "s"}
        </span>
      ) : warning ? (
        <span className="inline-flex items-center gap-1 text-chrome-text/60" title={inspect?.warnings.join("\n")}>
          <AlertTriangle className="h-3 w-3 text-warning" />
          {warning}
          {inspect && inspect.warnings.length > 1 ? ` (+${inspect.warnings.length - 1})` : ""}
        </span>
      ) : (
        <span>ready</span>
      )}
      <span className="ml-auto font-mono tabular-nums">
        {includedCount} col{includedCount === 1 ? "" : "s"}
      </span>
    </div>
  )
}

function Banner({
  tone,
  icon,
  onClose,
  children,
}: {
  tone: "warning"
  icon?: boolean
  onClose?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px]",
        tone === "warning" && "border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {icon ? <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> : null}
      <span className="break-words">{children}</span>
      {onClose ? (
        <button type="button" onClick={onClose} className="ml-auto text-warning/70 hover:text-warning">
          ✕
        </button>
      ) : null}
    </div>
  )
}

function EmptyHint({ label }: { label: string }) {
  return <div className="grid h-full place-items-center px-6 text-center text-[11px] text-chrome-text/45">{label}</div>
}

function MissingFile({ fileName }: { fileName: string }) {
  return (
    <div className="grid flex-1 place-items-center px-6 text-center">
      <div className="max-w-sm space-y-2">
        <Upload className="mx-auto h-8 w-8 text-chrome-text/30" />
        <div className="text-[12px] text-foreground">{fileName} is no longer in memory</div>
        <div className="text-[11px] text-chrome-text/55">
          A dropped file can&apos;t survive a page reload. Drop the CSV onto the desktop again to
          re-open the importer.
        </div>
      </div>
    </div>
  )
}

// ── utils ───────────────────────────────────────────────────────────

/** Decode the head sample for the Raw view (mirrors the server's decode). */
function decodeForRaw(bytes: Uint8Array, encoding: CsvEncoding): string {
  try {
    return new TextDecoder(encoding, { fatal: false, ignoreBOM: false }).decode(bytes)
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  }
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
