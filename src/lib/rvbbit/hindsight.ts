"use client"

import type { KgGraph, KgGraphEdge, KgGraphNode } from "./kg"

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

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function sqlJson(value: unknown): string {
  return `${sqlStr(JSON.stringify(value ?? {}))}::jsonb`
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function optText(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : ""
}

export interface HindsightAvailability {
  ready: boolean
  schemaExists: boolean
  memoryUnits: boolean
  memoryLinks: boolean
  banks: boolean
  entities: boolean
}

export interface HindsightTableCount {
  table: string
  rows: number
}

export interface HindsightServiceStatus {
  name: string
  endpointUrl: string | null
  status: string | null
  health: unknown
  updatedAt: number | null
}

export interface HindsightOverview {
  availability: HindsightAvailability
  services: HindsightServiceStatus[]
  tables: HindsightTableCount[]
  banks: number
  documents: number
  chunks: number
  memories: number
  links: number
  entities: number
  asyncOperations: number
  llmRequests: number
  auditRows: number
  invalidated: number
  latestMemoryAt: number | null
}

export interface HindsightBank {
  bankId: string
  name: string | null
  memoryUnits: number
  documents: number
  chunks: number
  links: number
  entities: number
  createdAt: number | null
  updatedAt: number | null
}

export interface HindsightMemoryRow {
  id: string
  bankId: string
  documentId: string | null
  chunkId: string | null
  text: string
  context: string | null
  factType: string | null
  tags: string[]
  accessCount: number
  proofCount: number
  createdAt: number | null
  updatedAt: number | null
  mentionedAt: number | null
  metadata: unknown
}

export interface HindsightMemoryDetail {
  memory: Record<string, unknown> | null
  document: Record<string, unknown> | null
  chunk: Record<string, unknown> | null
  links: Record<string, unknown>[]
  entities: Record<string, unknown>[]
  invalidations: Record<string, unknown>[]
}

export interface HindsightRecallResult {
  raw: unknown
  results: HindsightMemoryRow[]
}

export interface HindsightOpsRows {
  asyncOperations: Record<string, unknown>[]
  auditLog: Record<string, unknown>[]
  llmRequests: Record<string, unknown>[]
  invalidated: Record<string, unknown>[]
  graphQueue: Record<string, unknown>[]
  errors: string[]
}

export interface HindsightGraphResult {
  graph: KgGraph | null
  error?: string
}

export async function detectHindsight(connectionId: string): Promise<HindsightAvailability> {
  const res = await runQuery(
    connectionId,
    `SELECT
       to_regnamespace('hindsight') IS NOT NULL AS schema_exists,
       to_regclass('hindsight.memory_units') IS NOT NULL AS memory_units,
       to_regclass('hindsight.memory_links') IS NOT NULL AS memory_links,
       to_regclass('hindsight.banks') IS NOT NULL AS banks,
       to_regclass('hindsight.entities') IS NOT NULL AS entities`,
    1,
  )
  if (!res.ok || res.rows.length === 0) {
    return { ready: false, schemaExists: false, memoryUnits: false, memoryLinks: false, banks: false, entities: false }
  }
  const r = res.rows[0]
  const schemaExists = r.schema_exists === true
  const memoryUnits = r.memory_units === true
  const memoryLinks = r.memory_links === true
  const banks = r.banks === true
  const entities = r.entities === true
  return {
    ready: schemaExists && memoryUnits && memoryLinks && banks,
    schemaExists,
    memoryUnits,
    memoryLinks,
    banks,
    entities,
  }
}

export async function fetchHindsightOverview(connectionId: string): Promise<{ overview: HindsightOverview | null; error?: string }> {
  const availability = await detectHindsight(connectionId)
  if (!availability.ready) {
    return {
      overview: {
        availability,
        services: [],
        tables: [],
        banks: 0,
        documents: 0,
        chunks: 0,
        memories: 0,
        links: 0,
        entities: 0,
        asyncOperations: 0,
        llmRequests: 0,
        auditRows: 0,
        invalidated: 0,
        latestMemoryAt: null,
      },
    }
  }
  const res = await runQuery(
    connectionId,
    `WITH table_counts AS (
       SELECT 'banks' AS table_name, count(*)::bigint AS rows FROM hindsight.banks
       UNION ALL SELECT 'documents', count(*)::bigint FROM hindsight.documents
       UNION ALL SELECT 'chunks', count(*)::bigint FROM hindsight.chunks
       UNION ALL SELECT 'memory_units', count(*)::bigint FROM hindsight.memory_units
       UNION ALL SELECT 'memory_links', count(*)::bigint FROM hindsight.memory_links
       UNION ALL SELECT 'entities', count(*)::bigint FROM hindsight.entities
       UNION ALL SELECT 'async_operations', count(*)::bigint FROM hindsight.async_operations
       UNION ALL SELECT 'audit_log', count(*)::bigint FROM hindsight.audit_log
       UNION ALL SELECT 'llm_requests', count(*)::bigint FROM hindsight.llm_requests
       UNION ALL SELECT 'invalidated_memory_units', count(*)::bigint FROM hindsight.invalidated_memory_units
     )
     SELECT
       (SELECT coalesce(jsonb_agg(jsonb_build_object('table', table_name, 'rows', rows) ORDER BY table_name), '[]'::jsonb) FROM table_counts) AS tables,
       (SELECT max(coalesce(mentioned_at, updated_at, created_at)) FROM hindsight.memory_units) AS latest_memory_at,
       (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.updated_at DESC NULLS LAST), '[]'::jsonb)
          FROM rvbbit.memory_services s
         WHERE s.provider = 'hindsight') AS services`,
    1,
  )
  if (!res.ok) return { overview: null, error: res.error }
  const r = res.rows[0] ?? {}
  const tables = asArray<Record<string, unknown>>(r.tables).map((row) => ({
    table: String(row.table ?? ""),
    rows: num(row.rows),
  }))
  const count = (table: string) => tables.find((t) => t.table === table)?.rows ?? 0
  const services = asArray<Record<string, unknown>>(r.services).map((row) => ({
    name: String(row.name ?? ""),
    endpointUrl: strOrNull(row.endpoint_url),
    status: strOrNull(row.status),
    health: row.health ?? null,
    updatedAt: epoch(row.updated_at),
  }))
  return {
    overview: {
      availability,
      services,
      tables,
      banks: count("banks"),
      documents: count("documents"),
      chunks: count("chunks"),
      memories: count("memory_units"),
      links: count("memory_links"),
      entities: count("entities"),
      asyncOperations: count("async_operations"),
      llmRequests: count("llm_requests"),
      auditRows: count("audit_log"),
      invalidated: count("invalidated_memory_units"),
      latestMemoryAt: epoch(r.latest_memory_at),
    },
  }
}

export async function fetchHindsightBanks(connectionId: string): Promise<{ banks: HindsightBank[]; error?: string }> {
  const res = await runQuery(
    connectionId,
    `SELECT
       b.bank_id,
       b.name,
       b.created_at,
       b.updated_at,
       (SELECT count(*) FROM hindsight.memory_units mu WHERE mu.bank_id = b.bank_id) AS memory_units,
       (SELECT count(*) FROM hindsight.documents d WHERE d.bank_id = b.bank_id) AS documents,
       (SELECT count(*) FROM hindsight.chunks c WHERE c.bank_id = b.bank_id) AS chunks,
       (SELECT count(*) FROM hindsight.memory_links l WHERE l.bank_id = b.bank_id) AS links,
       (SELECT count(*) FROM hindsight.entities e WHERE e.bank_id = b.bank_id) AS entities
     FROM hindsight.banks b
     ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC NULLS LAST, b.bank_id`,
  )
  if (!res.ok) return { banks: [], error: res.error }
  return {
    banks: res.rows.map((r) => ({
      bankId: String(r.bank_id ?? ""),
      name: strOrNull(r.name),
      memoryUnits: num(r.memory_units),
      documents: num(r.documents),
      chunks: num(r.chunks),
      links: num(r.links),
      entities: num(r.entities),
      createdAt: epoch(r.created_at),
      updatedAt: epoch(r.updated_at),
    })),
  }
}

export async function fetchHindsightMemories(
  connectionId: string,
  opts: { bankId?: string | null; query?: string | null; limit?: number } = {},
): Promise<{ rows: HindsightMemoryRow[]; error?: string }> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 150))
  const bank = optText(opts.bankId)
  const query = optText(opts.query)
  const bankWhere = bank ? `AND mu.bank_id = ${sqlStr(bank)}` : ""
  const queryWhere = query
    ? `AND (mu.text ILIKE ${sqlStr(`%${query}%`)}
            OR coalesce(mu.context, '') ILIKE ${sqlStr(`%${query}%`)}
            OR mu.metadata::text ILIKE ${sqlStr(`%${query}%`)}
            OR array_to_string(coalesce(mu.tags::text[], ARRAY[]::text[]), ' ') ILIKE ${sqlStr(`%${query}%`)})`
    : ""
  const res = await runQuery(
    connectionId,
    `SELECT
       mu.id::text AS id,
       mu.bank_id,
       mu.document_id,
       mu.chunk_id,
       mu.text,
       mu.context,
       mu.fact_type,
       coalesce(mu.tags::text[], ARRAY[]::text[]) AS tags,
       mu.access_count,
       mu.proof_count,
       mu.created_at,
       mu.updated_at,
       mu.mentioned_at,
       mu.metadata
     FROM hindsight.memory_units mu
     WHERE true ${bankWhere} ${queryWhere}
     ORDER BY coalesce(mu.mentioned_at, mu.updated_at, mu.created_at) DESC NULLS LAST, mu.id
     LIMIT ${limit}`,
    limit,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return { rows: res.rows.map(parseMemoryRow) }
}

