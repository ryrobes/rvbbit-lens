import sanitizeHtml from "sanitize-html"
import * as cheerio from "cheerio"
import { executeQuery } from "@/lib/db/query"
import type { QueryResultColumn } from "@/lib/db/types"

/**
 * Plates — server-side renderer for the second app species
 * (rvbbit-sql/docs/KIT_PLATES_PLAN.md). Surfaces ship as rows in
 * rvbbit.plates; this module loads a row, runs its declared read-only
 * queries, expands the two-hands template vocabulary (rv-each / rv-if /
 * {{ }} interpolation / islands / actions), and returns sanitized HTML
 * plus an island manifest the client hydrates with REAL lens components.
 *
 * Safety model: the template is sanitized BEFORE tokens are expanded, and
 * every interpolated value is entity-escaped before insertion, so data can
 * never introduce markup. A final sanitize pass is the belt. Logic lives in
 * SQL — there is no expression language here beyond single-field truthiness.
 */

const TEMPLATE_VERSION = 1
const EACH_ROW_CAP = 500

export interface PlateIsland {
  id: string
  kind: "grid" | "chart" | "metric"
  query: string
  props: Record<string, string>
  columns: QueryResultColumn[]
  rows: Array<Record<string, unknown>>
}

export interface PlateActionMeta {
  confirm: boolean
  description: string
  args: Array<{ name: string; type: string; required: boolean }>
}

export interface RenderedPlate {
  plateId: string
  title: string
  description: string | null
  kit: string | null
  html: string
  islands: PlateIsland[]
  actions: Record<string, PlateActionMeta>
}

interface PlateRow {
  plate_id: string
  kit: string | null
  title: string
  description: string | null
  template_version: number
  template: string
  queries: Record<string, { sql: string; cache_ttl_ms?: number }>
  actions: Record<
    string,
    { sql: string; args?: Array<{ name: string; type?: string; required?: boolean }>; confirm?: boolean; description?: string }
  >
  params: Array<{ name: string; type?: string; default?: unknown; from_bus?: boolean }>
}

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

function escapeHtml(v: unknown): string {
  if (v == null) return ""
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Substitute {{ params.x }} tokens in a query's SQL as escaped literals. */
function bindQueryParams(sql: string, params: Record<string, unknown>): string {
  return sql.replace(/\{\{\s*params\.([a-zA-Z_][\w]*)\s*\}\}/g, (_, name: string) => {
    const v = params[name]
    if (v == null) return "NULL"
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
    if (typeof v === "boolean") return v ? "true" : "false"
    return sqlLit(String(v))
  })
}

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "div", "section", "article", "header", "footer", "main", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "b", "i", "em", "strong",
    "small", "code", "pre", "blockquote", "hr", "br", "ul", "ol", "li",
    "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "caption", "form", "label", "input", "select", "option", "textarea",
    "button", "fieldset", "legend",
    // islands (replaced before serialization, but must survive sanitation)
    "rv-grid", "rv-chart", "rv-metric",
  ],
  allowedAttributes: {
    "*": [
      "class", "title", "colspan", "rowspan",
      // the vocabulary — everything else is stripped
      "rv-each", "rv-if", "rv-action", "rv-emit", "rv-value",
      "rv-open-sql", "rv-open-sql-title", "rv-confirm",
      "query", "spec", "value", "label", "x", "y", "mark", "unit",
    ],
    input: ["class", "title", "name", "value", "type", "placeholder", "required", "min", "max", "step", "checked"],
    select: ["class", "title", "name", "required"],
    option: ["value", "selected"],
    textarea: ["class", "title", "name", "placeholder", "required", "rows"],
    button: ["class", "title", "type", "rv-open-sql", "rv-open-sql-title", "rv-emit", "rv-value"],
    form: ["class", "rv-action"],
  },
  disallowedTagsMode: "discard",
  allowedSchemes: [], // no URLs anywhere in v1
}

async function loadPlate(connectionId: string, plateId: string): Promise<PlateRow | null> {
  const res = await executeQuery(
    connectionId,
    `SELECT plate_id, kit, title, description, template_version, template,
            queries, actions, params
     FROM rvbbit.plates WHERE plate_id = ${sqlLit(plateId)}`,
    { readOnly: true, rowLimit: 1 },
  )
  const row = res.rows?.[0] as unknown as PlateRow | undefined
  return row ?? null
}

