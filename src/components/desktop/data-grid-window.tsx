"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { useWorkspaceActive } from "./workspace-active-context"
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Boxes,
  ClipboardCopy,
  Clock,
  Download,
  FileCode2,
  FolderOpen,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RotateCcw,
  Save,
  Sigma,
  Sparkles,
  Table2,
  TreeStructure,
  X,
} from "@/lib/icons"
import { format as formatSql } from "sql-formatter"
import { ChartView } from "./chart-view"
import { ControlView } from "./control-view"
import { ModelField } from "./operator-inspector"
import { ResultGrid } from "./result-grid"
import { ResultTranscript, defaultKind, statementKeys } from "./result-transcript"
import { ArrangeGrid } from "./arrange-grid"
import { AppBlockView, type AppBlockFilterInput } from "./app-block-view"
import { extractUiArtifacts, UiArtifactView, type UiArtifactActionInput, type UiArtifactActionResult, type UiArtifactParamInput, type UiArtifactRow } from "./ui-artifact-view"
import { ContextMenu, type ContextMenuState } from "./context-menu"
import { listQueryHistory, pushQueryHistory } from "@/lib/desktop/query-history"
import { SingleCellCallout } from "./single-cell-callout"
import { SqlEditor } from "./sql-editor"
import { fetchLlmModels, type LlmModel } from "@/lib/rvbbit/operators"
import { TimeTravelStrip } from "./time-travel-strip"
import { ExplainGraph, parseExplainResult, type ExplainRoot } from "./explain-graph"
import { Button } from "@/components/ui/button"
import type {
  DataPayload,
  DesktopColumnRef,
  DesktopParamOperator,
  DesktopParamValue,
  DesktopWindowState,
  ParamTarget,
  RollupGrain,
  RollupSpec,
  RowInspectorPayload,
  SemanticOpMeta,
} from "@/lib/desktop/types"
import { effectiveRollup } from "@/lib/desktop/sql-builder"
import { reconcileRollupLineage } from "@/lib/desktop/rollup-sql-parse"
import { rollupChartSpec } from "@/lib/desktop/rollup-chart"
import { classifyColumn, inferChartSpec } from "@/lib/desktop/chart-infer"
import { UI_ARTIFACT_KIND, UI_FILTER_SOURCE_CTE, UI_RENDERER } from "@/lib/desktop/ui-artifact-contract"
import { RollupShelf, type FilterKind } from "./rollup-shelf"
import type { QueryResult, QueryResultColumn, SchemaSnapshot, StatementResult } from "@/lib/db/types"
import { buildSqlCompletionSchema } from "@/lib/desktop/sql-completion"
import type { BlockReferenceMap } from "@/lib/desktop/sql-block-refs"
import { cn } from "@/lib/utils"
import { rowsToCsv } from "@/lib/sql/format"
import {
  hasTopLevelThen,
  pipelineHead,
  splitPipelineHead,
  wrapFlowStatements,
  expandFlowResult,
  isSynthQuery,
  inferJsonbColumns,
  columnsFromServerSchema,
  extractSynthIntent,
  splitStatements,
} from "@/lib/sql/then-rewrite"
import type { JsonbProjectionColumn } from "@/lib/desktop/types"
import {
  buildDesktopRuntimeGraph,
  crossFilterAppliesToStatement,
  injectStatementFilters,
  paramKey,
  predicateForParam,
  quoteSqlIdent,
  resolveParamPlacement,
  sameParamValue,
  singleFromItem,
  shortParamValue,
  slugifyBlockName,
  sourceSqlForPayload,
  stripTrailingSqlTerminator,
  uniqueBlockName,
  type CrossFilter,
} from "@/lib/desktop/reactive-sql"
import { setActiveBlockDragSource, writeBlockDragPayload } from "@/lib/desktop/block-drag"
import { usePresentMode } from "@/lib/desktop/present-mode"
import { hasParamDragPayload, readParamDragPayload } from "@/lib/desktop/param-drag"
import { attachDragGhost } from "@/lib/desktop/drag-ghost"
import { defineVizBlock } from "@/lib/rvbbit/viz-blocks"
import {
  appendHtmlBlockTurn,
  buildHtmlBlockSql,
  extractHtmlBlockTurnResult,
  fallbackHtmlBlockTurn,
  normalizeHtmlBlockSpec,
  type HtmlBlockSpec,
  type HtmlBlockTurnResult,
} from "@/lib/desktop/app-block"

interface DataGridWindowProps {
  window: DesktopWindowState
  payload: DataPayload
  activeConnectionId: string | null
  /** Whether the active connection has the pg_rvbbit extension —
   *  enables EXPLAIN (SEMANTIC) for the semantic cost projection. */
  hasRvbbit: boolean
  /** Active-connection schema snapshot — powers table/column autocomplete in
   *  the SQL editor. Null until loaded / when no connection is active. */
  schema: SchemaSnapshot | null
  semanticOps: SemanticOpMeta[]
  allWindows: DesktopWindowState[]
  params: DesktopParamValue[]
  runSignal: number
  onChangePayload: (mutate: (payload: DataPayload) => DataPayload) => void
  onSaveAsViewApp: (seed: {
    sql: string
    title?: string
    chartSpec?: Record<string, unknown> | null
    statementViews?: DataPayload["statementViews"]
    statementLayout?: DataPayload["statementLayout"]
    viewKind?: DataPayload["viewKind"]
    controlField?: string
    htmlBlock?: HtmlBlockSpec | null
  }) => void
  onOpenRow: (payload: RowInspectorPayload) => void
  onEmitParam: (input: {
    sourceWindowId: string
    sourceBlockName: string
    sourceTitle: string
    field: string
    value: unknown
    operator?: DesktopParamOperator
    multiValueAction?: "add" | "remove" | "toggle" | "set" | "replace"
    cascade?: boolean
    dataTypeId?: number
    type?: string
    sourceSchema?: string
    sourceTable?: string
    sourceColumn?: string
  }) => void
  onSubscribeParam: (key: string, targetField?: string, target?: ParamTarget) => void
  /**
   * Apply a pure transform to this window's rollup spec (shelf edits).
   * Rebuilds SQL/title at the host so the window chrome stays in sync.
   */
  onEditRollup?: (transform: (s: RollupSpec) => RollupSpec) => void
  /** Re-pivot with a new temporal grain (re-probes distinct values). */
  onRepivot?: (grain: RollupGrain) => void
  /** Probe distinct source values for a column (WHERE filter multi-select). */
  onProbeValues?: (column: DesktopColumnRef, search?: string) => Promise<{ values: (string | number | null)[]; truncated: boolean }>
  /**
   * Round-trip back into the KG when this Data window was opened from a
   * KG evidence row (i.e. payload.sourceContext is set). Phase 2's
   * reverse bridge.
   */
  onOpenKgForSource?: (ctx: import("@/lib/desktop/types").KgSourceContext) => void
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; sql: string; startedAt: number }
  | { kind: "done"; result: QueryResult }
  | { kind: "error"; error: string; code?: string; detail?: string; hint?: string; position?: number | null }

type ExplainState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; plan: ExplainRoot; analyzed: boolean }
  | { kind: "error"; message: string }

type FlowStepRow = {
  step_idx: number
  stage: string
  spec: string | null
  generated_sql: string | null
  n_rows: number
  rows: Record<string, unknown>[]
}

function expandPipelineStatementResult(stmt: StatementResult): StatementResult {
  const expanded = expandFlowResult({
    sql: stmt.sql ?? "",
    connectionId: "",
    columns: stmt.columns,
    rows: stmt.rows,
    rowCount: stmt.rowCount,
    truncated: stmt.truncated,
    durationMs: 0,
    command: stmt.command,
  })
  return { ...stmt, columns: expanded.columns, rows: expanded.rows }
}

function expandPipelineResult(result: QueryResult, cols?: JsonbProjectionColumn[]): QueryResult {
  const expanded = expandFlowResult(result, cols)
  if (!result.results?.length) return expanded
  return {
    ...expanded,
    results: result.results.map(expandPipelineStatementResult),
  }
}

const FLOW_STEPS_SQL =
  "SELECT step_idx, stage, spec, generated_sql, n_rows, rows FROM rvbbit.flow_steps " +
  "WHERE run_id = (SELECT run_id FROM rvbbit.flow_steps ORDER BY created_at DESC LIMIT 1) " +
  "ORDER BY step_idx"

// The model "Ask" mode uses, persisted globally (one choice for all future
// Asks). Empty = let rvbbit.synth_sql use the synth operator's default model.
const ASK_MODEL_KEY = "rvbbit-lens:ask-model"
const SQL_RAIL_DEFAULT_WIDTH = 380
const SQL_RAIL_MIN_WIDTH = 280
const SQL_RESULTS_MIN_WIDTH = 360
const SQL_RAIL_MAX_FRACTION = 0.5

/** Normalize compiled SQL for the per-statement-columns cache gate: strip block AND
 *  line comments (the inlined {ref} `version=N` marker, as_of, user notes) — none
 *  change a statement's OUTPUT columns, so this keeps mechanism-2 cross-filtering alive
 *  for {ref} tiles after a referenced block re-runs (the marker → a fixed space; the
 *  rest of the compiled SQL is deterministic). We do NOT collapse whitespace — that
 *  would equate two distinct quoted identifiers (`"My  State"` vs `"My State"`) and
 *  let mechanism-2 wrap a tile with the prior run's column name (42703). */
function colsKey(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim()
}

function splitSqlRelation(relation: string): string[] {
  const parts: string[] = []
  let buf = ""
  let quoted = false
  for (let i = 0; i < relation.length; i += 1) {
    const c = relation[i]
    if (quoted) {
      if (c === '"') {
        if (relation[i + 1] === '"') {
          buf += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        buf += c
      }
      continue
    }
    if (c === '"') {
      quoted = true
      continue
    }
    if (c === ".") {
      parts.push(buf.trim())
      buf = ""
      continue
    }
    buf += c
  }
  parts.push(buf.trim())
  return parts.filter(Boolean)
}

function resolveControlFilterSource(
  statement: string | undefined,
  field: string,
  schema: SchemaSnapshot | null,
): Pick<CrossFilter, "sourceSchema" | "sourceTable" | "column"> | null {
  if (!statement || !field || !schema) return null
  const head = pipelineHead(statement) ?? statement
  const item = singleFromItem(head)
  if (!item || item.type !== "table") return null
  const parts = splitSqlRelation(item.relation)
  const tableName = parts[parts.length - 1]?.toLowerCase()
  const schemaName = parts.length > 1 ? parts[parts.length - 2]?.toLowerCase() : null
  if (!tableName) return null
  const matches = schema.tables.filter(
    (t) =>
      t.name.toLowerCase() === tableName &&
      (!schemaName || t.schema.toLowerCase() === schemaName),
  )
  if (matches.length !== 1) return null
  const table = matches[0]
  const column = table.columns.find((c) => c.name.toLowerCase() === field.toLowerCase())
  if (!column) return null
  return { sourceSchema: table.schema, sourceTable: table.name, column: column.name }
}

function crossFilterKey(x: Pick<CrossFilter, "sourceSchema" | "sourceTable" | "column" | "targetStmtIndex">): string {
  return `${x.sourceSchema ?? ""}.${x.sourceTable ?? ""}.${x.column}->${x.targetStmtIndex ?? "*"}`.toLowerCase()
}

function crossFilterLabel(x: CrossFilter): string {
  const base = x.sourceTable ? `${x.sourceTable}.${x.column}` : x.column
  return x.targetStmtIndex === undefined ? base : `${base} -> #${x.targetStmtIndex + 1}`
}

function injectFieldOnlyFilters(sql: string, filters: CrossFilter[]): string {
  const fieldFilters = filters.filter((f) => !f.sourceTable)
  if (fieldFilters.length === 0) return sql
  const preds = fieldFilters.map((f) => predicateForParam(f.column, f.value, f.operator))
  return `SELECT * FROM (\n${stripTrailingSqlTerminator(sql)}\n) AS __rvbbit_pf WHERE ${preds.join(" AND ")}`
}

function relationColumnSet(schema: SchemaSnapshot | null, relation: string): Set<string> | null {
  if (!schema) return null
  const rel = relation.toLowerCase()
  const qualified = rel.includes(".")
  const matches = schema.tables.filter((table) => {
    const fq = `${table.schema}.${table.name}`.toLowerCase()
    return fq === rel || (!qualified && table.name.toLowerCase() === rel)
  })
  if (matches.length !== 1) return null
  return new Set(matches[0].columns.map((column) => column.name.toLowerCase()))
}

function injectFieldOnlyBaseTableFilters(
  sql: string,
  filters: CrossFilter[],
  schema: SchemaSnapshot | null,
): { sql: string; applied: Set<string> } {
  const applied = new Set<string>()
  const item = singleFromItem(sql)
  if (!item || item.type !== "table") return { sql, applied }
  const columns = relationColumnSet(schema, item.relation)
  if (!columns) return { sql, applied }
  const matching = filters.filter((filter) => columns.has(filter.column.toLowerCase()))
  if (matching.length === 0) return { sql, applied }
  for (const filter of matching) applied.add(crossFilterKey(filter))
  const preds = matching.map((filter) => predicateForParam(filter.column, filter.value, filter.operator))
  const inner = `(SELECT * FROM ${item.relation} WHERE ${preds.join(" AND ")}) ${item.alias}`
  return { sql: sql.slice(0, item.start) + inner + sql.slice(item.end), applied }
}

function injectPipelineHeadFilters(sql: string, filters: CrossFilter[], schema: SchemaSnapshot | null): string {
  if (filters.length === 0) return sql
  const statements = splitStatements(sql)
  if (statements.length === 0) return sql
  return statements
    .map((statement, index) => {
      const split = splitPipelineHead(statement)
      if (!split) return statement
      const applicable = filters.filter((f) => crossFilterAppliesToStatement(f, index))
      if (applicable.length === 0) return statement

      const tableFilters = applicable.filter((f) => !!f.sourceTable)
      const fieldFilters = applicable.filter((f) => !f.sourceTable)
      let head = tableFilters.length > 0
        ? injectStatementFilters(split.head, tableFilters, schema)
        : split.head
      const pushed = injectFieldOnlyBaseTableFilters(head, fieldFilters, schema)
      head = pushed.sql
      const remainingFieldFilters = fieldFilters.filter((filter) => !pushed.applied.has(crossFilterKey(filter)))
      head = injectFieldOnlyFilters(head, remainingFieldFilters)
      return `${head}\n${split.tail}`
    })
    .join(";\n")
}

function statementLayoutArtifacts(results: StatementResult[] | null): UiArtifactRow[] {
  if (!results) return []
  return results.flatMap((statement) => {
    const artifacts = extractUiArtifacts(statement.rows) ?? []
    return artifacts.filter((artifact) => artifact.artifact_kind === UI_ARTIFACT_KIND.META && artifact.renderer === UI_RENDERER.STATEMENT_LAYOUT)
  })
}

function isMetaOnlyResult(statement: StatementResult): boolean {
  const artifacts = extractUiArtifacts(statement.rows)
  return !!artifacts?.length && artifacts.every((artifact) => artifact.artifact_kind === UI_ARTIFACT_KIND.META)
}

function artifactStringValue(artifact: UiArtifactRow, key: string): string {
  const value = artifact.spec?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function artifactParamOperator(artifact: UiArtifactRow, key: string): DesktopParamOperator | undefined {
  const value = artifactStringValue(artifact, key).toLowerCase()
  return value === "eq" || value === "in" || value === "gte" || value === "lte" ? value : undefined
}

function addStatementAlias(aliases: Map<string, string>, value: unknown, key: string): void {
  if (typeof value !== "string") return
  const alias = value.trim()
  if (!alias) return
  aliases.set(alias, key)
  aliases.set(alias.toLowerCase(), key)
}

function statementNameAliases(results: StatementResult[] | null, sourceStatements: string[]): Map<string, string> {
  const aliases = new Map<string, string>()
  if (!results?.length) return aliases
  const keys = statementKeys(results, sourceStatements)
  results.forEach((statement, index) => {
    const key = keys[index]
    if (!key) return
    addStatementAlias(aliases, key, key)
    addStatementAlias(aliases, String(index + 1), key)
    addStatementAlias(aliases, `#${index + 1}`, key)
    addStatementAlias(aliases, String(statement.index + 1), key)
    addStatementAlias(aliases, `#${statement.index + 1}`, key)
    const artifacts = extractUiArtifacts(statement.rows) ?? []
    for (const artifact of artifacts) {
      addStatementAlias(aliases, artifact.title, key)
      addStatementAlias(aliases, artifact.spec?.title, key)
      if (artifact.artifact_kind === UI_ARTIFACT_KIND.META && artifact.renderer === UI_RENDERER.STATEMENT_NAME) {
        addStatementAlias(aliases, artifactStringValue(artifact, "name"), key)
        addStatementAlias(aliases, artifactStringValue(artifact, "label"), key)
      }
    }
  })
  return aliases
}

type StatementFilterBinding = {
  sourceStmtIndex: number
  targetStmtIndex: number
  field?: string
  operator?: DesktopParamOperator
}

type StatementFilterTarget = {
  targetStmtIndex?: number
  field?: string
  operator?: DesktopParamOperator
}

function statementFilterBindings(
  results: StatementResult[] | null,
  sourceStatements: string[],
  aliases: Map<string, string>,
): Map<number, StatementFilterBinding[]> {
  const bindings = new Map<number, StatementFilterBinding[]>()
  if (!results?.length) return bindings
  const keys = statementKeys(results, sourceStatements)
  const keyToStmtIndex = new Map<string, number>()
  keys.forEach((key, index) => keyToStmtIndex.set(key, results[index]?.index ?? index))
  results.forEach((statement) => {
    const artifacts = extractUiArtifacts(statement.rows) ?? []
    for (const artifact of artifacts) {
      if (artifact.artifact_kind !== UI_ARTIFACT_KIND.META || artifact.renderer !== UI_RENDERER.FILTER_BINDING) continue
      const target = artifactStringValue(artifact, "target")
      if (!target) continue
      const targetKey = aliases.get(target) ?? aliases.get(target.toLowerCase()) ?? (keys.includes(target) ? target : undefined)
      const targetStmtIndex = targetKey ? keyToStmtIndex.get(targetKey) : undefined
      if (targetStmtIndex === undefined) continue
      const next: StatementFilterBinding = {
        sourceStmtIndex: statement.index,
        targetStmtIndex,
        field: artifactStringValue(artifact, "field") || undefined,
        operator: artifactParamOperator(artifact, "operator"),
      }
      bindings.set(statement.index, [...(bindings.get(statement.index) ?? []), next])
    }
  })
  return bindings
}

function layoutTileKey(ref: unknown, keys: string[], aliases: Map<string, string>): { key: string; w: number } | null {
  let raw: unknown = ref
  let weight = 1
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const obj = ref as Record<string, unknown>
    raw = obj.key ?? obj.name ?? obj.statement ?? obj.index ?? obj.tile
    const w = Number(obj.w ?? obj.width ?? 1)
    weight = Number.isFinite(w) && w > 0 ? w : 1
  }
  if (typeof raw === "string") {
    const token = raw.trim()
    if (keys.includes(token)) return { key: token, w: weight }
    const aliased = aliases.get(token) ?? aliases.get(token.toLowerCase())
    if (aliased) return { key: aliased, w: weight }
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isFinite(n)) return null
  const key = keys[n - 1] ?? keys[n]
  return key ? { key, w: weight } : null
}

function parseLayoutRows(raw: unknown, keys: string[], aliases: Map<string, string>): NonNullable<DataPayload["statementLayout"]>["rows"] | undefined {
  if (typeof raw === "string") {
    const text = raw.trim()
    if (!text) return undefined
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        return parseLayoutRows(JSON.parse(text), keys, aliases)
      } catch {
        return undefined
      }
    }
    const rows = text
      .split(/[\/;\n]+/)
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => ({
        h: 1,
        tiles: row
          .split(/[,+\s]+/)
          .map((token) => layoutTileKey(token, keys, aliases))
          .filter((tile): tile is { key: string; w: number } => !!tile),
      }))
      .filter((row) => row.tiles.length > 0)
    return rows.length > 0 ? rows : undefined
  }
  if (!Array.isArray(raw)) {
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>
      if (obj.rows !== undefined) return parseLayoutRows(obj.rows, keys, aliases)
      if (obj.layout !== undefined) return parseLayoutRows(obj.layout, keys, aliases)
      if (Array.isArray(obj.tiles)) return parseLayoutRows([obj], keys, aliases)
    }
    return undefined
  }
  const rows = raw
    .map((row) => {
      if (Array.isArray(row)) {
        return {
          h: 1,
          tiles: row
            .map((tile) => layoutTileKey(tile, keys, aliases))
            .filter((tile): tile is { key: string; w: number } => !!tile),
        }
      }
      if (row && typeof row === "object") {
        const obj = row as Record<string, unknown>
        const h = Number(obj.h ?? obj.height ?? 1)
        const tilesRaw = Array.isArray(obj.tiles) ? obj.tiles : []
        return {
          h: Number.isFinite(h) && h > 0 ? h : 1,
          tiles: tilesRaw
            .map((tile) => layoutTileKey(tile, keys, aliases))
            .filter((tile): tile is { key: string; w: number } => !!tile),
        }
      }
      const tile = layoutTileKey(row, keys, aliases)
      return tile ? { h: 1, tiles: [tile] } : { h: 1, tiles: [] }
    })
    .filter((row) => row.tiles.length > 0)
  return rows.length > 0 ? rows : undefined
}

