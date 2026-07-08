/** GQE (NVIDIA GPU Query Engine) status for the menu-bar tray.
 *
 * Status comes from `rvbbit.accelerator_runtime_status()->'gpu_gqe'` — passive
 * (its sidecar probe is cached extension-side), safe to poll. Hardware is
 * best-effort from `rvbbit.warren_gpu_capacity` (only populated when a warren
 * agent with GPU visibility reports inventory); routing activity from
 * `rvbbit.route_decisions`. `rvbbit.warm_gpu_gqe()` starts the engine.
 */

export interface GqeStatus {
  binary_found?: boolean
  config_enabled?: boolean
  routes_available?: boolean
  route_gate_enabled?: boolean
  reason?: string
  protocol?: string
  binary_path?: string
}

export interface GqeGpu {
  node: string
  names: string[] | null
  count: number
  total: number
  usable: number
  available: number
}

export interface GqeActivity {
  d1: number
  d7: number
  total: number
}

export interface GqeDetails {
  status: GqeStatus | null
  gpus: GqeGpu[]
  activity: GqeActivity | null
}

async function runQuery(
  connectionId: string,
  sql: string,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 50, readOnly: true }),
    })
    const body = (await res.json()) as { ok?: boolean; rows?: Record<string, unknown>[]; error?: string }
    if (!body.ok) return { ok: false, error: body.error ?? "query failed" }
    return { ok: true, rows: body.rows ?? [] }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === "object") return v as T
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T
    } catch {
      return null
    }
  }
  return null
}

/** The engine is present-and-routable on this instance (icon visibility). */
export function gqeAvailable(s: GqeStatus | null): boolean {
  return !!(s && s.binary_found && s.config_enabled && s.routes_available)
}

/** The GQE server process is actually running (hot) vs auto-start-ready. */
export function gqeRunning(s: GqeStatus | null): boolean {
  if (!s) return false
  return !/not running/i.test(s.reason ?? "")
}

export async function fetchGqeStatus(connectionId: string): Promise<GqeStatus | null> {
  const r = await runQuery(
    connectionId,
    "SELECT ((rvbbit.accelerator_runtime_status())::jsonb -> 'gpu_gqe') AS gqe",
  )
  if (!r.ok || r.rows.length === 0) return null
  return parseJson<GqeStatus>(r.rows[0].gqe)
}

export async function fetchGqeDetails(connectionId: string): Promise<GqeDetails> {
  const r = await runQuery(
    connectionId,
    `SELECT
       ((rvbbit.accelerator_runtime_status())::jsonb -> 'gpu_gqe') AS gqe,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'node', node_name, 'names', gpu_names, 'count', gpu_count,
            'total', gpu_mem_total_bytes, 'usable', gpu_mem_usable_bytes,
            'available', gpu_available_bytes)), '[]'::jsonb)
          FROM rvbbit.warren_gpu_capacity WHERE gpu_count > 0) AS gpus,
       (SELECT jsonb_build_object(
            'd1', count(*) FILTER (WHERE decided_at > now() - interval '24 hours'),
            'd7', count(*) FILTER (WHERE decided_at > now() - interval '7 days'),
            'total', count(*))
          FROM rvbbit.route_decisions WHERE route = 'gpu_gqe') AS activity`,
  )
  if (!r.ok || r.rows.length === 0) return { status: null, gpus: [], activity: null }
  const row = r.rows[0]
  return {
    status: parseJson<GqeStatus>(row.gqe),
    gpus: parseJson<GqeGpu[]>(row.gpus) ?? [],
    activity: parseJson<GqeActivity>(row.activity),
  }
}

export async function warmGqe(connectionId: string): Promise<{ ok: boolean; message: string }> {
  // First choice: the extension's own warm probe.
  const r = await runQuery(connectionId, "SELECT rvbbit.warm_gpu_gqe() AS warm")
  if (r.ok) {
    const payload = parseJson<Record<string, unknown>>(r.rows[0]?.warm)
    const status = String(payload?.status ?? "")
    if (status === "warm") return { ok: true, message: "warm" }
    if (status === "failed") return { ok: false, message: String(payload?.error ?? "warm failed") }
    // 'disabled' (router prior off — the default) or 'unavailable'
    // (e.g. smallest table is schema-qualified, which GQE refuses):
    // fall through to the direct recipe below.
  }
  // Direct warm: a forced-GQE count over the smallest PUBLIC-schema
  // accelerated table. Both statements must run top-level in one session —
  // the route rewrite does not fire inside DO/SPI — and the table must be
  // unqualified (GQE rejects schema-qualified references).
  const t = await runQuery(
    connectionId,
    `SELECT rg.table_oid::regclass::text AS t
     FROM rvbbit.row_groups rg
     WHERE rg.table_oid::regclass::text NOT LIKE '%.%'
     GROUP BY rg.table_oid
     ORDER BY sum(rg.n_rows) ASC NULLS LAST LIMIT 1`,
  )
  if (!t.ok) return { ok: false, message: t.error }
  if (t.rows.length === 0) return { ok: false, message: "no public-schema accelerated table to warm with" }
  const table = String(t.rows[0].t)
  const w = await runQuery(
    connectionId,
    `SET rvbbit.route_force_candidate = 'gpu_gqe'; SELECT count(*) FROM ${table}`,
  )
  return w.ok ? { ok: true, message: `warmed via ${table}` } : { ok: false, message: w.error }
}