export async function fetchHindsightMemoryDetail(
  connectionId: string,
  memoryId: string,
): Promise<{ detail: HindsightMemoryDetail | null; error?: string }> {
  const res = await runQuery(
    connectionId,
    `WITH target AS (
       SELECT * FROM hindsight.memory_units WHERE id = ${sqlStr(memoryId)}::uuid
     )
     SELECT
       (SELECT to_jsonb(t) FROM target t) AS memory,
       (SELECT to_jsonb(d)
          FROM target t
          JOIN hindsight.documents d ON d.id = t.document_id
         LIMIT 1) AS document,
       (SELECT to_jsonb(c)
          FROM target t
          JOIN hindsight.chunks c ON c.chunk_id = t.chunk_id
         LIMIT 1) AS chunk,
       (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb)
          FROM target t
          JOIN hindsight.memory_links l ON l.from_unit_id = t.id OR l.to_unit_id = t.id) AS links,
       (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.canonical_name), '[]'::jsonb)
          FROM target t
          JOIN hindsight.unit_entities ue ON ue.unit_id = t.id
          JOIN hindsight.entities e ON e.id = ue.entity_id) AS entities,
       (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.invalidated_at DESC NULLS LAST), '[]'::jsonb)
          FROM target t
          JOIN hindsight.invalidated_memory_units i ON i.id = t.id) AS invalidations`,
    1,
  )
  if (!res.ok) return { detail: null, error: res.error }
  if (res.rows.length === 0 || !res.rows[0]?.memory) return { detail: null }
  const r = res.rows[0]
  return {
    detail: {
      memory: asRecord(r.memory),
      document: r.document ? asRecord(r.document) : null,
      chunk: r.chunk ? asRecord(r.chunk) : null,
      links: asArray(r.links),
      entities: asArray(r.entities),
      invalidations: asArray(r.invalidations),
    },
  }
}

