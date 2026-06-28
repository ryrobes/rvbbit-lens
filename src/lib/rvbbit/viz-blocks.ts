"use client"

// Data layer for canonical SQL/viz blocks. The durable source of truth lives in
// pg_rvbbit (rvbbit.viz_block_defs / viz_object_links); Lens uses this helper to
// list, preview, define, and link blocks over the standard query route.

export interface VizBlockSummary {
  name: string
  version: number
  title: string
  intent: string
  description: string | null
  owner: string | null
  sqlTemplate: string
  inputSchema: Record<string, unknown>
  layoutTemplate: Record<string, unknown>
  params: Record<string, unknown>
  tags: string[]
  labels: Record<string, unknown>
  enabled: boolean
  createdAt: string | null
}

export type VizBlockVersion = VizBlockSummary

export interface VizObjectLink {
  linkId?: number | null
  objectKind: string
  objectKey: string
  role: string
  confidence: number
  linkSource: string
  conditions: Record<string, unknown>
  notes?: string | null
  blockVersion: number | null
  linkCreatedAt?: string | null
}

export interface VizBlockMatch extends VizBlockSummary, VizObjectLink {}

export interface DefineVizBlockInput {
  name: string
  sqlTemplate: string
  inputSchema?: Record<string, unknown>
  layoutTemplate?: Record<string, unknown>
  title?: string | null
  intent?: string | null
  description?: string | null
  owner?: string | null
  params?: Record<string, unknown>
  tags?: string[]
  labels?: Record<string, unknown>
  enabled?: boolean
  links?: Array<{
    object_kind?: string
    objectKind?: string
    object_key?: string
    objectKey?: string
    role?: string
    confidence?: number
    link_source?: string
    linkSource?: string
    conditions?: Record<string, unknown>
    notes?: string | null
    block_version?: number | null
    blockVersion?: number | null
  }>
}

export interface LinkVizBlockInput {
  blockName: string
  objectKind: string
  objectKey: string
  role?: string | null
  confidence?: number | null
  linkSource?: string | null
  conditions?: Record<string, unknown>
  blockVersion?: number | null
  notes?: string | null
}

interface Ok {
  ok: true
  rows: Array<Record<string, unknown>>
}
interface Err {
  ok: false
  error: string
}

async function run(
  connectionId: string,
  sql: string,
  rowLimit = 5000,
  opts: { readOnly?: boolean } = {},
): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit, readOnly: opts.readOnly ?? false }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function nullableText(value: string | null | undefined): string {
  const text = value == null ? "" : String(value)
  return text.trim() ? q(text) : "NULL"
}

function nullableInt(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "NULL" : String(Math.trunc(value))
}

function nullableFloat(value: number | null | undefined, fallback: number): string {
  const n = value == null ? fallback : Number(value)
  return Number.isFinite(n) ? String(n) : String(fallback)
}

function jb(value: unknown): string {
  return `${q(JSON.stringify(value ?? {}))}::jsonb`
}

function textArray(values: string[] | null | undefined): string {
  if (!values?.length) return "'{}'::text[]"
  return `ARRAY[${values.map(q).join(",")}]::text[]`
}

function boolSql(value: boolean | null | undefined, fallback = true): string {
  return value ?? fallback ? "TRUE" : "FALSE"
}

function str(v: unknown): string | null {
  return v == null ? null : String(v)
}

function asObject(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== "string" || !v.trim()) return []
  if (v.startsWith("{") && v.endsWith("}")) {
    return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
  }
  return [v]
}

function normalizeBlock(row: Record<string, unknown>): VizBlockSummary {
  return {
    name: String(row.name ?? ""),
    version: Number(row.version ?? 0),
    title: String(row.title ?? row.name ?? ""),
    intent: String(row.intent ?? "overview"),
    description: str(row.description),
    owner: str(row.owner),
    sqlTemplate: String(row.sql_template ?? ""),
    inputSchema: asObject(row.input_schema),
    layoutTemplate: asObject(row.layout_template),
    params: asObject(row.params),
    tags: asStringArray(row.tags),
    labels: asObject(row.labels),
    enabled: row.enabled == null ? true : Boolean(row.enabled),
    createdAt: str(row.created_at),
  }
}

function normalizeLink(row: Record<string, unknown>): VizObjectLink {
  return {
    linkId: row.link_id == null ? null : Number(row.link_id),
    objectKind: String(row.object_kind ?? ""),
    objectKey: String(row.object_key ?? ""),
    role: String(row.role ?? "source"),
    confidence: Number(row.confidence ?? 1),
    linkSource: String(row.link_source ?? "declared"),
    conditions: asObject(row.conditions),
    notes: str(row.notes),
    blockVersion: row.block_version == null ? null : Number(row.block_version),
    linkCreatedAt: str(row.link_created_at),
  }
}

function normalizeDefineLink(link: NonNullable<DefineVizBlockInput["links"]>[number]): Record<string, unknown> {
  return {
    object_kind: link.object_kind ?? link.objectKind,
    object_key: link.object_key ?? link.objectKey,
    role: link.role,
    confidence: link.confidence,
    link_source: link.link_source ?? link.linkSource,
    conditions: link.conditions,
    notes: link.notes,
    block_version: link.block_version ?? link.blockVersion,
  }
}

