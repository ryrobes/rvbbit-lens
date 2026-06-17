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

async function run(connectionId: string, sql: string, rowLimit = 5000): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit }),
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
  occurredAt: string | null
  chunk: string
  score: number | null
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
}

/** All configured sources + their live doc counts + remote config. */
export async function fetchSources(connectionId: string): Promise<{ sources: BrainSource[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT s.source_id, s.label, s.kind, s.enabled, s.creds_ref,
            s.config->>'endpoint' AS endpoint, s.config->'folders' AS folders,
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
    })),
    error: null,
  }
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

/** Trigger a sync now (connector → manifest → extract → reconcile). Returns the run summary. */
export async function syncSourceNow(
  connectionId: string,
  sourceId: number,
): Promise<{ result: Record<string, unknown> | null; error: string | null }> {
  const r = await run(connectionId, `SELECT rvbbit.brain_sync_source(${Math.floor(sourceId)}, 'manual') AS r`, 1)
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

/** Semantic search over the identity's permitted docs (filter-before-vector-search). */
export async function askBrain(
  connectionId: string,
  email: string,
  query: string,
  k = 8,
): Promise<{ hits: BrainHit[]; error: string | null }> {
  const trimmed = query.trim()
  if (!email || !trimmed) return { hits: [], error: null }
  const r = await run(
    connectionId,
    `SELECT doc_id, title, folder_path, source, occurred_at::text AS occurred_at, chunk, score
       FROM rvbbit.ask_brain(${q(email)}, ${q(trimmed)}, ${Math.max(1, Math.min(Math.floor(k), 50))})`,
  )
  if (!r.ok) return { hits: [], error: r.error }
  return {
    hits: r.rows.map((row) => ({
      docId: Number(row.doc_id),
      title: String(row.title ?? ""),
      folderPath: String(row.folder_path ?? "/"),
      source: String(row.source ?? ""),
      occurredAt: str(row.occurred_at),
      chunk: String(row.chunk ?? ""),
      score: num(row.score),
    })),
    error: null,
  }
}
