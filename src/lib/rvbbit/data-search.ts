"use client"

/**
 * Catalog "Data Search" data layer.
 *
 * Mirrors the shape of [[kg]]/kg.ts — typed rows + targeted fetchers, each
 * composable from the Data Search window. Everything is SQL-first against the
 * `db_catalog` knowledge graph + `rvbbit.catalog_docs` fingerprint store built
 * by `rvbbit.catalog_crawl()` (see docs/CATALOG_KG_PLAN.md).
 *
 * Surface used here:
 *   - rvbbit.data_search(query, k, kinds, graph)   → ranked table/column hits
 *   - rvbbit.catalog_crawl(schemas, graph, ...)    → (re)build the catalog
 *   - rvbbit.kg_nodes / rvbbit.catalog_docs / rvbbit.catalog_runs (status)
 */

export const CATALOG_GRAPH = "db_catalog"

export type CatalogKind = "db_table" | "db_column" | (string & {})

export interface DataSearchHit {
  nodeId: number
  kind: CatalogKind
  schema: string
  rel: string
  /** null for table hits, the column name for column hits */
  col: string | null
  /** normalized hybrid relevance in [0,1] (RRF-fused dense+lexical; top hit = 1.0) */
  score: number | null
  doc: string
  /** # incident KG edges (subject+object) — the node's connectedness / "hub-ness" */
  degree: number
  /** # DISTINCT source rows that mention this entity (distinct evidence source_pk) —
   *  the real "semantic frequency": how many reports a concept recurs across, after
   *  embedding entity-resolution merges near-duplicate mentions. Drives size/heat. */
  frequency: number
}

export interface CatalogStatus {
  /** false when the catalog SQL functions/tables are not installed yet */
  installed: boolean
  tables: number
  columns: number
  docs: number
  embedded: number
  lastRunAt: number | null
  lastStatus: string | null
}

export interface CatalogCrawlResult {
  runId: number | null
  tables: number
  columns: number
  edges: number
  docsEmbedded: number
}

// ── Query plumbing (mirrors kg.ts) ──────────────────────────────────

interface QueryOk {
  ok: true
  columns: { name: string }[]
  rows: Array<Record<string, unknown>>
}
interface QueryErr {
  ok: false
  error: string
}