export async function listVizBlocks(
  connectionId: string,
): Promise<{ blocks: VizBlockSummary[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT name, version, title, intent, description, owner, sql_template,
            input_schema, layout_template, params, tags, labels, enabled,
            created_at::text AS created_at
       FROM rvbbit.viz_block_catalog
      ORDER BY intent, name`,
    5000,
    { readOnly: true },
  )
  if (!r.ok) return { blocks: [], error: r.error }
  return { blocks: r.rows.map(normalizeBlock), error: null }
}

export async function fetchVizBlockVersions(
  connectionId: string,
  name: string,
): Promise<{ versions: VizBlockVersion[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT version, title, intent, description, owner, sql_template,
            input_schema, layout_template, params, tags, labels, enabled,
            created_at::text AS created_at,
            ${q(name)} AS name
       FROM rvbbit.viz_block_versions(${q(name)})`,
    5000,
    { readOnly: true },
  )
  if (!r.ok) return { versions: [], error: r.error }
  return { versions: r.rows.map(normalizeBlock), error: null }
}

export async function fetchVizBlockLinks(
  connectionId: string,
  name: string,
): Promise<{ links: VizObjectLink[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT link_id, object_kind, object_key, role, confidence, link_source,
            conditions, notes, block_version, created_at::text AS link_created_at
       FROM rvbbit.viz_object_links
      WHERE block_name = ${q(name)}
      ORDER BY role, object_kind, object_key, coalesce(block_version, 0)`,
    5000,
    { readOnly: true },
  )
  if (!r.ok) return { links: [], error: r.error }
  return { links: r.rows.map(normalizeLink), error: null }
}

export async function findVizBlocksForObject(
  connectionId: string,
  objectKind: string | null,
  objectKey: string | null,
  intent?: string | null,
): Promise<{ blocks: VizBlockMatch[]; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT name, version, title, intent, description, sql_template,
            input_schema, layout_template, params, tags, labels,
            object_kind, object_key, role, confidence, link_source,
            conditions, block_version,
            NULL::text AS owner,
            TRUE AS enabled,
            NULL::text AS created_at
       FROM rvbbit.viz_blocks_for_object(
            ${nullableText(objectKind)},
            ${nullableText(objectKey)},
            ${nullableText(intent)}
       )`,
    5000,
    { readOnly: true },
  )
  if (!r.ok) return { blocks: [], error: r.error }
  return {
    blocks: r.rows.map((row) => ({ ...normalizeBlock(row), ...normalizeLink(row) })),
    error: null,
  }
}

export async function previewVizBlockDraftSql(
  connectionId: string,
  sqlTemplate: string,
  params: Record<string, unknown> = {},
): Promise<{ sql: string | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.preview_viz_block_sql(${q(sqlTemplate)}, ${jb(params)}) AS sql`,
    1,
    { readOnly: true },
  )
  if (!r.ok) return { sql: null, error: r.error }
  return { sql: r.rows.length ? String(r.rows[0]?.sql ?? "") : null, error: null }
}

export async function previewVizBlockSql(
  connectionId: string,
  name: string,
  params: Record<string, unknown> = {},
  version?: number | null,
): Promise<{ sql: string | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.preview_viz_block(${q(name)}, ${jb(params)}, ${nullableInt(version)}) AS sql`,
    1,
    { readOnly: true },
  )
  if (!r.ok) return { sql: null, error: r.error }
  return { sql: r.rows.length ? String(r.rows[0]?.sql ?? "") : null, error: null }
}

export async function defineVizBlock(
  connectionId: string,
  input: DefineVizBlockInput,
): Promise<{ version: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.define_viz_block(
       ${q(input.name)},
       ${q(input.sqlTemplate)},
       ${jb(input.inputSchema ?? {})},
       ${jb(input.layoutTemplate ?? {})},
       ${nullableText(input.title)},
       ${nullableText(input.intent ?? "overview")},
       ${nullableText(input.description)},
       ${nullableText(input.owner)},
       ${jb(input.params ?? {})},
       ${textArray(input.tags ?? [])},
       ${jb(input.labels ?? {})},
       ${boolSql(input.enabled, true)},
       ${jb((input.links ?? []).map(normalizeDefineLink))}
     ) AS version`,
  )
  if (!r.ok) return { version: null, error: r.error }
  return { version: r.rows.length ? Number(r.rows[0]?.version ?? 0) : null, error: null }
}

export async function linkVizBlock(
  connectionId: string,
  input: LinkVizBlockInput,
): Promise<{ linkId: number | null; error: string | null }> {
  const r = await run(
    connectionId,
    `SELECT rvbbit.link_viz_block(
       ${q(input.blockName)},
       ${q(input.objectKind)},
       ${q(input.objectKey)},
       ${nullableText(input.role ?? "source")},
       ${nullableFloat(input.confidence, 1.0)},
       ${nullableText(input.linkSource ?? "declared")},
       ${jb(input.conditions ?? {})},
       ${nullableInt(input.blockVersion)},
       ${nullableText(input.notes)}
     ) AS link_id`,
  )
  if (!r.ok) return { linkId: null, error: r.error }
  return { linkId: r.rows.length ? Number(r.rows[0]?.link_id ?? 0) : null, error: null }
}