function truthy(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  const s = String(v).trim().toLowerCase()
  return s !== "" && s !== "false" && s !== "f" && s !== "0" && s !== "no"
}

/** Expand one element's subtree for one row: {{ row.col }} tokens (escaped)
 *  and rv-if pruning. Operates on serialized HTML — safe because values are
 *  entity-escaped before insertion and the template was pre-sanitized. */
function expandRowTemplate(inner: string, row: Record<string, unknown>): string {
  return inner.replace(/\{\{\s*row\.([a-zA-Z_][\w]*)\s*\}\}/g, (_, col: string) =>
    escapeHtml(row[col]),
  )
}

export async function renderPlate(
  connectionId: string,
  plateId: string,
  callerParams: Record<string, unknown> = {},
): Promise<RenderedPlate> {
  const plate = await loadPlate(connectionId, plateId)
  if (!plate) throw new Error(`plate ${plateId} not found`)
  if (Number(plate.template_version) !== TEMPLATE_VERSION) {
    throw new Error(
      `plate ${plateId} has template_version ${plate.template_version}; this renderer speaks v${TEMPLATE_VERSION}`,
    )
  }

  // Declared params only; defaults from the row, overrides from the caller.
  const params: Record<string, unknown> = {}
  for (const p of plate.params ?? []) {
    params[p.name] = callerParams[p.name] ?? p.default ?? null
  }

  // Run every declared query (read-only, bound to declared params).
  const results = new Map<string, { columns: QueryResultColumn[]; rows: Array<Record<string, unknown>> }>()
  for (const [name, q] of Object.entries(plate.queries ?? {})) {
    const res = await executeQuery(connectionId, bindQueryParams(q.sql, params), {
      readOnly: true,
      rowLimit: EACH_ROW_CAP,
    })
    results.set(name, {
      columns: (res.columns ?? []) as QueryResultColumn[],
      rows: (res.rows ?? []) as Array<Record<string, unknown>>,
    })
  }

  // 1. Sanitize the raw template BEFORE any data enters it.
  const cleaned = sanitizeHtml(plate.template, SANITIZE_OPTS)
  const $ = cheerio.load(cleaned, {}, false)

  // 2. rv-each expansion (outermost first; islands not allowed inside).
  $("[rv-each]").each((_, el) => {
    const $el = $(el)
    const qname = String($el.attr("rv-each") ?? "")
    const result = results.get(qname)
    $el.removeAttr("rv-each")
    if (!result) {
      $el.replaceWith(`<div class="plate-error">unknown query “${escapeHtml(qname)}”</div>`)
      return
    }
    if ($el.find("rv-grid,rv-chart,rv-metric").length > 0) {
      $el.replaceWith(`<div class="plate-error">islands may not appear inside rv-each</div>`)
      return
    }
    const templateHtml = $.html($el)
    const rendered: string[] = []
    for (const row of result.rows.slice(0, EACH_ROW_CAP)) {
      const frag = cheerio.load(expandRowTemplate(templateHtml, row), {}, false)
      // rv-if pruning within this row's clone
      frag("[rv-if]").each((__, cond) => {
        const $c = frag(cond)
        const expr = String($c.attr("rv-if") ?? "").trim()
        $c.removeAttr("rv-if")
        const negate = expr.startsWith("!")
        const field = (negate ? expr.slice(1) : expr).replace(/^row\./, "").trim()
        const keep = negate ? !truthy(row[field]) : truthy(row[field])
        if (!keep) $c.remove()
      })
      rendered.push(frag.html() ?? "")
    }
    $el.replaceWith(rendered.join(""))
  })

  // 3. Any rv-if left outside rv-each has no row scope — drop it honestly.
  $("[rv-if]").each((_, el) => {
    $(el).replaceWith(`<div class="plate-error">rv-if is only valid inside rv-each</div>`)
  })

  // 4. Islands → placeholders + manifest (query results ride along).
  const islands: PlateIsland[] = []
  $("rv-grid,rv-chart,rv-metric").each((i, el) => {
    const $el = $(el)
    const tag = (el as unknown as { tagName: string }).tagName.toLowerCase()
    const kind = tag.replace("rv-", "") as PlateIsland["kind"]
    const qname = String($el.attr("query") ?? "")
    const result = results.get(qname)
    if (!result) {
      $el.replaceWith(`<div class="plate-error">island references unknown query “${escapeHtml(qname)}”</div>`)
      return
    }
    const id = `island-${i}`
    const props: Record<string, string> = {}
    for (const [k, v] of Object.entries($el.attr() ?? {})) {
      if (k !== "query") props[k] = String(v)
    }
    islands.push({ id, kind, query: qname, props, columns: result.columns, rows: result.rows })
    $el.replaceWith(`<div class="plate-island" data-rv-island="${id}"></div>`)
  })

  // 5. {{ params.x }} anywhere; then strip any leftover tokens.
  let html = $.html() ?? ""
  html = html.replace(/\{\{\s*params\.([a-zA-Z_][\w]*)\s*\}\}/g, (_, name: string) =>
    escapeHtml(params[name]),
  )
  html = html.replace(/\{\{[^}]*\}\}/g, "")

  // 6. Belt: sanitize the final document (values are escaped, so this is a
  //    no-op unless something went wrong — in which case it saves us).
  const baseAttrs = SANITIZE_OPTS.allowedAttributes as Record<string, sanitizeHtml.AllowedAttribute[]>
  html = sanitizeHtml(html, {
    ...SANITIZE_OPTS,
    allowedAttributes: {
      ...baseAttrs,
      div: ["class", "title", "data-rv-island"],
    },
  })

  const actions: Record<string, PlateActionMeta> = {}
  for (const [name, a] of Object.entries(plate.actions ?? {})) {
    actions[name] = {
      confirm: a.confirm === true,
      description: a.description ?? "",
      args: (a.args ?? []).map((g) => ({
        name: g.name,
        type: g.type ?? "text",
        required: g.required !== false,
      })),
    }
  }

  return {
    plateId: plate.plate_id,
    title: plate.title,
    description: plate.description,
    kit: plate.kit,
    html,
    islands,
    actions,
  }
}

