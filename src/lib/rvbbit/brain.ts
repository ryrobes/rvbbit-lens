/**
 * Data layer for the Document Intelligence brain (rvbbit.brain_*) — role-gated docs.
 * Every read is parameterized by a "View as <email>" identity, so the file explorer
 * doubles as an ACL inspector: switch identity → watch Drive docs/folders appear & vanish.
 * Mirrors alerts.ts: a run() POST to /api/db/query, q() literal builder, {…,error} returns.
 */

interface Ok {
  ok: true
  columns: { name: string }[]
  rows: Record<string, unknown>[]
}
interface Err {
  ok: false
  error: string
}

interface RunOptions {
  readOnly?: boolean
  statementTimeout?: number
}

async function run(connectionId: string, sql: string, rowLimit = 5000, opts: RunOptions = {}): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql,
        rowLimit,
        ...(opts.statementTimeout != null ? { statementTimeout: opts.statementTimeout } : {}),
        ...(opts.readOnly ? { readOnly: true, poolLane: "meta" } : {}),
      }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function runRead(connectionId: string, sql: string, rowLimit = 5000, statementTimeout?: number): Promise<Ok | Err> {
  return run(connectionId, sql, rowLimit, { readOnly: true, statementTimeout })
}

/** Postgres single-quoted literal (the query API has no bind params). */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function num0(v: unknown): number {
  return v == null ? 0 : Number(v)
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}
function bool(v: unknown): boolean {
  return v === true || v === "t"
}

export interface BrainDoc {
  folderPath: string
  docId: number
  title: string
  source: string
  mime: string
  author: string | null
  occurredMs: number | null
  ingestedMs: number | null
  chunks: number
  roles?: string[] // admin listing only
  unassigned?: boolean // admin listing only — role-less = nobody can see it
}

/** Parse a Postgres text[] that may arrive as a JS array or a "{a,b}" string. */
function arrParse(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === "string" && v.startsWith("{") && v.endsWith("}")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.replace(/^"|"$/g, "").trim())
      .filter(Boolean)
  }
  return []
}

export interface BrainHit {
  docId: number
  title: string
  folderPath: string
  source: string
  docType: string | null
  occurredAt: string | null
  chunk: string
  score: number | null
}

/** A search pre-filter: narrow the corpus by type/source/folder/date before the vector search. */
export interface BrainFilter {
  type?: string[]
  source?: string[]
  folder?: string
  since?: string
  until?: string
}

export interface BrainFacets {
  types: { value: string; docs: number }[]
  sources: { value: string; docs: number }[]
}

/** Discover what the identity can filter by: doc types + sources (with counts), ACL-aware. */
export async function fetchFacets(connectionId: string, email: string): Promise<BrainFacets> {
  if (!email) return { types: [], sources: [] }
  const r = await runRead(connectionId, `SELECT facet, value, docs FROM rvbbit.brain_facets(${q(email)})`)
  if (!r.ok) return { types: [], sources: [] }
  const types: { value: string; docs: number }[] = []
  const sources: { value: string; docs: number }[] = []
  for (const row of r.rows) {
    const e = { value: String(row.value ?? ""), docs: Number(row.docs ?? 0) }
    if (row.facet === "type") types.push(e)
    else if (row.facet === "source") sources.push(e)
  }
  return { types, sources }
}

export interface BrainDocDetail {
  docId: number
  title: string
  folderPath: string
  source: string
  author: string | null
  mime: string
  occurredAt: string | null
  ingestedAt: string | null
  body: string | null
  roles: string[]
}

/** Distinct principals that hold any role — the "View as" candidates. */
export async function fetchPrincipals(connectionId: string): Promise<string[]> {
  const r = await runRead(connectionId, `SELECT DISTINCT principal FROM rvbbit.brain_role_members ORDER BY principal`)
  if (!r.ok) return []
  return r.rows.map((row) => String(row.principal))
}

/** Every folder + doc the given identity may see (ACL-enforced server-side). */
export async function fetchBrainTree(
  connectionId: string,
  email: string,
): Promise<{ docs: BrainDoc[]; error: string | null }> {
  if (!email) return { docs: [], error: null }
  const r = await runRead(
    connectionId,
    `SELECT folder_path, doc_id, title, source, mime, author,
            extract(epoch FROM occurred_at) * 1000 AS occurred_ms,
            extract(epoch FROM ingested_at) * 1000 AS ingested_ms, chunks
       FROM rvbbit.brain_tree(${q(email)})`,
  )
  if (!r.ok) return { docs: [], error: r.error }
  return {
    docs: r.rows.map((row) => ({
      folderPath: String(row.folder_path ?? "/"),
      docId: Number(row.doc_id),
      title: String(row.title ?? "(untitled)"),
      source: String(row.source ?? ""),
      mime: String(row.mime ?? "text/markdown"),
      author: str(row.author),
      occurredMs: num(row.occurred_ms),
      ingestedMs: num(row.ingested_ms),
      chunks: Number(row.chunks ?? 0),
    })),
    error: null,
  }
}