async function runQuery(
  connectionId: string,
  sql: string,
  rowLimit = 2000,
  opts: { statementTimeout?: number } = {},
): Promise<QueryOk | QueryErr> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, statementTimeout: opts.statementTimeout }),
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
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function epoch(v: unknown): number | null {
  return v ? new Date(String(v)).getTime() : null
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function sqlTextArray(items: string[] | null | undefined): string {
  if (!items || items.length === 0) return "NULL"
  return `ARRAY[${items.map(sqlStr).join(", ")}]::text[]`
}

// ── Free-text search ─────────────────────────────────────────────────

export async function searchData(
  connectionId: string,
  query: string,
  k: number = 25,
  kinds: CatalogKind[] | null = null,
  graph: string = CATALOG_GRAPH,
): Promise<{ hits: DataSearchHit[]; error?: string }> {
  if (!query.trim()) return { hits: [] }
  const lim = Math.max(1, Math.min(200, k))
  const g = sqlStr(graph)
  const canFallbackToKgNodes = graph !== CATALOG_GRAPH
  // Wrap data_search to attach, per hit: DEGREE (incident edges = connectedness) and
  // FREQUENCY (distinct source rows mentioning the entity = recurrence across reports).
  // Both are single hash-joinable aggregates over the existing kg_edges/kg_evidence
  // indexes, so this works against the shipped extension with no migration.
  const res = await runQuery(
    connectionId,
    `WITH s AS (
       SELECT node_id, kind, schema_name, rel_name, col_name, score, doc
         FROM rvbbit.data_search(${sqlStr(query.trim())}, ${lim}, ${sqlTextArray(kinds)}, ${g})),
     deg AS (
       SELECT s.node_id, count(e.edge_id) AS degree
         FROM s
         JOIN rvbbit.kg_edges e
           ON e.graph_id = ${g}
          AND (e.subject_node_id = s.node_id OR e.object_node_id = s.node_id)
        GROUP BY s.node_id),
     freq AS (
       SELECT s.node_id, count(DISTINCT ev.source_pk) AS frequency
         FROM s
         JOIN rvbbit.kg_edges e
           ON e.graph_id = ${g}
          AND (e.subject_node_id = s.node_id OR e.object_node_id = s.node_id)
         JOIN rvbbit.kg_evidence ev
           ON ev.graph_id = ${g} AND ev.edge_id = e.edge_id
        GROUP BY s.node_id)
     SELECT s.node_id, s.kind, s.schema_name, s.rel_name, s.col_name, s.score, s.doc,
            COALESCE(d.degree, 0) AS degree, COALESCE(f.frequency, 0) AS frequency
       FROM s
       LEFT JOIN deg d ON d.node_id = s.node_id
       LEFT JOIN freq f ON f.node_id = s.node_id
      ORDER BY s.score DESC NULLS LAST`,
  )
  if (!res.ok) {
    if (canFallbackToKgNodes) {
      const fallback = await searchKgNodes(connectionId, query, lim, kinds, graph)
      if (!fallback.error) return fallback
    }
    return { hits: [], error: res.error }
  }
  const hits = res.rows.map((r) => ({
    nodeId: num(r.node_id),
    kind: (String(r.kind ?? "db_column") as CatalogKind),
    schema: String(r.schema_name ?? ""),
    rel: String(r.rel_name ?? ""),
    col: strOrNull(r.col_name),
    score: numOrNull(r.score),
    doc: String(r.doc ?? ""),
    degree: num(r.degree),
    frequency: num(r.frequency),
  }))
  if (hits.length === 0 && canFallbackToKgNodes) return searchKgNodes(connectionId, query, lim, kinds, graph)
  return { hits }
}

async function searchKgNodes(
  connectionId: string,
  query: string,
  k: number,
  kinds: CatalogKind[] | null,
  graph: string,
): Promise<{ hits: DataSearchHit[]; error?: string }> {
  const q = query.trim()
  if (!q) return { hits: [] }
  const g = sqlStr(graph)
  const res = await runQuery(
    connectionId,
    `WITH node_docs AS (
       SELECT n.node_id, n.kind, n.label, n.confidence, n.properties,
              left(concat_ws(E'\\n',
                n.kind || ': ' || n.label,
                NULLIF(n.properties::text, '{}'),
                rels.relation_text
              ), 32768) AS doc
         FROM rvbbit.kg_nodes n
         LEFT JOIN LATERAL (
           SELECT string_agg(DISTINCT concat_ws(' ', e.predicate, other.label), ' ') AS relation_text
             FROM rvbbit.kg_edges e
             JOIN rvbbit.kg_nodes other
               ON other.graph_id = e.graph_id
              AND other.node_id = CASE
                    WHEN e.subject_node_id = n.node_id THEN e.object_node_id
                    ELSE e.subject_node_id
                  END
            WHERE e.graph_id = ${g}
              AND (e.subject_node_id = n.node_id OR e.object_node_id = n.node_id)
         ) rels ON true
        WHERE n.graph_id = ${g}
          AND (${sqlTextArray(kinds)} IS NULL OR n.kind = ANY (${sqlTextArray(kinds)}))
     ),
     scored AS (
       SELECT nd.*,
              (CASE WHEN lower(nd.label) LIKE lower(${sqlStr(q)}) || '%' THEN 4 ELSE 0 END
               + CASE WHEN position(lower(${sqlStr(q)}) IN lower(nd.label)) > 0 THEN 3 ELSE 0 END
               + CASE WHEN position(lower(${sqlStr(q)}) IN lower(nd.kind)) > 0 THEN 1.5 ELSE 0 END
               + CASE WHEN position(lower(${sqlStr(q)}) IN lower(nd.doc)) > 0 THEN 1 ELSE 0 END
               + ts_rank_cd(to_tsvector('english', nd.doc), websearch_to_tsquery('english', ${sqlStr(q)}))
              )::float8 AS raw_score
         FROM node_docs nd
     ),
     hits AS (
       SELECT *
         FROM scored
        WHERE raw_score > 0
        ORDER BY raw_score DESC, confidence DESC NULLS LAST, node_id
        LIMIT ${k}
     ),
     deg AS (
       SELECT h.node_id, count(e.edge_id) AS degree
         FROM hits h
         JOIN rvbbit.kg_edges e
           ON e.graph_id = ${g}
          AND (e.subject_node_id = h.node_id OR e.object_node_id = h.node_id)
        GROUP BY h.node_id
     ),
     freq AS (
       SELECT h.node_id, count(DISTINCT ev.source_pk) AS frequency
         FROM hits h
         LEFT JOIN rvbbit.kg_edges e
           ON e.graph_id = ${g}
          AND (e.subject_node_id = h.node_id OR e.object_node_id = h.node_id)
         JOIN rvbbit.kg_evidence ev
           ON ev.graph_id = ${g}
          AND (ev.node_id = h.node_id OR ev.edge_id = e.edge_id)
        GROUP BY h.node_id
     )
     SELECT h.node_id, h.kind, h.label,
            h.raw_score / NULLIF(max(h.raw_score) OVER (), 0) AS score,
            h.doc, COALESCE(d.degree, 0) AS degree, COALESCE(f.frequency, 0) AS frequency
       FROM hits h
       LEFT JOIN deg d ON d.node_id = h.node_id
       LEFT JOIN freq f ON f.node_id = h.node_id
      ORDER BY h.raw_score DESC, h.confidence DESC NULLS LAST, h.node_id`,
  )
  if (!res.ok) return { hits: [], error: res.error }
  return {
    hits: res.rows.map((r) => ({
      nodeId: num(r.node_id),
      kind: (String(r.kind ?? "entity") as CatalogKind),
      schema: "kg",
      rel: String(r.label ?? ""),
      col: null,
      score: numOrNull(r.score),
      doc: String(r.doc ?? r.label ?? ""),
      degree: num(r.degree),
      frequency: num(r.frequency),
    })),
  }
}

// ── Catalog status (counts + last run) ───────────────────────────────

export async function fetchCatalogStatus(connectionId: string): Promise<CatalogStatus> {
  const empty: CatalogStatus = {
    installed: false,
    tables: 0,
    columns: 0,
    docs: 0,
    embedded: 0,
    lastRunAt: null,
    lastStatus: null,
  }
  // Probe install state first so a missing table/function can't error the counts.
  const probe = await runQuery(
    connectionId,
    `SELECT to_regclass('rvbbit.catalog_docs') IS NOT NULL
        AND to_regprocedure('rvbbit.data_search(text,integer,text[],text)') IS NOT NULL AS installed`,
  )
  if (!probe.ok || !probe.rows[0]?.installed) return empty

  const res = await runQuery(
    connectionId,
    `SELECT
       (SELECT count(*) FROM rvbbit.kg_nodes
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)} AND kind = 'db_table')   AS tables,
       (SELECT count(*) FROM rvbbit.kg_nodes
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)} AND kind = 'db_column')  AS columns,
       (SELECT count(*) FROM rvbbit.catalog_docs
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)})                          AS docs,
       (SELECT count(*) FROM rvbbit.catalog_docs
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)} AND embedding IS NOT NULL) AS embedded,
       (SELECT max(finished_at) FROM rvbbit.catalog_runs
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)})                          AS last_run_at,
       (SELECT status FROM rvbbit.catalog_runs
         WHERE graph_id = ${sqlStr(CATALOG_GRAPH)} ORDER BY run_id DESC LIMIT 1) AS last_status`,
  )
  if (!res.ok || res.rows.length === 0) return { ...empty, installed: true }
  const r = res.rows[0]
  return {
    installed: true,
    tables: num(r.tables),
    columns: num(r.columns),
    docs: num(r.docs),
    embedded: num(r.embedded),
    lastRunAt: epoch(r.last_run_at),
    lastStatus: strOrNull(r.last_status),
  }
}

// ── Embedder health ──────────────────────────────────────────────────

export interface EmbedderHealth {
  /** True when rvbbit.embed returned a usable query vector. */
  ok: boolean
  /** Vector dimension returned by the live embedder, when ok. */
  dim: number | null
  error?: string
}

/**
 * Probe the embedder that `data_search` relies on for its dense ranker.
 *
 * data_search embeds the query with `rvbbit.embed(query,'','query')` and
 * SWALLOWS any failure (v_q := NULL), silently degrading to lexical-only
 * — so a semantic query with no keyword overlap returns nothing even
 * though the catalog is fully embedded. KG browsing needs no embedder, so
 * it keeps working, which makes the failure look mysterious. This probe
 * lets the UI say "semantic search is down" instead of "no matches".
 */
export async function probeEmbedder(connectionId: string): Promise<EmbedderHealth> {
  const res = await runQuery(
    connectionId,
    `SELECT array_length(rvbbit.embed('rvbbit data-search health probe', '', 'query'), 1) AS dim`,
  )
  if (!res.ok) return { ok: false, dim: null, error: res.error }
  const dim = numOrNull(res.rows[0]?.dim)
  if (dim == null || dim <= 0) {
    return { ok: false, dim: null, error: "embedder returned no vector" }
  }
  return { ok: true, dim }
}

// ── (Re)crawl the catalog ────────────────────────────────────────────

export async function crawlCatalog(
  connectionId: string,
  opts: { schemas?: string[] | null; doEmbed?: boolean } = {},
): Promise<{ result?: CatalogCrawlResult; error?: string }> {
  // The crawl fingerprints every table (count/distinct/quantiles per column +
  // embeddings) and can run for many minutes over a large schema. We CALL the
  // durable PROCEDURE form (rvbbit.catalog_crawl_run): it COMMITs after each
  // table and logs progress to rvbbit.catalog_crawl_progress, so the work
  // survives interruption with partial results and can be watched table-by-table
  // (vs. the all-or-nothing SELECT rvbbit.catalog_crawl() function, where a
  // cancel/error at minute 30 rolls back everything). statement_timeout is also
  // disabled so it runs to completion; a single bad table is logged and skipped
  // rather than capping the whole crawl.
  const res = await runQuery(
    connectionId,
    `CALL rvbbit.catalog_crawl_run(
       schemas  => ${sqlTextArray(opts.schemas)},
       graph    => ${sqlStr(CATALOG_GRAPH)},
       do_embed => ${opts.doEmbed === false ? "false" : "true"}
     )`,
    1,
    { statementTimeout: 0 },
  )
  if (!res.ok) return { error: res.error }
  // The procedure returns no rows; read its summary back from catalog_runs.
  const sum = await runQuery(
    connectionId,
    `SELECT run_id, tables_seen, columns_seen, edges_made, docs_embedded
       FROM rvbbit.catalog_runs
      WHERE graph_id = ${sqlStr(CATALOG_GRAPH)}
      ORDER BY run_id DESC
      LIMIT 1`,
    1,
  )
  const raw = (sum.ok ? sum.rows[0] : undefined) ?? ({} as Record<string, unknown>)
  return {
    result: {
      runId: numOrNull(raw.run_id),
      tables: num(raw.tables_seen),
      columns: num(raw.columns_seen),
      edges: num(raw.edges_made),
      docsEmbedded: num(raw.docs_embedded),
    },
  }
}

// ── Display helpers ──────────────────────────────────────────────────

/** Fully-qualified KG label for a hit (matches the crawler's node labels). */
export function hitLabel(h: DataSearchHit): string {
  return h.col ? `${h.schema}.${h.rel}.${h.col}` : `${h.schema}.${h.rel}`
}

/** Collapse a fingerprint doc to a one-line preview. */
export function shortDoc(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, max - 1) + "…"
}
