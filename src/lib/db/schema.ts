import "server-only"

import { getPool } from "./pool"
import type { ExtensionInfo, SchemaColumn, SchemaFunction, SchemaSnapshot, SchemaTable } from "./types"
import { loadFinderStats } from "./finder-stats"

type OperatorRow = { name: string; description: string | null; shape: string | null }
type RvbbitRegistryRow = { oid: string | number; acceleration_enabled: boolean | string | null }

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
  -- COALESCE: pg_*_relation_size returns NULL for a relation whose file is gone
  -- (e.g. concurrent DROP); without it the tier silently vanishes from the total.
  COALESCE(pg_relation_size(c.oid), 0)::bigint      AS heap_bytes,
  COALESCE(pg_indexes_size(c.oid), 0)::bigint       AS index_bytes,
  CASE WHEN c.reltoastrelid <> 0
       THEN COALESCE(pg_relation_size(c.reltoastrelid), 0) ELSE 0 END::bigint AS toast_bytes,
  obj_description(c.oid, 'pg_class')                AS comment,
  (am.amname = 'rvbbit')                            AS relam_is_rvbbit
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_am am ON am.oid = c.relam
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

// Callable routines in user schemas. `_`-prefixed names are rvbbit internals
// (the user only wants the public-facing semantic functions). arg_names is the
// ordered list of INPUT args (filtering out OUT/TABLE columns via proargmodes);
// required_count = inputs without a default (trailing defaults are optional).
const FUNCTION_QUERY = `
SELECT
  n.nspname                          AS schema,
  p.proname                          AS name,
  pg_get_function_arguments(p.oid)   AS args,
  pg_get_function_result(p.oid)      AS result,
  obj_description(p.oid, 'pg_proc')  AS comment,
  CASE p.prokind
    WHEN 'a' THEN 'aggregate'
    WHEN 'w' THEN 'window'
    WHEN 'p' THEN 'procedure'
    ELSE 'function'
  END                                AS kind,
  GREATEST(p.pronargs - p.pronargdefaults, 0)::int AS required_count,
  COALESCE((
    SELECT array_agg(u.an ORDER BY u.ord)
    FROM unnest(
           COALESCE(p.proargnames, ARRAY[]::text[]),
           COALESCE(p.proargmodes, ARRAY[]::"char"[])
         ) WITH ORDINALITY AS u(an, am, ord)
    WHERE u.am IS NULL OR u.am IN ('i','b','v')
  ), ARRAY[]::text[])                AS arg_names
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
  AND left(p.proname, 1) <> '_'
  AND p.prokind IN ('f','a','w','p')
ORDER BY n.nspname, p.proname
`

// rvbbit semantic operators carry human descriptions + a shape (scalar /
// aggregate / dimension / rowset). We merge these onto the matching pg_proc
// functions for richer completion info. Guarded at the call site (.catch) so
// connections without the rvbbit extension don't error on the missing table.
const OPERATOR_QUERY = `SELECT name, description, shape FROM rvbbit.operators`

