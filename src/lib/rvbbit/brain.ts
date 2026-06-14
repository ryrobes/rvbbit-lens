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