function layoutModeFromArtifactSpec(spec: Record<string, unknown>): NonNullable<DataPayload["statementLayout"]>["mode"] {
  const mode = typeof spec.mode === "string" ? spec.mode : undefined
  if (mode === "transcript") return "transcript"
  const layout = spec.layout
  if (layout && typeof layout === "object" && !Array.isArray(layout)) {
    const nestedMode = (layout as Record<string, unknown>).mode
    if (nestedMode === "transcript") return "transcript"
  }
  return "arrange"
}

function layoutFromArtifact(
  artifact: UiArtifactRow | undefined,
  results: StatementResult[] | null,
  sourceStatements: string[],
  aliases: Map<string, string>,
): NonNullable<DataPayload["statementLayout"]> | null {
  if (!artifact || !results?.length) return null
  const spec = artifact.spec ?? {}
  const mode = layoutModeFromArtifactSpec(spec)
  const keys = statementKeys(results, sourceStatements)
  const rows = parseLayoutRows(spec.rows ?? spec.layout, keys, aliases)
  return rows ? { mode, rows } : { mode }
}

function loadAskModel(): string {
  try { return (typeof window !== "undefined" && window.localStorage.getItem(ASK_MODEL_KEY)) || "" } catch { return "" }
}
function saveAskModel(model: string): void {
  try { window.localStorage.setItem(ASK_MODEL_KEY, model) } catch { /* ignore */ }
}

function sqlJsonLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value ?? null))}::jsonb`
}

function firstCellValue(result: QueryResult): unknown {
  const firstCol = result.columns[0]?.name
  return firstCol ? result.rows[0]?.[firstCol] : undefined
}

type VizExportRenderer = "current" | "vega_lite" | "basic_chart" | "table_view" | "metric_card" | "filter_control"
type MaterializedVizRenderer = Exclude<VizExportRenderer, "current">

interface VizExportSource {
  sourceIndex: number
  sourceSql: string
  key: string
  title: string
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  defaultRenderer: MaterializedVizRenderer
  defaultChartKind?: "bar" | "line"
  vegaSpec?: Record<string, unknown> | null
}

interface VizExportSeed {
  title: string
  blockName: string
  objectKind: string
  objectKey: string
  filterField: string
  sources: VizExportSource[]
  statementLayout?: DataPayload["statementLayout"]
  multi: boolean
}

interface VizExportForm {
  name: string
  title: string
  intent: string
  description: string
  owner: string
  tagsText: string
  artifactPrefix: string
  renderer: VizExportRenderer
  chartKind: "bar" | "line" | "area" | "point"
  filterField: string
  includeTable: boolean
  objectKind: string
  objectKey: string
  linkRole: string
}

interface BuiltVizBlockSql {
  sql: string
  labels: Record<string, unknown>
  layoutTemplate: Record<string, unknown>
  warnings: string[]
}

function sqlText(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

function sqlJson(value: unknown): string {
  return `${sqlText(JSON.stringify(value ?? {}))}::jsonb`
}

function artifactId(value: string, fallback: string): string {
  return slugifyBlockName(value || fallback).slice(0, 54)
}

function artifactRowSql(input: {
  artifactId: string
  artifactKind: string
  renderer: string
  title: string
  specSql: string
  dataSql?: string
}): string {
  return [
    "SELECT",
    "  'ui'::text AS rvbbit_artifact,",
    `  ${sqlText(input.artifactId)}::text AS artifact_id,`,
    `  ${sqlText(input.artifactKind)}::text AS artifact_kind,`,
    `  ${sqlText(input.renderer)}::text AS renderer,`,
    `  ${sqlText(input.title)}::text AS title,`,
    `  ${input.specSql} AS spec,`,
    `  ${input.dataSql ?? "NULL::jsonb"} AS data,`,
    "  NULL::jsonb AS layout,",
    "  NULL::jsonb AS bindings,",
    "  NULL::jsonb AS diagnostics",
  ].join("\n")
}

function statementNameRowSql(name: string, title: string): string {
  return artifactRowSql({
    artifactId: `${name}_name`,
    artifactKind: UI_ARTIFACT_KIND.META,
    renderer: UI_RENDERER.STATEMENT_NAME,
    title: `${title} Name`,
    specSql: `jsonb_build_object('name', ${sqlText(name)}, 'label', ${sqlText(title)})`,
  })
}

function filterBindingRowSql(sourceName: string, targetName: string, field: string): string {
  return artifactRowSql({
    artifactId: `${sourceName}_bind_${targetName}`.slice(0, 60),
    artifactKind: UI_ARTIFACT_KIND.META,
    renderer: UI_RENDERER.FILTER_BINDING,
    title: `${sourceName} -> ${targetName}`,
    specSql: `jsonb_build_object('target', ${sqlText(targetName)}, 'field', ${sqlText(field)}, 'operator', 'in')`,
  })
}

function sourceDataSql(): string {
  return `(SELECT coalesce(jsonb_agg(to_jsonb(${UI_FILTER_SOURCE_CTE})), '[]'::jsonb) FROM ${UI_FILTER_SOURCE_CTE})`
}

function sourceColumnsSpec(columns: QueryResultColumn[]): Record<string, unknown> {
  return { columns: columns.map((column) => column.name) }
}

function firstNumericOrFirstColumn(columns: QueryResultColumn[]): string {
  return columns.find((column) => classifyColumn(column) === "numeric")?.name ?? columns[0]?.name ?? ""
}

function inferredChartFields(source: VizExportSource, chartKind: string): Record<string, unknown> {
  const inferred = inferChartSpec(source.columns, source.rows)
  const x = inferred?.xField ?? source.columns.find((column) => classifyColumn(column) !== "numeric")?.name ?? source.columns[0]?.name ?? ""
  const y = inferred?.yField ?? source.columns.find((column) => classifyColumn(column) === "numeric")?.name ?? ""
  return {
    kind: chartKind,
    x,
    ...(y ? { y } : {}),
  }
}

function sanitizeVegaSpec(spec: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!spec) return null
  const rest = { ...spec }
  delete rest.data
  return rest
}

function vegaXField(spec: Record<string, unknown> | null | undefined): string {
  const encoding = spec?.encoding
  if (!encoding || typeof encoding !== "object" || Array.isArray(encoding)) return ""
  const x = (encoding as Record<string, unknown>).x
  if (!x || typeof x !== "object" || Array.isArray(x)) return ""
  const field = (x as Record<string, unknown>).field
  return typeof field === "string" ? field : ""
}

function materializedRenderer(source: VizExportSource, form: VizExportForm): MaterializedVizRenderer {
  if (form.renderer !== "current") return form.renderer
  return source.defaultRenderer
}

function visibleArtifactSql(source: VizExportSource, renderer: MaterializedVizRenderer, form: VizExportForm, name: string): string {
  const title = source.title
  if (renderer === "table_view") {
    return artifactRowSql({
      artifactId: name,
      artifactKind: "table",
      renderer: UI_RENDERER.TABLE_VIEW,
      title,
      specSql: sqlJson(sourceColumnsSpec(source.columns)),
      dataSql: sourceDataSql(),
    })
  }
  if (renderer === "metric_card") {
    const valueField = firstNumericOrFirstColumn(source.columns)
    return artifactRowSql({
      artifactId: name,
      artifactKind: "metric",
      renderer: UI_RENDERER.METRIC_CARD,
      title,
      specSql: `jsonb_build_object('label', ${sqlText(valueField || title)}, 'value', (SELECT to_jsonb(${quoteSqlIdent(valueField || "value")}) FROM ${UI_FILTER_SOURCE_CTE} LIMIT 1))`,
      dataSql: sourceDataSql(),
    })
  }
  if (renderer === "filter_control") {
    const field = form.filterField || source.columns[0]?.name || ""
    return artifactRowSql({
      artifactId: name,
      artifactKind: "control",
      renderer: UI_RENDERER.FILTER_CONTROL,
      title,
      specSql: sqlJson({
        kind: "dropdown",
        field,
        operator: "in",
      }),
      dataSql: sourceDataSql(),
    })
  }
  if (renderer === "vega_lite") {
    const inferred = inferChartSpec(source.columns, source.rows)?.spec ?? {}
    const spec = sanitizeVegaSpec(source.vegaSpec) ?? inferred
    return artifactRowSql({
      artifactId: name,
      artifactKind: "chart",
      renderer: UI_RENDERER.VEGA_LITE,
      title,
      specSql: sqlJson(spec),
      dataSql: sourceDataSql(),
    })
  }
  const chartKind = form.renderer === "current"
    ? source.defaultChartKind ?? "bar"
    : form.chartKind
  return artifactRowSql({
    artifactId: name,
    artifactKind: "chart",
    renderer: UI_RENDERER.BASIC_CHART,
    title,
    specSql: sqlJson(inferredChartFields(source, chartKind)),
    dataSql: sourceDataSql(),
  })
}

function artifactStatementSql(source: VizExportSource, rows: string[]): string {
  return [
    `WITH ${UI_FILTER_SOURCE_CTE} AS (`,
    stripTrailingSqlTerminator(source.sourceSql)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    ")",
    rows.join("\nUNION ALL\n"),
  ].join("\n")
}

function layoutRowsForExport(seed: VizExportSeed, namesByKey: Map<string, string>, fallbackNames: string[]): Record<string, unknown>[] {
  const rows = seed.statementLayout?.rows
  if (!rows?.length) {
    return fallbackNames.map((name) => ({ h: 1, tiles: [{ name, w: 1 }] }))
  }
  return rows.map((row) => ({
    h: row.h,
    tiles: row.tiles
      .map((tile) => {
        const name = namesByKey.get(tile.key)
        return name ? { name, w: tile.w } : null
      })
      .filter(Boolean),
  })).filter((row) => row.tiles.length > 0)
}

function buildVizBlockExportSql(seed: VizExportSeed, form: VizExportForm): BuiltVizBlockSql {
  const warnings: string[] = []
  const prefix = artifactId(form.artifactPrefix, "viz")
  const statements: string[] = []
  const namesByKey = new Map<string, string>()
  const primaryNames: string[] = []
  let emittedDetailTables = 0

  for (const [i, source] of seed.sources.entries()) {
    const renderer = materializedRenderer(source, form)
    const suffix = seed.sources.length > 1 ? `_${i + 1}` : ""
    const primaryName = artifactId(`${prefix}${suffix}_${renderer}`, `${prefix}_${i + 1}`)
    const primaryRows = [
      visibleArtifactSql(source, renderer, form, primaryName),
      statementNameRowSql(primaryName, source.title),
    ]
    const filterable =
      form.filterField &&
      source.columns.some((column) => column.name.toLowerCase() === form.filterField.toLowerCase()) &&
      (renderer === "vega_lite" || renderer === "basic_chart" || renderer === "filter_control")
    const detailName = artifactId(`${prefix}${suffix}_table`, `${prefix}_${i + 1}_table`)
    if (filterable && form.includeTable) {
      primaryRows.push(filterBindingRowSql(primaryName, detailName, form.filterField))
    } else if (renderer === "vega_lite" || renderer === "basic_chart" || renderer === "filter_control") {
      warnings.push(`No explicit filter target emitted for ${source.title}. Add a table target or another binding later if it should cross-filter.`)
    }
    statements.push(`${artifactStatementSql(source, primaryRows)};`)
    namesByKey.set(source.key, primaryName)
    primaryNames.push(primaryName)

    if (form.includeTable && renderer !== "table_view") {
      statements.push(`${artifactStatementSql(source, [
        visibleArtifactSql(source, "table_view", form, detailName),
        statementNameRowSql(detailName, `${source.title} Detail`),
      ])};`)
      emittedDetailTables += 1
    }
  }

  const layoutRows = layoutRowsForExport(seed, namesByKey, primaryNames)
  if (primaryNames.length > 1 || seed.statementLayout?.mode === "arrange") {
    statements.push(`${artifactRowSql({
      artifactId: `${prefix}_layout`,
      artifactKind: UI_ARTIFACT_KIND.META,
      renderer: UI_RENDERER.STATEMENT_LAYOUT,
      title: "Layout",
      specSql: sqlJson({
        mode: seed.statementLayout?.mode ?? "arrange",
        rows: layoutRows,
      }),
    })};`)
  }

  return {
    sql: statements.join("\n\n"),
    labels: {
      source: "data_window_export",
      renderer: form.renderer,
      primary_artifacts: primaryNames.length,
      detail_tables: emittedDetailTables,
      filter_field: form.filterField || null,
    },
    layoutTemplate: {
      mode: seed.statementLayout?.mode ?? (primaryNames.length > 1 ? "arrange" : "transcript"),
      rows: layoutRows,
    },
    warnings: [...new Set(warnings)],
  }
}

function vizObjectLinkDefaults(payload: DataPayload, result: QueryResult | null, blockName: string): { objectKind: string; objectKey: string } {
  if (payload.table) return { objectKind: "table", objectKey: `${payload.table.schema}.${payload.table.name}` }
  if (payload.sourceContext?.sourceTable) return { objectKind: "table", objectKey: payload.sourceContext.sourceTable }
  const sourceColumn = result?.columns.find((column) => column.sourceSchema && column.sourceTable)
  if (sourceColumn?.sourceSchema && sourceColumn.sourceTable) {
    return { objectKind: "table", objectKey: `${sourceColumn.sourceSchema}.${sourceColumn.sourceTable}` }
  }
  return { objectKind: "query", objectKey: blockName }
}

export function DataGridWindow({
  window: w,
  payload,
  activeConnectionId,
  hasRvbbit,
  schema,
  semanticOps,
  allWindows,
  params,
  runSignal,
  onChangePayload,
  onSaveAsViewApp,
  onOpenRow,
  onEmitParam,
  onSubscribeParam,
  onEditRollup,
  onRepivot,
  onProbeValues,
  onOpenKgForSource,
}: DataGridWindowProps) {
  const view = payload.view ?? {}
  const rootRef = useRef<HTMLDivElement | null>(null)
  const sqlRailRef = useRef<HTMLElement | null>(null)
  // Present mode = "content-only": no tab strip, SQL rail, header toolbar,
  // rollup shelf, view-kind switcher, or time-travel rail — just the saved
  // view's data, full-bleed. Editor-only tabs (sql/explain/steps) fall back to
  // the table so a viewer never lands on a code editor.
  const present = usePresentMode()
  // Schema-aware SQL completion (tables + columns w/ type hints, + rvbbit
  // function snippets), rebuilt only when the connection's schema changes.
  const sqlCompletion = useMemo(() => buildSqlCompletionSchema(schema), [schema])
  const completionSources = useMemo(
    () => (sqlCompletion?.functionSource ? [sqlCompletion.functionSource] : undefined),
    [sqlCompletion],
  )
  // A semantic-projection window (spec has rvbbit scalar-op projections) is a
  // per-row LLM op — it never auto-runs; it opens on Explain so the live
  // EXPLAIN (SEMANTIC) shows the cost estimate before the user materializes it.
  const isSemanticProjection = ((payload.lineage ? effectiveRollup(payload.lineage) : null)?.projections?.length ?? 0) > 0
  const [draftSql, setDraftSql] = useState<string>(view.sqlDraft ?? payload.sql ?? "")
  const htmlBlock = useMemo(() => normalizeHtmlBlockSpec(payload.htmlBlock) ?? null, [payload.htmlBlock])
  // Editor input mode + the plain-English question (Ask mode). In "ask" mode the
  // editor edits `askDraft`; Run calls rvbbit.synth_sql to generate SQL, drops it
  // into `draftSql`, flips back to "sql", and runs it. `draftSql` therefore always
  // holds real SQL; `askDraft` always holds the question.
  const [queryMode, setQueryMode] = useState<"sql" | "ask" | "app">(view.queryMode ?? (htmlBlock ? "app" : "sql"))
  const [askDraft, setAskDraft] = useState<string>(view.askDraft ?? "")
  const [appDraft, setAppDraft] = useState<string>(view.appDraft ?? "")
  // Model for Ask generation — persisted globally; "" = synth's default model.
  const [askModel, setAskModelState] = useState<string>(() => loadAskModel())
  const setAskModel = (m: string) => { setAskModelState(m); saveAskModel(m) }
  const [llmModels, setLlmModels] = useState<LlmModel[]>([])
  // Tracks the last `payload.sql` we've reconciled with the local draft.
  // The sync-and-rerun effect lives further down so it can call runSql.
  const lastSyncedSqlRef = useRef<string>(payload.sql ?? "")
  // Run nonce — every runSql call grabs a fresh number. When two runs
  // overlap (e.g. user drops two columns into a rollup before the first
  // network round-trip returns), only the latest call's resolution is
  // allowed to write payload.sql back; older resolutions would otherwise
  // revert the most recent merge.
  const runNonceRef = useRef(0)
  // Mirrors the run nonce as STATE, so the transcript/arrange grid can key={runEpoch}
  // to remount per run (resetting expand + child-grid state) without reading a ref
  // during render.
  const [runEpoch, setRunEpoch] = useState(0)
  // Block-local cross-filters (multi-statement dashboard): clicking a tile cell
  // filters sibling statements that read the same source table. Held in a ref too
  // so runSql reads the latest without being in its deps.
  const [crossFilters, setCrossFilters] = useState<CrossFilter[]>([])
  const crossFiltersRef = useRef<CrossFilter[]>([])
  const seededUiDefaultKeysRef = useRef<Set<string>>(new Set())
  const seededUiDefaultSqlRef = useRef(payload.sql ?? "")
  // Per-statement output columns from the last multi-statement run, so the cross-
  // filter injector can wrap a {ref}/subquery/JOIN tile by the OUTPUT column whose
  // provenance matches the filter (mechanism 2 in injectStatementFilters). Keyed by
  // the EXACT compiled SQL they were measured on: an edit changes compiledRun, so the
  // columns stop matching and the injector falls back to the surgical path — never
  // wrapping a statement with another (stale) statement's columns.
  const lastStmtColsRef = useRef<{ sql: string; cols: (QueryResultColumn[] | undefined)[] } | null>(null)
  const lastExecutedSqlRef = useRef<string>("")
  // Abort controller + cancel token for the in-flight run, so a Stop button can
  // both abort the client fetch and pg_cancel_backend the server query.
  const runControlRef = useRef<{ controller: AbortController; token: string } | null>(null)
  const [exportMenu, setExportMenu] = useState<ContextMenuState | null>(null)
  const [vizExportSeed, setVizExportSeed] = useState<VizExportSeed | null>(null)
  const [historyMenu, setHistoryMenu] = useState<ContextMenuState | null>(null)
  // Per-window target database (the connection's default unless overridden).
  const [databases, setDatabases] = useState<string[]>([])
  // The connection's actual current database (so the switcher shows it as selected
  // instead of a confusing "database…" placeholder). targetDb stays null until the
  // user picks a *different* db — null means "the connection default" (currentDb).
  const [currentDb, setCurrentDb] = useState<string | null>(null)
  // Honor a payload-supplied initial target db (e.g. pg_cron links open against
  // the cron home db 'postgres', not the connected working db).
  const [targetDb, setTargetDb] = useState<string | null>(payload.database ?? null)
  // Manual transaction: when autocommit is off, txnSessionId pins a server-side
  // connection; txnActive means a statement has opened the transaction.
  const [txnSessionId, setTxnSessionId] = useState<string | null>(null)
  const [txnActive, setTxnActive] = useState(false)
  // Baseline for the rerun-on-compiled-SQL effect. Lives up here (rather
  // than next to that effect) so the external-SQL sync effect can pin it.
  const prevCompiledRef = useRef<string | null>(null)
  const [runState, setRunState] = useState<RunState>({ kind: "idle" })
  // Live progress for a running query (polled from a separate connection).
  const [progress, setProgress] = useState<QueryProgress | null>(null)
  const workspaceActive = useWorkspaceActive()
  const [explainState, setExplainState] = useState<ExplainState>({ kind: "idle" })
  const [explainBusy, setExplainBusy] = useState(false)
  const [activeTab, setActiveTab] = useState<NonNullable<DataPayload["view"]>["activeTab"]>(view.activeTab ?? (htmlBlock ? "app" : isSemanticProjection ? "explain" : payload.origin === "table" ? "rows" : "sql"))
  const [rowsTransposed, setRowsTransposed] = useState<boolean>(view.rowsTransposed ?? false)
  const [sqlRailOpen, setSqlRailOpen] = useState<boolean>(view.sqlRailOpen ?? (payload.origin !== "table"))
  const [sqlRailWidthPx, setSqlRailWidthPx] = useState<number>(
    Math.max(SQL_RAIL_MIN_WIDTH, view.sqlRailWidthPx ?? SQL_RAIL_DEFAULT_WIDTH),
  )
  const [paramDropHot, setParamDropHot] = useState(false)
  // Transient note shown when a param drop is refused (field this block can't
  // produce). Auto-dismisses; the timer is cleared on re-set / unmount.
  const [paramNotice, setParamNotice] = useState<string | null>(null)
  const paramNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Pipeline-cascade run state: when the last run was a `… then op(…)` pipeline,
  // the Steps inspector reads rvbbit.flow_steps to show each stage's rowset.
  const [isPipelineRun, setIsPipelineRun] = useState(false)
  const [flowSteps, setFlowSteps] = useState<FlowStepRow[] | null>(null)
  const [activeStep, setActiveStep] = useState(0)
  const [flowStepsError, setFlowStepsError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [lastRunExpanded, setLastRunExpanded] = useState(false)

  const blockName = useMemo(() => {
    if (payload.reactive?.blockName) return payload.reactive.blockName
    return uniqueBlockName(payload.title || w.title || w.id, allWindows, w.id)
  }, [allWindows, payload.reactive?.blockName, payload.title, w.id, w.title])

  // Map of every block's `{name}` → its title + SQL, powering the editor's
  // cross-block reference highlighting + hover cards. Memoized on reference
  // *content* so moving/resizing windows doesn't reconfigure the editor —
  // refSignature deliberately omits window position.
  const refSignature = allWindows
    .filter((win) => win.kind === "data")
    .map((win) => {
      const p = win.payload as DataPayload | undefined
      const name = p?.reactive?.blockName || slugifyBlockName(p?.title || win.title || win.id)
      return `${name}${p?.title ?? ""}${p ? sourceSqlForPayload(p) : ""}`
    })
    .join("")
  const blockReferences = useMemo<BlockReferenceMap>(() => {
    const map: BlockReferenceMap = new Map()
    for (const win of allWindows) {
      if (win.kind !== "data") continue
      const p = win.payload as DataPayload | undefined
      if (!p) continue
      const name = p.reactive?.blockName || slugifyBlockName(p.title || win.title || win.id)
      if (name) map.set(name.toLowerCase(), { title: p.title || win.title || name, sql: sourceSqlForPayload(p) })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refSignature])

  // This block's own active params — drives the in-grid highlight of the live
  // filter / pick value(s).
  const blockParams = useMemo(
    () => params.filter((p) => p.sourceBlockName.toLowerCase() === blockName.toLowerCase()),
    [params, blockName],
  )

  // The "View" tab renders a Vega chart (default) or an interactive control.
  const viewKind = payload.viewKind ?? "chart"
  const setViewKind = (k: NonNullable<DataPayload["viewKind"]>) =>
    onChangePayload((p) => ({ ...p, viewKind: k }))

  // Probe the column's true min/max over the block's full relation (datepicker /
  // slider bounds) by wrapping the block's compiled SQL; null for pipeline/synth
  // blocks (can't wrap) so the control falls back to the loaded result.
  const probeBounds = useCallback(
    async (field: string): Promise<{ min: unknown; max: unknown } | null> => {
      if (!activeConnectionId) return null
      const graph = buildDesktopRuntimeGraph(allWindows, params, schema)
      const compiled = graph.blocks.get(w.id)?.compiledSql
      if (!compiled || hasTopLevelThen(compiled) || isSynthQuery(compiled)) return null
      const c = quoteSqlIdent(field)
      const sql = `SELECT min(${c}) AS lo, max(${c}) AS hi\nFROM (\n${stripTrailingSqlTerminator(compiled)}\n) __bounds`
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // pipeline/synth are guarded out above, so this is always a plain
          // SELECT — run it under the read-only transaction guard.
          body: JSON.stringify({ connectionId: activeConnectionId, sql, rowLimit: 1, readOnly: true, database: targetDb ?? undefined }),
        })
        const body = (await res.json()) as { ok?: boolean; rows?: Record<string, unknown>[] }
        const row = body.ok && Array.isArray(body.rows) ? body.rows[0] : undefined
        if (!row || (row.lo == null && row.hi == null)) return null
        return { min: row.lo ?? null, max: row.hi ?? null }
      } catch {
        return null
      }
    },
    [activeConnectionId, allWindows, params, w.id, targetDb],
  )

  // First time this window opens, persist its unique block name into
  // the payload so subsequent renders see the same name and other
  // windows can resolve block.<name> references against it.
  useEffect(() => {
    if (payload.reactive?.blockName) return
    onChangePayload((p) => ({
      ...p,
      reactive: {
        blockName,
        sourceSql: sourceSqlForPayload(p),
        paramSubscriptions: p.reactive?.paramSubscriptions ?? [],
        version: 1,
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Compile this window's SQL through the runtime graph so block.X and
  // param.X.Y references rewrite, and subscriptions become WHERE clauses.
  const compiledSql = useMemo(() => {
    const graphWindows = htmlBlock
      ? allWindows.map((win) => {
          if (win.id !== w.id || win.kind !== "data") return win
          const p = win.payload as DataPayload
          return {
            ...win,
            payload: {
              ...p,
              reactive: p.reactive ? { ...p.reactive, paramSubscriptions: [] } : p.reactive,
            } satisfies DataPayload,
          }
        })
      : allWindows
    const graph = buildDesktopRuntimeGraph(graphWindows, params, schema)
    const block = graph.blocks.get(w.id)
    return block?.compiledSql ?? payload.sql
  }, [allWindows, htmlBlock, params, payload.sql, w.id, schema])

  const subscriptions = payload.reactive?.paramSubscriptions ?? []

  // Sync local draft → payload (debounced). We keep onChangePayload in a
  // ref so its identity doesn't re-fire this effect on every parent
  // render — the parent inlines a fresh arrow per render, and without
  // the ref this becomes a render loop that churns setWindows every
  // 250ms (and starves the global undo-snapshot debounce).
  const onChangePayloadRef = useRef(onChangePayload)
  useEffect(() => { onChangePayloadRef.current = onChangePayload }, [onChangePayload])
  useEffect(() => {
    const handle = setTimeout(() => {
      onChangePayloadRef.current((p) => ({
        ...p,
        view: { ...(p.view ?? {}), sqlDraft: draftSql, sqlRailOpen, sqlRailWidthPx, activeTab, rowsTransposed, queryMode, askDraft, appDraft },
      }))
    }, 250)
    return () => clearTimeout(handle)
  }, [draftSql, sqlRailOpen, sqlRailWidthPx, activeTab, rowsTransposed, queryMode, askDraft, appDraft])

  const clampSqlRailWidth = useCallback((rawWidth: number) => {
    const containerWidth = rootRef.current?.getBoundingClientRect().width ?? 0
    if (containerWidth <= 0) {
      return Math.max(SQL_RAIL_MIN_WIDTH, Math.round(rawWidth))
    }
    const maxByFraction = Math.floor(containerWidth * SQL_RAIL_MAX_FRACTION)
    const maxByResults = Math.floor(containerWidth - SQL_RESULTS_MIN_WIDTH)
    const maxWidth = Math.max(SQL_RAIL_MIN_WIDTH, Math.min(maxByFraction, maxByResults))
    return Math.round(Math.min(Math.max(rawWidth, SQL_RAIL_MIN_WIDTH), maxWidth))
  }, [])

  const startSqlRailResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startWidth = sqlRailRef.current?.getBoundingClientRect().width ?? sqlRailWidthPx
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onMove = (moveEvent: PointerEvent) => {
      setSqlRailWidthPx(clampSqlRailWidth(startWidth + moveEvent.clientX - startX))
    }
    const onUp = () => {
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      setSqlRailWidthPx((w) => clampSqlRailWidth(w))
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [clampSqlRailWidth, sqlRailWidthPx])

  const nudgeSqlRailWidth = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16
    let next: number | null = null
    if (event.key === "ArrowLeft") next = sqlRailWidthPx - step
    if (event.key === "ArrowRight") next = sqlRailWidthPx + step
    if (event.key === "Home") next = SQL_RAIL_MIN_WIDTH
    if (event.key === "End") next = Number.MAX_SAFE_INTEGER
    if (next == null) return
    event.preventDefault()
    event.stopPropagation()
    setSqlRailWidthPx(clampSqlRailWidth(next))
  }, [clampSqlRailWidth, sqlRailWidthPx])

  // Lazily load the LLM model list the first time Ask mode is opened (drives the
  // model picker under the editor). Cheap; kept in state for the window's life.
  useEffect(() => {
    if ((queryMode !== "ask" && queryMode !== "app") || !activeConnectionId || llmModels.length > 0) return
    let cancelled = false
    fetchLlmModels(activeConnectionId).then((r) => { if (!cancelled) setLlmModels(r.models) })
    return () => { cancelled = true }
  }, [queryMode, activeConnectionId, llmModels.length])

  const runSql = useCallback(async (sourceSql: string, userInitiated = false, options?: { readOnly?: boolean }) => {
    if (!activeConnectionId) return
    const trimmedSource = sourceSql.trim()
    if (!trimmedSource) return
    // In a manual transaction, ONLY explicit user runs may issue a statement —
    // reactive cascades, mount, and db-switch auto-runs must never inject a
    // statement into the user's open transaction.
    if (txnSessionId && !userInitiated) return
    const myNonce = ++runNonceRef.current
    setRunEpoch(myNonce)
    // DEV instrumentation: record every runSql so a test harness can detect a
    // re-run storm (a block whose count climbs without user action). No-op in prod.
    if (process.env.NODE_ENV !== "production") {
      const g = globalThis as unknown as { __rvbbitRunLog?: { id: string; name: string; t: number }[] }
      ;(g.__rvbbitRunLog ??= []).push({ id: w.id, name: blockName, t: Date.now() })
    }
    // Compile *this draft* against the runtime graph by patching the
    // window's source SQL into the graph build. The simpler path: build
    // the graph against the live windows array, swap the active window's
    // source for the draft, and pull the compiled SQL.
    const graph = buildDesktopRuntimeGraph(
      allWindows.map((win) =>
        win.id === w.id && win.kind === "data"
          ? {
              ...win,
              payload: {
                ...(win.payload as DataPayload),
                reactive: {
                  ...((win.payload as DataPayload).reactive ?? { blockName, paramSubscriptions: subscriptions, version: 1 }),
                  sourceSql: trimmedSource,
                  blockName,
                  paramSubscriptions: htmlBlock ? [] : subscriptions,
                },
              } satisfies DataPayload,
            }
          : win,
      ),
      params,
      schema,
    )
    const compiled = graph.blocks.get(w.id)?.compiledSql ?? trimmedSource
    const subscriptionFilters: CrossFilter[] = htmlBlock
      ? subscriptions.flatMap((s) => {
          const p = params.find((param) => paramKey(param.sourceBlockName, param.field).toLowerCase() === s.key.toLowerCase())
          if (!p) return []
          return [{
            sourceSchema: p.sourceSchema,
            sourceTable: p.sourceTable,
            column: p.sourceColumn || s.targetField,
            value: p.value,
            operator: p.operator,
          } satisfies CrossFilter]
        })
      : []
    const runCrossFilters = subscriptionFilters.length > 0
      ? [...crossFiltersRef.current, ...subscriptionFilters]
      : crossFiltersRef.current
    const compiledForPipelines =
      runCrossFilters.length > 0
        ? injectPipelineHeadFilters(compiled, runCrossFilters, schema)
        : compiled
    // Pipeline cascade sugar: each bare `select ... then op(...)` statement is
    // wrapped as rvbbit.flow($$...$$) so THEN never reaches the PG parser. Per-
    // statement wrapping keeps multi-component SQL blocks composable.
    const flowWrap = wrapFlowStatements(compiledForPipelines)
    const isPipeline = flowWrap.hasPipeline
    const compiledRun = flowWrap.sql
    // Cross-filter: push active block-local filters into each safe single-table
    // SELECT statement (multi-statement dashboard). No-op when no filters / not
    // multi-statement; only mutates statements proven safe (see injectStatementFilters).
    // Only trust the captured per-statement columns when they were measured on the
    // SAME compiled SQL we are about to run — otherwise mechanism 2 could wrap a tile
    // with a prior run's columns (wrong column / 42703). Mismatch → surgical-only.
    // Block comments (the inlined {ref} `version=N` marker, as_of, user notes) don't
    // change a statement's OUTPUT columns, so normalize them out — else a referenced
    // block re-running (version bump) would silently disable mechanism-2 for {ref} tiles.
    const stmtCols =
      lastStmtColsRef.current && colsKey(lastStmtColsRef.current.sql) === colsKey(compiledRun)
        ? lastStmtColsRef.current.cols
        : undefined
    const toRun =
      runCrossFilters.length > 0
        ? injectStatementFilters(compiledRun, runCrossFilters, schema, stmtCols)
        : compiledRun
    lastExecutedSqlRef.current = toRun
    // rvbbit.synth(…) is a text-to-SQL source returning one jsonb column per row;
    // expand those into real grid columns like a pipeline (but it isn't wrapped and
    // has no Steps tab).
    const isSynth = !isPipeline && isSynthQuery(compiled)
    // Pipeline/synth results are client-expanded from one jsonb column — "Load
    // more" must not offer to re-fetch them (it would bypass the expansion).
    setLastRunExpanded(isPipeline || isSynth)
    if (isPipeline) {
      setFlowSteps(null)
      setFlowStepsError(null)
      setActiveStep(0)
    }
    setProgress(null)
    setRunState({ kind: "running", sql: compiled, startedAt: Date.now() })
    const controller = new AbortController()
    const cancelToken = crypto.randomUUID()
    runControlRef.current = { controller, token: cancelToken }
    // Manual-transaction mode routes through the pinned-connection endpoint.
    const useTxn = !!txnSessionId
    // Optimistically mark the transaction active: the statement is about to reach
    // the pinned backend, so Commit/Rollback and the unmount-rollback guard must be
    // armed even if this run is later aborted or errors (the txn may be open server
    // side). Worst case Commit/Rollback no-op against a session that never opened.
    if (useTxn) setTxnActive(true)
    try {
      const res = await fetch(useTxn ? "/api/db/txn" : "/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(
          useTxn
            ? {
                action: "query",
                sessionId: txnSessionId,
                connectionId: activeConnectionId,
                sql: toRun,
                rowLimit: 5000,
                cancelToken,
                database: targetDb ?? undefined,
              }
            : {
                connectionId: activeConnectionId,
                sql: toRun,
                rowLimit: 5000,
                readOnly: options?.readOnly ?? false,
                cancelToken,
                database: targetDb ?? undefined,
              },
        ),
      })
      const body = (await res.json()) as
        | (QueryResult & { ok: true })
        | { ok: false; error: string; code?: string; detail?: string; hint?: string; position?: number | null }
      // A newer run started while this fetch was in flight — drop the
      // result so it doesn't overwrite state owned by the later run.
      if (runNonceRef.current !== myNonce) return
      // (txnActive was set optimistically before the await — the statement reached
      // the pinned backend, so the transaction is open regardless of this result.)
      // Record only user-initiated runs (not reactive/cascade/mount auto-runs),
      // and only the current (non-stale) one.
      if (userInitiated) pushQueryHistory(trimmedSource, activeConnectionId, body.ok === false)
      if (body.ok === false) {
        setRunState({ kind: "error", error: body.error, code: body.code, detail: body.detail, hint: body.hint, position: body.position })
        setIsPipelineRun(false)
      } else {
        // For a rvbbit.synth() block, ask the compiler for the AUTHORITATIVE column
        // schema (synth_schema — exact Postgres types, captured at compile time) so
        // the grid types and the projection casts are precise instead of guessed from
        // sampled rows. Falls back to inference if it can't be fetched.
        let synthCols: JsonbProjectionColumn[] | undefined
        if (isSynth) {
          const intent = extractSynthIntent(compiled)
          if (intent) {
            try {
              const sres = await fetch("/api/db/query", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  connectionId: activeConnectionId,
                  sql: `SELECT column_name, data_type FROM rvbbit.synth_schema('${intent.replace(/'/g, "''")}')`,
                  rowLimit: 500,
                  readOnly: false,
                  database: targetDb ?? undefined,
                }),
              })
              const sbody = (await sres.json()) as {
                ok: boolean
                rows?: { column_name: string; data_type: string }[]
              }
              if (runNonceRef.current !== myNonce) return
              if (sbody.ok && sbody.rows && sbody.rows.length > 0) {
                synthCols = columnsFromServerSchema(sbody.rows)
              }
            } catch {
              /* fall back to inference */
            }
          }
        }
        // flow() / synth() return a single jsonb column per row; expand into columns
        // (using the authoritative synth schema when we have it). Statement-aware
        // pipeline wrapping can also produce transcript entries, so expand those too.
        const finalResult = isPipeline || isSynth ? expandPipelineResult(body, synthCols) : body
        // Record the column shape so the reactive graph can wrap *references* to this
        // block in a typed projection (drag-out rollups / block.<name> refs see real
        // columns, not jsonb). Synth-only: a bare-`then` pipeline's compiledSql is not
        // valid SQL as a subquery, so projecting over it would be unparseable. Prefer
        // the authoritative schema; fall back to inference. Cleared for ordinary
        // queries.
        const jsonbProjection =
          isSynth && finalResult !== body
            ? synthCols ?? inferJsonbColumns(finalResult.rows as Record<string, unknown>[])
            : undefined
        setIsPipelineRun(isPipeline)
        setRunState({ kind: "done", result: finalResult })
        // Remember this run's per-statement columns (with pg provenance) so the
        // next cross-filter re-run can wrap {ref}/subquery/JOIN tiles by their
        // output column — keyed by the compiled SQL they belong to (see stmtCols
        // gate above). Only meaningful for a true multi-statement run.
        lastStmtColsRef.current =
          finalResult.results && finalResult.results.length > 1
            ? { sql: compiledRun, cols: finalResult.results.map((r) => r.columns) }
            : null
        // Record the compiled SQL that just succeeded, so the auto-rerun
        // effect treats *this* as the baseline (not the unfiltered first
        // render).
        prevCompiledRef.current = compiled
        // Advance the payload.sql sync baseline too: the onChangePayload below
        // writes `sql: trimmedSource`, and the payload.sql-sync effect would
        // otherwise read that self-induced change as an *external* edit and
        // re-run the query a second time. Harmless for memoized ops (cache
        // hit), but a cache_policy='never' agent operator would execute twice
        // (two transcripts + double cost). Claiming the baseline here makes
        // that effect a no-op for our own write.
        lastSyncedSqlRef.current = trimmedSource
        onChangePayload((p) => ({
          ...p,
          sql: trimmedSource,
          jsonbProjection,
          // Keep the rollup shelf in sync with hand-edited SQL: re-parse the
          // run SQL back into a spec where we can, else detach the shelf.
          lineage: p.lineage ? reconcileRollupLineage(p.lineage, trimmedSource) : p.lineage,
          reactive: {
            blockName,
            sourceSql: trimmedSource,
            paramSubscriptions: subscriptions,
            version: (p.reactive?.version ?? 1) + 1,
          },
        }))
        if (activeTab === "sql") setActiveTab("rows")
      }
    } catch (e) {
      if (runNonceRef.current !== myNonce) return
      // User-initiated cancel: the fetch was aborted — quietly return to idle.
      if (e instanceof DOMException && e.name === "AbortError") {
        setRunState({ kind: "idle" })
        return
      }
      setRunState({ kind: "error", error: e instanceof Error ? e.message : String(e) })
    } finally {
      if (runControlRef.current?.token === cancelToken) runControlRef.current = null
    }
  }, [activeConnectionId, activeTab, allWindows, blockName, htmlBlock, onChangePayload, params, subscriptions, w.id, targetDb, txnSessionId, schema])

  // First mount: auto-run for windows that already have a real SQL body
  // (table previews, drag-out aggregations, block-ref spawns). Skip the
  // hand-typed "SELECT 1" scratch start.
  useEffect(() => {
    if (runState.kind !== "idle" || !activeConnectionId) return
    // Semantic projections are per-row LLM ops — never auto-materialize; the
    // Explain tab estimates cost and the user runs explicitly.
    if (isSemanticProjection) return
    // Pipeline cascades (… then op('…')) run rowset LLM stages — don't fire
    // them on spawn unless this is an explicitly saved/published SQL app.
    if (hasTopLevelThen(payload.sql) && !payload.autoRun) return
    const isAutoRunOrigin = payload.origin === "table" || payload.origin === "derived"
    if (!isAutoRunOrigin && !payload.autoRun) return
    void runSql(payload.sql, false, { readOnly: !!htmlBlock })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the ref in sync so runSql reads the latest cross-filters without a dep.
  useEffect(() => {
    crossFiltersRef.current = crossFilters
  }, [crossFilters])


  // Click a tile cell → toggle a block-local cross-filter on that column's REAL
  // source table (pg provenance). An expression column (no provenance) is a no-op.
  const onCellFilter = useCallback((column: QueryResultColumn, value: unknown, stmtIndex: number) => {
    if (!column.sourceTable || !column.sourceColumn) return
    // Equality on a jsonb/array cell isn't meaningful — skip non-scalars (null is OK → IS NULL).
    if (value !== null && typeof value === "object") return
    const next: CrossFilter = {
      sourceSchema: column.sourceSchema,
      sourceTable: column.sourceTable,
      column: column.sourceColumn,
      value,
      operator: "eq",
      // The clicked statement is excluded from this filter (no self-filter).
      sourceStmtIndex: stmtIndex,
    }
    const k = crossFilterKey(next)
    setCrossFilters((prev) => {
      const existing = prev.find((p) => crossFilterKey(p) === k)
      // Re-click the same value → toggle off; else set/replace this column's filter.
      if (existing && sameParamValue(existing.value, value)) {
        return prev.filter((p) => crossFilterKey(p) !== k)
      }
      return [...prev.filter((p) => crossFilterKey(p) !== k), next]
    })
  }, [])

  // Click a chart mark (bar/point) in a tile → cross-filter, mirroring the chart's
  // point-selection set (SET semantics, not the grid's toggle): the selection is the
  // source of truth, so we REPLACE this column's filter with it — empty selection
  // clears. Same parity as the single-block chart → global-param path.
  const onChartFilter = useCallback((column: QueryResultColumn, values: unknown[], stmtIndex: number) => {
    const sourceTable = column.sourceTable
    const sourceColumn = column.sourceColumn
    if (!sourceTable || !sourceColumn) return
    const sourceSchema = column.sourceSchema
    const scalars = values.filter((v) => v === null || typeof v !== "object")
    const k = crossFilterKey({ sourceSchema, sourceTable, column: sourceColumn })
    setCrossFilters((prev) => {
      const without = prev.filter((p) => crossFilterKey(p) !== k)
      if (scalars.length === 0) return without
      return [
        ...without,
        {
          sourceSchema,
          sourceTable,
          column: sourceColumn,
          value: scalars.length === 1 ? scalars[0] : scalars,
          operator: scalars.length === 1 ? "eq" : "in",
          sourceStmtIndex: stmtIndex,
        },
      ]
    })
  }, [])

  // Commit or roll back the open manual transaction.
  const endTxn = useCallback(
    async (action: "commit" | "rollback") => {
      const sid = txnSessionId
      if (!sid) return
      // For a rollback, interrupt any in-flight statement on the pinned backend
      // (server cancel + abort the fetch) so the ROLLBACK reaches the backend
      // promptly instead of queuing behind a long-running statement. A commit lets
      // the in-flight statement finish first.
      if (action === "rollback") {
        const ctl = runControlRef.current
        if (ctl) {
          await fetch("/api/db/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cancelToken: ctl.token }),
          }).catch(() => {})
          ctl.controller.abort()
        }
      }
      await fetch("/api/db/txn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sessionId: sid }),
      }).catch(() => {})
      setTxnActive(false)
    },
    [txnSessionId],
  )

  // Toggle autocommit: turning it OFF starts manual-transaction mode (a fresh
  // session id); turning it ON rolls back any open transaction first.
  const toggleAutocommit = useCallback(async () => {
    if (txnSessionId) {
      if (txnActive) await endTxn("rollback")
      setTxnSessionId(null)
      setTxnActive(false)
    } else {
      setTxnSessionId(crypto.randomUUID())
    }
  }, [txnSessionId, txnActive, endTxn])

  // Roll back a still-open transaction if the window closes (best-effort).
  const txnRef = useRef({ sessionId: null as string | null, active: false })
  useEffect(() => {
    txnRef.current = { sessionId: txnSessionId, active: txnActive }
  }, [txnSessionId, txnActive])
  useEffect(
    () => () => {
      const t = txnRef.current
      if (t.sessionId && t.active) {
        void fetch("/api/db/txn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "rollback", sessionId: t.sessionId }),
          keepalive: true,
        }).catch(() => {})
      }
    },
    [],
  )

  // Stop the in-flight query: pg_cancel_backend on the server + abort the fetch.
  const cancelRun = useCallback(() => {
    const ctl = runControlRef.current
    if (!ctl) return
    void fetch("/api/db/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cancelToken: ctl.token }),
    }).catch(() => {})
    ctl.controller.abort()
  }, [])

  // Fetch the next page: re-run the same compiled SQL with a higher row cap and
  // replace the result. The 5000 cap is a client-side slice, so a bigger cap just
  // returns more of the same query. Run read-only so a re-fetch can never re-fire
  // a side-effecting statement, and nonce-guard so a concurrent run isn't clobbered.
  // Only offered for plain non-expanded SELECTs (see the button gate).
  const loadMore = useCallback(async () => {
    if (runState.kind !== "done" || !activeConnectionId) return
    // While a manual transaction is open, "Load more" must not run — it re-fetches
    // on a separate pooled connection that can't see this transaction's uncommitted
    // rows, so it would replace the in-txn page with an inconsistent snapshot.
    if (txnSessionId) return
    const ran = runState.result
    const myNonce = ++runNonceRef.current
    setLoadingMore(true)
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          sql: ran.sql,
          rowLimit: ran.rows.length + 5000,
          readOnly: true,
          database: targetDb ?? undefined,
        }),
      })
      const body = (await res.json()) as (QueryResult & { ok?: boolean }) | { ok: false }
      if (runNonceRef.current !== myNonce) return // a newer run superseded this page fetch
      if (body && (body as { ok?: boolean }).ok !== false) setRunState({ kind: "done", result: body as QueryResult })
    } catch {
      /* keep the current page on failure */
    } finally {
      setLoadingMore(false)
    }
  }, [runState, activeConnectionId, targetDb, txnSessionId])

  // Ask mode: generate SQL from the plain-English question via rvbbit.synth_sql
  // (grounded text-to-SQL → a validated, read-only SELECT), drop it into the
  // editor, flip back to SQL mode, and run it. One-shot, no chat.
  const runAsk = useCallback(async (question: string) => {
    if (!activeConnectionId) return
    const q = question.trim()
    if (!q) return
    const myNonce = ++runNonceRef.current
    setProgress(null)
    setRunState({ kind: "running", sql: "rvbbit.synth_sql(…)", startedAt: Date.now() })
    try {
      // Pass the chosen model via opts (invoke_with_cache honors opts.model and
      // keys the cache by it); empty opts = synth's default model.
      const opts = askModel ? JSON.stringify({ model: askModel }) : "{}"
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          // synth_sql writes its cache on a miss → must NOT be read-only.
          sql: `SELECT rvbbit.synth_sql('${q.replace(/'/g, "''")}', 'synth', '${opts.replace(/'/g, "''")}') AS sql`,
          rowLimit: 1,
          readOnly: false,
        }),
      })
      const body = (await res.json()) as
        | (QueryResult & { ok: true })
        | { ok: false; error: string; code?: string; detail?: string; hint?: string }
      // A newer action started while synth was in flight — drop this result.
      if (runNonceRef.current !== myNonce) return
      if (body.ok === false) {
        setRunState({ kind: "error", error: body.error, code: body.code, detail: body.detail, hint: body.hint })
        return
      }
      const firstCol = body.columns[0]?.name
      const generated = ((firstCol ? body.rows[0]?.[firstCol] : null) as string | null) ?? ""
      if (!generated.trim()) {
        setRunState({ kind: "error", error: "Ask: no SQL was generated — try rephrasing the question." })
        return
      }
      // synth_sql returns one long line — pretty-print it (whitespace/keyword
      // case only, semantically identical) so the editor is readable. Fall back
      // to the raw SQL if the formatter can't parse it.
      let pretty = generated
      try { pretty = formatSql(generated, { language: "postgresql", keywordCase: "upper" }) } catch { /* keep raw */ }
      // Hand off to runSql (it owns the next nonce); load + flip to SQL mode.
      setDraftSql(pretty)
      setQueryMode("sql")
      void runSql(pretty, true)
    } catch (e) {
      if (runNonceRef.current !== myNonce) return
      setRunState({ kind: "error", error: e instanceof Error ? e.message : String(e) })
    }
  }, [activeConnectionId, askModel, runSql])

  const runHtmlBlockAgentTurn = useCallback(async (message: string, current: HtmlBlockSpec | null): Promise<HtmlBlockTurnResult> => {
    if (!activeConnectionId) throw new Error("No connection selected.")
    const tableContext = schema?.tables.slice(0, 30).map((t) => ({
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      columns: t.columns.slice(0, 18).map((c) => ({ name: c.name, type: c.dataType })),
    })) ?? []
    const desktopContext = {
      blockName,
      title: payload.title || w.title,
      currentSql: payload.sql,
      tables: tableContext,
      lastResult: runState.kind === "done"
        ? {
            columns: runState.result.columns.map((c) => c.name),
            rows: runState.result.rows.length,
            statements: runState.result.results?.map((r) => ({ index: r.index, columns: r.columns.map((c) => c.name), rows: r.rows.length })),
          }
        : null,
    }
    const conversation = current?.messages?.slice(-12) ?? []
    const opts = askModel ? { model: askModel } : {}
    const sql =
      "SELECT rvbbit.html_block_turn(" +
      [
        sqlLiteral(message),
        sqlJsonLiteral(current),
        sqlJsonLiteral(conversation),
        sqlJsonLiteral(desktopContext),
        sqlJsonLiteral(opts),
      ].join(", ") +
      ") AS artifact"
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: activeConnectionId,
        sql,
        rowLimit: 1,
        readOnly: false,
        database: targetDb ?? undefined,
      }),
    })
    const body = (await res.json()) as
      | (QueryResult & { ok: true })
      | { ok: false; error: string; code?: string; detail?: string; hint?: string }
    if (body.ok === false) {
      throw new Error([body.error, body.detail, body.hint].filter(Boolean).join("\n"))
    }
    const raw = firstCellValue(body)
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : raw
    const extracted = extractHtmlBlockTurnResult(parsed)
    if (!extracted) throw new Error("html_block_turn did not return a valid HTML Block artifact.")
    return { ...extracted, source: "agent" }
  }, [activeConnectionId, askModel, blockName, payload.sql, payload.title, runState, schema, targetDb, w.title])

  const runAppTurn = useCallback(async (message: string) => {
    if (!activeConnectionId) return
    const text = message.trim()
    if (!text) return
    const current = htmlBlock
    const myNonce = ++runNonceRef.current
    setProgress(null)
    setRunState({ kind: "running", sql: "rvbbit.html_block_turn(…)", startedAt: Date.now() })
    let turn: HtmlBlockTurnResult
    try {
      turn = await runHtmlBlockAgentTurn(text, current)
    } catch (error) {
      if (runNonceRef.current !== myNonce) return
      const local = fallbackHtmlBlockTurn({ prompt: text, current, schema, draftSql })
      const reason = error instanceof Error ? error.message : String(error)
      turn = { ...local, summary: `${local.summary}${reason ? ` (${reason})` : ""}` }
    }
    if (runNonceRef.current !== myNonce) return
    const next = appendHtmlBlockTurn({ current, turn, userMessage: text })
    const nextSql = buildHtmlBlockSql(next)
    setDraftSql(nextSql)
    setAppDraft("")
    setQueryMode("app")
    setActiveTab("app")
    lastSyncedSqlRef.current = nextSql
    onChangePayload((p) => ({
      ...p,
      title: next.title || p.title,
      sql: nextSql,
      htmlBlock: next,
      view: { ...(p.view ?? {}), queryMode: "app", appDraft: "", activeTab: "app", sqlDraft: nextSql },
      reactive: {
        blockName,
        sourceSql: nextSql,
        paramSubscriptions: p.reactive?.paramSubscriptions ?? [],
        version: (p.reactive?.version ?? 1) + 1,
      },
    }))
    void runSql(nextSql, true, { readOnly: true })
  }, [activeConnectionId, blockName, draftSql, htmlBlock, onChangePayload, runHtmlBlockAgentTurn, runSql, schema])

  const onRun = useCallback(() => {
    if (queryMode === "ask") return void runAsk(askDraft)
    if (queryMode === "app") {
      if (appDraft.trim()) return void runAppTurn(appDraft)
      if (!htmlBlock) return
      const sql = buildHtmlBlockSql(htmlBlock)
      setDraftSql(sql)
      return void runSql(sql, true, { readOnly: true })
    }
    // A manual run of EDITED SQL invalidates the block-local cross-filters: their
    // POSITIONAL sourceStmtIndex is tied to the previous statement order, so after an
    // edit that inserts/removes/reorders statements they would spare/filter the wrong
    // sibling. Drop them (ref first, so THIS run executes unfiltered, no stale flash).
    if (crossFiltersRef.current.length > 0 && (draftSql || payload.sql).trim() !== (payload.sql ?? "").trim()) {
      crossFiltersRef.current = []
      setCrossFilters([])
    }
    void runSql(draftSql || payload.sql, true)
  }, [queryMode, askDraft, appDraft, draftSql, payload.sql, runAsk, runAppTurn, runSql, htmlBlock])

  // Lazily load per-step rowsets for the Steps inspector when that tab opens.
  useEffect(() => {
    if (activeTab !== "steps" || !isPipelineRun || flowSteps !== null || !activeConnectionId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: activeConnectionId,
            sql: FLOW_STEPS_SQL,
            rowLimit: 500,
            readOnly: true,
          }),
        })
        const body = (await res.json()) as
          | { ok: true; rows: FlowStepRow[] }
          | { ok: false; error: string }
        if (cancelled) return
        if (body.ok === false) {
          setFlowStepsError(body.error)
          setFlowSteps([])
        } else {
          setFlowSteps(body.rows ?? [])
          setFlowStepsError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setFlowStepsError(e instanceof Error ? e.message : String(e))
          setFlowSteps([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeTab, isPipelineRun, flowSteps, activeConnectionId])

  // When `payload.sql` changes from outside this window — e.g. another
  // window merged a dragged column into this rollup's lineage — adopt
  // it as the draft (only if the user hasn't drifted from the last
  // synced value) and re-run, so the grid reflects the new aggregate
  // immediately without a manual Run.
  useEffect(() => {
    if (lastSyncedSqlRef.current === payload.sql) return
    // In Ask mode the editor shows the question (askDraft), not draftSql, and a
    // synth-generated SQL change shouldn't silently re-run — just advance the
    // baseline so this doesn't re-fire when the user flips back to SQL.
    if (queryMode === "ask") { lastSyncedSqlRef.current = payload.sql ?? ""; return }
    const prev = lastSyncedSqlRef.current
    lastSyncedSqlRef.current = payload.sql ?? ""
    setDraftSql((cur) => (cur === prev ? (payload.sql ?? "") : cur))
    // Claim the current compiled SQL as the baseline *before* re-running.
    // `compiledSql` is derived from `payload.sql`, so the rerun-on-compiled
    // effect below also wakes on this change — but `draftSql` is still the
    // stale pre-merge value in this commit, so letting it fire would run the
    // OLD query and (winning the run nonce) clobber payload.sql right back.
    // Pinning the baseline here makes that effect a no-op for this change.
    prevCompiledRef.current = compiledSql
    // Semantic projections never auto-materialize (per-row LLM cost) — show the
    // updated plan/cost on Explain instead of running.
    if (isSemanticProjection) {
      setActiveTab("explain")
      return
    }
    // A newly-chained pipeline stage (… then op('…')) shouldn't fire its LLM
    // stages on edit — flip to Explain for a plan-only calls/cost preview; the
    // user reviews and runs it explicitly. Saved/published SQL apps opt into
    // running their authored workflow on open/update.
    if (payload.sql && hasTopLevelThen(payload.sql) && !payload.autoRun) {
      setActiveTab("explain")
      return
    }
    if (payload.sql) void runSql(payload.sql, false, { readOnly: queryMode === "app" || !!htmlBlock })
  }, [payload.sql, payload.autoRun, compiledSql, runSql, isSemanticProjection, queryMode, htmlBlock])

  // ── EXPLAIN ───────────────────────────────────────────────────────
  // Plan-only EXPLAIN (FORMAT JSON) never executes the query, so it is
  // safe to run on any statement. ANALYZE *does* execute it — the tab
  // gates that button to SELECTs.

  // Compile a source SQL string through the reactive graph exactly the
  // way runSql does, so EXPLAIN plans the SQL that would actually run —
  // including the current (possibly un-run) draft.
  const compileSource = useCallback(
    (sourceSql: string): string => {
      const trimmed = sourceSql.trim()
      if (!trimmed) return ""
      const graph = buildDesktopRuntimeGraph(
        allWindows.map((win) =>
          win.id === w.id && win.kind === "data"
            ? {
                ...win,
                payload: {
                  ...(win.payload as DataPayload),
                  reactive: {
                    ...((win.payload as DataPayload).reactive ?? {
                      blockName,
                      paramSubscriptions: subscriptions,
                      version: 1,
                    }),
                    sourceSql: trimmed,
                    blockName,
                  },
                } satisfies DataPayload,
              }
            : win,
        ),
        params,
        schema,
      )
      return graph.blocks.get(w.id)?.compiledSql ?? trimmed
    },
    [allWindows, blockName, params, subscriptions, w.id, schema],
  )

  // `silent` keeps the current graph on screen while re-planning (used
  // by the live-as-you-type pass) instead of flashing a spinner, and
  // swallows the syntax errors that are normal while a query is still
  // being typed — the last good plan stays visible.
  const runExplain = useCallback(
    async (analyze: boolean, silent = false) => {
      if (!activeConnectionId) return
      const sql = compileSource(draftSql || payload.sql)
      if (!sql) {
        if (!silent) setExplainState({ kind: "error", message: "No SQL to explain yet." })
        return
      }
      // With pg_rvbbit, EXPLAIN (SEMANTIC) is a strict superset — it
      // returns the regular plan *and* the Semantic Execution Graph
      // (the projected external/LLM cost). ESTIMATE mode makes no
      // external calls, so it stays safe for live re-planning.
      const prefix = hasRvbbit
        ? `EXPLAIN (SEMANTIC${analyze ? ", ANALYZE, BUFFERS" : ""}, FORMAT JSON)\n`
        : `EXPLAIN (${analyze ? "ANALYZE, BUFFERS, " : ""}FORMAT JSON)\n`
      if (silent) setExplainBusy(true)
      else setExplainState({ kind: "loading" })
      try {
        const res = await fetch("/api/db/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: activeConnectionId,
            sql: prefix + sql,
            rowLimit: 1,
            database: targetDb ?? undefined,
          }),
        })
        const body = (await res.json()) as
          | (QueryResult & { ok: true })
          | { ok: false; error: string }
        if (body.ok === false) {
          // Mid-typing errors: keep the last good plan if we have one.
          setExplainState((prev) =>
            silent && prev.kind === "done" ? prev : { kind: "error", message: body.error },
          )
          return
        }
        const plan = parseExplainResult(body.rows)
        if (!plan) {
          setExplainState((prev) =>
            silent && prev.kind === "done"
              ? prev
              : { kind: "error", message: "Could not parse the EXPLAIN output." },
          )
          return
        }
        setExplainState({ kind: "done", plan, analyzed: analyze })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setExplainState((prev) =>
          silent && prev.kind === "done" ? prev : { kind: "error", message },
        )
      } finally {
        if (silent) setExplainBusy(false)
      }
    },
    [activeConnectionId, compileSource, draftSql, payload.sql, hasRvbbit, targetDb],
  )

  // Run ANALYZE for real — but a semantic query's ANALYZE makes actual
  // (billable) LLM calls, so confirm against the projected cost first.
  const onAnalyze = useCallback(() => {
    if (explainState.kind === "done") {
      const sum = explainState.plan["Semantic Execution Graph"]?.["External Call Summary"]
      const cost = sum?.["Total Cost USD"] ?? 0
      const calls =
        (sum?.["LLM Calls"] ?? 0) +
        (sum?.["Sidecar Calls"] ?? 0) +
        (sum?.["Code Calls"] ?? 0)
      if (calls > 0) {
        const ok = window.confirm(
          `Run ANALYZE executes this query for real — about ${calls} external semantic ` +
            `call(s), ~$${cost.toFixed(4)} projected (cold-cache upper bound).\n\nContinue?`,
        )
        if (!ok) return
      }
    }
    void runExplain(true)
  }, [explainState, runExplain])

  // Live EXPLAIN: while the tab is open, re-plan shortly after the SQL
  // settles. Plan-only EXPLAIN never executes the query, so this is
  // cheap and safe to run on every pause in typing. The first plan on
  // open is immediate + non-silent; later ones are debounced + silent.
  const explainOpenedRef = useRef(false)
  useEffect(() => {
    if (activeTab !== "explain") {
      explainOpenedRef.current = false
      return
    }
    const justOpened = !explainOpenedRef.current
    explainOpenedRef.current = true
    const handle = setTimeout(
      () => void runExplain(false, !justOpened),
      justOpened ? 0 : 650,
    )
    return () => clearTimeout(handle)
  }, [activeTab, draftSql, compiledSql, runExplain])

  // Re-run when an upstream cascading filter changes or the desktop asks this
  // block to refresh (runSignal bumps).
  useEffect(() => {
    // In Ask mode draftSql is empty (the editor holds the question), so this
    // would re-run stale payload.sql — skip it.
    if (runSignal === 0 || isSemanticProjection || queryMode === "ask") return
    void runSql(draftSql || payload.sql, false, { readOnly: queryMode === "app" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal])

  // Re-run whenever the *compiled* SQL changes — i.e. a referenced {X}
  // upstream's SQL/version changed, a `param.X.Y` substitution flipped, or a
  // self subscription resolved. The first effect pass records the baseline
  // without running, so a later upstream rerun can wake even a never-run
  // downstream block.
  useEffect(() => {
    if (prevCompiledRef.current === null || isSemanticProjection) {
      prevCompiledRef.current = compiledSql
      return
    }
    if (prevCompiledRef.current === compiledSql) return
    prevCompiledRef.current = compiledSql
    void runSql(draftSql || payload.sql, false, { readOnly: queryMode === "app" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledSql])

  function onRenameBlock() {
    const next = prompt("Block name (used by other windows to reference this result):", blockName)
    if (!next) return
    const sanitized = slugifyBlockName(next)
    if (!sanitized) return
    const unique = uniqueBlockName(sanitized, allWindows, w.id)
    onChangePayload((p) => ({
      ...p,
      reactive: {
        blockName: unique,
        sourceSql: p.reactive?.sourceSql ?? sourceSqlForPayload(p),
        paramSubscriptions: p.reactive?.paramSubscriptions ?? [],
        version: (p.reactive?.version ?? 1) + 1,
      },
    }))
  }

  function handleBlockDragStart(e: React.DragEvent<HTMLButtonElement>) {
    const title = payload.title || w.title || blockName
    writeBlockDragPayload(e.dataTransfer, {
      kind: "rvbbit-lens.desktop.block",
      windowId: w.id,
      blockName,
      title,
    })
    attachDragGhost(e.dataTransfer, {
      variant: "block",
      label: `{${blockName}}`,
      sublabel: "block ref",
    })
    // Publish the active block drag so the rowset-op palette can surface.
    setActiveBlockDragSource({ windowId: w.id, blockName, title })
  }

  function handleParamDragOver(e: React.DragEvent<HTMLElement>) {
    if (!hasParamDragPayload(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setParamDropHot(true)
  }

  function handleParamDragLeave() { setParamDropHot(false) }

  function showParamNotice(msg: string) {
    setParamNotice(msg)
    if (paramNoticeTimer.current) clearTimeout(paramNoticeTimer.current)
    paramNoticeTimer.current = setTimeout(() => setParamNotice(null), 4500)
  }

  // Resolve a {ref} block name → its source SQL, so param-placement can follow a
  // chart's `FROM {core}` up to the column set of `core` (all blocks rooted on
  // the same table).
  function resolveBlockSource(name: string): string | null {
    const target = name.toLowerCase()
    for (const win of allWindows) {
      if (win.kind !== "data") continue
      const pl = win.payload as DataPayload | undefined
      if (!pl) continue
      const bn = (pl.reactive?.blockName || slugifyBlockName(pl.title || win.title || win.id)).toLowerCase()
      if (bn === target) return sourceSqlForPayload(pl)
    }
    return null
  }

  function handleParamDrop(e: React.DragEvent<HTMLElement>) {
    setParamDropHot(false)
    const drag = readParamDragPayload(e.dataTransfer)
    if (!drag) return
    e.preventDefault()
    const param = params.find((p) => p.key === drag.key)
    if (!param) return
    // Where can this field be applied? "from-item" pushes into the (possibly
    // {ref}-inlined) FROM-item; "query" wraps the output; "none" = the field
    // exists in neither → refuse instead of emitting `WHERE <missing> = …`.
    const placement = resolveParamPlacement(sourceSqlForPayload(payload), param.field, schema, {
      ownColumns: result?.columns?.map((c) => c.name) ?? null,
      blockSource: resolveBlockSource,
    })
    if (placement === "none") {
      showParamNotice(`Can't filter by “${param.field}” here — it isn't in this block's output or its upstream data.`)
      return
    }
    const target: ParamTarget = placement === "from-item" ? { kind: "from-item" } : { kind: "query" }
    onSubscribeParam(drag.key, param.field, target)
  }
  useEffect(() => () => { if (paramNoticeTimer.current) clearTimeout(paramNoticeTimer.current) }, [])

  // Re-run against the newly-selected database when the target-db switches, so
  // the visible rows always match the chosen db (skips the initial mount).
  const prevTargetDbRef = useRef(targetDb)
  useEffect(() => {
    if (prevTargetDbRef.current === targetDb) return
    prevTargetDbRef.current = targetDb
    if ((queryMode === "sql" || queryMode === "app") && (runState.kind === "done" || runState.kind === "error")) {
      void runSql(draftSql || payload.sql, false, { readOnly: queryMode === "app" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDb])

  // Re-run with the new cross-filters injected when they change (skips mount).
  const prevCrossRef = useRef(crossFilters)
  useEffect(() => {
    if (prevCrossRef.current === crossFilters) return
    prevCrossRef.current = crossFilters
    if ((queryMode === "sql" || queryMode === "app") && (runState.kind === "done" || runState.kind === "error")) {
      void runSql(draftSql || payload.sql, false, { readOnly: queryMode === "app" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossFilters])

  // Databases on this server, for the per-window target-db switcher.
  useEffect(() => {
    if (!activeConnectionId) return
    let cancelled = false
    fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: activeConnectionId,
        sql: "SELECT datname, datname = current_database() AS is_current FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname",
        poolLane: "meta",
      }),
    })
      .then((r) => r.json())
      .then((b: { ok?: boolean; rows?: { datname: string; is_current?: boolean }[] }) => {
        if (cancelled || !b.ok || !b.rows) return
        setDatabases(b.rows.map((r) => r.datname))
        setCurrentDb(b.rows.find((r) => r.is_current)?.datname ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeConnectionId])

  const onReset = useCallback(() => {
    if (queryMode === "ask") setAskDraft(view.askDraft ?? "")
    else if (queryMode === "app") setAppDraft(view.appDraft ?? "")
    else setDraftSql(payload.sql || "")
  }, [queryMode, payload.sql, view.askDraft, view.appDraft])

  const onHistory = useCallback(
    (e: React.MouseEvent) => {
      const recent = listQueryHistory(activeConnectionId, 15)
      setHistoryMenu({
        x: e.clientX,
        y: e.clientY,
        items:
          recent.length === 0
            ? [{ id: "empty", label: "No history yet", disabled: true }]
            : recent.map((h, i) => ({
                id: `h${i}`,
                label: h.sql.replace(/\s+/g, " ").trim().slice(0, 64) || "(empty)",
                danger: h.errored,
                onSelect: () => {
                  setDraftSql(h.sql)
                  void runSql(h.sql, true)
                },
              })),
      })
    },
    [activeConnectionId, runSql],
  )

  const onFormat = useCallback(() => {
    try {
      const next = formatSql(draftSql, { language: "postgresql", keywordCase: "upper" })
      setDraftSql(next)
    } catch { /* tolerate parse errors silently */ }
  }, [draftSql])

  const result = runState.kind === "done" ? runState.result : null
  const error = runState.kind === "error" ? runState : null
  const isRunning = runState.kind === "running"
  // The RAW (pre-filter) statement texts, by index, so the transcript/arrange key
  // per-statement views + tile layout on the SOURCE statement — stable while a
  // cross-filter/broadcast rewrites the executed SQL (else the layout would reset
  // on every filter). Content-bearing fragments only, to align with PG's results.
  const sourceStatements = useMemo(
    () => splitStatements(payload.sql ?? "").filter((sgmt) => sgmt.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim().length > 0),
    [payload.sql],
  )
  // A multi-statement run carries a per-statement breakdown — render the transcript
  // (nothing swallowed) instead of the single grid. Statement-aware pipeline wrapping
  // lets visual component blocks participate here too. Meta layout statements are
  // consumed here and hidden from the visible tile set.
  const rawMultiResults = useMemo(
    () => result && result.results && result.results.length > 1 ? result.results : null,
    [result],
  )
  const visibleMultiResults = useMemo(
    () => rawMultiResults?.filter((statement) => !isMetaOnlyResult(statement)) ?? null,
    [rawMultiResults],
  )
  const multiResults = useMemo(
    () => visibleMultiResults && visibleMultiResults.length > 1 ? visibleMultiResults : null,
    [visibleMultiResults],
  )
  const layoutArtifacts = useMemo(() => statementLayoutArtifacts(rawMultiResults), [rawMultiResults])
  const layoutArtifact = layoutArtifacts.length > 0 ? layoutArtifacts[layoutArtifacts.length - 1] : undefined
  const layoutAliases = useMemo(
    () => statementNameAliases(visibleMultiResults, sourceStatements),
    [visibleMultiResults, sourceStatements],
  )
  const filterBindings = useMemo(
    () => statementFilterBindings(visibleMultiResults, sourceStatements, layoutAliases),
    [visibleMultiResults, sourceStatements, layoutAliases],
  )
  const sqlStatementLayout = useMemo(
    () => layoutFromArtifact(layoutArtifact, visibleMultiResults, sourceStatements, layoutAliases),
    [layoutArtifact, visibleMultiResults, sourceStatements, layoutAliases],
  )
  const hasSqlStatementLayout = !!multiResults && !!sqlStatementLayout
  const effectiveStatementLayout = payload.statementLayout ?? sqlStatementLayout ?? undefined
  const uiArtifacts = result && !rawMultiResults ? extractUiArtifacts(result.rows) : null
  const arrangeMode = !!multiResults && effectiveStatementLayout?.mode === "arrange"
  const runAppReadOnlySql = useCallback(async (sql: string): Promise<QueryResult> => {
    if (!activeConnectionId) throw new Error("No connection selected.")
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: activeConnectionId,
        sql,
        rowLimit: 5000,
        readOnly: true,
        database: targetDb ?? undefined,
      }),
    })
    const body = (await res.json()) as (QueryResult & { ok?: true }) | { ok: false; error: string; detail?: string; hint?: string }
    if ((body as { ok?: boolean }).ok === false) {
      const err = body as { error: string; detail?: string; hint?: string }
      throw new Error([err.error, err.detail, err.hint].filter(Boolean).join("\n"))
    }
    return body as QueryResult
  }, [activeConnectionId, targetDb])
  const emitAppFilter = useCallback((input: AppBlockFilterInput) => {
    if (!htmlBlock) return
    const sourceIdx = input.queryId ? htmlBlock.queries.findIndex((q) => q.id === input.queryId) : 0
    const sourceResult = sourceIdx >= 0
      ? result?.results?.[sourceIdx] ?? (htmlBlock.queries.length === 1 ? result : null)
      : null
    const sourceCol = sourceResult?.columns.find((c) => c.name === input.field || c.sourceColumn === input.field)
    const sourceQueryId = sourceIdx >= 0 ? htmlBlock.queries[sourceIdx]?.id : input.queryId
    const boundTargets = htmlBlock.bindings?.filter((b) => b.sourceQueryId === sourceQueryId && b.field === input.field) ?? []
    const explicitTarget: Array<{ targetQueryId?: string; targetField?: string; operator?: CrossFilter["operator"] }> = input.targetQueryId
      ? [{ targetQueryId: input.targetQueryId, targetField: input.field, operator: input.operator }]
      : []
    const targets: Array<{ targetQueryId?: string; targetField?: string; operator?: CrossFilter["operator"] }> =
      explicitTarget.length > 0
        ? explicitTarget
        : boundTargets.length > 0
          ? boundTargets.map((b) => ({ targetQueryId: b.targetQueryId, targetField: b.targetField, operator: b.operator }))
          : [{ targetField: input.field, operator: input.operator }]
    const clear =
      input.value === null ||
      input.value === undefined ||
      (Array.isArray(input.value) && input.value.length === 0)
    const filters: CrossFilter[] = targets.map((target) => {
      const targetIdx = target.targetQueryId
        ? htmlBlock.queries.findIndex((q) => q.id === target.targetQueryId)
        : undefined
      const operator = target.operator ?? input.operator ?? (Array.isArray(input.value) ? "in" : "eq")
      return {
        sourceSchema: sourceCol?.sourceSchema,
        sourceTable: sourceCol?.sourceTable,
        column: target.targetField || sourceCol?.sourceColumn || input.field,
        value: input.value,
        operator,
        sourceStmtIndex: sourceIdx >= 0 ? sourceIdx : undefined,
        targetStmtIndex: typeof targetIdx === "number" && targetIdx >= 0 ? targetIdx : undefined,
      }
    })
    setCrossFilters((prev) => {
      let next = prev
      for (const filter of filters) {
        const key = crossFilterKey(filter)
        const without = next.filter((p) => crossFilterKey(p) !== key)
        next = clear ? without : [...without, filter]
      }
      crossFiltersRef.current = next
      return next
    })
  }, [htmlBlock, result])
  const appColumnDragSource = useMemo(() => htmlBlock ? {
    parentWindowId: w.id,
    parentBlockName: blockName,
    parentTitle: payload.title || w.title,
    parentSql: buildHtmlBlockSql(htmlBlock),
    relationKey: `${relationKeyFor(payload)}:html-block`,
  } : null, [blockName, htmlBlock, payload, w.id, w.title])
  useEffect(() => {
    const sql = payload.sql ?? ""
    if (seededUiDefaultSqlRef.current === sql) return
    seededUiDefaultSqlRef.current = sql
    seededUiDefaultKeysRef.current.clear()
  }, [payload.sql])
  const emitUiArtifactParam = useCallback((input: UiArtifactParamInput) => {
    if (input.defaultSeedKey) {
      if (seededUiDefaultKeysRef.current.has(input.defaultSeedKey)) return
      seededUiDefaultKeysRef.current.add(input.defaultSeedKey)
    }
    const rawBindings =
      multiResults && input.sourceStmtIndex !== undefined
        ? filterBindings.get(input.sourceStmtIndex)
        : undefined
    const bindings =
      input.requiresBinding && input.sourceStmtIndex !== undefined
        ? rawBindings?.filter((binding) => binding.targetStmtIndex !== input.sourceStmtIndex)
        : rawBindings
    if (input.requiresBinding && multiResults && input.sourceStmtIndex !== undefined && !bindings?.length) return
    const resolved =
      input.sourceStmtIndex === undefined
        ? null
        : resolveControlFilterSource(sourceStatements[input.sourceStmtIndex], input.field, schema)
    onEmitParam({
      sourceWindowId: w.id,
      sourceBlockName: blockName,
      sourceTitle: payload.title || w.title || blockName,
      field: input.field,
      value: input.value,
      operator: input.operator,
      multiValueAction: input.multiValueAction,
      cascade: input.cascade ?? false,
      type: input.type,
      sourceSchema: resolved?.sourceSchema,
      sourceTable: resolved?.sourceTable,
      sourceColumn: resolved?.column,
    })
    if (!multiResults || input.sourceStmtIndex === undefined) return

    const targets: StatementFilterTarget[] = bindings?.length
      ? bindings
      : [{ field: input.field }]
    const clear =
      input.multiValueAction === "remove" ||
      (input.multiValueAction === "replace" && Array.isArray(input.value) && input.value.length === 0) ||
      ((input.operator === "gte" || input.operator === "lte") && (input.value === null || input.value === undefined))
    setCrossFilters((prev) => {
      let next = prev
      for (const binding of targets) {
        const column = binding.field || resolved?.column || input.field
        const targetIsExplicitBinding = !!bindings?.length
        const target: Pick<CrossFilter, "sourceSchema" | "sourceTable" | "column" | "targetStmtIndex"> = targetIsExplicitBinding
          ? { column, targetStmtIndex: binding.targetStmtIndex }
          : resolved
          ? { ...resolved, column, targetStmtIndex: binding.targetStmtIndex }
          : { column, targetStmtIndex: binding.targetStmtIndex }
        const key = crossFilterKey(target)
        const existing = next.find((p) => crossFilterKey(p) === key)
        const without = next.filter((p) => crossFilterKey(p) !== key)
        if (clear) {
          next = without
          continue
        }
        if (input.multiValueAction === "replace" && existing && sameParamValue(existing.value, input.value)) {
          next = without
          continue
        }

        const base: CrossFilter = {
          ...target,
          value: input.value,
          operator: binding.operator ?? input.operator ?? "eq",
          sourceStmtIndex: input.sourceStmtIndex,
        }

        if (input.multiValueAction === "toggle" || input.multiValueAction === "add") {
          const existingValues = existing
            ? Array.isArray(existing.value)
              ? existing.value
              : [existing.value]
            : []
          const already = existingValues.some((v) => sameParamValue(v, input.value))
          const nextValues =
            input.multiValueAction === "toggle" && already
              ? existingValues.filter((v) => !sameParamValue(v, input.value))
              : already
                ? existingValues
                : [...existingValues, input.value]
          next = nextValues.length === 0
            ? without
            : [
                ...without,
                {
                  ...base,
                  value: nextValues.length === 1 ? nextValues[0] : nextValues,
                  operator: "in",
                },
              ]
          continue
        }

        next = [...without, base]
      }
      return next
    })
  }, [blockName, filterBindings, multiResults, onEmitParam, payload.title, schema, sourceStatements, w.id, w.title])

  const runUiArtifactAction = useCallback(async (input: UiArtifactActionInput): Promise<UiArtifactActionResult> => {
    if (!activeConnectionId) return { ok: false, error: "No connection selected." }
    try {
      const res = await fetch("/api/db/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: activeConnectionId,
          sql: input.sql,
          rowLimit: 500,
          readOnly: false,
          database: targetDb ?? undefined,
        }),
      })
      const body = (await res.json()) as {
        ok?: boolean
        error?: string
        command?: string
        rowCount?: number
        rows?: unknown[]
      }
      if (body.ok === false) return { ok: false, error: body.error ?? "Action failed." }
      if (input.refresh !== false) void runSql(draftSql || payload.sql)
      const command = body.command || "OK"
      const rowCount =
        typeof body.rowCount === "number"
          ? body.rowCount
          : Array.isArray(body.rows)
            ? body.rows.length
            : undefined
      return {
        ok: true,
        message: rowCount === undefined ? command : `${command} ${rowCount}`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }, [activeConnectionId, draftSql, payload.sql, runSql, targetDb])

  // DEV test handle: register this block so a Playwright harness can drive a
  // cross-filter without a real cell click (drag/click are hard to automate). No-op
  // in prod. `xfilterByName` finds the named output column (with provenance) on the
  // requested statement and calls onCellFilter exactly as a cell click would.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return
    const g = globalThis as unknown as { __rvbbitBlocks?: Record<string, unknown> }
    const reg = (g.__rvbbitBlocks ??= {})
    reg[w.id] = {
      name: blockName,
      runKind: () => runState.kind,
      compiledSql: () => compiledSql,
      lastExecutedSql: () => lastExecutedSqlRef.current,
      keys: () => (result?.results ? statementKeys(result.results, sourceStatements) : null),
      statements: () => result?.results?.map((r) => ({ cols: r.columns.map((c) => c.name), rows: r.rows.length })) ?? null,
      crossFilters: () => crossFiltersRef.current,
      aliases: () => Array.from(layoutAliases.entries()),
      filterBindings: () => Array.from(filterBindings.entries()),
      debugFilters: () => ({
        keys: result?.results ? statementKeys(result.results, sourceStatements) : null,
        statements: result?.results?.map((r) => ({ index: r.index, cols: r.columns.map((c) => c.name), rows: r.rows.length })) ?? null,
        aliases: Array.from(layoutAliases.entries()),
        filterBindings: Array.from(filterBindings.entries()),
        crossFilters: crossFiltersRef.current,
        lastExecutedSql: lastExecutedSqlRef.current,
      }),
      uiFilter: (field: string, value: unknown, stmtIdx = 0) => {
        const values = Array.isArray(value) ? value : [value]
        emitUiArtifactParam({
          field,
          value: values,
          operator: "in",
          multiValueAction: "replace",
          cascade: false,
          sourceStmtIndex: stmtIdx,
          requiresBinding: true,
        })
        return "ok"
      },
      xfilterByName: (colName: string, value: unknown, stmtIdx = 0) => {
        const cols = result?.results?.[stmtIdx]?.columns ?? result?.columns ?? []
        const col = cols.find((c) => c.name === colName)
        if (!col) return `no column ${colName}`
        onCellFilter(col, value, stmtIdx)
        return `ok: ${col.sourceTable ?? "?"}.${col.sourceColumn ?? "?"}`
      },
      chartFilter: (colName: string, values: unknown[], stmtIdx = 0) => {
        const cols = result?.results?.[stmtIdx]?.columns ?? result?.columns ?? []
        const col = cols.find((c) => c.name === colName)
        if (!col) return `no column ${colName}`
        onChartFilter(col, values, stmtIdx)
        return `ok: ${col.sourceTable ?? "?"}.${col.sourceColumn ?? "?"}`
      },
      setView: (stmtIdx: number, kind: string) => {
        const ks = result?.results ? statementKeys(result.results, sourceStatements) : null
        if (!ks?.[stmtIdx]) return "no key"
        onChangePayload((p) => ({ ...p, statementViews: { ...(p.statementViews ?? {}), [ks[stmtIdx]]: kind as never } }))
        return "ok"
      },
    }
    return () => { delete reg[w.id] }
  }, [w.id, blockName, result, runState.kind, onCellFilter, onChartFilter, onChangePayload, sourceStatements, compiledSql, layoutAliases, filterBindings, emitUiArtifactParam])

  // Live progress while a query runs — polled from a SEPARATE connection so we
  // can see it (the main connection is blocked). pg_stat_activity gives
  // elapsed/state/wait; rvbbit.receipt_queue_depth() gives in-flight semantic
  // calls. Replaces a blind "Running query...".
  useEffect(() => {
    // progress is reset at run-start and only rendered while running, so we
    // don't clear it here (avoids a synchronous setState in the effect).
    if (!isRunning || !activeConnectionId || !workspaceActive) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const res = await fetch("/api/db/query-progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId: activeConnectionId }),
        })
        const j = (await res.json()) as (QueryProgress & { ok?: boolean }) | null
        if (!cancelled && j?.ok) {
          setProgress({
            elapsedMs: j.elapsedMs ?? null,
            wait: j.wait ?? null,
            state: j.state ?? null,
            operators: Array.isArray(j.operators) ? j.operators : [],
          })
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) timer = setTimeout(poll, 700)
    }
    timer = setTimeout(poll, 400) // small delay so the query registers in pg_stat_activity
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isRunning, activeConnectionId, workspaceActive])

  // The editable rollup spec the shelf shows — null when this isn't a
  // column-aggregate window, or when the SQL was hand-edited into a shape
  // we can't model (detached: rollup === null).
  const rollupSpec = useMemo<RollupSpec | null>(() => {
    const lin = payload.lineage
    return lin ? effectiveRollup(lin) : null
  }, [payload.lineage])

  // Seed the Chart tab from the rollup spec (knows dims vs measures, and
  // which dim is temporal) instead of guessing from result column types.
  const chartSeedSpec = useMemo(
    () => (rollupSpec ? rollupChartSpec(rollupSpec) : null),
    [rollupSpec],
  )

  // Which filter UI a column gets (text multi-select / numeric / date
  // range), derived from the result column types when available.
  const columnKind = useMemo(() => {
    const map = new Map<string, FilterKind>()
    for (const c of result?.columns ?? []) {
      const role = classifyColumn(c)
      map.set(c.name, role === "numeric" ? "numeric" : role === "temporal" ? "date" : "text")
    }
    return (name: string): FilterKind => map.get(name) ?? "text"
  }, [result])

  const openVizBlockExport = useCallback(() => {
    if (!result) return
    const sourceTitle = payload.title || w.title || blockName
    const blockSlug = artifactId(sourceTitle, blockName)
    const link = vizObjectLinkDefaults(payload, result, blockName)
    const sources: VizExportSource[] = []

    if (multiResults?.length) {
      const keys = statementKeys(multiResults, sourceStatements)
      multiResults.forEach((statement, index) => {
        if (statement.columns.length === 0) return
        const sourceSql = sourceStatements[statement.index] ?? statement.sql ?? ""
        if (!sourceSql.trim()) return
        const key = keys[index] ?? `stmt_${statement.index + 1}`
        const view = payload.statementViews?.[key] ?? defaultKind(statement)
        const renderer: MaterializedVizRenderer =
          view === "number"
            ? "metric_card"
            : view === "bar" || view === "line"
              ? "basic_chart"
              : "table_view"
        sources.push({
          sourceIndex: statement.index,
          sourceSql,
          key,
          title: `Statement ${statement.index + 1}`,
          columns: statement.columns,
          rows: statement.rows,
          defaultRenderer: renderer,
          defaultChartKind: view === "line" ? "line" : "bar",
        })
      })
    } else if (result.columns.length > 0) {
      const inferred = inferChartSpec(result.columns, result.rows)
      const spec = sanitizeVegaSpec(payload.chartSpec ?? chartSeedSpec ?? inferred?.spec ?? null)
      const renderer: MaterializedVizRenderer =
        activeTab === "chart"
          ? viewKind === "chart" ? "vega_lite" : "filter_control"
          : "table_view"
      sources.push({
        sourceIndex: 0,
        sourceSql: sourceSqlForPayload(payload) || draftSql || result.sql,
        key: "result",
        title: sourceTitle,
        columns: result.columns,
        rows: result.rows,
        defaultRenderer: renderer,
        defaultChartKind: "bar",
        vegaSpec: spec,
      })
    }

    const chartSource = sources.find((source) => source.defaultRenderer === "vega_lite" || source.defaultRenderer === "basic_chart")
    const inferred = chartSource ? inferChartSpec(chartSource.columns, chartSource.rows) : null
    const filterField =
      payload.controlField ??
      vegaXField(chartSource?.vegaSpec) ??
      inferred?.xField ??
      sources[0]?.columns.find((column) => classifyColumn(column) !== "numeric")?.name ??
      sources[0]?.columns[0]?.name ??
      ""

    setVizExportSeed({
      title: sourceTitle,
      blockName: blockSlug,
      objectKind: link.objectKind,
      objectKey: link.objectKey,
      filterField,
      sources,
      statementLayout: multiResults ? effectiveStatementLayout : undefined,
      multi: !!multiResults,
    })
  }, [
    activeTab,
    blockName,
    chartSeedSpec,
    draftSql,
    effectiveStatementLayout,
    multiResults,
    payload,
    result,
    sourceStatements,
    viewKind,
    w.title,
  ])

  // Provide the column drag source so result-grid header cells can
  // serialize themselves into a column-drag DataTransfer payload.
  const columnDragSource = useMemo(() => {
    if (!result) return null
    const cols: DesktopColumnRef[] = result.columns.map((c) => ({
      name: c.name,
      type: c.dataTypeName,
      dataTypeId: c.dataTypeId,
      role: isNumericTypeId(c.dataTypeId) ? "metric" as const : "dimension" as const,
    }))
    return {
      parentWindowId: w.id,
      parentBlockName: blockName,
      parentTitle: payload.title || w.title,
      parentSql: payload.sql,
      relationKey: relationKeyFor(payload),
      columns: cols,
    }
  }, [blockName, payload, result, w.id, w.title])

  // The view the body renders. In present mode the editor-only tabs collapse to
  // the table so a presented tile always shows data, never a code surface.
  const bodyTab =
    present && (activeTab === "sql" || activeTab === "explain" || activeTab === "steps")
      ? "rows"
      : activeTab === "chart" && hasSqlStatementLayout
        ? "rows"
      : activeTab

  return (
    <div
      ref={rootRef}
      className={cn("relative flex h-full")}
      onDragOver={handleParamDragOver}
      onDragLeave={handleParamDragLeave}
      onDrop={handleParamDrop}
    >
      {paramDropHot ? (
        <div className="pointer-events-none absolute inset-0 z-30 m-2 grid place-items-center rounded-md border-2 border-dashed border-main/70 bg-main/10 text-[12px] font-medium text-main">
          Drop to subscribe this window to the param
        </div>
      ) : null}
      {paramNotice ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-2">
          <div className="pointer-events-auto max-w-[92%] rounded-md border border-danger/40 bg-chrome-bg/95 px-3 py-1.5 text-[11px] text-danger shadow-lg">
            {paramNotice}
          </div>
        </div>
      ) : null}
      {vizExportSeed && activeConnectionId ? (
        <VizBlockExportDialog
          seed={vizExportSeed}
          connectionId={activeConnectionId}
          onClose={() => setVizExportSeed(null)}
        />
      ) : null}
      {sqlRailOpen && !present ? (
        <>
        <aside
          ref={sqlRailRef}
          className="flex flex-col border-r border-chrome-border bg-doc-bg/80"
          style={{
            width: sqlRailWidthPx,
            minWidth: SQL_RAIL_MIN_WIDTH,
            maxWidth: `${SQL_RAIL_MAX_FRACTION * 100}%`,
          }}
        >
          <Toolbar
            isRunning={isRunning}
            onRun={onRun}
            onFormat={onFormat}
            onReset={onReset}
            onHistory={onHistory}
            onLoadFile={setDraftSql}
            databases={databases}
            currentDb={currentDb}
            targetDb={targetDb}
            onSetDb={setTargetDb}
            txnMode={!!txnSessionId}
            txnActive={txnActive}
            onToggleAutocommit={toggleAutocommit}
            onCommit={() => void endTxn("commit")}
            onRollback={() => void endTxn("rollback")}
            queryMode={queryMode}
            onSetQueryMode={(mode) => {
              setQueryMode(mode)
              if (mode === "app") setActiveTab("app")
            }}
            askable={hasRvbbit}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {queryMode === "ask" ? (
              <SqlEditor value={askDraft} onChange={setAskDraft} onRun={onRun} language="plain" />
            ) : queryMode === "app" ? (
              <AppChatPanel
                spec={htmlBlock}
                draft={appDraft}
                onDraftChange={setAppDraft}
                onRun={onRun}
              />
            ) : (
              <SqlEditor
                value={draftSql}
                onChange={setDraftSql}
                onRun={onRun}
                schema={sqlCompletion?.namespace}
                defaultSchema={sqlCompletion?.defaultSchema}
                completionSources={completionSources}
                blockReferences={blockReferences}
                semanticOperators={semanticOps}
              />
            )}
          </div>
          {queryMode === "ask" || queryMode === "app" ? (
            <div className="shrink-0 border-t border-chrome-border bg-chrome-bg/30 px-2 py-1.5">
              <ModelField value={askModel} models={llmModels} onChange={setAskModel} />
            </div>
          ) : null}
          <RunStatus runState={runState} progress={progress} onCancel={cancelRun} />
          <ContextMenu state={exportMenu} onClose={() => setExportMenu(null)} />
          <ContextMenu state={historyMenu} onClose={() => setHistoryMenu(null)} />
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize SQL editor"
          tabIndex={0}
          className="group relative z-20 w-2 shrink-0 cursor-col-resize touch-none select-none bg-transparent"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onPointerDown={startSqlRailResize}
          onKeyDown={nudgeSqlRailWidth}
          title="Drag to resize SQL editor"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-chrome-border/70 transition-colors group-hover:bg-main/70" />
          <div className="absolute inset-y-0 left-1/2 w-2 -translate-x-1/2 transition-colors group-hover:bg-main/10" />
        </div>
        </>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {present ? null : (
        <div className="flex h-9 shrink-0 items-center border-b border-chrome-border bg-chrome-bg/30 pl-1 pr-2">
          {/* Left group scrolls horizontally when narrow rather than wrapping —
              keeps the rail a fixed height and every tab reachable. */}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              type="button"
              onClick={() => setSqlRailOpen((o) => !o)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-chrome-text hover:bg-foreground/[0.06] hover:text-foreground"
              title={sqlRailOpen ? "Hide SQL editor" : "Show SQL editor"}
            >
              {sqlRailOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            </button>
            {/* Run lives in the SQL panel's toolbar when it's open; surface it
                here when the panel is collapsed so it's always one click away. */}
            {!sqlRailOpen ? (
              <button
                type="button"
                onClick={onRun}
                disabled={isRunning}
                className="grid h-7 w-7 shrink-0 place-items-center rounded text-rvbbit-accent hover:bg-rvbbit-accent/15 disabled:opacity-40"
                title="Run (⌘↩)"
              >
                {isRunning ? <Clock className="h-3.5 w-3.5 animate-pulse" /> : <Play className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            <Tab label="Rows" icon={Table2} active={activeTab === "rows"} onClick={() => setActiveTab("rows")} />
            {htmlBlock || queryMode === "app" ? (
              <Tab label="App" icon={FileCode2} active={activeTab === "app"} onClick={() => setActiveTab("app")} />
            ) : null}
            <Tab label="Profile" icon={Sigma} active={activeTab === "profile"} onClick={() => setActiveTab("profile")} />
            <Tab label="View" icon={BarChart3} active={activeTab === "chart"} onClick={() => setActiveTab("chart")} />
            <Tab label="SQL" icon={FileCode2} active={activeTab === "sql"} onClick={() => setActiveTab("sql")} />
            <Tab label="Explain" icon={TreeStructure} active={activeTab === "explain"} onClick={() => setActiveTab("explain")} />
            {isPipelineRun ? (
              <Tab label="Steps" icon={GitBranch} active={activeTab === "steps"} onClick={() => setActiveTab("steps")} />
            ) : null}

            <button
              type="button"
              draggable
              onDragStart={handleBlockDragStart}
              onDragEnd={() => setActiveBlockDragSource(null)}
              onClick={onRenameBlock}
              title={`Block name — drag onto a rowset tile to pipeline (filter/group/pivot/top/analyze/enrich), onto the canvas to spawn SELECT * FROM {${blockName}}, or click to rename. Reference this block from any other window's SQL as {${blockName}}.`}
              className="ml-1 inline-flex shrink-0 cursor-grab items-center gap-1 whitespace-nowrap rounded border border-main/30 bg-main/10 px-1.5 py-0.5 text-[10px] text-main hover:border-main/60 active:cursor-grabbing"
            >
              <GitBranch className="h-3 w-3" />
              {`{${blockName}}`}
            </button>

            <div className="shrink-0">
              <NotifyChannelControl
                channel={payload.notifyChannel}
                onChange={(ch) =>
                  onChangePayload((p) => ({ ...p, notifyChannel: ch }))
                }
              />
            </div>

            {subscriptions.length > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-rvbbit-accent/30 bg-rvbbit-bg/40 px-1.5 py-0.5 text-[10px] text-rvbbit-accent" title={subscriptions.map((s) => s.key).join(", ")}>
                {subscriptions.length} filter{subscriptions.length === 1 ? "" : "s"}
              </span>
            ) : null}

            {payload.sourceContext && onOpenKgForSource ? (
              <button
                type="button"
                onClick={() => onOpenKgForSource(payload.sourceContext!)}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-chrome-border/60 bg-background px-2 py-0.5 text-[10px] hover:border-chrome-border hover:bg-foreground/[0.06]"
                style={{ color: "var(--brand-kg)" }}
                title={`Open the KG node(s) tied to ${payload.sourceContext.sourceTable}#${payload.sourceContext.sourcePk}`}
              >
                <TreeStructure className="h-3 w-3" />
                <span>open in KG</span>
              </button>
            ) : null}
          </div>

          {/* Right cluster is pinned + never wraps, so the row/ms readout can't
              push the rail to multiple lines. */}
          {result ? (
            <div className="flex shrink-0 items-center gap-1 pl-2">
              <span className="whitespace-nowrap text-[11px] tabular-nums text-chrome-text">
                {multiResults
                  ? `${multiResults.length} statements · ${result.durationMs}ms`
                  : `${result.rowCount} rows · ${result.durationMs}ms${result.truncated ? " · truncated" : ""}`}
              </span>
              {multiResults ? (
                <span className="inline-flex shrink-0 items-center overflow-hidden rounded border border-chrome-border/60 text-[10px]">
                  {(["transcript", "arrange"] as const).map((m) => {
                    const active = (effectiveStatementLayout?.mode ?? "transcript") === m
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() =>
                          onChangePayload((p) => ({
                            ...p,
                            statementLayout: { ...(p.statementLayout ?? sqlStatementLayout ?? {}), mode: m },
                          }))
                        }
                        className={cn(
                          "px-1.5 py-0.5 capitalize transition-colors",
                          active ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/55 hover:text-foreground",
                        )}
                      >
                        {m}
                      </button>
                    )
                  })}
                </span>
              ) : null}
              {!multiResults && result.truncated && result.command === "SELECT" && !lastRunExpanded && !txnSessionId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={loadMore}
                  disabled={loadingMore}
                  title="Fetch 5000 more rows"
                  className="whitespace-nowrap text-[10px]"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                title="Export…"
                onClick={(e) => {
                  const target = payload.table
                    ? `"${payload.table.schema}"."${payload.table.name}"`
                    : "target_table"
                  setExportMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { id: "csv", label: "Export CSV", icon: Download, onSelect: () => exportCsv(result, w.title) },
                      { id: "json", label: "Export JSON", icon: FileCode2, onSelect: () => exportJson(result, w.title) },
                      { id: "inserts", label: "Copy as INSERTs", icon: ClipboardCopy, onSelect: () => void copyText(buildInserts(result, target)) },
                      ...(arrangeMode
                        ? [
                            {
                              id: "reset-layout",
                              label: "Reset arrange layout",
                              icon: RotateCcw,
                              separatorBefore: true,
                              onSelect: () => onChangePayload((p) => ({ ...p, statementLayout: sqlStatementLayout ?? { mode: "arrange" } })),
                            },
                          ]
                        : []),
                    ],
                  })
                }}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={openVizBlockExport}
                disabled={!hasRvbbit || !activeConnectionId}
                title={hasRvbbit ? "Save the current SQL view as a canonical viz block" : "Requires an rvbbit-enabled database"}
              >
                <Save className="h-3.5 w-3.5" />
                <span className="text-xs">Save viz</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onSaveAsViewApp({
                    sql: payload.sql || draftSql,
                    title: payload.title,
                    chartSpec: payload.chartSpec ?? null,
                    statementViews: payload.statementViews,
                    statementLayout: effectiveStatementLayout,
                    viewKind: payload.viewKind,
                    controlField: payload.controlField,
                    htmlBlock,
                  })
                }
                title="Save as a view (rows + chart)"
              >
                <Boxes className="h-3.5 w-3.5" />
                <span className="text-xs">Save view</span>
              </Button>
            </div>
          ) : null}
        </div>
        )}

        {rollupSpec && onEditRollup && !present ? (
          <RollupShelf
            spec={rollupSpec}
            onEdit={onEditRollup}
            onRepivot={onRepivot}
            onProbeValues={onProbeValues}
            columnKind={columnKind}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {bodyTab === "app" ? (
            <AppBlockView
              spec={htmlBlock}
              result={result}
              running={isRunning}
              error={error?.error ?? null}
              activeConnectionId={activeConnectionId}
              columnDragSource={appColumnDragSource}
              onRun={onRun}
              onRunSql={runAppReadOnlySql}
              onEmitFilter={emitAppFilter}
            />
          ) : null}
          {bodyTab === "rows" && result ? (
            multiResults ? (
              <div className="flex h-full flex-col">
                {crossFilters.length > 0 ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-chrome-border/60 bg-chrome-bg/40 px-2 py-1 text-[10px]">
                    <span className="shrink-0 text-chrome-text/50">Filtering</span>
                    {crossFilters.map((f) => (
                      <span
                        key={crossFilterKey(f)}
                        className="inline-flex items-center gap-1 rounded-full border border-rvbbit-accent/40 bg-rvbbit-accent/10 px-1.5 py-0.5 text-rvbbit-accent"
                      >
                        <span className="font-mono">{`${crossFilterLabel(f)} = ${shortParamValue(f.value)}`}</span>
                        <button
                          type="button"
                          title="Remove filter"
                          onClick={() =>
                            setCrossFilters((prev) => prev.filter((p) => crossFilterKey(p) !== crossFilterKey(f)))
                          }
                          className="hover:text-foreground"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCrossFilters([])}
                      className="shrink-0 text-chrome-text/45 hover:text-foreground"
                    >
                      clear all
                    </button>
                  </div>
                ) : null}
                {/* key by run nonce → remount each run; per-card views + layout live
                    in the payload, so they survive the remount. */}
                <div className="min-h-0 flex-1">
                  {arrangeMode ? (
                    <ArrangeGrid
                      key={runEpoch}
                      results={multiResults}
                      views={payload.statementViews}
                      onSetView={(viewKey, kind) =>
                        onChangePayload((p) => ({
                          ...p,
                          statementViews: { ...(p.statementViews ?? {}), [viewKey]: kind },
                        }))
                      }
                      layout={effectiveStatementLayout}
                      onChangeLayout={(mut) =>
                        onChangePayload((p) => ({ ...p, statementLayout: mut(effectiveStatementLayout ?? {}) }))
                      }
                      onCellFilter={onCellFilter}
                      onChartFilter={onChartFilter}
                      crossFilters={crossFilters}
                      sourceStatements={sourceStatements}
                      activeParams={blockParams}
                      onEmitParam={emitUiArtifactParam}
                      onRunAction={runUiArtifactAction}
                    />
                  ) : (
                    <ResultTranscript
                      key={runEpoch}
                      results={multiResults}
                      sourceStatements={sourceStatements}
                      views={payload.statementViews}
                      onSetView={(viewKey, kind) =>
                        onChangePayload((p) => ({
                          ...p,
                          statementViews: { ...(p.statementViews ?? {}), [viewKey]: kind },
                        }))
                      }
                      onCellFilter={onCellFilter}
                      onChartFilter={onChartFilter}
                      crossFilters={crossFilters}
                      activeParams={blockParams}
                      onEmitParam={emitUiArtifactParam}
                      onRunAction={runUiArtifactAction}
                    />
                  )}
                </div>
              </div>
            ) : uiArtifacts ? (
              <UiArtifactView artifacts={uiArtifacts} fill activeParams={blockParams} onEmitParam={emitUiArtifactParam} onRunAction={runUiArtifactAction} />
            ) : result.rows.length === 1 && result.columns.length === 1 ? (
              <SingleCellCallout
                column={result.columns[0]}
                value={result.rows[0]?.[result.columns[0].name]}
              />
            ) : (
              <ResultGrid
                columns={result.columns}
                rows={result.rows}
                transposed={rowsTransposed}
                onTransposedChange={setRowsTransposed}
                columnDragSource={columnDragSource}
                activeParams={blockParams}
                onOpenRow={({ row, rowIndex, column }) => {
                  onOpenRow({
                    kind: "row-inspector",
                    sourceTitle: payload.title || w.title || blockName,
                    rowIndex,
                    columns: result.columns as QueryResultColumn[],
                    row,
                    selectedColumn: column.name,
                  })
                }}
                onEmitCellParam={(field, value, dataTypeId, operator, cascade, source) => {
                  onEmitParam({
                    sourceWindowId: w.id,
                    sourceBlockName: blockName,
                    sourceTitle: payload.title || w.title || blockName,
                    field,
                    value,
                    operator: operator ?? "eq",
                    cascade,
                    dataTypeId,
                    sourceSchema: source?.schema,
                    sourceTable: source?.table,
                    sourceColumn: source?.column,
                  })
                }}
              />
            )
          ) : null}
          {bodyTab === "rows" && !result ? (
            <EmptyResult
              error={error}
              running={isRunning}
              progress={progress}
              onRun={onRun}
              filterCount={crossFilters.length}
              onClearFilters={() => setCrossFilters([])}
            />
          ) : null}
          {bodyTab === "profile" && result ? <ProfileView result={result} /> : null}
          {bodyTab === "profile" && !result ? (
            <EmptyResult
              error={error}
              running={isRunning}
              progress={progress}
              onRun={onRun}
              filterCount={crossFilters.length}
              onClearFilters={() => setCrossFilters([])}
            />
          ) : null}
          {bodyTab === "chart" && result ? (
            <div className="flex h-full flex-col">
              {present ? null : <ViewKindBar kind={viewKind} onChange={setViewKind} />}
              <div className="min-h-0 flex-1">
                {viewKind === "chart" ? (
                  <ChartView
                    result={result}
                    userSpec={payload.chartSpec ?? null}
                    onChangeUserSpec={(spec) => onChangePayload((p) => ({ ...p, chartSpec: spec }))}
                    chartRenderer={payload.chartRenderer}
                    onChangeChartRenderer={(renderer) => onChangePayload((p) => ({ ...p, chartRenderer: renderer }))}
                    chartTheme={payload.chartTheme ?? null}
                    onChangeChartTheme={(theme) => onChangePayload((p) => ({ ...p, chartTheme: theme }))}
                    seedSpec={chartSeedSpec}
                    activeParams={blockParams}
                    onEmitParam={(field, value, dataTypeId) => {
                      // The chart mirrors its full point selection: `value` is the
                      // ARRAY of selected values. "replace" sets the param to
                      // exactly that set (empty clears it), cascade:false so it
                      // never self-filters — drag the chip onto a target.
                      onEmitParam({
                        sourceWindowId: w.id,
                        sourceBlockName: blockName,
                        sourceTitle: payload.title || w.title || blockName,
                        field,
                        value,
                        operator: "in",
                        multiValueAction: "replace",
                        cascade: false,
                        dataTypeId,
                      })
                    }}
                  />
                ) : (
                  <ControlView
                    result={result}
                    field={payload.controlField ?? null}
                    kind={viewKind}
                    activeParams={blockParams}
                    onChangeField={(f) => onChangePayload((p) => ({ ...p, controlField: f }))}
                    onProbeBounds={probeBounds}
                    onEmit={(field, value, dataTypeId, spec) =>
                      onEmitParam({
                        sourceWindowId: w.id,
                        sourceBlockName: blockName,
                        sourceTitle: payload.title || w.title || blockName,
                        field,
                        value,
                        operator: spec.operator,
                        multiValueAction: spec.action,
                        cascade: false,
                        dataTypeId,
                      })
                    }
                  />
                )}
              </div>
            </div>
          ) : null}
          {bodyTab === "chart" && !result ? (
            <EmptyResult
              error={error}
              running={isRunning}
              progress={progress}
              onRun={onRun}
              filterCount={crossFilters.length}
              onClearFilters={() => setCrossFilters([])}
            />
          ) : null}
          {bodyTab === "sql" ? (
            queryMode === "app" ? (
              <GeneratedSqlView sql={draftSql || payload.sql || buildHtmlBlockSql(htmlBlock)} />
            ) :
            sqlRailOpen && !present ? (
              <SqlDockedPlaceholder />
            ) : (
              <div className="h-full bg-doc-bg group-data-[focused=false]/window:bg-doc-bg/70">
                <SqlEditor
                  value={draftSql}
                  onChange={setDraftSql}
                  onRun={onRun}
                  schema={sqlCompletion?.namespace}
                  defaultSchema={sqlCompletion?.defaultSchema}
                  completionSources={completionSources}
                  blockReferences={blockReferences}
                  semanticOperators={semanticOps}
                />
              </div>
            )
          ) : null}
          {bodyTab === "explain" ? (
            <ExplainTab
              state={explainState}
              busy={explainBusy}
              canAnalyze={
                explainState.kind === "done" &&
                explainState.plan.Plan["Node Type"] !== "ModifyTable"
              }
              onRefresh={() => void runExplain(false)}
              onAnalyze={onAnalyze}
            />
          ) : null}
          {bodyTab === "steps" ? (
            <FlowStepsView
              steps={flowSteps}
              error={flowStepsError}
              activeStep={activeStep}
              onSelectStep={setActiveStep}
            />
          ) : null}
        </div>
      </section>
      {present || queryMode === "app" ? null : (
        <TimeTravelStrip
          sql={draftSql}
          detectSql={compiledSql}
          onChange={setDraftSql}
          onRun={onRun}
          connectionId={activeConnectionId}
          hasRvbbit={hasRvbbit}
        />
      )}
    </div>
  )
}

function SqlDockedPlaceholder() {
  return (
    <div className="grid h-full place-items-center bg-doc-bg/60 text-[11px] text-chrome-text/45 group-data-[focused=false]/window:bg-doc-bg/40">
      <div className="flex items-center gap-2 rounded-md border border-chrome-border/50 bg-chrome-bg/35 px-3 py-2">
        <PanelLeftOpen className="h-3.5 w-3.5" />
        SQL editor is open in the side panel
      </div>
    </div>
  )
}

function GeneratedSqlView({ sql }: { sql: string }) {
  return (
    <div className="h-full overflow-auto bg-doc-bg p-3">
      <pre className="min-h-full whitespace-pre-wrap rounded-md border border-chrome-border bg-chrome-bg/35 p-3 font-mono text-[12px] leading-relaxed text-chrome-text">
        {sql || "SELECT 1 AS value;"}
      </pre>
    </div>
  )
}

function AppChatPanel({
  spec,
  draft,
  onDraftChange,
  onRun,
}: {
  spec: HtmlBlockSpec | null
  draft: string
  onDraftChange: (next: string) => void
  onRun: () => void
}) {
  const messages = spec?.messages ?? []
  return (
    <div className="flex h-full flex-col bg-doc-bg/70">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {messages.length === 0 ? (
          <div className="rounded-md border border-chrome-border/60 bg-chrome-bg/35 px-2 py-2 text-[11px] text-chrome-text/55">
            No turns yet.
          </div>
        ) : (
          <div className="space-y-2">
            {messages.slice(-16).map((m) => (
              <div
                key={m.id}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-[11px] leading-snug",
                  m.role === "user"
                    ? "border-main/30 bg-main/10 text-foreground"
                    : "border-chrome-border/60 bg-chrome-bg/45 text-chrome-text",
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[9px] uppercase tracking-wide text-chrome-text/55">
                  <span>{m.role}</span>
                  {m.agentRunId ? <span className="truncate font-mono">{m.agentRunId}</span> : null}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-chrome-border p-2">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              onRun()
            }
          }}
          rows={5}
          className="h-28 w-full resize-none rounded-md border border-chrome-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none placeholder:text-chrome-text/35 focus:border-main/60"
          placeholder={spec ? "Follow up..." : "Describe the HTML Block..."}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[10px] text-chrome-text/45">
            {spec?.queries.length ? `${spec.queries.length} quer${spec.queries.length === 1 ? "y" : "ies"}` : "draft"}
          </span>
          <Button size="sm" onClick={onRun} disabled={!draft.trim() && !spec}>
            <Sparkles className="h-3 w-3" />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}

function FlowStepsView({
  steps,
  error,
  activeStep,
  onSelectStep,
}: {
  steps: FlowStepRow[] | null
  error: string | null
  activeStep: number
  onSelectStep: (i: number) => void
}) {
  if (error) {
    return <div className="p-4 text-xs text-danger">Could not load pipeline steps: {error}</div>
  }
  if (steps === null) {
    return <div className="p-4 text-xs text-chrome-text/55">Loading pipeline steps…</div>
  }
  if (steps.length === 0) {
    return (
      <div className="p-4 text-xs text-chrome-text/55">
        No pipeline steps recorded for the last run.
      </div>
    )
  }
  const idx = Math.min(activeStep, steps.length - 1)
  const step = steps[idx]
  const rows = Array.isArray(step.rows) ? step.rows : []
  const cols: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r && typeof r === "object") {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k)
          cols.push(k)
        }
      }
    }
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-chrome-border p-2">
        {steps.map((s, i) => (
          <button
            key={s.step_idx}
            type="button"
            onClick={() => onSelectStep(i)}
            title={s.spec ?? s.stage}
            className={`rounded px-2 py-1 text-xs ${
              i === idx
                ? "bg-main/15 text-rvbbit-accent"
                : "text-chrome-text/55 hover:text-chrome-text"
            }`}
          >
            <span className="font-mono">{s.step_idx}</span> · {s.stage} ·{" "}
            <span className="font-mono">{s.n_rows}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {step.spec ? (
          <div className="mb-2 break-all font-mono text-[11px] text-chrome-text/55">{step.spec}</div>
        ) : null}
        {step.generated_sql ? (
          <pre className="mb-2 overflow-x-auto whitespace-pre-wrap rounded border border-chrome-border bg-doc-bg px-2 py-1 font-mono text-[11px] text-rvbbit-accent">
            {step.generated_sql}
          </pre>
        ) : null}
        {step.n_rows > rows.length ? (
          <div className="mb-1 text-[11px] text-chrome-text/55">
            showing first {rows.length} of {step.n_rows} rows
          </div>
        ) : null}
        {cols.length === 0 ? (
          <div className="text-xs text-chrome-text/55">(no rows)</div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="sticky top-0 border-b border-chrome-border bg-doc-bg px-2 py-1 text-left font-medium text-chrome-text"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, ri) => (
                <tr key={ri} className="border-b border-chrome-border/40">
                  {cols.map((c) => {
                    const v = (r as Record<string, unknown>)[c]
                    return (
                      <td key={c} className="px-2 py-1 align-top font-mono text-chrome-text">
                        {v === null || v === undefined
                          ? ""
                          : typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Toolbar({
  isRunning,
  onRun,
  onFormat,
  onReset,
  onHistory,
  onLoadFile,
  databases,
  currentDb,
  targetDb,
  onSetDb,
  txnMode,
  txnActive,
  onToggleAutocommit,
  onCommit,
  onRollback,
  queryMode,
  onSetQueryMode,
  askable,
}: {
  isRunning: boolean
  onRun: () => void
  onFormat: () => void
  onReset: () => void
  onHistory?: (e: React.MouseEvent) => void
  onLoadFile?: (content: string) => void
  databases?: string[]
  currentDb?: string | null
  targetDb?: string | null
  onSetDb?: (db: string | null) => void
  txnMode?: boolean
  txnActive?: boolean
  onToggleAutocommit?: () => void
  onCommit?: () => void
  onRollback?: () => void
  queryMode: "sql" | "ask" | "app"
  onSetQueryMode: (mode: "sql" | "ask" | "app") => void
  /** Whether the Ask (NL→SQL) toggle is offered — only on rvbbit connections. */
  askable: boolean
}) {
  const ask = queryMode === "ask"
  const app = queryMode === "app"
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-chrome-border bg-chrome-bg/40 px-1.5 [&>*]:shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Fixed height + no-shrink children: when the window is narrow the rail
          stays one row at a static height (overflow is swipe-scrollable but the
          scrollbar is hidden — matches the tab strip below). */}
      {/* SQL | Ask | HTML query-type toggle (rvbbit only). */}
      {askable ? (
        <div className="mr-0.5 inline-flex overflow-hidden rounded border border-chrome-border/70">
          <button
            type="button"
            onClick={() => onSetQueryMode("sql")}
            aria-pressed={queryMode === "sql"}
            className={cn("px-1.5 py-0.5 text-[10px] transition-colors", queryMode === "sql" ? "bg-foreground/[0.12] text-foreground" : "text-chrome-text/55 hover:bg-foreground/[0.06]")}
          >
            SQL
          </button>
          <button
            type="button"
            onClick={() => onSetQueryMode("ask")}
            aria-pressed={ask}
            title="Ask in plain English — generates SQL with rvbbit.synth_sql"
            className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors", ask ? "bg-rvbbit-accent/20 text-rvbbit-accent" : "text-chrome-text/55 hover:bg-foreground/[0.06]")}
          >
            <Sparkles className="h-2.5 w-2.5" />
            Ask
          </button>
          <button
            type="button"
            onClick={() => onSetQueryMode("app")}
            aria-pressed={app}
            title="HTML Block — chat-authored HTML backed by named SQL queries"
            className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-colors", app ? "bg-main/20 text-main" : "text-chrome-text/55 hover:bg-foreground/[0.06]")}
          >
            <FileCode2 className="h-2.5 w-2.5" />
            HTML
          </button>
        </div>
      ) : null}
      <Button size="sm" onClick={onRun} disabled={isRunning} title={ask ? "Generate SQL from your question (⌘↩)" : app ? "Send HTML Block turn or run its queries (⌘↩)" : "Run (⌘↩)"}>
        {ask || app ? <Sparkles className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        {ask ? "Ask" : app ? "Send" : "Run"}
      </Button>
      {!ask && !app && onToggleAutocommit ? (
        <button
          type="button"
          onClick={onToggleAutocommit}
          title={
            txnMode
              ? "Manual transaction (autocommit off) — click to return to autocommit"
              : "Autocommit on — click to start a manual transaction"
          }
          className={cn(
            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
            txnMode ? "border-warning/60 text-warning" : "border-chrome-border/60 text-chrome-text/60 hover:bg-foreground/[0.05]",
          )}
        >
          {txnActive ? <span className="h-1.5 w-1.5 rounded-full bg-warning" /> : null}
          {txnMode ? "txn" : "auto"}
        </button>
      ) : null}
      {!ask && !app && txnMode && txnActive && onCommit && onRollback ? (
        <>
          <Button size="sm" variant="neutral" onClick={onCommit} title="COMMIT the transaction">
            Commit
          </Button>
          <Button size="sm" variant="ghost" onClick={onRollback} title="ROLLBACK the transaction">
            Rollback
          </Button>
        </>
      ) : null}
      {!ask && !app ? (
        <Button size="sm" variant="neutral" onClick={onFormat} title="Format">
          Aa
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onReset} title={ask ? "Reset question" : app ? "Reset message" : "Reset to saved"}>
        <RotateCcw className="h-3 w-3" />
      </Button>
      {!ask && !app && onHistory ? (
        <Button size="sm" variant="ghost" onClick={onHistory} title="Query history">
          <Clock className="h-3 w-3" />
        </Button>
      ) : null}
      {!ask && !app && onLoadFile ? (
        <Button
          size="sm"
          variant="ghost"
          title="Open a .sql file into the editor"
          onClick={() => {
            const input = document.createElement("input")
            input.type = "file"
            input.accept = ".sql,.txt,text/plain"
            input.onchange = () => {
              const file = input.files?.[0]
              if (file) void file.text().then((text) => onLoadFile(text)).catch(() => {})
            }
            input.click()
          }}
        >
          <FolderOpen className="h-3 w-3" />
        </Button>
      ) : null}
      {!ask && !app && onSetDb && databases && databases.length > 1 ? (
        <select
          value={targetDb ?? currentDb ?? ""}
          // Re-selecting the connection's own database clears the override (null) so
          // it reads as "default" rather than a redundant per-window target.
          onChange={(e) => onSetDb(e.target.value && e.target.value !== currentDb ? e.target.value : null)}
          disabled={txnMode}
          title={
            txnMode
              ? "Locked: a manual transaction is pinned to this database — commit or roll back to switch"
              : "Target database for this window"
          }
          className="h-6 max-w-[150px] shrink-0 rounded border border-chrome-border/60 bg-chrome-bg px-1 text-[10px] text-chrome-text outline-none hover:bg-foreground/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {!currentDb ? <option value="">database…</option> : null}
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      ) : null}
      {ask || app ? (
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-chrome-text/55"
          title={ask ? "Generates SQL via one grounded LLM call (rvbbit.synth_sql) over your schema; cached after the first run." : "Runs an agent-backed HTML Block turn when rvbbit.html_block_turn is installed."}
        >
          <Sparkles className="h-2.5 w-2.5" style={{ color: "var(--rvbbit-accent)" }} />
          {ask ? "≈1 LLM call · cached after first" : "agent turn"}
        </span>
      ) : null}
    </div>
  )
}

const vizInputCls =
  "h-7 w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 font-mono text-[12px] text-foreground outline-none placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"
const vizAreaCls =
  "w-full rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1 font-mono text-[11px] leading-snug text-foreground outline-none placeholder:text-chrome-text/30 focus:border-main/50 focus:bg-foreground/[0.06]"

function tagsFromText(text: string): string[] {
  return text.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean)
}

function initialVizExportForm(seed: VizExportSeed): VizExportForm {
  const hasNonTable = seed.sources.some((source) => source.defaultRenderer !== "table_view")
  return {
    name: seed.blockName,
    title: seed.title,
    intent: seed.multi ? "dashboard" : "overview",
    description: `Canonical view exported from ${seed.title}.`,
    owner: "",
    tagsText: "viz-block, exported-view",
    artifactPrefix: seed.blockName,
    renderer: "current",
    chartKind: "bar",
    filterField: seed.filterField,
    includeTable: hasNonTable,
    objectKind: seed.objectKind,
    objectKey: seed.objectKey,
    linkRole: "source",
  }
}

function VizBlockExportDialog({
  seed,
  connectionId,
  onClose,
}: {
  seed: VizExportSeed
  connectionId: string
  onClose: () => void
}) {
  const [form, setForm] = useState<VizExportForm>(() => initialVizExportForm(seed))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)

  const built = useMemo(() => buildVizBlockExportSql(seed, form), [seed, form])
  const canSave = !saving && seed.sources.length > 0 && form.name.trim() !== "" && built.sql.trim() !== ""

  const save = useCallback(async () => {
    if (!canSave) return
    setSaving(true)
    setSaveError(null)
    setSavedVersion(null)
    const name = artifactId(form.name, "viz_block")
    const links =
      form.objectKind.trim() && form.objectKey.trim()
        ? [{
            objectKind: form.objectKind.trim(),
            objectKey: form.objectKey.trim(),
            role: form.linkRole.trim() || "source",
            confidence: 1,
            linkSource: "declared",
            conditions: {},
          }]
        : []
    const { version, error } = await defineVizBlock(connectionId, {
      name,
      title: form.title.trim() || name,
      intent: form.intent.trim() || "overview",
      description: form.description.trim() || null,
      owner: form.owner.trim() || null,
      sqlTemplate: built.sql,
      inputSchema: {
        source: "data_window_export",
        renderer: form.renderer,
        filter_field: form.filterField || null,
        statement_count: seed.sources.length,
      },
      layoutTemplate: built.layoutTemplate,
      params: {},
      tags: tagsFromText(form.tagsText),
      labels: built.labels,
      enabled: true,
      links,
    })
    setSaving(false)
    if (error) {
      setSaveError(error)
      return
    }
    setSavedVersion(version)
    setForm((current) => ({ ...current, name }))
  }, [built.labels, built.layoutTemplate, built.sql, canSave, connectionId, form, seed.sources.length])

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-background/55 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Save canonical viz block"
        className="flex max-h-[92%] w-[min(1120px,96%)] min-h-0 flex-col overflow-hidden rounded-md border border-chrome-border bg-chrome-bg shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border/70 px-3 py-2">
          <Save className="h-4 w-4 text-main" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">Save Canonical Viz Block</div>
            <div className="truncate text-[11px] text-chrome-text/50">
              {seed.sources.length} artifact source{seed.sources.length === 1 ? "" : "s"} from {seed.title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] overflow-hidden">
          <div className="min-h-0 overflow-y-auto border-r border-chrome-border/60 p-3">
            <div className="space-y-2">
              <VizExportField label="block name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: artifactId(e.target.value, "viz_block") }))}
                  className={vizInputCls}
                  placeholder="orders_overview"
                />
              </VizExportField>
              <VizExportField label="title">
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  className={vizInputCls}
                />
              </VizExportField>
              <div className="grid grid-cols-2 gap-2">
                <VizExportField label="intent">
                  <input
                    value={form.intent}
                    onChange={(e) => setForm((f) => ({ ...f, intent: artifactId(e.target.value, "overview") }))}
                    className={vizInputCls}
                  />
                </VizExportField>
                <VizExportField label="owner">
                  <input
                    value={form.owner}
                    onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                    className={vizInputCls}
                    placeholder="analytics"
                  />
                </VizExportField>
              </div>
              <VizExportField label="description">
                <textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  className={`${vizAreaCls} h-16`}
                />
              </VizExportField>
              <VizExportField label="tags">
                <input
                  value={form.tagsText}
                  onChange={(e) => setForm((f) => ({ ...f, tagsText: e.target.value }))}
                  className={vizInputCls}
                />
              </VizExportField>

              <div className="my-2 h-px bg-chrome-border/55" />

              <VizExportField label="artifact prefix">
                <input
                  value={form.artifactPrefix}
                  onChange={(e) => setForm((f) => ({ ...f, artifactPrefix: artifactId(e.target.value, "artifact") }))}
                  className={vizInputCls}
                />
              </VizExportField>
              <VizExportField label="renderer">
                <select
                  value={form.renderer}
                  onChange={(e) => setForm((f) => ({ ...f, renderer: e.target.value as VizExportRenderer }))}
                  className={vizInputCls}
                >
                  <option value="current">{seed.multi ? "current statement views" : "current view"}</option>
                  <option value="vega_lite">vega_lite</option>
                  <option value="basic_chart">basic_chart</option>
                  <option value="table_view">table_view</option>
                  <option value="metric_card">metric_card</option>
                  <option value="filter_control">filter_control</option>
                </select>
              </VizExportField>
              {form.renderer === "basic_chart" ? (
                <VizExportField label="chart kind">
                  <select
                    value={form.chartKind}
                    onChange={(e) => setForm((f) => ({ ...f, chartKind: e.target.value as VizExportForm["chartKind"] }))}
                    className={vizInputCls}
                  >
                    <option value="bar">bar</option>
                    <option value="line">line</option>
                    <option value="area">area</option>
                    <option value="point">point</option>
                  </select>
                </VizExportField>
              ) : null}
              <VizExportField label="filter field">
                <input
                  value={form.filterField}
                  onChange={(e) => setForm((f) => ({ ...f, filterField: e.target.value }))}
                  className={vizInputCls}
                  placeholder="state"
                />
              </VizExportField>
              <label className="flex items-center gap-2 rounded-[3px] border border-foreground/10 bg-foreground/[0.03] px-2 py-1.5 text-[11px] text-chrome-text/75">
                <input
                  type="checkbox"
                  checked={form.includeTable}
                  onChange={(e) => setForm((f) => ({ ...f, includeTable: e.currentTarget.checked }))}
                  className="h-3 w-3"
                />
                include detail table target
              </label>

              <div className="my-2 h-px bg-chrome-border/55" />

              <div className="grid grid-cols-[0.7fr_1.3fr] gap-2">
                <VizExportField label="object kind">
                  <input
                    value={form.objectKind}
                    onChange={(e) => setForm((f) => ({ ...f, objectKind: artifactId(e.target.value, "table") }))}
                    className={vizInputCls}
                  />
                </VizExportField>
                <VizExportField label="object key">
                  <input
                    value={form.objectKey}
                    onChange={(e) => setForm((f) => ({ ...f, objectKey: e.target.value }))}
                    className={vizInputCls}
                  />
                </VizExportField>
              </div>
              <VizExportField label="link role">
                <input
                  value={form.linkRole}
                  onChange={(e) => setForm((f) => ({ ...f, linkRole: artifactId(e.target.value, "source") }))}
                  className={vizInputCls}
                />
              </VizExportField>
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-chrome-border/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-chrome-text/55">Generated SQL Template</div>
              <div className="flex-1" />
              {savedVersion != null ? (
                <span className="rounded border border-success/35 bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
                  saved v{savedVersion}
                </span>
              ) : null}
              <Button size="sm" onClick={() => void save()} disabled={!canSave}>
                <Save className="h-3 w-3" />
                {saving ? "Saving..." : "Save block"}
              </Button>
            </div>
            {built.warnings.length ? (
              <div className="shrink-0 border-b border-warning/20 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
                {built.warnings[0]}
              </div>
            ) : null}
            {seed.sources.length === 0 ? (
              <div className="shrink-0 border-b border-danger/25 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
                No SELECT result with columns is available to export.
              </div>
            ) : null}
            {saveError ? (
              <div className="shrink-0 whitespace-pre-wrap border-b border-danger/25 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
                {saveError}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <SqlEditor
                value={built.sql}
                onChange={() => {}}
                readOnly
                autoFocus={false}
                wrap
                height="100%"
                fontSize={12}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function VizExportField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wider text-chrome-text/55">{label}</span>
      {children}
    </label>
  )
}

function NotifyChannelControl({
  channel,
  onChange,
}: {
  channel: string | null | undefined
  onChange: (channel: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(channel ?? "")
  const ref = useRef<HTMLDivElement>(null)
  const active = !!channel

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => {
            if (!o) setDraft(channel ?? "")
            return !o
          })
        }}
        title={
          active
            ? `Re-runs when a NOTIFY arrives on "${channel}" — click to change`
            : "Subscribe to a Postgres NOTIFY channel"
        }
        className={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
          active
            ? "border-main/50 bg-main/15 text-main"
            : "border-transparent text-chrome-text/55 hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        <Bell className="h-3 w-3" weight={active ? "fill" : "regular"} />
        {active ? <span className="font-mono">{channel}</span> : null}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-chrome-border bg-chrome-bg p-2 shadow-xl">
          <div className="mb-1.5 text-[10px] leading-snug text-chrome-text/70">
            Re-run this window whenever a Postgres <span className="font-mono">NOTIFY</span> lands
            on a channel.
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onChange(draft.trim() || null)
              setOpen(false)
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false)
              }}
              placeholder="channel name"
              className="h-7 flex-1 rounded border border-chrome-border bg-doc-bg px-2 font-mono text-[11px] text-foreground outline-none focus:border-main/60"
            />
            <button
              type="submit"
              className="h-7 rounded border border-chrome-border bg-secondary-background px-2 text-[11px] text-foreground hover:bg-foreground/[0.06]"
            >
              Set
            </button>
          </form>
          {active ? (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="mt-1.5 text-[10px] text-danger hover:underline"
            >
              Unsubscribe from {channel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Tab({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-[11px]",
        active
          ? "border-main/40 bg-main/15 text-foreground"
          : "border-transparent text-chrome-text hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  )
}

/** Segmented switcher for the "View" tab: render the result as a chart or as an
 *  interactive control (dropdown / multiselect) that publishes a pick param. */
function ViewKindBar({
  kind,
  onChange,
}: {
  kind: NonNullable<DataPayload["viewKind"]>
  onChange: (k: NonNullable<DataPayload["viewKind"]>) => void
}) {
  const items: { id: NonNullable<DataPayload["viewKind"]>; label: string }[] = [
    { id: "chart", label: "Chart" },
    { id: "dropdown", label: "Dropdown" },
    { id: "multiselect", label: "Multi-select" },
    { id: "datepicker", label: "Date" },
    { id: "slider", label: "Slider" },
  ]
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1">
      <span className="mr-1 text-[9px] uppercase tracking-wider text-chrome-text/50">view</span>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={cn(
            "rounded px-2 py-0.5 text-[10px] transition-colors",
            kind === it.id
              ? "bg-main/20 text-foreground"
              : "text-chrome-text/65 hover:bg-foreground/[0.06] hover:text-foreground",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

interface OpCount {
  operator: string
  calls: number
}

interface QueryProgress {
  elapsedMs: number | null
  wait: string | null
  state: string | null
  operators: OpCount[]
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US")
}

/** One-line live description of a running query for the status bar. */
function progressLabel(p: QueryProgress | null): string {
  if (!p) return "Running…"
  const bits: string[] = ["Running"]
  if (p.elapsedMs != null) bits.push(fmtDur(p.elapsedMs))
  const ops = p.operators ?? []
  if (ops.length > 0) {
    bits.push(ops.slice(0, 3).map((o) => `${o.operator} ${fmtNum(o.calls)}`).join(", "))
  }
  if (p.wait) bits.push(`waiting: ${p.wait}`)
  else if (p.state && p.state !== "active") bits.push(p.state)
  return bits.join(" · ")
}

/** Small live bar viz of per-operator semantic-call counts during a query. */
function OpCountsViz({ operators }: { operators: OpCount[] }) {
  if (!operators || operators.length === 0) return null
  const max = Math.max(...operators.map((o) => o.calls), 1)
  return (
    <div className="mx-auto mt-3 w-56 space-y-1.5 text-left">
      <div className="text-[10px] uppercase tracking-wide text-chrome-text/50">semantic calls</div>
      {operators.slice(0, 6).map((o) => (
        <div key={o.operator} className="flex items-center gap-2">
          <span className="w-20 shrink-0 truncate font-mono text-[10px] text-chrome-text/80" title={o.operator}>
            {o.operator}
          </span>
          <span className="relative h-2 flex-1 overflow-hidden rounded-sm bg-chrome-border/40">
            <span
              className="absolute inset-y-0 left-0 rounded-sm bg-chart-1/80"
              style={{ width: `${Math.max(4, (o.calls / max) * 100)}%` }}
            />
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-chrome-text/80">
            {fmtNum(o.calls)}
          </span>
        </div>
      ))}
    </div>
  )
}

function RunStatus({
  runState,
  progress,
  onCancel,
}: {
  runState: RunState
  progress: QueryProgress | null
  onCancel?: () => void
}) {
  if (runState.kind === "idle") return null
  return (
    <div className="flex items-center gap-2 border-t border-chrome-border bg-chrome-bg/40 px-3 py-1.5 text-[11px] text-chrome-text">
      {runState.kind === "running" ? (
        <>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3 w-3 animate-pulse" />
            {progressLabel(progress)}
          </span>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              title="Cancel the running query (pg_cancel_backend)"
              className="ml-auto inline-flex items-center gap-1 rounded border border-danger/50 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/10"
            >
              <X className="h-3 w-3" /> Stop
            </button>
          ) : null}
        </>
      ) : null}
      {runState.kind === "done" ? (
        <span>
          {runState.result.results && runState.result.results.length > 1
            ? `${runState.result.results.length} statements · ${runState.result.durationMs}ms`
            : `${runState.result.command ?? "OK"} · ${runState.result.rowCount} rows · ${runState.result.durationMs}ms`}
        </span>
      ) : null}
      {runState.kind === "error" ? (
        <span className="text-danger">{runState.error}</span>
      ) : null}
    </div>
  )
}

function EmptyResult({
  error,
  running,
  progress,
  onRun,
  filterCount,
  onClearFilters,
}: {
  error: { error: string; code?: string; detail?: string; hint?: string; position?: number | null } | null
  running: boolean
  progress?: QueryProgress | null
  onRun: () => void
  filterCount?: number
  onClearFilters?: () => void
}) {
  if (running) {
    return (
      <div className="grid h-full place-items-center text-xs text-chrome-text">
        <div className="text-center">
          <Clock className="mx-auto mb-2 h-5 w-5 animate-pulse" />
          <div>
            Running query
            {progress?.elapsedMs != null ? <span className="tabular-nums"> · {fmtDur(progress.elapsedMs)}</span> : "…"}
          </div>
          {progress?.wait ? (
            <div className="mt-1 text-[10px] text-chrome-text/60">waiting on {progress.wait}</div>
          ) : null}
          {progress?.operators ? <OpCountsViz operators={progress.operators} /> : null}
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-start gap-2 overflow-auto p-4 text-xs">
        <div className="inline-flex items-center gap-1.5 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error.code ? <span className="font-mono">{error.code}</span> : null}
          <span>{error.error}</span>
          {error.position != null ? (
            <span className="font-mono text-danger/70">@ char {error.position}</span>
          ) : null}
        </div>
        {error.detail ? <div className="text-chrome-text">{error.detail}</div> : null}
        {error.hint ? <div className="text-rvbbit-accent">Hint: {error.hint}</div> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="neutral" onClick={onRun}>Run again</Button>
          {filterCount && onClearFilters ? (
            <Button size="sm" variant="neutral" onClick={onClearFilters}>
              Clear {filterCount} filter{filterCount === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div className="grid h-full place-items-center text-xs text-chrome-text">
      Press Run to execute the query.
    </div>
  )
}

function ProfileView({ result }: { result: QueryResult }) {
  const profile = useMemo(() => buildProfile(result), [result])
  return (
    <div className="h-full overflow-auto p-3">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-chrome-bg/95 text-chrome-text">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">Column</th>
            <th className="px-2 py-1 font-medium">Type</th>
            <th className="px-2 py-1 font-medium text-right">Nulls</th>
            <th className="px-2 py-1 font-medium text-right">Distinct</th>
            <th className="px-2 py-1 font-medium">Min</th>
            <th className="px-2 py-1 font-medium">Max</th>
          </tr>
        </thead>
        <tbody>
          {profile.map((p) => (
            <tr key={p.column} className="border-t border-chrome-border/40">
              <td className="px-2 py-1 text-foreground">{p.column}</td>
              <td className="px-2 py-1 text-chrome-text">{p.type}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.nulls}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.distinct}</td>
              <td className="px-2 py-1 text-chrome-text">{p.min}</td>
              <td className="px-2 py-1 text-chrome-text">{p.max}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function buildProfile(result: QueryResult): Array<{
  column: string
  type: string
  nulls: number
  distinct: number
  min: string
  max: string
}> {
  return result.columns.map((c) => {
    let nulls = 0
    const distinct = new Set<string>()
    let min: unknown = undefined
    let max: unknown = undefined
    for (const r of result.rows) {
      const v = r[c.name]
      if (v == null) { nulls += 1; continue }
      const k = typeof v === "object" ? JSON.stringify(v) : String(v)
      if (distinct.size < 1000) distinct.add(k)
      if (typeof v === "number" || v instanceof Date) {
        if (min === undefined || (v as number | Date) < (min as number | Date)) min = v
        if (max === undefined || (v as number | Date) > (max as number | Date)) max = v
      } else if (typeof v === "string") {
        if (min === undefined || (typeof min === "string" && v < (min as string))) min = v
        if (max === undefined || (typeof min === "string" && v > (max as string))) max = v
      }
    }
    return {
      column: c.name,
      type: c.dataTypeName ?? String(c.dataTypeId),
      nulls,
      distinct: distinct.size,
      min: min === undefined ? "" : String(min),
      max: max === undefined ? "" : String(max),
    }
  })
}

function ExplainTab({
  state,
  busy,
  canAnalyze,
  onRefresh,
  onAnalyze,
}: {
  state: ExplainState
  busy: boolean
  canAnalyze: boolean
  onRefresh: () => void
  onAnalyze: () => void
}) {
  const loading = state.kind === "loading"
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-chrome-border bg-chrome-bg/30 px-2 py-1">
        <Button size="sm" variant="neutral" onClick={onRefresh} disabled={loading}>
          <RotateCcw className="h-3 w-3" />
          Re-explain
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onAnalyze}
          disabled={!canAnalyze || loading}
          title={
            canAnalyze
              ? "Runs the query for real row counts and timings"
              : "ANALYZE executes the statement — enabled only for SELECT"
          }
        >
          <Play className="h-3 w-3" />
          Run ANALYZE
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-chrome-text/55">
          {busy ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-main" />
              re-planning as you type…
            </>
          ) : (
            "live plan · safe · ANALYZE executes the query"
          )}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="grid h-full place-items-center text-xs text-chrome-text">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3 animate-pulse" />
              Planning…
            </span>
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full flex-col items-start gap-2 p-4 text-xs">
            <div className="inline-flex items-start gap-1.5 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{state.message}</span>
            </div>
            <Button size="sm" variant="neutral" onClick={onRefresh}>
              Try again
            </Button>
          </div>
        ) : state.kind === "done" ? (
          <ExplainGraph plan={state.plan} analyzed={state.analyzed} />
        ) : (
          <div className="grid h-full place-items-center text-xs text-chrome-text">
            Open this tab to plan the query.
          </div>
        )}
      </div>
    </div>
  )
}

function download(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 500)
}

function exportCsv(result: QueryResult, title: string) {
  download(rowsToCsv(result.columns, result.rows), "text/csv;charset=utf-8", `${slugify(title || "result")}.csv`)
}

function exportJson(result: QueryResult, title: string) {
  const json = JSON.stringify(
    result.rows,
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  )
  download(json, "application/json", `${slugify(title || "result")}.json`)
}

function sqlLiteral(v: unknown): string {
  if (v == null) return "NULL"
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL"
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  if (Array.isArray(v)) {
    // Postgres array literal '{a,b}' (flat case) — let the column type coerce.
    const inner = v
      .map((e) =>
        e == null
          ? "NULL"
          : typeof e === "number" || typeof e === "boolean"
            ? String(e)
            : `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      )
      .join(",")
    return `'{${inner}}'`
  }
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  return `'${String(v).replace(/'/g, "''")}'`
}

/** Result rows as INSERT statements (for moving data / seeding). */
function buildInserts(result: QueryResult, target: string): string {
  if (result.rows.length === 0) return "-- no rows"
  const cols = result.columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ")
  return result.rows
    .map(
      (r) =>
        `INSERT INTO ${target} (${cols}) VALUES (${result.columns.map((c) => sqlLiteral(r[c.name])).join(", ")});`,
    )
    .join("\n")
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* best effort */
  }
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function isNumericTypeId(oid: number): boolean {
  // 20=int8, 21=int2, 23=int4, 700=float4, 701=float8, 1700=numeric, 790=money
  return oid === 20 || oid === 21 || oid === 23 || oid === 700 || oid === 701 || oid === 1700 || oid === 790
}

function relationKeyFor(p: DataPayload): string {
  if (p.table) return `${p.table.schema}.${p.table.name}`
  if (p.origin === "derived" || p.origin === "query") return `query:${stableHash(p.sql)}`
  return `unknown:${stableHash(p.sql ?? "")}`
}

function stableHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36).slice(0, 8)
}
