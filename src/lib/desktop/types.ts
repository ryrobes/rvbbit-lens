import type { ExtensionInfo, QueryResultColumn, SchemaColumn, SchemaTable } from "@/lib/db/types"

export type DesktopWindowKind =
  | "finder"
  | "data"
  | "query-document"
  | "artifact"
  | "view-app"
  | "view-app-builder"
  | "view-apps"
  | "system-objects"
  | "extensions"
  | "rvbbit-cache"
  | "connections"
  | "palette"
  | "pg-monitor"
  | "notifications"
  | "operators"
  | "operator-flow"
  | "specialists"
  | "specialist-detail"
  | "routing"
  | "mcp-servers"
  | "mcp-server-detail"
  | "query-lens"
  | "kg-browser"
  | "kg-entity-detail"
  | "kg-extraction-runs"
  | "kg-merge-review"
  | "kg-explorer"
  | "capabilities"
  | "capability-detail"
  | "warren"
  | "warren-job-detail"
  | "costs"
  | "duck"
  | "data-search"
  | "drift"
  | "model-studio"

export interface DesktopWindowPosition {
  x: number
  y: number
}

export interface DesktopViewportState {
  x: number
  y: number
  scale: number
}

export interface DesktopWindowState {
  id: string
  kind: DesktopWindowKind
  title: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  minimized: boolean
  payload?: WindowPayload
}

export type WindowPayload =
  | FinderPayload
  | DataPayload
  | QueryDocumentPayload
  | ArtifactPayload
  | ViewAppPayload
  | ViewAppBuilderPayload
  | ViewAppsPayload
  | SystemObjectsPayload
  | ExtensionsPayload
  | RvbbitCachePayload
  | ConnectionsPayload
  | PalettePayload
  | PgMonitorPayload
  | NotificationsPayload
  | OperatorsPayload
  | OperatorFlowPayload
  | SpecialistsPayload
  | SpecialistDetailPayload
  | RoutingPayload
  | McpServersPayload
  | McpServerDetailPayload
  | QueryLensPayload
  | KgBrowserPayload
  | KgEntityDetailPayload
  | KgExtractionRunsPayload
  | KgMergeReviewPayload
  | KgExplorerPayload
  | CapabilitiesPayload
  | CapabilityDetailPayload
  | WarrenPayload
  | WarrenJobDetailPayload
  | CostsPayload
  | DuckPayload
  | DataSearchPayload
  | DriftPayload
  | ModelStudioPayload

export interface FinderPayload {
  kind?: "finder"
  selectedSchema?: string
}

export interface DataPayload {
  kind?: "data"
  title: string
  sql: string
  origin?: "table" | "query" | "derived"
  table?: { schema: string; name: string }
  view?: DataWindowViewState
  callerId?: string | null
  /**
   * Reactive overlay: every data window has a block name (defaulted to a
   * slug of its title). Other windows can reference this window's result
   * by name (`block.<name>`) or emit/receive params (`param.<block>.<field>`).
   * Subscriptions are *declarative* — they get rewritten as WHERE clauses
   * by buildDesktopRuntimeGraph before the SQL ships to Postgres.
   */
  reactive?: ReactiveBlockState
  /** lineage chain: which parent SQL spawned this derived window */
  lineage?: DesktopQueryLineage
  /**
   * Postgres LISTEN channel this window is subscribed to. When a
   * NOTIFY on this channel arrives, the window re-runs its query.
   */
  notifyChannel?: string | null
  /**
   * When this Data window was opened as a source-row deep-link from a
   * KG evidence row, this context is preserved so the window can
   * round-trip back to the KG via an "Open in KG" header chip.
   */
  sourceContext?: KgSourceContext
  /**
   * Sticky user-authored Vega-Lite spec for the Chart tab. When set,
   * the Chart tab uses this instead of the inferred auto-spec.
   * Editing the spec sets this; "Reset to auto" clears it back to
   * null and the auto-inferrer takes over again.
   */
  chartSpec?: Record<string, unknown> | null
}

