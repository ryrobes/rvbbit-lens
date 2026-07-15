import "server-only"

/**
 * Finder vitals — everything on a Finder row that is a *number about the
 * table* rather than the table's shape: on-disk sizes, resolved row counts,
 * row-group tiers, generation/compaction, usage heat, drift.
 *
 * Split out of the schema snapshot so the tree (structure) and the instrument
 * panel (vitals) refresh independently: structure changes rarely and is
 * fingerprint-gated; vitals are a small keyed-by-oid patch the client merges
 * into existing rows without rebuilding the tree.
 */

import { getPool } from "./pool"
import { loadFinderStats } from "./finder-stats"
import type { SchemaTable } from "./types"

/** Field-for-field subset of SchemaTable — the client merge is a dumb spread. */
export interface FinderVitalsPatch {
  oid: number
  rows: number | null
  rowsSource: SchemaTable["rowsSource"]
  profiledAt: string | null
  sizeBytes: number | null
  heapBytes: number | null
  indexBytes: number | null
  toastBytes: number | null
  parquetRows: number | null
  parquetBytes: number | null
  hotParquetBytes: number | null
  coldBytes: number | null
  vortexBytes: number | null
  variantBytes: number | null
  rgCount: number | null
  coldCount: number | null
  freshness: SchemaTable["freshness"]
  generation: number | null
  lastCompactAt: string | null
  lanceEnabled: boolean
  heat: number | null
  driftSeverity: number | null
  driftFlags: string[] | null
  driftChangeType: string | null
}

// The one genuinely expensive catalog read: pg_*_relation_size() stats every
// file segment per relation. reltuples rides along for the rows fallback.
const SIZE_QUERY = `
SELECT
  c.oid::int8                                       AS oid,
  c.reltuples::bigint                               AS row_estimate,
  (am.amname = 'rvbbit')                            AS relam_is_rvbbit,
  pg_total_relation_size(c.oid)::bigint             AS size_bytes,
  -- COALESCE: pg_*_relation_size returns NULL for a relation whose file is gone
  -- (e.g. concurrent DROP); without it the tier silently vanishes from the total.
  COALESCE(pg_relation_size(c.oid), 0)::bigint      AS heap_bytes,
  COALESCE(pg_indexes_size(c.oid), 0)::bigint       AS index_bytes,
  CASE WHEN c.reltoastrelid <> 0
       THEN COALESCE(pg_relation_size(c.reltoastrelid), 0) ELSE 0 END::bigint AS toast_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_am am ON am.oid = c.relam
WHERE c.relkind IN ('r','v','m','f','p')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
`

const REGISTRY_QUERY = `
SELECT table_oid::int8 AS oid,
       acceleration_enabled
FROM rvbbit.tables
`

type SizeRow = {
  oid: string | number
  row_estimate: string | number | null
  relam_is_rvbbit: boolean | null
  size_bytes: string | number | null
  heap_bytes: string | number | null
  index_bytes: string | number | null
  toast_bytes: string | number | null
}

// Sizes change slowly and are the scale-sensitive part — a short TTL cache
// keeps rapid refreshes (post-DDL bursts, impatient clicking) from re-statting
// thousands of files. Everything else in the vitals batch is always fresh.
const SIZE_TTL_MS = 30_000
const sizeCache = new Map<string, { at: number; rows: SizeRow[] }>()

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function loadFinderVitals(connectionId: string): Promise<FinderVitalsPatch[]> {
  const { pool } = await getPool(connectionId, undefined, "meta")
  const client = await pool.connect()
  try {
    const cached = sizeCache.get(connectionId)
    const sizesFresh = cached != null && Date.now() - cached.at < SIZE_TTL_MS

    const [sizesSettled, registrySettled, stats] = await Promise.all([
      sizesFresh
        ? Promise.resolve({ status: "fulfilled" as const, value: { rows: cached.rows } })
        : client.query(SIZE_QUERY).then(
            (r) => ({ status: "fulfilled" as const, value: { rows: r.rows as SizeRow[] } }),
            () => ({ status: "rejected" as const }),
          ),
      client.query(REGISTRY_QUERY).then(
        (r) => ({ status: "fulfilled" as const, value: r }),
        () => ({ status: "rejected" as const }),
      ),
      loadFinderStats(client),
    ])

    const sizeRows: SizeRow[] = sizesSettled.status === "fulfilled" ? sizesSettled.value.rows : []
    if (!sizesFresh && sizesSettled.status === "fulfilled") {
      sizeCache.set(connectionId, { at: Date.now(), rows: sizeRows })
    }

    const registryByOid = new Map<string, boolean>()
    if (registrySettled.status === "fulfilled") {
      for (const r of registrySettled.value.rows as Array<{ oid: string | number; acceleration_enabled: unknown }>) {
        const v = r.acceleration_enabled
        registryByOid.set(String(r.oid), v === true || v === "t" || v === "true")
      }
    }

    return sizeRows.map((t) => {
      const key = String(t.oid)
      const st = stats.byOid.get(key)
      const isRvbbit = registryByOid.get(key) ?? (t.relam_is_rvbbit === true)
      const reltuples = num(t.row_estimate)
      const heapEst = reltuples != null && reltuples >= 0 ? reltuples : null
      // Same precedence the snapshot used to apply: crawl count(*) wins, then
      // live rvbbit parquet rows, then the heap estimate.
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
        oid: Number(t.oid),
        rows,
        rowsSource,
        profiledAt: st?.profiledAt ?? null,
        sizeBytes: num(t.size_bytes),
        heapBytes: num(t.heap_bytes),
        indexBytes: num(t.index_bytes),
        toastBytes: num(t.toast_bytes),
        parquetRows: st?.parquetRows ?? null,
        parquetBytes: st?.parquetBytes ?? null,
        hotParquetBytes: st?.hotParquetBytes ?? null,
        coldBytes: st?.coldBytes ?? null,
        vortexBytes: st?.vortexBytes ?? null,
        variantBytes: st?.variantBytes ?? null,
        rgCount: st?.rgCount ?? null,
        coldCount: st?.coldCount ?? null,
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
  } finally {
    client.release()
  }
}
