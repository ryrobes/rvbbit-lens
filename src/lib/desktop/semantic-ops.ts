"use client"

import type { DesktopColumnRef, RollupOp, SemanticOpMeta } from "./types"
import { isDateRef, isNumericRef } from "./sql-builder"

/**
 * Client-side catalog of scalar semantic operators (rvbbit.operators) for the
 * drag-drop UI. Loaded once per connection and cached, so the drop overlay can
 * decide tiles synchronously during a drag.
 *
 * Thin slice: only scalar ops the UI can run with zero arg-binding — a single
 * column argument and a non-jsonb return. Multi-arg ops (classify, extract, …)
 * and jsonb returns come in a later phase.
 */

const RETURN_TYPES = new Set(["text", "bool", "float8"]) // jsonb deferred

interface OperatorRow {
  name: string
  shape: string
  arg_names: string[] | null
  arg_types: string[] | null
  return_type: string
  description: string | null
}

const cache = new Map<string, SemanticOpMeta[]>()

/** Load (and cache) the scalar operator catalog for a connection. Returns [] on
 *  any non-rvbbit connection or error — the feature simply doesn't surface. */
export async function loadSemanticOps(connectionId: string): Promise<SemanticOpMeta[]> {
  const cached = cache.get(connectionId)
  if (cached) return cached
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        sql: "SELECT name, shape, arg_names, arg_types, return_type, description FROM rvbbit.operators WHERE shape = 'scalar' ORDER BY name",
        rowLimit: 500,
      }),
    })
    const json = (await res.json()) as { ok: boolean; rows?: OperatorRow[] }
    // Don't cache failures/empties — a non-rvbbit connection (or a transient
    // error) shouldn't pin an empty catalog for the session; retry next time.
    if (!json.ok || !json.rows) return []
    const ops: SemanticOpMeta[] = json.rows
      .filter((r) => RETURN_TYPES.has(r.return_type))
      .map((r) => ({
        name: r.name,
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
}

/**
 * The semantic-op tiles to offer for a drag. Thin slice: a single text-ish
 * column (semantic scalars operate on text; numeric/date columns are excluded,
 * mirroring the type-awareness of the vanilla rollup tiles), and only ops that
 * take exactly one argument (the column) so no extra binding is needed.
 */
export function availableSemanticOps(
  columns: DesktopColumnRef[],
  ops: SemanticOpMeta[],
): SemanticOpTile[] {
  if (columns.length !== 1 || ops.length === 0) return []
  const col = columns[0]
  if (isNumericRef(col) || isDateRef(col)) return []
  return ops
    .filter((o) => o.argNames.length === 1)
    .map((o) => ({
      op: { kind: "semantic-op" as const, operator: o },
      label: titleCase(o.name),
      hint: o.description ?? `rvbbit.${o.name}(${col.name})`,
      returnType: o.returnType,
    }))
}

function titleCase(name: string): string {
  return name
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}
