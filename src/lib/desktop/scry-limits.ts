/**
 * Scry P5 performance ceilings.
 *
 * The house rule: a cap must be SURFACED (a HUD chip / node glyph / count),
 * never a silent drop. The rail always holds the complete hit list, so capping
 * the bloom hides nothing — it just bounds what paints on the canvas.
 */

/** Hits rendered on the canvas. The results rail still lists ALL of them. */
export const MAX_BLOOM_NODES = 80
/** Accumulated spider-expansion ceiling (nodes added by branching). */
export const MAX_SPIDER_NODES = 240
/** Hard render ceiling across both populations (bloom + spider). */
export const MAX_TOTAL_NODES = 300
/** Simultaneously-open preview panels (each is DOM-heavy); LRU-closed past this. */
export const MAX_OPEN_PREVIEWS = 6
/** Cached preview entries (re-fetchable, so safe to LRU-evict). */
export const MAX_PREVIEW_CACHE = 16
/** Neighbors merged per expand — re-homed from use-scry-spider. */
export const MAX_EDGES_PER_EXPAND = 60