/** ADMIN: every doc (unfiltered) + its roles + unassigned flag — the triage surface. */
export async function fetchAllDocs(connectionId: string): Promise<{ docs: BrainDoc[]; error: string | null }> {
  const r = await runRead(
    connectionId,
    `SELECT folder_path, doc_id, title, source, mime, author,
            extract(epoch FROM occurred_at) * 1000 AS occurred_ms,
            extract(epoch FROM ingested_at) * 1000 AS ingested_ms, chunks, roles, unassigned
       FROM rvbbit.brain_all_docs()`,
  )
  if (!r.ok) return { docs: [], error: r.error }
  return {
    docs: r.rows.map((row) => ({
      folderPath: String(row.folder_path ?? "/"),
      docId: Number(row.doc_id),
      title: String(row.title ?? "(untitled)"),
      source: String(row.source ?? ""),
      mime: String(row.mime ?? "text/markdown"),
      author: str(row.author),
      occurredMs: num(row.occurred_ms),
      ingestedMs: num(row.ingested_ms),
      chunks: Number(row.chunks ?? 0),
      roles: arrParse(row.roles),
      unassigned: row.unassigned === true || row.unassigned === "t",
    })),
    error: null,
  }
}

/** Replace a document's allowed-role set. */
export async function setDocRoles(connectionId: string, docId: number, roles: string[]): Promise<string | null> {
  const r = await run(connectionId, `SELECT rvbbit.brain_set_doc_roles(${Math.floor(docId)}, ${arr(roles)})`)
  return r.ok ? null : r.error
}

/** Known roles anywhere + member/doc counts (role pickers + access overview). */
export async function fetchKnownRoles(connectionId: string): Promise<{ role: string; members: number; docs: number }[]> {
  const r = await runRead(connectionId, `SELECT role, members, docs FROM rvbbit.brain_list_roles()`)
  if (!r.ok) return []
  return r.rows.map((row) => ({ role: String(row.role), members: Number(row.members ?? 0), docs: Number(row.docs ?? 0) }))
}

/** Members (emails) of the given roles. */
export async function fetchRoleMembers(connectionId: string, roles: string[]): Promise<{ role: string; principal: string }[]> {
  if (!roles.length) return []
  const r = await runRead(connectionId, `SELECT role, principal FROM rvbbit.brain_role_member_list(${arr(roles)})`)
  if (!r.ok) return []
  return r.rows.map((row) => ({ role: String(row.role), principal: String(row.principal) }))
}

/** Grant (on) or revoke a role for a principal (email). */
export async function grantMember(connectionId: string, role: string, principal: string, on = true): Promise<string | null> {
  const fn = on ? "brain_grant" : "brain_revoke"
  const r = await run(connectionId, `SELECT rvbbit.${fn}(${q(role)}, ${q(principal)})`)
  return r.ok ? null : r.error
}

/** ADMIN: open a doc's body bypassing ACL (so role-less docs can be triaged). */
export async function fetchDocAdmin(
  connectionId: string,
  docId: number,
): Promise<{ doc: BrainDocDetail | null; error: string | null }> {
  const r = await runRead(
    connectionId,
    `SELECT d.doc_id, d.title, d.folder_path, s.label AS source, d.author, d.mime,
            d.occurred_at::text AS occurred_at, d.ingested_at::text AS ingested_at, d.body,
            coalesce((SELECT array_agg(role ORDER BY role) FROM rvbbit.brain_doc_roles dr WHERE dr.doc_id = d.doc_id), '{}') AS roles
       FROM rvbbit.brain_documents d JOIN rvbbit.brain_sources s ON s.source_id = d.source_id
      WHERE d.doc_id = ${Math.floor(docId)}`,
  )
  if (!r.ok) return { doc: null, error: r.error }
  const d = r.rows[0]
  if (!d) return { doc: null, error: null }
  return {
    doc: {
      docId: Number(d.doc_id),
      title: String(d.title ?? ""),
      folderPath: String(d.folder_path ?? "/"),
      source: String(d.source ?? ""),
      author: str(d.author),
      mime: String(d.mime ?? ""),
      occurredAt: str(d.occurred_at),
      ingestedAt: str(d.ingested_at),
      body: str(d.body),
      roles: arrParse(d.roles),
    },
    error: null,
  }
}

/** Open one doc's full body — returns null if the identity isn't cleared for it. */
export async function fetchBrainDoc(
  connectionId: string,
  email: string,
  docId: number,
): Promise<{ doc: BrainDocDetail | null; error: string | null }> {
  const r = await runRead(connectionId, `SELECT rvbbit.brain_get_doc(${q(email)}, ${Math.floor(docId)}) AS d`)
  if (!r.ok) return { doc: null, error: r.error }
  const d = r.rows[0]?.d as Record<string, unknown> | null | undefined
  if (!d) return { doc: null, error: null }
  return {
    doc: {
      docId: Number(d.doc_id),
      title: String(d.title ?? ""),
      folderPath: String(d.folder_path ?? "/"),
      source: String(d.source ?? ""),
      author: str(d.author),
      mime: String(d.mime ?? ""),
      occurredAt: str(d.occurred_at),
      ingestedAt: str(d.ingested_at),
      body: str(d.body),
      roles: Array.isArray(d.roles) ? (d.roles as unknown[]).map(String) : [],
    },
    error: null,
  }
}

function arr(roles: string[] | null | undefined): string {
  const rs = (roles ?? []).map((r) => r.trim()).filter(Boolean)
  return rs.length ? `ARRAY[${rs.map(q).join(",")}]::text[]` : "NULL::text[]"
}

/** Ingest one document (drag-drop). Mirrors rvbbit.brain_ingest; idempotent on (source, uri). */
export async function ingestDoc(
  connectionId: string,
  d: { source: string; title: string; body: string; roles?: string[]; folder?: string | null; uri?: string | null; author?: string | null },
): Promise<{ docId: number | null; error: string | null }> {
  const sql =
    `SELECT rvbbit.brain_ingest(${q(d.source)}, ${q(d.title)}, ${q(d.body)}, ${arr(d.roles)}, ` +
    `${d.folder ? q(d.folder) : "NULL"}, ${d.uri ? q(d.uri) : "NULL"}, ${d.author ? q(d.author) : "NULL"}) AS id`
  const r = await run(connectionId, sql)
  if (!r.ok) return { docId: null, error: r.error }
  return { docId: r.rows[0]?.id == null ? null : Number(r.rows[0].id), error: null }
}

