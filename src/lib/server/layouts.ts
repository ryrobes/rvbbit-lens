import { executeQuery } from "@/lib/db/query"

/**
 * Layouts — the plate compose layer (rvbbit-sql/docs/PLATE_COMPOSE_PLAN.md).
 * A layout is a kit-shipped composition of plates on a free-floating canvas:
 * pane rects as fractions of a declared design size, plus z-order. The row
 * owns arrangement, never behavior — validation of that doctrine lives in
 * rvbbit.upsert_layout (0187); this module is transport.
 */

function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export interface LayoutPane {
  id: string
  plate?: string
  x: number
  y: number
  w: number
  h: number
  z?: number
  params?: Record<string, unknown>
  slot?: boolean
  title?: string
}

export interface LayoutRow {
  layout_id: string
  kit: string | null
  title: string
  description: string | null
  requires_role: string | null
  design: { width: number; height: number; min_width?: number }
  panes: LayoutPane[]
}

export async function listLayouts(connectionId: string): Promise<LayoutRow[]> {
  try {
    const res = await executeQuery(
      connectionId,
      `SELECT layout_id, kit, title, description, requires_role, design, panes
       FROM rvbbit.plate_layouts ORDER BY kit NULLS LAST, layout_id`,
      { readOnly: true, rowLimit: 500 },
    )
    return (res.rows ?? []) as unknown as LayoutRow[]
  } catch {
    return [] // pre-0187 server
  }
}

export async function loadLayout(connectionId: string, layoutId: string): Promise<LayoutRow | null> {
  const res = await executeQuery(
    connectionId,
    `SELECT layout_id, kit, title, description, requires_role, design, panes
     FROM rvbbit.plate_layouts WHERE layout_id = ${sqlLit(layoutId)}`,
    { readOnly: true, rowLimit: 1 },
  )
  const row = res.rows?.[0] as unknown as LayoutRow | undefined
  return row ?? null
}

export interface LayoutInstallInput {
  layout_id: string
  title?: string
  design?: { width: number; height: number; min_width?: number }
  panes?: LayoutPane[]
  kit?: string | null
  description?: string
  /** Also point the kit's front door (kits.default_layout) at this layout. */
  default?: boolean
}

/** Install via rvbbit.upsert_layout — the engine's validation (fractions,
 *  unique pane ids, the no-behavior-keys wall) is the validator; errors
 *  come back verbatim so an agent can read the reason and iterate. */
export async function installLayout(
  connectionId: string,
  layout: LayoutInstallInput,
): Promise<{ ok: boolean; layoutId?: string; error?: string }> {
  if (!layout?.layout_id) return { ok: false, error: "layout_id is required" }
  try {
    const sql = `SELECT rvbbit.upsert_layout(
      ${sqlLit(layout.layout_id)},
      ${sqlLit(layout.title ?? layout.layout_id)},
      ${sqlLit(JSON.stringify(layout.design ?? { width: 1600, height: 900 }))}::jsonb,
      ${sqlLit(JSON.stringify(layout.panes ?? []))}::jsonb,
      ${layout.kit == null ? "NULL" : sqlLit(layout.kit)},
      ${layout.description == null ? "NULL" : sqlLit(layout.description)}
    ) AS layout_id`
    const res = await executeQuery(connectionId, sql, { rowLimit: 1 })
    const row = res.rows?.[0] as { layout_id?: string } | undefined
    if (layout.default && layout.kit) {
      await executeQuery(
        connectionId,
        `UPDATE rvbbit.kits SET default_layout = ${sqlLit(layout.layout_id)} WHERE kit = ${sqlLit(layout.kit)}`,
        { rowLimit: 1 },
      )
    }
    return { ok: true, layoutId: row?.layout_id ?? layout.layout_id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface LayoutPatchInput {
  layout_id: string
  title?: string
  description?: string
  kit?: string | null
  design?: { width: number; height: number; min_width?: number }
  /** Merged per pane id onto the existing panes; null removes a pane. */
  panes?: Record<string, Partial<LayoutPane> | null>
}

/** Partial update, mirroring patch_plate's shape: fields replace when
 *  present; panes merge PER ID (null removes). Goes back through
 *  upsert_layout so the doctrine validation always applies, and the 0187
 *  revision trigger ledgers each patch. */
export async function patchLayout(
  connectionId: string,
  patch: LayoutPatchInput,
): Promise<{ ok: boolean; layoutId?: string; kit?: string | null; error?: string; detail?: string }> {
  if (!patch?.layout_id) return { ok: false, error: "layout_id is required" }
  const current = await loadLayout(connectionId, patch.layout_id)
  if (!current) {
    return { ok: false, error: `layout ${patch.layout_id} not found — use upsert_layout to create it` }
  }
  const byId = new Map(current.panes.map((p) => [p.id, p]))
  let touched = 0
  let removed = 0
  for (const [id, p] of Object.entries(patch.panes ?? {})) {
    if (p === null) {
      if (byId.delete(id)) removed++
    } else {
      touched++
      byId.set(id, { ...(byId.get(id) ?? { x: 0, y: 0, w: 0.3, h: 0.3 }), ...p, id } as LayoutPane)
    }
  }
  const kit = patch.kit !== undefined ? patch.kit : current.kit
  const result = await installLayout(connectionId, {
    layout_id: patch.layout_id,
    title: patch.title ?? current.title,
    design: patch.design ?? current.design,
    panes: [...byId.values()],
    kit,
    description: patch.description ?? current.description ?? undefined,
  })
  if (!result.ok) return result
  const bits = [
    touched ? `${touched} pane${touched === 1 ? "" : "s"}` : null,
    removed ? `${removed} removed` : null,
    patch.design ? "design" : null,
    patch.title != null ? "title" : null,
  ].filter(Boolean)
  return { ok: true, layoutId: patch.layout_id, kit, detail: `patched: ${bits.join(", ") || "no-op"}` }
}
