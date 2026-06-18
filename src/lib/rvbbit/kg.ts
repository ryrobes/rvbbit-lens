"use client"

/**
 * Knowledge Graph data layer.
 *
 * Mirrors the shape of [[query-lens]]/lens.ts — typed rows + targeted
 * fetchers, each independently composable from any KG window.
 *
 * The KG is intentionally SQL-first per docs/KNOWLEDGE_GRAPH.md;
 * everything here is a thin shim that issues the queries from that
 * doc's "UI Builder Guide" section.
 */

export interface KgGraphSummary {
  graphId: string
  nodes: number
  edges: number
  evidenceRows: number
  lastActivity: number | null
}

export interface KgKindCount {
  kind: string
  count: number
}

export interface KgPredicateCount {
  predicate: string
  count: number
  avgConfidence: number | null
}

export interface KgShape {
  kinds: KgKindCount[]
  predicates: KgPredicateCount[]
}

export interface KgNodeSearchHit {
  nodeId: number
  graphId: string
  kind: string
  label: string
  confidence: number | null
  updatedAt: number | null
}

export interface KgNodeAlias {
  aliasId: number
  alias: string
  confidence: number | null
  properties: unknown
}

export interface KgEntityDetail {
  nodeId: number
  graphId: string
  kind: string
  label: string
  confidence: number | null
  properties: unknown
  createdAt: number | null
  updatedAt: number | null
  aliases: KgNodeAlias[]
  evidenceCount: number
}

export interface KgNeighbor {
  edgeId: number
  fromNodeId: number
  fromKind: string
  fromLabel: string
  toNodeId: number
  toKind: string
  toLabel: string
  predicate: string
  direction: "out" | "in"
  edgeConfidence: number | null
  edgeProperties: unknown
  depth: number
  /** raw kg_nodes.properties for each endpoint — populated by the by-id fetch only */
  fromProps?: unknown
  toProps?: unknown
  /** incident-edge count for each endpoint — the connectedness signal */
  fromDegree?: number
  toDegree?: number
  /** distinct source rows mentioning each endpoint — the frequency that drives
   *  data-layer node size/heat (kept consistent with bloom hits) */
  fromFrequency?: number
  toFrequency?: number
}

export interface KgEvidenceRow {
  evidenceId: number
  edgeId: number | null
  nodeId: number | null
  queryId: string | null
  sourceTable: string | null
  sourcePk: string | null
  sourceColumn: string | null
  evidenceText: string | null
  confidence: number | null
  properties: unknown
  createdAt: number | null
}

export interface KgRagContextRow {
  contextRank: number
  score: number
  depth: number
  predicate: string
  edgeDirection: "out" | "in"
  fromKind: string
  fromLabel: string
  fromNodeId: number
  toKind: string
  toLabel: string
  toNodeId: number
  edgeId: number
  evidenceCount: number
  evidence: unknown
}

export interface KgRecentRun {
  runId: number
  graphId: string
  queryId: string | null
  sourceTable: string | null
  sourceColumn: string | null
  focus: string | null
  status: string
  rowsSeen: number
  triplesInserted: number
  errors: number
  createdAt: number | null
  finishedAt: number | null
}

export interface KgRecentMerge {
  mergeId: number
  graphId: string
  queryId: string | null
  winnerNodeId: number
  loserLabel: string | null
  createdAt: number | null
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
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function epoch(v: unknown): number | null {
  return v ? new Date(String(v)).getTime() : null
}
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}
function sqlBigintArray(items: number[]): string {
  const ids = items
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (ids.length === 0) return "ARRAY[]::bigint[]"
  return `ARRAY[${Array.from(new Set(ids)).join(", ")}]::bigint[]`
}

// ── Graph-level: graphs + shape + activity ──────────────────────────

export async function fetchGraphs(
  connectionId: string,
): Promise<{ rows: KgGraphSummary[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `WITH graphs AS (
       SELECT graph_id FROM rvbbit.kg_nodes
       UNION
       SELECT graph_id FROM rvbbit.kg_edges
       UNION
       SELECT graph_id FROM rvbbit.kg_evidence
     )
     SELECT g.graph_id,
            COALESCE(n.nodes, 0) AS nodes,
            COALESCE(e.edges, 0) AS edges,
            COALESCE(ev.evidence_rows, 0) AS evidence_rows,
            GREATEST(n.updated_at, e.updated_at, ev.updated_at) AS last_activity
     FROM graphs g
     LEFT JOIN (
       SELECT graph_id, count(*) AS nodes, max(updated_at) AS updated_at
       FROM rvbbit.kg_nodes GROUP BY graph_id
     ) n USING (graph_id)
     LEFT JOIN (
       SELECT graph_id, count(*) AS edges, max(updated_at) AS updated_at
       FROM rvbbit.kg_edges GROUP BY graph_id
     ) e USING (graph_id)
     LEFT JOIN (
       SELECT graph_id, count(*) AS evidence_rows, max(created_at) AS updated_at
       FROM rvbbit.kg_evidence GROUP BY graph_id
     ) ev USING (graph_id)
     ORDER BY last_activity DESC NULLS LAST, g.graph_id`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return {
    rows: res.rows.map((r) => ({
      graphId: String(r.graph_id ?? ""),
      nodes: num(r.nodes),
      edges: num(r.edges),
      evidenceRows: num(r.evidence_rows),
      lastActivity: epoch(r.last_activity),
    })),
  }
}

export async function fetchGraphShape(
  connectionId: string,
  graphId: string,
): Promise<{ shape: KgShape; error?: string }> {
  const [kindsRes, predsRes] = await Promise.all([
    runQuery(
      connectionId,
      `SELECT kind, count(*) AS n
       FROM rvbbit.kg_nodes WHERE graph_id = ${sqlStr(graphId)}
       GROUP BY kind ORDER BY n DESC, kind`,
    ),
    runQuery(
      connectionId,
      `SELECT predicate, count(*) AS n, avg(confidence) AS avg_conf
       FROM rvbbit.kg_edges WHERE graph_id = ${sqlStr(graphId)}
       GROUP BY predicate ORDER BY n DESC, predicate`,
    ),
  ])
  const kinds: KgKindCount[] = kindsRes.ok
    ? kindsRes.rows.map((r) => ({ kind: String(r.kind ?? ""), count: num(r.n) }))
    : []
  const predicates: KgPredicateCount[] = predsRes.ok
    ? predsRes.rows.map((r) => ({
        predicate: String(r.predicate ?? ""),
        count: num(r.n),
        avgConfidence: numOrNull(r.avg_conf),
      }))
    : []
  const err = !kindsRes.ok ? kindsRes.error : !predsRes.ok ? predsRes.error : undefined
  return { shape: { kinds, predicates }, error: err }
}

export async function fetchRecentRuns(
  connectionId: string,
  graphId: string,
  limit: number = 10,
): Promise<KgRecentRun[]> {
  const lim = Math.max(1, Math.min(100, limit))
  const res = await runQuery(
    connectionId,
    `SELECT run_id, graph_id, query_id::text AS query_id,
            source_table::text AS source_table, source_column, focus,
            status, rows_seen, triples_inserted, errors,
            created_at, finished_at
     FROM rvbbit.kg_extraction_runs WHERE graph_id = ${sqlStr(graphId)}
     ORDER BY created_at DESC LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: num(r.run_id),
    graphId: String(r.graph_id ?? ""),
    queryId: strOrNull(r.query_id),
    sourceTable: strOrNull(r.source_table),
    sourceColumn: strOrNull(r.source_column),
    focus: strOrNull(r.focus),
    status: String(r.status ?? ""),
    rowsSeen: num(r.rows_seen),
    triplesInserted: num(r.triples_inserted),
    errors: num(r.errors),
    createdAt: epoch(r.created_at),
    finishedAt: epoch(r.finished_at),
  }))
}

export async function fetchRecentMerges(
  connectionId: string,
  graphId: string,
  limit: number = 10,
): Promise<KgRecentMerge[]> {
  const lim = Math.max(1, Math.min(100, limit))
  const res = await runQuery(
    connectionId,
    `SELECT m.merge_id, m.graph_id, m.query_id::text AS query_id,
            m.winner_node_id, m.loser_label, m.merged_at
     FROM rvbbit.kg_node_merges m WHERE m.graph_id = ${sqlStr(graphId)}
     ORDER BY m.merged_at DESC LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    mergeId: num(r.merge_id),
    graphId: String(r.graph_id ?? ""),
    queryId: strOrNull(r.query_id),
    winnerNodeId: num(r.winner_node_id),
    loserLabel: strOrNull(r.loser_label),
    createdAt: epoch(r.merged_at),
  }))
}

