import type { ExtensionInfo, QueryResultColumn, SchemaColumn, SchemaTable } from "@/lib/db/types"
import type { DataSearchHit } from "@/lib/rvbbit/data-search"
import type { OpStep, RetryPlan, TakesPlan, WardsPlan } from "@/lib/rvbbit/operators"
import type { ActivityRow, PgStatementCatalogRow } from "@/lib/db/pg-stats"
import type { HtmlBlockSpec } from "./app-block"

export type DesktopWindowKind =
  | "finder"
  | "data"
  | "data-mover"
  | "dashboards"
  | "apps"
  | "dashboard-app"
  | "csv-import"
  | "query-document"
  | "row-inspector"
  | "artifact"
  | "view-app"
  | "view-app-builder"
  | "view-apps"
  | "system-objects"
  | "extensions"
  | "rvbbit-cache"
  | "cache"
  | "connections"
  | "palette"
  | "appearance"
  | "pg-monitor"
  | "system-health"
  | "plate"
  | "plates"
  | "fitting"
  | "scenes"
  | "pg-query-explorer"
  | "pg-query-inspector"
  | "lock-explorer"
  | "mvcc-explorer"
  | "fleet"
  | "semantic-tests"
  | "postgres-admin"
  | "notifications"
  | "operators"
  | "model-settings"
  | "operator-flow"
  | "specialists"
  | "specialist-detail"
  | "system-learning"
  | "routing"
  | "mcp-servers"
  | "mcp-incoming"
  | "mcp-server-detail"
  | "query-lens"
  | "kg-browser"
  | "kg-entity-detail"
  | "kg-extraction-runs"
  | "kg-merge-review"
  | "kg-explorer"
  | "hindsight-memory"
  | "capabilities"
  | "capability-detail"
  | "warren"
  | "warren-job-detail"
  | "costs"
  | "sync-mirror"
  | "duck"
  | "data-search"
  | "scry-results"
  | "drift"
  | "model-studio"
  | "folder"
  | "hf-deploy"
  | "metric-catalog"
  | "metric-creator"
  | "metric-inspector"
  | "viz-blocks"
  | "cube-catalog"
  | "cube-creator"
  | "cube-inspector"
  | "cube-proposals"
  | "metric-board"
  | "alerts"
  | "dagster"
  | "brain"
  | "agent-messages"
  | "assistant"
  | "assistant-settings"

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
  | DataMoverPayload
  | DashboardsPayload
  | AppsPayload
  | DashboardAppPayload
  | BrainPayload
  | CsvImportPayload
  | QueryDocumentPayload
  | RowInspectorPayload
  | ArtifactPayload
  | ViewAppPayload
  | ViewAppBuilderPayload
  | ViewAppsPayload
  | SystemObjectsPayload
  | ExtensionsPayload
  | RvbbitCachePayload
  | CachePayload
  | ConnectionsPayload
  | PalettePayload
  | AppearancePayload
  | PgMonitorPayload
  | PlatePayload
  | PlatesPayload
  | FittingPayload
  | SystemHealthPayload
  | ScenesPayload
  | PgQueryExplorerPayload
  | PgQueryInspectorPayload
  | LockExplorerPayload
  | MvccExplorerPayload
  | FleetPayload
  | SemanticTestsPayload
  | PostgresAdminPayload
  | NotificationsPayload
  | OperatorsPayload
  | ModelSettingsPayload
  | OperatorFlowPayload
  | SpecialistsPayload
  | SpecialistDetailPayload
  | SystemLearningPayload
  | RoutingPayload
  | McpServersPayload
  | McpIncomingPayload
  | McpServerDetailPayload
  | QueryLensPayload
  | KgBrowserPayload
  | KgEntityDetailPayload
  | KgExtractionRunsPayload
  | KgMergeReviewPayload
  | KgExplorerPayload
  | HindsightMemoryPayload
  | CapabilitiesPayload
  | CapabilityDetailPayload
  | WarrenPayload
  | WarrenJobDetailPayload
  | CostsPayload
  | SyncMirrorPayload
  | DuckPayload
  | DataSearchPayload
  | ScryResultsPayload
  | DriftPayload
  | ModelStudioPayload
  | FolderPayload
  | HfDeployPayload
  | MetricCatalogPayload
  | MetricCreatorPayload
  | MetricInspectorPayload
  | VizBlocksPayload
  | CubeCatalogPayload
  | CubeCreatorPayload
  | CubeInspectorPayload
  | CubeProposalsPayload
  | MetricBoardPayload
  | AlertsPayload
  | DagsterPayload
  | AgentMessagesPayload
  | AssistantPayload
  | AssistantSettingsPayload