export async function recallHindsight(
  connectionId: string,
  bankId: string,
  query: string,
  options: Record<string, unknown> = {},
  serviceName = "hindsight_default",
): Promise<{ recall: HindsightRecallResult | null; error?: string }> {
  const q = optText(query)
  const bank = optText(bankId)
  if (!q || !bank) return { recall: { raw: { results: [] }, results: [] } }
  const res = await runQuery(
    connectionId,
    `SELECT rvbbit.hindsight_recall(${sqlStr(bank)}, ${sqlStr(q)}, ${sqlJson(options)}, ${sqlStr(serviceName)}) AS result`,
    1,
    { statementTimeout: 120000 },
  )
  if (!res.ok) return { recall: null, error: res.error }
  const raw = res.rows[0]?.result ?? { results: [] }
  const rawObject = asRecord(raw)
  const resultItems = asArray<Record<string, unknown>>(rawObject.results ?? rawObject.memories)
  const ids = resultItems
    .map((row) => String(row.id ?? ""))
    .filter(Boolean)
  if (ids.length === 0) return { recall: { raw, results: [] } }
  const detail = await fetchHindsightMemoriesByIds(connectionId, ids)
  if (detail.error) return { recall: { raw, results: resultItems.map(memoryRowFromRecallItem) }, error: detail.error }
  return { recall: { raw, results: detail.rows.length ? detail.rows : resultItems.map(memoryRowFromRecallItem) } }
}