// ── Phase 3: remote sources, sync runs, pending grants, the doc graph ─────────

export interface BrainSource {
  sourceId: number
  label: string
  kind: string
  enabled: boolean
  endpoint: string | null
  folders: string[]
  credsRef: string | null
  lastSyncedMs: number | null
  docs: number
  /** non-null → a query source (MCP/SQL); the provider it's bound to */
  provider: string | null
}

/** All configured sources + their live doc counts + remote config. */
export async function fetchSources(connectionId: string): Promise<{ sources: BrainSource[]; error: string | null }> {
  const r = await runRead(
    connectionId,
    `SELECT s.source_id, s.label, s.kind, s.enabled, s.creds_ref,
            s.config->>'endpoint' AS endpoint, s.config->'folders' AS folders,
            s.config->>'provider' AS provider,
            extract(epoch FROM s.last_synced_at) * 1000 AS last_ms,
            (SELECT count(*) FROM rvbbit.brain_documents d WHERE d.source_id = s.source_id AND d.deleted_at IS NULL) AS docs
       FROM rvbbit.brain_sources s ORDER BY s.label`,
  )
  if (!r.ok) return { sources: [], error: r.error }
  return {
    sources: r.rows.map((row) => ({
      sourceId: Number(row.source_id),
      label: String(row.label ?? ""),
      kind: String(row.kind ?? "manual"),
      enabled: row.enabled === true || row.enabled === "t",
      endpoint: str(row.endpoint),
      folders: Array.isArray(row.folders) ? (row.folders as unknown[]).map(String) : [],
      credsRef: str(row.creds_ref),
      lastSyncedMs: num(row.last_ms),
      docs: Number(row.docs ?? 0),
      provider: str(row.provider),
    })),
    error: null,
  }
}

export interface BrainProvider {
  provider: string
  label: string
  listSql: string
  itemSql: string | null
  icon: string | null
  description: string | null
  /** declarative structured-edge specs [{predicate, kind, path}]; JSON string for the editor */
  edgeMap: string
  /** number of edge specs (for the card summary) */
  edgeCount: number
  /** the doc_type all this provider's sources are tagged with (document | ticket | meeting | …) */
  docType: string
  /** how many sources currently bind this provider */
  sources: number
}

/** All registered document-type providers (the reusable "scrape is SQL" definitions). */
export async function fetchProviders(connectionId: string): Promise<{ providers: BrainProvider[]; error: string | null }> {
  const r = await runRead(
    connectionId,
    `SELECT p.provider, p.label, p.list_sql, p.item_sql, p.icon, p.description, p.doc_type,
            p.edge_map::text AS edge_map, jsonb_array_length(coalesce(p.edge_map,'[]'::jsonb)) AS edge_count,
            (SELECT count(*) FROM rvbbit.brain_sources s WHERE s.config->>'provider' = p.provider) AS sources
       FROM rvbbit.brain_doc_providers p ORDER BY p.label`,
  )
  if (!r.ok) return { providers: [], error: r.error }
  return {
    providers: r.rows.map((row) => ({
      provider: String(row.provider),
      label: String(row.label ?? ""),
      listSql: String(row.list_sql ?? ""),
      itemSql: str(row.item_sql),
      icon: str(row.icon),
      description: str(row.description),
      edgeMap: String(row.edge_map ?? "[]"),
      edgeCount: Number(row.edge_count ?? 0),
      docType: String(row.doc_type ?? "document"),
      sources: Number(row.sources ?? 0),
    })),
    error: null,
  }
}

/** Create/update a provider (document type). item_sql null/empty → single-phase.
 *  edgeMap is a JSON array string of {predicate, kind, path} structured-edge specs.
 *  docType tags every doc from this provider's sources (document | ticket | meeting | custom…). */
export async function defineProvider(
  connectionId: string,
  p: { provider: string; label: string; listSql: string; itemSql?: string | null; icon?: string | null; description?: string | null; edgeMap?: string | null; docType?: string | null },
): Promise<string | null> {
  const edge = p.edgeMap && p.edgeMap.trim() ? p.edgeMap.trim() : "[]"
  const docType = p.docType && p.docType.trim() ? p.docType.trim() : "document"
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_define_provider(${q(p.provider)}, ${q(p.label)}, ${q(p.listSql)}, ` +
      `${p.itemSql && p.itemSql.trim() ? q(p.itemSql) : "NULL"}, ` +
      `${p.icon ? q(p.icon) : "NULL"}, ${p.description ? q(p.description) : "NULL"}, ${q(edge)}::jsonb, ${q(docType)})`,
  )
  return r.ok ? null : r.error
}

/** Remove a provider (only if no source binds it). */
export async function deleteProvider(connectionId: string, provider: string): Promise<string | null> {
  const r = await run(
    connectionId,
    `DELETE FROM rvbbit.brain_doc_providers WHERE provider = ${q(provider)}
       AND NOT EXISTS (SELECT 1 FROM rvbbit.brain_sources s WHERE s.config->>'provider' = ${q(provider)})`,
  )
  if (!r.ok) return r.error
  return null
}

/** Create a query source bound to a provider (globally visible docs). */
export async function addQuerySource(
  connectionId: string,
  s: { label: string; provider: string },
): Promise<{ sourceId: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_add_query_source(${q(s.label)}, ${q(s.provider)}) AS id`,
  )
  if (!r.ok) return { sourceId: null, error: r.error }
  return { sourceId: r.rows[0]?.id == null ? null : Number(r.rows[0].id), error: null }
}