/** Execute a named action with validated args. The GRANT wall is the real
 *  enforcement (the SQL runs as the connection's user); this validates shape
 *  and logs the invocation. */
export async function runPlateAction(
  connectionId: string,
  plateId: string,
  actionName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const plate = await loadPlate(connectionId, plateId)
  if (!plate) return { ok: false, error: `plate ${plateId} not found` }
  const action = (plate.actions ?? {})[actionName]
  if (!action) return { ok: false, error: `action ${actionName} is not declared on this plate` }

  const declared = new Map((action.args ?? []).map((a) => [a.name, a]))
  for (const key of Object.keys(args)) {
    if (!declared.has(key)) return { ok: false, error: `undeclared arg ${key}` }
  }
  let sql = action.sql
  for (const [name, def] of declared) {
    const v = args[name]
    if ((v == null || v === "") && def.required !== false) {
      return { ok: false, error: `missing required arg ${name}` }
    }
    const lit =
      v == null || v === ""
        ? "NULL"
        : def.type === "number"
          ? String(Number(v))
          : def.type === "boolean"
            ? (truthy(v) ? "true" : "false")
            : sqlLit(String(v))
    if (lit === "NaN") return { ok: false, error: `arg ${name} is not a number` }
    sql = sql.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"), lit)
  }
  if (/\{\{[^}]*\}\}/.test(sql)) return { ok: false, error: "action sql has unbound tokens" }

  try {
    await executeQuery(connectionId, sql, { rowLimit: 1 })
    await executeQuery(
      connectionId,
      `INSERT INTO rvbbit.plate_action_log (plate_id, action, args)
       VALUES (${sqlLit(plateId)}, ${sqlLit(actionName)}, ${sqlLit(JSON.stringify(args))}::jsonb)`,
      { rowLimit: 1 },
    ).catch(() => {})
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await executeQuery(
      connectionId,
      `INSERT INTO rvbbit.plate_action_log (plate_id, action, args, error)
       VALUES (${sqlLit(plateId)}, ${sqlLit(actionName)}, ${sqlLit(JSON.stringify(args))}::jsonb, ${sqlLit(msg)})`,
      { rowLimit: 1 },
    ).catch(() => {})
    return { ok: false, error: msg }
  }
}

/** List plates for the browser window. */
export async function listPlates(connectionId: string): Promise<
  Array<{ plate_id: string; kit: string | null; title: string; description: string | null }>
> {
  const res = await executeQuery(
    connectionId,
    `SELECT plate_id, kit, title, description FROM rvbbit.plates ORDER BY kit NULLS FIRST, plate_id`,
    { readOnly: true, rowLimit: 200 },
  )
  return (res.rows ?? []) as Array<{
    plate_id: string
    kit: string | null
    title: string
    description: string | null
  }>
}
