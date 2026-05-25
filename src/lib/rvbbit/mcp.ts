"use client"

/**
 * Client-side model for rvbbit's MCP (Model Context Protocol) layer —
 * external tool/resource servers exposed as first-class SQL objects.
 *
 * Surfaces (see rvbbit docs/MCP.md):
 *   - mcp_servers       (table)  registry of servers
 *   - mcp_tools         (table)  discovered tools per server
 *   - mcp_resources     (table)  discovered resources per server
 *   - mcp_invocations   (table)  per-call audit log
 *   - mcp_cache         (table)  opted-in tool result cache
 *   - mcp_usage         (view)   per-(server, tool) usage rollup
 *   - mcp_health        (view)   passive per-server status snapshot
 *
 * Functions: register_mcp_server, drop_mcp_server, refresh_mcp_server,
 *   set_mcp_tool_caching, purge_mcp_cache, generate_mcp_wrappers,
 *   mcp_call, mcp_probe, mcp_resource, mcp_resource_text, mcp_rows, mcp_text.
 */

// ── Types ───────────────────────────────────────────────────────────

export type Transport = "stdio" | "http"

export interface McpServer {
  name: string
  transport: Transport
  command: string | null
  args: string[] | null
  env: Record<string, string> | null
  url: string | null
  authHeaderEnv: string | null
  timeoutMs: number
  description: string | null
  createdAt: string
}

export interface McpServerOverview extends McpServer {
  // joined from mcp_health
  nTools: number
  nResources: number
  lastDiscoveredAt: string | null
  lastCallAt: string | null
  lastErrorAt: string | null
  // joined from mcp_usage
  totalCalls: number
  totalErrors: number
}

export interface McpTool {
  server: string
  name: string
  description: string | null
  inputSchema: JsonSchema | null
  cacheable: boolean
  ttlSeconds: number | null
  discoveredAt: string | null
  // joined from mcp_usage (nullable when never called)
  nCalls: number
  nErrors: number
  avgLatencyMs: number
  p95LatencyMs: number
  lastCallAt: string | null
  nCached: number
}

export interface McpResource {
  server: string
  uri: string
  name: string | null
  description: string | null
  mimeType: string | null
  discoveredAt: string | null
}

export interface McpInvocation {
  id: number
  server: string
  tool: string
  args: unknown
  output: unknown
  error: string | null
  latencyMs: number
  cacheHit: boolean
  queryId: string | null
  invocationAt: number
}

export interface McpUsageRow {
  server: string
  tool: string
  nCalls: number
  nErrors: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  firstCallAt: string | null
  lastCallAt: string | null
}

export interface McpCacheEntry {
  server: string
  tool: string
  argsHash: string
  args: unknown
  cachedAt: string
  ttlSeconds: number | null
  expired: boolean
  outputBytes: number
}

export interface McpProbe {
  reachable: boolean
  latencyMs: number | null
  nTools: number | null
  error: string | null
}

export interface McpEnvelope {
  isError: boolean
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; uri: string; text?: string; mimeType?: string }
  >
}

/** JSON Schema as used by mcp_tools.input_schema. */
export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchema
  default?: unknown
  format?: string
}

/** A summary of activity against servers no longer registered. */
export interface GhostServerRow {
  server: string
  nCalls: number
  nErrors: number
  lastCallAt: string | null
}

