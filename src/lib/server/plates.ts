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
  kind: "grid" | "chart" | "metric" | "board" | "shot" | "frame"
  query: string
  props: Record<string, string>
  columns: QueryResultColumn[]
  rows: Array<Record<string, unknown>>
}

// ── Artifact islands (the Hub, docs/HUB_PLAN.md) ─────────────────────────
// rv-shot (thumbnail img) and rv-frame (live iframe) take HANDLES — a kind
// + slug — never URLs. The server resolves the src here: thumbnails go
// through the lens proxy (/api/rvbbit/thumb), live frames point at the
// warehouse-mcp origin that already serves /apps/<slug> and /d/<slug>.
// Scoping by construction: plate content cannot name an arbitrary origin.
const ARTIFACT_SLUG = /^[a-z0-9][a-z0-9_-]{0,127}$/i
const ARTIFACT_FRAME_KINDS = new Set(["app", "dashboard"])
/** Browser-reachable base for live app/dashboard iframes. */
export function artifactFrameBase(): string {
  return (process.env.RVBBIT_APP_BASE ?? process.env.WAREHOUSE_PUBLIC_URL ?? "").replace(/\/+$/, "")
}
/** Server-side base the thumb proxy fetches from (compose-internal DNS). */
export function artifactInternalBase(): string {
  return (process.env.RVBBIT_APP_BASE_INTERNAL ?? "").replace(/\/+$/, "") || artifactFrameBase()
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
  /** Extra kits whose data events also refresh this plate (foundation-kit
   *  overlays: an hvac plate listening to scheduling's actions). */
  listens: string[]
  /** Render instrumentation — the plate window's strip shows totalMs and
   *  the source menu shows per-query ms · rows. Make the invisible visible. */
  debug: {
    totalMs: number
    queries: Array<{ name: string; ms: number; rows: number; error?: string }>
  }
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
  requires_role?: string | null
  listens?: string[] | null
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

// Inline-style allowlist: visual properties only. Missing from this set BY
// DESIGN: position/inset/z-index (escape the plate box), transform family,
// pointer-events, cursor, content, visibility, will-change, backdrop-filter
// (containing-block trap), transition/animation (no keyframes anyway).
const STYLE_PROPS = new Set([
  "color", "background", "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "background-clip",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-width", "border-style", "border-color", "border-radius",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "border-collapse", "border-spacing", "outline", "outline-offset",
  "box-shadow", "text-shadow", "opacity", "filter", "mix-blend-mode",
  "font", "font-size", "font-weight", "font-style", "font-family", "font-variant-numeric",
  "letter-spacing", "line-height", "text-align", "text-transform",
  "text-decoration", "text-overflow", "text-wrap", "white-space", "word-break", "vertical-align",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "aspect-ratio", "object-fit", "overflow", "overflow-x", "overflow-y",
  "display", "gap", "row-gap", "column-gap",
  "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
  "align-items", "align-content", "align-self",
  "justify-content", "justify-items", "justify-self",
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-column", "grid-row", "grid-area", "grid-auto-flow", "grid-auto-rows", "grid-auto-columns",
  "place-items", "place-content", "place-self", "columns", "column-count",
])
// Value-level deny: no network fetches, no legacy script vectors. Applied
// after interpolation, so DATA that tries to smuggle url() dies here too.
const STYLE_VALUE_DENY = /url\s*\(|expression\s*\(|javascript:|@import|-moz-binding/i

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "div", "section", "article", "header", "footer", "main", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "b", "i", "em", "strong",
    "small", "code", "pre", "blockquote", "hr", "br", "ul", "ol", "li",
    "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "caption", "form", "label", "input", "select", "option", "textarea",
    "button", "fieldset", "legend",
    // islands (replaced before serialization, but must survive sanitation)
    "rv-grid", "rv-chart", "rv-metric", "rv-board", "rv-shot", "rv-frame",
  ],
  allowedAttributes: {
    "*": [
      // style passes the sanitizer intact (template tokens may live inside
      // it) — the FINAL render pass enforces STYLE_PROPS/STYLE_VALUE_DENY
      // on real, post-interpolation values.
      "class", "style", "title", "colspan", "rowspan",
      // the vocabulary — everything else is stripped
      "rv-each", "rv-group", "rv-if", "rv-action", "rv-emit", "rv-value",
      "rv-open-sql", "rv-open-sql-title", "rv-open", "rv-open-title",
      "rv-open-dbl", "rv-confirm", "rv-live",
      "query", "spec", "value", "label", "x", "y", "mark", "unit",
    ],
    input: ["class", "title", "name", "value", "type", "placeholder", "required", "min", "max", "step", "checked", "rv-emit", "rv-value"],
    select: ["class", "title", "name", "required", "rv-emit", "query", "value", "label", "placeholder"],
    option: ["value", "selected"],
    textarea: ["class", "title", "name", "placeholder", "required", "rows"],
    // name: a submit button may carry an action arg per row (the native
    // per-row-action idiom); the client passes the submitter to FormData
    // so the clicked button's name/value pair rides along.
    button: ["class", "title", "type", "name", "value", "rv-open-sql", "rv-open-sql-title", "rv-emit", "rv-value"],
    form: ["class", "rv-action"],
    // board island: columns from rows; a drop fires the named action {id, to}
    "rv-board": ["query", "group-by", "group-label", "id", "title", "value", "note", "tone", "action"],
    // chart island: quick attrs (series/stack/axis formats/height) plus a
    // full Vega-Lite fragment via spec — the island force-injects data,
    // width, autosize, and theme, so spec is mark+encoding vocabulary only.
    "rv-chart": ["query", "spec", "x", "y", "mark", "color", "stack", "x-format", "y-format", "height", "rv-emit"],
    // grid island: spreadsheet editing rides the action wall — a cell
    // commit fires edit-action with {id, column, value}; the action's SQL
    // (CASE per column) decides what actually persists. sql-from renders a
    // grid over SQL held in another query's first row (read-only, capped).
    "rv-grid": ["query", "edit-action", "edit", "id", "sql-from", "limit"],
    // artifact islands (the Hub): handles only — kind + slug, never URLs.
    // shot = thumbnail via the lens proxy; frame = live iframe of the
    // warehouse-served app/dashboard. Src is resolved server-side.
    "rv-shot": ["kind", "slug", "title"],
    "rv-frame": ["kind", "slug", "title", "height"],
  },
  disallowedTagsMode: "discard",
  allowedSchemes: [], // no URLs anywhere in v1
  // Never postcss-parse style attrs: template tokens ({{ row.x }}) live
  // inside them pre-expansion and break the parser, which silently drops
  // the attribute. The final render pass (STYLE_PROPS/STYLE_VALUE_DENY)
  // is the sole style enforcer, and it sees real values.
  parseStyleAttributes: false,
}

// ── Plate source (view SQL / history) ───────────────────────────────────
// Everything the strip's source menu shows: the full upsert_plate statement
// (built, not run — the bench→seed round trip), each named query, and the
// revision ledger (0182). SQL is generated HERE so dollar-quoting is done
// once, correctly.

export interface PlateSourceInfo {
  plateId: string
  title: string
  kit: string | null
  upsertSql: string
  queries: Array<{ name: string; sql: string }>
  revisions: Array<{ rev: number; reason: string; captured_at: string; title: string }>
}

function dollarQuote(text: string): string {
  let tag = "plate"
  let n = 0
  while (text.includes(`$${tag}$`)) tag = `plate${++n}`
  return `$${tag}$${text}$${tag}$`
}

export async function loadPlateSource(
  connectionId: string,
  plateId: string,
): Promise<PlateSourceInfo | null> {
  const res = await executeQuery(
    connectionId,
    `SELECT to_jsonb(p) AS plate FROM rvbbit.plates p WHERE plate_id = ${sqlLit(plateId)}`,
    { readOnly: true, rowLimit: 1 },
  )
  const raw = res.rows?.[0]?.plate
  const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined
  if (!row) return null

  const queriesObj = (row.queries ?? {}) as Record<string, { sql?: string }>
  const jsonArg = (v: unknown, empty: string) => {
    const s = JSON.stringify(v ?? JSON.parse(empty), null, 2)
    return `${dollarQuote(s)}::jsonb`
  }
  const textArg = (v: unknown) => (v == null || v === "" ? "NULL" : dollarQuote(String(v)))
  const lines = [
    `SELECT rvbbit.upsert_plate(`,
    `  ${sqlLit(plateId)},`,
    `  ${dollarQuote(String(row.title ?? plateId))},`,
    `  ${dollarQuote(String(row.template ?? ""))},`,
    `  ${jsonArg(row.queries, "{}")},`,
    `  ${jsonArg(row.actions, "{}")},`,
    `  ${jsonArg(row.params, "[]")},`,
    `  ${textArg(row.kit)},`,
    `  ${textArg(row.description)},`,
    `  ${Number(row.template_version) || 1}`,
    `);`,
  ]
  // module / listens / requires_role live outside the upsert signature;
  // emit the companion UPDATE so the statement round-trips the whole row.
  const extras: string[] = []
  if (row.module != null) extras.push(`module = ${sqlLit(String(row.module))}`)
  if (row.requires_role != null) extras.push(`requires_role = ${sqlLit(String(row.requires_role))}`)
  if (row.listens != null) extras.push(`listens = ${dollarQuote(JSON.stringify(row.listens))}::jsonb`)
  if (extras.length > 0) {
    lines.push(``, `UPDATE rvbbit.plates SET ${extras.join(", ")} WHERE plate_id = ${sqlLit(plateId)};`)
  }

  let revisions: PlateSourceInfo["revisions"] = []
  try {
    const rev = await executeQuery(
      connectionId,
      `SELECT rev, reason, captured_at::text AS captured_at, snapshot->>'title' AS title
       FROM rvbbit.plate_revisions WHERE plate_id = ${sqlLit(plateId)}
       ORDER BY rev DESC LIMIT 12`,
      { readOnly: true, rowLimit: 12 },
    )
    revisions = (rev.rows ?? []) as unknown as PlateSourceInfo["revisions"]
  } catch {
    // pre-0182 server — the menu just shows no history
  }

  return {
    plateId,
    title: String(row.title ?? plateId),
    kit: row.kit == null ? null : String(row.kit),
    upsertSql: lines.join("\n"),
    queries: Object.entries(queriesObj).map(([name, q]) => ({ name, sql: q?.sql ?? "" })),
    revisions,
  }
}

async function loadPlate(connectionId: string, plateId: string): Promise<PlateRow | null> {
  const res = await executeQuery(
    connectionId,
    `SELECT plate_id, kit, module, title, description, template_version, template,
            queries, actions, params,
            to_jsonb(p)->>'requires_role' AS requires_role,
            to_jsonb(p)->'listens' AS listens
     FROM rvbbit.plates p WHERE plate_id = ${sqlLit(plateId)}`,
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
  const renderStart = Date.now()
  const plate = await loadPlate(connectionId, plateId)
  if (!plate) throw new Error(`plate ${plateId} not found`)
  if (plate.requires_role && !(await roleAllowed(connectionId, plate.requires_role))) {
    throw new Error(`plate ${plateId} requires role ${plate.requires_role}`)
  }
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
  const queryTimings: RenderedPlate["debug"]["queries"] = []
  for (const [name, q] of Object.entries(plate.queries ?? {})) {
    const qStart = Date.now()
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
      queryTimings.push({ name, ms: Date.now() - qStart, rows: res.rows?.length ?? 0 })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      results.set(name, { columns: [], rows: [], error })
      queryTimings.push({ name, ms: Date.now() - qStart, rows: 0, error })
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

  // 2-pre. rv-group expansion: rv-group="query:column" repeats the element
  // once per distinct value of column (first-appearance order — the SQL's
  // ORDER BY is the layout order). Inside the clone, {{ group.key }} and
  // {{ group.count }} interpolate, and rv-each="group" iterates that
  // group's rows via a synthetic per-group result. Composes with
  // plate-columns / plate-cal so boards get their columns from ROWS —
  // never from names hardcoded into the template.
  let groupSeq = 0
  $("[rv-group]").each((_, el) => {
    const $el = $(el)
    const spec = String($el.attr("rv-group") ?? "")
    $el.removeAttr("rv-group")
    const [gq, gcol] = spec.split(":").map((s) => s.trim())
    if (!gq || !gcol) {
      $el.replaceWith(`<div class="plate-error">rv-group needs “query:column”</div>`)
      return
    }
    const result = results.get(gq)
    if (!result) {
      $el.replaceWith(`<div class="plate-error">unknown query “${escapeHtml(gq)}”</div>`)
      return
    }
    if (result.error) {
      $el.replaceWith(
        `<div class="plate-error">query “${escapeHtml(gq)}” failed: ${escapeHtml(result.error)}</div>`,
      )
      return
    }
    if ($el.find("[rv-group]").length > 0) {
      $el.replaceWith(`<div class="plate-error">rv-group may not nest</div>`)
      return
    }
    if ($el.find("rv-grid,rv-chart,rv-metric,rv-board").length > 0) {
      $el.replaceWith(`<div class="plate-error">islands may not appear inside rv-group</div>`)
      return
    }
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const row of result.rows.slice(0, EACH_ROW_CAP)) {
      const key = row[gcol] == null ? "" : String(row[gcol])
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
    const templateHtml = $.html($el)
    const rendered: string[] = []
    for (const [key, rows] of groups) {
      const syntheticName = `__group_${groupSeq++}`
      results.set(syntheticName, { columns: result.columns, rows })
      const frag = cheerio.load(templateHtml, {}, false)
      frag('[rv-each="group"]').attr("rv-each", syntheticName)
      const html = (frag.html() ?? "")
        .replace(/\{\{\s*group\.key\s*\}\}/g, escapeHtml(key))
        .replace(/\{\{\s*group\.count\s*\}\}/g, String(rows.length))
      rendered.push(html)
    }
    $el.replaceWith(rendered.join(""))
  })

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
    if ($el.find("rv-grid,rv-chart,rv-metric,rv-board").length > 0) {
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
  // Form selects (no rv-emit) may ALSO be query-driven: selection comes
  // from a truthy `selected` COLUMN — never from an interpolated selected
  // attribute (sanitize-html turns selected="" into a BARE selected, which
  // the browser treats as on; boolean attrs cannot be templated).
  $("select[rv-emit], select[query]").each((_, el) => {
    const $el = $(el)
    const field = $el.attr("rv-emit")
    const current = field == null || params[field] == null ? "" : String(params[field])
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
        const on = field != null ? v === current : truthy(row.selected)
        opts.push(`<option value="${v === "" ? BLANK : escapeHtml(v)}"${on ? " selected" : ""}>${escapeHtml(l)}</option>`)
      }
      $el.removeAttr("query").removeAttr("value").removeAttr("label").removeAttr("placeholder")
      $el.html(opts.join(""))
    } else if (field != null) {
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

  // 3b. sql-from grids: <rv-grid sql-from="query.column" limit="50"> renders
  // a grid over SQL that CAME FROM SQL — the named query's first row holds
  // the statement (how the Hub peek shows a cube's rows when the table name
  // is only known per-selection). Same wall as everything else: SELECT-shaped
  // only, read-only execution, hard row cap. Timed into debug like any query.
  const sqlFromData = new Map<string, { columns: QueryResultColumn[]; rows: Array<Record<string, unknown>> } | { error: string }>()
  {
    const els = $("rv-grid[sql-from]").toArray()
    for (let i = 0; i < els.length; i++) {
      const $el = $(els[i])
      $el.attr("data-rv-sqlfrom", String(i))
      const ref = String($el.attr("sql-from") ?? "")
      const dot = ref.indexOf(".")
      const qname = dot > 0 ? ref.slice(0, dot) : ref
      const col = dot > 0 ? ref.slice(dot + 1) : ""
      const src = results.get(qname)
      const sql = String(src?.rows?.[0]?.[col] ?? "").trim()
      if (!src || src.error || !sql) {
        sqlFromData.set(String(i), { error: src?.error ? `source query “${qname}” failed` : "" })
        continue
      }
      if (!/^\s*(select|with)\b/i.test(sql)) {
        sqlFromData.set(String(i), { error: "sql-from statements must be SELECT-shaped" })
        continue
      }
      const limitAttr = Number($el.attr("limit"))
      const rowLimit = Number.isFinite(limitAttr) && limitAttr > 0 ? Math.min(limitAttr, 200) : 50
      const t0 = Date.now()
      try {
        const r = await executeQuery(connectionId, sql, { readOnly: true, rowLimit })
        queryTimings.push({ name: `grid:${ref}`, ms: Date.now() - t0, rows: r.rows?.length ?? 0 })
        sqlFromData.set(String(i), {
          columns: (r.columns ?? []) as QueryResultColumn[],
          rows: (r.rows ?? []) as Array<Record<string, unknown>>,
        })
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        queryTimings.push({ name: `grid:${ref}`, ms: Date.now() - t0, rows: 0, error })
        sqlFromData.set(String(i), { error })
      }
    }
  }

  // 4. Islands → placeholders + manifest (query results ride along).
  const islands: PlateIsland[] = []
  $("rv-grid,rv-chart,rv-metric,rv-board,rv-shot,rv-frame").each((i, el) => {
    const $el = $(el)
    const tag = (el as unknown as { tagName: string }).tagName.toLowerCase()
    const kind = tag.replace("rv-", "") as PlateIsland["kind"]

    // Artifact islands are QUERYLESS: a validated handle becomes a
    // server-resolved src. Bad handles render an inline error, not a hole.
    if (kind === "shot" || kind === "frame") {
      const akind = String($el.attr("kind") ?? "app").toLowerCase()
      const slug = String($el.attr("slug") ?? "")
      if (!ARTIFACT_FRAME_KINDS.has(akind) || !ARTIFACT_SLUG.test(slug)) {
        $el.replaceWith(`<div class="plate-error">rv-${kind}: bad artifact handle</div>`)
        return
      }
      const props: Record<string, string> = {}
      for (const [k, v] of Object.entries($el.attr() ?? {})) props[k] = String(v)
      if (kind === "frame") {
        const base = artifactFrameBase()
        if (!base) {
          $el.replaceWith(`<div class="plate-error">rv-frame: RVBBIT_APP_BASE is not configured</div>`)
          return
        }
        props.src = `${base}${akind === "dashboard" ? "/d/" : "/apps/"}${slug}`
      } else {
        props.src = `/api/rvbbit/thumb?kind=${encodeURIComponent(akind)}&slug=${encodeURIComponent(slug)}`
      }
      const id = `island-${i}`
      islands.push({ id, kind, query: "", props, columns: [], rows: [] })
      $el.replaceWith(`<div class="plate-island" data-rv-island="${id}"></div>`)
      return
    }

    // sql-from grids resolved in the 3b pre-pass.
    const sqlFromIdx = $el.attr("data-rv-sqlfrom")
    if (kind === "grid" && sqlFromIdx != null) {
      const data = sqlFromData.get(sqlFromIdx)
      if (!data || "error" in data) {
        const msg = data?.error ?? ""
        $el.replaceWith(msg ? `<div class="plate-error">grid: ${escapeHtml(msg)}</div>` : "")
        return
      }
      const id = `island-${i}`
      const props: Record<string, string> = {}
      for (const [k, v] of Object.entries($el.attr() ?? {})) {
        if (k !== "data-rv-sqlfrom") props[k] = String(v)
      }
      islands.push({ id, kind, query: "", props, columns: data.columns, rows: data.rows })
      $el.replaceWith(`<div class="plate-island" data-rv-island="${id}"></div>`)
      return
    }

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
      div: ["class", "style", "title", "data-rv-island"],
    },
  })

  // Restore blank markers to real empty values now that sanitation is done.
  html = html.split(BLANK).join("")

  // Class scrub: the app's own compiled Tailwind utilities are GLOBAL, so
  // without this a plate could borrow fixed/z-50/inset-0 from the lens
  // stylesheet and overlay desktop chrome. The scoped plate palette
  // (plate-utilities.css) is what SHOULD work; this strips what must not,
  // including arbitrary-value classes (inline styles in a class costume).
  {
    const DANGEROUS =
      /^(?:!|-)|^(?:fixed|absolute|sticky|relative|static)$|^-?(?:inset|top|right|bottom|left|z|translate|scale|rotate|skew|origin)-|^(?:w|h|min-w|min-h|max-w|max-h)-(?:screen|dvh|svh|lvh|dvw)|^pointer-events-|^(?:visible|invisible|collapse)$|[[\]]/
    const $$ = cheerio.load(html, {}, false)
    $$("[class]").each((_, el) => {
      const cls = String($$(el).attr("class") ?? "")
      const kept = cls.split(/\s+/).filter((t) => t && !DANGEROUS.test(t))
      if (kept.length !== cls.split(/\s+/).filter(Boolean).length) {
        $$(el).attr("class", kept.join(" "))
      }
    })
    // Style scrub: inline style is ALLOWED, property-allowlisted. The
    // guardrail was never "no styles" — it's containment: nothing may
    // escape the plate box (position/z/transform/pointer-events) and
    // nothing may phone home (url()). Everything visual — arbitrary
    // colors, gradients, exact grid templates, shadows, typography,
    // data-driven widths from SQL — is decoration and passes. Runs on
    // the FINAL document, so interpolated values are inspected as real
    // values, not template tokens.
    $$("[style]").each((_, el) => {
      const raw = String($$(el).attr("style") ?? "")
      const kept = raw
        .split(";")
        .map((decl) => {
          const idx = decl.indexOf(":")
          if (idx < 1) return null
          const prop = decl.slice(0, idx).trim().toLowerCase()
          const value = decl.slice(idx + 1).trim()
          if (!prop || !value) return null
          if (!STYLE_PROPS.has(prop)) return null
          if (STYLE_VALUE_DENY.test(value)) return null
          return `${prop}: ${value}`
        })
        .filter(Boolean)
      if (kept.length > 0) $$(el).attr("style", kept.join("; "))
      else $$(el).removeAttr("style")
    })
    html = $$.html() ?? html
  }

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
    listens: Array.isArray(plate.listens) ? plate.listens : [],
    debug: { totalMs: Date.now() - renderStart, queries: queryTimings },
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
  if (plate.requires_role && !(await roleAllowed(connectionId, plate.requires_role))) {
    return { ok: false, error: `plate ${plateId} requires role ${plate.requires_role}` }
  }
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

export interface PlatePatchInput {
  plate_id: string
  title?: string
  description?: string
  kit?: string | null
  template?: string
  /** Merged per key onto the existing queries; a null value REMOVES a key. */
  queries?: Record<string, { sql: string; database?: string } | null>
  /** Merged per key onto the existing actions; a null value REMOVES a key. */
  actions?: Record<string, unknown | null>
  /** Whole-array replacement when present (params are small; no merge). */
  params?: Array<Record<string, unknown>>
}

/** Partially update an EXISTING plate. This is how large plates get built —
 *  a working skeleton via upsert_plate, then queries/actions added in later
 *  commands or turns — and how routine edits stay small (one query changes,
 *  one query rides the wire). The merged row goes back through
 *  rvbbit.upsert_plate, so every install-time tripwire still applies, and
 *  the 0182 revision trigger ledgers each patch. */
export async function patchPlate(
  connectionId: string,
  patch: PlatePatchInput,
): Promise<{ ok: boolean; plateId?: string; kit?: string | null; error?: string; detail?: string }> {
  if (!patch?.plate_id) return { ok: false, error: "plate_id is required" }
  const current = await loadPlate(connectionId, patch.plate_id)
  if (!current) {
    return { ok: false, error: `plate ${patch.plate_id} not found — use upsert_plate to create it` }
  }
  const queries: Record<string, unknown> = { ...(current.queries ?? {}) }
  let addedQ = 0
  let removedQ = 0
  for (const [k, v] of Object.entries(patch.queries ?? {})) {
    if (v === null) {
      if (k in queries) removedQ++
      delete queries[k]
    } else {
      addedQ++
      queries[k] = v
    }
  }
  const actions: Record<string, unknown> = { ...(current.actions ?? {}) }
  let addedA = 0
  let removedA = 0
  for (const [k, v] of Object.entries(patch.actions ?? {})) {
    if (v === null) {
      if (k in actions) removedA++
      delete actions[k]
    } else {
      addedA++
      actions[k] = v
    }
  }
  const kit = patch.kit !== undefined ? patch.kit : current.kit
  const result = await installPlate(connectionId, {
    plate_id: patch.plate_id,
    title: patch.title ?? current.title,
    template: patch.template ?? current.template,
    queries: queries as PlateInstallInput["queries"],
    actions,
    params: patch.params ?? (current.params as Array<Record<string, unknown>>) ?? [],
    kit,
    description: patch.description ?? current.description ?? undefined,
  })
  if (!result.ok) return result
  const bits = [
    patch.template != null ? "template" : null,
    addedQ ? `${addedQ} quer${addedQ === 1 ? "y" : "ies"}` : null,
    removedQ ? `${removedQ} removed` : null,
    addedA ? `${addedA} action${addedA === 1 ? "" : "s"}` : null,
    removedA ? `${removedA} action${removedA === 1 ? "" : "s"} removed` : null,
    patch.params ? "params" : null,
    patch.title != null ? "title" : null,
  ].filter(Boolean)
  return { ok: true, plateId: patch.plate_id, kit, detail: `patched: ${bits.join(", ") || "no-op"}` }
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
  requires_role: string | null
  /** Viewer lacks requires_role — shelf shows a lock, render refuses. */
  locked: boolean
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
  /** Preflight verdict, evaluated UPFRONT: a kit whose capability isn't
   *  installed yet shows what it's blocked on instead of a setup button —
   *  the mental model is install-the-capability, then set up its kit. */
  ready: boolean
  blockers: string[]
}

/** Catalog kits (kind='kit') not currently set up — the shelf's shipped-kits
 *  section. Present in the catalog, absent from rvbbit.kits (removing a kit
 *  returns it here). */
export async function listAvailableKits(
  connectionId: string,
  installed: Record<string, unknown>,
): Promise<AvailableKit[]> {
  try {
    const res = await executeQuery(
      connectionId,
      `SELECT id AS catalog_id, name, title, description,
              manifest->>'version' AS version,
              coalesce(manifest->'requires', '{}'::jsonb) AS requires
       FROM rvbbit.capability_catalog WHERE kind = 'kit' AND active ORDER BY name`,
      { readOnly: true, rowLimit: 200 },
    )
    const rows = ((res.rows ?? []) as unknown as Array<AvailableKit & { requires: unknown }>).filter(
      (k) => !(k.name in installed),
    )
    const out: AvailableKit[] = []
    for (const k of rows) {
      let ready = true
      let blockers: string[] = []
      try {
        const pf = await executeQuery(
          connectionId,
          `SELECT requirement, detail FROM rvbbit.kit_preflight(${sqlLit(JSON.stringify(k.requires ?? {}))}::jsonb) WHERE NOT ok`,
          { readOnly: true, rowLimit: 20 },
        )
        const fails = (pf.rows ?? []) as Array<{ requirement: string; detail: string }>
        ready = fails.length === 0
        blockers = fails.map((f) => f.requirement)
      } catch {
        // pre-0168 target: no preflight — leave ready, click-time errors apply
      }
      out.push({
        catalog_id: k.catalog_id,
        name: k.name,
        title: k.title,
        description: k.description,
        version: k.version,
        ready,
        blockers,
      })
    }
    return out
  } catch {
    return []
  }
}

/** List plates with their module-gate state for the shelf. */
export async function listPlates(connectionId: string): Promise<PlateListEntry[]> {
  const res = await executeQuery(
    connectionId,
    `SELECT plate_id, kit, module, title, description,
            to_jsonb(p)->>'requires_role' AS requires_role
     FROM rvbbit.plates p ORDER BY kit NULLS FIRST, module NULLS FIRST, plate_id`,
    { readOnly: true, rowLimit: 200 },
  )
  const rows = (res.rows ?? []) as Array<Omit<PlateListEntry, "gated" | "violations" | "gate_detail" | "locked">>
  const gates = new Map<string, { open: boolean; violations: number; detail: string }>()
  const roles = new Map<string, boolean>()
  const out: PlateListEntry[] = []
  for (const r of rows) {
    let gate = { open: true, violations: 0, detail: "" }
    if (r.kit && r.module) {
      const key = `${r.kit} ${r.module}`
      const hit = gates.get(key)
      if (hit) gate = hit
      else {
        gate = await moduleGate(connectionId, r.kit, r.module)
        gates.set(key, gate)
      }
    }
    let locked = false
    if (r.requires_role) {
      const cached = roles.get(r.requires_role)
      const allowed = cached ?? (await roleAllowed(connectionId, r.requires_role))
      roles.set(r.requires_role, allowed)
      locked = !allowed
    }
    out.push({ ...r, gated: !gate.open, violations: gate.violations, gate_detail: gate.detail, locked })
  }
  return out
}