// ── Node search + load ──────────────────────────────────────────────

export async function searchKgNodes(
  connectionId: string,
  graphId: string,
  kind: string | null,
  q: string,
  limit: number = 50,
): Promise<KgNodeSearchHit[]> {
  const lim = Math.max(1, Math.min(200, limit))
  const qFrag = q.trim()
    ? `AND label ILIKE ${sqlStr("%" + q.trim() + "%")}`
    : ""
  const kindFrag = kind ? `AND kind = rvbbit.kg_normalize_label(${sqlStr(kind)})` : ""
  const orderFrag = q.trim()
    ? `CASE WHEN label ILIKE ${sqlStr(q.trim() + "%")} THEN 0 ELSE 1 END,`
    : ""
  const res = await runQuery(
    connectionId,
    `SELECT node_id, graph_id, kind, label, confidence, updated_at
     FROM rvbbit.kg_nodes
     WHERE graph_id = ${sqlStr(graphId)} ${kindFrag} ${qFrag}
     ORDER BY ${orderFrag} confidence DESC NULLS LAST, updated_at DESC
     LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    nodeId: num(r.node_id),
    graphId: String(r.graph_id ?? ""),
    kind: String(r.kind ?? ""),
    label: String(r.label ?? ""),
    confidence: numOrNull(r.confidence),
    updatedAt: epoch(r.updated_at),
  }))
}

/** Resolve (graphId, kind, label) → node_id via the doc's normalized lookup. */
export async function resolveKgNodeId(
  connectionId: string,
  graphId: string,
  kind: string,
  label: string,
): Promise<number | null> {
  const res = await runQuery(
    connectionId,
    `SELECT node_id FROM rvbbit.kg_nodes
     WHERE graph_id = ${sqlStr(graphId)}
       AND kind = rvbbit.kg_normalize_label(${sqlStr(kind)})
       AND (label = ${sqlStr(label)} OR label_norm = rvbbit.kg_normalize_label(${sqlStr(label)}))
     ORDER BY confidence DESC NULLS LAST, updated_at DESC
     LIMIT 1`,
  )
  if (!res.ok || res.rows.length === 0) return null
  return num(res.rows[0].node_id)
}

export async function fetchKgEntity(
  connectionId: string,
  nodeId: number,
): Promise<{ entity: KgEntityDetail | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT n.node_id, n.graph_id, n.kind, n.label, n.confidence, n.properties,
            n.created_at, n.updated_at,
            COALESCE(a.aliases, '[]'::jsonb) AS aliases,
            COALESCE(ev.evidence_count, 0) AS node_evidence_count
     FROM rvbbit.kg_nodes n
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'alias_id', alias_id,
                  'alias', alias,
                  'confidence', confidence,
                  'properties', properties
                )
                ORDER BY confidence DESC NULLS LAST, alias
              ) AS aliases
       FROM rvbbit.kg_aliases
       WHERE graph_id = n.graph_id AND node_id = n.node_id
     ) a ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS evidence_count
       FROM rvbbit.kg_evidence
       WHERE graph_id = n.graph_id AND node_id = n.node_id
     ) ev ON true
     WHERE n.node_id = ${nodeId}`,
  )
  if (!res.ok) return { entity: null, error: res.error }
  if (res.rows.length === 0) return { entity: null }
  const r = res.rows[0]
  const aliasesRaw = (r.aliases ?? []) as Array<Record<string, unknown>>
  const aliases: KgNodeAlias[] = aliasesRaw.map((a) => ({
    aliasId: num(a.alias_id),
    alias: String(a.alias ?? ""),
    confidence: numOrNull(a.confidence),
    properties: a.properties ?? null,
  }))
  return {
    entity: {
      nodeId: num(r.node_id),
      graphId: String(r.graph_id ?? ""),
      kind: String(r.kind ?? ""),
      label: String(r.label ?? ""),
      confidence: numOrNull(r.confidence),
      properties: r.properties ?? null,
      createdAt: epoch(r.created_at),
      updatedAt: epoch(r.updated_at),
      aliases,
      evidenceCount: num(r.node_evidence_count),
    },
  }
}