/** The desktop-level Assistant (archive + input). The conversation thread is
 *  deliberately NOT stored here — it lives in localStorage + homebase keyed by
 *  home, so scene restores and desktop resets never rewind the chat. */
export interface AssistantPayload {
  kind?: "assistant"
}

/** Assistant Settings — model, personality, voice. A normal canvas window. */
export interface AssistantSettingsPayload {
  kind?: "assistant-settings"
}

/** The Alerts cockpit — an observable view over rvbbit.alert_* (rules, state,
 *  queue, events, sweep heartbeats). `rule` is the selected rule name. */
export interface AlertsPayload {
  kind?: "alerts"
  rule?: string
}

/** Read-only Hindsight schema observer. Recall can call the registered service;
 *  the table and graph views only select from Hindsight's own schema. */
export interface HindsightMemoryPayload {
  kind?: "hindsight-memory"
  bankId?: string | null
  initialTab?: "overview" | "memories" | "recall" | "graph" | "ops"
}

/** Read-only Dagster instance observer, backed by any Dagster metadata tables
 *  present in the active Postgres database. */
export interface DagsterPayload {
  kind?: "dagster"
}

export interface FinderPayload {
  kind?: "finder"
  selectedSchema?: string
}

/**
 * CSV importer window. The dropped `File` itself lives in the transient
 * file-store (keyed by window id) since a File can't be serialized into a
 * persisted payload; only its descriptive metadata travels here so a
 * restored window can show which file it was (and prompt a re-drop).
 */
export interface CsvImportPayload {
  kind?: "csv-import"
  fileName: string
  fileSize: number
  lastModified?: number
  /** Schema pre-selected when the import was launched (defaults to "public"). */
  defaultSchema?: string
}

/** How a single statement's result renders in the multi-statement transcript. */
export type StatementViewKind = "table" | "bar" | "line" | "number"

/** One horizontal band of the Arrange tiling. `h` is a UNITLESS height weight
 *  across rows (row height = h / Σ rows.h). */
export interface ArrangeRow {
  h: number
  tiles: ArrangeTile[]
}
/** One tile in a row. `key` ∈ statementKeys(results) — the same identity space as
 *  statementViews. `w` is a UNITLESS width weight within its row (tile width =
 *  w / Σ row.tiles.w). */
export interface ArrangeTile {
  key: string
  w: number
}

export type ChartRendererKind = "vega-lite" | "flint-vega-lite" | "flint-echarts" | "flint-chartjs"