export interface KgSourceContext {
  sourceTable: string
  sourcePk: string
  sourceColumn?: string | null
}

export interface ReactiveBlockState {
  blockName: string
  sourceSql?: string
  paramSubscriptions?: DesktopParamSubscription[]
  version?: number
}

export type DesktopParamOperator = "eq" | "in"

export interface DesktopParamValue {
  key: string
  sourceWindowId: string
  sourceBlockName: string
  sourceTitle: string
  field: string
  operator?: DesktopParamOperator
  value: unknown
  dataTypeId?: number
  type?: string
  updatedAt: string
}

export interface DesktopParamSubscription {
  key: string
  targetField: string
}

export interface DesktopBlockRef {
  windowId: string
  blockName: string
  title: string
}

export interface DesktopBlockDragPayload {
  kind: "rvbbit-lens.desktop.block"
  windowId: string
  blockName: string
  title: string
}

export interface DesktopParamDragPayload {
  kind: "rvbbit-lens.desktop.param"
  key: string
}

export interface DesktopQueryLineage {
  kind: "column-aggregate" | "block-ref"
  parentWindowId: string
  parentTitle: string
  parentSql: string
  relationKey: string
  /**
   * Parent window's reactive block name — what we write into `FROM {X}`
   * when (re)building a column-aggregate query. Distinct from
   * `relationKey`, which is a table/SQL-hash key used for matching.
   * Optional for backwards compat with pre-merge saved windows; new
   * column-aggregate windows always populate it.
   */
  parentBlockName?: string
  /**
   * Legacy flat column list. Superseded by `rollup`; still written as a
   * flattened mirror for any reader that only needs the column names.
   * New code should treat `rollup` as the source of truth and fall back
   * to deriving a spec from `columns` only when `rollup` is absent.
   */
  columns?: DesktopColumnRef[]
  /**
   * Declarative rollup spec — the source of truth for (re)building a
   * column-aggregate query. Group-bys, measures, ordering, and pivot all
   * live here so the SQL is a pure function of the spec.
   *
   * `null` is a distinct state: the user hand-edited the SQL into a shape
   * we can't model, so the rollup shelf detaches (hides) while the window
   * keeps running as plain SQL. Editing back to a recognizable rollup
   * re-attaches it. `undefined` = legacy window predating the spec.
   */
  rollup?: RollupSpec | null
}

/**
 * A declarative GROUP BY / aggregate spec. `buildRollupQuery` turns this
 * into SQL deterministically; drop-zone interactions mutate it via
 * `applyRollupOp`. Designed to be pivot-ready: the `pivot` term holds a
 * dimension plus its resolved distinct values, so the (verbose,
 * conditional-aggregation) pivot SQL stays a pure function of the spec.
 */
export interface RollupSpec {
  /** Grouping dimensions → SELECT + GROUP BY. */
  groupBy: RollupGroupTerm[]
  /** Aggregate measures. */
  measures: RollupMeasure[]
  /** Optional explicit ordering; when absent a sensible default is used. */
  orderBy?: RollupOrderTerm[]
  /** Pre-aggregation filters on source columns → WHERE (AND-combined). */
  filters?: RollupFilter[]
  /** Post-aggregation filters on measures → HAVING (AND-combined). */
  having?: RollupHavingTerm[]
  /** Top-N: rank by a measure and cap the row count. */
  limit?: RollupLimit | null
  /** Tableau-style pivot: a dimension's distinct values fan into columns. */
  pivot?: RollupPivot | null
}

export type RollupCompareOp = ">" | ">=" | "<" | "<=" | "=" | "!="

/** A WHERE predicate on a source column (pre-aggregation). */
export type RollupFilterOp =
  | "in" | "not_in"          // values[]
  | "eq" | "neq"             // value
  | "gt" | "gte" | "lt" | "lte" // value (numeric/date bound)
  | "is_null" | "not_null"