// ── Neighbors, Evidence, RAG context ────────────────────────────────

export async function fetchKgNeighbors(
  connectionId: string,
  graphId: string,
  kind: string,
  label: string,
  maxDepth: number = 1,
  direction: "out" | "in" | "both" = "both",
): Promise<KgNeighbor[]> {
  const res = await runQuery(
    connectionId,
    `SELECT * FROM rvbbit.kg_neighbors(
       node_kind => ${sqlStr(kind)},
       node_label => ${sqlStr(label)},
       max_depth => ${Math.max(1, Math.min(3, maxDepth))},
       direction => ${sqlStr(direction)},
       specialist => '',
       match_threshold => 0.0,
       graph => ${sqlStr(graphId)}
     )`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    edgeId: num(r.edge_id),
    fromNodeId: num(r.from_node_id),
    fromKind: String(r.from_kind ?? ""),
    fromLabel: String(r.from_label ?? ""),
    toNodeId: num(r.to_node_id),
    toKind: String(r.to_kind ?? ""),
    toLabel: String(r.to_label ?? ""),
    predicate: String(r.predicate ?? ""),
    direction: r.edge_direction === "in" ? "in" : "out",
    edgeConfidence: numOrNull(r.edge_confidence),
    edgeProperties: r.edge_properties ?? null,
    depth: num(r.depth),
  }))
}

/**
 * Neighbors of a node BY node_id (robust: depends only on the indexed
 * subject/object columns, never on label resolution). Each row is one edge with
 * both endpoints denormalized + their kg_nodes.properties for reconstruction.
 * Used by Scry's spider expansion. `LIMIT cap+1` is a truncation sentinel.
 */
export async function fetchKgNeighborsById(
  connectionId: string,
  graphId: string,
  nodeId: number,
  maxEdges: number = 60,
): Promise<KgNeighbor[]> {
  const cap = Math.max(1, Math.min(200, maxEdges))
  const res = await runQuery(
    connectionId,
    `WITH outbound AS (
       SELECT e.edge_id, e.subject_node_id AS from_id, e.object_node_id AS to_id,
              e.predicate, e.confidence, e.properties, 'out'::text AS dir
       FROM rvbbit.kg_edges e
       WHERE e.graph_id = ${sqlStr(graphId)} AND e.subject_node_id = ${Number(nodeId)}
     ),
     inbound AS (
       SELECT e.edge_id, e.object_node_id AS from_id, e.subject_node_id AS to_id,
              e.predicate, e.confidence, e.properties, 'in'::text AS dir
       FROM rvbbit.kg_edges e
       WHERE e.graph_id = ${sqlStr(graphId)} AND e.object_node_id = ${Number(nodeId)}
     ),
     merged AS (SELECT * FROM outbound UNION ALL SELECT * FROM inbound),
     -- trim to the cap FIRST, then compute endpoint degrees only for the kept rows
     -- (a hub node can have far more incident edges than the cap; computing degree in
     -- the projected SELECT would run it for every edge before LIMIT prunes).
     trimmed AS (
       SELECT m.edge_id,
              m.from_id, fn.kind AS from_kind, fn.label AS from_label, fn.properties AS from_props,
              m.to_id,   tn.kind AS to_kind,   tn.label AS to_label,   tn.properties AS to_props,
              m.predicate, m.dir, m.confidence, m.properties AS edge_properties
       FROM merged m
       JOIN rvbbit.kg_nodes fn ON fn.node_id = m.from_id
       JOIN rvbbit.kg_nodes tn ON tn.node_id = m.to_id
       ORDER BY m.confidence DESC NULLS LAST, m.edge_id
       LIMIT ${cap + 1}
     )
     SELECT t.edge_id,
            t.from_id AS from_node_id, t.from_kind, t.from_label, t.from_props,
            (SELECT count(*) FROM rvbbit.kg_edges e2
              WHERE e2.graph_id = ${sqlStr(graphId)}
                AND (e2.subject_node_id = t.from_id OR e2.object_node_id = t.from_id)) AS from_degree,
            (SELECT count(DISTINCT ev.source_pk) FROM rvbbit.kg_evidence ev
              JOIN rvbbit.kg_edges e4 ON e4.edge_id = ev.edge_id
              WHERE ev.graph_id = ${sqlStr(graphId)}
                AND (e4.subject_node_id = t.from_id OR e4.object_node_id = t.from_id)) AS from_frequency,
            t.to_id AS to_node_id, t.to_kind, t.to_label, t.to_props,
            (SELECT count(*) FROM rvbbit.kg_edges e3
              WHERE e3.graph_id = ${sqlStr(graphId)}
                AND (e3.subject_node_id = t.to_id OR e3.object_node_id = t.to_id)) AS to_degree,
            (SELECT count(DISTINCT ev.source_pk) FROM rvbbit.kg_evidence ev
              JOIN rvbbit.kg_edges e5 ON e5.edge_id = ev.edge_id
              WHERE ev.graph_id = ${sqlStr(graphId)}
                AND (e5.subject_node_id = t.to_id OR e5.object_node_id = t.to_id)) AS to_frequency,
            t.predicate, t.dir AS edge_direction,
            t.confidence AS edge_confidence, t.edge_properties
     FROM trimmed t`,
  )
  // Throw on error so callers can distinguish a real failure (retryable) from a
  // legitimate zero-neighbor leaf node (an empty array).
  if (!res.ok) throw new Error(res.error || "kg neighbor fetch failed")
  return res.rows.map((r) => ({
    edgeId: num(r.edge_id),
    fromNodeId: num(r.from_node_id),
    fromKind: String(r.from_kind ?? ""),
    fromLabel: String(r.from_label ?? ""),
    toNodeId: num(r.to_node_id),
    toKind: String(r.to_kind ?? ""),
    toLabel: String(r.to_label ?? ""),
    predicate: String(r.predicate ?? ""),
    direction: r.edge_direction === "in" ? "in" : "out",
    edgeConfidence: numOrNull(r.edge_confidence),
    edgeProperties: r.edge_properties ?? null,
    depth: 1,
    fromProps: r.from_props ?? null,
    toProps: r.to_props ?? null,
    fromDegree: num(r.from_degree),
    toDegree: num(r.to_degree),
    fromFrequency: num(r.from_frequency),
    toFrequency: num(r.to_frequency),
  }))
}

