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
  durationMs: number
  command?: string
  warning?: string
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
  kind: "table" | "view" | "matview" | "foreign" | "partition" | "other"
  rowEstimate: number | null
  sizeBytes: number | null
  comment: string | null
  columns: SchemaColumn[]
  isRvbbit?: boolean
}

export interface SchemaSnapshot {
  connectionId: string
  generatedAt: string
  databases: string[]
  currentDatabase: string
  schemas: string[]
  tables: SchemaTable[]
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