/** Create/update a remote source (gdrive, …). config carries endpoint + Drive doc/folder locations. */
export async function configureSource(
  connectionId: string,
  s: { label: string; kind: string; endpoint: string; folders: string[]; credsRef?: string | null; connector?: string | null },
): Promise<{ sourceId: number | null; error: string | null }> {
  const config = JSON.stringify({
    endpoint: s.endpoint || undefined,
    folders: s.folders.map((f) => f.trim()).filter(Boolean),
    connector: s.connector || undefined,
  })
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_configure_source(${q(s.label)}, ${q(s.kind)}, ${q(config)}::jsonb, ` +
      `${s.credsRef ? q(s.credsRef) : "NULL"}) AS id`,
  )
  if (!r.ok) return { sourceId: null, error: r.error }
  return { sourceId: r.rows[0]?.id == null ? null : Number(r.rows[0].id), error: null }
}

/** Enable/disable a source (skipped by the nightly sync when disabled). */
export async function setSourceEnabled(connectionId: string, sourceId: number, on: boolean): Promise<string | null> {
  const r = await run(
    connectionId,
    `UPDATE rvbbit.brain_sources SET enabled = ${on ? "true" : "false"} WHERE source_id = ${Math.floor(sourceId)}`,
  )
  return r.ok ? null : r.error
}

/** Trigger a sync now — routed by source kind (connector OR query/MCP). Returns the run summary. */
export async function syncSourceNow(
  connectionId: string,
  sourceId: number,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.brain_sync_dispatch(${Math.floor(sourceId)}, 'manual') AS r`, 1)
  if (!r.ok) return { result: null, error: r.error }
  return { result: (r.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}

export interface SystemLearningBrainStatus {
  installed: boolean
  sourceId: number | null
  enabled: boolean
  docs: number
  indexedItems: number
  groups: SystemLearningGroup[]
  examples: SystemLearningExample[]
  lastSyncedAt: number | null
  lastRunAt: number | null
  lastRunAdded: number
  lastRunChanged: number
  lastRunSkipped: number
  error?: string
}

export interface SystemLearningGroup {
  objectType: string
  items: number
  lastSeenAt: number | null
}

export interface SystemLearningExample {
  uri: string
  title: string
  objectType: string
  tableName: string | null
  columnName: string | null
  layout: string | null
  shapeKey: string | null
  engine: string | null
  operatorName: string | null
  status: string | null
  occurredAt: number | null
}

export interface SystemLearningBrainSync {
  ok: boolean
  result: Record<string, unknown> | null
  added: number
  changed: number
  skipped: number
  removed: number
  error?: string
}

export interface SystemLearningPrompt {
  label: string
  query: string
  useWhen: string
}

export const SYSTEM_LEARNING_PROMPTS: SystemLearningPrompt[] = [
  {
    label: "Acceleration next steps",
    query: "Which heap tables should I consider adding to RVBBIT acceleration next, and why?",
    useWhen: "heap tables show repeated sequential scans or large read volume",
  },
  {
    label: "Slow query explanation",
    query: "Which observed route shapes are still slow, which engine wins, and what should I test next?",
    useWhen: "routing traces disagree or a shape needs exploration",
  },
  {
    label: "Layout payoff",
    query: "Which accepted or proposed workload layouts look most valuable, and are they built?",
    useWhen: "cluster or hive variants were recommended from workload evidence",
  },
  {
    label: "Operator trust",
    query: "Which SQL operators are getting real usage, cost, retries, or cache hits worth reviewing?",
    useWhen: "semantic operators need an audit trail before promotion",
  },
  {
    label: "What changed",
    query: "Summarize what RVBBIT learned recently about this database with exact artifact handles.",
    useWhen: "you want the latest learned state across routing, acceleration, and operators",
  },
]

export interface SystemLearningArtifact {
  uri: string
  title: string
  objectType: string
  occurredAt: number | null
  body: string
  tableName: string | null
  columnName: string | null
  layout: string | null
  layoutKind: string | null
  layoutStatus: string | null
  shapeKey: string | null
  shapeFamily: string | null
  engine: string | null
  operatorName: string | null
  status: string | null
  score: number | null
  observations: number | null
  seqScans: number | null
  seqRows: number | null
  writes: number | null
  sizeBytes: number | null
  rowEstimate: number | null
  inspectSql: string
  askQuery: string
}

export function systemLearningInspectSql(uri: string): string {
  return `SELECT uri, title, occurred_at, props, body\nFROM rvbbit.system_learning_items\nWHERE uri = ${q(uri)}`
}

function systemLearningAskQuery(row: Pick<SystemLearningArtifact, "objectType" | "title" | "tableName" | "operatorName" | "layout" | "shapeKey">): string {
  const subject =
    row.tableName ??
    row.operatorName ??
    row.layout ??
    (row.shapeKey ? `shape ${row.shapeKey.slice(0, 48)}` : row.title)
  if (row.objectType === "heap_acceleration_candidate") {
    return `Should I accelerate ${subject}? Cite the exact artifact and explain the read/write evidence.`
  }
  if (row.objectType === "workload_layout") {
    return `Is workload layout ${subject} worth building or maintaining? Cite the exact artifact.`
  }
  if (row.objectType === "route_shape") {
    return `Why does ${subject} route this way, and what should I test next? Cite the exact artifact.`
  }
  if (row.objectType === "operator") {
    return `What should I know about SQL operator ${subject}? Cite usage, cost, and trust signals.`
  }
  return `Explain ${row.title} with exact RVBBIT system learning handles.`
}

export async function fetchSystemLearningArtifacts(
  connectionId: string,
  options: { objectTypes?: string[]; limit?: number } = {},
): Promise<{ rows: SystemLearningArtifact[]; error: string | null }> {
  const objectTypes = (options.objectTypes ?? []).map((s) => s.trim()).filter(Boolean)
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 24)))
  const where = objectTypes.length
    ? `WHERE coalesce(props->>'object_type', 'unknown') IN (${objectTypes.map(q).join(",")})`
    : ""
  const res = await runRead(
    connectionId,
    `SELECT uri, title,
            coalesce(props->>'object_type', 'unknown') AS object_type,
            extract(epoch FROM occurred_at) * 1000 AS occurred_ms,
            left(coalesce(body, ''), 1400) AS body,
            props->>'table' AS table_name,
            props->>'column' AS column_name,
            props->>'layout' AS layout,
            props->>'layout_kind' AS layout_kind,
            props->>'layout_status' AS layout_status,
            props->>'shape_key' AS shape_key,
            props->>'shape_family' AS shape_family,
            props->>'engine' AS engine,
            props->>'operator' AS operator_name,
            props->>'status' AS status,
            (props->>'score')::double precision AS score,
            (props->>'observations')::double precision AS observations,
            (props->>'seq_scans')::double precision AS seq_scans,
            (props->>'seq_rows')::double precision AS seq_rows,
            (props->>'writes')::double precision AS writes,
            (props->>'size_bytes')::double precision AS size_bytes,
            (props->>'row_estimate')::double precision AS row_estimate
       FROM rvbbit.system_learning_items
       ${where}
       ORDER BY occurred_at DESC, title
       LIMIT ${limit}`,
    limit,
  )
  if (!res.ok) return { rows: [], error: res.error }
  const rows = res.rows.map((row) => {
    const artifact: SystemLearningArtifact = {
      uri: String(row.uri ?? ""),
      title: String(row.title ?? ""),
      objectType: String(row.object_type ?? "unknown"),
      occurredAt: num(row.occurred_ms),
      body: String(row.body ?? ""),
      tableName: str(row.table_name),
      columnName: str(row.column_name),
      layout: str(row.layout),
      layoutKind: str(row.layout_kind),
      layoutStatus: str(row.layout_status),
      shapeKey: str(row.shape_key),
      shapeFamily: str(row.shape_family),
      engine: str(row.engine),
      operatorName: str(row.operator_name),
      status: str(row.status),
      score: num(row.score),
      observations: num(row.observations),
      seqScans: num(row.seq_scans),
      seqRows: num(row.seq_rows),
      writes: num(row.writes),
      sizeBytes: num(row.size_bytes),
      rowEstimate: num(row.row_estimate),
      inspectSql: systemLearningInspectSql(String(row.uri ?? "")),
      askQuery: "",
    }
    artifact.askQuery = systemLearningAskQuery(artifact)
    return artifact
  })
  return { rows, error: null }
}