export interface KgNeighborhoodNode {
  nodeId: number
  graphId: string
  kind: string
  label: string
  confidence: number | null
  properties: unknown
  degree: number
  frequency: number
  isSeed: boolean
}

export interface KgNeighborhoodEdge {
  edgeId: number
  fromNodeId: number
  toNodeId: number
  predicate: string
  confidence: number | null
  properties: unknown
  evidenceCount: number
  connectsSeeds: boolean
}

export interface KgNeighborhood {
  nodes: KgNeighborhoodNode[]
  edges: KgNeighborhoodEdge[]
}

export async function fetchKgNeighborhoodByNodeIds(
  connectionId: string,
  graphId: string,
  nodeIds: number[],
  maxEdges: number = 900,
): Promise<{ neighborhood: KgNeighborhood; error?: string }> {
  const seedArray = sqlBigintArray(nodeIds)
  if (seedArray === "ARRAY[]::bigint[]") return { neighborhood: { nodes: [], edges: [] } }
  const edgeLimit = Math.max(1, Math.min(3000, maxEdges))
  const res = await runQuery(
    connectionId,
    `WITH seeds AS (
       SELECT DISTINCT unnest(${seedArray}) AS node_id
     ),
     ranked_edges AS (
       SELECT e.edge_id, e.subject_node_id, e.object_node_id, e.predicate,
              e.confidence, e.properties,
              (e.subject_node_id IN (SELECT node_id FROM seeds)
               AND e.object_node_id IN (SELECT node_id FROM seeds)) AS connects_seeds,
              (SELECT count(*) FROM rvbbit.kg_evidence ev
                WHERE ev.graph_id = ${sqlStr(graphId)} AND ev.edge_id = e.edge_id) AS evidence_count
       FROM rvbbit.kg_edges e
       WHERE e.graph_id = ${sqlStr(graphId)}
         AND (e.subject_node_id IN (SELECT node_id FROM seeds)
              OR e.object_node_id IN (SELECT node_id FROM seeds))
       ORDER BY connects_seeds DESC, e.confidence DESC NULLS LAST, e.edge_id
       LIMIT ${edgeLimit}
     ),
     endpoint_ids AS (
       SELECT node_id FROM seeds
       UNION
       SELECT subject_node_id FROM ranked_edges
       UNION
       SELECT object_node_id FROM ranked_edges
     ),
     node_rows AS (
       SELECT n.node_id, n.graph_id, n.kind, n.label, n.confidence, n.properties,
              n.node_id IN (SELECT node_id FROM seeds) AS is_seed,
              (SELECT count(*) FROM rvbbit.kg_edges e2
                WHERE e2.graph_id = ${sqlStr(graphId)}
                  AND (e2.subject_node_id = n.node_id OR e2.object_node_id = n.node_id)) AS degree,
              (SELECT count(DISTINCT ev.source_pk)
                 FROM rvbbit.kg_evidence ev
                 JOIN rvbbit.kg_edges e3 ON e3.edge_id = ev.edge_id
                WHERE ev.graph_id = ${sqlStr(graphId)}
                  AND (e3.subject_node_id = n.node_id OR e3.object_node_id = n.node_id)) AS frequency
       FROM rvbbit.kg_nodes n
       WHERE n.graph_id = ${sqlStr(graphId)}
         AND n.node_id IN (SELECT node_id FROM endpoint_ids)
     )
     SELECT
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'node_id', node_id,
          'graph_id', graph_id,
          'kind', kind,
          'label', label,
          'confidence', confidence,
          'properties', properties,
          'degree', degree,
          'frequency', frequency,
          'is_seed', is_seed
        ) ORDER BY is_seed DESC, degree DESC, node_id), '[]'::jsonb) FROM node_rows) AS nodes,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'edge_id', edge_id,
          'from_node_id', subject_node_id,
          'to_node_id', object_node_id,
          'predicate', predicate,
          'confidence', confidence,
          'properties', properties,
          'evidence_count', evidence_count,
          'connects_seeds', connects_seeds
        ) ORDER BY connects_seeds DESC, confidence DESC NULLS LAST, edge_id), '[]'::jsonb) FROM ranked_edges) AS edges`,
  )
  if (!res.ok) return { neighborhood: { nodes: [], edges: [] }, error: res.error }
  const row = res.rows[0] ?? {}
  const rawNodes = (row.nodes ?? []) as Array<Record<string, unknown>>
  const rawEdges = (row.edges ?? []) as Array<Record<string, unknown>>
  return {
    neighborhood: {
      nodes: rawNodes.map((n) => ({
        nodeId: num(n.node_id),
        graphId: String(n.graph_id ?? graphId),
        kind: String(n.kind ?? ""),
        label: String(n.label ?? ""),
        confidence: numOrNull(n.confidence),
        properties: n.properties ?? null,
        degree: num(n.degree),
        frequency: num(n.frequency),
        isSeed: n.is_seed === true,
      })),
      edges: rawEdges.map((e) => ({
        edgeId: num(e.edge_id),
        fromNodeId: num(e.from_node_id),
        toNodeId: num(e.to_node_id),
        predicate: String(e.predicate ?? ""),
        confidence: numOrNull(e.confidence),
        properties: e.properties ?? null,
        evidenceCount: num(e.evidence_count),
        connectsSeeds: e.connects_seeds === true,
      })),
    },
  }
}

