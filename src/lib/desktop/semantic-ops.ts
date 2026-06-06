"use client"

import { Activity, Flag, Tag, type LucideIcon } from "@/lib/icons"
import type { DesktopColumnRef, RollupOp, SemanticOpMeta, SemanticOpShape } from "./types"
import { isDateRef, isNumericRef } from "./sql-builder"

/**
 * Client-side catalog of semantic operators (rvbbit.operators) for the
 * drag-drop UI. Loaded once per connection and cached (the FULL catalog, all
 * shapes), so the drop overlay can decide tiles synchronously during a drag.
 *
 * Only `scalar` ops with a column-fillable text arg surface as draggable tiles
 * today (see {@link availableSemanticOps}); the other shapes (aggregate /
 * dimension / rowset) are carried so the overlay can show them as labeled
 * "coming soon" placeholder bands — giving every shape a stable, advertised
 * home before its interaction model ships.
 */

const RETURN_TYPES = new Set(["text", "bool", "float8"]) // jsonb deferred (scalar tiles)
const KNOWN_SHAPES = new Set<SemanticOpShape>(["scalar", "aggregate", "dimension", "rowset", "query"])
// Shapes that are NOT per-row projections (different drop model, not yet wired).
// Gating on "not one of these" rather than `=== 'scalar'` lets catalog data
// loaded before the `shape` field existed (legacy/HMR-stale state, which was
// always scalar-only) keep surfacing tiles instead of blanking the overlay.
const NON_SCALAR_SHAPES = new Set<string>(["aggregate", "dimension", "rowset", "query"])

interface OperatorRow {
  name: string
  shape: string
  arg_names: string[] | null
  arg_types: string[] | null
  return_type: string
  description: string | null
}

const cache = new Map<string, SemanticOpMeta[]>()

/** Load (and cache) the FULL operator catalog (all shapes) for a connection.
 *  Returns [] on any non-rvbbit connection or error — the feature simply
 *  doesn't surface. */
export async function loadSemanticOps(connectionId: string): Promise<SemanticOpMeta[]> {
  const cached = cache.get(connectionId)
  if (cached) return cached
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql: "SELECT name, shape, arg_names, arg_types, return_type, description FROM rvbbit.operators ORDER BY name",
        rowLimit: 500,
      }),
    })
    const json = (await res.json()) as { ok: boolean; rows?: OperatorRow[] }
    // Don't cache failures/empties — a non-rvbbit connection (or a transient
    // error) shouldn't pin an empty catalog for the session; retry next time.
    if (!json.ok || !json.rows) return []
    const ops: SemanticOpMeta[] = json.rows.map((r) => ({
      name: r.name,
      // Unknown/extension-future shapes fall into the whole-result bucket so
      // they never masquerade as a draggable scalar tile.
      shape: (KNOWN_SHAPES.has(r.shape as SemanticOpShape) ? r.shape : "rowset") as SemanticOpShape,
      argNames: Array.isArray(r.arg_names) ? r.arg_names : [],
      argTypes: Array.isArray(r.arg_types) ? r.arg_types : [],
      returnType: r.return_type as SemanticOpMeta["returnType"],
      description: r.description ?? undefined,
    }))
    if (ops.length > 0) cache.set(connectionId, ops)
    return ops
  } catch {
    return []
  }
}

/** Drop the cached catalog (e.g. after operators change). */
export function invalidateSemanticOps(connectionId?: string): void {
  if (connectionId) cache.delete(connectionId)
  else cache.clear()
}

export interface SemanticOpTile {
  op: Extract<RollupOp, { kind: "semantic-op" }>
  label: string
  hint: string
  returnType: SemanticOpMeta["returnType"]
  /** True when the op takes literal args beyond the column — the drop opens a
   *  small bind step before the projection is created. */
  needsArgs: boolean
}

/**
 * The semantic-op tiles to offer for a drag of a single text-ish column
 * (semantic scalars operate on text; numeric/date columns are excluded,
 * mirroring the vanilla rollup tiles). arg[0] is the dragged column; any
 * further args must be `text` literals the user binds at drop time. Ops whose
 * extra args are non-text (e.g. a jsonb `row`) are excluded — they can't be
 * bound with a simple text input yet.
 */
export function availableSemanticOps(
  columns: DesktopColumnRef[],
  ops: SemanticOpMeta[],
): SemanticOpTile[] {
  if (columns.length !== 1 || ops.length === 0) return []
  const col = columns[0]
  if (isNumericRef(col) || isDateRef(col)) return []
  return ops
    .filter(
      (o) =>
        !NON_SCALAR_SHAPES.has(o.shape) && // only per-row projections are column-droppable today
        RETURN_TYPES.has(o.returnType) && // jsonb returns deferred
        o.argNames.length >= 1 &&
        o.argTypes[0] === "text" && // the dragged column fills arg 0
        o.argTypes.slice(1).every((t) => t === "text"), // remaining args bind as text literals
    )
    .map((o) => {
      const extra = o.argNames.slice(1)
      return {
        op: { kind: "semantic-op" as const, operator: o },
        label: titleCase(o.name),
        hint: o.description ?? `rvbbit.${o.name}(${[col.name, ...extra].join(", ")})`,
        returnType: o.returnType,
        needsArgs: extra.length > 0,
      }
    })
}