// ── Query plumbing ──────────────────────────────────────────────────

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(connectionId: string, sql: string): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 5000 }),
    })
    return (await res.json()) as QueryOk | QueryErr
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function bool(v: unknown): boolean {
  return v === true || v === "t"
}
function epoch(v: unknown): number {
  return v ? new Date(String(v)).getTime() : 0
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function sqlTextArrayOrNull(arr: string[] | null | undefined): string {
  if (!arr || arr.length === 0) return "NULL"
  return `ARRAY[${arr.map(sqlStr).join(", ")}]::text[]`
}
function sqlJsonbOrNull(obj: unknown): string {
  if (obj == null) return "NULL"
  return `${sqlStr(JSON.stringify(obj))}::jsonb`
}
function sqlIntOrNull(n: number | null | undefined): string {
  return n == null ? "NULL" : String(Math.round(n))
}

// ── Read ────────────────────────────────────────────────────────────

export async function fetchServers(
  connectionId: string,
): Promise<{ rows: McpServerOverview[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT s.name, s.transport, s.command, s.args, s.env, s.url, s.auth_header_env, ` +
      `s.timeout_ms, s.description, s.created_at, ` +
      `h.n_tools, h.n_resources, h.last_discovered_at, h.last_call_at, h.last_error_at, ` +
      `COALESCE((SELECT sum(u.n_calls) FROM rvbbit.mcp_usage u WHERE u.server = s.name), 0) AS total_calls, ` +
      `COALESCE((SELECT sum(u.n_errors) FROM rvbbit.mcp_usage u WHERE u.server = s.name), 0) AS total_errors ` +
      `FROM rvbbit.mcp_servers s LEFT JOIN rvbbit.mcp_health h ON h.name = s.name ORDER BY s.name`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      name: String(r.name ?? ""),
      transport: (r.transport === "http" ? "http" : "stdio") as Transport,
      command: strOrNull(r.command),
      args: Array.isArray(r.args) ? (r.args as string[]) : null,
      env: (r.env as Record<string, string> | null) ?? null,
      url: strOrNull(r.url),
      authHeaderEnv: strOrNull(r.auth_header_env),
      timeoutMs: num(r.timeout_ms),
      description: strOrNull(r.description),
      createdAt: String(r.created_at ?? ""),
      nTools: num(r.n_tools),
      nResources: num(r.n_resources),
      lastDiscoveredAt: strOrNull(r.last_discovered_at),
      lastCallAt: strOrNull(r.last_call_at),
      lastErrorAt: strOrNull(r.last_error_at),
      totalCalls: num(r.total_calls),
      totalErrors: num(r.total_errors),
    })),
  }
}

export async function fetchInvocations(
  connectionId: string,
  opts: { server?: string; tool?: string; limit?: number } = {},
): Promise<{ rows: McpInvocation[]; error?: string }> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200))
  const where: string[] = []
  if (opts.server) where.push(`server = ${sqlStr(opts.server)}`)
  if (opts.tool) where.push(`tool = ${sqlStr(opts.tool)}`)
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const res = await runQuery(
    connectionId,
    `SELECT id, server, tool, args, output, error, latency_ms, cache_hit, query_id, invocation_at ` +
      `FROM rvbbit.mcp_invocations ${whereSql} ORDER BY invocation_at DESC LIMIT ${limit}`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      id: num(r.id),
      server: String(r.server ?? ""),
      tool: String(r.tool ?? ""),
      args: r.args ?? null,
      output: r.output ?? null,
      error: strOrNull(r.error),
      latencyMs: num(r.latency_ms),
      cacheHit: bool(r.cache_hit),
      queryId: strOrNull(r.query_id),
      invocationAt: epoch(r.invocation_at),
    })),
  }
}

export async function fetchTools(
  connectionId: string,
  server: string,
): Promise<{ rows: McpTool[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT t.name, t.description, t.input_schema, t.cacheable, t.ttl_seconds, t.discovered_at, ` +
      `u.n_calls, u.n_errors, u.avg_latency_ms, u.p95_latency_ms, u.last_call_at, ` +
      `(SELECT count(*) FROM rvbbit.mcp_cache c WHERE c.server = t.server AND c.tool = t.name) AS n_cached ` +
      `FROM rvbbit.mcp_tools t LEFT JOIN rvbbit.mcp_usage u ` +
      `ON u.server = t.server AND u.tool = t.name ` +
      `WHERE t.server = ${sqlStr(server)} ORDER BY t.name`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      server,
      name: String(r.name ?? ""),
      description: strOrNull(r.description),
      inputSchema: (r.input_schema as JsonSchema | null) ?? null,
      cacheable: bool(r.cacheable),
      ttlSeconds: numOrNull(r.ttl_seconds),
      discoveredAt: strOrNull(r.discovered_at),
      nCalls: num(r.n_calls),
      nErrors: num(r.n_errors),
      avgLatencyMs: num(r.avg_latency_ms),
      p95LatencyMs: num(r.p95_latency_ms),
      lastCallAt: strOrNull(r.last_call_at),
      nCached: num(r.n_cached),
    })),
  }
}

/**
 * Lightweight per-server tool listing for the operator-editor pickers —
 * skips the usage join so it's a cheap single-query fetch across all
 * registered servers.
 */
export interface McpToolLite {
  server: string
  name: string
  description: string | null
  inputSchema: JsonSchema | null
}

export async function fetchAllToolsLite(
  connectionId: string,
): Promise<{ rows: McpToolLite[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    "SELECT server, name, description, input_schema FROM rvbbit.mcp_tools ORDER BY server, name",
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      server: String(r.server ?? ""),
      name: String(r.name ?? ""),
      description: strOrNull(r.description),
      inputSchema: (r.input_schema as JsonSchema | null) ?? null,
    })),
  }
}