export interface ChartThemeOverrides {
  palette?: string[]
  colorMode?: "auto" | "series" | "category" | "single"
  colorDomain?: string[]
  colorRange?: string[]
  accent?: string
  background?: string
  foreground?: string
  axisColor?: string
  gridColor?: string
  numberFormat?: "auto" | "compact" | "currency" | "percent" | "integer"
  dateFormat?: "auto" | "short" | "month" | "day" | "time"
  grid?: boolean
  legend?: boolean
  legendPlacement?: "auto" | "right" | "bottom" | "left" | "top" | "hidden"
  legendDensity?: "normal" | "compact"
  labels?: boolean
  points?: boolean
  roundedBars?: boolean
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
   * Initial target database for this window's db-switcher (the per-window
   * `database` override). Used when a query must run against a sibling db on the
   * same server — e.g. pg_cron links target the cron home db (default 'postgres'),
   * not the connected working db, or the cron.* schema lookup fails.
   */
  database?: string
  /** Optional per-window connection override. Saved/published SQL views carry
   *  the connection they were authored against so reopening them does not depend
   *  on the currently selected desktop connection. */
  connectionId?: string | null
  /** Force this window to run once on open, including top-level THEN workflows.
   *  Ordinary editor-created THEN pipelines still require an explicit Run. */
  autoRun?: boolean
  /**
   * Per-statement view overrides for the multi-statement transcript, keyed by a
   * hash of the statement text (so an override follows its statement across
   * reorders and resets if rewritten). Sparse — only cards the user switched off
   * their default (table, or a 1×1 scalar's number) are stored.
   */
  statementViews?: Record<string, StatementViewKind>
  /**
   * Mini-dashboard arrangement for the multi-statement transcript — a tiling-WM
   * layout: rows top→bottom, tiles left→right within a row, every boundary
   * resizable, the block area always fully tiled (no gaps). Absent ⇒ the default
   * vertical transcript (unchanged). Tiles are keyed by the SAME statementKeys set
   * as statementViews, so a tile's slot + view kind travel and reset together. All
   * reconciliation is render-time against the live key set (stale entries ignored,
   * pruned on the next write); a missing `rows` auto-seeds one tile per statement.
   */
  statementLayout?: {
    /** Absent ⇒ "transcript". Only "arrange" diverges from today's behavior. */
    mode?: "transcript" | "arrange"
    /** Tiling rows, top→bottom. Absent ⇒ auto-seed (one tile per statement). */
    rows?: ArrangeRow[]
  }
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
  /** Renderer used by the Chart tab. The spec remains Vega-Lite-ish for authoring. */
  chartRenderer?: ChartRendererKind
  /** Per-chart presentation overrides layered over the active Lens theme. */
  chartTheme?: ChartThemeOverrides | null
  /**
   * Agent-authored HTML surface backed by named SQL queries. The HTML is the
   * primary artifact; `sql` stores the manifest's native multi-query body so the
   * block still participates in SQL Desktop execution, lineage, params, drag/drop,
   * scene save/restore, and Saved Views.
   */
  htmlBlock?: HtmlBlockSpec | null
  /**
   * How the "View" tab renders this block: a Vega chart (default) or an
   * interactive control that publishes a pick param. `controlField` is the
   * column the control reads its values from.
   */
  viewKind?: "chart" | "dropdown" | "multiselect" | "datepicker" | "slider"
  controlField?: string
  /**
   * For a rvbbit.synth() block whose single jsonb column the grid expands
   * client-side, the run-inferred shape of that jsonb — column names + inferred
   * types. The reactive graph uses this to wrap a reference to this block in a
   * typed "projection" so downstream SQL (drag-out rollups, block.<name> refs,
   * EXPLAIN) sees real columns instead of the opaque jsonb column. Undefined for
   * ordinary blocks and for bare-`then` pipelines (whose compiledSql is not valid
   * standalone SQL to project over). Updated on each run.
   */
  jsonbProjection?: JsonbProjectionColumn[]
}

/** Read-only inspector for one result row from a SQL block. */
export interface RowInspectorPayload {
  kind?: "row-inspector"
  sourceTitle: string
  rowIndex: number
  columns: QueryResultColumn[]
  row: Record<string, unknown>
  selectedColumn?: string | null
}

/** One expanded column of a jsonb-returning block. `kind` is the coarse class used
 * to classify the column (numeric metric vs dimension); `pgType`, when present, is
 * the AUTHORITATIVE Postgres type captured by the compiler (rvbbit.synth_schema) so
 * the projection casts exactly (`::bigint`, `::date`, …) instead of guessing from
 * sampled rows. Absent for flow blocks (which still infer from data). */
