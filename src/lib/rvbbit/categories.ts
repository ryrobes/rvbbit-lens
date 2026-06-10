/**
 * Shared org-taxonomy layer: the unified 2-level category tree that metrics and
 * alerts both draw from. Reads rvbbit.category_options() (distinct in-use pairs)
 * and writes via rvbbit.set_category(kind, name, category, subcategory).
 */

interface Ok {
  ok: true
  columns: { name: string }[]
  rows: Record<string, unknown>[]
}
interface Err {
  ok: false
  error: string
}

async function run(connectionId: string, sql: string): Promise<Ok | Err> {
  try {
    const res = await fetch("/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, sql, rowLimit: 1000 }),
    })
    return (await res.json()) as Ok | Err
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Postgres single-quoted literal. */
function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

export type CategoryKind = "metric" | "alert"

export interface CategoryPair {
  category: string
  subcategory: string | null
}

/** Distinct (category, subcategory) pairs in use — the reusable lookup (unified
 *  across metrics + alerts). Feeds the creatable category/subcategory pickers. */
export async function fetchCategoryOptions(connectionId: string): Promise<{ pairs: CategoryPair[]; error: string | null }> {
  const r = await run(connectionId, `SELECT category, subcategory FROM rvbbit.category_options()`)
  if (!r.ok) return { pairs: [], error: r.error }
  return {
    pairs: r.rows.map((row) => ({
      category: String(row.category),
      subcategory: row.subcategory == null ? null : String(row.subcategory),
    })),
    error: null,
  }
}

/** Set an entity's category/subcategory; an empty category clears the assignment. */
export async function setCategory(
  connectionId: string,
  kind: CategoryKind,
  name: string,
  category: string,
  subcategory: string,
): Promise<string | null> {
  const cat = category.trim()
  const sub = subcategory.trim()
  const args =
    cat === ""
      ? `${q(kind)}, ${q(name)}, NULL`
      : `${q(kind)}, ${q(name)}, ${q(cat)}, ${sub === "" ? "NULL" : q(sub)}`
  const r = await run(connectionId, `SELECT rvbbit.set_category(${args})`)
  return r.ok ? null : r.error
}

/** Distinct category names from the pairs (for the category picker). */
export function categoriesFrom(pairs: CategoryPair[]): string[] {
  return [...new Set(pairs.map((p) => p.category))].sort()
}

/** Distinct subcategories under a given category (for the subcategory picker). */
export function subcategoriesFor(pairs: CategoryPair[], category: string): string[] {
  return [...new Set(pairs.filter((p) => p.category === category && p.subcategory != null).map((p) => p.subcategory as string))].sort()
}