async function fetchHindsightMemoriesByIds(
  connectionId: string,
  ids: string[],
): Promise<{ rows: HindsightMemoryRow[]; error?: string }> {
  const unique = Array.from(new Set(ids)).filter(Boolean)
  if (unique.length === 0) return { rows: [] }
  const uuidArray = `ARRAY[${unique.map((id) => `${sqlStr(id)}::uuid`).join(", ")}]`
  const res = await runQuery(
    connectionId,
    `SELECT
       mu.id::text AS id,
       mu.bank_id,
       mu.document_id,
       mu.chunk_id,
       mu.text,
       mu.context,
       mu.fact_type,
       coalesce(mu.tags::text[], ARRAY[]::text[]) AS tags,
       mu.access_count,
       mu.proof_count,
       mu.created_at,
       mu.updated_at,
       mu.mentioned_at,
       mu.metadata
     FROM hindsight.memory_units mu
     WHERE mu.id = ANY(${uuidArray})
     ORDER BY array_position(${uuidArray}, mu.id), mu.id`,
  )
  if (!res.ok) return { rows: [], error: res.error }
  return { rows: res.rows.map(parseMemoryRow) }
}

export async function fetchHindsightOps(connectionId: string, bankId?: string | null): Promise<HindsightOpsRows> {
  const bank = optText(bankId)
  const bankWhere = bank ? `WHERE bank_id = ${sqlStr(bank)}` : ""
  const queries: Array<[keyof Omit<HindsightOpsRows, "errors">, string]> = [
    ["asyncOperations", `SELECT to_jsonb(t) AS row FROM (SELECT * FROM hindsight.async_operations ${bankWhere} ORDER BY created_at DESC NULLS LAST LIMIT 80) t`],
    ["auditLog", `SELECT to_jsonb(t) AS row FROM (SELECT * FROM hindsight.audit_log ${bankWhere} ORDER BY started_at DESC NULLS LAST LIMIT 80) t`],
    ["llmRequests", `SELECT to_jsonb(t) AS row FROM (SELECT * FROM hindsight.llm_requests ${bankWhere} ORDER BY started_at DESC NULLS LAST LIMIT 80) t`],
    ["invalidated", `SELECT to_jsonb(t) AS row FROM (SELECT * FROM hindsight.invalidated_memory_units ${bankWhere} ORDER BY invalidated_at DESC NULLS LAST LIMIT 80) t`],
    ["graphQueue", `SELECT to_jsonb(t) AS row FROM (SELECT * FROM hindsight.graph_maintenance_queue ${bankWhere} ORDER BY enqueued_at DESC NULLS LAST LIMIT 80) t`],
  ]
  const out: HindsightOpsRows = {
    asyncOperations: [],
    auditLog: [],
    llmRequests: [],
    invalidated: [],
    graphQueue: [],
    errors: [],
  }
  await Promise.all(queries.map(async ([key, sql]) => {
    const res = await runQuery(connectionId, sql, 100)
    if (!res.ok) {
      out.errors.push(`${key}: ${res.error}`)
      return
    }
    out[key] = res.rows.map((row) => asRecord(row.row))
  }))
  return out
}

