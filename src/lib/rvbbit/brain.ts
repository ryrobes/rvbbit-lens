/**
 * Data layer for the Document Intelligence brain (rvbbit.brain_*) — role-gated docs.
 * Every read is parameterized by a "View as <email>" identity, so the file explorer
 * doubles as an ACL inspector: switch identity → watch folders/docs appear & vanish.
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

async function run(connectionId: string, sql: string, rowLimit = 5000, statementTimeout?: number): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, ...(statementTimeout != null ? { statementTimeout } : {}) }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal (the query API has no bind params). */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function num(v: unknown): number | null {
  return v == null ? null : Number(v)
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
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
  const r = await run(connectionId, `SELECT facet, value, docs FROM rvbbit.brain_facets(${q(email)})`)
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
  const r = await run(connectionId, `SELECT DISTINCT principal FROM rvbbit.brain_role_members ORDER BY principal`)
  if (!r.ok) return []
  return r.rows.map((row) => String(row.principal))
}

/** Every folder + doc the given identity may see (ACL-enforced server-side). */
export async function fetchBrainTree(
  connectionId: string,
  email: string,
): Promise<{ docs: BrainDoc[]; error: string | null }> {
  if (!email) return { docs: [], error: null }
  const r = await run(
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
  const r = await run(
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
  const r = await run(connectionId, `SELECT role, members, docs FROM rvbbit.brain_list_roles()`)
  if (!r.ok) return []
  return r.rows.map((row) => ({ role: String(row.role), members: Number(row.members ?? 0), docs: Number(row.docs ?? 0) }))
}

/** Members (emails) of the given roles. */
export async function fetchRoleMembers(connectionId: string, roles: string[]): Promise<{ role: string; principal: string }[]> {
  if (!roles.length) return []
  const r = await run(connectionId, `SELECT role, principal FROM rvbbit.brain_role_member_list(${arr(roles)})`)
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
  const r = await run(
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
  const r = await run(connectionId, `SELECT rvbbit.brain_get_doc(${q(email)}, ${Math.floor(docId)}) AS d`)
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
  const r = await run(
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
  const r = await run(
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

/** Create/update a remote source (gdrive, …). config carries endpoint + folders. */
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
  const r = await run(
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
  const r = await run(
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
  const r = await run(
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
  const r = await run(
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
  const r = await run(
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
    0,
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
