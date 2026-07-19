import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

interface PanelRow {
  id: string
  label: string
  description?: string | null
  folder?: string | null
  hints?: string[]
  notes?: string | null
}

/** Sync the lens launcher registry into rvbbit.desktop_panels (0190):
 *  upsert everything, prune what the running lens no longer ships. The
 *  table is the assistant's on-demand help index — best-effort, silent on
 *  pre-0190 servers. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    panels?: PanelRow[]
  } | null
  if (!body?.connectionId || !Array.isArray(body.panels) || body.panels.length === 0) {
    return NextResponse.json({ ok: false, error: "connectionId and panels required" }, { status: 400 })
  }
  const panels = body.panels.filter((p) => p?.id && p?.label).slice(0, 200)
  try {
    const values = panels
      .map(
        (p) =>
          `(${lit(p.id)}, ${lit(p.label)}, ${p.description ? lit(p.description) : "NULL"}, ` +
          `${p.folder ? lit(p.folder) : "NULL"}, ${lit(JSON.stringify(p.hints ?? []))}::jsonb, ` +
          `${p.notes ? lit(p.notes) : "NULL"})`,
      )
      .join(", ")
    await executeQuery(
      body.connectionId,
      `INSERT INTO rvbbit.desktop_panels AS d (id, label, description, folder, hints, notes)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         folder = EXCLUDED.folder,
         hints = EXCLUDED.hints,
         notes = EXCLUDED.notes,
         updated_at = clock_timestamp()`,
      { rowLimit: 1 },
    )
    await executeQuery(
      body.connectionId,
      `DELETE FROM rvbbit.desktop_panels
       WHERE NOT (id = ANY(ARRAY[${panels.map((p) => lit(p.id)).join(", ")}]::text[]))`,
      { rowLimit: 1 },
    )
    return NextResponse.json({ ok: true, count: panels.length })
  } catch (e) {
    // pre-0190 server or transient failure — help degrades, work continues
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
