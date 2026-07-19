/**
 * Curated deep-link hints + "what's inside" notes for the panel registry
 * (rvbbit.desktop_panels). The registry itself derives from the launcher
 * array — id/label/description/folder are automatic; THIS map is the only
 * hand-maintained part, and only for panels that earn it. `hints` lists
 * values open_panel accepts for the panel; `notes` lets the assistant give
 * directions ("Indexes tab") even where no deep-link exists.
 */
export const PANEL_EXTRAS: Record<string, { hints?: string[]; notes?: string }> = {
  "system-objects": {
    hints: [
      "tables", "indexes", "foreign-keys", "triggers", "sequences",
      "extensions", "roles", "settings", "activity", "locks", "stats",
    ],
    notes:
      "categories: tables, indexes (sizes, scans, unused), foreign-keys, triggers, sequences, extensions, roles, settings (server GUCs), activity, locks, stats",
  },
  monitor: {
    notes:
      "live server activity: session gauges, active queries, top tables by size & activity — collapsible sections, no tabs",
  },
  "query-explorer": {
    notes:
      "historical normalized queries: runtime distributions, call counts, notable evidence; click a query to open its inspector",
  },
  finder: {
    notes:
      "schema browser: schemas → tables → columns with live rvbbit vitals (row counts, sizes, acceleration, freshness)",
  },
  plates: {
    notes: "the plate shelf: kit plates, layouts, kit installs, save-arrangement",
  },
  "system-health": {
    notes: "maintenance X-ray: tombstones, bloat, cron coverage — remedies are built as SQL, never auto-run",
  },
}