export async function fetchResources(
  connectionId: string,
  server: string,
): Promise<{ rows: McpResource[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT uri, name, description, mime_type, discovered_at ` +
      `FROM rvbbit.mcp_resources WHERE server = ${sqlStr(server)} ORDER BY uri`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      server,
      uri: String(r.uri ?? ""),
      name: strOrNull(r.name),
      description: strOrNull(r.description),
      mimeType: strOrNull(r.mime_type),
      discoveredAt: strOrNull(r.discovered_at),
    })),
  }
}

export async function fetchCache(
  connectionId: string,
  server: string,
): Promise<{ rows: McpCacheEntry[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT c.tool, c.args_hash, c.args, c.cached_at, t.ttl_seconds, ` +
      `CASE WHEN t.ttl_seconds IS NULL THEN false ` +
      `ELSE c.cached_at + (t.ttl_seconds::text || ' seconds')::interval < now() END AS expired, ` +
      `octet_length(c.output::text) AS output_bytes ` +
      `FROM rvbbit.mcp_cache c LEFT JOIN rvbbit.mcp_tools t ` +
      `ON t.server = c.server AND t.name = c.tool ` +
      `WHERE c.server = ${sqlStr(server)} ORDER BY c.cached_at DESC`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      server,
      tool: String(r.tool ?? ""),
      argsHash: String(r.args_hash ?? ""),
      args: r.args ?? null,
      cachedAt: String(r.cached_at ?? ""),
      ttlSeconds: numOrNull(r.ttl_seconds),
      expired: bool(r.expired),
      outputBytes: num(r.output_bytes),
    })),
  }
}

export async function fetchGhostServers(connectionId: string): Promise<GhostServerRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT server, count(*) AS n_calls, ` +
      `count(*) FILTER (WHERE error IS NOT NULL) AS n_errors, max(invocation_at) AS last_call_at ` +
      `FROM rvbbit.mcp_invocations ` +
      `WHERE server NOT IN (SELECT name FROM rvbbit.mcp_servers) ` +
      `GROUP BY server ORDER BY n_calls DESC LIMIT 100`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    server: String(r.server ?? ""),
    nCalls: num(r.n_calls),
    nErrors: num(r.n_errors),
    lastCallAt: strOrNull(r.last_call_at),
  }))
}

// ── Mutate ──────────────────────────────────────────────────────────

export interface RegisterServerInput {
  name: string
  transport: Transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  authHeaderEnv?: string
  timeoutMs?: number | null
  description?: string
}

export function buildRegisterServerSql(input: RegisterServerInput): string {
  const parts: string[] = [
    `server_name => ${sqlStr(input.name)}`,
    `server_transport => ${sqlStr(input.transport)}`,
  ]
  if (input.transport === "stdio") {
    if (input.command) parts.push(`server_command => ${sqlStr(input.command)}`)
    if (input.args && input.args.length > 0) {
      parts.push(`server_args => ${sqlTextArrayOrNull(input.args)}`)
    }
    if (input.env && Object.keys(input.env).length > 0) {
      parts.push(`server_env => ${sqlJsonbOrNull(input.env)}`)
    }
  } else {
    if (input.url) parts.push(`server_url => ${sqlStr(input.url)}`)
    if (input.authHeaderEnv) parts.push(`server_auth_env => ${sqlStr(input.authHeaderEnv)}`)
  }
  if (input.timeoutMs != null) parts.push(`server_timeout_ms => ${sqlIntOrNull(input.timeoutMs)}`)
  if (input.description) parts.push(`server_description => ${sqlStr(input.description)}`)
  return `SELECT rvbbit.register_mcp_server(${parts.join(", ")})`
}

export async function registerServer(
  connectionId: string,
  input: RegisterServerInput,
): Promise<{ error?: string }> {
  const res = await runQuery(connectionId, buildRegisterServerSql(input))
  return res.ok ? {} : { error: res.error }
}

export async function dropServer(connectionId: string, name: string): Promise<{ error?: string }> {
  const res = await runQuery(connectionId, `SELECT rvbbit.drop_mcp_server(${sqlStr(name)})`)
  return res.ok ? {} : { error: res.error }
}

export async function refreshServer(
  connectionId: string,
  name: string,
): Promise<{ nTools: number; error?: string }> {
  const res = await runQuery(connectionId, `SELECT rvbbit.refresh_mcp_server(${sqlStr(name)}) AS n`)
  if (!res.ok) return { nTools: 0, error: res.error }
  return { nTools: num(res.rows[0]?.n) }
}

export async function setToolCaching(
  connectionId: string,
  server: string,
  tool: string,
  ttlSeconds: number | null,
): Promise<{ error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.set_mcp_tool_caching(${sqlStr(server)}, ${sqlStr(tool)}, ${sqlIntOrNull(ttlSeconds)})`,
  )
  return res.ok ? {} : { error: res.error }
}

export async function disableToolCaching(
  connectionId: string,
  server: string,
  tool: string,
): Promise<{ error?: string }> {
  const res = await runQuery(
    connectionId,
    `UPDATE rvbbit.mcp_tools SET cacheable = false, ttl_seconds = NULL ` +
      `WHERE server = ${sqlStr(server)} AND name = ${sqlStr(tool)}`,
  )
  return res.ok ? {} : { error: res.error }
}

