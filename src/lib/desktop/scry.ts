"use client"

/**
 * "Scry" — the reactive cascade search layer.
 *
 * A cascade is a stack of stages. Stage 0 searches the whole catalog; every
 * stage below is scoped *within* the previous stage's results, so the chain
 * reads like Smalltalk's `it`: "find X … within those, find Y …". Editing any
 * upstream stage re-flows everything downstream (the prompt owns that loop).
 *
 * v1 "within" = the set of relations (`schema.rel`) implicated by the upstream
 * hits. A scoped stage runs a wide semantic search then keeps only hits whose
 * relation is in that set. v2 can widen the scope to the true KG neighborhood
 * via `rvbbit.kg_neighbors` (the same data behind the "ghost breadcrumbs"
 * node-graph view) — the hits already carry `nodeId` for exactly that.
 */

import { searchData, type DataSearchHit } from "@/lib/rvbbit/data-search"
import { fetchKgNeighborhoodByNodeIds } from "@/lib/rvbbit/kg"
import { objectType } from "@/lib/desktop/scry-types"

/**
 * Corpus seam. "catalog" = the structure graph (schema/fingerprints from
 * catalog_crawl); "data" = the data-derived KG (entity/relationship triples
 * extracted from row CONTENT by data_crawl). Each maps to a KG graph_id.
 */
export type ScrySourceId = "catalog" | "data"

export function sourceGraph(source: ScrySourceId): string {
  return source === "data" ? "data_kg" : "db_catalog"
}

export function sourceLabel(source: ScrySourceId): string {
  return source === "data" ? "facts" : "structure"
}

export interface ScryStage {
  id: string
  query: string
  hits: DataSearchHit[]
  loading: boolean
  error?: string
}

export interface ScryScope {
  nodeIds: Set<number>
  rels: Set<string>
}

/** Stable key for a relation, joined with an unlikely sentinel so schema/rel can't collide. */
export function relKey(schema: string, rel: string): string {
  return `${schema}\u001f${rel}`
}

/** The graph neighborhood plus relation fallback a downstream stage searches within. */
export async function scopeFromHits(
  connectionId: string,
  graph: string,
  hits: DataSearchHit[],
): Promise<ScryScope> {
  const rels = new Set<string>()
  const seedIds: number[] = []
  for (const h of hits) {
    rels.add(relKey(h.schema, h.rel))
    if (Number.isFinite(h.nodeId) && h.nodeId > 0) seedIds.push(h.nodeId)
  }
  if (seedIds.length === 0) return { nodeIds: new Set(), rels }
  const { neighborhood } = await fetchKgNeighborhoodByNodeIds(connectionId, graph, seedIds, 1200)
  return {
    nodeIds: new Set([...seedIds, ...neighborhood.nodes.map((n) => n.nodeId)]),
    rels,
  }
}

/**
 * Run one cascade stage. `scope === null` (stage 0) searches the whole catalog;
 * a scoped stage searches wide then narrows to the upstream relations. We pull
 * a larger `k` when scoped so the post-filter still has candidates to show.
 *
 * `enabledTypes` (the object-type filter) is applied to the wide result set
 * BEFORE the top-40 cap, so disabling a dominant type (e.g. meeting notes)
 * lets more of the remaining types rise into view — i.e. it re-ranks, not just
 * hides. `null`/empty = all types.
 */
export async function runScryStage(
  connectionId: string,
  query: string,
  scope: ScryScope | null,
  graph: string = "db_catalog",
  enabledTypes: Set<string> | null = null,
): Promise<{ hits: DataSearchHit[]; error?: string }> {
  const q = query.trim()
  if (!q) return { hits: [] }
  // Pull wider when a type filter is on so the cap still has candidates to show.
  const k = scope ? 200 : enabledTypes && enabledTypes.size > 0 ? 200 : 60
  const { hits, error } = await searchData(connectionId, q, k, null, graph)
  if (error) return { hits: [], error }
  const scoped = scope
    ? hits.filter((h) => scope.nodeIds.has(h.nodeId) || scope.rels.has(relKey(h.schema, h.rel)))
    : hits
  const typed =
    enabledTypes && enabledTypes.size > 0
      ? scoped.filter((h) => enabledTypes.has(objectType(h)))
      : scoped
  return { hits: typed.slice(0, 40) }
}
