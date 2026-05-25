import "server-only"

import { getPool } from "./pool"
import type { ExtensionInfo, SchemaColumn, SchemaSnapshot, SchemaTable } from "./types"

const TABLE_QUERY = `
SELECT
  c.oid::int8                                       AS oid,
  n.nspname                                         AS schema,
  c.relname                                         AS name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'matview'
    WHEN 'f' THEN 'foreign'
    WHEN 'p' THEN 'partition'
    ELSE 'other'
  END                                               AS kind,
  c.reltuples::bigint                               AS row_estimate,
  pg_total_relation_size(c.oid)::bigint             AS size_bytes,
  obj_description(c.oid, 'pg_class')                AS comment
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','v','m','f','p')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
ORDER BY n.nspname, c.relname
`

const COLUMN_QUERY = `
SELECT
  a.attrelid::int8                                   AS table_oid,
  a.attname                                          AS name,
  format_type(a.atttypid, a.atttypmod)               AS data_type,
  t.typname                                          AS udt_name,
  a.atttypid::int4                                   AS type_oid,
  NOT a.attnotnull                                   AS nullable,
  pg_get_expr(d.adbin, d.adrelid)                    AS default,
  a.attnum                                           AS ordinal,
  col_description(a.attrelid, a.attnum)              AS comment,
  COALESCE(pk.is_pk, false)                          AS is_primary_key
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef d
       ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN (
  SELECT conrelid AS table_oid, unnest(conkey) AS attnum, true AS is_pk
  FROM pg_constraint WHERE contype = 'p'
) pk ON pk.table_oid = a.attrelid AND pk.attnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum
`

const EXTENSION_QUERY = `
SELECT e.extname AS name,
       n.nspname AS schema,
       e.extversion AS version,
       d.description AS description
FROM pg_extension e
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_description d
       ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass
ORDER BY e.extname
`

export async function loadExtensions(connectionId: string): Promise<ExtensionInfo[]> {
  const { pool } = await getPool(connectionId)
  const result = await pool.query<ExtensionInfo>(EXTENSION_QUERY)
  return result.rows
}

export async function loadSchema(connectionId: string): Promise<SchemaSnapshot> {
  const { pool } = await getPool(connectionId)
  const client = await pool.connect()
  try {
    const [tablesResult, columnsResult, dbResult, schemasResult, extResult] = await Promise.all([
      client.query(TABLE_QUERY),
      client.query(COLUMN_QUERY),
      client.query<{ database: string }>("SELECT current_database() AS database"),
      client.query<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog','information_schema')
           AND nspname NOT LIKE 'pg_toast%'
           AND nspname NOT LIKE 'pg_temp_%'
         ORDER BY nspname`,
      ),
      client.query<ExtensionInfo>(EXTENSION_QUERY),
    ])

    // Group columns by oid for O(n) join.
    const colsByTable = new Map<string, SchemaColumn[]>()
    for (const row of columnsResult.rows as Array<SchemaColumn & { table_oid: string | number }>) {
      const key = String(row.table_oid)
      const list = colsByTable.get(key) ?? []
      const col: SchemaColumn = {
        name: row.name,
        dataType: row.dataType ?? (row as unknown as { data_type: string }).data_type,
        udtName: row.udtName ?? (row as unknown as { udt_name: string }).udt_name,
        typeOid: row.typeOid ?? Number((row as unknown as { type_oid: number }).type_oid),
        nullable: row.nullable ?? false,
        default: row.default ?? null,
        ordinal: row.ordinal ?? 0,
        comment: row.comment ?? null,
        isPrimaryKey: row.isPrimaryKey ?? (row as unknown as { is_primary_key: boolean }).is_primary_key,
      }
      list.push(col)
      colsByTable.set(key, list)
    }

    const tables: SchemaTable[] = (tablesResult.rows as Array<{
      oid: string | number
      schema: string
      name: string
      kind: SchemaTable["kind"]
      row_estimate: string | number | null
      size_bytes: string | number | null
      comment: string | null
    }>).map((t) => ({
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      rowEstimate: t.row_estimate == null ? null : Number(t.row_estimate),
      sizeBytes: t.size_bytes == null ? null : Number(t.size_bytes),
      comment: t.comment,
      columns: colsByTable.get(String(t.oid)) ?? [],
      isRvbbit: t.schema === "rvbbit" || t.schema === "pg_rvbbit",
    }))

    const extensions = extResult.rows
    const rvbbitExt = extensions.find((e) => e.name === "rvbbit" || e.name === "pg_rvbbit") ?? null

    return {
      connectionId,
      generatedAt: new Date().toISOString(),
      databases: [],
      currentDatabase: dbResult.rows[0]?.database ?? "",
      schemas: schemasResult.rows.map((r) => r.nspname),
      tables,
      extensions,
      hasRvbbit: !!rvbbitExt,
      rvbbitVersion: rvbbitExt?.version ?? null,
    }
  } finally {
    client.release()
  }
}