export async function purgeCache(
  connectionId: string,
  server: string,
  tool?: string,
): Promise<{ nPurged: number; error?: string }> {
  const args = tool ? `${sqlStr(server)}, ${sqlStr(tool)}` : sqlStr(server)
  const res = await runQuery(connectionId, `SELECT rvbbit.purge_mcp_cache(${args}) AS n`)
  if (!res.ok) return { nPurged: 0, error: res.error }
  return { nPurged: num(res.rows[0]?.n) }
}

// ── Active (talk to the gateway) ────────────────────────────────────

export async function mcpCall(
  connectionId: string,
  server: string,
  tool: string,
  args: unknown,
): Promise<{ envelope: McpEnvelope | null; latencyMs: number; error?: string }> {
  const started = Date.now()
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.mcp_call(${sqlStr(server)}, ${sqlStr(tool)}, ${sqlJsonbOrNull(args)}) AS r`,
  )
  const latencyMs = Date.now() - started
  if (!res.ok) return { envelope: null, latencyMs, error: res.error }
  return { envelope: (res.rows[0]?.r as McpEnvelope | null) ?? null, latencyMs }
}

export async function mcpProbe(
  connectionId: string,
  server: string,
): Promise<{ probe: McpProbe | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.mcp_probe(${sqlStr(server)}) AS p`,
  )
  if (!res.ok) return { probe: null, error: res.error }
  const p = (res.rows[0]?.p ?? {}) as Record<string, unknown>
  return {
    probe: {
      reachable: bool(p.reachable),
      latencyMs: numOrNull(p.latency_ms),
      nTools: numOrNull(p.n_tools),
      error: strOrNull(p.error),
    },
  }
}

export async function mcpResource(
  connectionId: string,
  server: string,
  uri: string,
): Promise<{ data: unknown; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.mcp_resource(${sqlStr(server)}, ${sqlStr(uri)}) AS r`,
  )
  if (!res.ok) return { data: null, error: res.error }
  return { data: res.rows[0]?.r ?? null }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Concatenate all text content blocks of an MCP envelope. */
export function mcpText(envelope: McpEnvelope | null | undefined): string {
  if (!envelope?.content) return ""
  return envelope.content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
}

/** Status pill string from a server overview (no probe). */
export type ServerStatus = "untested" | "failing" | "active" | "idle"
export function serverStatus(s: {
  lastCallAt: string | null
  lastErrorAt: string | null
}): ServerStatus {
  if (!s.lastCallAt) return "untested"
  if (s.lastErrorAt && new Date(s.lastErrorAt) > new Date(s.lastCallAt)) return "failing"
  const last = new Date(s.lastCallAt).getTime()
  if (Date.now() - last < 3600_000) return "active"
  return "idle"
}

/** Resolve the first non-null JSON-Schema type token. */
export function schemaType(s: JsonSchema | null | undefined): string {
  if (!s) return "any"
  const t = s.type
  if (Array.isArray(t)) {
    const first = t.find((x) => x !== "null")
    return typeof first === "string" ? first : "any"
  }
  return typeof t === "string" ? t : "any"
}

/**
 * Coerce a per-field string value into the JSON-schema-typed JS value the
 * tool expects. Empty optional fields drop out (return undefined).
 */
export function coerceSchemaValue(
  raw: string,
  schema: JsonSchema | undefined,
  required: boolean,
): { value: unknown; error?: string; omit?: boolean } {
  const trimmed = raw.trim()
  if (trimmed === "" && !required) return { value: undefined, omit: true }
  const t = schemaType(schema)
  if (t === "string") return { value: raw }
  if (t === "integer") {
    const n = Number(trimmed)
    if (!Number.isInteger(n)) return { value: null, error: "expected integer" }
    return { value: n }
  }
  if (t === "number") {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return { value: null, error: "expected number" }
    return { value: n }
  }
  if (t === "boolean") {
    if (/^(true|1|yes)$/i.test(trimmed)) return { value: true }
    if (/^(false|0|no)$/i.test(trimmed)) return { value: false }
    return { value: null, error: "expected boolean" }
  }
  // array | object | unknown → parse as JSON
  try {
    return { value: JSON.parse(trimmed) }
  } catch (e) {
    return { value: null, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Build a per-tool args object from a `field name → raw string` map.
 * Skips empty optionals; surfaces type errors per field.
 */
export function buildArgsFromForm(
  schema: JsonSchema | null | undefined,
  values: Record<string, string>,
): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  for (const [key, raw] of Object.entries(values)) {
    const r = coerceSchemaValue(raw, props[key], required.has(key))
    if (r.error) errors[key] = r.error
    else if (!r.omit) args[key] = r.value
  }
  for (const req of required) {
    if (!(req in values) || values[req].trim() === "") {
      errors[req] = "required"
    }
  }
  return { args, errors }
}
