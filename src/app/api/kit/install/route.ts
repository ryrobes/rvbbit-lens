import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/** One-click kit install from a capability_catalog entry (kind='kit').
 *  The manifest's install_sql runs TWICE: first wrapped in an explicit
 *  BEGIN/ROLLBACK (validation — the FUNCTIONrvbbit policy as an API), then
 *  for real. Each run is a single multi-statement call, so it executes on
 *  one connection as one implicit transaction — all-or-nothing. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    catalogId?: string
  } | null
  if (!body?.connectionId || !body?.catalogId) {
    return NextResponse.json({ ok: false, error: "connectionId and catalogId required" }, { status: 400 })
  }
  try {
    const entry = await executeQuery(
      body.connectionId,
      `SELECT manifest->>'install_sql' AS install_sql, name FROM rvbbit.capability_catalog
       WHERE id = ${sqlLit(body.catalogId)} AND kind = 'kit'`,
      { readOnly: true, rowLimit: 1 },
    )
    const row = entry.rows?.[0] as { install_sql?: string; name?: string } | undefined
    if (!row?.install_sql) {
      return NextResponse.json({ ok: false, error: `no kit install_sql at catalog id ${body.catalogId}` })
    }
    const script = row.install_sql
    // Validation pass: same script, explicitly rolled back.
    try {
      await executeQuery(body.connectionId, `BEGIN;\n${script}\nROLLBACK;`, { rowLimit: 1 })
    } catch (e) {
      return NextResponse.json({
        ok: false,
        error: `validation failed (nothing was installed): ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    await executeQuery(body.connectionId, script, { rowLimit: 1 })
    // Post-install self-test: surface anything broken on THIS box.
    const kitName = row.name ?? body.catalogId.replace(/^kit\//, "")
    let failures: Array<{ item: string; detail: string }> = []
    try {
      const vres = await executeQuery(
        body.connectionId,
        `SELECT item, detail FROM rvbbit.validate_kit(${sqlLit(kitName)}) WHERE NOT ok`,
        { readOnly: true, rowLimit: 50 },
      )
      failures = (vres.rows ?? []) as Array<{ item: string; detail: string }>
    } catch {
      // validate_kit absent (older target) — install still succeeded
    }
    return NextResponse.json({ ok: true, kit: kitName, selftestFailures: failures })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
