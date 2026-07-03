import { randomUUID } from "@/lib/uuid"
import type { QueryResult, SchemaSnapshot, StatementResult } from "@/lib/db/types"

export const HTML_BLOCK_SCHEMA_VERSION = "rvbbit.html_block.v1"

export type HtmlBlockQueryRole = "primary" | "detail" | "control" | "support"

export interface HtmlBlockQuery {
  id: string
  title?: string
  sql: string
  role?: HtmlBlockQueryRole
  description?: string
  filterable?: string[]
}

export interface HtmlBlockBinding {
  sourceQueryId: string
  field: string
  targetQueryId?: string
  targetField?: string
  operator?: "eq" | "in" | "gte" | "lte"
}

export interface HtmlBlockMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: string
  receiptId?: string | null
  agentRunId?: string | null
}

export interface HtmlBlockRevision {
  id: string
  createdAt: string
  source: "agent" | "local" | "import"
  summary?: string
  receiptId?: string | null
  agentRunId?: string | null
}

export interface HtmlBlockSpec {
  schemaVersion: typeof HTML_BLOCK_SCHEMA_VERSION
  title: string
  html: string
  queries: HtmlBlockQuery[]
  bindings?: HtmlBlockBinding[]
  messages?: HtmlBlockMessage[]
  revisions?: HtmlBlockRevision[]
}

export interface HtmlBlockQueryResult {
  query: HtmlBlockQuery
  index: number
  result: StatementResult | QueryResult | null
}

export interface HtmlBlockTurnResult {
  spec: HtmlBlockSpec
  source: "agent" | "local"
  summary?: string
  receiptId?: string | null
  agentRunId?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : undefined
}

function safeId(input: string, fallback: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return slug || fallback
}

function normalizeQuery(value: unknown, idx: number): HtmlBlockQuery | null {
  if (!isRecord(value)) return null
  const sql = str(value.sql)?.trim()
  if (!sql) return null
  const rawId = str(value.id) ?? str(value.name) ?? str(value.title) ?? `query_${idx + 1}`
  const role = str(value.role)
  return {
    id: safeId(rawId, `query_${idx + 1}`),
    title: str(value.title) ?? str(value.name),
    sql,
    role: role === "detail" || role === "control" || role === "support" ? role : idx === 0 ? "primary" : "detail",
    description: str(value.description),
    filterable: strArray(value.filterable),
  }
}

function normalizeBinding(value: unknown): HtmlBlockBinding | null {
  if (!isRecord(value)) return null
  const sourceQueryId = str(value.sourceQueryId) ?? str(value.source_query_id) ?? str(value.source)
  const field = str(value.field) ?? str(value.sourceField) ?? str(value.source_field)
  if (!sourceQueryId || !field) return null
  const op = str(value.operator)
  return {
    sourceQueryId: safeId(sourceQueryId, sourceQueryId),
    field,
    targetQueryId: str(value.targetQueryId) ?? str(value.target_query_id) ?? str(value.target),
    targetField: str(value.targetField) ?? str(value.target_field),
    operator: op === "in" || op === "gte" || op === "lte" ? op : "eq",
  }
}

function normalizeMessages(value: unknown): HtmlBlockMessage[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((m): HtmlBlockMessage | null => {
      if (!isRecord(m)) return null
      const role = str(m.role)
      const content = str(m.content)
      if (!content || (role !== "user" && role !== "assistant" && role !== "system")) return null
      return {
        id: str(m.id) ?? randomUUID(),
        role,
        content,
        createdAt: str(m.createdAt) ?? str(m.created_at) ?? new Date().toISOString(),
        receiptId: str(m.receiptId) ?? str(m.receipt_id) ?? null,
        agentRunId: str(m.agentRunId) ?? str(m.agent_run_id) ?? null,
      }
    })
    .filter((m): m is HtmlBlockMessage => !!m)
}

function normalizeRevisions(value: unknown): HtmlBlockRevision[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((r): HtmlBlockRevision | null => {
      if (!isRecord(r)) return null
      const source = str(r.source)
      return {
        id: str(r.id) ?? randomUUID(),
        createdAt: str(r.createdAt) ?? str(r.created_at) ?? new Date().toISOString(),
        source: source === "agent" || source === "import" ? source : "local",
        summary: str(r.summary),
        receiptId: str(r.receiptId) ?? str(r.receipt_id) ?? null,
        agentRunId: str(r.agentRunId) ?? str(r.agent_run_id) ?? null,
      }
    })
    .filter((r): r is HtmlBlockRevision => !!r)
}