export async function fetchKgEvidenceForNode(
  connectionId: string,
  graphId: string,
  nodeId: number,
): Promise<KgEvidenceRow[]> {
  // Pull both node-evidence AND edge-evidence for edges touching this node,
  // so the Evidence tab shows everything that contributes to the entity.
  const res = await runQuery(
    connectionId,
    `WITH touching_edges AS (
       SELECT edge_id FROM rvbbit.kg_edges
       WHERE graph_id = ${sqlStr(graphId)}
         AND (subject_node_id = ${nodeId} OR object_node_id = ${nodeId})
     )
     SELECT evidence_id, edge_id, node_id, query_id::text AS query_id,
            source_table::text AS source_table, source_pk, source_column,
            evidence_text, confidence, properties, created_at
     FROM rvbbit.kg_evidence
     WHERE graph_id = ${sqlStr(graphId)}
       AND (node_id = ${nodeId}
            OR edge_id IN (SELECT edge_id FROM touching_edges))
     ORDER BY confidence DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 200`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    evidenceId: num(r.evidence_id),
    edgeId: numOrNull(r.edge_id),
    nodeId: numOrNull(r.node_id),
    queryId: strOrNull(r.query_id),
    sourceTable: strOrNull(r.source_table),
    sourcePk: strOrNull(r.source_pk),
    sourceColumn: strOrNull(r.source_column),
    evidenceText: strOrNull(r.evidence_text),
    confidence: numOrNull(r.confidence),
    properties: r.properties ?? null,
    createdAt: epoch(r.created_at),
  }))
}

export async function fetchKgRagContext(
  connectionId: string,
  graphId: string,
  kind: string,
  label: string,
  maxDepth: number = 2,
  maxEdges: number = 50,
): Promise<KgRagContextRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT context_rank, score, depth, predicate, edge_direction,
            from_kind, from_label, from_node_id,
            to_kind, to_label, to_node_id,
            edge_id, evidence_count, evidence
     FROM rvbbit.kg_context(
       node_kind => ${sqlStr(kind)},
       node_label => ${sqlStr(label)},
       max_depth => ${Math.max(1, Math.min(3, maxDepth))},
       max_edges => ${Math.max(1, Math.min(200, maxEdges))},
       direction => 'both',
       include_evidence => true,
       specialist => '',
       match_threshold => 0.0,
       graph => ${sqlStr(graphId)},
       ranking => '{}'::jsonb
     )`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    contextRank: num(r.context_rank),
    score: num(r.score),
    depth: num(r.depth),
    predicate: String(r.predicate ?? ""),
    edgeDirection: r.edge_direction === "in" ? "in" : "out",
    fromKind: String(r.from_kind ?? ""),
    fromLabel: String(r.from_label ?? ""),
    fromNodeId: num(r.from_node_id),
    toKind: String(r.to_kind ?? ""),
    toLabel: String(r.to_label ?? ""),
    toNodeId: num(r.to_node_id),
    edgeId: num(r.edge_id),
    evidenceCount: num(r.evidence_count),
    evidence: r.evidence ?? null,
  }))
}

// ── Extraction runs + errors (Phase 3) ──────────────────────────────

export interface KgExtractionRunDetail extends KgRecentRun {
  properties: unknown
}

export interface KgExtractionError {
  errorId: number
  sourceTable: string | null
  sourcePk: string | null
  sourceColumn: string | null
  inputPreview: string | null
  error: string | null
  properties: unknown
  createdAt: number | null
}

/** Single extraction run by id, with full properties payload. */
export async function fetchExtractionRun(
  connectionId: string,
  runId: number,
): Promise<KgExtractionRunDetail | null> {
  const res = await runQuery(
    connectionId,
    `SELECT run_id, graph_id, query_id::text AS query_id,
            source_table::text AS source_table, source_column, focus,
            status, rows_seen, triples_inserted, errors,
            properties, created_at, finished_at
     FROM rvbbit.kg_extraction_runs WHERE run_id = ${runId}`,
  )
  if (!res.ok || res.rows.length === 0) return null
  const r = res.rows[0]
  return {
    runId: num(r.run_id),
    graphId: String(r.graph_id ?? ""),
    queryId: strOrNull(r.query_id),
    sourceTable: strOrNull(r.source_table),
    sourceColumn: strOrNull(r.source_column),
    focus: strOrNull(r.focus),
    status: String(r.status ?? ""),
    rowsSeen: num(r.rows_seen),
    triplesInserted: num(r.triples_inserted),
    errors: num(r.errors),
    properties: r.properties ?? null,
    createdAt: epoch(r.created_at),
    finishedAt: epoch(r.finished_at),
  }
}

export async function fetchAllExtractionRuns(
  connectionId: string,
  graphId: string | null,
  limit: number = 100,
): Promise<KgExtractionRunDetail[]> {
  const lim = Math.max(1, Math.min(500, limit))
  const where = graphId ? `WHERE graph_id = ${sqlStr(graphId)}` : ""
  const res = await runQuery(
    connectionId,
    `SELECT run_id, graph_id, query_id::text AS query_id,
            source_table::text AS source_table, source_column, focus,
            status, rows_seen, triples_inserted, errors,
            properties, created_at, finished_at
     FROM rvbbit.kg_extraction_runs ${where}
     ORDER BY created_at DESC LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    runId: num(r.run_id),
    graphId: String(r.graph_id ?? ""),
    queryId: strOrNull(r.query_id),
    sourceTable: strOrNull(r.source_table),
    sourceColumn: strOrNull(r.source_column),
    focus: strOrNull(r.focus),
    status: String(r.status ?? ""),
    rowsSeen: num(r.rows_seen),
    triplesInserted: num(r.triples_inserted),
    errors: num(r.errors),
    properties: r.properties ?? null,
    createdAt: epoch(r.created_at),
    finishedAt: epoch(r.finished_at),
  }))
}

