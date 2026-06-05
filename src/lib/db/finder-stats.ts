import "server-only"

/**
 * Finder "instrument panel" stats — one batch of cheap queries run alongside the
 * schema load to hydrate each table row with rvbbit-native vitals: real row
 * counts (crawl + parquet), accelerator freshness, storage tier (hot/cold row
 * groups), generation/last-compact, Lance, and usage heat.
 *
 * Each rvbbit/catalog query self-degrades: if the rvbbit schema isn't installed
 * (or a column name drifts), Promise.allSettled drops that query and the Finder
 * falls back to plain behavior — never throws.
 */

interface Queryable {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface FinderStat {
  parquetRows?: number | null
  /** all row-group bytes (hot + cold) — kept for back-compat; the tooltip uses the split below. */
  parquetBytes?: number | null
  rgCount?: number | null
  coldCount?: number | null
  shadowRetained?: boolean | null
  shadowDirty?: boolean | null
  generation?: number | null
  lastCompactAt?: string | null
  lanceUrl?: string | null
  crawlRows?: number | null
  profiledAt?: string | null
  heat?: number | null
  driftSeverity?: number | null
  driftFlags?: string[] | null
  driftChangeType?: string | null
  // ── per-tier rvbbit footprint (for the Finder storage-breakdown tooltip) ──
  // hot/cold are DISJOINT row-group bytes. heap/index/toast come from TABLE_QUERY
  // (pg-native, universal) — not here. vortex/variant are REDUNDANT accelerator
  // copies — shown separately, NOT summed into the footprint total.
  /** local hot-tier parquet row groups (cold_url IS NULL). */
  hotParquetBytes?: number | null
  /** cold-tier row groups migrated to ObjectStore (cold_url IS NOT NULL). */
  coldBytes?: number | null
  /** vortex_scan layout-variant files (a compressed copy of canonical parquet). */
  vortexBytes?: number | null
  /** other layout-variant copies (cluster/hive/…). */
  variantBytes?: number | null
}

// Q1 — rvbbit accelerator stats: freshness + parquet rows/bytes + row-group
// (hot/cold) counts + current generation + last-compact, keyed by table oid.
const RVBBIT_STATS_QUERY = `
SELECT
  t.table_oid::int8                                     AS oid,
  t.shadow_heap_retained                                AS shadow_retained,
  t.shadow_heap_dirty                                   AS shadow_dirty,
  t.lance_url                                           AS lance_url,
  COALESCE(rg.n_rows_total, 0)::int8                    AS parquet_rows,
  COALESCE(rg.n_bytes_total, 0)::int8                   AS parquet_bytes,
  COALESCE(rg.hot_bytes, 0)::int8                       AS hot_parquet_bytes,
  COALESCE(rg.cold_bytes, 0)::int8                      AS cold_bytes,
  COALESCE(rg.rg_count, 0)::int4                        AS rg_count,
  COALESCE(rg.cold_count, 0)::int4                      AS cold_count,
  g.max_generation::int8                                AS generation,
  g.last_compact_at                                     AS last_compact_at
FROM rvbbit.tables t
LEFT JOIN (
  SELECT table_oid,
         SUM(n_rows)                                       AS n_rows_total,
         SUM(n_bytes)                                       AS n_bytes_total,
         SUM(n_bytes) FILTER (WHERE cold_url IS NULL)       AS hot_bytes,
         SUM(n_bytes) FILTER (WHERE cold_url IS NOT NULL)   AS cold_bytes,
         COUNT(*)                                           AS rg_count,
         COUNT(*) FILTER (WHERE cold_url IS NOT NULL)       AS cold_count
  FROM rvbbit.row_groups
  GROUP BY table_oid
) rg ON rg.table_oid = t.table_oid
LEFT JOIN (
  SELECT table_oid, MAX(generation) AS max_generation, MAX(committed_at) AS last_compact_at
  FROM rvbbit.generations
  GROUP BY table_oid
) g ON g.table_oid = t.table_oid
`

// Q5 — layout-variant footprint (vortex + other alt-layout copies). Kept SEPARATE
// from Q1 so an older extension without rvbbit.row_group_variants degrades only
// this query (no vortex segment) instead of blanking all the core stats.
const VARIANT_BYTES_QUERY = `
SELECT
  table_oid::int8 AS oid,
  COALESCE(SUM(n_bytes) FILTER (WHERE layout IN ('vortex','vortex_scan')), 0)::int8     AS vortex_bytes,
  COALESCE(SUM(n_bytes) FILTER (WHERE layout NOT IN ('vortex','vortex_scan')), 0)::int8 AS variant_bytes
FROM rvbbit.row_group_variants
GROUP BY table_oid
`

// Q2 — exact crawl row counts (count(*) at crawl time) for ANY crawled table.
// Keys on the OID the crawler stamped into properties.oid — so a table that was
// dropped and recreated (new oid) simply won't match any live table in the
// merge (no stale count leaks onto a same-named replacement), and we avoid the
// pg_class name-join entirely.
const CRAWL_ROWS_QUERY = `
SELECT
  (n.properties->>'oid')::oid::int8    AS oid,
  (n.properties->>'n_rows')::int8      AS crawl_rows,
  n.properties->>'profiled_at'         AS profiled_at
FROM rvbbit.kg_nodes n
WHERE n.graph_id = 'db_catalog'
  AND n.kind = 'db_table'
  AND n.properties ? 'oid'
  AND n.properties ? 'n_rows'
`

// Q3 — usage heat: distinct queries that produced evidence about each table in
// the last 7 days. source_table is regclass → oid joins directly.
const USAGE_HEAT_QUERY = `
SELECT source_table::oid::int8 AS oid, COUNT(DISTINCT query_id)::int4 AS hits_7d
FROM rvbbit.kg_evidence
WHERE created_at >= now() - interval '7 days'
  AND source_table IS NOT NULL
  AND query_id IS NOT NULL
GROUP BY source_table
`

// Q4 — table-level drift: the latest finished crawl vs the previous one. Keyed
// to oid via the crawler-stamped fingerprint.oid on the latest snapshot (so a
// dropped+recreated table can't inherit a same-named predecessor's drift). Only
// runs when ≥2 successful crawls exist (else `pair` is empty → no drift badges).
const DRIFT_QUERY = `
WITH runs AS (
  SELECT run_id, finished_at
  FROM rvbbit.catalog_runs
  WHERE graph_id = 'db_catalog' AND status = 'ok'
  ORDER BY finished_at DESC NULLS LAST, run_id DESC
  LIMIT 2
),
pair AS (
  SELECT run_latest, run_previous
  FROM (
    -- Label by COMPLETION order, not run_id: a slow low-run_id crawl can finish
    -- after a fast high-run_id one, and the most-recently-finished run holds the
    -- newest snapshot. Ordering by run_id alone would invert the drift direction.
    SELECT (array_agg(run_id ORDER BY finished_at DESC NULLS LAST, run_id DESC))[1] AS run_latest,
           (array_agg(run_id ORDER BY finished_at DESC NULLS LAST, run_id DESC))[2] AS run_previous
    FROM runs
  ) x
  WHERE run_previous IS NOT NULL
)
SELECT
  (s.fingerprint->>'oid')::oid::int8   AS oid,
  d.severity                           AS drift_severity,
  d.flags                              AS drift_flags,
  d.change_type                        AS drift_change_type
FROM pair p
CROSS JOIN LATERAL rvbbit.catalog_drift(p.run_previous, p.run_latest, 'db_catalog', true) d
JOIN rvbbit.catalog_snapshots s
  ON s.graph_id = 'db_catalog'
  AND s.kind = 'db_table'
  AND s.run_id = p.run_latest
  AND s.obj_key = d.obj_key
  AND s.fingerprint ? 'oid'
WHERE d.kind = 'db_table'
`

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function bool(v: unknown): boolean | null {
  return v == null ? null : v === true || v === "t" || v === "true"
}
function str(v: unknown): string | null {
  return v == null ? null : String(v)
}

export async function loadFinderStats(client: Queryable): Promise<{ byOid: Map<string, FinderStat> }> {
  const byOid = new Map<string, FinderStat>()
  const patch = (oid: unknown, p: Partial<FinderStat>) => {
    const k = String(oid)
    byOid.set(k, { ...(byOid.get(k) ?? {}), ...p })
  }

  const [rv, cr, ht, dr, va] = await Promise.allSettled([
    client.query(RVBBIT_STATS_QUERY),
    client.query(CRAWL_ROWS_QUERY),
    client.query(USAGE_HEAT_QUERY),
    client.query(DRIFT_QUERY),
    client.query(VARIANT_BYTES_QUERY),
  ])

  if (rv.status === "fulfilled") {
    for (const r of rv.value.rows) {
      patch(r.oid, {
        parquetRows: num(r.parquet_rows),
        parquetBytes: num(r.parquet_bytes),
        hotParquetBytes: num(r.hot_parquet_bytes),
        coldBytes: num(r.cold_bytes),
        rgCount: num(r.rg_count),
        coldCount: num(r.cold_count),
        shadowRetained: bool(r.shadow_retained),
        shadowDirty: bool(r.shadow_dirty),
        generation: num(r.generation),
        lastCompactAt: str(r.last_compact_at),
        lanceUrl: str(r.lance_url),
      })
    }
  }
  if (cr.status === "fulfilled") {
    for (const r of cr.value.rows) patch(r.oid, { crawlRows: num(r.crawl_rows), profiledAt: str(r.profiled_at) })
  }
  if (ht.status === "fulfilled") {
    for (const r of ht.value.rows) patch(r.oid, { heat: num(r.hits_7d) })
  }
  if (dr.status === "fulfilled") {
    for (const r of dr.value.rows) {
      patch(r.oid, {
        driftSeverity: num(r.drift_severity),
        driftFlags: Array.isArray(r.drift_flags) ? (r.drift_flags as unknown[]).map(String) : null,
        driftChangeType: str(r.drift_change_type),
      })
    }
  }
  if (va.status === "fulfilled") {
    for (const r of va.value.rows) patch(r.oid, { vortexBytes: num(r.vortex_bytes), variantBytes: num(r.variant_bytes) })
  }

  return { byOid }
}