export function normalizeHtmlBlockSpec(input: unknown): HtmlBlockSpec | null {
  const raw = isRecord(input) && isRecord(input.artifact) ? input.artifact : input
  if (!isRecord(raw)) return null
  const html = str(raw.html) ?? str(raw.document) ?? str(raw.srcdoc)
  const queries = Array.isArray(raw.queries)
    ? raw.queries.map(normalizeQuery).filter((q): q is HtmlBlockQuery => !!q)
    : []
  if (!html || queries.length === 0) return null
  const title = str(raw.title) ?? str(raw.name) ?? "HTML Block"
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings.map(normalizeBinding).filter((b): b is HtmlBlockBinding => !!b)
    : undefined
  return {
    schemaVersion: HTML_BLOCK_SCHEMA_VERSION,
    title,
    html,
    queries,
    bindings,
    messages: normalizeMessages(raw.messages),
    revisions: normalizeRevisions(raw.revisions),
  }
}

export function extractHtmlBlockTurnResult(value: unknown): Omit<HtmlBlockTurnResult, "source"> | null {
  const raw = isRecord(value) && isRecord(value.result) ? value.result : value
  if (!isRecord(raw)) return null
  const spec = normalizeHtmlBlockSpec(raw.artifact ?? raw.spec ?? raw)
  if (!spec) return null
  return {
    spec,
    summary: str(raw.summary) ?? str(raw.notes),
    receiptId: str(raw.receiptId) ?? str(raw.receipt_id) ?? null,
    agentRunId: str(raw.agentRunId) ?? str(raw.agent_run_id) ?? null,
  }
}

export function buildHtmlBlockSql(spec: HtmlBlockSpec | null | undefined): string {
  const queries = spec?.queries?.filter((q) => q.sql.trim()) ?? []
  if (queries.length === 0) return "SELECT 1 AS value;"
  return queries
    .map((q) => {
      const title = q.title ? ` title=${JSON.stringify(q.title)}` : ""
      return `-- rvbbit:html-block-query id=${q.id}${title}\n${q.sql.trim().replace(/;+\s*$/g, "")}`
    })
    .join("\n;\n\n") + ";"
}

export function htmlBlockQueryResults(
  spec: HtmlBlockSpec | null | undefined,
  result: QueryResult | null,
): HtmlBlockQueryResult[] {
  const queries = spec?.queries ?? []
  return queries.map((query, index) => ({
    query,
    index,
    result: result?.results?.[index] ?? (queries.length === 1 ? result : null),
  }))
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, "\"\"")}"`
}

function defaultQueryFromSchema(schema: SchemaSnapshot | null): HtmlBlockQuery {
  const table = schema?.tables?.find((t) => t.kind === "table" || t.kind === "view") ?? schema?.tables?.[0]
  if (!table) {
    return {
      id: "sample",
      title: "Sample",
      role: "primary",
      sql: "SELECT 1 AS value, now() AS generated_at",
    }
  }
  const cols = table.columns.slice(0, 8).map((c) => quoteIdent(c.name)).join(", ") || "*"
  return {
    id: safeId(table.name, "main"),
    title: table.name,
    role: "primary",
    filterable: table.columns.slice(0, 6).map((c) => c.name),
    sql: `SELECT ${cols}\nFROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}\nLIMIT 500`,
  }
}

function appTitleFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim()
  if (!cleaned) return "HTML Block"
  const first = cleaned.split(/[.!?]/)[0]?.trim() || cleaned
  return first.length > 42 ? `${first.slice(0, 39).trim()}...` : first
}