export interface RollupFilter {
  /** Source column (carries type/dataTypeId so the UI can pick a variant). */
  column: DesktopColumnRef
  op: RollupFilterOp
  /** For `in` / `not_in`. */
  values?: (string | number | null)[]
  /** For scalar comparisons. */
  value?: string | number | null
}

/** A HAVING condition on an aggregate measure. */
export interface RollupHavingTerm {
  measureId: string
  op: RollupCompareOp
  value: number
}

/** Top-N: order by a ranking measure and LIMIT the result. */
export interface RollupLimit {
  n: number
  /** Measure to rank by; default = first measure. */
  byMeasureId?: string
  /** desc = top (default), asc = bottom. */
  dir?: "asc" | "desc"
}

/**
 * Date-truncation grain for a temporal dimension (group-by or pivot).
 * Names map 1:1 to Postgres `date_trunc` units.
 */
export type RollupGrain = "year" | "quarter" | "month" | "week" | "day" | "hour"

/** A grouping dimension, optionally binned to a temporal grain. */
export interface RollupGroupTerm {
  column: DesktopColumnRef
  /** When set (temporal columns), the dim is `date_trunc(grain, col)`. */
  grain?: RollupGrain
}

export type RollupAgg =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_distinct"
  | "median"
  | "stddev"
  | "variance"

export interface RollupMeasure {
  /** Stable identity (`<agg>:<column|*>`) — dedupe key + pivot target. */
  id: string
  /** Source column; `null` means `count(*)` (row count). */
  column: DesktopColumnRef | null
  agg: RollupAgg
  /** SELECT alias, unique within the spec. */
  alias: string
}

export interface RollupOrderTerm {
  /** A group-by column name or a measure alias. */
  ref: string
  dir: "asc" | "desc"
}

export interface RollupPivot {
  /** Dimension whose distinct values fan out into columns. */
  column: DesktopColumnRef
  /** When set (temporal pivot), values are `date_trunc(grain, col)`. */
  grain?: RollupGrain
  /** Resolved distinct values (capped); rendered as FILTER predicates. */
  values: (string | number | null)[]
  /** Which measures to pivot; default = all measures. */
  measureIds?: string[]
  /** True when more distinct values existed than the cap. */
  truncated?: boolean
}

/**
 * A drop-zone action. Each type-aware tile in the merge overlay maps to
 * one of these; `applyRollupOp` folds it into a `RollupSpec`.
 */
export type RollupOp =
  // `grain` bins a temporal column when dropped (e.g. group by month).
  | { kind: "group-by"; grain?: RollupGrain }
  | { kind: "order-by" }
  | { kind: "measure"; agg: RollupAgg }
  // Pivot the dragged dimension across columns. `measureIds` scopes which
  // measures get spread (one per pivot value); omitted ⇒ all measures.
  // `grain` bins a temporal pivot column.
  | { kind: "pivot"; measureIds?: string[]; grain?: RollupGrain }

export interface DataWindowViewState {
  activeTab?: "rows" | "profile" | "chart" | "sql" | "explain"
  sqlRailOpen?: boolean
  sqlRailWidthPx?: number
  sqlDraft?: string
  autoRunIntervalMs?: number | null
}

export interface QueryDocumentPayload {
  kind?: "query-document"
  query: SavedQuery
}

export interface SavedQuery {
  id: string
  sql: string
  title?: string | null
  rowCount?: number | null
  durationMs?: number | null
  startedAt: string
  completedAt?: string | null
  status: "running" | "done" | "error"
  error?: string | null
}

export interface ArtifactPayload {
  kind?: "artifact"
  artifactId: string
}

export interface ViewAppPayload {
  kind?: "view-app"
  appId: string
}

export interface ViewAppBuilderPayload {
  kind?: "view-app-builder"
  appId?: string
  initialSql?: string
}

export interface ViewAppsPayload {
  kind?: "view-apps"
}

export interface SystemObjectsPayload {
  kind?: "system-objects"
  initialCategory?: SystemObjectCategory
}

export type SystemObjectCategory =
  | "tables"
  | "indexes"
  | "extensions"
  | "roles"
  | "settings"
  | "activity"
  | "locks"
  | "stats"

