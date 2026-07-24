import { executeQuery } from "@/lib/db/query"

/**
 * Decks — the narrative artifact (rvbbit-sql/docs/DECKS_PLAN.md). A deck is
 * a JSON spec rendered by the versioned deck-runtime bundle (vendored
 * bolt-slides) and published into rvbbit.dashboards with app_kind='deck',
 * exactly like a live app: same versions, same /apps/<slug> serving when
 * warehouse-mcp is around, same dashboard-app window in the lens.
 *
 * THE DESKTOP PINS THE DATA. Slides carry data.sql; this module RUNS each
 * query (read-only, capped) at publish time and embeds the rows into the
 * spec. The assistant never types numbers — if the SQL fails, the slide
 * publishes without rows and the failure lands in the apply report.
 */

const DECK_RUNTIME_BASE = "https://rvbbit.ai/dist/deck-runtime/0.1.1"
const PIN_ROW_CAP = 200

function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export interface DeckSlide {
  component: string
  props?: Record<string, unknown>
  notes?: string
  nav?: string
  data?: {
    sql?: string
    bind: string
    shape?: "rows" | "points" | "cell"
    column?: string
    mode?: "pinned" | "live"
    rows?: Array<Record<string, unknown>>
  }
}

export interface DeckSpec {
  deck: {
    title?: string
    theme?: Record<string, string>
    slides: DeckSlide[]
  }
}

export interface DeckPublishResult {
  ok: boolean
  slug?: string
  version?: number
  pinned?: number
  pin_errors?: string[]
  error?: string
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return base || "deck"
}

export function buildDeckHtml(spec: DeckSpec): string {
  const title = spec.deck.title ?? "Deck"
  const compact = JSON.stringify(spec)
  return (
    `<!doctype html><html><head><meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${title.replace(/</g, "&lt;")}</title>\n` +
    `<link rel="stylesheet" href="${DECK_RUNTIME_BASE}/deck-runtime.css">\n` +
    `</head><body>\n<div id="deck-root"></div>\n` +
    `<script type="application/json" id="deck-spec">${compact.replace(/</g, "\\u003c")}</script>\n` +
    `<script src="${DECK_RUNTIME_BASE}/deck-runtime.js"></script>\n` +
    `<script>RvbbitDeck.render(document.getElementById('deck-root'), JSON.parse(document.getElementById('deck-spec').textContent));</script>\n` +
    `</body></html>`
  )
}

/** Run every slide's data.sql and embed the rows (pinning). Mutates a copy. */
async function pinSpec(
  connectionId: string,
  spec: DeckSpec,
): Promise<{ spec: DeckSpec; pinned: number; errors: string[] }> {
  const out: DeckSpec = JSON.parse(JSON.stringify(spec))
  const errors: string[] = []
  let pinned = 0
  for (const [i, slide] of (out.deck.slides ?? []).entries()) {
    const d = slide.data
    if (!d?.sql) continue
    try {
      const res = await executeQuery(connectionId, d.sql, {
        readOnly: true,
        rowLimit: PIN_ROW_CAP,
      })
      d.rows = (res.rows ?? []) as Array<Record<string, unknown>>
      pinned += 1
    } catch (e) {
      errors.push(`slide ${i + 1} (${slide.component}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { spec: out, pinned, errors }
}

export async function publishDeck(
  connectionId: string,
  input: { name: string; description?: string; spec: DeckSpec },
): Promise<DeckPublishResult> {
  const slides = input.spec?.deck?.slides
  if (!input.name?.trim()) return { ok: false, error: "name required" }
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, error: "spec.deck.slides must be a non-empty array" }
  }

  const { spec, pinned, errors } = await pinSpec(connectionId, input.spec)
  const html = buildDeckHtml(spec)
  const slug = slugify(input.name)
  const manifest = {
    schema_version: "live_app.v0",
    runtime_kind: "html",
    app_kind: "deck",
    description: input.description ?? null,
    deck: spec,
    deck_runtime: DECK_RUNTIME_BASE,
  }

  // Upsert registry row + append a version — the same rows warehouse-mcp
  // writes (its _DASHBOARDS_DDL / extension migration 0200 own the schema).
  const res = await executeQuery(
    connectionId,
    `WITH up AS (
       INSERT INTO rvbbit.dashboards (slug, name, description, status, latest_version, runtime_kind, app_kind, manifest)
       VALUES (${sqlLit(slug)}, ${sqlLit(input.name)}, ${input.description ? sqlLit(input.description) : "NULL"},
               'live', 1, 'html', 'deck', ${sqlLit(JSON.stringify(manifest))}::jsonb)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = COALESCE(EXCLUDED.description, rvbbit.dashboards.description),
         latest_version = rvbbit.dashboards.latest_version + 1,
         app_kind = 'deck',
         manifest = EXCLUDED.manifest,
         updated_at = now()
       RETURNING id, latest_version
     )
     INSERT INTO rvbbit.dashboard_versions (dashboard_id, version, html, kind, created_by, notes, manifest)
     SELECT id, latest_version, ${sqlLit(html)}, 'live', 'lens-assistant',
            ${sqlLit(`deck · ${slides.length} slides · ${pinned} pinned`)},
            ${sqlLit(JSON.stringify({ deck: spec }))}::jsonb
     FROM up
     RETURNING version`,
    { readOnly: false, rowLimit: 1 },
  )
  const version = Number((res.rows?.[0] as { version?: unknown } | undefined)?.version ?? 1)
  return { ok: true, slug, version, pinned, pin_errors: errors.length ? errors : undefined }
}
