/**
 * Public types for the rvbbit-lens connection layer.
 *
 * Connections are stored in a single JSON file at
 * `~/.config/rvbbit-lens/connections.json` (or `$RVBBIT_LENS_HOME` if
 * set). One process, one user, one file — no multi-tenant indirection.
 */

export type SslMode = "disable" | "prefer" | "require" | "no-verify"

export interface ConnectionRecord {
  id: string
  /** Display name shown in the UI. */
  label: string
  host: string
  port: number
  database: string
  user: string
  /** Stored in plaintext in the local config file. The whole file is
   * a user-owned secret — same trust model as ~/.pgpass. */
  password?: string
  sslMode?: SslMode
  /** Optional connection string overrides everything else when set. */
  connectionString?: string
  /** True if the user has marked this as the default connection. */
  isDefault?: boolean
  // ── SSH tunnel (bastion) ──────────────────────────────────────────────
  // When enabled, the DB connection is forwarded through an SSH server. host/
  // port above are then resolved *from the SSH host* (exactly like the host:port
  // you'd put after `ssh -L`). Only valid in host/port mode (not connectionString).
  /** Master switch — tunnel only engages when this is true AND sshHost is set. */
  sshEnabled?: boolean
  sshHost?: string
  sshPort?: number
  sshUser?: string
  /** Path to a private key file on the machine running lens (e.g. ~/key.pem). */
  sshKeyPath?: string
  /** Pasted private-key contents (PEM). Secret — stripped by sanitize(). */
  sshPrivateKey?: string
  /** Passphrase for the private key. Secret. */
  sshPassphrase?: string
  /** Password auth (alternative to a key). Secret. */
  sshPassword?: string
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  id?: string
  label: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  sslMode?: SslMode
  connectionString?: string
  isDefault?: boolean
  sshEnabled?: boolean
  sshHost?: string
  sshPort?: number
  sshUser?: string
  sshKeyPath?: string
  sshPrivateKey?: string
  sshPassphrase?: string
  sshPassword?: string
}

export interface ConnectionTestResult {
  ok: boolean
  serverVersion?: string
  database?: string
  hasRvbbit?: boolean
  rvbbitVersion?: string | null
  schemaCount?: number
  tableCount?: number
  durationMs: number
  error?: string
}

export interface RvbbitStatus {
  connectionId: string
  hasRvbbit: boolean
  rvbbitVersion: string | null
  durationMs: number
}

export interface QueryResultColumn {
  name: string
  dataTypeId: number
  dataTypeName?: string
}

export interface QueryResult {
  sql: string
  connectionId: string
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  /** Time spent waiting for a pooled DB connection before the query began. */
  queueWaitMs?: number
  durationMs: number
  command?: string
  warning?: string
  /**
   * One entry per top-level statement when the block ran MORE THAN ONE statement
   * (else absent — the single-statement path is unchanged). The top-level
   * columns/rows/command above stay the "primary" (last result with rows) for
   * back-compat (cross-block refs, single-grid render); `results` is what the
   * multi-statement transcript renders so nothing gets swallowed.
   */
  results?: StatementResult[]
}

/** A single statement's result inside a multi-statement run (the transcript). */
export interface StatementResult {
  /** 0-based position among the run's statements. */
  index: number
  /** The statement text, when statements split 1:1 with results (else absent). */
  sql?: string
  command?: string
  columns: QueryResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
}

export interface QueryError {
  ok: false
  error: string
  code?: string
  position?: number | null
  detail?: string
  hint?: string
}

export interface SchemaColumn {
  name: string
  dataType: string
  udtName: string
  typeOid: number
  nullable: boolean
  default: string | null
  ordinal: number
  comment: string | null
  isPrimaryKey?: boolean
}

export interface SchemaTable {
  schema: string
  name: string
  /** pg_class oid — the join key for the instrument-stats batch. */
  oid?: number
  kind: "table" | "view" | "matview" | "foreign" | "partition" | "other"
  rowEstimate: number | null
  sizeBytes: number | null
  comment: string | null
  columns: SchemaColumn[]
  /** true iff the table's access method is rvbbit (pg_class.relam), NOT a schema-name guess. */
  isRvbbit?: boolean

  // ── Finder "instrument panel" fields (all optional; absent ⇒ render neutral) ──
  /** resolved real row count: crawl count(*) → rvbbit parquet rows → reltuples; never -1. */
  rows?: number | null
  rowsSource?: "live" | "crawl" | "estimate" | null
  /** ISO timestamp the crawl row count was taken (qualifies a "crawl" rows count). */
  profiledAt?: string | null
  colCount?: number
  // rvbbit-accelerated only:
  parquetRows?: number | null
  parquetBytes?: number | null
  rgCount?: number | null
  coldCount?: number | null
  // ── per-tier on-disk footprint (storage-breakdown tooltip) ──
  // heapBytes + hotParquetBytes + coldBytes + indexBytes + toastBytes are
  // physically disjoint and sum to the table's footprint. vortexBytes/variantBytes
  // are REDUNDANT accelerator copies — shown separately, never added to the total.
  heapBytes?: number | null
  hotParquetBytes?: number | null
  coldBytes?: number | null
  indexBytes?: number | null
  toastBytes?: number | null
  vortexBytes?: number | null
  variantBytes?: number | null
  freshness?: "fresh" | "stale" | "na"
  generation?: number | null
  lastCompactAt?: string | null
  lanceEnabled?: boolean
  /** distinct queries that touched this table in the last 7d (usage heat). */
  heat?: number | null
  /** max drift severity (0–1) vs the previous crawl; null ⇒ no prior run / no change. */
  driftSeverity?: number | null
  /** drift signal names, e.g. ["rows_up","null_spike","type_change"]. */
  driftFlags?: string[] | null
  driftChangeType?: string | null
}

/** A callable routine (function / aggregate / procedure) in a user schema —
 *  powers function-name autocomplete (esp. the rvbbit semantic functions). */
export interface SchemaFunction {
  schema: string
  name: string
  /** pretty parameter list, e.g. "intent text, operator text DEFAULT 'synth'". */
  args: string
  /** pretty return type, e.g. "text", "SETOF text", "TABLE(...)". */
  result: string
  comment: string | null
  kind: "function" | "aggregate" | "window" | "procedure"
  /** ordered INPUT argument names (excludes OUT / TABLE-result columns). */
  argNames: string[]
  /** count of leading input args without a default — the required arity. */
  requiredCount: number
  /** rvbbit operator shape when this fn is a registered semantic operator
   *  (scalar | aggregate | dimension | rowset); null otherwise. */
  shape?: string | null
}

export interface SchemaSnapshot {
  connectionId: string
  generatedAt: string
  databases: string[]
  currentDatabase: string
  schemas: string[]
  tables: SchemaTable[]
  /** callable routines in user schemas (internal `_`-prefixed ones excluded). */
  functions: SchemaFunction[]
  extensions: ExtensionInfo[]
  hasRvbbit: boolean
  rvbbitVersion: string | null
}

export interface ExtensionInfo {
  name: string
  schema: string
  version: string
  description: string | null
}