export interface JsonbProjectionColumn {
  name: string
  kind: "numeric" | "boolean" | "jsonb" | "text"
  pgType?: string
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

export type DesktopParamOperator = "eq" | "in" | "gte" | "lte"

export interface DesktopParamValue {
  key: string
  sourceWindowId: string
  sourceBlockName: string
  sourceTitle: string
  field: string
  operator?: DesktopParamOperator
  /** false ⇒ a "pick" param: published to the shelf, but the compiler does NOT
   *  synthesize a self-subscription, so the source block is NOT narrowed and
   *  nothing cascades — the user binds it explicitly by dragging it onto a
   *  target. Defaults to true (the click-to-filter cascade). */
  cascade?: boolean
  value: unknown
  dataTypeId?: number
  type?: string
  /** When true, the compiler auto-applies this param to EVERY block that safely
   *  references its source table (Tier-2 broadcast) — not just the source/explicit
   *  subscribers. OFF by default; needs sourceTable/sourceColumn (pg provenance). */
  broadcast?: boolean
  /** The clicked value's REAL source table+column (pg field tableID/columnID),
   *  so broadcast can target the right table. Absent for expression columns. */
  sourceSchema?: string
  sourceTable?: string
  sourceColumn?: string
  updatedAt: string
}

/** Where a param's predicate is applied to the subscribing block. */
export type ParamTarget =
  | { kind: "query" }
  // Push the predicate into the block's single FROM-item, resolved at compile
  // time — works for a base table OR a {ref} that has been inlined to a subquery
  // (so a chart over `FROM {core}` filters on a column of `core`, not its output).
  | { kind: "from-item" }
  // Legacy (pre-"from-item"): a frozen base-table relation. Still honored by the
  // compiler, which now ignores the relation and re-locates the live FROM-item.
  | { kind: "table"; relation: string; alias?: string }

export interface DesktopParamSubscription {
  key: string
  targetField: string
  /** "query" (default) wraps the whole result in `SELECT * FROM (…) WHERE`;
   *  "from-item"/"table" push the predicate INTO the block's single FROM-item
   *  (surgical — filters before aggregation, so the field need not be in the
   *  output; works through an inlined {ref} subquery). */
  target?: ParamTarget
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
  /**
   * Row-level semantic projections (rvbbit scalar operators). Unlike
   * measures/group-bys these are NOT aggregated — each adds a derived
   * column `rvbbit.<op>(<col>::text[, args]) AS alias`. A spec with
   * projections and no groupBy/measures is a pure projection block.
   */
  projections?: SemanticProjection[]
}

/** Coarse role of a semantic operator — drives where it lives in the drop
 *  overlay's shape bands and how a drop is interpreted:
 *  scalar→per-row projection, aggregate→measure, dimension→group-by,
 *  rowset/query→whole-result transform. */
export type SemanticOpShape = "scalar" | "aggregate" | "dimension" | "rowset" | "query"

/** A semantic operator (rvbbit.operators row) as the drop UI needs it. */
export interface SemanticOpMeta {
  name: string
  shape: SemanticOpShape
  argNames: string[]
  argTypes: string[]
  returnType: "bool" | "text" | "float8" | "jsonb"
  description?: string
  model?: string
  systemPrompt?: string
  userPrompt?: string
  parser?: string
  maxTokens?: number
  temperature?: number | null
  steps?: OpStep[] | null
  retry?: RetryPlan | null
  wards?: WardsPlan | null
  takes?: TakesPlan | null
}

/**
 * A bound extra argument for a multi-arg semantic op (everything past the
 * dragged column). Either a typed literal (`'positive,negative'`) or a
 * reference to another column in the same relation (`rvbbit.contradicts(a, b)`
 * where both are columns).
 */
export type SemanticArg =
  | { kind: "literal"; value: string }
  | { kind: "column"; column: string }

/** One materialized semantic projection in a {@link RollupSpec}. */
export interface SemanticProjection {
  /** Stable identity (`<operator>:<column>[:<args>]`) — dedupe key. */
  id: string
  column: DesktopColumnRef
  operator: string
  returnType: SemanticOpMeta["returnType"]
  /** Bound extra args (literal or column ref) for multi-arg ops; absent for 1-arg ops. */
  args?: SemanticArg[]
  /** SELECT alias, unique within the spec. */
  alias: string
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
  // Apply a scalar semantic operator to the dragged column as a row-level
  // projection (spawns a projection block). `args` are the bound extra args
  // (literal or column ref) for multi-arg ops (absent for 1-arg ops).
  | { kind: "semantic-op"; operator: SemanticOpMeta; args?: SemanticArg[] }

export interface DataWindowViewState {
  activeTab?: "rows" | "profile" | "chart" | "sql" | "explain" | "steps" | "app"
  rowsTransposed?: boolean
  sqlRailOpen?: boolean
  sqlRailWidthPx?: number
  sqlDraft?: string
  autoRunIntervalMs?: number | null
  /** Editor input mode: SQL, one-shot SQL Ask, or chat-authored HTML Block. */
  queryMode?: "sql" | "ask" | "app"
  /** The natural-language question, kept so toggling back to Ask restores it. */
  askDraft?: string
  /** Current chat draft for HTML Block mode. HTML itself is edited only by turns. */
  appDraft?: string
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
  initialName?: string
  initialChartSpec?: Record<string, unknown> | null
  initialStatementViews?: Record<string, StatementViewKind>
  initialStatementLayout?: DataPayload["statementLayout"]
  initialViewKind?: DataPayload["viewKind"]
  initialControlField?: string
  initialHtmlBlock?: HtmlBlockSpec | null
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
  | "foreign-keys"
  | "triggers"
  | "sequences"
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

export interface CachePayload {
  kind?: "cache"
  /** Which cache surface to open on: the synth-sql compiler cache or the
   * content-addressed operator result (memo) cache. */
  initialView?: "synth" | "memo"
}

export interface SyncMirrorPayload {
  kind?: "sync-mirror"
}

export interface DataMoverPayload {
  kind?: "data-mover"
}

export interface DashboardsPayload {
  kind?: "dashboards"
  selectedSlug?: string | null
}

export interface AppsPayload {
  kind?: "apps"
}

/** A single published live app, standalone — its own window on the canvas. */
export interface DashboardAppPayload {
  kind?: "dashboard-app"
  slug: string
  name?: string
}

export interface BrainPayload {
  kind?: "brain"
  viewAs?: string | null
  selectedFolder?: string | null
  selectedDocId?: number | null
}

/** The agent Messages app — a viewer over rvbbit.agent_messages, runs rolled
 *  up by run_id (one agent-operator call), drill into the per-turn transcript.
 *  `initialRunId` deep-links straight to a run; `operator` pre-filters. */
export interface AgentMessagesPayload {
  kind?: "agent-messages"
  initialRunId?: string | null
  operator?: string | null
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

/** One step of a Scry cascade ("find X … within those, find Y …"). */
export interface ScryChainStep {
  query: string
}

/** A spawned Scry results window: the cascade that made it + the hits. */
export interface ScryResultsPayload {
  kind?: "scry-results"
  chain: ScryChainStep[]
  hits: DataSearchHit[]
  connectionId: string | null
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

/** Metrics / BI apps. A metric is a named, versioned SQL template in
 *  rvbbit.metric_defs; the Catalog browses them, the Creator authors/versions
 *  them, the Inspector runs them across the def-time + data-time axes. */
export interface MetricCatalogPayload {
  kind?: "metric-catalog"
}
export interface MetricCreatorPayload {
  kind?: "metric-creator"
  /** Optional metric to load for editing on open. */
  metricName?: string | null
}
export interface MetricInspectorPayload {
  kind?: "metric-inspector"
  /** Optional metric to select on open. */
  metricName?: string | null
}
export interface VizBlocksPayload {
  kind?: "viz-blocks"
  /** Optional canonical block to load for editing on open. */
  blockName?: string | null
}
/** Cube Studio — the curated subject-area tables (metrics→cubes→raw). Catalog
 *  browses them, Creator authors them (Manual/Propose/From-Pack), Inspector
 *  grounds one (columns/health/lineage). */
export interface CubeCatalogPayload {
  kind?: "cube-catalog"
}
export interface CubeCreatorPayload {
  kind?: "cube-creator"
  /** Optional cube to load for editing on open. */
  cubeName?: string | null
}
export interface CubeInspectorPayload {
  kind?: "cube-inspector"
  /** Optional cube to select on open. */
  cubeName?: string | null
}
/** Cube Proposals — the review inbox for agent-drafted cubes (rvbbit.proposals). */
export interface CubeProposalsPayload {
  kind?: "cube-proposals"
}
export interface MetricBoardPayload {
  kind?: "metric-board"
  /** Persisted time-range selection (index into the board's RANGES). */
  rangeIdx?: number
  /** "value" (stored/def-scrub) or "restate" (reported-vs-recomputed). */
  mode?: "value" | "restate"
  /** Definition-time scrub (YYYY-MM-DD); empty = current definition. */
  defDate?: string
  /** Show every materialization as its own column (no date_trunc rollup). */
  showAll?: boolean
  /** Include non-KPI metrics in the board. Defaults to false for the KPI Board. */
  includeMetrics?: boolean
}

/**
 * A "folder" window — a file-explorer-style grouping of desktop launchers
 * (and, later, saved queries / arranged items). `folderId` selects which
 * group's items to show; the shell resolves it against its launcher registry.
 */
export interface FolderPayload {
  kind?: "folder"
  folderId: string
}

export interface ConnectionsPayload {
  kind?: "connections"
}

export interface PalettePayload {
  kind?: "palette"
}

export interface AppearancePayload {
  kind?: "appearance"
}

export interface PgMonitorPayload {
  kind?: "pg-monitor"
}

export interface PlatePayload {
  kind?: "plate"
  /** rvbbit.plates row to render. */
  plateId: string
}

export interface PlatesPayload {
  kind?: "plates"
}

export interface FittingPayload {
  kind?: "fitting"
  /** Preselect this kit's targets (rv-open="app:fitting?kit=..."). */
  kit?: string
}

export interface SystemHealthPayload {
  kind?: "system-health"
}

export interface ScenesPayload {
  kind?: "scenes"
}

export interface PgQueryExplorerPayload {
  kind?: "pg-query-explorer"
}

/** Persistent detail opened from either pg_stat_activity or the historical
 * pg_stat_statements catalog. Old saved live payloads omit `source`. */
interface PgQueryInspectorPayloadBase {
  kind?: "pg-query-inspector"
  connectionId: string
  capturedAt: string
}

export type PgQueryInspectorPayload = PgQueryInspectorPayloadBase & (
  | { source?: "live"; activity: ActivityRow; statement?: never }
  | { source: "historical"; statement: PgStatementCatalogRow; activity?: never }
)

export interface LockExplorerPayload {
  kind?: "lock-explorer"
}

export interface MvccExplorerPayload {
  kind?: "mvcc-explorer"
  view?: "horizon" | "tables" | "workers"
  tableSearch?: string
}

export interface FleetPayload {
  kind?: "fleet"
}

export interface SemanticTestsPayload {
  kind?: "semantic-tests"
}

export interface PostgresAdminPayload {
  kind?: "postgres-admin"
  initialTab?: "overview" | "activity" | "indexes" | "permissions" | "objects" | "backup"
}

export interface NotificationsPayload {
  kind?: "notifications"
}

export interface OperatorsPayload {
  kind?: "operators"
}

export interface ModelSettingsPayload {
  kind?: "model-settings"
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

export interface SystemLearningPayload {
  kind?: "system-learning"
}

export interface RoutingPayload {
  kind?: "routing"
}

export interface McpServersPayload {
  kind?: "mcp-servers"
}

export interface McpIncomingPayload {
  kind?: "mcp-incoming"
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

export interface HfDeployPayload {
  kind?: "hf-deploy"
  /** Optional model id to inspect immediately on open. */
  modelId?: string | null
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

/** One of five independent scratch desktops. */
export type WorkspaceId = "1" | "2" | "3" | "4" | "5"

/**
 * A sixth, special slot dedicated to a loaded Scene (a saved desktop).
 * It renders like the numbered canvases but carries document identity
 * (which Scene is open, plus a dirty bit). Keeping it separate means
 * loading a Scene never clobbers a numbered scratch desktop — the open
 * Scene is the only canvas that is ever a "document".
 */
export type SceneSlotId = "scene"

/** Any addressable canvas slot: a numbered scratch desktop or the Scene slot. */
export type SlotId = WorkspaceId | SceneSlotId

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
  activeWorkspace: SlotId
  workspaces: Record<SlotId, WorkspaceCanvas>
  viewport: DesktopViewportState
  activeConnectionId?: string | null
  /** Which saved Scene is open in the Scene slot (null = none / unsaved). */
  currentSceneId?: string | null
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

// ── Scenes (saved desktops) ─────────────────────────────────────────
//
// A Scene freezes ONE desktop canvas (Option B: per-desktop, not the
// whole five-workspace session) under a name, restored into the
// dedicated Scene slot. `schemaVersion` is the FIRST field so the reader
// can branch on it — closing the gap that the version-less view-apps
// blob never had.

export const SCENE_SCHEMA_VERSION = 1 as const

/**
 * Re-link hint for when `connectionId` is dangling on this machine.
 * host/port/database/user only — never the password (secrets stay in the
 * server-side connections registry).
 */
export interface SceneConnectionFingerprint {
  connectionId: string | null
  label?: string
  host?: string
  port?: number
  database?: string
  user?: string
}

/**
 * Copies of side-store records the captured windows reference by id, so a
 * restored view-app / artifact window resolves instead of dangling.
 */
export interface SceneBundle {
  viewApps?: ViewApp[]
  artifacts?: DesktopArtifact[]
}

export interface Scene {
  schemaVersion: typeof SCENE_SCHEMA_VERSION
  id: string
  name: string
  description?: string
  /** The frozen desktop: windows + params + zSeed. */
  body: WorkspaceCanvas
  viewport?: DesktopViewportState
  connection?: SceneConnectionFingerprint
  bundle?: SceneBundle
  /** Hash of `body` — drives the dirty dot on the open Scene. */
  contentHash: string
  windowCount: number
  /** webp data URL of the window-layout mini-map, generated on save. */
  thumbnail?: string
  /** webp data URL of a real DOM capture of the desktop at save time.
   *  Best-effort: cross-origin iframe content comes out blank and capture can
   *  fail outright — the geometry `thumbnail` is the always-works fallback. */
  snapshot?: string
  /** Sharing: 'shared' scenes appear in other homes' Scene Library. Client-
   *  tracked and carried to the server shadow (default 'private'). */
  visibility?: "private" | "shared"
  createdAt: string
  updatedAt: string
}

export interface SceneStoreV1 {
  schemaVersion: typeof SCENE_SCHEMA_VERSION
  scenes: Scene[]
}

/**
 * Saved "view app" — a SQL statement promoted to a desktop icon with
 * a custom icon glyph + color. Stored in localStorage for v0.
 */
/** A saved Scry exploration — the restorable state of the graph explorer.
 *  Layout isn't persisted (the force sim re-derives it). */
export interface ScryViewState {
  graphId: string
  /** the cascade stage queries, top → bottom */
  queries: string[]
  /** enabled object types (null = all on) */
  enabledTypes: string[] | null
  colorMode: "stage" | "type"
}

/** A Saved View. `kind:"query"` (default, back-compat) is a SQL view rendered as
 *  rows/chart; `kind:"scry"` reopens the graph explorer from `scry`. */
export interface ViewApp {
  id: string
  name: string
  description?: string
  kind?: "query" | "scry" | "html-block"
  sql: string
  iconKey: string
  iconColor: string
  connectionId?: string | null
  /** Optional Vega-Lite spec to render the result (query views). */
  chartSpec?: Record<string, unknown> | null
  /** Optional SQL-window render state captured from the authoring surface. */
  statementViews?: Record<string, StatementViewKind>
  statementLayout?: DataPayload["statementLayout"]
  viewKind?: DataPayload["viewKind"]
  controlField?: string
  htmlBlock?: HtmlBlockSpec | null
  /** Saved Scry exploration (scry views). */
  scry?: ScryViewState | null
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
  /** All columns of the source relation — lets a multi-arg semantic-op bind
   *  step offer sibling columns (e.g. contradicts(a, b) with both as columns). */
  sourceColumns?: DesktopColumnRef[]
}