// Registry-first rvbbit identity. Guarded at the call site so plain Postgres
// connections and older extension versions still degrade to relam detection.
const RVBBIT_TABLE_REGISTRY_QUERY = `
SELECT table_oid::int8 AS oid,
       coalesce(acceleration_enabled, true) AS acceleration_enabled
FROM rvbbit.tables
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
  const { pool } = await getPool(connectionId, undefined, "meta")
  const result = await pool.query<ExtensionInfo>(EXTENSION_QUERY)
  return result.rows
}

export async function loadSchema(connectionId: string): Promise<SchemaSnapshot> {
  const { pool } = await getPool(connectionId, undefined, "meta")
  const client = await pool.connect()
  try {
    const [
      tablesResult,
      columnsResult,
      dbResult,
      schemasResult,
      extResult,
      functionsResult,
      opsResult,
      rvbbitRegistryResult,
      finderStats,
    ] = await Promise.all([
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
      client.query(FUNCTION_QUERY),
      client.query<OperatorRow>(OPERATOR_QUERY).catch(() => ({ rows: [] as OperatorRow[] })),
      client.query<RvbbitRegistryRow>(RVBBIT_TABLE_REGISTRY_QUERY).catch(() => ({ rows: [] as RvbbitRegistryRow[] })),
      loadFinderStats(client),
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

    const bool = (v: unknown) => v === true || v === "t" || v === "true"
    const rvbbitRegistryByOid = new Map<string, boolean>()
    for (const row of rvbbitRegistryResult.rows) {
      rvbbitRegistryByOid.set(String(row.oid), bool(row.acceleration_enabled))
    }

    const tables: SchemaTable[] = (tablesResult.rows as Array<{
      oid: string | number
      schema: string
      name: string
      kind: SchemaTable["kind"]
      row_estimate: string | number | null
      size_bytes: string | number | null
      heap_bytes: string | number | null
      index_bytes: string | number | null
      toast_bytes: string | number | null
      comment: string | null
      relam_is_rvbbit: boolean | null
    }>).map((t) => {
      const numOrNull = (v: string | number | null) => (v == null ? null : Number(v))
      const cols = colsByTable.get(String(t.oid)) ?? []
      const registryEnabled = rvbbitRegistryByOid.get(String(t.oid))
      const isRvbbit = registryEnabled ?? (t.relam_is_rvbbit === true)
      const st = finderStats.byOid.get(String(t.oid))
      const reltuples = t.row_estimate == null ? null : Number(t.row_estimate)
      // PG14+ uses -1 as the "never analyzed" sentinel — clamp to null so we
      // never render a literal -1.
      const heapEst = reltuples != null && reltuples >= 0 ? reltuples : null
      // Real count(*) from the crawl wins; then live rvbbit parquet rows; then
      // the heap estimate.
      let rows: number | null = null
      let rowsSource: SchemaTable["rowsSource"] = null
      if (st?.crawlRows != null) {
        rows = st.crawlRows
        rowsSource = "crawl"
      } else if (isRvbbit && st?.parquetRows != null) {
        rows = st.parquetRows
        rowsSource = "live"
      } else if (heapEst != null) {
        rows = heapEst
        rowsSource = "estimate"
      }
      return {
        schema: t.schema,
        name: t.name,
        oid: Number(t.oid),
        kind: t.kind,
        rowEstimate: reltuples,
        sizeBytes: t.size_bytes == null ? null : Number(t.size_bytes),
        comment: t.comment,
        columns: cols,
        colCount: cols.length,
        isRvbbit,
        rows,
        rowsSource,
        profiledAt: st?.profiledAt ?? null,
        parquetRows: st?.parquetRows ?? null,
        parquetBytes: st?.parquetBytes ?? null,
        rgCount: st?.rgCount ?? null,
        coldCount: st?.coldCount ?? null,
        // pg-native footprint (universal — every table); cold copies handled below.
        heapBytes: numOrNull(t.heap_bytes),
        indexBytes: numOrNull(t.index_bytes),
        toastBytes: numOrNull(t.toast_bytes),
        // rvbbit row-group split + redundant accelerator copies.
        hotParquetBytes: st?.hotParquetBytes ?? null,
        coldBytes: st?.coldBytes ?? null,
        vortexBytes: st?.vortexBytes ?? null,
        variantBytes: st?.variantBytes ?? null,
        freshness: !isRvbbit ? "na" : st ? (st.shadowDirty ? "stale" : "fresh") : "na",
        generation: st?.generation ?? null,
        lastCompactAt: st?.lastCompactAt ?? null,
        lanceEnabled: !!st?.lanceUrl,
        heat: st?.heat ?? null,
        driftSeverity: st?.driftSeverity ?? null,
        driftFlags: st?.driftFlags ?? null,
        driftChangeType: st?.driftChangeType ?? null,
      }
    })

    // Map operator name → { description, shape } for the semantic functions.
    const opByName = new Map<string, OperatorRow>()
    for (const o of opsResult.rows) opByName.set(o.name, o)

    const functions: SchemaFunction[] = (functionsResult.rows as Array<{
      schema: string
      name: string
      args: string | null
      result: string | null
      comment: string | null
      kind: SchemaFunction["kind"]
      required_count: number | string | null
      arg_names: string[] | null
    }>).map((f) => {
      const op = opByName.get(f.name)
      return {
        schema: f.schema,
        name: f.name,
        args: f.args ?? "",
        result: f.result ?? "",
        // operator description (richer/semantic) wins over the pg_proc comment.
        comment: op?.description?.trim() || f.comment || null,
        kind: f.kind,
        argNames: f.arg_names ?? [],
        requiredCount: Number(f.required_count) || 0,
        shape: op?.shape ?? null,
      }
    })

    const extensions = extResult.rows
    const rvbbitExt = extensions.find((e) => e.name === "rvbbit" || e.name === "pg_rvbbit") ?? null

    return {
      connectionId,
      generatedAt: new Date().toISOString(),
      databases: [],
      currentDatabase: dbResult.rows[0]?.database ?? "",
      schemas: schemasResult.rows.map((r) => r.nspname),
      tables,
      functions,
      extensions,
      hasRvbbit: !!rvbbitExt,
      rvbbitVersion: rvbbitExt?.version ?? null,
    }
  } finally {
    client.release()
  }
}
