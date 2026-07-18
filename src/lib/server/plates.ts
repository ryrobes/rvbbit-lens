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
  requires_role?: string
  /** pg_has_role(current_user, requires_role) — affordance only; the GRANT
   *  wall is the real enforcement. Missing role counts as not allowed. */
  allowed: boolean
}

export interface RenderedPlate {
  plateId: string
  title: string
  description: string | null
  kit: string | null
  html: string
  islands: PlateIsland[]
  actions: Record<string, PlateActionMeta>
  /** Resolved param values — the client uses the KEYS to know which
   *  rv-emit fields this plate consumes itself (param loop-back). */
  params: Record<string, unknown>
  /** Params declared with from_bus: true — the window subscribes these to
   *  the desktop param bus, so ANY window emitting the field drives this
   *  plate (cross-plate / cross-window filtering). */
  busFields: string[]
}

interface PlateRow {
  plate_id: string
  kit: string | null
  module: string | null
  title: string
  description: string | null
  template_version: number
  template: string
  queries: Record<string, { sql: string; cache_ttl_ms?: number; database?: string }>
  actions: Record<
    string,
    {
      sql: string
      args?: Array<{ name: string; type?: string; required?: boolean }>
      confirm?: boolean
      description?: string
      requires_role?: string
    }
  >
  params: Array<{ name: string; type?: string; default?: unknown; from_bus?: boolean }>
}

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`
}

/** sanitize-html DROPS empty attribute values (value="" becomes nothing),
 *  and cheerio then emulates DOM defaults (a value-less radio reports "on").
 *  Empty values are real in our vocabulary ("All" options/radios emit '' to
 *  clear a param), so they ride through both sanitize passes as a marker
 *  that's restored to value="" at the very end. */
const BLANK = "__rv_blank__"

/** Raw attribute read — bypasses cheerio's form-value emulation. */
function rawAttr(el: unknown, name: string): string | undefined {
  const v = (el as { attribs?: Record<string, string> }).attribs?.[name]
  return v === BLANK ? "" : v
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
      "rv-open-sql", "rv-open-sql-title", "rv-open", "rv-open-title",
      "rv-confirm", "rv-live",
      "query", "spec", "value", "label", "x", "y", "mark", "unit",
    ],
    input: ["class", "title", "name", "value", "type", "placeholder", "required", "min", "max", "step", "checked", "rv-emit", "rv-value"],
    select: ["class", "title", "name", "required", "rv-emit", "query", "value", "label", "placeholder"],
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
    `SELECT plate_id, kit, module, title, description, template_version, template,
            queries, actions, params
     FROM rvbbit.plates WHERE plate_id = ${sqlLit(plateId)}`,
    { readOnly: true, rowLimit: 1 },
  )
  const row = res.rows?.[0] as unknown as PlateRow | undefined
  return row ?? null
}

/** Contract gate: a plate with a module renders only while every contract
 *  on (kit, module) is green. Enforced HERE — the shelf UI is a courtesy;
 *  the render refusal is the wall. Broken contracts fail closed. */
async function moduleGate(
  connectionId: string,
  kit: string | null,
  module: string | null,
): Promise<{ open: boolean; violations: number; detail: string }> {
  if (!kit || !module) return { open: true, violations: 0, detail: "" }
  const res = await executeQuery(
    connectionId,
    `SELECT count(*) FILTER (WHERE NOT ok)::int AS red,
            coalesce(sum(violations) FILTER (WHERE NOT ok), 0)::int AS violations,
            coalesce(min(sample) FILTER (WHERE NOT ok), '') AS detail
     FROM rvbbit.kit_contract_status(${sqlLit(kit)}) s
     WHERE s.module = ${sqlLit(module)}`,
    { readOnly: true, rowLimit: 1 },
  )
  const row = res.rows?.[0] ?? {}
  const red = Number(row.red ?? 0)
  return {
    open: red === 0,
    violations: Number(row.violations ?? 0),
    detail: String(row.detail ?? ""),
  }
}

/** Affordance check for requires_role actions. A role that does not exist
 *  reads as NOT allowed (pg_has_role errors on unknown roles). */
async function roleAllowed(connectionId: string, role: string): Promise<boolean> {
  try {
    const res = await executeQuery(
      connectionId,
      `SELECT pg_has_role(current_user, ${sqlLit(role)}, 'member') AS ok`,
      { readOnly: true, rowLimit: 1 },
    )
    return Boolean((res.rows?.[0] as { ok?: boolean } | undefined)?.ok)
  } catch {
    return false
  }
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
  const gate = await moduleGate(connectionId, plate.kit, plate.module)
  if (!gate.open) {
    throw new Error(
      `module “${plate.module}” is gated: ${gate.violations} contract violation(s)` +
        (gate.detail ? ` — ${gate.detail}` : "") +
        `. Open the kit's switchboard to resolve them.`,
    )
  }
  if (Number(plate.template_version) !== TEMPLATE_VERSION) {
    throw new Error(
      `plate ${plateId} has template_version ${plate.template_version}; this renderer speaks v${TEMPLATE_VERSION}`,
    )
  }

  // Declared params only; defaults from the row, overrides from the caller.
  // A declared type coerces the incoming value (emits arrive as strings from
  // rv-value attributes) so SQL like OFFSET {{ params.page }} * 15 is sound.
  const params: Record<string, unknown> = {}
  for (const p of plate.params ?? []) {
    let v = callerParams[p.name] ?? p.default ?? null
    if (v != null && p.type === "number") {
      const n = Number(v)
      v = Number.isFinite(n) ? n : (typeof p.default === "number" ? p.default : null)
    }
    if (v != null && p.type === "boolean") v = truthy(v)
    params[p.name] = v
  }

  // Run every declared query (read-only, bound to declared params). A
  // failing query degrades to an inline error where it is CONSUMED — one
  // broken probe must never take down the whole surface.
  const results = new Map<
    string,
    { columns: QueryResultColumn[]; rows: Array<Record<string, unknown>>; error?: string }
  >()
  for (const [name, q] of Object.entries(plate.queries ?? {})) {
    try {
      const res = await executeQuery(connectionId, bindQueryParams(q.sql, params), {
        readOnly: true,
        rowLimit: EACH_ROW_CAP,
        database: q.database,
      })
      results.set(name, {
        columns: (res.columns ?? []) as QueryResultColumn[],
        rows: (res.rows ?? []) as Array<Record<string, unknown>>,
      })
    } catch (e) {
      results.set(name, {
        columns: [],
        rows: [],
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 1. Sanitize the raw template BEFORE any data enters it (empty value=""
  //    attrs become the BLANK marker first so they survive sanitation).
  const cleaned = sanitizeHtml(
    plate.template
      .replace(/value\s*=\s*""/g, `value="${BLANK}"`)
      // bare boolean-ish vocabulary attrs would be dropped as empty — give
      // them a value so authors can write plain `rv-live`.
      .replace(/\brv-live(?!\s*=)/g, 'rv-live="live"'),
    SANITIZE_OPTS,
  )
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
    if (result.error) {
      $el.replaceWith(
        `<div class="plate-error">query “${escapeHtml(qname)}” failed: ${escapeHtml(result.error)}</div>`,
      )
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

  // 2b. Param controls: any <select rv-emit> is server-controlled. With a
  // `query` attribute its options come from that query's rows (value/label
  // name the columns; `placeholder` adds a leading empty option); with
  // authored options they are used as-is. Either way the option matching
  // the CURRENT param value is marked selected — selection state comes
  // from SQL-resolved params, never from client state.
  $("select[rv-emit]").each((_, el) => {
    const $el = $(el)
    const field = String($el.attr("rv-emit") ?? "")
    const current = params[field] == null ? "" : String(params[field])
    const qname = $el.attr("query")
    if (qname != null) {
      const result = results.get(String(qname))
      if (!result || result.error) {
        $el.replaceWith(
          `<div class="plate-error">select query “${escapeHtml(qname)}” ${result?.error ? `failed: ${escapeHtml(result.error)}` : "is unknown"}</div>`,
        )
        return
      }
      const valueCol = String($el.attr("value") ?? result.columns[0]?.name ?? "")
      const labelCol = String($el.attr("label") ?? valueCol)
      const opts: string[] = []
      const placeholder = $el.attr("placeholder")
      if (placeholder != null) {
        opts.push(`<option value="${BLANK}"${current === "" ? " selected" : ""}>${escapeHtml(placeholder)}</option>`)
      }
      for (const row of result.rows.slice(0, EACH_ROW_CAP)) {
        const v = row[valueCol] == null ? "" : String(row[valueCol])
        const l = row[labelCol] == null ? v : String(row[labelCol])
        opts.push(`<option value="${v === "" ? BLANK : escapeHtml(v)}"${v === current ? " selected" : ""}>${escapeHtml(l)}</option>`)
      }
      $el.removeAttr("query").removeAttr("value").removeAttr("label").removeAttr("placeholder")
      $el.html(opts.join(""))
    } else {
      $el.find("option").each((__, opt) => {
        const $o = $(opt)
        const v = rawAttr(opt, "value") ?? $o.text()
        if (String(v) === current) $o.attr("selected", "selected")
        else $o.removeAttr("selected")
      })
    }
  })

  // Radios with rv-emit: the one whose value matches the param is checked.
  // Radios sharing a field are auto-grouped by name — without it the
  // browser never unchecks siblings and you get two dots lit until the
  // refetch swap catches up.
  $('input[type="radio"][rv-emit]').each((_, el) => {
    const $el = $(el)
    const field = String($el.attr("rv-emit") ?? "")
    if (!$el.attr("name")) $el.attr("name", `rv-radio-${field}`)
    const current = params[field] == null ? "" : String(params[field])
    if (String(rawAttr(el, "value") ?? "") === current) $el.attr("checked", "checked")
    else $el.removeAttr("checked")
  })

  // Checkboxes with rv-emit: checked when the param holds their rv-value
  // (or anything truthy when no rv-value is declared) — same principle as
  // selected options: control state comes from resolved params.
  $('input[type="checkbox"][rv-emit]').each((_, el) => {
    const $el = $(el)
    const field = String($el.attr("rv-emit") ?? "")
    const current = params[field] == null ? "" : String(params[field])
    const want = $el.attr("rv-value")
    const on = want != null ? current === String(want) : current !== ""
    if (on) $el.attr("checked", "checked")
    else $el.removeAttr("checked")
  })

  // 3. rv-if outside rv-each: query-qualified single-field truthiness —
  // `rv-if="tabs.show_browse"` keeps the element while column show_browse of
  // query tabs' FIRST row is truthy. Still no expression language: the SQL
  // computes the boolean because the SQL received the params (this is how
  // tabs work — a tab is a param, its sections are query-driven rv-ifs).
  // Bare row.* here has no row scope — dropped honestly.
  $("[rv-if]").each((_, el) => {
    const $el = $(el)
    const expr = String($el.attr("rv-if") ?? "").trim()
    const negate = expr.startsWith("!")
    const path = (negate ? expr.slice(1) : expr).trim()
    const dot = path.indexOf(".")
    const qname = dot > 0 ? path.slice(0, dot) : ""
    if (qname === "row" || dot <= 0) {
      $el.replaceWith(`<div class="plate-error">rv-if “${escapeHtml(expr)}” needs a row scope (inside rv-each) or a query.column path</div>`)
      return
    }
    const result = results.get(qname)
    if (!result || result.error) {
      $el.replaceWith(
        `<div class="plate-error">rv-if query “${escapeHtml(qname)}” ${result?.error ? `failed: ${escapeHtml(result.error)}` : "is unknown"}</div>`,
      )
      return
    }
    const v = result.rows[0]?.[path.slice(dot + 1)]
    const keep = negate ? !truthy(v) : truthy(v)
    $el.removeAttr("rv-if")
    if (!keep) $el.remove()
  })

  // 4. Islands → placeholders + manifest (query results ride along).
  const islands: PlateIsland[] = []
  $("rv-grid,rv-chart,rv-metric").each((i, el) => {
    const $el = $(el)
    const tag = (el as unknown as { tagName: string }).tagName.toLowerCase()
    const kind = tag.replace("rv-", "") as PlateIsland["kind"]
    const qname = String($el.attr("query") ?? "")
    const result = results.get(qname)
    if (!result || result.error) {
      $el.replaceWith(
        `<div class="plate-error">island query “${escapeHtml(qname)}” ${result?.error ? `failed: ${escapeHtml(result.error)}` : "is unknown"}</div>`,
      )
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

  // Restore blank markers to real empty values now that sanitation is done.
  html = html.split(BLANK).join("")

  const actions: Record<string, PlateActionMeta> = {}
  for (const [name, a] of Object.entries(plate.actions ?? {})) {
    const requiresRole = a.requires_role?.trim() || undefined
    actions[name] = {
      confirm: a.confirm === true,
      description: a.description ?? "",
      args: (a.args ?? []).map((g) => ({
        name: g.name,
        type: g.type ?? "text",
        required: g.required !== false,
      })),
      requires_role: requiresRole,
      allowed: requiresRole ? await roleAllowed(connectionId, requiresRole) : true,
    }
  }

  // Affordance gating: forms for actions the viewer's role can't run are
  // replaced with a quiet note. The GRANT wall (SQL runs as the connection
  // user) remains the real enforcement either way.
  const forbidden = Object.entries(actions).filter(([, m]) => !m.allowed)
  if (forbidden.length > 0) {
    const $$ = cheerio.load(html, {}, false)
    for (const [name, meta] of forbidden) {
      $$(`form[rv-action="${name}"]`).replaceWith(
        `<p class="plate-row-flag">action “${escapeHtml(name)}” requires role ${escapeHtml(meta.requires_role ?? "")}</p>`,
      )
    }
    html = $$.html() ?? html
  }

  return {
    plateId: plate.plate_id,
    title: plate.title,
    description: plate.description,
    kit: plate.kit,
    html,
    islands,
    actions,
    params,
    busFields: (plate.params ?? []).filter((p) => p.from_bus === true).map((p) => p.name),
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
  const requiresRole = action.requires_role?.trim()
  if (requiresRole && !(await roleAllowed(connectionId, requiresRole))) {
    return { ok: false, error: `action ${actionName} requires role ${requiresRole}` }
  }

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

export interface PlateInstallInput {
  plate_id: string
  title?: string
  template: string
  queries?: Record<string, { sql: string; database?: string }>
  actions?: Record<string, unknown>
  params?: Array<Record<string, unknown>>
  kit?: string | null
  description?: string
}

/** Install a plate via rvbbit.upsert_plate — the engine's tripwires (script/
 *  handler rejection, SELECT-shaped queries) are the validator; errors come
 *  back verbatim so an agent can read the reason and iterate. */
export async function installPlate(
  connectionId: string,
  plate: PlateInstallInput,
): Promise<{ ok: boolean; plateId?: string; error?: string }> {
  if (!plate?.plate_id || !plate?.template) {
    return { ok: false, error: "plate_id and template are required" }
  }
  try {
    const sql = `SELECT rvbbit.upsert_plate(
      ${sqlLit(plate.plate_id)},
      ${sqlLit(plate.title ?? plate.plate_id)},
      ${sqlLit(plate.template)},
      ${sqlLit(JSON.stringify(plate.queries ?? {}))}::jsonb,
      ${sqlLit(JSON.stringify(plate.actions ?? {}))}::jsonb,
      ${sqlLit(JSON.stringify(plate.params ?? []))}::jsonb,
      ${plate.kit == null ? "NULL" : sqlLit(plate.kit)},
      ${plate.description == null ? "NULL" : sqlLit(plate.description)}
    ) AS plate_id`
    const res = await executeQuery(connectionId, sql, { rowLimit: 1 })
    const row = res.rows?.[0] as { plate_id?: string } | undefined
    return { ok: true, plateId: row?.plate_id ?? plate.plate_id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface PlateListEntry {
  plate_id: string
  kit: string | null
  module: string | null
  title: string
  description: string | null
  gated: boolean
  violations: number
  gate_detail: string
}

export interface KitMeta {
  kit: string
  version: string | null
  title: string | null
  description: string | null
}

/** Kit registry metadata for shelf grouping. Tolerates targets that predate
 *  the rvbbit.kits table (pre-0162) by degrading to an empty map. */
export async function listKits(connectionId: string): Promise<Record<string, KitMeta>> {
  try {
    const res = await executeQuery(
      connectionId,
      `SELECT kit, version, title, description FROM rvbbit.kits`,
      { readOnly: true, rowLimit: 200 },
    )
    const out: Record<string, KitMeta> = {}
    for (const r of (res.rows ?? []) as unknown as KitMeta[]) out[r.kit] = r
    return out
  } catch {
    return {}
  }
}

export interface AvailableKit {
  catalog_id: string
  name: string
  title: string | null
  description: string | null
  version: string | null
}

/** Catalog kits (kind='kit') not currently installed — the shelf's
 *  "available" section. Uninstalled = present in the catalog, absent from
 *  rvbbit.kits (uninstall returns a kit to available). */
export async function listAvailableKits(
  connectionId: string,
  installed: Record<string, unknown>,
): Promise<AvailableKit[]> {
  try {
    const res = await executeQuery(
      connectionId,
      `SELECT id AS catalog_id, name, title, description, manifest->>'version' AS version
       FROM rvbbit.capability_catalog WHERE kind = 'kit' AND active ORDER BY name`,
      { readOnly: true, rowLimit: 200 },
    )
    return ((res.rows ?? []) as unknown as AvailableKit[]).filter((k) => !(k.name in installed))
  } catch {
    return []
  }
}

/** List plates with their module-gate state for the shelf. */
export async function listPlates(connectionId: string): Promise<PlateListEntry[]> {
  const res = await executeQuery(
    connectionId,
    `SELECT plate_id, kit, module, title, description
     FROM rvbbit.plates ORDER BY kit NULLS FIRST, module NULLS FIRST, plate_id`,
    { readOnly: true, rowLimit: 200 },
  )
  const rows = (res.rows ?? []) as Array<Omit<PlateListEntry, "gated" | "violations" | "gate_detail">>
  const gates = new Map<string, { open: boolean; violations: number; detail: string }>()
  const out: PlateListEntry[] = []
  for (const r of rows) {
    let gate = { open: true, violations: 0, detail: "" }
    if (r.kit && r.module) {
      const key = `${r.kit} ${r.module}`
      const hit = gates.get(key)
      if (hit) gate = hit
      else {
        gate = await moduleGate(connectionId, r.kit, r.module)
        gates.set(key, gate)
      }
    }
    out.push({ ...r, gated: !gate.open, violations: gate.violations, gate_detail: gate.detail })
  }
  return out
}
