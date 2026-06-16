import "server-only"

import { getPool } from "./pool"
import type { RvbbitStatus } from "./types"

export async function loadRvbbitStatus(connectionId: string): Promise<RvbbitStatus> {
  const start = Date.now()
  const { pool } = await getPool(connectionId, undefined, "meta")
  const result = await pool.query<{ version: string }>(`
SELECT extversion AS version
FROM pg_extension
WHERE extname IN ('pg_rvbbit', 'rvbbit')
ORDER BY CASE extname WHEN 'pg_rvbbit' THEN 0 ELSE 1 END
LIMIT 1`)
  const version = result.rows[0]?.version ?? null
  return {
    connectionId,
    hasRvbbit: version != null,
    rvbbitVersion: version,
    durationMs: Date.now() - start,
  }
}