export async function fetchHindsightGraph(
  connectionId: string,
  opts: { bankId?: string | null; limit?: number } = {},
): Promise<HindsightGraphResult> {
  const bank = optText(opts.bankId)
  const limit = Math.max(10, Math.min(250, opts.limit ?? 90))
  const bankWhere = bank ? `AND mu.bank_id = ${sqlStr(bank)}` : ""
  const docBankWhere = bank ? `AND d.bank_id = ${sqlStr(bank)}` : ""
  const chunkBankWhere = bank ? `AND c.bank_id = ${sqlStr(bank)}` : ""
  const entityBankWhere = bank ? `AND e.bank_id = ${sqlStr(bank)}` : ""
  const linkBankWhere = bank ? `AND l.bank_id = ${sqlStr(bank)}` : ""
  const res = await runQuery(
    connectionId,
    `WITH selected_mem AS (
       SELECT mu.*
       FROM hindsight.memory_units mu
       WHERE true ${bankWhere}
       ORDER BY coalesce(mu.mentioned_at, mu.updated_at, mu.created_at) DESC NULLS LAST, mu.id
       LIMIT ${limit}
     ),
     node_source AS (
       SELECT DISTINCT
              'bank:' || mu.bank_id AS node_key,
              'bank' AS kind,
              mu.bank_id AS label,
              1.0::double precision AS confidence,
              0 AS sort_depth
       FROM selected_mem mu
       UNION ALL
       SELECT DISTINCT
              'document:' || d.id,
              'document',
              coalesce(nullif(d.file_original_name, ''), d.id),
              0.9::double precision,
              1
       FROM hindsight.documents d
       JOIN selected_mem mu ON mu.document_id = d.id
       WHERE true ${docBankWhere}
       UNION ALL
       SELECT DISTINCT
              'chunk:' || c.chunk_id,
              'chunk',
              c.chunk_id,
              0.8::double precision,
              2
       FROM hindsight.chunks c
       JOIN selected_mem mu ON mu.chunk_id = c.chunk_id
       WHERE true ${chunkBankWhere}
       UNION ALL
       SELECT
              'memory:' || mu.id::text,
              coalesce(nullif(mu.fact_type, ''), 'memory'),
              left(regexp_replace(mu.text, '\\s+', ' ', 'g'), 120),
              0.95::double precision,
              3
       FROM selected_mem mu
       UNION ALL
       SELECT DISTINCT
              'entity:' || e.id::text,
              'entity',
              e.canonical_name,
              least(1.0, greatest(0.05, e.mention_count::double precision / nullif(max(e.mention_count) OVER (), 0))),
              4
       FROM hindsight.entities e
       JOIN hindsight.unit_entities ue ON ue.entity_id = e.id
       JOIN selected_mem mu ON mu.id = ue.unit_id
       WHERE true ${entityBankWhere}
     ),
     nodes AS (
       SELECT row_number() OVER (ORDER BY sort_depth, kind, node_key)::int AS node_id, *
       FROM node_source
     ),
     edge_source AS (
       SELECT DISTINCT 'bank:' || d.bank_id AS from_key, 'document:' || d.id AS to_key, 'contains_document' AS predicate, 1.0::double precision AS confidence, 1 AS depth
       FROM hindsight.documents d
       JOIN selected_mem mu ON mu.document_id = d.id
       WHERE true ${docBankWhere}
       UNION ALL
       SELECT DISTINCT 'document:' || c.document_id, 'chunk:' || c.chunk_id, 'has_chunk', 1.0::double precision, 2
       FROM hindsight.chunks c
       JOIN selected_mem mu ON mu.chunk_id = c.chunk_id
       WHERE true ${chunkBankWhere}
       UNION ALL
       SELECT DISTINCT 'chunk:' || mu.chunk_id, 'memory:' || mu.id::text, 'produced_memory', 1.0::double precision, 3
       FROM selected_mem mu
       WHERE mu.chunk_id IS NOT NULL
       UNION ALL
       SELECT 'memory:' || l.from_unit_id::text, 'memory:' || l.to_unit_id::text, l.link_type, l.weight, 4
       FROM hindsight.memory_links l
       JOIN selected_mem a ON a.id = l.from_unit_id
       JOIN selected_mem b ON b.id = l.to_unit_id
       WHERE true ${linkBankWhere}
       UNION ALL
       SELECT DISTINCT 'memory:' || ue.unit_id::text, 'entity:' || ue.entity_id::text, 'mentions_entity', 0.85::double precision, 4
       FROM hindsight.unit_entities ue
       JOIN selected_mem mu ON mu.id = ue.unit_id
     ),
     edges AS (
       SELECT row_number() OVER (ORDER BY predicate, from_key, to_key)::int AS edge_id,
              f.node_id AS from_node_id,
              t.node_id AS to_node_id,
              e.predicate,
              e.confidence,
              e.depth
       FROM edge_source e
       JOIN nodes f ON f.node_key = e.from_key
       JOIN nodes t ON t.node_key = e.to_key
       WHERE f.node_id <> t.node_id
     )
     SELECT
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
         'node_id', node_id,
         'kind', kind,
         'label', label,
         'confidence', confidence,
         'depth', sort_depth
       ) ORDER BY node_id), '[]'::jsonb) FROM nodes) AS nodes,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
         'edge_id', edge_id,
         'from_node_id', from_node_id,
         'to_node_id', to_node_id,
         'predicate', predicate,
         'confidence', confidence,
         'depth', depth
       ) ORDER BY edge_id), '[]'::jsonb) FROM edges) AS edges`,
    1,
  )
  if (!res.ok) return { graph: null, error: res.error }
  const row = res.rows[0] ?? {}
  const nodes: KgGraphNode[] = asArray<Record<string, unknown>>(row.nodes).map((node) => ({
    nodeId: num(node.node_id),
    kind: String(node.kind ?? ""),
    label: String(node.label ?? ""),
    confidence: numOrNull(node.confidence),
    depth: num(node.depth),
    isSeed: node.kind === "bank",
  }))
  const edges: KgGraphEdge[] = asArray<Record<string, unknown>>(row.edges).map((edge) => ({
    edgeId: num(edge.edge_id),
    fromNodeId: num(edge.from_node_id),
    toNodeId: num(edge.to_node_id),
    predicate: String(edge.predicate ?? ""),
    direction: "out",
    confidence: numOrNull(edge.confidence),
    score: num(edge.confidence) || 1,
    depth: num(edge.depth),
  }))
  return {
    graph: {
      seed: { kind: "bank", label: bank || "hindsight" },
      nodes,
      edges,
    },
  }
}