export interface ExtensionsPayload {
  kind?: "extensions"
}

export interface RvbbitCachePayload {
  kind?: "rvbbit-cache"
  initialView?: "receipts" | "embeddings" | "judgments" | "bitmaps" | "specialists"
}

export interface CostsPayload {
  kind?: "costs"
  /**
   * Optional cross-window deep-link state. When set, the costs window
   * opens with these filters already applied — e.g. a Query Lens trace
   * surfacing a "see this query's cost breakdown" link could open
   * Costs filtered to that query_id.
   */
  initialFilter?: {
    queryId?: string | null
    operator?: string | null
    backend?: string | null
    model?: string | null
    auditStatus?: string | null
  }
}

/** Duck/Vortex sidecar broker telemetry monitor. */
export interface DuckPayload {
  kind?: "duck"
}

export interface DataSearchPayload {
  kind?: "data-search"
  /** Optional starting query, e.g. when opened from a deep-link. */
  initialQuery?: string
}

export interface DriftPayload {
  kind?: "drift"
  /** Optional starting run pair (baseline A, current B). Defaults to latest two. */
  runA?: number
  runB?: number
}

export interface ModelStudioPayload {
  kind?: "model-studio"
  /** Optional model to select on open. */
  modelName?: string
}

export interface ConnectionsPayload {
  kind?: "connections"
}

export interface PalettePayload {
  kind?: "palette"
}

export interface PgMonitorPayload {
  kind?: "pg-monitor"
}

export interface NotificationsPayload {
  kind?: "notifications"
}

export interface OperatorsPayload {
  kind?: "operators"
}

export interface OperatorFlowPayload {
  kind?: "operator-flow"
  /** Operator name to open, or null for a brand-new unsaved operator. */
  operatorName: string | null
  /**
   * Optional receipt to deep-link to. When set, the window starts in
   * "run" mode with this receipt pre-selected — used by Query Lens
   * cross-links so clicking a receipt event lands you on that exact
   * trace, not just the operator's most recent run.
   */
  receiptId?: string | null
}

export interface SpecialistsPayload {
  kind?: "specialists"
}

export interface SpecialistDetailPayload {
  kind?: "specialist-detail"
  specialistName: string
}

export interface RoutingPayload {
  kind?: "routing"
}

export interface McpServersPayload {
  kind?: "mcp-servers"
}

export interface McpServerDetailPayload {
  kind?: "mcp-server-detail"
  serverName: string
}

export interface QueryLensPayload {
  kind?: "query-lens"
  /** Optional starting query_id; window resolves to its trace on mount. */
  queryId?: string | null
}

/**
 * Where a KG window was opened *from*. Surfaces a "← from X" breadcrumb
 * chip and a click target to return to the source. The label is what's
 * rendered in the chip; the discriminator drives the back-action.
 */
export type KgEntitySource =
  | { kind: "lens"; queryId: string; label: string }
  | { kind: "browser"; graphId: string; label: string }
  | {
      kind: "kg-entity"
      label: string
      /** Full back-target so clicking the chip refocuses that entity. */
      graphId: string
      entityKind: string
      entityLabel: string
      nodeId: number | null
    }

export interface KgBrowserPayload {
  kind?: "kg-browser"
  /** Optional starting graph_id. If unset, the window picks the most active graph. */
  graphId?: string | null
}

export interface KgExtractionRunsPayload {
  kind?: "kg-extraction-runs"
  /** Optional starting graph filter. */
  graphId?: string | null
  /** Optional starting selected run. */
  runId?: number | null
}

export interface KgMergeReviewPayload {
  kind?: "kg-merge-review"
  graphId?: string | null
  /** Optional starting node-kind filter (e.g. "customer"). */
  nodeKindFilter?: string
}

export interface KgExplorerPayload {
  kind?: "kg-explorer"
  graphId?: string
  seedKind?: string | null
  seedLabel?: string | null
  depth?: number
  direction?: "out" | "in" | "both"
  maxEdges?: number
}