function emptySystemLearningBrainStatus(error?: string): SystemLearningBrainStatus {
  return {
    installed: false,
    sourceId: null,
    enabled: false,
    docs: 0,
    indexedItems: 0,
    groups: [],
    examples: [],
    lastSyncedAt: null,
    lastRunAt: null,
    lastRunAdded: 0,
    lastRunChanged: 0,
    lastRunSkipped: 0,
    ...(error ? { error } : {}),
  }
}

export async function fetchSystemLearningBrainStatus(connectionId: string): Promise<SystemLearningBrainStatus> {
  const catalog = await runRead(
    connectionId,
    `SELECT
       to_regclass('rvbbit.system_learning_items') IS NOT NULL AS items_present,
       to_regclass('rvbbit.system_learning_brain_status') IS NOT NULL AS status_present,
       to_regclass('rvbbit.system_learning_item_summary') IS NOT NULL AS summary_present,
       to_regclass('rvbbit.brain_sources') IS NOT NULL AS sources_present,
       to_regclass('rvbbit.brain_documents') IS NOT NULL AS documents_present,
       to_regclass('rvbbit.brain_sync_runs') IS NOT NULL AS runs_present`,
    1,
  )
  if (!catalog.ok) return emptySystemLearningBrainStatus(catalog.error)
  const catalogRow = catalog.rows[0] ?? {}
  const itemsPresent = bool(catalogRow.items_present)
  const groups = await fetchSystemLearningGroups(connectionId, bool(catalogRow.summary_present))
  const examples = await fetchSystemLearningExamples(connectionId, itemsPresent)
  if (!bool(catalogRow.sources_present) || !bool(catalogRow.documents_present) || !bool(catalogRow.runs_present)) {
    return emptySystemLearningBrainStatus()
  }

  if (bool(catalogRow.status_present)) {
    const status = await runRead(
      connectionId,
      `SELECT installed, source_id, enabled, indexed_items, docs,
              extract(epoch FROM last_synced_at) * 1000 AS last_synced_ms,
              extract(epoch FROM last_run_at) * 1000 AS last_run_ms,
              last_run_added, last_run_changed, last_run_skipped
       FROM rvbbit.system_learning_brain_status`,
      1,
    )
    if (!status.ok) return emptySystemLearningBrainStatus(status.error)
    const row = status.rows[0] ?? {}
    return {
      installed: bool(row.installed),
      sourceId: num(row.source_id),
      enabled: bool(row.enabled),
      docs: num0(row.docs),
      indexedItems: num0(row.indexed_items),
      groups,
      examples,
      lastSyncedAt: num(row.last_synced_ms),
      lastRunAt: num(row.last_run_ms),
      lastRunAdded: num0(row.last_run_added),
      lastRunChanged: num0(row.last_run_changed),
      lastRunSkipped: num0(row.last_run_skipped),
    }
  }

  const res = await runRead(
    connectionId,
    `WITH src AS (
       SELECT source_id, enabled, last_synced_at
       FROM rvbbit.brain_sources
       WHERE label = 'RVBBIT System Learning'
     ), last_run AS (
       SELECT r.started_at, r.added, r.changed, r.skipped
       FROM rvbbit.brain_sync_runs r
       JOIN src s ON s.source_id = r.source_id
       ORDER BY r.started_at DESC
       LIMIT 1
     )
     SELECT
       to_regclass('rvbbit.system_learning_items') IS NOT NULL AS installed,
       (SELECT source_id FROM src) AS source_id,
       coalesce((SELECT enabled FROM src), false) AS enabled,
       ${itemsPresent ? "coalesce((SELECT count(*) FROM rvbbit.system_learning_items), 0)::bigint" : "0::bigint"} AS indexed_items,
       coalesce((SELECT count(*) FROM rvbbit.brain_documents d JOIN src s ON s.source_id = d.source_id WHERE d.deleted_at IS NULL), 0)::bigint AS docs,
       (SELECT extract(epoch FROM last_synced_at) * 1000 FROM src) AS last_synced_ms,
       (SELECT extract(epoch FROM started_at) * 1000 FROM last_run) AS last_run_ms,
       coalesce((SELECT added FROM last_run), 0)::int AS last_run_added,
       coalesce((SELECT changed FROM last_run), 0)::int AS last_run_changed,
       coalesce((SELECT skipped FROM last_run), 0)::int AS last_run_skipped`,
    1,
  )
  if (!res.ok) return emptySystemLearningBrainStatus(res.error)
  const row = res.rows[0] ?? {}
  return {
    installed: itemsPresent && bool(row.installed),
    sourceId: num(row.source_id),
    enabled: bool(row.enabled),
    docs: num0(row.docs),
    indexedItems: num0(row.indexed_items),
    groups,
    examples,
    lastSyncedAt: num(row.last_synced_ms),
    lastRunAt: num(row.last_run_ms),
    lastRunAdded: num0(row.last_run_added),
    lastRunChanged: num0(row.last_run_changed),
    lastRunSkipped: num0(row.last_run_skipped),
  }
}