function parseMemoryRow(r: Record<string, unknown>): HindsightMemoryRow {
  return {
    id: String(r.id ?? ""),
    bankId: String(r.bank_id ?? ""),
    documentId: strOrNull(r.document_id),
    chunkId: strOrNull(r.chunk_id),
    text: String(r.text ?? r.content ?? ""),
    context: strOrNull(r.context),
    factType: strOrNull(r.fact_type),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    accessCount: num(r.access_count),
    proofCount: num(r.proof_count),
    createdAt: epoch(r.created_at),
    updatedAt: epoch(r.updated_at),
    mentionedAt: epoch(r.mentioned_at),
    metadata: r.metadata ?? null,
  }
}

function memoryRowFromRecallItem(r: Record<string, unknown>): HindsightMemoryRow {
  return {
    id: String(r.id ?? ""),
    bankId: "",
    documentId: strOrNull(r.document_id),
    chunkId: strOrNull(r.chunk_id),
    text: String(r.text ?? ""),
    context: strOrNull(r.context),
    factType: strOrNull(r.type) ?? strOrNull(r.fact_type),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    accessCount: 0,
    proofCount: 0,
    createdAt: null,
    updatedAt: null,
    mentionedAt: epoch(r.mentioned_at),
    metadata: r.metadata ?? null,
  }
}