/**
 * Dimension operators offered for a single text column drag. A dimension op
 * (`rvbbit.<op>(text) RETURNS SETOF text`) fans one text out into a set of
 * canonical labels; dropping it spawns a frequency table (GROUP BY the label).
 * Single-arg, text-returning, dimension-shaped only — so it's a one-step drop
 * with no bind popover.
 */
export function availableDimensionOps(
  columns: DesktopColumnRef[],
  ops: SemanticOpMeta[],
): SemanticOpTile[] {
  if (columns.length !== 1 || ops.length === 0) return []
  const col = columns[0]
  if (isNumericRef(col) || isDateRef(col)) return []
  return ops
    .filter((o) => o.shape === "dimension" && o.argNames.length === 1 && o.argTypes[0] === "text")
    .map((o) => ({
      op: { kind: "semantic-op" as const, operator: o },
      label: titleCase(o.name),
      hint: o.description ?? `rvbbit.${o.name}(${col.name}) → label rows to GROUP BY`,
      returnType: o.returnType,
      needsArgs: false,
    }))
}

function titleCase(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

/** Icon for a scalar op's return type — what the derived column will *be*:
 *  a label (text), a yes/no flag (bool), or a numeric score (float8). */
export function returnTypeIcon(rt: SemanticOpMeta["returnType"]): LucideIcon {
  if (rt === "bool") return Flag
  if (rt === "float8") return Activity
  return Tag // text (jsonb isn't surfaced as a scalar tile)
}

/** Tiny corner-chip glyph mirroring {@link returnTypeIcon}. */
export function returnTypeChip(rt: SemanticOpMeta["returnType"]): string {
  if (rt === "bool") return "y/n"
  if (rt === "float8") return ".9"
  return "Aa"
}

/**
 * Partition scalar tiles by return type for the Scalar band's sub-rails:
 * text → a Label, bool → a Flag (yes/no), float8 → a Score. Return type is
 * the most decision-relevant axis at drop time — it tells you what the new
 * derived column will *be*.
 */
export function groupScalarTilesByReturnType(tiles: SemanticOpTile[]): {
  text: SemanticOpTile[]
  bool: SemanticOpTile[]
  float8: SemanticOpTile[]
} {
  const g: { text: SemanticOpTile[]; bool: SemanticOpTile[]; float8: SemanticOpTile[] } = {
    text: [],
    bool: [],
    float8: [],
  }
  for (const t of tiles) {
    if (t.returnType === "bool") g.bool.push(t)
    else if (t.returnType === "float8") g.float8.push(t)
    else g.text.push(t) // text (and any stray non-bool/float8) reads as a label
  }
  return g
}

/** A rowset (whole-result, pipeline-stage) operator as the block-drag UI needs
 *  it: dropping a block onto one appends a `then <op>('<prompt>')` stage. */
export interface RowsetOpTile {
  op: SemanticOpMeta
  label: string
  hint: string
}

// Synth-sql shape transforms first (cheap — generate SQL), then the LLM-heavy
// per-row/over-set stages. Names not listed fall to the end, alphabetically.
const ROWSET_ORDER = ["filter", "group", "pivot", "top", "analyze", "enrich"]

/**
 * The rowset operators offered when a result block is dragged. These don't take
 * a column — they transform the whole resultset from a natural-language prompt,
 * so they surface on a *block* drag (not a column drag).
 */
export function availableRowsetOps(ops: SemanticOpMeta[]): RowsetOpTile[] {
  return ops
    .filter((o) => o.shape === "rowset")
    .sort((a, b) => {
      const ai = ROWSET_ORDER.indexOf(a.name)
      const bi = ROWSET_ORDER.indexOf(b.name)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name)
    })
    .map((o) => ({
      op: o,
      label: titleCase(o.name),
      hint: o.description ?? `then ${o.name}('…')`,
    }))
}

/**
 * Operator names for the not-yet-draggable shapes, grouped for the overlay's
 * "coming soon" placeholder bands. Names only — these shapes (aggregate →
 * measure, dimension → group-by, rowset/query → whole-result transform) have a
 * different interaction model that isn't wired up yet. A band with zero ops is
 * absent here, so the overlay collapses it to nothing rather than showing an
 * empty frame.
 */
export function placeholderShapeOps(ops: SemanticOpMeta[]): {
  aggregate: string[]
  dimension: string[]
  wholeResult: string[]
} {
  const aggregate: string[] = []
  const dimension: string[] = []
  const wholeResult: string[] = []
  for (const o of ops) {
    if (o.shape === "aggregate") aggregate.push(o.name)
    else if (o.shape === "dimension") dimension.push(o.name)
    else if (o.shape === "rowset" || o.shape === "query") wholeResult.push(o.name)
  }
  return { aggregate, dimension, wholeResult }
}