async function fetchSystemLearningGroups(connectionId: string, summaryPresent: boolean): Promise<SystemLearningGroup[]> {
  if (!summaryPresent) return []
  const res = await runRead(
    connectionId,
    `SELECT object_type, items, extract(epoch FROM last_seen_at) * 1000 AS last_seen_ms
     FROM rvbbit.system_learning_item_summary
     ORDER BY items DESC, object_type`,
    40,
  )
  if (!res.ok) return []
  return res.rows.map((row) => ({
    objectType: String(row.object_type ?? "unknown"),
    items: num0(row.items),
    lastSeenAt: num(row.last_seen_ms),
  }))
}

async function fetchSystemLearningExamples(connectionId: string, itemsPresent: boolean): Promise<SystemLearningExample[]> {
  if (!itemsPresent) return []
  const res = await runRead(
    connectionId,
    `WITH ranked AS (
       SELECT uri, title, occurred_at, props,
              coalesce(props->>'object_type', 'unknown') AS object_type,
              row_number() OVER (
                PARTITION BY coalesce(props->>'object_type', 'unknown')
                ORDER BY occurred_at DESC, title
              ) AS rn
       FROM rvbbit.system_learning_items
     )
     SELECT uri, title, object_type,
            props->>'table' AS table_name,
            props->>'column' AS column_name,
            props->>'layout' AS layout,
            props->>'shape_key' AS shape_key,
            props->>'engine' AS engine,
            props->>'operator' AS operator_name,
            props->>'status' AS status,
            extract(epoch FROM occurred_at) * 1000 AS occurred_ms
     FROM ranked
     WHERE rn = 1
     ORDER BY object_type, occurred_at DESC, title
     LIMIT 8`,
    8,
  )
  if (!res.ok) return []
  return res.rows.map((row) => ({
    uri: String(row.uri ?? ""),
    title: String(row.title ?? ""),
    objectType: String(row.object_type ?? "unknown"),
    tableName: str(row.table_name),
    columnName: str(row.column_name),
    layout: str(row.layout),
    shapeKey: str(row.shape_key),
    engine: str(row.engine),
    operatorName: str(row.operator_name),
    status: str(row.status),
    occurredAt: num(row.occurred_ms),
  }))
}

export async function syncSystemLearningBrain(connectionId: string): Promise<SystemLearningBrainSync> {
  const res = await run(
    connectionId,
    `WITH src AS (
       SELECT source_id
       FROM rvbbit.brain_sources
       WHERE label = 'RVBBIT System Learning'
     )
     SELECT rvbbit.brain_sync_dispatch((SELECT source_id FROM src), 'manual') AS r`,
    1,
    { statementTimeout: 0 },
  )
  if (!res.ok) {
    return { ok: false, result: null, added: 0, changed: 0, skipped: 0, removed: 0, error: res.error }
  }
  const result = (res.rows[0]?.r as Record<string, unknown> | null) ?? null
  return {
    ok: true,
    result,
    added: num0(result?.added),
    changed: num0(result?.changed),
    skipped: num0(result?.skipped),
    removed: num0(result?.removed),
  }
}

