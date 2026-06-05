import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

// Live progress for a running rvbbit-lens query, polled from a SEPARATE pool
// connection while the main query is in flight. pg_stat_activity is server
// state (visible across connections) — unlike rvbbit.receipts/cost_events,
// which are transaction-isolated and invisible until the query commits. Gives
// elapsed time, state, and what the backend is waiting on (so "stuck on IO"
// vs "active/CPU-bound" is visible). Works on any connection (core catalog).
const PROGRESS_SQL = `
SELECT round(extract(epoch FROM (clock_timestamp() - query_start)) * 1000)::bigint AS elapsed_ms,
       state,
       nullif(coalesce(wait_event_type, '') ||
              CASE WHEN wait_event IS NOT NULL THEN ':' || wait_event ELSE '' END, '') AS wait,
       left(query, 240) AS q
FROM pg_stat_activity
WHERE datname = current_database()
  AND application_name = 'rvbbit-lens'
  AND state = 'active'
  AND pid <> pg_backend_pid()
ORDER BY query_start ASC
LIMIT 1`

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { connectionId?: string } | null
  if (!body?.connectionId) {
    return NextResponse.json({ ok: false, error: "connectionId required" }, { status: 400 })
  }
  try {
    const result = await executeQuery(body.connectionId, PROGRESS_SQL, {
      rowLimit: 1,
      readOnly: true,
    })
    const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined
    return NextResponse.json({
      ok: true,
      active: !!row,
      elapsedMs: row?.elapsed_ms == null ? null : Number(row.elapsed_ms),
      state: row?.state == null ? null : String(row.state),
      wait: row?.wait == null ? null : String(row.wait),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 200 })
  }
}