export async function fetchExtractionErrors(
  connectionId: string,
  runId: number,
  limit: number = 200,
): Promise<KgExtractionError[]> {
  const lim = Math.max(1, Math.min(500, limit))
  const res = await runQuery(
    connectionId,
    `SELECT error_id,
            source_table::text AS source_table, source_pk, source_column,
            left(input_text, 500) AS input_preview,
            error, properties, created_at
     FROM rvbbit.kg_extraction_errors
     WHERE run_id = ${runId}
     ORDER BY error_id LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    errorId: num(r.error_id),
    sourceTable: strOrNull(r.source_table),
    sourcePk: strOrNull(r.source_pk),
    sourceColumn: strOrNull(r.source_column),
    inputPreview: strOrNull(r.input_preview),
    error: strOrNull(r.error),
    properties: r.properties ?? null,
    createdAt: epoch(r.created_at),
  }))
}

// ── Merge review (Phase 3) ──────────────────────────────────────────

export interface KgMergeCandidate {
  candidateId: number
  graphId: string
  kind: string
  score: number | null
  method: string | null
  reason: string | null
  status: string
  leftNodeId: number
  leftLabel: string
  leftProperties: unknown
  leftConfidence: number | null
  rightNodeId: number
  rightLabel: string
  rightProperties: unknown
  rightConfidence: number | null
  createdAt: number | null
}

export async function fetchMergeCandidates(
  connectionId: string,
  graphId: string | null,
  status: "pending" | "accepted" | "rejected" | "all" = "pending",
  kind: string | null = null,
  limit: number = 200,
): Promise<KgMergeCandidate[]> {
  const lim = Math.max(1, Math.min(500, limit))
  const where: string[] = []
  if (graphId) where.push(`c.graph_id = ${sqlStr(graphId)}`)
  if (status !== "all") where.push(`c.status = ${sqlStr(status)}`)
  if (kind) where.push(`c.kind = rvbbit.kg_normalize_label(${sqlStr(kind)})`)
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const res = await runQuery(
    connectionId,
    `SELECT c.candidate_id, c.graph_id, c.kind, c.score, c.method, c.reason, c.status,
            c.created_at,
            ln.node_id AS l_id, ln.label AS l_label, ln.properties AS l_props, ln.confidence AS l_conf,
            rn.node_id AS r_id, rn.label AS r_label, rn.properties AS r_props, rn.confidence AS r_conf
     FROM rvbbit.kg_merge_candidates c
     JOIN rvbbit.kg_nodes ln ON ln.node_id = c.left_node_id
     JOIN rvbbit.kg_nodes rn ON rn.node_id = c.right_node_id
     ${whereClause}
     ORDER BY c.score DESC NULLS LAST, c.candidate_id
     LIMIT ${lim}`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    candidateId: num(r.candidate_id),
    graphId: String(r.graph_id ?? ""),
    kind: String(r.kind ?? ""),
    score: numOrNull(r.score),
    method: strOrNull(r.method),
    reason: strOrNull(r.reason),
    status: String(r.status ?? ""),
    leftNodeId: num(r.l_id),
    leftLabel: String(r.l_label ?? ""),
    leftProperties: r.l_props ?? null,
    leftConfidence: numOrNull(r.l_conf),
    rightNodeId: num(r.r_id),
    rightLabel: String(r.r_label ?? ""),
    rightProperties: r.r_props ?? null,
    rightConfidence: numOrNull(r.r_conf),
    createdAt: epoch(r.created_at),
  }))
}

/** Regenerate the candidate queue for a given kind. */
export async function suggestMerges(
  connectionId: string,
  graphId: string | null,
  kind: string,
  threshold: number = 0.86,
  limit: number = 100,
): Promise<{ ok: boolean; error?: string }> {
  const graphArg = graphId ? `graph => ${sqlStr(graphId)}` : `graph => NULL`
  const res = await runQuery(
    connectionId,
    `SELECT 1 FROM rvbbit.kg_suggest_merges(
       node_kind => ${sqlStr(kind)},
       threshold => ${threshold},
       limit_count => ${limit},
       ${graphArg}
     ) LIMIT 1`,
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function acceptMerge(
  connectionId: string,
  candidateId: number,
  preferredWinnerNodeId: number | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const winner =
    preferredWinnerNodeId != null
      ? `preferred_winner_node_id => ${preferredWinnerNodeId}`
      : `preferred_winner_node_id => NULL`
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.kg_accept_merge(
       target_candidate_id => ${candidateId},
       ${winner}
     )`,
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export async function rejectMerge(
  connectionId: string,
  candidateId: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.kg_reject_merge(${candidateId})`,
  )
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

// ── Source-row provenance bridge (Phase 2) ──────────────────────────

/**
 * Resolve the single-column primary key for a source_table::regclass
 * text (e.g. "public.tickets" or just "tickets"). Returns null for
 * composite PKs and for tables without a PK at all — the caller can
 * fall back to opening the table unfiltered.
 */
export async function fetchPrimaryKeyColumn(
  connectionId: string,
  sourceTable: string,
): Promise<string | null> {
  const res = await runQuery(
    connectionId,
    `SELECT a.attname AS col, count(*) OVER () AS n
     FROM pg_constraint c
     JOIN pg_attribute a
       ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = ${sqlStr(sourceTable)}::regclass
       AND c.contype = 'p'
     LIMIT 2`,
  )
  if (!res.ok || res.rows.length === 0) return null
  // Composite PK → bail.
  if (num(res.rows[0].n) > 1) return null
  return String(res.rows[0].col ?? "")
}

export interface KgSourceMatch {
  /** Distinct kg_nodes touched by the matching evidence rows. */
  nodes: Array<{
    nodeId: number
    graphId: string
    kind: string
    label: string
  }>
  evidenceCount: number
}

/**
 * Reverse provenance lookup: given a (source_table, source_pk) pair,
 * find every KG node that has evidence tying back to that row, plus
 * the total evidence row count. Used by the "Open in KG" header chip
 * on source-row Data windows.
 */
export async function fetchKgEvidenceBySource(
  connectionId: string,
  sourceTable: string,
  sourcePk: string,
): Promise<KgSourceMatch> {
  // node_id can be direct (node-evidence) or derived from edge endpoints.
  const res = await runQuery(
    connectionId,
    `WITH ev AS (
       SELECT * FROM rvbbit.kg_evidence
       WHERE source_table = ${sqlStr(sourceTable)}::regclass
         AND source_pk = ${sqlStr(sourcePk)}
     ),
     touched_nodes AS (
       SELECT n.node_id, n.graph_id, n.kind, n.label
       FROM rvbbit.kg_nodes n
       WHERE n.node_id IN (
         SELECT node_id FROM ev WHERE node_id IS NOT NULL
         UNION
         SELECT subject_node_id FROM ev e
         JOIN rvbbit.kg_edges ed ON ed.edge_id = e.edge_id
         UNION
         SELECT object_node_id FROM ev e
         JOIN rvbbit.kg_edges ed ON ed.edge_id = e.edge_id
       )
     )
     SELECT
       (SELECT count(*) FROM ev) AS evidence_count,
       json_agg(json_build_object(
         'node_id', node_id,
         'graph_id', graph_id,
         'kind', kind,
         'label', label
       )) AS nodes
     FROM touched_nodes`,
  )
  if (!res.ok || res.rows.length === 0) {
    return { nodes: [], evidenceCount: 0 }
  }
  const r = res.rows[0]
  const evCount = num(r.evidence_count)
  const rawNodes = (r.nodes ?? []) as Array<Record<string, unknown>> | null
  const nodes = (rawNodes ?? []).map((n) => ({
    nodeId: num(n.node_id),
    graphId: String(n.graph_id ?? ""),
    kind: String(n.kind ?? ""),
    label: String(n.label ?? ""),
  }))
  return { nodes, evidenceCount: evCount }
}

// ── Topology (Phase 4) ──────────────────────────────────────────────

export interface KgGraphNode {
  nodeId: number
  kind: string
  label: string
  confidence: number | null
  /** Shortest-path depth from the seed, computed client-side. */
  depth: number
  /** True for the seed node only. */
  isSeed?: boolean
}

export interface KgGraphEdge {
  edgeId: number
  fromNodeId: number
  toNodeId: number
  predicate: string
  direction: "out" | "in"
  confidence: number | null
  /** Score from kg_context — useful for visual weighting. */
  score: number
  /** Best-known depth this edge appears at. */
  depth: number
}

export interface KgGraph {
  seed: { kind: string; label: string }
  nodes: KgGraphNode[]
  edges: KgGraphEdge[]
}

/**
 * Topology view of `kg_context` — deduplicated nodes + edges with
 * client-side depth assignment. No evidence is loaded (fetch lazily
 * via fetchKgEvidenceForEdge when the user clicks an edge).
 */
export async function fetchKgContextGraph(
  connectionId: string,
  graphId: string,
  kind: string,
  label: string,
  maxDepth: number = 2,
  direction: "out" | "in" | "both" = "both",
  maxEdges: number = 200,
): Promise<{ graph: KgGraph | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT context_rank, score, depth, predicate, edge_direction,
            from_kind, from_label, from_node_id,
            to_kind, to_label, to_node_id,
            edge_id
     FROM rvbbit.kg_context(
       node_kind => ${sqlStr(kind)},
       node_label => ${sqlStr(label)},
       max_depth => ${Math.max(1, Math.min(3, maxDepth))},
       max_edges => ${Math.max(1, Math.min(500, maxEdges))},
       direction => ${sqlStr(direction)},
       include_evidence => false,
       specialist => '',
       match_threshold => 0.0,
       graph => ${sqlStr(graphId)},
       ranking => '{}'::jsonb
     )`,
  )
  if (!res.ok) return { graph: null, error: res.error }

  // Resolve the seed node's id (kg_context returns "from" anchored on
  // seed for outbound and "to" anchored on seed for inbound — we need
  // a stable seed for layout).
  const seedId = await resolveKgNodeId(connectionId, graphId, kind, label)
  const nodes = new Map<number, KgGraphNode>()
  if (seedId != null) {
    nodes.set(seedId, {
      nodeId: seedId,
      kind,
      label,
      confidence: null,
      depth: 0,
      isSeed: true,
    })
  }
  const edges: KgGraphEdge[] = []
  for (const r of res.rows) {
    const dep = num(r.depth)
    const fromId = num(r.from_node_id)
    const toId = num(r.to_node_id)
    if (!nodes.has(fromId)) {
      nodes.set(fromId, {
        nodeId: fromId,
        kind: String(r.from_kind ?? ""),
        label: String(r.from_label ?? ""),
        confidence: null,
        depth: fromId === seedId ? 0 : dep,
      })
    }
    if (!nodes.has(toId)) {
      nodes.set(toId, {
        nodeId: toId,
        kind: String(r.to_kind ?? ""),
        label: String(r.to_label ?? ""),
        confidence: null,
        depth: toId === seedId ? 0 : dep,
      })
    }
    edges.push({
      edgeId: num(r.edge_id),
      fromNodeId: fromId,
      toNodeId: toId,
      predicate: String(r.predicate ?? ""),
      direction: r.edge_direction === "in" ? "in" : "out",
      confidence: null,
      score: num(r.score),
      depth: dep,
    })
  }
  // Refine depth: BFS from seed using the edge set, since kg_context's
  // `depth` is per-edge, not necessarily per-node.
  if (seedId != null) {
    const adj = new Map<number, number[]>()
    for (const e of edges) {
      adj.set(e.fromNodeId, [...(adj.get(e.fromNodeId) ?? []), e.toNodeId])
      adj.set(e.toNodeId, [...(adj.get(e.toNodeId) ?? []), e.fromNodeId])
    }
    const dist = new Map<number, number>([[seedId, 0]])
    const q: number[] = [seedId]
    while (q.length > 0) {
      const v = q.shift()!
      const d = dist.get(v)!
      for (const w of adj.get(v) ?? []) {
        if (!dist.has(w)) {
          dist.set(w, d + 1)
          q.push(w)
        }
      }
    }
    for (const n of nodes.values()) {
      if (dist.has(n.nodeId)) n.depth = dist.get(n.nodeId)!
    }
  }
  return {
    graph: {
      seed: { kind, label },
      nodes: Array.from(nodes.values()),
      edges,
    },
  }
}

/**
 * "Zoomed out" view of a graph: top-N most-connected nodes plus the
 * subset of edges between them. Used by the Explorer's overview mode
 * when no seed has been chosen — clicking any rendered node promotes
 * it to a seed and the canvas re-renders as a concentric constellation.
 */
export async function fetchKgGraphOverview(
  connectionId: string,
  graphId: string,
  maxNodes: number = 60,
): Promise<{ graph: KgGraph | null; error?: string }> {
  const lim = Math.max(2, Math.min(500, maxNodes))
  const edgeLimit = Math.max(80, Math.min(2500, lim * 5))
  const res = await runQuery(
    connectionId,
    `WITH node_deg AS (
       SELECT n.node_id, n.kind, n.label, n.confidence,
              (SELECT count(*) FROM rvbbit.kg_edges e
                WHERE e.graph_id = n.graph_id
                  AND (e.subject_node_id = n.node_id OR e.object_node_id = n.node_id)
              ) AS deg
       FROM rvbbit.kg_nodes n
       WHERE n.graph_id = ${sqlStr(graphId)}
     ),
     top AS (
       SELECT * FROM node_deg ORDER BY deg DESC, node_id LIMIT ${lim}
     ),
     edge_set AS (
       SELECT e.edge_id, e.subject_node_id, e.object_node_id, e.predicate, e.confidence
       FROM rvbbit.kg_edges e
       WHERE e.graph_id = ${sqlStr(graphId)}
         AND e.subject_node_id IN (SELECT node_id FROM top)
         AND e.object_node_id IN (SELECT node_id FROM top)
       ORDER BY e.confidence DESC NULLS LAST, e.edge_id
       LIMIT ${edgeLimit}
     )
     SELECT
       (SELECT jsonb_agg(jsonb_build_object(
         'node_id', node_id, 'kind', kind, 'label', label,
         'confidence', confidence, 'deg', deg
       )) FROM top) AS nodes,
       (SELECT jsonb_agg(jsonb_build_object(
         'edge_id', edge_id, 'from_node_id', subject_node_id,
         'to_node_id', object_node_id, 'predicate', predicate,
         'confidence', confidence
       )) FROM edge_set) AS edges`,
  )
  if (!res.ok) return { graph: null, error: res.error }
  if (res.rows.length === 0) return { graph: null }
  const r = res.rows[0]
  const rawNodes = (r.nodes ?? []) as Array<Record<string, unknown>> | null
  const rawEdges = (r.edges ?? []) as Array<Record<string, unknown>> | null
  const nodes: KgGraphNode[] = (rawNodes ?? []).map((n) => ({
    nodeId: num(n.node_id),
    kind: String(n.kind ?? ""),
    label: String(n.label ?? ""),
    confidence: numOrNull(n.confidence),
    // We borrow `depth` to carry node degree in overview mode — the
    // existing layout/rendering only uses `depth` for the constellation
    // mode, and overview mode uses its own circular layout.
    depth: num(n.deg),
  }))
  const edges: KgGraphEdge[] = (rawEdges ?? []).map((e) => ({
    edgeId: num(e.edge_id),
    fromNodeId: num(e.from_node_id),
    toNodeId: num(e.to_node_id),
    predicate: String(e.predicate ?? ""),
    direction: "out",
    confidence: numOrNull(e.confidence),
    score: 1,
    depth: 1,
  }))
  return {
    graph: {
      seed: { kind: "", label: "" },
      nodes,
      edges,
    },
  }
}

export async function fetchKgEvidenceForEdge(
  connectionId: string,
  graphId: string,
  edgeId: number,
): Promise<KgEvidenceRow[]> {
  const res = await runQuery(
    connectionId,
    `SELECT evidence_id, edge_id, node_id, query_id::text AS query_id,
            source_table::text AS source_table, source_pk, source_column,
            evidence_text, confidence, properties, created_at
     FROM rvbbit.kg_evidence
     WHERE graph_id = ${sqlStr(graphId)} AND edge_id = ${edgeId}
     ORDER BY confidence DESC NULLS LAST, created_at DESC
     LIMIT 100`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => ({
    evidenceId: num(r.evidence_id),
    edgeId: numOrNull(r.edge_id),
    nodeId: numOrNull(r.node_id),
    queryId: strOrNull(r.query_id),
    sourceTable: strOrNull(r.source_table),
    sourcePk: strOrNull(r.source_pk),
    sourceColumn: strOrNull(r.source_column),
    evidenceText: strOrNull(r.evidence_text),
    confidence: numOrNull(r.confidence),
    properties: r.properties ?? null,
    createdAt: epoch(r.created_at),
  }))
}

// ── Path Finder (Phase 4) ───────────────────────────────────────────

export interface KgPathEdge {
  edgeId: number
  predicate: string
  confidence: number | null
}

export interface KgPath {
  length: number
  nodeIds: number[]
  labels: string[]
  edges: KgPathEdge[]
}

export async function fetchKgPaths(
  connectionId: string,
  graphId: string,
  subjectKind: string,
  subjectLabel: string,
  objectKind: string,
  objectLabel: string,
  maxDepth: number = 3,
  direction: "out" | "in" | "both" = "both",
): Promise<KgPath[]> {
  const res = await runQuery(
    connectionId,
    `SELECT p.length, p.node_ids, p.labels,
       (
         SELECT jsonb_agg(
           jsonb_build_object(
             'edge_id', e.edge_id,
             'predicate', e.predicate,
             'confidence', e.confidence
           )
           ORDER BY ord
         )
         FROM unnest(p.edge_ids) WITH ORDINALITY AS path_edges(edge_id, ord)
         JOIN rvbbit.kg_edges e ON e.edge_id = path_edges.edge_id
       ) AS edges
     FROM rvbbit.kg_paths(
       subject_kind => ${sqlStr(subjectKind)},
       subject_label => ${sqlStr(subjectLabel)},
       object_kind => ${sqlStr(objectKind)},
       object_label => ${sqlStr(objectLabel)},
       max_depth => ${Math.max(1, Math.min(5, maxDepth))},
       direction => ${sqlStr(direction)},
       specialist => '',
       match_threshold => 0.0,
       graph => ${sqlStr(graphId)}
     ) p
     ORDER BY p.length, p.node_ids
     LIMIT 20`,
  )
  if (!res.ok) return []
  return res.rows.map((r) => {
    const nodeIds = (r.node_ids as number[] | null) ?? []
    const labels = (r.labels as string[] | null) ?? []
    const rawEdges = (r.edges as Array<Record<string, unknown>> | null) ?? []
    return {
      length: num(r.length),
      nodeIds: nodeIds.map((n) => num(n)),
      labels: labels.map((l) => String(l)),
      edges: rawEdges.map((e) => ({
        edgeId: num(e.edge_id),
        predicate: String(e.predicate ?? ""),
        confidence: numOrNull(e.confidence),
      })),
    }
  })
}

// ── Display helpers ─────────────────────────────────────────────────

/** Short human label for an evidence row's provenance, e.g. "tickets#42:body". */
export function evidenceProvenanceLabel(e: KgEvidenceRow): string {
  if (!e.sourceTable) return "—"
  const pk = e.sourcePk ? `#${e.sourcePk}` : ""
  const col = e.sourceColumn ? `:${e.sourceColumn}` : ""
  return `${e.sourceTable}${pk}${col}`
}

/** Truncate a long evidence_text to a one-line preview. */
export function shortEvidenceText(s: string | null, max: number = 140): string {
  if (!s) return ""
  const trimmed = s.replace(/\s+/g, " ").trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…"
}