export interface BrainSyncRun {
  runId: number
  sourceId: number | null
  startedMs: number | null
  finishedMs: number | null
  trigger: string
  added: number
  changed: number
  removed: number
  skipped: number
  errors: number
  elapsedSec: number | null
}

/** Recent sync runs (optionally for one source). */
export async function fetchSyncRuns(
  connectionId: string,
  sourceId?: number,
): Promise<{ runs: BrainSyncRun[]; error: string | null }> {
  const where = sourceId ? `WHERE source_id = ${Math.floor(sourceId)}` : ""
  const r = await runRead(
    connectionId,
    `SELECT run_id, source_id, extract(epoch FROM started_at)*1000 AS started_ms,
            extract(epoch FROM finished_at)*1000 AS finished_ms, trigger, added, changed, removed, skipped, errors, elapsed_sec
       FROM rvbbit.brain_sync_runs ${where} ORDER BY run_id DESC LIMIT 30`,
  )
  if (!r.ok) return { runs: [], error: r.error }
  return {
    runs: r.rows.map((row) => ({
      runId: Number(row.run_id),
      sourceId: num(row.source_id),
      startedMs: num(row.started_ms),
      finishedMs: num(row.finished_ms),
      trigger: String(row.trigger ?? ""),
      added: Number(row.added ?? 0),
      changed: Number(row.changed ?? 0),
      removed: Number(row.removed ?? 0),
      skipped: Number(row.skipped ?? 0),
      errors: Number(row.errors ?? 0),
      elapsedSec: num(row.elapsed_sec),
    })),
    error: null,
  }
}

export interface BrainPendingGrant {
  sourceId: number
  folderId: string
  grantKind: string
  grantValue: string
  approved: boolean
}

/** Group/domain/anyone shares awaiting admin approval (strict ACL). */
export async function fetchPendingGrants(connectionId: string): Promise<{ grants: BrainPendingGrant[]; error: string | null }> {
  const r = await runRead(
    connectionId,
    `SELECT source_id, folder_id, grant_kind, grant_value, approved
       FROM rvbbit.brain_pending_grants WHERE NOT approved ORDER BY source_id, folder_id`,
  )
  if (!r.ok) return { grants: [], error: r.error }
  return {
    grants: r.rows.map((row) => ({
      sourceId: Number(row.source_id),
      folderId: String(row.folder_id ?? ""),
      grantKind: String(row.grant_kind ?? ""),
      grantValue: String(row.grant_value ?? ""),
      approved: row.approved === true || row.approved === "t",
    })),
    error: null,
  }
}