export interface CapabilitiesPayload {
  kind?: "capabilities"
  /** Optional starting filter — pre-checks the matching tag chip. */
  tagFilter?: string | null
}

export interface CapabilityDetailPayload {
  kind?: "capability-detail"
  /** Catalog entry id (e.g. `extract/gliner-medium-v2.1.yaml`). */
  catalogId: string
  /** Optional starting tab. */
  initialTab?: "overview" | "generated-sql" | "probe" | "install" | "tests"
}

export interface WarrenPayload {
  kind?: "warren"
  /** Optional starting tab. */
  initialTab?: "inventory" | "jobs" | "runtimes"
  /** Optional pre-applied label filter for inventory (selector-style match). */
  labelFilter?: Record<string, unknown>
}

export interface WarrenJobDetailPayload {
  kind?: "warren-job-detail"
  jobId: string
  /** Pretty title when known so the window chrome doesn't say "loading…". */
  jobName?: string | null
}

export interface KgEntityDetailPayload {
  kind?: "kg-entity-detail"
  /**
   * Preferred direct identifier. When set, the window loads by node_id
   * without resolving (entityKind, entityLabel) — useful for Lens
   * cross-links which carry node ids directly.
   */
  nodeId?: number | null
  /** Fallback resolution path when nodeId is unknown to the opener. */
  entityKind?: string
  entityLabel?: string
  graphId: string
  source?: KgEntitySource
}

export interface DesktopCanvasState {
  windows: DesktopWindowState[]
  zSeed: number
  viewport: DesktopViewportState
}

/** One of five independent desktops. */
export type WorkspaceId = "1" | "2" | "3" | "4" | "5"

/**
 * A single workspace's full canvas. All five are kept mounted at once
 * (parked off-screen when inactive) so switching preserves window
 * state — data results, SQL drafts, scroll positions — and the slide
 * animation has real windows to move rather than loading spinners.
 */
export interface WorkspaceCanvas {
  windows: DesktopWindowState[]
  zSeed: number
  params: DesktopParamValue[]
  focusedWindowId: string | null
}

export interface DesktopSavedState {
  version: 2
  activeWorkspace: WorkspaceId
  workspaces: Record<WorkspaceId, WorkspaceCanvas>
  viewport: DesktopViewportState
  activeConnectionId?: string | null
  updatedAt?: string
}

/** Legacy v1 shape — kept only so loadDesktopState can migrate it. */
export interface DesktopSavedStateV1 {
  version: 1
  windows: DesktopWindowState[]
  zSeed: number
  viewport: DesktopViewportState
  params?: DesktopParamValue[]
  activeConnectionId?: string | null
  updatedAt?: string
}

/**
 * Saved "view app" — a SQL statement promoted to a desktop icon with
 * a custom icon glyph + color. Stored in localStorage for v0.
 */
export interface ViewApp {
  id: string
  name: string
  description?: string
  sql: string
  iconKey: string
  iconColor: string
  connectionId?: string | null
  /** Optional Vega-Lite spec to render the result. */
  chartSpec?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface DesktopArtifact {
  id: string
  title: string
  kind: "vega-lite" | "plotly" | "json" | "table"
  sourceSql?: string
  specJson?: Record<string, unknown> | null
  specText?: string | null
  connectionId?: string | null
  createdAt: string
  updatedAt: string
}

// Re-exports so windows can import freely from this barrel.
export type { ExtensionInfo, QueryResultColumn, SchemaColumn, SchemaTable }

/** Column drag payload for the canvas. */
export type DesktopColumnRole = "dimension" | "metric"

export interface DesktopColumnRef {
  name: string
  type?: string
  dataTypeId?: number
  role: DesktopColumnRole
}

export interface DesktopColumnDragPayload {
  kind: "rvbbit-lens.desktop.column"
  parentWindowId: string
  parentBlockName: string
  parentTitle: string
  parentSql: string
  relationKey: string
  columns: DesktopColumnRef[]
}