function starterHtml(title: string, queryId: string): string {
  const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<main class="app">
  <section class="top">
    <div>
      <p class="eyebrow">Live data</p>
      <h1>${safeTitle}</h1>
    </div>
    <button id="refresh" type="button">Refresh</button>
  </section>
  <section id="metrics" class="metrics"></section>
  <section class="panel">
    <div class="panel-head">
      <h2>Records</h2>
      <span id="count"></span>
    </div>
    <div class="table-wrap"><table id="rows"></table></div>
  </section>
</main>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #101114; color: #f3f0ea; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .app { min-height: 100vh; padding: 22px; background: radial-gradient(circle at top left, rgba(65, 150, 170, .18), transparent 34%), #101114; }
  .top { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  .eyebrow { margin: 0 0 6px; color: #8fb7b1; text-transform: uppercase; letter-spacing: .08em; font-size: 11px; }
  h1 { margin: 0; font-size: clamp(24px, 4vw, 44px); line-height: 1.02; letter-spacing: 0; max-width: 840px; }
  h2 { margin: 0; font-size: 14px; letter-spacing: 0; }
  button { border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.08); color: #f3f0ea; border-radius: 6px; padding: 8px 11px; cursor: pointer; }
  button:hover { background: rgba(255,255,255,.13); }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .metric { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); border-radius: 8px; padding: 12px; }
  .metric .label { color: #a8a29a; font-size: 11px; text-transform: uppercase; }
  .metric .value { margin-top: 4px; font-size: 24px; font-weight: 650; }
  .panel { border: 1px solid rgba(255,255,255,.12); background: rgba(17,18,22,.78); border-radius: 8px; overflow: hidden; }
  .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.1); color: #d8d2c8; }
  .table-wrap { overflow: auto; max-height: 62vh; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.08); text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #17191e; color: #a8d3cb; font-weight: 600; }
</style>
<script>
  const queryId = ${JSON.stringify(queryId)};
  const fmt = new Intl.NumberFormat(undefined, { notation: "compact" });
  function valueText(value) {
    if (value == null) return "";
    if (typeof value === "number") return Number.isFinite(value) ? fmt.format(value) : "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
  async function load() {
    const data = await rvbbitQuery(queryId);
    const rows = data.rows || [];
    const columns = (data.columns || Object.keys(rows[0] || {}).map(name => ({ name }))).slice(0, 10);
    document.getElementById("count").textContent = rows.length + " rows";
    document.getElementById("metrics").innerHTML = [
      ["Rows", fmt.format(rows.length)],
      ["Fields", fmt.format(columns.length)],
      ["Query", queryId]
    ].map(([label, value]) => '<div class="metric"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>').join("");
    const head = '<thead><tr>' + columns.map(c => '<th>' + c.name + '</th>').join("") + '</tr></thead>';
    const body = '<tbody>' + rows.slice(0, 250).map(row => '<tr>' + columns.map(c => '<td>' + valueText(row[c.name]) + '</td>').join("") + '</tr>').join("") + '</tbody>';
    document.getElementById("rows").innerHTML = head + body;
  }
  document.getElementById("refresh").addEventListener("click", load);
  load().catch(err => { document.body.insertAdjacentHTML("beforeend", '<pre style="color:#ff8a8a;padding:16px">' + err.message + '</pre>'); });
</script>`
}

export function fallbackHtmlBlockTurn(args: {
  prompt: string
  current?: HtmlBlockSpec | null
  schema: SchemaSnapshot | null
  draftSql?: string
}): HtmlBlockTurnResult {
  const title = args.current?.title || appTitleFromPrompt(args.prompt)
  const existingQueries = args.current?.queries?.filter((q) => q.sql.trim()) ?? []
  const query =
    existingQueries[0] ??
    (args.draftSql?.trim() && args.draftSql.trim().toUpperCase() !== "SELECT 1;"
      ? { id: "main", title: "Main", role: "primary" as const, sql: args.draftSql.trim() }
      : defaultQueryFromSchema(args.schema))
  const spec: HtmlBlockSpec = {
    schemaVersion: HTML_BLOCK_SCHEMA_VERSION,
    title,
    html: args.current?.html ?? starterHtml(title, query.id),
    queries: existingQueries.length ? existingQueries : [query],
    bindings: args.current?.bindings,
  }
  return {
    spec,
    source: "local",
    summary: "Local starter revision. Install rvbbit.html_block_turn for agent-authored revisions.",
  }
}

export function appendHtmlBlockTurn(args: {
  current: HtmlBlockSpec | null
  turn: HtmlBlockTurnResult
  userMessage: string
}): HtmlBlockSpec {
  const now = new Date().toISOString()
  const base = args.current ?? args.turn.spec
  const user: HtmlBlockMessage = {
    id: randomUUID(),
    role: "user",
    content: args.userMessage,
    createdAt: now,
  }
  const assistant: HtmlBlockMessage = {
    id: randomUUID(),
    role: "assistant",
    content: args.turn.summary || (args.turn.source === "agent" ? "Updated HTML Block." : "Created local HTML Block starter."),
    createdAt: now,
    receiptId: args.turn.receiptId ?? null,
    agentRunId: args.turn.agentRunId ?? null,
  }
  const revision: HtmlBlockRevision = {
    id: randomUUID(),
    createdAt: now,
    source: args.turn.source,
    summary: assistant.content,
    receiptId: args.turn.receiptId ?? null,
    agentRunId: args.turn.agentRunId ?? null,
  }
  return {
    ...base,
    ...args.turn.spec,
    messages: [...(base.messages ?? []), user, assistant],
    revisions: [...(base.revisions ?? []), revision],
  }
}