/** Approve a pending grant: add the given emails to the folder's role. */
export async function approvePendingGrant(
  connectionId: string,
  g: { sourceId: number; folderId: string; grantKind: string; grantValue: string; emails: string[] },
): Promise<string | null> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_approve_pending_grant(${Math.floor(g.sourceId)}, ${q(g.folderId)}, ` +
      `${q(g.grantKind)}, ${q(g.grantValue)}, ${arr(g.emails)})`,
  )
  return r.ok ? null : r.error
}

export interface BrainGraphRow {
  relType: "entity" | "related_doc" | string
  kind: string
  label: string
  docId: number | null
  weight: number
}

/** ACL-aware "how does this doc relate": entities + other visible docs sharing them. */
export async function fetchDocGraph(
  connectionId: string,
  email: string,
  docId: number,
): Promise<{ rows: BrainGraphRow[]; error: string | null }> {
  if (!email) return { rows: [], error: null }
  const r = await runRead(
    connectionId,
    `SELECT rel_type, kind, label, doc_id, weight FROM rvbbit.brain_doc_graph(${q(email)}, ${Math.floor(docId)})`,
  )
  if (!r.ok) return { rows: [], error: r.error }
  return {
    rows: r.rows.map((row) => ({
      relType: String(row.rel_type ?? ""),
      kind: String(row.kind ?? ""),
      label: String(row.label ?? ""),
      docId: num(row.doc_id),
      weight: Number(row.weight ?? 0),
    })),
    error: null,
  }
}

export interface NerStatus {
  /** the GLiNER extract_entities operator exists → enrichment will use it for full entity coverage */
  installed: boolean
  backendRegistered: boolean
  /** catalog id to deep-link the install panel (falls back to the known id) */
  catalogId: string | null
}

/** Whether the GLiNER NER capability is installed (enrichment uses it if so). */
export async function fetchNerStatus(connectionId: string): Promise<NerStatus> {
  const r = await runRead(
    connectionId,
    `SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname='rvbbit' AND p.proname='extract_entities') AS installed,
            EXISTS(SELECT 1 FROM rvbbit.backends WHERE name='extract_gliner') AS backend_registered,
            (CASE WHEN to_regclass('rvbbit.capability_catalog') IS NOT NULL
                  THEN (SELECT id FROM rvbbit.capability_catalog WHERE backend_name='extract_gliner' LIMIT 1) END) AS catalog_id`,
  )
  if (!r.ok) return { installed: false, backendRegistered: false, catalogId: null }
  const row = r.rows[0] ?? {}
  return {
    installed: row.installed === true || row.installed === "t",
    backendRegistered: row.backend_registered === true || row.backend_registered === "t",
    catalogId: row.catalog_id ? String(row.catalog_id) : null,
  }
}

export interface ExtractionStatus {
  opInstalled: boolean
  extractEndpoint: string | null
  /** Live probe verdict: true = the doc-extract sidecar answered (a probe on
   *  a nonexistent staged file returns "" by contract); false = the call
   *  errored (not running / unreachable); null = probe not attempted. */
  reachable: boolean | null
  connectorEndpoint: string | null
}

/** Is the brain able to EAT DOCUMENTS right now? Registration facts plus a
 *  live reachability probe through the real extract_doc operator path —
 *  per-item failures return "", so probing a nonexistent staged path proves
 *  the sidecar is up without side effects. */
export async function fetchExtractionStatus(connectionId: string): Promise<ExtractionStatus> {
  const r = await runRead(
    connectionId,
    `SELECT (SELECT endpoint_url FROM rvbbit.backends WHERE name='extract_doc') AS extract_endpoint,
            (SELECT endpoint_url FROM rvbbit.backends WHERE name='gdrive_connector') AS connector_endpoint,
            EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname='rvbbit' AND p.proname='extract_doc') AS op_installed`,
  )
  const row = (r.ok ? (r.rows[0] ?? {}) : {}) as Record<string, unknown>
  const status: ExtractionStatus = {
    opInstalled: row.op_installed === true || row.op_installed === "t",
    extractEndpoint: row.extract_endpoint ? String(row.extract_endpoint) : null,
    reachable: null,
    connectorEndpoint: row.connector_endpoint ? String(row.connector_endpoint) : null,
  }
  if (status.opInstalled && status.extractEndpoint) {
    const probe = await run(
      connectionId,
      `SELECT coalesce(rvbbit.extract_doc('/staging/__rvbbit_probe__.txt', 'text/plain'), '') AS x`,
      1,
    )
    status.reachable = probe.ok
  }
  return status
}

/** Delete a source. purgeDocs=true wipes its docs + KG nodes + synthetic roles; false keeps docs
 *  (reassigned to a "<label> (archived)" manual source). Returns the summary. */
export async function deleteSource(
  connectionId: string,
  sourceId: number,
  purgeDocs: boolean,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_delete_source(${Math.floor(sourceId)}, ${purgeDocs ? "true" : "false"}) AS r`,
    1,
  )
  if (!r.ok) return { result: null, error: r.error }
  return { result: (r.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}

export interface BrainRelation {
  subjectKind: string
  subject: string
  predicate: string
  objectKind: string
  object: string
  confidence: number | null
}

/** Typed relationships (the edges, not just "mentions") among a doc's entities. ACL-gated. */
export async function fetchDocRelations(
  connectionId: string,
  email: string,
  docId: number,
): Promise<{ rels: BrainRelation[]; error: string | null }> {
  if (!email) return { rels: [], error: null }
  const r = await runRead(
    connectionId,
    `SELECT subject_kind, subject, predicate, object_kind, object, confidence
       FROM rvbbit.brain_doc_relations(${q(email)}, ${Math.floor(docId)}, 40)`,
  )
  if (!r.ok) return { rels: [], error: r.error }
  return {
    rels: r.rows.map((row) => ({
      subjectKind: String(row.subject_kind ?? ""),
      subject: String(row.subject ?? ""),
      predicate: String(row.predicate ?? ""),
      objectKind: String(row.object_kind ?? ""),
      object: String(row.object ?? ""),
      confidence: num(row.confidence),
    })),
    error: null,
  }
}

/** Enrich one doc into the KG now (entities/relations/wikilinks). */
export async function enrichDocNow(
  connectionId: string,
  docId: number,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.brain_enrich_doc(${Math.floor(docId)}) AS r`, 1)
  if (!r.ok) return { result: null, error: r.error }
  return { result: (r.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}

/** Bulk-enrich a whole source ("set"): KG entities + structured edges for every doc. By default only
 *  new/changed docs; force=true re-enriches all. Triples (LLM) auto-skip for query/MCP sources.
 *  No statement timeout — a large set can take a while. */
export async function enrichSource(
  connectionId: string,
  sourceId: number,
  opts?: { force?: boolean },
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.brain_enrich_source(${Math.floor(sourceId)}, ${opts?.force ? "true" : "false"}) AS r`,
    1,
    { statementTimeout: 0 },
  )
  if (!r.ok) return { result: null, error: r.error }
  return { result: (r.rows[0]?.r as Record<string, unknown>) ?? null, error: null }
}

/** Semantic search over the identity's permitted docs, with an optional pre-filter (type/source/…). */
export async function askBrain(
  connectionId: string,
  email: string,
  query: string,
  k = 8,
  filter?: BrainFilter,
): Promise<{ hits: BrainHit[]; error: string | null }> {
  const trimmed = query.trim()
  if (!email || !trimmed) return { hits: [], error: null }
  const f: Record<string, unknown> = {}
  if (filter?.type?.length) f.type = filter.type
  if (filter?.source?.length) f.source = filter.source
  if (filter?.folder) f.folder = filter.folder
  if (filter?.since) f.since = filter.since
  if (filter?.until) f.until = filter.until
  const r = await run(
    connectionId,
    `SELECT doc_id, title, folder_path, source, doc_type, occurred_at::text AS occurred_at, chunk, score
       FROM rvbbit.ask_brain(${q(email)}, ${q(trimmed)}, ${Math.max(1, Math.min(Math.floor(k), 50))}, ${q(JSON.stringify(f))}::jsonb)`,
  )
  if (!r.ok) return { hits: [], error: r.error }
  return {
    hits: r.rows.map((row) => ({
      docId: Number(row.doc_id),
      title: String(row.title ?? ""),
      folderPath: String(row.folder_path ?? "/"),
      source: String(row.source ?? ""),
      docType: str(row.doc_type),
      occurredAt: str(row.occurred_at),
      chunk: String(row.chunk ?? ""),
      score: num(row.score),
    })),
    error: null,
  }
}
