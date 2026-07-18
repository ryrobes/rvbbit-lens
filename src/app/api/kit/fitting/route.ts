import { NextResponse } from "next/server"
import { executeQuery } from "@/lib/db/query"

export const runtime = "nodejs"

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/** Fitting Room backend: one route, op-switched. All the intelligence
 *  lives in the engine (rvbbit.fitting_*); this is plumbing. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    connectionId?: string
    op?: string
    kit?: string
    target?: string
    schemaName?: string
    relName?: string
    selectSql?: string
    proposal?: unknown
  } | null
  if (!body?.connectionId || !body?.op) {
    return NextResponse.json({ ok: false, error: "connectionId and op required" }, { status: 400 })
  }
  const cid = body.connectionId
  try {
    switch (body.op) {
      case "overview": {
        const res = await executeQuery(
          cid,
          `SELECT kt.kit, kt.target, kt.description, kt.columns,
                  f.accepted_at, f.accepted_by, f.select_sql,
                  (to_regclass(kt.target) IS NOT NULL) AS view_exists
           FROM rvbbit.kit_targets kt
           LEFT JOIN rvbbit.kit_fittings f USING (kit, target)
           ORDER BY kt.kit, kt.target`,
          { readOnly: true, rowLimit: 500 },
        )
        return NextResponse.json({ ok: true, targets: res.rows ?? [] })
      }
      case "candidates": {
        if (!body.kit || !body.target) throw new Error("kit and target required")
        const res = await executeQuery(
          cid,
          `SELECT schema_name, rel_name, round(score::numeric, 3) AS score, matched_on
           FROM rvbbit.fitting_candidates(${sqlLit(body.kit)}, ${sqlLit(body.target)}, 8)`,
          { readOnly: true, rowLimit: 20 },
        )
        return NextResponse.json({ ok: true, candidates: res.rows ?? [] })
      }
      case "tables": {
        const res = await executeQuery(
          cid,
          `SELECT n.nspname AS schema_name, c.relname AS rel_name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'v', 'm')
             AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'rvbbit', 'cron')
           ORDER BY 1, 2`,
          { readOnly: true, rowLimit: 2000 },
        )
        return NextResponse.json({ ok: true, tables: res.rows ?? [] })
      }
      case "draft": {
        if (!body.kit || !body.target || !body.schemaName || !body.relName) throw new Error("kit, target, schemaName, relName required")
        // Engine-side drafting first: clover_llm maps semantically (renames,
        // casts) with a deterministic fallback built in. Pre-0172 targets
        // lack fitting_draft — fall through to the local name-match below.
        try {
          const dres = await executeQuery(
            cid,
            `SELECT draft, drafted_by, note FROM rvbbit.fitting_draft(
               ${sqlLit(body.kit)}, ${sqlLit(body.target)},
               ${sqlLit(body.schemaName)}, ${sqlLit(body.relName)})`,
            { rowLimit: 1 },
          )
          const drow = dres.rows?.[0] as { draft?: string; drafted_by?: string; note?: string } | undefined
          if (drow?.draft) {
            return NextResponse.json({ ok: true, draft: drow.draft, draftedBy: drow.drafted_by, note: drow.note })
          }
        } catch {
          // fitting_draft absent on this target database — use the local draft
        }
        const res = await executeQuery(
          cid,
          `WITH tcols AS (
             SELECT c->>'name' AS name, coalesce(c->>'type', 'text') AS typ,
                    coalesce((c->>'required')::boolean, true) AS required,
                    ordinality
             FROM rvbbit.kit_targets kt,
                  jsonb_array_elements(kt.columns) WITH ORDINALITY AS e(c, ordinality)
             WHERE kt.kit = ${sqlLit(body.kit)} AND kt.target = ${sqlLit(body.target)}
           ), scols AS (
             SELECT a.attname::text AS name
             FROM pg_attribute a
             WHERE a.attrelid = ${sqlLit(`${body.schemaName}.${body.relName}`)}::regclass
               AND a.attnum > 0 AND NOT a.attisdropped
           )
           SELECT string_agg(
             CASE WHEN s.name IS NOT NULL THEN quote_ident(s.name) || ' AS ' || quote_ident(t.name)
                  WHEN NOT t.required THEN 'NULL::' || t.typ || ' AS ' || quote_ident(t.name)
                  ELSE '/* TODO map this */ NULL::' || t.typ || ' AS ' || quote_ident(t.name) END,
             E',\n       ' ORDER BY t.ordinality) AS cols
           FROM tcols t LEFT JOIN scols s ON s.name = t.name`,
          { readOnly: true, rowLimit: 1 },
        )
        const cols = (res.rows?.[0] as { cols?: string } | undefined)?.cols ?? "*"
        const draft = `SELECT ${cols}\nFROM ${body.schemaName}.${body.relName}`
        return NextResponse.json({ ok: true, draft, draftedBy: "name-match", note: "deterministic draft" })
      }
      case "check": {
        if (!body.kit || !body.target || !body.selectSql) throw new Error("kit, target, selectSql required")
        // Not readOnly: fitting_check creates a session-temp probe view.
        const checks = await executeQuery(
          cid,
          `SELECT check_name, ok, detail FROM rvbbit.fitting_check(${sqlLit(body.kit)}, ${sqlLit(body.target)}, ${sqlLit(body.selectSql)})`,
          { rowLimit: 100 },
        )
        let preview: unknown[] = []
        let previewColumns: unknown[] = []
        try {
          const p = await executeQuery(cid, `SELECT * FROM (${body.selectSql.replace(/;\s*$/, "")}) _fit_preview LIMIT 5`, {
            readOnly: true,
            rowLimit: 5,
          })
          preview = p.rows ?? []
          previewColumns = p.columns ?? []
        } catch {
          // checks already carry the error
        }
        return NextResponse.json({ ok: true, checks: checks.rows ?? [], preview, previewColumns })
      }
      case "apply": {
        if (!body.kit || !body.target || !body.selectSql) throw new Error("kit, target, selectSql required")
        const res = await executeQuery(
          cid,
          `SELECT check_name, ok, detail FROM rvbbit.fitting_apply(
             ${sqlLit(body.kit)}, ${sqlLit(body.target)}, ${sqlLit(body.selectSql)},
             ${sqlLit(JSON.stringify(body.proposal ?? {}))}::jsonb)`,
          { rowLimit: 100 },
        )
        return NextResponse.json({ ok: true, checks: res.rows ?? [] })
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown op ${body.op}` }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
